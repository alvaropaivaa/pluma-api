import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import mime from 'mime-types'
import QRCode from 'qrcode'
import { z, ZodError } from 'zod'
import { contaPelaChave } from '../../api/account-keys.js'
import { type InstanceRow } from '../../api/common.js'
import { listContacts, listMessageEvents, listWebhookLogs, updateSettings } from '../../api/extras.js'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { logger } from '../../logger.js'
import { manager } from '../../whatsapp/manager.js'
import { SendError, loadMedia, loadStoredMessage, sendRequestSchema, type SendRequest } from '../../whatsapp/outgoing.js'
import { cancelQueued, createJob, listQueued, waitForJob } from '../../whatsapp/send-queue.js'
import { decrypt, encrypt, newToken } from '../../security/crypto.js'
import { NotConnectedError, type Session } from '../../whatsapp/session.js'

/**
 * Rotas compatíveis com a W-API (https://docs.w-api.app): mesmos caminhos, parâmetros e respostas.
 * Autenticação igual à deles: ?instanceId=...  +  Authorization: Bearer <token da instância>.
 * Criar instância (integrador): Bearer <apiKey da conta>.
 */

class WapiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    wapiInstance?: InstanceRow
  }
}

const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()

/** Parâmetros podem vir no corpo ou na query string (a W-API aceita os dois) */
const input = (req: FastifyRequest) => ({ ...(req.query as object), ...((req.body as object) ?? {}) }) as Record<string, unknown>

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw new WapiError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return r.data
}

const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
const phone = z.string().min(5)
const ok = (extra: Record<string, unknown> = {}) => ({ error: false, ...extra })

// ---------- autenticação ----------

async function accountFrom(req: FastifyRequest) {
  // Aceitamos os três formatos que os sistemas por aí usam: Bearer, `apiKey` no
  // corpo/query e os cabeçalhos `x-api-key`/`Apikey` (o segundo é o da W-API).
  // Quem vem de outra API não deveria tropeçar no nome do cabeçalho.
  const cabecalho = (req.headers['x-api-key'] ?? req.headers['apikey']) as string | undefined
  const key = bearer(req) ?? (input(req).apiKey as string | undefined) ?? (cabecalho || undefined)
  if (!key) throw new WapiError(401, 'Token de parceiro ausente')
  const accountId = await contaPelaChave(key)
  if (!accountId) throw new WapiError(401, 'Token de parceiro inválido')
  return accountId
}

async function instanceFrom(req: FastifyRequest) {
  const instanceId = input(req).instanceId
  const token = bearer(req)
  if (typeof instanceId !== 'string' || !token) throw new WapiError(401, 'instanceId ou token ausente')
  if (!z.string().uuid().safeParse(instanceId).success) throw new WapiError(404, 'Instância não encontrada')
  const { rows } = await pool.query<InstanceRow>('select * from instances where id = $1', [instanceId])
  const inst = rows[0]
  const real = inst ? decrypt(inst.token) : ''
  if (!inst || real.length !== token.length || !timingSafeEqual(Buffer.from(real), Buffer.from(token))) {
    throw new WapiError(401, 'Token inválido para esta instância')
  }
  return inst
}

function connectedSession(inst: InstanceRow): Session {
  const session = manager.get(inst.id)
  if (!session || session.status !== 'connected') throw new WapiError(400, 'Instância desconectada')
  return session
}

// ---------- envio ----------

/** Campo de mídia da W-API: URL ou base64 (com ou sem data URI) */
const media = (value: string, mimetype?: string) =>
  /^https?:\/\//i.test(value) ? { url: value, mimetype } : { base64: value, mimetype }

async function send(inst: InstanceRow, req: SendRequest, reply: FastifyReply) {
  const session = connectedSession(inst)
  const payload = parse(sendRequestSchema, req)
  const { job } = await createJob(inst.id, payload)
  const response = { instanceId: inst.id, messageId: job.message_id, insertedId: job.id }
  // Com delayMessage a W-API responde na hora e envia depois; fazemos igual
  if (payload.delaySeconds) return reply.send(response)
  const done = waitForJob(job.id, config.SEND_WAIT_MS)
  session.kickQueue()
  const result = await done
  if (result?.status === 'failed') {
    const status = result.error_code === 'not_on_whatsapp' || result.error_code === 'invalid_media' ? 422 : 400
    return reply.status(status).send({ error: true, message: result.error, instanceId: inst.id, insertedId: job.id })
  }
  return reply.send({ ...response, messageId: result?.message_id ?? job.message_id })
}

const common = { phone, messageId: z.string().optional(), delayMessage: z.coerce.number().int().min(0).max(3600).optional() }
const base = (b: { phone: string; messageId?: string; delayMessage?: number }) => ({
  to: b.phone,
  quotedId: b.messageId || undefined,
  delaySeconds: b.delayMessage || undefined,
})

/** Botões no formato W-API: CALL, URL, REPLY (a doc também escreve REPLAY) */
const wapiButton = z.object({
  type: z.string().transform((t) => t.toUpperCase()),
  buttonText: z.string().min(1),
  phone: z.string().optional(),
  url: z.string().optional(),
  id: z.string().optional(),
})
const toButton = (b: z.infer<typeof wapiButton>) =>
  b.type === 'CALL'
    ? { type: 'call' as const, text: b.buttonText, phone: b.phone }
    : b.type === 'URL'
      ? { type: 'url' as const, text: b.buttonText, url: b.url }
      : { type: 'reply' as const, text: b.buttonText, id: b.id }

// ---------- rotas ----------

