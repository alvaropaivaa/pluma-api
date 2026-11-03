import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { loadMedia, mediaSourceSchema } from '../whatsapp/outgoing.js'
import type { Session } from '../whatsapp/session.js'
import { loadConnectedSession, parse } from './common.js'

const groupParam = z.object({ groupId: z.string().endsWith('@g.us') }).passthrough()
const phones = z.array(z.string().min(8)).min(1).max(256)

/** Participantes: telefone vira o JID real (com checagem se tem WhatsApp); JID passa direto */
const toJids = (session: Session, list: string[]) => Promise.all(list.map((p) => (p.includes('@') ? p : session.jidFor(p))))

/** Código do convite a partir do link inteiro ou só do código */
const inviteCode = (v: string) => v.trim().replace(/^https?:\/\/chat\.whatsapp\.com\//, '').split(/[/?#]/)[0]

export async function groupRoutes(api: FastifyInstance) {
  const withGroup = async (req: Parameters<typeof loadConnectedSession>[0]) => {
    const { session } = await loadConnectedSession(req)
    const { groupId } = parse(groupParam, req.params)
    return { session, sock: session.socket(), groupId }
  }

  api.get('/instances/:id/groups', async (req) => {
    const { session } = await loadConnectedSession(req)
    return (await session.listGroups()).map((g) => ({
      id: g.id,
      subject: g.subject,
      size: g.size ?? g.participants.length,
      owner: g.owner,
      announce: g.announce,
      restrict: g.restrict,
    }))
  })

  api.post('/instances/:id/groups', async (req) => {
    const { session } = await loadConnectedSession(req)
    const body = parse(z.object({ subject: z.string().min(1).max(100), participants: phones }), req.body)
    return session.socket().groupCreate(body.subject, await toJids(session, body.participants))
  })

  // Entrar por link/código de convite
  api.post('/instances/:id/groups/join', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { invite } = parse(z.object({ invite: z.string().min(5) }), req.body)
    return { groupId: await session.socket().groupAcceptInvite(inviteCode(invite)) }
  })

  api.get('/instances/:id/groups/invite/:code', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { code } = parse(z.object({ code: z.string().min(5) }).passthrough(), req.params)
    return session.socket().groupGetInviteInfo(inviteCode(code))
  })

  api.get('/instances/:id/groups/:groupId', async (req) => {
    const { session, groupId } = await withGroup(req)
    return session.groupMetadata(groupId)
  })

  api.put('/instances/:id/groups/:groupId/subject', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const { subject } = parse(z.object({ subject: z.string().min(1).max(100) }), req.body)
    await sock.groupUpdateSubject(groupId, subject)
    return { ok: true }
  })

  api.put('/instances/:id/groups/:groupId/description', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const { description } = parse(z.object({ description: z.string().max(2048) }), req.body)
    await sock.groupUpdateDescription(groupId, description || undefined)
    return { ok: true }
  })

  api.put('/instances/:id/groups/:groupId/picture', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const media = await loadMedia(parse(z.object(mediaSourceSchema), req.body))
    await sock.updateProfilePicture(groupId, media.buffer)
    return { ok: true }
  })

  api.delete('/instances/:id/groups/:groupId/picture', async (req) => {
    const { sock, groupId } = await withGroup(req)
    await sock.removeProfilePicture(groupId)
    return { ok: true }
  })

  /**
   * announcement: só admins mandam mensagem; locked: só admins editam dados do grupo;
   * ephemeral: mensagens temporárias em segundos (0 desliga); joinApproval: aprovar quem entra pelo link
   */
  api.put('/instances/:id/groups/:groupId/settings', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const body = parse(
      z.object({
        announcement: z.boolean().optional(),
        locked: z.boolean().optional(),
        ephemeral: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)]).optional(),
        joinApproval: z.boolean().optional(),
        membersCanAdd: z.boolean().optional(),
      }),
      req.body,
    )
    if (body.announcement !== undefined) await sock.groupSettingUpdate(groupId, body.announcement ? 'announcement' : 'not_announcement')
    if (body.locked !== undefined) await sock.groupSettingUpdate(groupId, body.locked ? 'locked' : 'unlocked')
    if (body.ephemeral !== undefined) await sock.groupToggleEphemeral(groupId, body.ephemeral)
    if (body.joinApproval !== undefined) await sock.groupJoinApprovalMode(groupId, body.joinApproval ? 'on' : 'off')
    if (body.membersCanAdd !== undefined) await sock.groupMemberAddMode(groupId, body.membersCanAdd ? 'all_member_add' : 'admin_add')
    return { ok: true }
  })

  // add | remove | promote (virar admin) | demote (tirar admin)
  api.post('/instances/:id/groups/:groupId/participants', async (req) => {
    const { session, sock, groupId } = await withGroup(req)
    const body = parse(z.object({ action: z.enum(['add', 'remove', 'promote', 'demote']), participants: phones }), req.body)
    return sock.groupParticipantsUpdate(groupId, await toJids(session, body.participants), body.action)
  })

  api.get('/instances/:id/groups/:groupId/invite', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const code = await sock.groupInviteCode(groupId)
    return { code, link: code ? `https://chat.whatsapp.com/${code}` : null }
  })

  api.post('/instances/:id/groups/:groupId/invite/revoke', async (req) => {
    const { sock, groupId } = await withGroup(req)
    const code = await sock.groupRevokeInvite(groupId)
    return { code, link: code ? `https://chat.whatsapp.com/${code}` : null }
  })

  api.get('/instances/:id/groups/:groupId/requests', async (req) => {
    const { sock, groupId } = await withGroup(req)
    return sock.groupRequestParticipantsList(groupId)
  })

  api.post('/instances/:id/groups/:groupId/requests', async (req) => {
    const { session, sock, groupId } = await withGroup(req)
    const body = parse(z.object({ action: z.enum(['approve', 'reject']), participants: phones }), req.body)
    return sock.groupRequestParticipantsUpdate(groupId, await toJids(session, body.participants), body.action)
  })

  api.post('/instances/:id/groups/:groupId/leave', async (req) => {
    const { sock, groupId } = await withGroup(req)
    await sock.groupLeave(groupId)
    return { ok: true }
  })
}
