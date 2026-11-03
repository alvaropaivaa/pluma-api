import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '../db.js'
import { decrypt, encrypt, newToken } from '../security/crypto.js'
import { manager } from '../whatsapp/manager.js'
import { cancelQueued, listQueued, toJob } from '../whatsapp/send-queue.js'
import { HttpError, loadConnectedSession, loadInstance, parse, toInstance, type InstanceRow } from './common.js'

const page = z.object({ page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(500).default(50) })

export const proxySchema = z
  .object({
    protocol: z.enum(['http', 'https', 'socks5']),
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    user: z.string().optional(),
    pass: z.string().optional(),
  })
  .nullable()

export const settingsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  autoRead: z.boolean().optional(),
  // Importar o histórico na conexão. Vale uma vez por número; ligar de novo não reimporta
  importHistory: z.boolean().optional(),
  ignoreGroups: z.boolean().optional(),
  rejectCalls: z.boolean().optional(),
  callMessage: z.string().max(1000).nullable().optional(),
  proxy: proxySchema.optional(),
  // null = padrão do servidor; sendPerDay 0 = sem limite diário
  sendPerMinute: z.number().int().min(1).max(600).nullable().optional(),
  sendPerDay: z.number().int().min(0).max(1_000_000).nullable().optional(),
})

/** Atualiza configurações; proxy só vale depois de reconectar */
export async function updateSettings(instanceId: string, body: z.infer<typeof settingsSchema>) {
  const { rows } = await pool.query<InstanceRow>(
    `update instances set
       name = coalesce($2, name),
       auto_read = coalesce($3, auto_read),
       import_history = coalesce($14, import_history),
       ignore_groups = coalesce($4, ignore_groups),
       reject_calls = coalesce($5, reject_calls),
       call_message = case when $6 then $7 else call_message end,
       proxy = case when $8 then $9::jsonb else proxy end,
       send_per_minute = case when $10 then $11::int else send_per_minute end,
       send_per_day = case when $12 then $13::int else send_per_day end,
       updated_at = now()
     where id = $1 returning *`,
    [
      instanceId,
      body.name ?? null,
      body.autoRead ?? null,
      body.ignoreGroups ?? null,
      body.rejectCalls ?? null,
      body.callMessage !== undefined,
      body.callMessage ?? null,
      body.proxy !== undefined,
      body.proxy ? JSON.stringify({ ...body.proxy, pass: body.proxy.pass ? encrypt(body.proxy.pass) : undefined }) : null,
      body.sendPerMinute !== undefined,
      body.sendPerMinute ?? null,
      body.sendPerDay !== undefined,
      body.sendPerDay ?? null,
      body.importHistory ?? null,
    ],
  )
  await manager.get(instanceId)?.reloadSettings()
  return rows[0]
}

export async function listContacts(instanceId: string, p: number, perPage: number, search?: string) {
  const { rows } = await pool.query<{ jid: string; lid: string | null; phone: string | null; name: string | null; notify: string | null; verified_name: string | null; total: number }>(
    `select *, count(*) over ()::int as total from contacts
     where instance_id = $1 and ($4::text is null or name ilike $4 or notify ilike $4 or phone like $4)
     order by coalesce(name, notify, phone) limit $2 offset $3`,
    [instanceId, perPage, (p - 1) * perPage, search ? `%${search}%` : null],
  )
  return { rows, total: rows[0]?.total ?? 0 }
}

export async function listWebhookLogs(instanceId: string, p: number, perPage: number) {
  const { rows } = await pool.query(
    `select id, event, coalesce(target_url, '') as url, attempts, response_status, duration_ms, last_error,
       delivered_at, failed_at, created_at, count(*) over ()::int as total
     from webhook_outbox where instance_id = $1 order by id desc limit $2 offset $3`,
    [instanceId, perPage, (p - 1) * perPage],
  )
  return { rows, total: (rows[0]?.total as number) ?? 0 }
}

