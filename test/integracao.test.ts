// Testes com banco de verdade (DATABASE_URL de teste): leases, fila, criptografia no banco e a API HTTP
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { registrarChave } from '../src/api/account-keys.js'
import { buildServer } from '../src/api/server.js'
import { createPanelUser } from '../src/api/panel-auth.js'
import { acquireLease, fairShare, handOff, heartbeat, markDraining, receivingWorkers, renewLeases, stillOrphan, workerId } from '../src/cluster/leases.js'
import { pool } from '../src/db.js'
import { encryptLegacyData } from '../src/security/encrypt-legacy.js'
import { decrypt } from '../src/security/crypto.js'
import { claimNextJob, createJob, failJob, getJob } from '../src/whatsapp/send-queue.js'

let app: Awaited<ReturnType<typeof buildServer>>
let accountId: string
let apiKey: string

before(async () => {
  await pool.query('truncate accounts, workers restart identity cascade')
  apiKey = `wak_${randomBytes(24).toString('hex')}`
  const { rows } = await pool.query<{ id: string }>('insert into accounts (name, api_key_hash) values ($1, $2) returning id', [
    'Conta Teste',
    createHash('sha256').update(apiKey).digest('hex'),
  ])
  accountId = rows[0].id
  await registrarChave(accountId, 'Chave inicial', apiKey)
  await createPanelUser(accountId, 'painel@teste.com', 'senha-forte-123')
  app = await buildServer()
})

after(async () => {
  await app.close()
  await pool.end()
})

async function newInstance(name = `inst-${randomBytes(3).toString('hex')}`) {
  const res = await app.inject({ method: 'POST', url: '/instances', headers: { 'x-api-key': apiKey }, payload: { name } })
  assert.equal(res.statusCode, 201, res.body)
  return res.json() as { id: string; token: string; webhookSecret: string }
}

// ---------- API: autenticação e dados cifrados ----------

test('api: sem credencial é 401; chave errada é 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/instances' })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': 'wak_errada' } })).statusCode, 401)
})

test('api: criar instância devolve token legível, mas no banco token e segredo ficam cifrados', async () => {
  const inst = await newInstance()
  assert.match(inst.token, /^[0-9a-f]{64}$/)
  const { rows } = await pool.query('select token, webhook_secret from instances where id = $1', [inst.id])
  assert.match(rows[0].token, /^enc:v1:/)
  assert.match(rows[0].webhook_secret, /^enc:v1:/)
  assert.equal(decrypt(rows[0].token), inst.token)
})

test('api: rota de administrador fica desligada por padrão', async () => {
  const res = await app.inject({ method: 'POST', url: '/accounts', payload: { name: 'x' } })
  assert.equal(res.statusCode, 404)
})

