import { spawn } from 'node:child_process'
import {
  BufferJSON,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WASocket,
} from 'baileys'
import mime from 'mime-types'
import sharp from 'sharp'
import { z } from 'zod'
import { config } from '../config.js'
import { pool } from '../db.js'
import { BlockedUrlError, safeFetch } from '../net/safe-fetch.js'
import { decrypt } from '../security/crypto.js'
import { extensionFor } from '../storage/media-storage.js'

export type SendErrorCode = 'not_on_whatsapp' | 'invalid_media' | 'message_not_found' | 'invalid_request' | 'send_error'

/** Erro de envio; só `send_error` vale tentar de novo */
export class SendError extends Error {
  constructor(
    readonly code: SendErrorCode,
    message: string,
  ) {
    super(message)
  }
  get retryable() {
    return this.code === 'send_error'
  }
}

export const mediaSourceSchema = {
  url: z.string().url().optional(),
  base64: z.string().optional(),
  mimetype: z.string().optional(),
}
const caption = z.string().max(4096).optional()
// Telefones ou JIDs a mencionar (@fulano)
const mentions = { mentions: z.array(z.string()).max(1024).optional(), mentionAll: z.boolean().optional() }
const viewOnce = { viewOnce: z.boolean().optional() }
const location = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
})

// Botões nativos (experimental: o WhatsApp pode não exibir em alguns aparelhos)
const buttonSchema = z.object({
  type: z.enum(['reply', 'url', 'call', 'copy']),
  text: z.string().min(1).max(40),
  id: z.string().max(256).optional(), // reply: id devolvido quando a pessoa toca
  url: z.string().url().optional(), // url
  phone: z.string().optional(), // call
  code: z.string().max(512).optional(), // copy
})
// Imagem/arquivo em campo único: URL ou base64
const mediaString = z.string().min(10)

export const outgoingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(65_536), ...mentions }),
  z.object({ type: z.literal('image'), ...mediaSourceSchema, caption, ...mentions, ...viewOnce }),
  z.object({
    type: z.literal('video'),
    ...mediaSourceSchema,
    caption,
    ...mentions,
    ...viewOnce,
    gif: z.boolean().optional(), // toca em loop, sem som
    videoNote: z.boolean().optional(), // vídeo redondo
  }),
  // ptt = mensagem de voz (converte para ogg/opus)
  z.object({ type: z.literal('audio'), ...mediaSourceSchema, ptt: z.boolean().default(true), ...viewOnce }),
  z.object({ type: z.literal('document'), ...mediaSourceSchema, fileName: z.string().max(255).optional(), caption, ...mentions }),
  // imagem comum (png/jpg/gif) é convertida para webp 512x512
  z.object({ type: z.literal('sticker'), ...mediaSourceSchema }),
  z.object({ type: z.literal('location'), ...location.shape }),
  z.object({
    type: z.literal('contact'),
    contacts: z
      .array(z.object({ name: z.string().min(1).max(200), phone: z.string().regex(/^\+?\d{8,15}$/), organization: z.string().max(200).optional() }))
      .min(1)
      .max(20),
  }),
  z.object({
    type: z.literal('poll'),
    name: z.string().min(1).max(255),
    options: z.array(z.string().min(1).max(100)).min(2).max(12),
    selectableCount: z.number().int().min(0).max(12).default(1), // 0 = quantas quiser
  }),
  z.object({
    type: z.literal('event'),
    name: z.string().min(1).max(255),
    description: z.string().max(2048).optional(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().optional(),
    location: location.optional(),
    call: z.enum(['audio', 'video']).optional(),
  }),
  // emoji vazio remove a reação
  z.object({ type: z.literal('reaction'), messageId: z.string().min(1), emoji: z.string().max(16) }),
  z.object({ type: z.literal('edit'), messageId: z.string().min(1), text: z.string().min(1).max(65_536) }),
  z.object({ type: z.literal('delete'), messageId: z.string().min(1) }),
  z.object({ type: z.literal('forward'), messageId: z.string().min(1) }),
  // Link com prévia montada por quem envia (título, descrição e imagem informados, sem o servidor visitar o site)
  z.object({
    type: z.literal('link'),
    text: z.string().min(1).max(65_536),
    url: z.string().url(),
    title: z.string().max(300),
    description: z.string().max(1000).optional(),
    image: mediaString.optional(),
  }),
  z.object({
    type: z.literal('buttons'),
    text: z.string().min(1).max(4096),
    title: z.string().max(60).optional(),
    footer: z.string().max(60).optional(),
    buttons: z.array(buttonSchema).min(1).max(10),
  }),
  z.object({
    type: z.literal('list'),
    text: z.string().min(1).max(4096),
    title: z.string().max(60).optional(),
    footer: z.string().max(60).optional(),
    buttonText: z.string().min(1).max(20),
    sections: z
      .array(
        z.object({
          title: z.string().max(24),
          rows: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24), description: z.string().max(72).optional() })).min(1).max(10),
        }),
      )
      .min(1)
      .max(10),
  }),
  z.object({
    type: z.literal('carousel'),
    text: z.string().min(1).max(4096),
    cards: z.array(z.object({ text: z.string().min(1).max(160), image: mediaString, buttons: z.array(buttonSchema).min(1).max(2) })).min(1).max(10),
  }),
  z.object({
    type: z.literal('pix'),
    merchantName: z.string().max(100).default(''),
    pixKey: z.string().min(1).max(100),
    keyType: z.enum(['CPF', 'CNPJ', 'PHONE', 'EMAIL', 'EVP']),
    amount: z.number().min(0).max(1_000_000).default(0),
  }),
  z.object({
    type: z.literal('pin'),
    messageId: z.string().min(1),
    pin: z.boolean().default(true),
    duration: z.union([z.literal(86400), z.literal(604800), z.literal(2592000)]).default(604800),
  }),
])