/**
 * Eventos de mensagem já gerados (formato W-API: webhookReceived / webhookDelivery) desde um instante.
 * Serve para o sistema que recebe conferir se perdeu algo e completar (resgate). Guardados por 7 dias
 */
export async function listMessageEvents(instanceId: string, sinceSeconds: number, limit: number) {
  const { rows } = await pool.query<{ payload: string; created_at: Date }>(
    `select payload, created_at from webhook_outbox
     where instance_id = $1 and event in ('webhookReceived', 'webhookDelivery')
       and date_trunc('milliseconds', created_at) > to_timestamp($2)
     order by created_at, id limit $3`,
    [instanceId, sinceSeconds, limit],
  )
  const events = rows.map((r) => JSON.parse(decrypt(r.payload)))
  const last = rows.at(-1)?.created_at
  // Cursor em milissegundos (o mesmo corte da consulta): repetir a chamada com ele não devolve nada de novo
  return { events, next: last ? last.getTime() / 1000 : sinceSeconds }
}

export async function extraRoutes(api: FastifyInstance) {
  api.patch('/instances/:id/settings', async (req) => {
    const instance = await loadInstance(req)
    return toInstance(await updateSettings(instance.id, parse(settingsSchema, req.body)))
  })

  /** Token novo para as rotas /v1 (o antigo para de funcionar na hora) */
  api.post('/instances/:id/token/rotate', async (req) => {
    const instance = await loadInstance(req)
    const { rows } = await pool.query<InstanceRow>(
      'update instances set token = $2, updated_at = now() where id = $1 returning *',
      [instance.id, encrypt(newToken())],
    )
    return toInstance(rows[0])
  })

  api.get('/instances/:id/events', async (req) => {
    const instance = await loadInstance(req)
    const q = parse(z.object({ since: z.coerce.number().min(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query)
    return listMessageEvents(instance.id, q.since, q.limit)
  })

  /** Link de ligação do WhatsApp (quem abre entra numa chamada de voz ou vídeo com este número) */
  api.post('/instances/:id/call-link', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { type } = parse(z.object({ type: z.enum(['audio', 'video']).default('audio') }), req.body ?? {})
    const token = await session.socket().createCallLink(type)
    if (!token) throw new HttpError(502, 'o WhatsApp não devolveu o link')
    return { type, token, url: `https://call.whatsapp.com/${type === 'video' ? 'video' : 'voice'}/${token}` }
  })

  /** Pede ao WhatsApp as mensagens anteriores às que já temos de uma conversa */
  api.post('/instances/:id/history/fetch', async (req) => {
    const { session } = await loadConnectedSession(req)
    const b = parse(z.object({ phone: z.string().min(5), count: z.coerce.number().int().min(1).max(200).default(50) }), req.body ?? {})
    return session.fetchOlderMessages(b.phone, b.count)
  })

  // ---------- e-mails de alerta da conta ----------

  api.get('/account/alerts', async (req) => {
    const { rows } = await pool.query<{ alert_emails: string[]; users: string[] }>(
      `select a.alert_emails, coalesce(array_agg(u.email) filter (where u.email is not null), '{}') as users
       from accounts a left join panel_users u on u.account_id = a.id where a.id = $1 group by a.id`,
      [req.accountId],
    )
    return { alertEmails: rows[0]?.alert_emails ?? [], fallback: rows[0]?.users ?? [] }
  })

  api.put('/account/alerts', async (req) => {
    const { alertEmails } = parse(z.object({ alertEmails: z.array(z.string().email()).max(20) }), req.body)
    await pool.query('update accounts set alert_emails = $2 where id = $1', [req.accountId, [...new Set(alertEmails.map((e) => e.toLowerCase()))]])
    return { alertEmails }
  })

  api.get('/instances/:id/device', async (req) => {
    const { session } = await loadConnectedSession(req)
    return session.device()
  })

  // ---------- agenda ----------

  api.get('/instances/:id/contacts', async (req) => {
    const instance = await loadInstance(req)
    const q = parse(page.extend({ search: z.string().max(100).optional() }), req.query)
    const { rows, total } = await listContacts(instance.id, q.page, q.perPage, q.search)
    return {
      contacts: rows.map((c) => ({ jid: c.jid, lid: c.lid, phone: c.phone, name: c.name, pushName: c.notify, verifiedName: c.verified_name })),
      total,
      page: q.page,
      totalPages: Math.ceil(total / q.perPage),
    }
  })

  /** Vários números de uma vez: quais têm WhatsApp */
  api.post('/instances/:id/check', async (req) => {
    const { session } = await loadConnectedSession(req)
    const { phones } = parse(z.object({ phones: z.array(z.string().regex(/^\+?\d{8,15}$/)).min(1).max(500) }), req.body)
    const out = []
    for (const phone of phones) out.push({ phone: phone.replace(/\D/g, ''), ...(await session.checkNumber(phone)) })
    return out
  })

  // ---------- fila de envio ----------

  api.get('/instances/:id/queue', async (req) => {
    const instance = await loadInstance(req)
    const q = parse(page, req.query)
    const { jobs, total } = await listQueued(instance.id, q.page, q.perPage)
    return { jobs: jobs.map((j) => ({ ...toJob(j), type: j.payload.type, sendAfter: j.not_before })), total }
  })

  api.delete('/instances/:id/queue', async (req) => {
    const instance = await loadInstance(req)
    return { removed: await cancelQueued(instance.id) }
  })

  api.delete('/instances/:id/queue/:jobId', async (req) => {
    const instance = await loadInstance(req)
    const { jobId } = parse(z.object({ jobId: z.string().uuid() }).passthrough(), req.params)
    const removed = await cancelQueued(instance.id, jobId)
    if (!removed) throw new HttpError(404, 'envio não está na fila (já saiu ou não existe)')
    return { removed }
  })

  // ---------- histórico de webhooks ----------

  api.get('/instances/:id/webhook-logs', async (req) => {
    const instance = await loadInstance(req)
    const q = parse(page, req.query)
    const { rows, total } = await listWebhookLogs(instance.id, q.page, q.perPage)
    return { logs: rows.map(({ total: _t, ...r }) => r), total }
  })

  api.get('/instances/:id/webhook-logs/:logId', async (req) => {
    const instance = await loadInstance(req)
    const { logId } = parse(z.object({ logId: z.coerce.number().int() }).passthrough(), req.params)
    const { rows } = await pool.query('select * from webhook_outbox where instance_id = $1 and id = $2', [instance.id, logId])
    if (!rows[0]) throw new HttpError(404, 'log não encontrado')
    return { ...rows[0], payload: JSON.parse(decrypt(rows[0].payload)) }
  })

  /** Webhooks no formato W-API (uma URL por evento) */
  api.put('/instances/:id/wapi-webhooks', async (req) => {
    const instance = await loadInstance(req)
    const url = z.string().url().or(z.literal(''))
    const body = parse(
      z.object({ received: url, delivery: url, connected: url, disconnected: url, status: url, presence: url }).partial(),
      req.body,
    )
    const { rows } = await pool.query<InstanceRow>(
      `update instances set wapi_webhooks = wapi_webhooks || $2::jsonb, updated_at = now() where id = $1 returning *`,
      [instance.id, JSON.stringify(body)],
    )
    return toInstance(rows[0])
  })

  // ---------- mídia pela chave ----------

  api.post('/instances/:id/media/download', async (req) => {
    const { session } = await loadConnectedSession(req)
    const body = parse(
      z.object({
        mediaKey: z.string().min(10),
        directPath: z.string().min(5),
        url: z.string().url().optional(),
        type: z.enum(['image', 'video', 'audio', 'document', 'sticker', 'ptv', 'gif', 'ppic', 'thumbnail-link']),
        mimetype: z.string().min(3),
      }),
      req.body,
    )
    return session.downloadByKey(body)
  })
}