test('api W-API: token certo entra; token de outra instância não', async () => {
  const a = await newInstance()
  const b = await newInstance()
  const ok = await app.inject({ method: 'GET', url: `/v1/instance/status-instance?instanceId=${a.id}`, headers: { authorization: `Bearer ${a.token}` } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json(), { instanceId: a.id, connected: false })
  const bad = await app.inject({ method: 'GET', url: `/v1/instance/status-instance?instanceId=${a.id}`, headers: { authorization: `Bearer ${b.token}` } })
  assert.equal(bad.statusCode, 401)
})

test('api W-API: enviar com a instância desconectada dá erro claro, sem enfileirar', async () => {
  const a = await newInstance()
  const res = await app.inject({
    method: 'POST',
    url: `/v1/message/send-text?instanceId=${a.id}`,
    headers: { authorization: `Bearer ${a.token}` },
    payload: { phone: '5511999999999', message: 'oi' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, true)
  const { rows } = await pool.query('select count(*)::int as n from send_jobs where instance_id = $1', [a.id])
  assert.equal(rows[0].n, 0)
})

// ---------- painel: login, sessão e CSRF ----------

test('ritmo de envio: padrão sem limite diário; ajuste por instância; null volta ao padrão', async () => {
  const inst = await newInstance()
  const patch = (payload: object) =>
    app.inject({ method: 'PATCH', url: `/instances/${inst.id}/settings`, headers: { 'x-api-key': apiKey }, payload })
  const get = async () => (await app.inject({ method: 'GET', url: `/instances/${inst.id}`, headers: { 'x-api-key': apiKey } })).json().settings

  const padrao = await get()
  assert.equal(padrao.sendPerMinute, 60)
  assert.equal(padrao.sendPerDay, 0)
  assert.equal(padrao.sendLimitsCustom, false)

  assert.equal((await patch({ sendPerMinute: 120, sendPerDay: 5000 })).statusCode, 200)
  assert.deepEqual([(await get()).sendPerMinute, (await get()).sendPerDay, (await get()).sendLimitsCustom], [120, 5000, true])

  // outro ajuste não mexe no ritmo
  await patch({ autoRead: true })
  assert.equal((await get()).sendPerMinute, 120)

  assert.equal((await patch({ sendPerMinute: 0 })).statusCode, 400)
  assert.equal((await patch({ sendPerMinute: null, sendPerDay: null })).statusCode, 200)
  assert.equal((await get()).sendLimitsCustom, false)
})

test('canal caiu: o aviso sai pelo endereço cadastrado, mesmo sem um só para desconexão', async () => {
  const { wapiConnected, wapiDisconnected } = await import('../src/compat/wapi/webhooks.js')
  const inst = await newInstance()
  // Como o CRM faz: cadastra só mensagem recebida, entrega e status
  const url = 'https://exemplo.com/inbound/wapi/abc'
  await pool.query(`update instances set wapi_webhooks = $2 where id = $1`, [
    inst.id,
    JSON.stringify({ received: url, delivery: url, status: url }),
  ])

  await wapiDisconnected(inst.id)
  await wapiConnected({ instanceId: inst.id, connectedPhone: '5511999999999', connectedLid: null })
  const { rows } = await pool.query<{ event: string; target_url: string }>(
    'select event, target_url from webhook_outbox where instance_id = $1 order by id',
    [inst.id],
  )
  assert.deepEqual(
    rows.map((r) => r.event),
    ['webhookDisconnected', 'webhookConnected'],
  )
  assert.ok(rows.every((r) => r.target_url === url))

  // Sem nenhum endereço cadastrado, não enfileira nada
  const outra = await newInstance()
  await wapiDisconnected(outra.id)
  const vazio = await pool.query('select 1 from webhook_outbox where instance_id = $1', [outra.id])
  assert.equal(vazio.rowCount, 0)
})

test('histórico: chave desligada por padrão e ligada por instância', async () => {
  const inst = await newInstance()
  const get = async () => (await app.inject({ method: 'GET', url: `/instances/${inst.id}`, headers: { 'x-api-key': apiKey } })).json().settings
  assert.equal((await get()).importHistory, false, 'nasce desligada: número nenhum importa sozinho')

  const res = await app.inject({
    method: 'PATCH',
    url: `/instances/${inst.id}/settings`,
    headers: { 'x-api-key': apiKey },
    payload: { importHistory: true },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal((await get()).importHistory, true)

  // liga num número não mexe nos outros
  const outra = await newInstance()
  assert.equal((await get.call(null)).importHistory, true)
  const settingsOutra = (await app.inject({ method: 'GET', url: `/instances/${outra.id}`, headers: { 'x-api-key': apiKey } })).json().settings
  assert.equal(settingsOutra.importHistory, false)
})

test('webhook: entrega acorda na hora em que o aviso entra na fila', async () => {
  const { WEBHOOK_CHANNEL, enqueueWapiWebhook } = await import('../src/webhooks/outbox.js')
  const inst = await newInstance()
  await pool.query(`update instances set wapi_webhooks = $2 where id = $1`, [
    inst.id,
    JSON.stringify({ received: 'https://exemplo.com/inbound' }),
  ])

  const ouvinte = new (await import('pg')).default.Client({ connectionString: process.env.DATABASE_URL })
  await ouvinte.connect()
  await ouvinte.query(`listen ${WEBHOOK_CHANNEL}`)
  const avisado = new Promise<void>((resolve) => ouvinte.on('notification', () => resolve()))

  await enqueueWapiWebhook(inst.id, 'received', { event: 'webhookReceived' })
  // Sem o aviso, a entrega só sairia na próxima ronda (1s): isso é o segundo que sobrava
  await Promise.race([avisado, new Promise((_r, rej) => setTimeout(() => rej(new Error('não avisou')), 3000))])
  await ouvinte.end()
})

test('painel: senha errada 401; certa cria sessão; alteração sem cabeçalho do painel é barrada (CSRF)', async () => {
  const bad = await app.inject({ method: 'POST', url: '/painel/api/login', payload: { email: 'painel@teste.com', password: 'errada' } })
  assert.equal(bad.statusCode, 401)
  const good = await app.inject({ method: 'POST', url: '/painel/api/login', payload: { email: 'painel@teste.com', password: 'senha-forte-123' } })
  assert.equal(good.statusCode, 200)
  const cookie = good.headers['set-cookie'] as string
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  const sid = cookie.split(';')[0]
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { cookie: sid } })).statusCode, 200)
  const csrf = await app.inject({ method: 'POST', url: '/instances', headers: { cookie: sid }, payload: { name: 'csrf' } })
  assert.equal(csrf.statusCode, 403)
  const okPost = await app.inject({ method: 'POST', url: '/instances', headers: { cookie: sid, 'x-painel': '1' }, payload: { name: 'pelo-painel' } })
  assert.equal(okPost.statusCode, 201)
})

// ---------- chaves de parceiro ----------

async function sessaoDoPainel() {
  const login = await app.inject({ method: 'POST', url: '/painel/api/login', payload: { email: 'painel@teste.com', password: 'senha-forte-123' } })
  return (login.headers['set-cookie'] as string).split(';')[0]
}

test('chaves: criar outra não derruba a antiga; revogar derruba só a revogada', async () => {
  const sid = await sessaoDoPainel()
  const criada = await app.inject({
    method: 'POST',
    url: '/painel/api/api-keys',
    headers: { cookie: sid, 'x-painel': '1' },
    payload: { name: 'CRM' },
  })
  assert.equal(criada.statusCode, 200, criada.body)
  const { id, apiKey: chaveNova } = criada.json() as { id: string; apiKey: string }
  assert.match(chaveNova, /^wak_[0-9a-f]{48}$/)

  // as duas valem ao mesmo tempo: é isso que permite trocar o .env sem janela de erro
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': apiKey } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': chaveNova } })).statusCode, 200)

  const revoga = await app.inject({ method: 'POST', url: `/painel/api/api-keys/${id}/revoke`, headers: { cookie: sid, 'x-painel': '1' } })
  assert.equal(revoga.statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': chaveNova } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': apiKey } })).statusCode, 200)

  // revogar de novo não encontra nada para revogar
  assert.equal((await app.inject({ method: 'POST', url: `/painel/api/api-keys/${id}/revoke`, headers: { cookie: sid, 'x-painel': '1' } })).statusCode, 404)
})

