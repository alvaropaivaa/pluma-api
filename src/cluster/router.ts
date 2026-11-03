import replyFrom from '@fastify/reply-from'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { logger } from '../logger.js'
import { internalSecret, leastLoadedWorker, ownerOf } from './leases.js'

/**
 * Roteador: a porta pública. Chamadas de uma instância vão para o worker dono dela
 * (o mesmo código de rotas roda lá, com a sessão em memória). O resto é atendido aqui.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Chamadas que ligam a instância: sem dono, vão para o worker menos carregado
const STARTS_SESSION = [
  /^\/instances\/[^/]+\/(connect|restart)(\?|$)/,
  /^\/v1\/instance\/(qr-code|pairing-code|restart)(\?|$)/,
]

export function instanceIdOf(req: Pick<FastifyRequest, 'url' | 'query' | 'body'>) {
  const path = req.url.split('?')[0]
  const m = path.match(/^\/instances\/([^/]+)/)
  if (m && UUID.test(m[1])) return m[1]
  if (path.startsWith('/v1/') && (!/^\/v1\/(integrator|client)\//.test(path) || path.endsWith('/delete-instance'))) {
    const id = (req.query as Record<string, unknown>)?.instanceId ?? (req.body as Record<string, unknown> | undefined)?.instanceId
    if (typeof id === 'string' && UUID.test(id)) return id
  }
  return undefined
}

/** Chamado direto na app raiz (não via register) para o gancho valer em todas as rotas */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setupRouter(app: FastifyInstance<any, any, any, any>) {
  await app.register(replyFrom, { undici: { connections: 64, pipelining: 1, bodyTimeout: 120_000, headersTimeout: 120_000 } })

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const instanceId = instanceIdOf(req)
    if (!instanceId) return
    let target = await ownerOf(instanceId)
    if (!target && STARTS_SESSION.some((r) => r.test(req.url))) target = await leastLoadedWorker()
    if (!target) return // ninguém segura a instância: responde daqui (ex.: "não conectada")
    return reply.from(`http://${target.host}:${target.port}${req.url}`, {
      rewriteRequestHeaders: (_req, headers) => ({ ...headers, 'x-internal': internalSecret }),
      onError: (rep, { error }) => {
        logger.warn({ err: error, worker: target!.id, instanceId }, 'worker não respondeu')
        rep.status(503).send({ error: 'instância temporariamente indisponível, tente em alguns segundos' })
      },
    })
  })
}

/** Worker só aceita chamadas vindas do roteador (além do /health local) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setupWorkerGuard(app: FastifyInstance<any, any, any, any>) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return
    if (req.headers['x-internal'] !== internalSecret) return reply.status(403).send({ error: 'acesso direto ao worker não permitido' })
  })
}

