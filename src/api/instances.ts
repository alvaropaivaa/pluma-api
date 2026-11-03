import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { z } from 'zod'
import { pool } from '../db.js'
import { encrypt, newToken } from '../security/crypto.js'
import { manager } from '../whatsapp/manager.js'
import { HttpError, loadInstance, parse, toInstance, type InstanceRow } from './common.js'

export const WEBHOOK_EVENTS = [
  'qr',
  'connection.update',
  'messages.upsert',
  'messages.update',
  'send.update',
  'messages.delete',
  'messages.edit',
  'poll.update',
  'presence.update',
  'call',
  'groups.update',
  'group-participants.update',
] as const

const webhookSchema = z.object({
  webhookUrl: z.string().url().nullable().optional(),
  webhookEvents: z.array(z.enum(WEBHOOK_EVENTS)).optional(),
})

export async function instanceRoutes(api: FastifyInstance) {
  api.post('/instances', async (req, reply) => {
    const body = parse(webhookSchema.extend({ name: z.string().min(1).max(100) }), req.body)
    const secret = randomBytes(32).toString('hex')
    const { rows } = await pool
      .query<InstanceRow>(
        `insert into instances (account_id, name, webhook_url, webhook_events, webhook_secret, token)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [req.accountId, body.name, body.webhookUrl ?? null, body.webhookEvents ?? [], encrypt(secret), encrypt(newToken())],
      )
      .catch((err) => {
        if (err.code === '23505') throw new HttpError(409, 'já existe uma instância com esse nome')
        throw err
      })
    // O segredo do webhook (para validar a assinatura HMAC) só aparece aqui
    return reply.status(201).send({ ...toInstance(rows[0]), webhookSecret: secret })
  })

  api.get('/instances', async (req) => {
    const { rows } = await pool.query<InstanceRow>('select * from instances where account_id = $1 order by created_at', [req.accountId])
    return rows.map(toInstance)
  })

  api.get('/instances/:id', async (req) => toInstance(await loadInstance(req)))

  api.post('/instances/:id/connect', async (req) => {
    const instance = await loadInstance(req)
    const { phone } = parse(z.object({ phone: z.string().regex(/^\+?\d{10,15}$/).optional() }), req.body ?? {})
    const session = await manager.connect(instance.id, phone)
    return { status: session.status }
  })

  api.get('/instances/:id/qr', async (req) => {
    const instance = await loadInstance(req)
    const session = manager.get(instance.id)
    if (!session?.qr) return { status: session?.status ?? instance.status, qr: null, pairingCode: session?.pairingCode ?? null }
    return {
      status: session.status,
      qr: session.qr,
      qrImage: await QRCode.toDataURL(session.qr),
      pairingCode: session.pairingCode ?? null,
    }
  })

  api.post('/instances/:id/restart', async (req) => {
    const instance = await loadInstance(req)
    const session = await manager.restart(instance.id)
    return { status: session.status }
  })

  api.post('/instances/:id/disconnect', async (req) => {
    const instance = await loadInstance(req)
    await manager.disconnect(instance.id)
    return { status: 'disconnected' }
  })

  api.post('/instances/:id/logout', async (req) => {
    const instance = await loadInstance(req)
    await manager.logout(instance.id)
    return { status: 'logged_out' }
  })

  api.delete('/instances/:id', async (req, reply) => {
    const instance = await loadInstance(req)
    await manager.remove(instance.id)
    return reply.status(204).send()
  })

  api.put('/instances/:id/webhook', async (req) => {
    const instance = await loadInstance(req)
    const body = parse(webhookSchema, req.body)
    const { rows } = await pool.query<InstanceRow>(
      `update instances set
         webhook_url = case when $2 then $3 else webhook_url end,
         webhook_events = coalesce($4, webhook_events),
         updated_at = now()
       where id = $1 returning *`,
      [instance.id, body.webhookUrl !== undefined, body.webhookUrl ?? null, body.webhookEvents ?? null],
    )
    return toInstance(rows[0])
  })
}
