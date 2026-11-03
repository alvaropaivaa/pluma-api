// Testes que não precisam de banco nem de WhatsApp: criptografia, rede, montagem de mensagens, formatos
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { instanceIdOf } from '../src/cluster/router.js'
import { toWhatsmeowJson } from '../src/compat/wapi/webhooks.js'
import { BlockedUrlError, isPrivateAddress, safeFetch } from '../src/net/safe-fetch.js'
import { decrypt, encrypt, isEncrypted } from '../src/security/crypto.js'
import { decidirHistorico } from '../src/whatsapp/history.js'
import { cleanupLocalMedia, cleanupOrphanMedia, localRoot, mediaUrl, putMedia, verifyLocalMediaSignature } from '../src/storage/media-storage.js'
import { SendError, WAVEFORM_BARS, audioWaveform, sendPayload, sendRequestSchema } from '../src/whatsapp/outgoing.js'
import { PAIRING_WINDOW_MS, pairingOnClose } from '../src/whatsapp/pairing.js'

// ---------- criptografia ----------

test('criptografia: ida e volta, e cada cifragem é diferente', () => {
  const a = encrypt('segredo 🔐 ação')
  const b = encrypt('segredo 🔐 ação')
  assert.ok(isEncrypted(a))
  assert.notEqual(a, b) // IV aleatório
  assert.equal(decrypt(a), 'segredo 🔐 ação')
})

test('criptografia: valor antigo em texto puro passa direto', () => {
  assert.equal(decrypt('texto-antigo'), 'texto-antigo')
})

test('criptografia: valor adulterado é recusado', () => {
  const v = encrypt('valor')
  const raw = Buffer.from(v.slice('enc:v1:'.length), 'base64')
  raw[raw.length - 1] ^= 1
  assert.throws(() => decrypt('enc:v1:' + raw.toString('base64')))
})

// ---------- rede (SSRF) ----------

test('rede: endereços internos são bloqueados', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.ok(isPrivateAddress(ip), ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip)
})

test('rede: safeFetch recusa protocolo estranho e IP interno', async () => {
  await assert.rejects(safeFetch('file:///etc/passwd'), BlockedUrlError)
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data'), BlockedUrlError)
  await assert.rejects(safeFetch('http://[::1]:8080/'), BlockedUrlError)
})

// ---------- links de mídia ----------

test('mídia: link assinado vale; adulterado ou vencido não', async () => {
  const url = new URL(await mediaUrl('inst/2026-09/arquivo.jpg'))
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig')!
  assert.ok(verifyLocalMediaSignature('inst/2026-09/arquivo.jpg', exp, sig))
  assert.ok(!verifyLocalMediaSignature('inst/2026-09/outro.jpg', exp, sig))
  assert.ok(!verifyLocalMediaSignature('inst/2026-09/arquivo.jpg', Math.floor(Date.now() / 1000) - 1, sig))
})

// ---------- validação e montagem de mensagens ----------

test('envio: {to, text} sem type vira texto; enquete com 1 opção é recusada', () => {
  assert.equal(sendRequestSchema.parse({ to: '5511999999999', text: 'oi' }).type, 'text')
  assert.equal(sendRequestSchema.safeParse({ to: '5511999999999', type: 'poll', name: 'x', options: ['a'] }).success, false)
  assert.equal(sendRequestSchema.safeParse({ to: '5511999999999', type: 'tipo-que-nao-existe' }).success, false)
})

function fakeSock() {
  const sent: { jid: string; content: any; opts: any }[] = []
  const sock: any = {
    user: { id: '5511000000000:1@s.whatsapp.net' },
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, opts })
      return { key: { id: 'X', remoteJid: jid, fromMe: true }, message: {} }
    },
  }
  return { sock, sent }
}
const run = async (p: object) => {
  const { sock, sent } = fakeSock()
  await sendPayload(sock, '00000000-0000-0000-0000-000000000000', '5511@s.whatsapp.net', sendRequestSchema.parse({ to: '5511999999999', ...p }))
  return sent[0]
}

