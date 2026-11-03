import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { TARGETS_MESSAGE, sendRequestSchema } from '../whatsapp/outgoing.js'
import { createJob, getJob, toJob, waitForJob, type JobRow } from '../whatsapp/send-queue.js'
import { HttpError, loadConnectedSession, loadInstance, parse } from './common.js'

// Erros do job que viram 4xx para quem chamou
const ERROR_STATUS: Record<string, number> = {
  not_on_whatsapp: 422,
  invalid_media: 422,
  invalid_request: 400,
  message_not_found: 404,
}

const jobResponse = (job: JobRow) => {
  if (job.status === 'sent') return { code: 200, body: toJob(job) }
  if (job.status === 'failed') return { code: ERROR_STATUS[job.error_code ?? ''] ?? 502, body: toJob(job) }
  return { code: 202, body: toJob(job) } // ainda na fila
}

export async function messageRoutes(api: FastifyInstance) {
  /**
   * Envia (texto, mídia, reação, edição, exclusão). Entra na fila e espera até SEND_WAIT_MS
   * pelo resultado: 200 enviado, 202 ainda na fila (acompanhe pelo jobId ou webhook send.update)
   */
  api.post('/instances/:id/messages', async (req, reply) => {
    const body = parse(sendRequestSchema, req.body)
    if (!TARGETS_MESSAGE.has(body.type) && !body.to) throw new HttpError(400, 'to: obrigatório')
    const header = req.headers['idempotency-key']
    if (typeof header === 'string' && !body.idempotencyKey) body.idempotencyKey = header

    // Não aceita envio com a instância desligada, para não disparar mensagem velha horas depois
    const { instance, session } = await loadConnectedSession(req)
    const { job, created } = await createJob(instance.id, body)
    if (!created && (job.status === 'sent' || job.status === 'failed')) {
      const r = jobResponse(job)
      return reply.status(r.code).send(r.body)
    }
    // Com atraso pedido, não espera: devolve 202 com o messageId já definido
    if (body.delaySeconds) return reply.status(202).send(toJob(job))
    const done = waitForJob(job.id, config.SEND_WAIT_MS)
    session.kickQueue()
    const r = jobResponse((await done) ?? job)
    return reply.status(r.code).send(r.body)
  })

  api.get('/instances/:id/messages/jobs/:jobId', async (req) => {
    const instance = await loadInstance(req)
    const { jobId } = parse(z.object({ jobId: z.string().uuid() }).passthrough(), req.params)
    const job = await getJob(instance.id, jobId)
    if (!job) throw new HttpError(404, 'envio não encontrado')
    return toJob(job)
  })

  /** Publica nos status (stories). Sem statusRecipients, vai para quem conversou com o número recentemente */
  api.post('/instances/:id/status', async (req, reply) => {
    const body = parse(sendRequestSchema, { ...(req.body as object), to: 'status' })
    if (!['text', 'image', 'video', 'audio'].includes(body.type)) throw new HttpError(400, 'status aceita text, image, video ou audio')
    const { instance, session } = await loadConnectedSession(req)
    const { job } = await createJob(instance.id, body)
    const done = waitForJob(job.id, config.SEND_WAIT_MS)
    session.kickQueue()
    const r = jobResponse((await done) ?? job)
    return reply.status(r.code).send(r.body)
  })
}