test('chaves: a lista mostra apelido, autor e último uso; alteração sem cabeçalho do painel é barrada', async () => {
  const sid = await sessaoDoPainel()
  const criada = await app.inject({
    method: 'POST',
    url: '/painel/api/api-keys',
    headers: { cookie: sid, 'x-painel': '1' },
    payload: { name: 'automação' },
  })
  const { apiKey: chave } = criada.json() as { apiKey: string }
  await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': chave } })

  const lista = await app.inject({ method: 'GET', url: '/painel/api/api-keys', headers: { cookie: sid } })
  assert.equal(lista.statusCode, 200)
  const { keys } = lista.json() as { keys: Array<Record<string, unknown>> }
  const nossa = keys.find((k) => k.name === 'automação')!
  assert.ok(nossa, 'a chave criada tem que aparecer na lista')
  assert.equal(nossa.created_by_email, 'painel@teste.com')
  assert.equal(nossa.hint, chave.slice(-6))
  assert.ok(nossa.last_used_at, 'o último uso precisa ficar registrado, senão não dá para saber se pode revogar')
  assert.equal(Object.keys(nossa).some((c) => String(nossa[c]).includes(chave)), false, 'a chave não pode voltar na listagem')

  // sem o cabeçalho do painel, criar chave é CSRF
  const csrf = await app.inject({ method: 'POST', url: '/painel/api/api-keys', headers: { cookie: sid }, payload: { name: 'x' } })
  assert.equal(csrf.statusCode, 403)
  assert.equal((await app.inject({ method: 'GET', url: '/painel/api/api-keys' })).statusCode, 401)
})

test('chaves: uma conta não revoga a chave da outra', async () => {
  const outraChave = `wak_${randomBytes(24).toString('hex')}`
  const { rows } = await pool.query<{ id: string }>('insert into accounts (name, api_key_hash) values ($1, $2) returning id', [
    'Outra Conta',
    createHash('sha256').update(outraChave).digest('hex'),
  ])
  const idDaOutra = await registrarChave(rows[0].id, 'Chave inicial', outraChave)

  const sid = await sessaoDoPainel()
  const tentativa = await app.inject({ method: 'POST', url: `/painel/api/api-keys/${idDaOutra}/revoke`, headers: { cookie: sid, 'x-painel': '1' } })
  assert.equal(tentativa.statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: '/instances', headers: { 'x-api-key': outraChave } })).statusCode, 200)

  const lista = (await app.inject({ method: 'GET', url: '/painel/api/api-keys', headers: { cookie: sid } })).json() as { keys: Array<{ id: string }> }
  assert.equal(lista.keys.some((k) => k.id === idDaOutra), false, 'a lista não pode vazar chave de outra conta')
})