test('envio: texto com menção vira JID', async () => {
  const s = await run({ type: 'text', text: 'oi', mentions: ['5585999999999'] })
  assert.deepEqual(s.content, { text: 'oi', mentions: ['5585999999999@s.whatsapp.net'] })
})

test('envio: localização, enquete e evento', async () => {
  assert.deepEqual((await run({ type: 'location', latitude: -3.7, longitude: -38.5, name: 'Loja' })).content.location, {
    degreesLatitude: -3.7,
    degreesLongitude: -38.5,
    name: 'Loja',
    address: undefined,
  })
  assert.deepEqual((await run({ type: 'poll', name: 'Dia?', options: ['Seg', 'Ter'] })).content.poll, {
    name: 'Dia?',
    values: ['Seg', 'Ter'],
    selectableCount: 1,
  })
  const ev = (await run({ type: 'event', name: 'Reunião', startDate: '2026-09-20T14:00:00-03:00' })).content.event
  assert.equal(ev.startDate.toISOString(), '2026-09-20T17:00:00.000Z')
})

test('envio: contato escapa caracteres que quebrariam o vCard', async () => {
  const s = await run({ type: 'contact', contacts: [{ name: 'Fulano; da\nSilva', phone: '+5585999999999' }] })
  const vcard: string = s.content.contacts.contacts[0].vcard
  assert.match(vcard, /FN:Fulano  da Silva/)
  assert.match(vcard, /waid=5585999999999:\+5585999999999/)
})

test('envio: imagem vira figurinha webp 512x512', async () => {
  const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const s = await run({ type: 'sticker', base64: `data:image/png;base64,${png.toString('base64')}` })
  const meta = await sharp(s.content.sticker).metadata()
  assert.equal(meta.format, 'webp')
  assert.equal(meta.width, 512)
})

test('envio: mídia em endereço interno é recusada com erro claro', async () => {
  await assert.rejects(run({ type: 'image', url: 'http://127.0.0.1/segredo.png' }), (err: unknown) => err instanceof SendError && err.code === 'invalid_media')
})

// ---------- formato W-API ----------

test('webhook W-API: mídia sai com URL em maiúsculo e bytes em base64 (formato whatsmeow)', () => {
  const out = toWhatsmeowJson({
    imageMessage: { url: 'https://mmg.whatsapp.net/x', mediaKey: Buffer.from([1, 2, 3]), fileSha256: Buffer.from([4]), mimetype: 'image/jpeg' },
  }) as any
  assert.equal(out.imageMessage.URL, 'https://mmg.whatsapp.net/x')
  assert.equal(out.imageMessage.url, 'https://mmg.whatsapp.net/x')
  assert.equal(out.imageMessage.mediaKey, 'AQID')
  assert.equal(out.imageMessage.fileSHA256, 'BA==')
})

// ---------- roteador ----------

test('roteador: acha a instância no caminho nativo e no instanceId das rotas /v1', () => {
  const id = '359f6c6b-7aed-47f1-9e29-40a5f2acd5c6'
  assert.equal(instanceIdOf({ url: `/instances/${id}/messages`, query: {}, body: undefined }), id)
  assert.equal(instanceIdOf({ url: `/v1/message/send-text?instanceId=${id}`, query: { instanceId: id }, body: {} }), id)
  assert.equal(instanceIdOf({ url: `/v1/integrator/delete-instance?instanceId=${id}`, query: { instanceId: id }, body: {} }), id)
  // criar instância não é de uma instância; id inválido também não
  assert.equal(instanceIdOf({ url: '/v1/integrator/create-instance', query: {}, body: { instanceId: id } }), undefined)
  assert.equal(instanceIdOf({ url: '/v1/message/send-text?instanceId=../../x', query: { instanceId: '../../x' }, body: {} }), undefined)
})

// ---------- e-mails de alerta ----------

