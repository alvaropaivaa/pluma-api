import { startAlerts } from './alerts/alerts.js'
import { buildServer } from './api/server.js'
import { config } from './config.js'
import { pool } from './db.js'
import { logger } from './logger.js'
import { cleanupLocalMedia, cleanupOrphanMedia } from './storage/media-storage.js'
import { startWebhookDispatcher } from './webhooks/outbox.js'
import { manager } from './whatsapp/manager.js'

const HOUR = 60 * 60 * 1000
const role = config.ROLE
// Quem cuida das tarefas gerais (webhooks e limpeza): o roteador, ou o processo único em modo "all"
const runsShared = role !== 'worker'
// Quem segura conexões do WhatsApp
const holdsSessions = role !== 'router'

async function cleanup() {
  const messages = await pool.query('delete from messages where created_at < now() - make_interval(days => $1)', [config.MESSAGE_RETENTION_DAYS])
  const webhooks = await pool.query(`delete from webhook_outbox where coalesce(delivered_at, failed_at) < now() - interval '7 days'`)
  await pool.query(`delete from alert_outbox where coalesce(sent_at, failed_at) < now() - interval '30 days'`)
  const jobs = await pool.query(`delete from send_jobs where status in ('sent', 'failed') and updated_at < now() - interval '30 days'`)
  await pool.query(`delete from workers where heartbeat_at < now() - interval '1 hour'`)
  const media = await cleanupLocalMedia()
  const { rows: vivas } = await pool.query<{ id: string }>('select id from instances')
  const orfas = await cleanupOrphanMedia(new Set(vivas.map((r) => r.id)))
  logger.info({ messages: messages.rowCount, webhooks: webhooks.rowCount, jobs: jobs.rowCount, media, orfas }, 'limpeza concluída')
}

const app = await buildServer()
const stopDispatcher = runsShared ? startWebhookDispatcher() : () => undefined
const stopAlerts = runsShared ? startAlerts() : () => undefined
const cleanupTimer = runsShared ? setInterval(() => cleanup().catch((err) => logger.error({ err }, 'falha na limpeza')), HOUR) : undefined

// Worker escuta só para o roteador: na própria máquina ou, com dois containers, na rede interna
// do Docker (a porta não é publicada e toda chamada exige o segredo interno)
const port = role === 'worker' ? config.INTERNAL_PORT : config.PORT
const host = role === 'worker' ? (config.ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1') : config.HOST
await app.listen({ port, host })
logger.info('%s ouvindo em %s:%d', role, host, port)

if (runsShared) await manager.fixStaleStatuses()
if (holdsSessions) manager.startLoop()

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('%s recebido, desligando', signal)
  clearInterval(cleanupTimer)
  stopDispatcher()
  stopAlerts()
  // Passa os números para o outro container com a API ainda no ar (o roteador de lá
  // continua chegando nos números que ainda estão aqui); depois solta o que sobrou
  if (holdsSessions) await manager.handOffAll().catch((err) => logger.error({ err }, 'falha na passagem dos números'))
  await app.close()
  if (holdsSessions) await manager.shutdown()
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (err) => logger.error({ err }, 'promessa rejeitada sem tratamento'))