test('chaves: a criação de instância aceita Bearer, x-api-key e Apikey (sistemas que vêm da W-API)', async () => {
  const criar = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/v1/integrator/create-instance', headers, payload: { instanceName: `via-${randomBytes(2).toString('hex')}` } })

  for (const headers of [{ authorization: `Bearer ${apiKey}` }, { 'x-api-key': apiKey }, { apikey: apiKey }]) {
    const res = await criar(headers)
    assert.equal(res.statusCode, 200, `${JSON.stringify(headers)} -> ${res.body}`)
    assert.equal(res.json().error, false)
  }
  assert.equal((await criar({ 'x-api-key': 'wak_errada' })).statusCode, 401)
  assert.equal((await criar({})).statusCode, 401)
})

// ---------- entrega de webhooks ----------

test('webhook: destino lento não segura aviso pronto de outro cliente', async () => {
  const { reservarLote } = await import('../src/webhooks/outbox.js')
  const lenta = await newInstance('fila-lenta')
  const rapida = await newInstance('fila-rapida')
  const url = 'https://exemplo.invalido/hook'
  for (const inst of [lenta, rapida]) {
    await pool.query(`update instances set wapi_webhooks = $2 where id = $1`, [inst.id, JSON.stringify({ received: url })])
  }
  const { enqueueWapiWebhook } = await import('../src/webhooks/outbox.js')
  for (let i = 0; i < 30; i++) await enqueueWapiWebhook(lenta.id, 'received', { event: 'webhookReceived', n: i })
  await enqueueWapiWebhook(rapida.id, 'received', { event: 'webhookReceived', n: 'urgente' })

  // A reserva devolve no máximo o que cabe nas vagas: é isso que permite puxar de novo
  // assim que uma entrega termina, em vez de esperar o lote inteiro.
  const nossos = (linhas: Array<{ id: number }>) => linhas.length
  const primeiro = await reservarLote(5)
  assert.equal(nossos(primeiro), 5, 'pega só o tamanho das vagas disponíveis')
  const segundo = await reservarLote(5)
  assert.equal(nossos(segundo), 5, 'com vagas novas, puxa mais sem esperar as anteriores')
  assert.equal(new Set([...primeiro, ...segundo].map((r) => r.id)).size, 10, 'não entrega o mesmo aviso duas vezes')

  // pedir zero vaga não toca na fila (worker lotado não deve reservar nada)
  assert.deepEqual(await reservarLote(0), [])

  // destino no limite fica de fora da reserva: a vaga vai para quem tem destino livre
  const { destinoDe } = await import('../src/webhooks/outbox.js')
  assert.equal(destinoDe(url), 'exemplo.invalido')
  const outraUrl = 'https://outro-destino.invalido/hook'
  const terceira = await newInstance('fila-outro-destino')
  await pool.query(`update instances set wapi_webhooks = $2 where id = $1`, [terceira.id, JSON.stringify({ received: outraUrl })])
  await enqueueWapiWebhook(terceira.id, 'received', { event: 'webhookReceived', n: 'outro' })

  const comExclusao = await reservarLote(10, ['exemplo.invalido'])
  assert.equal(comExclusao.length, 1, 'só o aviso do destino livre foi reservado')
  assert.equal(comExclusao[0].webhook_url, outraUrl)

  const restantes = await pool.query<{ n: number }>(
    "select count(*)::int as n from webhook_outbox where instance_id in ($1, $2) and delivered_at is null and failed_at is null",
    [lenta.id, rapida.id],
  )
  assert.equal(restantes.rows[0].n, 31, 'reservar não marca como entregue; só segura por 60s')
})

// ---------- registro de quedas ----------

