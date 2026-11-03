import { BufferJSON, getContentType, normalizeMessageContent, proto } from 'baileys'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../db.js'
import { decrypt } from '../security/crypto.js'
import { loadMedia, mediaSourceSchema } from '../whatsapp/outgoing.js'
import { loadConnectedSession, loadInstance, parse } from './common.js'

const chatParam = z.object({ chatId: z.string().includes('@') }).passthrough()
const contactParam = z.object({ contact: z.string().min(8) }).passthrough()

type MessageRow = { remote_jid: string; id: string; from_me: boolean; participant: string | null; message: string; created_at: Date }

const summarize = (row: MessageRow) => {
  const message = normalizeMessageContent(proto.Message.fromObject(JSON.parse(decrypt(row.message), BufferJSON.reviver)))
  const type = getContentType(message)
  const inner = type ? (message as Record<string, { text?: string; caption?: string } | string | undefined>)[type] : undefined
  const text = typeof inner === 'string' ? inner : inner?.text ?? inner?.caption
  return { id: row.id, fromMe: row.from_me, sender: row.participant, type, text, at: row.created_at }
}

export async function chatRoutes(api: FastifyInstance) {
  // ---------- conversas ----------

  /** Conversas com mensagens guardadas (janela de retenção), da mais recente para a mais antiga */
  api.get('/instances/:id/chats', async (req) => {
    const instance = await loadInstance(req)
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query)
    const { rows } = await pool.query<MessageRow & { phone: string | null }>(
      `select * from (
         select distinct on (m.remote_jid) m.*, l.pn as phone
         from messages m
         left join lid_mappings l on l.instance_id = m.instance_id and l.lid = m.remote_jid
         where m.instance_id = $1 and m.remote_jid <> 'status@broadcast'
         order by m.remote_jid, m.created_at desc
       ) t order by created_at desc limit $2`,
      [instance.id, limit],
    )
    return rows.map((r) => ({
      chatId: r.remote_jid,
      isGroup: r.remote_jid.endsWith('@g.us'),
      phone: r.remote_jid.endsWith('@s.whatsapp.net') ? r.remote_jid.split('@')[0] : r.phone?.split('@')[0] ?? null,
      lastMessage: summarize(r),
    }))
  })

  api.get('/instances/:id/chats/:chatId/messages', async (req) => {
    const instance = await loadInstance(req)
    const { chatId } = parse(chatParam, req.params)
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), req.query)
    const { rows } = await pool.query<MessageRow>(
      'select * from messages where instance_id = $1 and remote_jid = $2 order by created_at desc limit $3',
      [instance.id, chatId, limit],
    )
    return rows.map(summarize)
  })

  api.post('/instances/:id/chats/read', async (req) => {
    const { session } = await loadConnectedSession(req)
    const body = parse(z.object({ chatId: z.string().includes('@'), messageIds: z.array(z.string()).optional() }), req.body)
    return { marked: await session.markRead(body.chatId, body.messageIds) }
  })

  // archive | unarchive | pin | unpin | mute | unmute | unread | clear | delete
  api.post('/instances/:id/chats/:chatId/:action', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { chatId, action } = parse(
      chatParam.extend({ action: z.enum(['archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute', 'unread', 'clear', 'delete']) }),
      req.params,
    )
    const { seconds } = parse(z.object({ seconds: z.number().int().min(60).optional() }), req.body ?? {})
    await session.modifyChat(chatId, action, seconds)
    return { ok: true }
  })

  api.post('/instances/:id/presence', async (req) => {
    const { session } = await loadConnectedSession(req)
    const body = parse(
      z.object({ to: z.string().min(8), state: z.enum(['composing', 'recording', 'paused', 'available', 'unavailable']) }),
      req.body,
    )
    await session.presence(body.to, body.state)
    return { ok: true }
  })

  /** Mídia de uma mensagem guardada (gera link novo) */
  api.get('/instances/:id/messages/:messageId/media', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { messageId } = parse(z.object({ messageId: z.string().min(1) }).passthrough(), req.params)
    return session.redownloadMedia(messageId)
  })

  // ---------- contatos ----------

  api.get('/instances/:id/check/:phone', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { phone } = parse(z.object({ phone: z.string().regex(/^\+?\d{8,15}$/) }).passthrough(), req.params)
    return session.checkNumber(phone)
  })

  api.get('/instances/:id/contacts/:contact/photo', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    return session.profilePicture(contact)
  })

  /** Recado ("about") do contato */
  api.get('/instances/:id/contacts/:contact/about', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    const jid = await session.jidFor(contact)
    const [result] = (await session.socket().fetchStatus(jid)) ?? []
    const status = (result as { status?: { status?: string; setAt?: Date } } | undefined)?.status
    return { jid, about: status?.status ?? null, setAt: status?.setAt ?? null }
  })

  api.get('/instances/:id/contacts/:contact/business', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    const jid = await session.jidFor(contact)
    return { jid, business: (await session.socket().getBusinessProfile(jid)) ?? null }
  })

  api.post('/instances/:id/contacts/:contact/block', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    await session.socket().updateBlockStatus(await session.jidFor(contact), 'block')
    return { ok: true }
  })

  api.post('/instances/:id/contacts/:contact/unblock', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    await session.socket().updateBlockStatus(await session.jidFor(contact), 'unblock')
    return { ok: true }
  })

  api.get('/instances/:id/blocklist', async (req) => {
    const { session } = await loadConnectedSession(req)
    return session.socket().fetchBlocklist()
  })

  /** Passa a receber o "online"/"digitando" desse contato no webhook presence.update */
  api.post('/instances/:id/contacts/:contact/subscribe-presence', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { contact } = parse(contactParam, req.params)
    await session.socket().presenceSubscribe(await session.jidFor(contact))
    return { ok: true }
  })

  // ---------- perfil do próprio número ----------

  api.get('/instances/:id/profile', async (req) => {
    const { session } = await loadConnectedSession(req)
    const sock = session.socket()
    const me = sock.user!
    let picture: string | null = null
    try {
      picture = (await sock.profilePictureUrl(me.id, 'image')) ?? null
    } catch {
      // sem foto
    }
    return { jid: me.id, lid: me.lid ?? null, name: me.name ?? me.notify ?? null, picture }
  })

  api.put('/instances/:id/profile/name', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { name } = parse(z.object({ name: z.string().min(1).max(25) }), req.body)
    await session.socket().updateProfileName(name)
    return { ok: true }
  })

  api.put('/instances/:id/profile/about', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { about } = parse(z.object({ about: z.string().max(139) }), req.body)
    await session.socket().updateProfileStatus(about)
    return { ok: true }
  })

  api.put('/instances/:id/profile/picture', async (req) => {
    const { session } = await loadConnectedSession(req)
    const sock = session.socket()
    const media = await loadMedia(parse(z.object(mediaSourceSchema), req.body))
    await sock.updateProfilePicture(sock.user!.id, media.buffer)
    return { ok: true }
  })

  api.delete('/instances/:id/profile/picture', async (req) => {
    const { session } = await loadConnectedSession(req)
    const sock = session.socket()
    await sock.removeProfilePicture(sock.user!.id)
    return { ok: true }
  })

  api.get('/instances/:id/privacy', async (req) => {
    const { session } = await loadConnectedSession(req)
    return session.socket().fetchPrivacySettings(true)
  })

  api.put('/instances/:id/privacy', async (req) => {
    const { session } = await loadConnectedSession(req)
    const sock = session.socket()
    const who = z.enum(['all', 'contacts', 'contact_blacklist', 'none'])
    const body = parse(
      z.object({
        lastSeen: who.optional(),
        online: z.enum(['all', 'match_last_seen']).optional(),
        profilePicture: who.optional(),
        about: who.optional(),
        readReceipts: z.enum(['all', 'none']).optional(),
        groupsAdd: z.enum(['all', 'contacts', 'contact_blacklist']).optional(),
        calls: z.enum(['all', 'known']).optional(),
        messages: z.enum(['all', 'contacts']).optional(),
      }),
      req.body,
    )
    if (body.lastSeen) await sock.updateLastSeenPrivacy(body.lastSeen)
    if (body.online) await sock.updateOnlinePrivacy(body.online)
    if (body.profilePicture) await sock.updateProfilePicturePrivacy(body.profilePicture)
    if (body.about) await sock.updateStatusPrivacy(body.about)
    if (body.readReceipts) await sock.updateReadReceiptsPrivacy(body.readReceipts)
    if (body.groupsAdd) await sock.updateGroupsAddPrivacy(body.groupsAdd)
    if (body.calls) await sock.updateCallPrivacy(body.calls)
    if (body.messages) await sock.updateMessagesPrivacy(body.messages)
    return sock.fetchPrivacySettings(true)
  })

  // ---------- ligações ----------

  api.post('/instances/:id/calls/reject', async (req) => {
    const { session } = await loadConnectedSession(req)
    const body = parse(z.object({ callId: z.string().min(1), from: z.string().includes('@') }), req.body)
    await session.socket().rejectCall(body.callId, body.from)
    return { ok: true }
  })
}