test('alerta: nome com HTML não vira código no e-mail', async () => {
  const { disconnectedEmail } = await import('../src/alerts/templates.js')
  const mail = disconnectedEmail({ accountName: 'Oficina <b>X</b>', instanceName: '<script>alert(1)</script>', phone: '5531983753267', instanceId: 'abc' }, 'motivo')
  assert.ok(!mail.html.includes('<script>alert(1)</script>'))
  assert.ok(mail.html.includes('&lt;script&gt;'))
  assert.ok(mail.html.includes('(31) 98375-3267'))
  assert.ok(mail.html.includes('Reconectar agora'))
})

test('mídia: arquivo com link vencido é apagado do disco; o recente fica', async () => {
  const dir = `teste-limpeza-${Date.now()}`
  await putMedia(`${dir}/velho.jpg`, Buffer.from('a'), 'image/jpeg')
  await putMedia(`${dir}/novo.jpg`, Buffer.from('b'), 'image/jpeg')
  const velho = join(localRoot, dir, 'velho.jpg')
  const antigo = new Date(Date.now() - 40 * 86_400_000)
  utimesSync(velho, antigo, antigo)
  assert.ok((await cleanupLocalMedia()) >= 1)
  assert.equal(existsSync(velho), false)
  assert.equal(existsSync(join(localRoot, dir, 'novo.jpg')), true)
  // quando o novo também vence, sai e a pasta vazia some
  utimesSync(join(localRoot, dir, 'novo.jpg'), antigo, antigo)
  await cleanupLocalMedia()
  assert.equal(existsSync(join(localRoot, dir)), false)
})

test('áudio de voz: sai com a ondinha (64 barras de 0 a 100), silêncio vira barras zeradas', async () => {
  // 1 s de silêncio seguido de 1 s de tom: a onda tem que ficar baixa no começo e alta no fim
  const wav = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=1', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-f', 'wav', 'pipe:1'])
  const wave = await audioWaveform(wav)
  assert.ok(wave)
  assert.equal(wave.length, WAVEFORM_BARS)
  assert.equal(Math.max(...wave), 100)
  assert.ok(wave[5] < 5 && wave[58] > 80, `onda inesperada: ${[...wave].join(',')}`)
  assert.equal(await audioWaveform(Buffer.from('isto não é áudio')), undefined)
})

test('mídia: pasta de instância que não existe mais é apagada inteira', async () => {
  const viva = `viva-${Date.now()}`
  const morta = `morta-${Date.now()}`
  await putMedia(`${viva}/a.jpg`, Buffer.from('a'), 'image/jpeg')
  await putMedia(`${morta}/b.jpg`, Buffer.from('b'), 'image/jpeg')

  assert.ok((await cleanupOrphanMedia(new Set([viva]))) >= 1)
  assert.equal(existsSync(join(localRoot, morta)), false)
  assert.equal(existsSync(join(localRoot, viva, 'a.jpg')), true, 'a instância viva não é tocada')

  await cleanupOrphanMedia(new Set())
})