test('quedas: registra começo e fim, e o dia soma o tempo fora', async () => {
  const { quedaComecou, quedaTerminou, quedasNaUltimaHora, resumoDoDia } = await import('../src/alerts/downtime.js')
  const inst = await newInstance('queda-1')

  await quedaComecou(inst.id, 428, 'Connection Terminated')
  // uma segunda queda sem ter voltado não abre outra linha: continua a mesma
  await quedaComecou(inst.id, 515, 'Stream Errored')
  const abertas = await pool.query('select count(*)::int as n, code from channel_downtime where instance_id = $1 and ended_at is null group by code', [inst.id])
  assert.equal(abertas.rows.length, 1)
  assert.equal(abertas.rows[0].n, 1)
  assert.equal(abertas.rows[0].code, 428, 'mantém o motivo da primeira queda')

  const segundos = await quedaTerminou(inst.id)
  assert.equal(typeof segundos, 'number')
  assert.ok(segundos! >= 0)
  assert.equal(await quedaTerminou(inst.id), undefined, 'voltar duas vezes não inventa queda')

  assert.equal(await quedasNaUltimaHora(inst.id), 1)
  const dia = await resumoDoDia(inst.id)
  assert.equal(dia.quedas, 1)
  assert.equal(typeof dia.segundos, 'number')
})

test('alerta: queda curta não vira e-mail; acima do limite na mesma hora, sim (uma vez)', async () => {
  const { channelUnstable } = await import('../src/alerts/alerts.js')
  const { quedaComecou, quedaTerminou } = await import('../src/alerts/downtime.js')
  const inst = await newInstance('queda-2')
  const enviados = async () =>
    (await pool.query<{ n: number }>("select count(*)::int as n from alert_outbox where instance_id = $1 and kind = 'flapping'", [inst.id])).rows[0].n

  // quatro quedas: rotina do WhatsApp, ninguém precisa saber
  for (let i = 0; i < 4; i++) {
    await quedaComecou(inst.id, 428, 'Connection Terminated')
    await quedaTerminou(inst.id)
    await channelUnstable(inst.id)
  }
  assert.equal(await enviados(), 0, 'quedas curtas não podem virar e-mail')

  // a quinta cruza o limite
  await quedaComecou(inst.id, 428, 'Connection Terminated')
  await quedaTerminou(inst.id)
  await channelUnstable(inst.id)
  assert.equal(await enviados(), 1)

  // e a sexta não repete o aviso dentro da mesma hora
  await quedaComecou(inst.id, 428, 'Connection Terminated')
  await quedaTerminou(inst.id)
  await channelUnstable(inst.id)
  assert.equal(await enviados(), 1, 'não pode encher a caixa de entrada')
})

// ---------- fila de envio ----------

test('fila: mesma idempotencyKey não cria dois envios; conteúdo fica cifrado no banco', async () => {
  const a = await newInstance()
  const payload = { to: '5511999999999', type: 'text' as const, text: 'mensagem sigilosa', idempotencyKey: 'pedido-1' }
  const first = await createJob(a.id, payload)
  const second = await createJob(a.id, payload)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.job.id, second.job.id)
  assert.equal(first.job.payload.type, 'text')
  const { rows } = await pool.query('select payload from send_jobs where id = $1', [first.job.id])
  assert.match(rows[0].payload, /^enc:v1:/)
  assert.ok(!rows[0].payload.includes('sigilosa'))
})

test('fila: erro temporário volta para a fila com espera; erro definitivo falha de vez', async () => {
  const a = await newInstance()
  await createJob(a.id, { to: '5511999999999', type: 'text', text: 'um' })
  let job = (await claimNextJob(a.id))!
  assert.equal(job.payload.text, 'um')
  await failJob(job, 'send_error', 'rede caiu', true)
  assert.equal((await getJob(a.id, job.id))!.status, 'queued')
  assert.equal(await claimNextJob(a.id), undefined) // ainda esperando o not_before
  await pool.query('update send_jobs set not_before = now() where id = $1', [job.id])
  job = (await claimNextJob(a.id))!
  await failJob(job, 'not_on_whatsapp', 'sem whatsapp', false)
  assert.equal((await getJob(a.id, job.id))!.status, 'failed')
})

// ---------- leases (posse das instâncias entre workers) ----------

test('lease: não toma instância de worker vivo; assume quando o lease vence', async () => {
  const a = await newInstance()
  await pool.query(`insert into instance_leases (instance_id, worker_id, expires_at) values ($1, 'outro-worker', now() + interval '30 seconds')`, [a.id])
  assert.equal((await acquireLease(a.id)).ok, false)
  await pool.query(`update instance_leases set expires_at = now() - interval '1 second' where instance_id = $1`, [a.id])
  const took = await acquireLease(a.id)
  assert.equal(took.ok, true)
  assert.equal(took.tookOver, true) // havia envios "no meio" a resolver
  assert.deepEqual([...(await renewLeases([a.id]))], [a.id])
  const { rows } = await pool.query('select worker_id from instance_leases where instance_id = $1', [a.id])
  assert.equal(rows[0].worker_id, workerId)
})