export const sendRequestSchema = z.preprocess(
  // Compatível com a Fase 1: {to, text} sem type = texto
  (v) => (v && typeof v === 'object' && !('type' in v) && 'text' in v ? { ...v, type: 'text' } : v),
  z.intersection(
    z.object({
      // telefone, JID ou "status" (publica nos status/stories)
      to: z.string().min(6).optional(),
      quotedId: z.string().optional(),
      idempotencyKey: z.string().max(200).optional(),
      // espera antes de enviar (segundos); a mensagem fica na fila até lá
      delaySeconds: z.number().int().min(0).max(3600).optional(),
      // só para to = "status"
      statusRecipients: z.array(z.string()).max(5000).optional(),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      font: z.number().int().min(0).max(9).optional(),
    }),
    outgoingSchema,
  ),
)

export type SendRequest = z.infer<typeof sendRequestSchema>

/** Tipos montados à mão como mensagem interativa (botões nativos) */
const INTERACTIVE = new Set(['buttons', 'list', 'carousel', 'pix'])

/** Tipos que agem sobre uma mensagem existente (o destino vem da mensagem, não de `to`) */
export const TARGETS_MESSAGE = new Set(['reaction', 'edit', 'delete', 'pin'])

export async function loadStoredMessage(instanceId: string, messageId: string): Promise<WAMessage | undefined> {
  const { rows } = await pool.query<{ remote_jid: string; id: string; from_me: boolean; participant: string | null; message: string }>(
    `select remote_jid, id, from_me, participant, message from messages
     where instance_id = $1 and id = $2 order by created_at desc limit 1`,
    [instanceId, messageId],
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    key: { remoteJid: row.remote_jid, id: row.id, fromMe: row.from_me, participant: row.participant ?? undefined },
    message: proto.Message.fromObject(JSON.parse(decrypt(row.message), BufferJSON.reviver)),
  }
}

async function requireStored(instanceId: string, messageId: string) {
  const msg = await loadStoredMessage(instanceId, messageId)
  if (!msg) throw new SendError('message_not_found', `mensagem ${messageId} não encontrada (só guardamos os últimos ${config.MESSAGE_RETENTION_DAYS} dias)`)
  return msg
}

const maxBytes = () => config.MEDIA_MAX_MB * 1024 * 1024

