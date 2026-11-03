import { proto, type WAMessage } from 'baileys'
import { enqueueWapiWebhook } from '../../webhooks/outbox.js'

/**
 * Webhooks no formato da W-API (webhookReceived, webhookDelivery, webhookStatus,
 * webhookConnected, webhookDisconnected, webhookPresence), para o CRM trocar de
 * provedor sem mudar código. Formatos copiados da documentação oficial (docs/wapi-spec.json)
 */

export type WapiContext = {
  instanceId: string
  connectedPhone: string | null
  connectedLid: string | null
}

const nowSeconds = () => Math.floor(Date.now() / 1000)
const digits = (jid?: string | null) => (jid ? jid.split('@')[0].split(':')[0] : '')

/**
 * A W-API roda sobre o whatsmeow (Go): os campos de mídia saem como `URL`, `fileSHA256`...
 * e os bytes em base64. Geramos os dois nomes para funcionar com código escrito para ela
 */
export function toWhatsmeowJson(message: proto.IMessage) {
  const obj = proto.Message.toObject(proto.Message.fromObject(message), { bytes: String, longs: String, defaults: false })
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = walk(v)
      if (k === 'url') out.URL = v
      if (k === 'fileSha256') out.fileSHA256 = v
      if (k === 'fileEncSha256') out.fileEncSHA256 = v
    }
    return out
  }
  return walk(obj) as Record<string, unknown>
}

export async function wapiMessage(
  ctx: WapiContext,
  msg: WAMessage,
  info: {
    isGroup: boolean
    chatPhone?: string
    senderPhone?: string
    senderLid?: string
    fromApi: boolean
    chatPicture?: string | null
    senderPicture?: string | null
    /** Mensagem antiga, importada na conexão: quem recebe não deve tratar como novidade */
    historical?: boolean
  },
) {
  const fromMe = !!msg.key.fromMe
  const remote = msg.key.remoteJid!
  // Conversa: grupo = id do grupo; individual = telefone (ou o @lid quando não dá para saber o número)
  const chatId = info.isGroup ? remote : info.chatPhone ?? remote
  const senderId = fromMe ? ctx.connectedPhone ?? '' : info.isGroup ? info.senderPhone ?? digits(msg.key.participant) : info.chatPhone ?? digits(remote)
  const event = fromMe ? 'webhookDelivery' : 'webhookReceived'
  const moment = Number(msg.messageTimestamp ?? nowSeconds())

  await enqueueWapiWebhook(ctx.instanceId, fromMe ? 'delivery' : 'received', {
    event,
    instanceId: ctx.instanceId,
    connectedPhone: ctx.connectedPhone,
    connectedLid: ctx.connectedLid,
    isGroup: info.isGroup,
    messageId: msg.key.id,
    fromMe,
    chat: { id: chatId, profilePicture: info.chatPicture ?? null },
    sender: {
      id: senderId,
      ...(info.senderLid ? { senderLid: info.senderLid } : {}),
      profilePicture: info.senderPicture ?? null,
      pushName: msg.pushName ?? '',
      verifiedBizName: msg.verifiedBizName ?? '',
    },
    moment,
    ...(info.historical ? { historical: true } : {}),
    ...(fromMe ? { fromApi: info.fromApi } : {}),
    msgContent: msg.message ? toWhatsmeowJson(msg.message) : {},
  })
}

const STATUS_NAMES: Record<number, string> = {
  [proto.WebMessageInfo.Status.ERROR]: 'ERROR',
  [proto.WebMessageInfo.Status.PENDING]: 'PENDING',
  [proto.WebMessageInfo.Status.SERVER_ACK]: 'SERVER_ACK',
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'DELIVERY',
  [proto.WebMessageInfo.Status.READ]: 'READ',
  [proto.WebMessageInfo.Status.PLAYED]: 'PLAYED',
}

export async function wapiStatus(ctx: WapiContext, update: { id: string; chatId: string; fromMe: boolean; status: number }) {
  const status = STATUS_NAMES[update.status]
  if (!status) return
  await enqueueWapiWebhook(ctx.instanceId, 'status', {
    event: 'webhookStatus',
    instanceId: ctx.instanceId,
    connectedPhone: ctx.connectedPhone,
    connectedLid: ctx.connectedLid,
    status,
    messageId: update.id,
    fromMe: update.fromMe,
    moment: Date.now(),
    chat: { id: update.chatId },
    isGroup: update.chatId.endsWith('@g.us'),
  })
}

export async function wapiConnected(ctx: WapiContext) {
  await enqueueWapiWebhook(
    ctx.instanceId,
    'connected',
    {
      event: 'webhookConnected',
      instanceId: ctx.instanceId,
      connectedPhone: ctx.connectedPhone,
      connectedLid: ctx.connectedLid,
      connected: true,
      moment: nowSeconds(),
    },
    // Par do aviso de queda: sem ele o sistema ficaria achando que o número continua fora
    { fallbackToAny: true },
  )
}

export async function wapiDisconnected(instanceId: string) {
  await enqueueWapiWebhook(
    instanceId,
    'disconnected',
    { event: 'webhookDisconnected', instanceId, disconnected: true, moment: nowSeconds() },
    { fallbackToAny: true },
  )
}

export async function wapiPresence(ctx: WapiContext, update: { id: string; presences: Record<string, { lastKnownPresence: string; lastSeen?: number }> }) {
  for (const [who, p] of Object.entries(update.presences)) {
    await enqueueWapiWebhook(ctx.instanceId, 'presence', {
      event: 'webhookPresence',
      instanceId: ctx.instanceId,
      connectedPhone: ctx.connectedPhone,
      chat: { id: update.id },
      participant: who,
      presence: p.lastKnownPresence.toUpperCase(),
      lastSeen: p.lastSeen ?? null,
      moment: nowSeconds(),
    })
  }
}