test('carga: worker ocupado para de pegar número novo, mas não solta nenhum dos seus', async () => {
  const { leastLoadedWorker } = await import('../src/cluster/leases.js')
  // dois números querendo ficar ligados, e outro worker vivo e folgado
  for (let i = 0; i < 2; i++) {
    const inst = await newInstance(`carga-${i}`)
    await pool.query('update instances set desired_running = true where id = $1', [inst.id])
    await pool.query(`insert into auth_creds (instance_id, creds) values ($1, 'x') on conflict do nothing`, [inst.id])
  }
  await pool.query(`insert into workers (id, host, port, instances, rss_mb, loop_lag_ms) values ('folgado', 'app_b', 9100, 9, 100, 5)
                    on conflict (id) do update set heartbeat_at = now(), draining = false, instances = 9, rss_mb = 100, loop_lag_ms = 5`)

  await heartbeat(5, 5)
  const comFolga = await fairShare()
  assert.ok(comFolga > 0, 'worker saudável continua pegando número')
  assert.equal((await leastLoadedWorker())?.id, workerId, 'com menos instâncias, é o escolhido')

  // agora o mesmo worker fica com atraso alto
  await heartbeat(5, 900)
  assert.equal(await fairShare(), 0, 'ocupado não pede mais número')
  assert.equal((await leastLoadedWorker())?.id, 'folgado', 'instância nova vai para o worker folgado')

  // o essencial: nada foi solto. Os leases dele continuam onde estavam.
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from instance_leases where worker_id = $1", [workerId])
  const meus = rows[0].n
  await heartbeat(5, 900)
  const depois = await pool.query<{ n: number }>("select count(*)::int as n from instance_leases where worker_id = $1", [workerId])
  assert.equal(depois.rows[0].n, meus, 'worker ocupado não pode soltar número — isso derrubaria cliente')

  // e se TODOS estiverem ocupados, volta a dividir: número sem dono é pior que worker lento
  await pool.query(`update workers set loop_lag_ms = 900 where id = 'folgado'`)
  assert.ok((await fairShare()) > 0, 'com todos ocupados, ninguém pode se recusar a atender')

  await pool.query(`delete from workers where id = 'folgado'`)
  await heartbeat(0, 5)
})

// ---------- migração de dados antigos ----------

test('deploy: worker saindo não conta na divisão; número passado fica sem dono até outro assumir', async () => {
  const inst = await newInstance()
  await pool.query('update instances set desired_running = true where id = $1', [inst.id])
  await pool.query(`insert into auth_creds (instance_id, creds) values ($1, 'x') on conflict do nothing`, [inst.id])
  await pool.query(`insert into workers (id, host, port) values ('outro-container', 'app_b', 9100) on conflict (id) do update set heartbeat_at = now(), draining = false`)
  await heartbeat(1, 0)
  assert.ok((await acquireLease(inst.id)).ok)
  const antes = await fairShare()

  await markDraining(1)
  assert.equal(await receivingWorkers(), 1)
  assert.ok((await fairShare()) >= antes, 'sem o worker que sai, a parte de cada um cresce')

  await handOff([inst.id])
  assert.equal(await stillOrphan([inst.id]), 1)
  // o outro container assume
  await pool.query(`insert into instance_leases (instance_id, worker_id, expires_at) values ($1, 'outro-container', now() + interval '30 seconds')`, [inst.id])
  assert.equal(await stillOrphan([inst.id]), 0)
  await pool.query(`delete from workers where id in ('outro-container', $1)`, [workerId])
})

test('dados antigos em texto puro são cifrados pela migração, e continuam legíveis', async () => {
  const a = await newInstance()
  await pool.query(`insert into messages (instance_id, remote_jid, id, from_me, message) values ($1, 'x@s.whatsapp.net', 'M1', false, '{"conversation":"antigo"}')`, [a.id])
  await pool.query(`update instances set token = 'token-antigo-em-texto' where id = $1`, [a.id])
  await encryptLegacyData(pool)
  const m = await pool.query(`select message from messages where instance_id = $1 and id = 'M1'`, [a.id])
  assert.match(m.rows[0].message, /^enc:v1:/)
  assert.equal(decrypt(m.rows[0].message), '{"conversation":"antigo"}')
  const t = await pool.query('select token from instances where id = $1', [a.id])
  assert.equal(decrypt(t.rows[0].token), 'token-antigo-em-texto')
})

// ---------- alertas ----------