test('deploy: "sessão trocada" uma vez é tratada como transitória; repetida derruba o canal', async () => {
  const fonte = await readFile(new URL('../src/whatsapp/session.ts', import.meta.url), 'utf8')
  // A primeira (e a segunda) tentam voltar; só a terceira em 2 min marca como substituída
  assert.match(fonte, /replacedAt = \[\.\.\.this\.replacedAt\.filter\(\(t\) => agora - t < 120_000\), agora\]/)
  assert.match(fonte, /if \(this\.replacedAt\.length < 3\) \{[\s\S]{0,120}scheduleReconnect/)
  // A passagem de números espera o socket fechar antes de soltar a posse
  const gerente = await readFile(new URL('../src/whatsapp/manager.ts', import.meta.url), 'utf8')
  assert.match(gerente, /await sleep\(HANDOFF_SETTLE_MS\)\s*\n\s*await handOff\(batch\)/)
})

test('envio: citar mensagem que não temos não derruba o envio, só perde a citação', async () => {
  // O CRM responde citando uma conversa anterior à conexão do número (ou de outro
  // provedor): a mensagem tem de sair mesmo assim. 23/09/2026
  const enviado = await run({ type: 'text', text: 'oi', quotedId: '3A7889DEB42E7BEF4D3D' })
  assert.deepEqual(enviado.content, { text: 'oi' })
  assert.equal(enviado.opts?.quoted, undefined)
})

test('histórico: aviso sai marcado, e só uma vez por número', async () => {
  const fonte = await readFile(new URL('../src/whatsapp/session.ts', import.meta.url), 'utf8')
  // Quem decide o que entra é decidirHistorico (testado logo abaixo, caso a caso)
  assert.match(fonte, /const decisao = decidirHistorico\(\{/)
  assert.match(fonte, /if \(!decisao\.importar\) return/)
  assert.match(fonte, /marcarComoImportado: decisao\.encerrar/)
  // Pedir mensagens antigas precisa de uma âncora: a mais antiga que já temos
  assert.match(fonte, /async fetchOlderMessages\(to: string, count: number\)/)
  // A conversa pode estar guardada pelo telefone ou pelo @lid: a âncora procura nos dois
  assert.match(fonte, /union select lid from lid_mappings where instance_id = \$1 and pn = \$2/)
  assert.match(fonte, /order by coalesce\(m\.ts, extract\(epoch from m\.created_at\)::bigint\) asc limit 1/)
  assert.match(fonte, /remoteJid: ancora\.remote_jid/)
  // Marca no banco só quando terminou o pacote inteiro
  assert.match(fonte, /update instances set history_imported_at = now\(\) where id = \$1/)
  // Respeita o limite de dias, o teto por conversa e a trava de grupos
  assert.match(fonte, /config\.HISTORY_MAX_DAYS/)
  assert.match(fonte, /jaNessaConversa >= config\.HISTORY_MAX_PER_CHAT/)
  assert.match(fonte, /isGroup && this\.settings\.ignoreGroups/)
  // Sai marcado como histórico para o CRM não tratar como novidade
  assert.match(fonte, /historical: true/)
  const webhooks = await readFile(new URL('../src/compat/wapi/webhooks.ts', import.meta.url), 'utf8')
  assert.match(webhooks, /\.\.\.\(info\.historical \? \{ historical: true \} : \{\}\)/)
})

test('pareamento: insiste com código novo dentro da janela e desiste depois', () => {
  const agora = Date.now()
  assert.equal(pairingOnClose(agora, agora).do, 'novo-codigo', 'fechou na hora: ainda dá tempo')
  assert.equal(pairingOnClose(agora, agora + PAIRING_WINDOW_MS - 1_000).do, 'novo-codigo')
  assert.equal(pairingOnClose(agora, agora + PAIRING_WINDOW_MS).do, 'desistir')
  assert.equal(pairingOnClose(agora, agora + 10 * 60_000).do, 'desistir')
})

test('pareamento: fechar no meio nunca manda deslogar', () => {
  // 401 e 408 aqui são a tentativa falhando, não o celular desconectando. Tratar como
  // logout apagava a sessão e travava a instância em logged_out (medido em 05/10/2026)
  const agora = Date.now()
  for (const t of [0, 1_000, PAIRING_WINDOW_MS - 1, PAIRING_WINDOW_MS, PAIRING_WINDOW_MS * 3]) {
    const acao = pairingOnClose(agora, agora + t).do
    assert.ok(acao === 'novo-codigo' || acao === 'desistir', `ação inesperada: ${acao}`)
    assert.notEqual(acao, 'deslogar')
  }
})

test('pareamento: o código vence antes do socket, então o socket é reciclado', async () => {
  const fonte = await readFile(new URL('../src/whatsapp/session.ts', import.meta.url), 'utf8')
  // Um código por socket: pedir outro no mesmo socket gasta as rodadas de QR e o
  // WhatsApp fecha com 408 em ~2,5 min, matando a tentativa inteira
  assert.match(fonte, /if \(this\.pairingPhone && !this\.pairingAsked\)/)
  assert.match(fonte, /this\.pairingAsked = true/)
  assert.match(fonte, /this\.pairingAsked = false/, 'precisa zerar a cada socket novo')
  // E o socket cai quando o código vence, para um código válido entrar no lugar
  assert.match(fonte, /this\.pairingTimer = setTimeout\(/)
  assert.match(fonte, /PAIRING_CODE_TTL_MS/)
  assert.match(fonte, /código de pareamento venceu/)
  // A credencial pela metade tem de sair, senão o socket novo volta 401
  assert.match(fonte, /await clearAuthState\(this\.instanceId\)\n\s*if \(pairingOnClose/)
})

test('pareamento: tentativa que nunca conectou não conta como queda do número', async () => {
  const fonte = await readFile(new URL('../src/whatsapp/session.ts', import.meta.url), 'utf8')
  const pareamento = fonte.indexOf('if (this.pairingPhone) {\n        this.pairingCode = undefined')
  const queda = fonte.indexOf('await quedaComecou(this.instanceId, code, reason)')
  assert.ok(pareamento > 0 && queda > 0)
  // Cada troca de socket do pareamento viraria uma piscada falsa no relatório diário
  assert.ok(pareamento < queda, 'o desvio do pareamento tem de vir antes de registrar queda')
})

// ============ histórico do pareamento ============

const histBase = { sobDemanda: false, ligado: true, jaImportado: false, isLatest: false, quantidade: 100 }

test('histórico: pacote vazio marcado como último não encerra a importação', () => {
  // O caso que perdeu 15 mil mensagens em 20/10/2026
  assert.equal(decidirHistorico({ ...histBase, isLatest: true, quantidade: 0 }).encerrar, false)
})

test('histórico: último pacote com conteúdo encerra', () => {
  const d = decidirHistorico({ ...histBase, isLatest: true, quantidade: 1000 })
  assert.equal(d.importar, true)
  assert.equal(d.encerrar, true)
})

test('histórico: pacote do meio importa sem encerrar', () => {
  const d = decidirHistorico(histBase)
  assert.equal(d.importar, true)
  assert.equal(d.encerrar, false)
})

test('histórico: depois do vazio, o pacote seguinte com conteúdo ainda entra', () => {
  const vazio = decidirHistorico({ ...histBase, isLatest: true, quantidade: 0 })
  const seguinte = decidirHistorico({ ...histBase, jaImportado: vazio.encerrar, quantidade: 1000 })
  assert.equal(seguinte.importar, true)
})

test('histórico: com a chave desligada não importa nada', () => {
  assert.equal(decidirHistorico({ ...histBase, ligado: false }).importar, false)
})

test('histórico: já importado não aceita mais pacotes do pareamento', () => {
  assert.equal(decidirHistorico({ ...histBase, jaImportado: true }).importar, false)
})

test('histórico: pedido sob demanda entra mesmo com a chave desligada', () => {
  const d = decidirHistorico({ ...histBase, sobDemanda: true, ligado: false, jaImportado: true })
  assert.equal(d.importar, true)
  assert.equal(d.encerrar, false)
})

test('e-mail: sem remetente configurado não envia, mesmo com provedor', async () => {
  const { config } = await import('../src/config.js')
  const { emailConfigured, sendEmail } = await import('../src/alerts/email.js')
  const antes = { from: config.ALERT_FROM, resend: config.RESEND_API_KEY }
  try {
    config.ALERT_FROM = undefined
    config.RESEND_API_KEY = 'chave-falsa'
    assert.equal(emailConfigured(), false)
    await assert.rejects(sendEmail(['a@teste.com'], 'assunto', 'corpo'), /ALERT_FROM/)
    config.ALERT_FROM = 'API Roxa <alertas@exemplo.com>'
    assert.equal(emailConfigured(), true)
  } finally {
    config.ALERT_FROM = antes.from
    config.RESEND_API_KEY = antes.resend
  }
})
