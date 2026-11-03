import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { pool } from '../db.js'
import { config } from '../config.js'
import { decrypt } from '../security/crypto.js'
import { manager } from '../whatsapp/manager.js'
import { NotConnectedError } from '../whatsapp/session.js'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return result.data
}

export type InstanceRow = {
  id: string
  account_id: string
  name: string
  status: string
  phone: string | null
  webhook_url: string | null
  webhook_events: string[]
  last_error: string | null
  connected_at: Date | null
  created_at: Date
  token: string
  auto_read: boolean
  import_history: boolean
  history_imported_at: Date | null
  ignore_groups: boolean
  reject_calls: boolean
  call_message: string | null
  send_per_minute: number | null
  send_per_day: number | null
  wapi_webhooks: Record<string, string>
  proxy: { protocol: string; host: string; port: number; user?: string } | null
  picture_url: string | null
}

export const toInstance = (row: InstanceRow) => ({
  id: row.id,
  name: row.name,
  status: manager.get(row.id)?.status ?? row.status,
  phone: row.phone,
  picture: manager.get(row.id)?.ownPicture ?? row.picture_url,
  webhookUrl: row.webhook_url,
  webhookEvents: row.webhook_events,
  lastError: row.last_error,
  connectedAt: row.connected_at,
  createdAt: row.created_at,
  // Bearer das rotas compatíveis com a W-API (/v1/...)
  token: decrypt(row.token),
  settings: {
    autoRead: row.auto_read,
    importHistory: row.import_history,
    historyImportedAt: row.history_imported_at,
    ignoreGroups: row.ignore_groups,
    rejectCalls: row.reject_calls,
    callMessage: row.call_message,
    // limite efetivo (o da instância ou o padrão do servidor); sendPerDay 0 = sem limite
    sendPerMinute: row.send_per_minute ?? config.SEND_MAX_PER_MINUTE,
    sendPerDay: row.send_per_day ?? config.SEND_MAX_PER_DAY,
    sendLimitsCustom: row.send_per_minute !== null || row.send_per_day !== null,
    // senha do proxy nunca volta na resposta
    proxy: row.proxy ? { protocol: row.proxy.protocol, host: row.proxy.host, port: row.proxy.port, user: row.proxy.user ?? null } : null,
  },
  wapiWebhooks: row.wapi_webhooks,
})

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string
  }
}

/** Instância da conta autenticada (404 se não for dela) */
export async function loadInstance(req: FastifyRequest) {
  const { id } = parse(z.object({ id: z.string().uuid() }).passthrough(), req.params)
  const { rows } = await pool.query<InstanceRow>('select * from instances where id = $1 and account_id = $2', [id, req.accountId])
  if (!rows[0]) throw new HttpError(404, 'instância não encontrada')
  return rows[0]
}

/** Sessão conectada da instância (409 se não estiver) */
export async function loadConnectedSession(req: FastifyRequest) {
  const instance = await loadInstance(req)
  const session = manager.get(instance.id)
  if (!session || session.status !== 'connected') throw new NotConnectedError('instância não está conectada')
  return { instance, session }
}