export async function wapiRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number; isBoom?: boolean; output?: { statusCode: number } }, _req, reply) => {
    if (err instanceof WapiError) return reply.status(err.statusCode).send({ error: true, message: err.message })
    if (err instanceof NotConnectedError) return reply.status(400).send({ error: true, message: 'Instância desconectada' })
    if (err instanceof SendError) return reply.status(err.code === 'send_error' ? 502 : 400).send({ error: true, message: err.message })
    if (err instanceof ZodError) return reply.status(400).send({ error: true, message: err.issues.map((i) => i.message).join('; ') })
    if (err.isBoom && err.output) return reply.status(err.output.statusCode < 500 ? err.output.statusCode : 502).send({ error: true, message: `WhatsApp recusou: ${err.message}` })
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: true, message: err.message })
    logger.error({ err }, 'erro na rota W-API')
    return reply.status(500).send({ error: true, message: 'Erro interno' })
  })

  // ===== Integrador: criar/listar instâncias (autentica com a apiKey da conta) =====

  const createInstance = async (req: FastifyRequest) => {
    const accountId = await accountFrom(req)
    const url = z.string().url().or(z.literal('')).optional()
    const b = parse(
      z.object({
        instanceName: z.string().min(1).max(100),
        webhookConnectedUrl: url,
        webhookDeliveryUrl: url,
        webhookDisconnectedUrl: url,
        webhookStatusUrl: url,
        webhookPresenceUrl: url,
        webhookReceivedUrl: url,
        automaticReading: bool.optional(),
        rejectCalls: bool.optional(),
        callMessage: z.string().max(1000).optional(),
        useProxy: bool.optional(),
        proxyProtocol: z.enum(['http', 'https', 'socks5']).optional(),
        proxyHost: z.string().optional(),
        proxyPort: z.coerce.number().int().optional(),
        proxyUser: z.string().optional(),
        proxyPass: z.string().optional(),
      }),
      input(req),
    )
    const hooks = Object.fromEntries(
      Object.entries({
        connected: b.webhookConnectedUrl,
        delivery: b.webhookDeliveryUrl,
        disconnected: b.webhookDisconnectedUrl,
        status: b.webhookStatusUrl,
        presence: b.webhookPresenceUrl,
        received: b.webhookReceivedUrl,
      }).filter(([, v]) => v),
    )
    const proxy = b.useProxy && b.proxyHost && b.proxyPort
      ? { protocol: b.proxyProtocol ?? 'http', host: b.proxyHost, port: b.proxyPort, user: b.proxyUser, pass: b.proxyPass }
      : null
    // A W-API aceita nomes repetidos; aqui o nome é único por conta, então desambigua
    let name = b.instanceName
    const { rows: dup } = await pool.query('select 1 from instances where account_id = $1 and name = $2', [accountId, name])
    if (dup.length) name = `${name} (${randomBytes(2).toString('hex')})`
    const { rows } = await pool.query<InstanceRow>(
      `insert into instances (account_id, name, webhook_secret, wapi_webhooks, auto_read, reject_calls, call_message, proxy, token)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        accountId,
        name,
        encrypt(randomBytes(32).toString('hex')),
        JSON.stringify(hooks),
        b.automaticReading ?? false,
        b.rejectCalls ?? false,
        b.callMessage || null,
        proxy ? JSON.stringify({ ...proxy, pass: proxy.pass ? encrypt(proxy.pass) : undefined }) : null,
        encrypt(newToken()),
      ],
    )
    const inst = rows[0]
    return ok({ message: 'Instância criada com sucesso.', instanceId: inst.id, token: decrypt(inst.token), instanceName: inst.name, status: 'ACTIVE' })
  }

  const listInstances = async (req: FastifyRequest) => {
    const accountId = await accountFrom(req)
    const { rows } = await pool.query<InstanceRow>('select * from instances where account_id = $1 order by created_at', [accountId])
    return ok({
      instances: rows.map((i) => ({
        instanceId: i.id,
        instanceName: i.name,
        token: decrypt(i.token),
        connected: (manager.get(i.id)?.status ?? i.status) === 'connected',
        connectedPhone: i.phone ?? '',
        created: i.created_at,
      })),
    })
  }

  const deleteInstance = async (req: FastifyRequest) => {
    const accountId = await accountFrom(req)
    const { instanceId } = parse(z.object({ instanceId: z.string().uuid() }), input(req))
    const { rows } = await pool.query('select id from instances where id = $1 and account_id = $2', [instanceId, accountId])
    if (!rows[0]) throw new WapiError(404, 'Instância não encontrada')
    await manager.remove(instanceId)
    return ok({ message: 'Instância removida com sucesso.' })
  }

  for (const prefix of ['/v1/integrator', '/v1/client']) {
    app.post(`${prefix}/create-instance`, createInstance)
    app.get(`${prefix}/list-instances`, listInstances)
    app.delete(`${prefix}/delete-instance`, deleteInstance)
  }

  // ===== Rotas de instância (Bearer token da instância) =====

  app.register(async (r) => {
    r.addHook('preHandler', async (req) => {
      req.wapiInstance = await instanceFrom(req)
    })
    const inst = (req: FastifyRequest) => req.wapiInstance!

    // ---------- instância ----------

    /** Liga a instância se preciso e espera o QR aparecer (até 10s) */
    r.get('/v1/instance/qr-code', async (req, reply) => {
      const i = inst(req)
      let session = manager.get(i.id)
      if (session?.status === 'connected') return reply.status(400).send({ error: true, message: 'Instância já está conectada', instanceId: i.id })
      if (!session?.active) session = await manager.connect(i.id)
      for (let t = 0; t < 20 && !session.qr && session.status !== 'connected'; t++) await new Promise((res) => setTimeout(res, 500))
      if (!session.qr) return reply.status(400).send({ error: true, message: 'QR code ainda não disponível, tente de novo', instanceId: i.id })
      const dataUrl = await QRCode.toDataURL(session.qr)
      if (input(req).image === 'enable') {
        return reply.header('content-type', 'image/png').send(Buffer.from(dataUrl.split(',')[1], 'base64'))
      }
      return ok({ qrcode: dataUrl, instanceId: i.id })
    })

    r.get('/v1/instance/pairing-code', async (req, reply) => {
      const i = inst(req)
      const { phoneNumber } = parse(z.object({ phoneNumber: z.string().regex(/^\+?\d{10,15}$/) }), input(req))
      if (manager.get(i.id)?.status === 'connected') return reply.status(400).send({ error: true, message: 'Instância já está conectada' })
      await manager.disconnect(i.id)
      const session = await manager.connect(i.id, phoneNumber)
      for (let t = 0; t < 20 && !session.pairingCode; t++) await new Promise((res) => setTimeout(res, 500))
      if (!session.pairingCode) return reply.status(400).send({ error: true, message: 'Não foi possível gerar o código, tente de novo' })
      return ok({ instanceId: i.id, pairingCode: session.pairingCode })
    })

    r.get('/v1/instance/restart', async (req) => {
      await manager.restart(inst(req).id)
      return ok({ message: 'Instância reiniciada com sucesso.', instanceId: inst(req).id })
    })

    const logout = async (req: FastifyRequest) => {
      await manager.logout(inst(req).id)
      return ok({ message: 'Deslogado com sucesso!', instanceId: inst(req).id })
    }
    r.get('/v1/instance/disconnect', logout)
    r.get('/v1/instance/logout', logout)

    r.get('/v1/instance/status-instance', async (req) => {
      const i = inst(req)
      return { instanceId: i.id, connected: manager.get(i.id)?.status === 'connected' }
    })

    r.get('/v1/instance/device', async (req) => {
      const d = await connectedSession(inst(req)).device()
      return {
        connectedPhone: d.phone,
        lid: d.lid,
        name: d.name,
        platform: d.platform,
        profilePictureUrl: d.picture,
        status: d.about,
        isBusiness: d.isBusiness,
      }
    })

    r.put('/v1/instance/update-instance-name', async (req) => {
      const { instanceName } = parse(z.object({ instanceName: z.string().min(1).max(100) }), input(req))
      await updateSettings(inst(req).id, { name: instanceName })
      return ok({ message: 'Nome da instância atualizado com sucesso.' })
    })

    r.get('/v1/instance/fetch-instance', async (req) => {
      const i = inst(req)
      const { rows } = await pool.query<{ sent: number; received: number }>(
        `select (select count(*)::int from send_jobs where instance_id = $1 and status = 'sent') as sent,
                (select count(*)::int from messages where instance_id = $1 and not from_me) as received`,
        [i.id],
      )
      const h = i.wapi_webhooks ?? {}
      return {
        instanceId: i.id,
        instanceName: i.name,
        token: decrypt(i.token),
        connected: manager.get(i.id)?.status === 'connected',
        connectedPhone: i.phone ?? '',
        paymentStatus: 'PAID',
        created: i.created_at,
        expires: null,
        messagesSent: rows[0].sent,
        messagesReceived: rows[0].received,
        webhookConnectedUrl: h.connected ?? '',
        webhookDeliveryUrl: h.delivery ?? '',
        webhookDisconnectedUrl: h.disconnected ?? '',
        webhookStatusUrl: h.status ?? '',
        webhookPresenceUrl: h.presence ?? '',
        webhookReceivedUrl: h.received ?? '',
        automaticReading: i.auto_read,
        rejectCalls: i.reject_calls,
        callMessage: i.call_message ?? '',
        ignoreGroups: i.ignore_groups,
      }
    })

    const toggle = (field: 'autoRead' | 'ignoreGroups' | 'rejectCalls', label: string) => async (req: FastifyRequest) => {
      const raw = input(req).value
      const i = inst(req)
      // Sem "value", alterna (a doc da W-API não manda corpo nesses endpoints)
      const current = { autoRead: i.auto_read, ignoreGroups: i.ignore_groups, rejectCalls: i.reject_calls }[field]
      const value = raw === undefined ? !current : parse(bool, raw)
      await updateSettings(i.id, { [field]: value })
      return ok({ message: `${label} ${value ? 'ativado' : 'desativado'} com sucesso.` })
    }
    r.put('/v1/instance/update-auto-read-message', toggle('autoRead', 'Leitura automática'))
    r.put('/v1/instance/update-ignore-groups', toggle('ignoreGroups', 'Ignorar eventos de grupos'))
    r.put('/v1/instance/update-call-reject-auto', toggle('rejectCalls', 'Rejeitar ligações'))

    r.put('/v1/instance/update-call-reject-message', async (req) => {
      const { value } = parse(z.object({ value: z.string().max(1000) }), input(req))
      await updateSettings(inst(req).id, { callMessage: value || null })
      return ok({ message: 'Mensagem de ligação atualizada com sucesso.' })
    })

    r.put('/v1/instance/update-proxy', async (req) => {
      const b = parse(
        z.object({
          useProxy: bool,
          proxyProtocol: z.enum(['http', 'https', 'socks5']).optional(),
          proxyHost: z.string().optional(),
          proxyPort: z.coerce.number().int().optional(),
          proxyUser: z.string().optional(),
          proxyPass: z.string().optional(),
        }),
        input(req),
      )
      if (b.useProxy && !(b.proxyHost && b.proxyPort)) throw new WapiError(400, 'proxyHost e proxyPort são obrigatórios')
      await updateSettings(inst(req).id, {
        proxy: b.useProxy ? { protocol: b.proxyProtocol ?? 'http', host: b.proxyHost!, port: b.proxyPort!, user: b.proxyUser, pass: b.proxyPass } : null,
      })
      return ok({ message: 'Proxy da instância atualizado com sucesso. Reinicie a instância para aplicar.' })
    })

    r.put('/v1/instance/profile-name', async (req) => {
      const { name } = parse(z.object({ name: z.string().min(1).max(25) }), input(req))
      await connectedSession(inst(req)).socket().updateProfileName(name)
      return ok()
    })

    r.put('/v1/instance/profile-description', async (req) => {
      const { description } = parse(z.object({ description: z.string().max(139) }), input(req))
      await connectedSession(inst(req)).socket().updateProfileStatus(description)
      return ok()
    })

    r.put('/v1/instance/profile-picture', async (req) => {
      const { url } = parse(z.object({ url: z.string().min(10) }), input(req))
      const sock = connectedSession(inst(req)).socket()
      await sock.updateProfilePicture(sock.user!.id, (await loadMedia(media(url))).buffer)
      return ok()
    })

    r.post('/v1/instance/extension-token', async (_req, reply) =>
      reply.status(501).send({ error: true, message: 'Extensão do navegador não disponível nesta API' }),
    )

    // ---------- mensagens ----------

    const msg = (schema: z.ZodTypeAny, build: (b: any) => SendRequest) => async (req: FastifyRequest, reply: FastifyReply) =>
      send(inst(req), build(parse(schema, input(req))), reply)

    r.post('/v1/message/send-text', msg(z.object({ ...common, message: z.string().min(1) }), (b) => ({ ...base(b), type: 'text', text: b.message })))
    r.post(
      '/v1/message/send-image',
      msg(z.object({ ...common, image: z.string().min(10), caption: z.string().optional() }), (b) => ({ ...base(b), type: 'image', ...media(b.image), caption: b.caption })),
    )
    r.post('/v1/message/send-sticker', msg(z.object({ ...common, sticker: z.string().min(10) }), (b) => ({ ...base(b), type: 'sticker', ...media(b.sticker) })))
    r.post(
      '/v1/message/send-gif',
      msg(z.object({ ...common, gif: z.string().min(10), caption: z.string().optional() }), (b) => ({ ...base(b), type: 'video', ...media(b.gif), caption: b.caption, gif: true })),
    )
    r.post('/v1/message/send-audio', msg(z.object({ ...common, audio: z.string().min(10) }), (b) => ({ ...base(b), type: 'audio', ...media(b.audio), ptt: true })))
    r.post(
      '/v1/message/send-video',
      msg(z.object({ ...common, video: z.string().min(10), caption: z.string().optional() }), (b) => ({ ...base(b), type: 'video', ...media(b.video), caption: b.caption })),
    )
    r.post('/v1/message/send-ptv', msg(z.object({ ...common, ptv: z.string().min(10) }), (b) => ({ ...base(b), type: 'video', ...media(b.ptv), videoNote: true })))
    r.post(
      '/v1/message/send-document',
      msg(
        z.object({ ...common, document: z.string().min(10), extension: z.string().optional(), fileName: z.string().optional(), caption: z.string().optional() }),
        (b) => {
          const ext = (b.extension ?? '').replace(/^\./, '')
          const mimetype = ext ? mime.lookup(ext) || undefined : undefined
          const fileName = b.fileName ? (ext && !b.fileName.includes('.') ? `${b.fileName}.${ext}` : b.fileName) : ext ? `arquivo.${ext}` : undefined
          return { ...base(b), type: 'document', ...media(b.document, mimetype), fileName, caption: b.caption }
        },
      ),
    )
    r.post(
      '/v1/message/send-link',
      msg(
        z.object({ ...common, message: z.string().min(1), linkUrl: z.string().url(), title: z.string(), linkDescription: z.string().optional(), image: z.string().optional(), linkType: z.string().optional() }),
        (b) => ({ ...base(b), type: 'link', text: b.message, url: b.linkUrl, title: b.title, description: b.linkDescription, image: b.image || undefined }),
      ),
    )
    r.post(
      '/v1/message/send-location',
      msg(
        z.object({ ...common, latitude: z.coerce.number(), longitude: z.coerce.number(), name: z.string().optional(), address: z.string().optional() }),
        (b) => ({ ...base(b), type: 'location', latitude: b.latitude, longitude: b.longitude, name: b.name, address: b.address }),
      ),
    )
    const wapiContact = z.object({ contactName: z.string().min(1), contactPhone: z.string().min(8), contactBusinessDescription: z.string().optional() })
    const toContact = (c: z.infer<typeof wapiContact>) => ({ name: c.contactName, phone: c.contactPhone.replace(/\D/g, ''), organization: c.contactBusinessDescription || undefined })
    r.post('/v1/message/send-contact', msg(z.object({ ...common, ...wapiContact.shape }), (b) => ({ ...base(b), type: 'contact', contacts: [toContact(b)] })))
    r.post('/v1/message/send-contacts', msg(z.object({ ...common, contacts: z.array(wapiContact).min(1) }), (b) => ({ ...base(b), type: 'contact', contacts: b.contacts.map(toContact) })))
    r.post(
      '/v1/message/send-poll',
      msg(
        z.object({ ...common, message: z.string().min(1), poll: z.array(z.string().min(1)).min(2), pollMaxOptions: z.coerce.number().int().optional() }),
        (b) => ({ ...base(b), type: 'poll', name: b.message, options: b.poll, selectableCount: b.pollMaxOptions ?? 1 }),
      ),
    )
    r.post(
      '/v1/message/send-reaction',
      msg(z.object({ ...common, messageId: z.string().min(1), reaction: z.string().min(1) }), (b) => ({ to: b.phone, type: 'reaction', messageId: b.messageId, emoji: b.reaction, delaySeconds: b.delayMessage || undefined })),
    )
    r.post(
      '/v1/message/remove-reaction',
      msg(z.object({ ...common, messageId: z.string().min(1) }), (b) => ({ to: b.phone, type: 'reaction', messageId: b.messageId, emoji: '', delaySeconds: b.delayMessage || undefined })),
    )
    r.post('/v1/message/edit-message', msg(z.object({ ...common, messageId: z.string().min(1), text: z.string().min(1) }), (b) => ({ to: b.phone, type: 'edit', messageId: b.messageId, text: b.text })))
    r.delete('/v1/message/delete-message', msg(z.object({ phone, messageId: z.string().min(1) }), (b) => ({ to: b.phone, type: 'delete', messageId: b.messageId })))
    const buttonsAction = msg(z.object({ ...common, message: z.string().min(1), buttonActions: z.array(wapiButton).min(1).max(10) }), (b) => ({
      ...base(b),
      type: 'buttons',
      text: b.message,
      buttons: b.buttonActions.map(toButton),
    }))
    // Os dois nomes existem por aí: a doc da W-API usa send-buttons-action; integrações usam send-button-actions
    r.post('/v1/message/send-button-actions', buttonsAction)
    r.post('/v1/message/send-buttons-action', buttonsAction)
    // Lista de botões de resposta (formato estilo Z-API: buttonList.buttons[{id,label}])
    r.post(
      '/v1/message/send-button-list',
      msg(
        z.object({
          ...common,
          message: z.string().min(1),
          buttonList: z.object({ buttons: z.array(z.object({ id: z.string().optional(), label: z.string().min(1) })).min(1).max(10) }).optional(),
          buttons: z.array(z.object({ id: z.string().optional(), buttonId: z.string().optional(), label: z.string().optional(), buttonText: z.string().optional() })).optional(),
        }),
        (b) => ({
          ...base(b),
          type: 'buttons',
          text: b.message,
          buttons: (b.buttonList?.buttons ?? b.buttons ?? []).map((x: { id?: string; buttonId?: string; label?: string; buttonText?: string }) => ({
            type: 'reply' as const,
            text: (x.label ?? x.buttonText)!,
            id: x.id ?? x.buttonId,
          })),
        }),
      ),
    )
    r.post(
      '/v1/message/send-otp',
      msg(z.object({ ...common, message: z.string().min(1), buttonText: z.string().min(1), code: z.string().min(1) }), (b) => ({
        ...base(b),
        type: 'buttons',
        text: b.message,
        buttons: [{ type: 'copy' as const, text: b.buttonText, code: b.code }],
      })),
    )
    r.post(
      '/v1/message/send-pix',
      msg(
        z.object({ ...common, merchantName: z.string().default(''), pixKey: z.string().min(1), type: z.string().transform((t) => t.toUpperCase()), amount: z.coerce.number().default(0) }),
        (b) => ({ ...base(b), type: 'pix', merchantName: b.merchantName, pixKey: b.pixKey, keyType: b.type, amount: b.amount }),
      ),
    )
    r.post(
      '/v1/message/send-carousel',
      msg(
        z.object({
          ...common,
          message: z.string().min(1),
          cards: z.array(z.object({ text: z.string().min(1), image: z.string().min(10), buttonActions: z.array(wapiButton).min(1) })).min(1).max(10),
        }),
        (b) => ({
          ...base(b),
          type: 'carousel',
          text: b.message,
          cards: b.cards.map((c: { text: string; image: string; buttonActions: z.infer<typeof wapiButton>[] }) => ({ text: c.text, image: c.image, buttons: c.buttonActions.map(toButton) })),
        }),
      ),
    )
    r.post(
      '/v1/message/send-list',
      msg(
        z.object({
          ...common,
          title: z.string().optional(),
          description: z.string().min(1),
          buttonText: z.string().min(1),
          footerText: z.string().optional(),
          sections: z.array(z.object({ title: z.string(), rows: z.array(z.object({ title: z.string().min(1), description: z.string().optional(), rowId: z.string().min(1) })).min(1) })).min(1),
        }),
        (b) => ({
          ...base(b),
          type: 'list',
          title: b.title,
          text: b.description,
          buttonText: b.buttonText,
          footer: b.footerText,
          sections: b.sections.map((s: { title: string; rows: { title: string; description?: string; rowId: string }[] }) => ({
            title: s.title,
            rows: s.rows.map((row) => ({ id: row.rowId, title: row.title, description: row.description })),
          })),
        }),
      ),
    )

    r.post('/v1/message/read-message', async (req) => {
      const b = parse(z.object({ phone, messageId: z.string().min(1) }), input(req))
      const session = connectedSession(inst(req))
      const stored = await loadStoredMessage(inst(req).id, b.messageId)
      const chatId = stored?.key.remoteJid ?? (b.phone.includes('@') ? b.phone : await session.jidFor(b.phone))
      await session.markRead(chatId, [b.messageId])
      return {}
    })

    r.post('/v1/message/download-media', async (req) => {
      const b = parse(
        z.object({ mediaKey: z.string().min(10), directPath: z.string().min(5), type: z.enum(['image', 'video', 'audio', 'document', 'sticker', 'ptv']), mimetype: z.string().min(3) }),
        input(req),
      )
      const r2 = await connectedSession(inst(req)).downloadByKey(b)
      return ok({ fileLink: r2.url, expires: r2.expiresAt })
    })

    // ---------- conversas ----------

    r.get('/v1/chats/fetch-chats', async (req) => {
      const i = inst(req)
      const q = parse(z.object({ perPage: z.coerce.number().int().min(1).max(500).default(20), page: z.coerce.number().int().min(1).default(1) }), input(req))
      const { rows } = await pool.query<{ remote_jid: string; created_at: Date; total: number; name: string | null; phone: string | null }>(
        `select t.*, c.name, coalesce(c.phone, l.pn) as phone, count(*) over ()::int as total from (
           select distinct on (remote_jid) remote_jid, created_at from messages
           where instance_id = $1 and remote_jid <> 'status@broadcast' order by remote_jid, created_at desc
         ) t
         left join contacts c on c.instance_id = $1 and c.jid = t.remote_jid
         left join lid_mappings l on l.instance_id = $1 and l.lid = t.remote_jid
         order by t.created_at desc limit $2 offset $3`,
        [i.id, q.perPage, (q.page - 1) * q.perPage],
      )
      const total = rows[0]?.total ?? 0
      return ok({
        chats: rows.map((c) => ({
          id: c.remote_jid,
          phone: c.remote_jid.endsWith('@s.whatsapp.net') ? c.remote_jid.split('@')[0] : c.phone?.split('@')[0] ?? null,
          name: c.name,
          isGroup: c.remote_jid.endsWith('@g.us'),
          lastMessageTime: Math.floor(c.created_at.getTime() / 1000),
        })),
        totalChats: total,
        totalPages: Math.ceil(total / q.perPage),
        currentPage: q.page,
      })
    })

    r.get('/v1/chats/chat', async (req) => {
      const i = inst(req)
      const { phoneNumber } = parse(z.object({ phoneNumber: z.string().min(5) }), input(req))
      const session = connectedSession(i)
      const jid = phoneNumber.includes('@') ? phoneNumber : await session.jidFor(phoneNumber)
      const { rows } = await pool.query<{ id: string; from_me: boolean; created_at: Date }>(
        'select id, from_me, created_at from messages where instance_id = $1 and remote_jid = $2 order by created_at desc limit 1',
        [i.id, jid],
      )
      const contact = await pool.query<{ name: string | null; notify: string | null }>('select name, notify from contacts where instance_id = $1 and jid = $2', [i.id, jid])
      return ok({
        chat: {
          id: jid,
          phone: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null,
          name: contact.rows[0]?.name ?? contact.rows[0]?.notify ?? null,
          profilePicture: (await session.profilePicture(jid)).url,
          lastMessageId: rows[0]?.id ?? null,
          lastMessageTime: rows[0] ? Math.floor(rows[0].created_at.getTime() / 1000) : null,
        },
      })
    })

    r.post('/v1/chats/send-presence', async (req) => {
      const b = parse(
        z.object({
          phone,
          presence: z.string().transform((p) => p.toLowerCase()).pipe(z.enum(['composing', 'recording', 'paused', 'available', 'unavailable'])),
          delay: z.coerce.number().int().min(0).max(60).optional(),
        }),
        input(req),
      )
      const session = connectedSession(inst(req))
      await session.presence(b.phone, b.presence)
      // Com delay, mantém o "digitando" pelo tempo pedido e depois para
      if (b.delay && (b.presence === 'composing' || b.presence === 'recording')) {
        setTimeout(() => session.presence(b.phone, 'paused').catch(() => undefined), b.delay * 1000)
      }
      return ok()
    })

    /**
     * Mensagens antigas de uma conversa, sob demanda (não existe na W-API).
     *
     * O WhatsApp responde depois, em segundos: cada mensagem antiga chega pelo webhook
     * normal marcada com `historical: true`, para o sistema guardar sem tratar como nova
     */
    r.post('/v1/chats/fetch-older-messages', async (req) => {
      const b = parse(z.object({ phone, count: z.coerce.number().int().min(1).max(200).default(50) }), input(req))
      const pedido = await connectedSession(inst(req)).fetchOlderMessages(b.phone, b.count)
      return { error: false, message: 'Pedido enviado ao WhatsApp. As mensagens chegam pelo webhook em alguns segundos.', ...pedido }
    })

    // ---------- contatos ----------

    r.get('/v1/contacts/phone-exists', async (req) => {
      const { phoneNumber } = parse(z.object({ phoneNumber: z.string().min(8) }), input(req))
      const session = connectedSession(inst(req))
      const result = await session.checkNumber(phoneNumber)
      let lid: string | null = null
      if (result.jid) {
        try {
          lid = (await session.socket().signalRepository.lidMapping.getLIDForPN(result.jid)) ?? null
        } catch {
          // sem LID conhecido
        }
      }
      return { exists: result.exists, phoneNumber: result.jid?.split('@')[0] ?? phoneNumber.replace(/\D/g, ''), lid }
    })

    r.post('/v1/contacts/check-numbers', async (req) => {
      const { phones } = parse(z.object({ phones: z.array(z.string().min(8)).min(1).max(500) }), input(req))
      const session = connectedSession(inst(req))
      const results = []
      for (const p of phones) {
        const res = await session.checkNumber(p)
        results.push({ phone: p.replace(/\D/g, ''), exists: res.exists, jid: res.jid })
      }
      return ok({ results })
    })

    r.get('/v1/contacts/fetch-contacts', async (req) => {
      const q = parse(z.object({ perPage: z.coerce.number().int().min(1).max(500).default(50), page: z.coerce.number().int().min(1).default(1) }), input(req))
      const { rows, total } = await listContacts(inst(req).id, q.page, q.perPage)
      return ok({
        message: 'Contatos encontrados com sucesso.',
        contacts: rows.map((c) => ({ id: c.jid, name: c.name ?? undefined, notify: c.notify ?? '', verifiedName: c.verified_name ?? '', lid: c.lid ?? undefined })),
        totalContacts: total,
        totalPages: Math.ceil(total / q.perPage),
        currentPage: q.page,
      })
    })

    r.get('/v1/contacts/profile-picture', async (req) => {
      const { phoneNumber } = parse(z.object({ phoneNumber: z.string().min(5) }), input(req))
      return { link: (await connectedSession(inst(req)).profilePicture(phoneNumber)).url }
    })

    r.post('/v1/contacts/block-contact', async (req) => {
      const b = parse(z.object({ phoneNumber: z.string().min(5), blockStatus: z.enum(['block', 'unblock']) }), input(req))
      const session = connectedSession(inst(req))
      await session.socket().updateBlockStatus(await session.jidFor(b.phoneNumber), b.blockStatus)
      return ok({ message: b.blockStatus === 'block' ? 'Contato bloqueado' : 'Contato desbloqueado' })
    })

    // ---------- grupos ----------

    const groupId = z.string().endsWith('@g.us')
    const toJids = (session: Session, list: string[]) => Promise.all(list.map((p) => (p.includes('@') ? p : session.jidFor(p))))
    const inviteLink = async (session: Session, gid: string) => {
      try {
        const code = await session.socket().groupInviteCode(gid)
        return code ? `https://chat.whatsapp.com/${code}` : null
      } catch {
        return null // só admin vê o link
      }
    }

    r.post('/v1/group/create-group', async (req) => {
      const b = parse(z.object({ groupName: z.string().min(1).max(100), participants: z.array(z.string()).min(1), profilePictureUrl: z.string().optional(), autoInvite: bool.optional() }), input(req))
      const session = connectedSession(inst(req))
      const sock = session.socket()
      const group = await sock.groupCreate(b.groupName, await toJids(session, b.participants))
      if (b.profilePictureUrl) {
        try {
          await sock.updateProfilePicture(group.id, (await loadMedia(media(b.profilePictureUrl))).buffer)
        } catch (err) {
          logger.warn({ err }, 'foto do grupo não aplicada')
        }
      }
      return ok({ group: { id: group.id, inviteLink: await inviteLink(session, group.id) } })
    })

    r.post('/v1/group/update-group-name', async (req) => {
      const b = parse(z.object({ groupId, groupName: z.string().min(1).max(100) }), input(req))
      await connectedSession(inst(req)).socket().groupUpdateSubject(b.groupId, b.groupName)
      return ok()
    })

    r.post('/v1/group/update-group-photo', async (req) => {
      const b = parse(z.object({ groupId, groupPhoto: z.string().min(10) }), input(req))
      await connectedSession(inst(req)).socket().updateProfilePicture(b.groupId, (await loadMedia(media(b.groupPhoto))).buffer)
      return ok()
    })

    r.post('/v1/group/update-description', async (req) => {
      const b = parse(z.object({ groupId, description: z.string().max(2048) }), input(req))
      await connectedSession(inst(req)).socket().groupUpdateDescription(b.groupId, b.description || undefined)
      return ok()
    })

    const participants = (action: 'add' | 'remove' | 'promote' | 'demote') => async (req: FastifyRequest) => {
      const b = parse(z.object({ groupId, phones: z.array(z.string()).min(1), autoInvite: bool.optional() }), input(req))
      const session = connectedSession(inst(req))
      const result = await session.socket().groupParticipantsUpdate(b.groupId, await toJids(session, b.phones), action)
      // autoInvite: quem não pôde ser adicionado (privacidade) recebe o link por mensagem
      if (action === 'add' && b.autoInvite) {
        const link = await inviteLink(session, b.groupId)
        for (const p of result.filter((x) => x.status === '403' || x.status === '408')) {
          if (link) await createJob(inst(req).id, { to: p.jid!, type: 'text', text: `Você foi convidado para um grupo: ${link}` })
        }
        session.kickQueue()
      }
      return ok()
    }
    r.post('/v1/group/add-participant', participants('add'))
    r.post('/v1/group/remove-participant', participants('remove'))
    r.post('/v1/group/add-admin', participants('promote'))
    r.post('/v1/group/remove-admin', participants('demote'))

    r.delete('/v1/group/leave-group', async (req) => {
      const b = parse(z.object({ groupId }), input(req))
      await connectedSession(inst(req)).socket().groupLeave(b.groupId)
      return ok()
    })

    r.get('/v1/group/group-metadata', async (req) => {
      const b = parse(z.object({ groupId }), input(req))
      const session = connectedSession(inst(req))
      const meta = await session.groupMetadata(b.groupId)
      return ok({ group: { ...meta, inviteLink: await inviteLink(session, b.groupId) } })
    })

    r.get('/v1/group/group-invitation-metadata', async (req) => {
      const { inviteUrl } = parse(z.object({ inviteUrl: z.string().min(5) }), input(req))
      const code = inviteUrl.trim().replace(/^https?:\/\/chat\.whatsapp\.com\//, '').split(/[/?#]/)[0]
      return connectedSession(inst(req)).socket().groupGetInviteInfo(code)
    })

    r.get('/v1/group/get-Participants', async (req) => {
      const b = parse(z.object({ groupId }), input(req))
      const meta = await connectedSession(inst(req)).groupMetadata(b.groupId)
      return ok({ participants: meta.participants.map((p) => ({ id: p.phoneNumber ?? p.id, lid: p.lid ?? (p.id.endsWith('@lid') ? p.id : undefined), admin: p.admin ?? null })) })
    })

    r.post('/v1/group/revoke-invite', async (req) => {
      const b = parse(z.object({ groupId }), input(req))
      const code = await connectedSession(inst(req)).socket().groupRevokeInvite(b.groupId)
      return ok({ link: code ? `https://chat.whatsapp.com/${code}` : null })
    })

    r.post('/v1/group/update-group-settings', async (req) => {
      const b = parse(z.object({ groupId, adminOnlyMessage: bool.optional(), adminOnlySettings: bool.optional() }), input(req))
      const sock = connectedSession(inst(req)).socket()
      if (b.adminOnlyMessage !== undefined) await sock.groupSettingUpdate(b.groupId, b.adminOnlyMessage ? 'announcement' : 'not_announcement')
      if (b.adminOnlySettings !== undefined) await sock.groupSettingUpdate(b.groupId, b.adminOnlySettings ? 'locked' : 'unlocked')
      return ok()
    })

    r.get('/v1/group/get-all-groups', async (req) => {
      const groups = await connectedSession(inst(req)).listGroups()
      return ok({
        message: 'Grupos encontrados com sucesso',
        groups: groups.map((g) => ({ id: g.id, subject: g.subject, size: g.size ?? g.participants.length, owner: g.owner, isCommunity: !!g.isCommunity, announce: !!g.announce })),
      })
    })

    // ---------- webhooks ----------

    const hook = (key: string, label: string) => async (req: FastifyRequest) => {
      const { value } = parse(z.object({ value: z.string().url().or(z.literal('')) }), input(req))
      await pool.query(`update instances set wapi_webhooks = wapi_webhooks || jsonb_build_object($2::text, $3::text), updated_at = now() where id = $1`, [inst(req).id, key, value])
      return ok({ message: `Webhook de ${label} atualizado.` })
    }
    r.put('/v1/webhook/update-webhook-connected', hook('connected', 'conexão'))
    r.put('/v1/webhook/update-webhook-disconnected', hook('disconnected', 'desconexão'))
    r.put('/v1/webhook/update-webhook-delivery', hook('delivery', 'envio'))
    r.put('/v1/webhook/update-webhook-received', hook('received', 'mensagens recebidas'))
    // A W-API chama a mesma coisa de "message-received" em parte da documentação;
    // sistemas que vêm de lá tentam esse nome primeiro.
    r.put('/v1/webhook/update-webhook-message-received', hook('received', 'mensagens recebidas'))
    r.put('/v1/webhook/update-webhook-message-status', hook('status', 'status'))
    r.put('/v1/webhook/update-webhook-chat-presence', hook('presence', 'presença'))

    const toLog = (l: Record<string, any>) => ({
      id: String(l.id),
      created: l.created_at,
      event: l.event,
      time: l.duration_ms != null ? (l.duration_ms / 1000).toFixed(3) : null,
      status: l.response_status,
      url: l.url || l.target_url,
      attempts: l.attempts,
      error: l.last_error,
    })

    r.get('/v1/webhook/fetch-webhook-logs', async (req) => {
      const q = parse(z.object({ perPage: z.coerce.number().int().min(1).max(500).default(10), page: z.coerce.number().int().min(1).default(1) }), input(req))
      const { rows, total } = await listWebhookLogs(inst(req).id, q.page, q.perPage)
      return ok({ message: 'Logs de webhook recuperados com sucesso.', logs: rows.map(toLog), totalLogs: total, totalPages: Math.ceil(total / q.perPage), currentPage: q.page })
    })

    // Resgate: eventos de mensagem gerados desde "since" (segundos unix), para conferir se algo se perdeu
    r.get('/v1/webhook/fetch-events', async (req) => {
      const q = parse(z.object({ since: z.coerce.number().min(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }), input(req))
      return ok(await listMessageEvents(inst(req).id, q.since, q.limit))
    })

    r.post('/v1/instance/create-call-link', async (req) => {
      const { type } = parse(z.object({ type: z.enum(['audio', 'video']).default('audio') }), input(req))
      const token = await connectedSession(inst(req)).socket().createCallLink(type)
      if (!token) throw new WapiError(502, 'O WhatsApp não devolveu o link')
      return ok({ type, token, link: `https://call.whatsapp.com/${type === 'video' ? 'video' : 'voice'}/${token}` })
    })

    r.get('/v1/webhook/get-webhook-log', async (req) => {
      const { id } = parse(z.object({ id: z.coerce.number().int() }), input(req))
      const { rows } = await pool.query('select * from webhook_outbox where instance_id = $1 and id = $2', [inst(req).id, id])
      if (!rows[0]) throw new WapiError(404, 'Log não encontrado')
      return ok({ message: 'Log de webhook recuperado com sucesso.', log: { ...toLog(rows[0]), payload: JSON.parse(decrypt(rows[0].payload)) } })
    })

    // ---------- fila ("quere" é o nome usado na W-API) ----------

    r.get('/v1/quere/quere', async (req) => {
      const q = parse(z.object({ perPage: z.coerce.number().int().min(1).max(500).default(10), page: z.coerce.number().int().min(1).default(1) }), input(req))
      const { jobs, total } = await listQueued(inst(req).id, q.page, q.perPage)
      return ok({
        messages: jobs.map((j) => ({
          insertedId: j.id,
          instanceId: j.instance_id,
          type: j.payload.type,
          phone: j.payload.to,
          delayMessage: j.delay_seconds,
          MessageId: j.message_id,
          created: j.created_at.getTime(),
          message: 'text' in j.payload ? j.payload.text : undefined,
        })),
        total,
      })
    })

    r.delete('/v1/quere/delete-quere', async (req) => ok({ message: 'Fila apagada com sucesso.', deletedCount: await cancelQueued(inst(req).id) }))

    r.delete('/v1/quere/delete-message', async (req) => {
      const { insertedId } = parse(z.object({ insertedId: z.string().uuid() }), input(req))
      const removed = await cancelQueued(inst(req).id, insertedId)
      if (!removed) throw new WapiError(404, 'Mensagem não está na fila')
      return ok({ message: 'Mensagem deletada com sucesso.' })
    })
  })
}
