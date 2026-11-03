import { EventEmitter } from 'node:events'
import { generateMessageIDV2 } from 'baileys'
import { pool } from '../db.js'
import { decrypt, encrypt } from '../security/crypto.js'
import { enqueueWebhook } from '../webhooks/outbox.js'
import type { SendRequest } from './outgoing.js'

const MAX_ATTEMPTS = 3

export type JobRow = {
  id: string
  instance_id: string
  idempotency_key: string | null
  payload: SendRequest
  status: 'queued' | 'sending' | 'sent' | 'failed'
  attempts: number
  message_id: string | null
  remote_jid: string | null
  error_code: string | null
  error: string | null
  delay_seconds: number
  not_before: Date
  created_at: Date
  sent_at: Date | null
}

/** Linha do banco com o payload decifrado (a coluna guarda o JSON cifrado) */
function hydrate<T extends { payload: unknown }>(row: T | undefined): T | undefined {
  if (!row) return row
  return typeof row.payload === 'string' ? { ...row, payload: JSON.parse(decrypt(row.payload)) } : row
}

// Avisa quem está esperando (o POST de envio) que o job terminou
const jobEvents = new EventEmitter()
jobEvents.setMaxListeners(0)

export const toJob = (row: JobRow) => ({
  jobId: row.id,
  status: row.status,
  messageId: row.message_id,
  to: row.remote_jid,
  idempotencyKey: row.idempotency_key,
  errorCode: row.error_code,
  error: row.error,
  createdAt: row.created_at,
  sentAt: row.sent_at,
})

/**
 * Cria o job; com a mesma idempotencyKey devolve o job que já existe.
 * O ID da mensagem no WhatsApp já nasce aqui, para quem chamou saber o messageId antes do envio
 */
export async function createJob(instanceId: string, payload: SendRequest) {
  const key = payload.idempotencyKey ?? null
  const delay = payload.delaySeconds ?? 0
  const { rows } = await pool.query<JobRow>(
    `insert into send_jobs (instance_id, idempotency_key, payload, message_id, delay_seconds, not_before)
     values ($1, $2, $3, $4, $5::int, now() + make_interval(secs => $5::int))
     on conflict (instance_id, idempotency_key) do nothing returning *`,
    [instanceId, key, encrypt(JSON.stringify(payload)), generateMessageIDV2(), delay],
  )
  if (rows[0]) return { job: hydrate(rows[0])!, created: true }
  const existing = await pool.query<JobRow>('select * from send_jobs where instance_id = $1 and idempotency_key = $2', [instanceId, key])
  return { job: hydrate(existing.rows[0])!, created: false }
}

export async function getJob(instanceId: string, id: string) {
  const { rows } = await pool.query<JobRow>('select * from send_jobs where instance_id = $1 and id = $2', [instanceId, id])
  return hydrate(rows[0])
}

export async function claimNextJob(instanceId: string) {
  const { rows } = await pool.query<JobRow>(
    `update send_jobs set status = 'sending', attempts = attempts + 1, updated_at = now()
     where id = (
       select id from send_jobs
       where instance_id = $1 and status = 'queued' and not_before <= now()
       order by created_at limit 1 for update skip locked
     ) returning *`,
    [instanceId],
  )
  return hydrate(rows[0])
}

export async function completeJob(job: JobRow, messageId: string | undefined, remoteJid: string) {
  const { rows } = await pool.query<JobRow>(
    `update send_jobs set status = 'sent', message_id = $2, remote_jid = $3, sent_at = now(), updated_at = now(), error = null, error_code = null
     where id = $1 returning *`,
    [job.id, messageId ?? null, remoteJid],
  )
  await finished(hydrate(rows[0])!)
}

/** Falha: tenta de novo (com espera) se o erro permite e ainda há tentativas; senão marca como falho */
export async function failJob(job: JobRow, code: string, error: string, retryable: boolean) {
  if (retryable && job.attempts < MAX_ATTEMPTS) {
    await pool.query(
      `update send_jobs set status = 'queued', error_code = $2, error = $3, updated_at = now(),
         not_before = now() + make_interval(secs => $4) where id = $1`,
      [job.id, code, error, 5 * job.attempts],
    )
    return
  }
  const { rows } = await pool.query<JobRow>(
    `update send_jobs set status = 'failed', error_code = $2, error = $3, updated_at = now() where id = $1 returning *`,
    [job.id, code, error],
  )
  await finished(hydrate(rows[0])!)
}

async function finished(job: JobRow) {
  jobEvents.emit(job.id, job)
  await enqueueWebhook(job.instance_id, 'send.update', toJob(job))
}

/** Espera o job terminar; undefined se o tempo acabar (ele continua na fila) */
export function waitForJob(id: string, timeoutMs: number) {
  return new Promise<JobRow | undefined>((resolve) => {
    const timer = setTimeout(() => {
      jobEvents.off(id, onDone)
      resolve(undefined)
    }, timeoutMs)
    const onDone = (job: JobRow) => {
      clearTimeout(timer)
      resolve(job)
    }
    jobEvents.once(id, onDone)
  })
}

export async function listQueued(instanceId: string, page: number, perPage: number) {
  const { rows } = await pool.query<JobRow & { total: number }>(
    `select *, count(*) over ()::int as total from send_jobs
     where instance_id = $1 and status = 'queued' order by created_at limit $2 offset $3`,
    [instanceId, perPage, (page - 1) * perPage],
  )
  return { jobs: rows.map((r) => hydrate(r)!), total: rows[0]?.total ?? 0 }
}

/** Tira da fila (só o que ainda não começou a ser enviado). Sem jobId, esvazia a fila */
export async function cancelQueued(instanceId: string, jobId?: string) {
  const { rowCount } = await pool.query(
    `update send_jobs set status = 'failed', error_code = 'cancelled', error = 'removido da fila', updated_at = now()
     where instance_id = $1 and status = 'queued' and ($2::uuid is null or id = $2)`,
    [instanceId, jobId ?? null],
  )
  return rowCount ?? 0
}

/** Envios feitos por este número nos últimos N segundos (para os limites) */
export async function countSent(instanceId: string, seconds: number) {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from send_jobs
     where instance_id = $1 and status = 'sent' and sent_at > now() - make_interval(secs => $2)`,
    [instanceId, seconds],
  )
  return rows[0].n
}

/**
 * Jobs que estavam "enviando" quando o worker dono caiu: não dá para saber se chegaram.
 * Chamado quando outro worker assume a instância.
 * Marca como falho em vez de reenviar, para não duplicar mensagem para o cliente
 */
export async function failInterruptedJobs(instanceId: string) {
  const { rows } = await pool.query<JobRow>(
    `update send_jobs set status = 'failed', error_code = 'interrupted',
       error = 'API reiniciou durante o envio; a mensagem pode ou não ter sido entregue', updated_at = now()
     where status = 'sending' and instance_id = $1 returning *`,
    [instanceId],
  )
  for (const job of rows) await enqueueWebhook(job.instance_id, 'send.update', toJob(hydrate(job)!))
  return rows.length
}