export async function loadMedia(src: { url?: string; base64?: string; mimetype?: string }) {
  if (src.base64) {
    const match = src.base64.match(/^data:([^;,]+)[^,]*,(.*)$/s)
    const buffer = Buffer.from(match ? match[2] : src.base64, 'base64')
    if (!buffer.length) throw new SendError('invalid_media', 'base64 vazio ou inválido')
    if (buffer.length > maxBytes()) throw new SendError('invalid_media', `arquivo maior que ${config.MEDIA_MAX_MB} MB`)
    return { buffer, mimetype: src.mimetype ?? match?.[1] ?? 'application/octet-stream', name: undefined }
  }
  if (!src.url) throw new SendError('invalid_request', 'informe url ou base64')

  let res: Awaited<ReturnType<typeof safeFetch>>
  try {
    res = await safeFetch(src.url, { signal: AbortSignal.timeout(60_000) })
  } catch (err) {
    const reason = err instanceof BlockedUrlError ? err.message : ((err as Error).cause as Error)?.message ?? (err as Error).message
    throw new SendError('invalid_media', `não consegui baixar a mídia: ${reason}`)
  }
  if (!res.ok) throw new SendError('invalid_media', `não consegui baixar a mídia: HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes()) {
    throw new SendError('invalid_media', `arquivo maior que ${config.MEDIA_MAX_MB} MB`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > maxBytes()) throw new SendError('invalid_media', `arquivo maior que ${config.MEDIA_MAX_MB} MB`)
  const name = decodeURIComponent(new URL(src.url).pathname.split('/').pop() || '') || undefined
  const headerType = res.headers.get('content-type')?.split(';')[0]
  const mimetype =
    src.mimetype ??
    (headerType && headerType !== 'application/octet-stream' ? headerType : undefined) ??
    (name ? mime.lookup(name) || undefined : undefined) ??
    'application/octet-stream'
  return { buffer, mimetype, name }
}

/** Mensagem de voz do WhatsApp precisa ser ogg/opus mono */
const toOggOpus = (input: Buffer) =>
  ffmpeg(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'], input, 'não consegui converter o áudio')

/** Roda o ffmpeg com o buffer na entrada e devolve a saída */
function ffmpeg(args: string[], input: Buffer, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args])
    const out: Buffer[] = []
    let stderr = ''
    ff.stdout.on('data', (d: Buffer) => out.push(d))
    ff.stderr.on('data', (d: Buffer) => (stderr += d))
    ff.on('error', (err) => reject(new SendError('invalid_media', `ffmpeg indisponível: ${err.message}`)))
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new SendError('invalid_media', `${what}: ${stderr.trim().slice(0, 200)}`)),
    )
    ff.stdin.on('error', () => undefined) // ffmpeg pode fechar a entrada antes de ler tudo
    ff.stdin.end(input)
  })
}

export const WAVEFORM_BARS = 64

/**
 * Ondinha do áudio de voz (as barrinhas no balão): 64 valores de 0 a 100, como o app do WhatsApp manda.
 * Sem ela o áudio chega com uma linha reta. Calculada da amplitude média de cada trecho
 */
export async function audioWaveform(input: Buffer): Promise<Uint8Array | undefined> {
  try {
    const pcm = await ffmpeg(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], input, 'não consegui ler o áudio')
    const samples = Math.floor(pcm.length / 2)
    if (samples < WAVEFORM_BARS) return undefined
    const per = Math.floor(samples / WAVEFORM_BARS)
    const bars: number[] = []
    for (let b = 0; b < WAVEFORM_BARS; b++) {
      let sum = 0
      for (let i = b * per; i < (b + 1) * per; i++) sum += Math.abs(pcm.readInt16LE(i * 2))
      bars.push(sum / per)
    }
    const max = Math.max(...bars)
    if (!max) return new Uint8Array(WAVEFORM_BARS)
    return Uint8Array.from(bars, (v) => Math.round((100 * v) / max))
  } catch {
    return undefined // sem ondinha o áudio ainda vai; não vale falhar o envio por isso
  }
}

/** Figurinha = webp 512x512 com fundo transparente (gif animado vira webp animado) */
async function toSticker(input: Buffer, mimetype: string) {
  if (mimetype === 'image/webp') return input
  try {
    return await sharp(input, { animated: true })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer()
  } catch (err) {
    throw new SendError('invalid_media', `não consegui converter em figurinha: ${(err as Error).message}`)
  }
}

const mediaFromString = (value: string) =>
  loadMedia(/^https?:\/\//.test(value) ? { url: value } : { base64: value })

async function linkThumbnail(image: string) {
  try {
    const m = await mediaFromString(image)
    return await sharp(m.buffer).resize(300, 300, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
  } catch {
    return undefined // prévia sem imagem é melhor que não enviar
  }
}

const nativeButton = (b: z.infer<typeof buttonSchema>) => {
  switch (b.type) {
    case 'reply':
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id ?? b.text }) }
    case 'url':
      return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) }
    case 'call':
      return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: b.text, phone_number: b.phone }) }
    case 'copy':
      return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: b.text, copy_code: b.code, id: b.id ?? 'copy' }) }
  }
}

/** Monta a mensagem interativa (nativeFlow), o mesmo formato que o WhatsApp Business usa */
async function buildInteractive(sock: WASocket, req: SendRequest): Promise<proto.IMessage> {
  let interactive: proto.Message.IInteractiveMessage
  if (req.type === 'buttons') {
    interactive = {
      header: req.title ? { title: req.title, hasMediaAttachment: false } : undefined,
      body: { text: req.text },
      footer: req.footer ? { text: req.footer } : undefined,
      nativeFlowMessage: { buttons: req.buttons.map(nativeButton), messageParamsJson: '' },
    }
  } else if (req.type === 'list') {
    interactive = {
      header: req.title ? { title: req.title, hasMediaAttachment: false } : undefined,
      body: { text: req.text },
      footer: req.footer ? { text: req.footer } : undefined,
      nativeFlowMessage: {
        buttons: [
          {
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title: req.buttonText,
              sections: req.sections.map((sec) => ({
                title: sec.title,
                rows: sec.rows.map((r) => ({ header: '', title: r.title, description: r.description ?? '', id: r.id })),
              })),
            }),
          },
        ],
        messageParamsJson: '',
      },
    }
  } else if (req.type === 'carousel') {
    const cards = []
    for (const card of req.cards) {
      const m = await mediaFromString(card.image)
      const media = await prepareWAMessageMedia({ image: m.buffer }, { upload: sock.waUploadToServer })
      cards.push({
        header: { hasMediaAttachment: true, imageMessage: media.imageMessage },
        body: { text: card.text },
        nativeFlowMessage: { buttons: card.buttons.map(nativeButton), messageParamsJson: '' },
      })
    }
    interactive = { body: { text: req.text }, carouselMessage: { cards, messageVersion: 1 } }
  } else if (req.type === 'pix') {
    const cents = Math.round(req.amount * 100)
    const money = { value: cents, offset: 100 }
    interactive = {
      body: { text: '' },
      nativeFlowMessage: {
        buttons: [
          {
            name: 'payment_info',
            buttonParamsJson: JSON.stringify({
              currency: 'BRL',
              total_amount: money,
              reference_id: Math.random().toString(36).slice(2, 12).toUpperCase(),
              type: 'physical-goods',
              order: { status: 'pending', subtotal: money, order_type: 'ORDER', items: [{ name: '', amount: money, quantity: 1, sale_amount: money }] },
              payment_settings: [
                { type: 'pix_static_code', pix_static_code: { merchant_name: req.merchantName, key: req.pixKey, key_type: req.keyType } },
              ],
              share_payment_status: false,
            }),
          },
        ],
        messageParamsJson: '',
      },
    }
  } else {
    throw new SendError('invalid_request', 'tipo interativo desconhecido')
  }
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: interactive,
      },
    },
  }
}

// Sem esse nó o WhatsApp não entrega mensagens interativas vindas de aparelho não-Business
const INTERACTIVE_NODES = [
  {
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }],
  },
]

const toJid = (phoneOrJid: string) => (phoneOrJid.includes('@') ? phoneOrJid : `${phoneOrJid.replace(/\D/g, '')}@s.whatsapp.net`)

function vcard(c: { name: string; phone: string; organization?: string }) {
  const digits = c.phone.replace(/\D/g, '')
  const esc = (s: string) => s.replace(/[\n;,]/g, ' ')
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${esc(c.name)}`,
    c.organization ? `ORG:${esc(c.organization)};` : undefined,
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    'END:VCARD',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Monta e envia. `jid` é o destino já resolvido (undefined para tipos que agem sobre uma mensagem
 * existente). `options` extra vai direto ao Baileys (ex.: statusJidList)
 */
export async function sendPayload(
  sock: WASocket,
  instanceId: string,
  jid: string | undefined,
  req: SendRequest,
  extra: MiscMessageGenerationOptions = {},
) {
  // Responder citando uma mensagem que não temos (anterior à conexão do número, ou de
  // outro provedor) não pode derrubar o envio: manda sem a citação, que é o que importa
  // para o cliente do outro lado (medido em 23/09/2026: 8 respostas perdidas assim)
  const quoted = req.quotedId ? await loadStoredMessage(instanceId, req.quotedId) : undefined

  if (INTERACTIVE.has(req.type)) {
    if (!jid) throw new SendError('invalid_request', 'informe "to"')
    try {
      const content = await buildInteractive(sock, req)
      const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user!.id, messageId: extra.messageId, quoted })
      await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id!, additionalNodes: INTERACTIVE_NODES })
      await sock.upsertMessage(msg, 'append')
      return { sent: msg, jid }
    } catch (err) {
      if (err instanceof SendError) throw err
      throw new SendError('send_error', (err as Error).message)
    }
  }

  let content: AnyMessageContent
  let target = jid
  const mention = 'mentions' in req && req.mentions ? { mentions: req.mentions.map(toJid) } : {}
  const mentionAll = 'mentionAll' in req && req.mentionAll ? { mentionAll: true } : {}
  const once = 'viewOnce' in req && req.viewOnce ? { viewOnce: true } : {}

  switch (req.type) {
    case 'text':
      content = { text: req.text, ...mention, ...mentionAll }
      break
    case 'image': {
      const m = await loadMedia(req)
      content = { image: m.buffer, mimetype: m.mimetype, caption: req.caption, ...mention, ...mentionAll, ...once }
      break
    }
    case 'video': {
      const m = await loadMedia(req)
      content = req.videoNote
        ? { video: m.buffer, mimetype: m.mimetype, ptv: true }
        : { video: m.buffer, mimetype: m.mimetype, caption: req.caption, gifPlayback: req.gif, ...mention, ...mentionAll, ...once }
      break
    }
    case 'audio': {
      const m = await loadMedia(req)
      if (req.ptt) {
        // waveform (as barrinhas do áudio) não está nos tipos do Baileys, mas ele usa o campo ao montar a mensagem
        const voice = { audio: await toOggOpus(m.buffer), ptt: true, mimetype: 'audio/ogg; codecs=opus', waveform: await audioWaveform(m.buffer), ...once }
        content = voice as AnyMessageContent
      } else {
        content = { audio: m.buffer, mimetype: m.mimetype, ...once }
      }
      break
    }
    case 'document': {
      const m = await loadMedia(req)
      const fileName = req.fileName ?? m.name ?? `arquivo.${extensionFor(m.mimetype)}`
      content = { document: m.buffer, mimetype: m.mimetype, fileName, caption: req.caption, ...mention }
      break
    }
    case 'sticker': {
      const m = await loadMedia(req)
      content = { sticker: await toSticker(m.buffer, m.mimetype) }
      break
    }
    case 'link': {
      const thumb = req.image ? await linkThumbnail(req.image) : undefined
      content = {
        text: req.text.includes(req.url) ? req.text : `${req.text}\n${req.url}`,
        linkPreview: { 'canonical-url': req.url, 'matched-text': req.url, title: req.title, description: req.description, jpegThumbnail: thumb },
      }
      break
    }
    case 'buttons':
    case 'list':
    case 'carousel':
    case 'pix':
      throw new SendError('invalid_request', 'tratado acima') // nunca chega aqui
    case 'location':
      content = {
        location: { degreesLatitude: req.latitude, degreesLongitude: req.longitude, name: req.name, address: req.address },
      }
      break
    case 'contact':
      content = {
        contacts: {
          displayName: req.contacts.length === 1 ? req.contacts[0].name : `${req.contacts.length} contatos`,
          contacts: req.contacts.map((c) => ({ displayName: c.name, vcard: vcard(c) })),
        },
      }
      break
    case 'poll':
      content = { poll: { name: req.name, values: req.options, selectableCount: req.selectableCount } }
      break
    case 'event':
      content = {
        event: {
          name: req.name,
          description: req.description,
          startDate: req.startDate,
          endDate: req.endDate,
          call: req.call,
          location: req.location
            ? { degreesLatitude: req.location.latitude, degreesLongitude: req.location.longitude, name: req.location.name, address: req.location.address }
            : undefined,
        },
      }
      break
    case 'forward': {
      const msg = await requireStored(instanceId, req.messageId)
      content = { forward: msg }
      break
    }
    case 'reaction': {
      const msg = await requireStored(instanceId, req.messageId)
      target = msg.key.remoteJid!
      content = { react: { text: req.emoji, key: msg.key } }
      break
    }
    case 'edit': {
      const msg = await requireStored(instanceId, req.messageId)
      if (!msg.key.fromMe) throw new SendError('invalid_request', 'só dá para editar mensagens enviadas por este número')
      target = msg.key.remoteJid!
      content = { text: req.text, edit: msg.key }
      break
    }
    case 'delete': {
      const msg = await requireStored(instanceId, req.messageId)
      if (!msg.key.fromMe) throw new SendError('invalid_request', 'só dá para apagar para todos mensagens enviadas por este número')
      target = msg.key.remoteJid!
      content = { delete: msg.key }
      break
    }
    case 'pin': {
      const msg = await requireStored(instanceId, req.messageId)
      target = msg.key.remoteJid!
      content = {
        pin: msg.key,
        type: req.pin ? proto.PinInChat.Type.PIN_FOR_ALL : proto.PinInChat.Type.UNPIN_FOR_ALL,
        time: req.duration,
      }
      break
    }
  }

  if (!target) throw new SendError('invalid_request', 'informe "to"')
  try {
    const sent = await sock.sendMessage(target, content, { quoted, ...extra })
    return { sent, jid: target }
  } catch (err) {
    throw new SendError('send_error', (err as Error).message)
  }
}