test('alerta: canal caído avisa uma vez só; ao voltar, avisa que normalizou', async () => {
  const { channelDown, channelUp } = await import('../src/alerts/alerts.js')
  const a = await newInstance('canal-alerta')
  await channelDown(a.id, 'desconectado pelo celular')
  await channelDown(a.id, 'desconectado pelo celular')
  let q = await pool.query(`select kind, recipients, subject from alert_outbox where instance_id = $1 order by id`, [a.id])
  assert.equal(q.rows.length, 1)
  assert.equal(q.rows[0].kind, 'disconnected')
  assert.deepEqual(q.rows[0].recipients, ['painel@teste.com']) // sem e-mails configurados, vai para os usuários do painel
  await channelUp(a.id)
  await channelUp(a.id) // sem incidente aberto: não manda de novo
  q = await pool.query(`select kind from alert_outbox where instance_id = $1 order by id`, [a.id])
  assert.deepEqual(q.rows.map((r) => r.kind), ['disconnected', 'reconnected'])
})

test('alerta: e-mails configurados na conta têm prioridade sobre os do painel', async () => {
  const { channelDown } = await import('../src/alerts/alerts.js')
  const res = await app.inject({ method: 'PUT', url: '/account/alerts', headers: { 'x-api-key': apiKey }, payload: { alertEmails: ['Agencia@Exemplo.com'] } })
  assert.equal(res.statusCode, 200)
  const a = await newInstance()
  await channelDown(a.id, 'teste')
  const q = await pool.query(`select recipients from alert_outbox where instance_id = $1`, [a.id])
  assert.deepEqual(q.rows[0].recipients, ['agencia@exemplo.com'])
  await pool.query(`update accounts set alert_emails = '{}' where id = $1`, [accountId])
})

test('alerta interno: não repete o mesmo aviso dentro do intervalo', async () => {
  const { opsAlert } = await import('../src/alerts/alerts.js')
  await pool.query(`delete from ops_alert_state; delete from alert_outbox where kind = 'ops'`)
  await opsAlert('teste-chave', 'Teste', ['linha'])
  await opsAlert('teste-chave', 'Teste', ['linha'])
  const q = await pool.query(`select recipients from alert_outbox where kind = 'ops'`)
  assert.equal(q.rows.length, 1)
  assert.deepEqual(q.rows[0].recipients, ['ops@teste.com'])
})

test('resgate: eventos de mensagem voltam decifrados e em ordem a partir de "since"', async () => {
  const { enqueueWapiWebhook } = await import('../src/webhooks/outbox.js')
  const a = await newInstance()
  await pool.query(`update instances set wapi_webhooks = '{"received":"https://exemplo.com/hook"}' where id = $1`, [a.id])
  const antes = Math.floor(Date.now() / 1000) - 1
  await enqueueWapiWebhook(a.id, 'received', { event: 'webhookReceived', messageId: 'M-1', msgContent: { conversation: 'oi' } })
  await enqueueWapiWebhook(a.id, 'received', { event: 'webhookReceived', messageId: 'M-2', msgContent: { conversation: 'tudo bem?' } })
  const res = await app.inject({ method: 'GET', url: `/v1/webhook/fetch-events?instanceId=${a.id}&since=${antes}`, headers: { authorization: `Bearer ${a.token}` } })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.events.map((e: { messageId: string }) => e.messageId), ['M-1', 'M-2'])
  assert.ok(body.next > antes)
  const depois = await app.inject({ method: 'GET', url: `/v1/webhook/fetch-events?instanceId=${a.id}&since=${body.next}`, headers: { authorization: `Bearer ${a.token}` } })
  assert.deepEqual(depois.json().events, [])
})

// ---------- dashboard do painel ----------

