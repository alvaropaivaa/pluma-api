import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyRequest } from 'fastify'
import mime from 'mime-types'
import { z } from 'zod'
import { contaPelaChave, gerarChave, hashKey, registrarChave } from './account-keys.js'
import { config } from '../config.js'
import { pool } from '../db.js'
import { logger } from '../logger.js'
import { localRoot, verifyLocalMediaSignature } from '../storage/media-storage.js'
import { manager } from '../whatsapp/manager.js'
import { SendError } from '../whatsapp/outgoing.js'
import { NotConnectedError } from '../whatsapp/session.js'
import { HttpError, parse } from './common.js'
import { clusterStatus, loopLagMs, workerId } from '../cluster/leases.js'
import { setupRouter, setupWorkerGuard } from '../cluster/router.js'
import { wapiRoutes } from '../compat/wapi/routes.js'
import { chatRoutes } from './chats.js'
import { extraRoutes } from './extras.js'
import { groupRoutes } from './groups.js'
import { instanceRoutes } from './instances.js'
import { messageRoutes } from './messages.js'
import { accountFromSession, createPanelUser, panelAuthRoutes, SESSION_COOKIE } from './panel-auth.js'
import { dashboardRoutes } from './dashboard.js'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')


const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export async function buildServer() {
  // Log HTTP só de avisos/erros; o log de cada requisição fica de fora
  const app = Fastify({
    loggerInstance: logger.child({ module: 'http' }, { level: 'warn' }),
    trustProxy: config.TRUST_PROXY,
    // base64 de mídia no corpo do envio
    bodyLimit: Math.ceil(((config.MEDIA_MAX_MB * 4) / 3 + 1) * 1024 * 1024),
  })

  // Só o que falha vira registro: chamada normal não polui o log, mas quando o
  // cliente vê "erro interno" dá para saber qual rota e qual código (25/09/2026,
  // erro ao criar instância pelo CRM sem nenhum rastro deste lado)
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) {
      logger.warn(
        { rota: req.url.split('?')[0], metodo: req.method, status: reply.statusCode, ip: req.ip },
        'chamada recusada',
      )
    }
  })

  app.setErrorHandler((err: Error & { statusCode?: number; isBoom?: boolean; output?: { statusCode: number } }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
    if (err instanceof NotConnectedError) return reply.status(409).send({ error: err.message })
    if (err instanceof SendError) {
      const status = { not_on_whatsapp: 422, invalid_media: 422, invalid_request: 400, message_not_found: 404, send_error: 502 }[err.code]
      return reply.status(status).send({ error: err.message, errorCode: err.code })
    }
    // Erro devolvido pelo WhatsApp (ex.: não é admin do grupo, grupo não existe)
    if (err.isBoom && err.output) {
      const code = err.output.statusCode
      return reply.status(code >= 400 && code < 500 ? code : 502).send({ error: `WhatsApp recusou: ${err.message}` })
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message })
    logger.error({ err }, 'erro não tratado')
    return reply.status(500).send({ error: 'erro interno' })
  })

  // Worker só atende o roteador; roteador repassa chamadas de instância para o worker dono
  if (config.ROLE === 'worker') setupWorkerGuard(app)
  if (config.ROLE === 'router') await setupRouter(app)

  app.register(fastifyCookie)

  // Limite de requisições por credencial (token/chave) ou, sem credencial, por IP.
  // Não vale nos workers: lá só chega o que o roteador já deixou passar
  if (config.ROLE !== 'worker') {
    await app.register(fastifyRateLimit, {
      global: true,
      max: config.RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      allowList: (req) => req.url === '/health',
      keyGenerator: (req) => {
        const credential = req.headers['x-api-key'] ?? req.headers.authorization ?? req.cookies?.[SESSION_COOKIE]
        return typeof credential === 'string' ? `cred:${createHash('sha256').update(credential).digest('hex')}` : `ip:${req.ip}`
      },
      errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: `muitas requisições; tente de novo em ${Math.ceil(ctx.ttl / 1000)}s` }),
    })
  }

  // Cabeçalhos de segurança em todas as respostas
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'same-origin')
    reply.header('x-frame-options', 'DENY')
    reply.removeHeader('x-powered-by')
  })

  // Painel e documentação: arquivos estáticos, com cabeçalhos que impedem embutir em outro site
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/painel') || req.url.startsWith('/docs')) {
      reply.header('x-frame-options', 'DENY')
      reply.header('x-content-type-options', 'nosniff')
      reply.header('referrer-policy', 'same-origin')
      reply.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      )
    }
  })
  app.register(fastifyStatic, { root: publicDir, prefix: '/', index: ['index.html'], wildcard: false })
  app.get('/', async (_req, reply) => reply.redirect('/painel/'))
  app.register(panelAuthRoutes)
  app.register(dashboardRoutes)

  app.get('/health', async () => {
    await pool.query('select 1')
    const self = { role: config.ROLE, workerId, instances: manager.size, rssMb: Math.round(process.memoryUsage().rss / 1048576) }
    // No roteador mostra o estado de todos os workers (heartbeat, carga, memória, atraso)
    return config.ROLE === 'router' ? { ok: true, ...self, workers: await clusterStatus() } : { ok: true, ...self, loopLagMs: loopLagMs() }
  })

  // Mídia no storage local, por link assinado (o link já é a autorização)
  if (config.MEDIA_STORAGE === 'local') {
    app.get('/media/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*']
      const { exp, sig } = parse(z.object({ exp: z.coerce.number(), sig: z.string() }), req.query)
      const path = normalize(join(localRoot, key))
      if (!path.startsWith(localRoot + '/') || !verifyLocalMediaSignature(key, exp, sig)) throw new HttpError(403, 'link inválido ou expirado')
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) throw new HttpError(404, 'arquivo não encontrado')
      return reply
        .header('content-type', mime.lookup(path) || 'application/octet-stream')
        .header('content-length', info.size)
        .send(createReadStream(path))
    })
  }

  // ---------- admin ----------

  // Criar conta pela web só se ligado de propósito (em produção, contas se criam pelo terminal)
  if (config.ADMIN_API_ENABLED) app.post('/accounts', async (req) => {
    const adminKey = req.headers['x-admin-key']
    if (typeof adminKey !== 'string' || !safeEqual(adminKey, config.ADMIN_KEY)) throw new HttpError(401, 'admin key inválida')
    const { name, email, password } = parse(
      z.object({ name: z.string().min(1), email: z.string().email().optional(), password: z.string().min(10).optional() }),
      req.body,
    )
    const apiKey = gerarChave()
    const { rows } = await pool.query<{ id: string }>(
      'insert into accounts (name, api_key_hash) values ($1, $2) returning id',
      [name, hashKey(apiKey)],
    )
    await registrarChave(rows[0].id, 'Chave inicial', apiKey)
    // Opcional: já cria o primeiro usuário do painel
    if (email && password) await createPanelUser(rows[0].id, email, password)
    // A chave só aparece aqui; no banco fica só o hash
    return { id: rows[0].id, name, apiKey, panelUser: email ?? null }
  })

  // ---------- compatível com a W-API (/v1/...) ----------

  app.register(wapiRoutes)

  // ---------- rotas da conta ----------

  app.register(async (api) => {
    api.addHook('onRequest', async (req: FastifyRequest) => {
      const key = req.headers['x-api-key']
      // Sem chave: aceita a sessão do painel. Alterações exigem o cabeçalho x-painel (bloqueia CSRF)
      if (typeof key !== 'string') {
        const session = await accountFromSession(req)
        if (!session) throw new HttpError(401, 'x-api-key ausente')
        if (req.method !== 'GET' && req.headers['x-painel'] !== '1') throw new HttpError(403, 'requisição inválida')
        req.accountId = session.account_id
        return
      }
      const accountId = await contaPelaChave(key)
      if (!accountId) throw new HttpError(401, 'api key inválida')
      req.accountId = accountId
    })
    await api.register(instanceRoutes)
    await api.register(messageRoutes)
    await api.register(groupRoutes)
    await api.register(chatRoutes)
    await api.register(extraRoutes)
  })

  return app
}