test('dashboard: só conta o que é da conta, ignora histórico e status, e não compara com período já apagado', async () => {
  const novaConta = async (nome: string) => {
    const { rows } = await pool.query<{ id: string }>('insert into accounts (name, api_key_hash) values ($1, $2) returning id', [nome, randomBytes(16).toString('hex')])
    const inst = await pool.query<{ id: string }>(`insert into instances (account_id, name, webhook_secret, token) values ($1, 'n1', 's', $2) returning id`, [rows[0].id, randomBytes(16).toString('hex')])
    return { conta: rows[0].id, inst: inst.rows[0].id }
  }
  const nossa = await novaConta('Conta do dashboard')
  const outra = await novaConta('Outra conta')
  await createPanelUser(nossa.conta, 'dash@teste.com', 'senha-forte-123')

  const job = (inst: string, status: string, sentAt: string) => pool.query(`insert into send_jobs (instance_id, payload, status, sent_at) values ($1, '{}', $2, ${sentAt})`, [inst, status])
  for (let i = 0; i < 3; i++) await job(nossa.inst, 'sent', 'now()')
  for (let i = 0; i < 5; i++) await job(outra.inst, 'sent', 'now()') // de outra conta: não pode aparecer
  await job(nossa.inst, 'failed', 'null')
  await job(nossa.inst, 'queued', 'null')
  await job(nossa.inst, 'queued', 'null')
  // Início de ontem cai dentro de "o mesmo trecho do período anterior" em qualquer hora do dia
  await job(nossa.inst, 'sent', `date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' - interval '1 day'`)

  const msg = (id: string, jid: string, fromMe: boolean, ts: string) =>
    pool.query(`insert into messages (instance_id, remote_jid, id, from_me, message, ts) values ($1, $2, $3, $4, 'x', ${ts})`, [nossa.inst, jid, id, fromMe])
  const agora = 'extract(epoch from now())::bigint'
  await msg('R1', '55@s.whatsapp.net', false, agora)
  await msg('R2', '55@s.whatsapp.net', false, 'null') // sem horário do WhatsApp: vale o de gravação
  await msg('E1', '55@s.whatsapp.net', true, agora) // enviada: não é recebida
  await msg('S1', 'status@broadcast', false, agora) // status de contato: não é mensagem
  await msg('H1', '55@s.whatsapp.net', false, `${agora} - 86400 * 3`) // histórico importado agora, de 3 dias atrás

  for (let i = 0; i < 3; i++) await pool.query(`insert into webhook_outbox (instance_id, event, payload, delivered_at) values ($1, 'e', '{}', now())`, [nossa.inst])
  await pool.query(`insert into webhook_outbox (instance_id, event, payload, failed_at) values ($1, 'e', '{}', now())`, [nossa.inst])
  await pool.query(`insert into webhook_outbox (instance_id, event, payload) values ($1, 'e', '{}')`, [nossa.inst]) // pendente não entra na conta
  await pool.query(`insert into channel_downtime (instance_id, started_at, ended_at, seconds) values ($1, now() - interval '30 minutes', now() - interval '20 minutes', 600)`, [nossa.inst])

  assert.equal((await app.inject({ method: 'GET', url: '/painel/api/dashboard' })).statusCode, 401)

  const login = await app.inject({ method: 'POST', url: '/painel/api/login', payload: { email: 'dash@teste.com', password: 'senha-forte-123' } })
  const cookie = (login.headers['set-cookie'] as string).split(';')[0]
  const pedir = async (period: string) => {
    const res = await app.inject({ method: 'GET', url: `/painel/api/dashboard?period=${period}`, headers: { cookie } })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
  }
  assert.equal((await app.inject({ method: 'GET', url: '/painel/api/dashboard?period=1y', headers: { cookie } })).statusCode, 400)

  const hoje = await pedir('today')
  assert.equal(hoje.sent.value, 3)
  assert.equal(hoje.sent.previous, 1)
  assert.equal(hoje.failed.value, 1)
  assert.equal(hoje.received.value, 2)
  assert.equal(hoje.queued, 2)
  assert.deepEqual([hoje.webhooks.delivered, hoje.webhooks.failed], [3, 1])
  assert.ok(hoje.series.every((p: { t: string }) => /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(p.t)))
  assert.equal(hoje.series.reduce((soma: number, p: { sent: number }) => soma + p.sent, 0), 3)

  const semana = await pedir('7d')
  assert.equal(semana.downtime.drops, 1)
  assert.ok(Math.abs(semana.downtime.seconds - 600) <= 2)
  assert.equal(typeof semana.sent.previous, 'number') // envios ficam 30 dias: há com o que comparar
  assert.equal(semana.received.previous, null) // recebidas ficam 7 dias: o período anterior já foi limpo
  assert.equal(semana.received.partial, false)
  assert.equal(semana.series.length, 7)

  const mes = await pedir('30d')
  assert.equal(mes.sent.previous, null)
  assert.equal(mes.received.partial, true)
  assert.equal(mes.webhooks.partial, true)
  assert.equal(mes.series.length, 30)
  assert.equal(mes.weekly.length, 4)
  assert.deepEqual([mes.weekly[3].sent, mes.weekly[3].failed], [4, 1]) // bloco mais recente, inclui o de ontem
  assert.equal(mes.weekly.slice(0, 3).reduce((soma: number, w: { sent: number }) => soma + w.sent, 0), 0)
})
