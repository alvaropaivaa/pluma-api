import { config } from '../config.js'
import { pool } from '../db.js'
import { logger } from '../logger.js'
import { emailConfigured, sendEmail } from './email.js'
import { quedasNaUltimaHora, resumoDoDia } from './downtime.js'
import { disconnectedEmail, flappingEmail, opsEmail, reconnectedEmail, unstableEmail } from './templates.js'

/**
 * Alertas por e-mail. Cliente (e-mails da conta): canal caiu, está instável, voltou.
 * Operação (OPS_ALERT_EMAILS): processo reiniciado, memória, fila acumulando, queda em massa.
 * Tudo passa por uma fila (alert_outbox): nada se perde se o provedor de e-mail cair.
 */

const opsRecipients = () =>
  config.OPS_ALERT_EMAILS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

async function recipientsFor(accountId: string) {
  const { rows } = await pool.query<{ alert_emails: string[]; users: string[] }>(
    `select a.alert_emails, coalesce(array_agg(u.email) filter (where u.email is not null), '{}') as users
     from accounts a left join panel_users u on u.account_id = a.id where a.id = $1 group by a.id`,
    [accountId],
  )
  const r = rows[0]
  if (!r) return []
  return r.alert_emails.length ? r.alert_emails : r.users
}

async function instanceInfo(instanceId: string) {
  const { rows } = await pool.query<{ account_id: string; account_name: string; name: string; phone: string | null }>(
    'select i.account_id, a.name as account_name, i.name, i.phone from instances i join accounts a on a.id = i.account_id where i.id = $1',
    [instanceId],
  )
  const r = rows[0]
  return r && { accountId: r.account_id, info: { accountName: r.account_name, instanceName: r.name, phone: r.phone, instanceId } }
}

async function enqueue(accountId: string | null, instanceId: string | null, kind: string, recipients: string[], mail: { subject: string; html: string }) {
  if (!recipients.length) return
  await pool.query(
    'insert into alert_outbox (account_id, instance_id, kind, recipients, subject, html) values ($1, $2, $3, $4, $5, $6)',
    [accountId, instanceId, kind, recipients, mail.subject, mail.html],
  )
}

/** Canal caiu (deslogado, bloqueado, aberto em outro lugar): avisa uma vez por incidente */
export async function channelDown(instanceId: string, reason: string) {
  const { rows } = await pool.query<{ kind: string; inserted: boolean }>(
    `insert into instance_incidents (instance_id, kind) values ($1, 'disconnected')
     on conflict (instance_id) do update set kind = 'disconnected' where instance_incidents.kind <> 'disconnected'
     returning kind, (xmax = 0) as inserted`,
    [instanceId],
  )
  if (!rows[0]) return // já avisado
  const inst = await instanceInfo(instanceId)
  if (!inst) return
  await enqueue(inst.accountId, instanceId, 'disconnected', await recipientsFor(inst.accountId), disconnectedEmail(inst.info, reason))
}

/**
 * Canal caindo e voltando toda hora. Queda de poucos segundos é rotina do
 * WhatsApp e não vira e-mail — ninguém precisa saber de 3 segundos. Mas acima de
 * um certo número de quedas na mesma hora deixa de ser rotina, e aí avisamos,
 * no máximo uma vez por hora por canal.
 */
export async function channelUnstable(instanceId: string) {
  const quedas = await quedasNaUltimaHora(instanceId)
  if (quedas < config.QUEDAS_POR_HORA_PARA_ALERTAR) return
  const inst = await instanceInfo(instanceId)
  if (!inst) return
  const { rows } = await pool.query(
    `insert into ops_alert_state (key, last_sent_at) values ($1, now())
     on conflict (key) do update set last_sent_at = now()
       where ops_alert_state.last_sent_at < now() - make_interval(mins => 60)
     returning key`,
    [`instavel:${instanceId}`],
  )
  if (!rows[0]) return
  const { segundos } = await resumoDoDia(instanceId)
  await enqueue(inst.accountId, instanceId, 'flapping', await recipientsFor(inst.accountId), flappingEmail(inst.info, quedas, segundos))
}

/** Canal voltou: se havia incidente aberto, avisa que normalizou */
export async function channelUp(instanceId: string) {
  const { rows } = await pool.query<{ opened_at: Date }>('delete from instance_incidents where instance_id = $1 returning opened_at', [instanceId])
  if (!rows[0]) return
  const inst = await instanceInfo(instanceId)
  if (!inst) return
  const minutes = Math.max(1, Math.round((Date.now() - rows[0].opened_at.getTime()) / 60_000))
  await enqueue(inst.accountId, instanceId, 'reconnected', await recipientsFor(inst.accountId), reconnectedEmail(inst.info, minutes))
}

/** Aviso interno da operação, com intervalo mínimo entre avisos iguais */
export async function opsAlert(key: string, title: string, lines: string[], cooldownMinutes = 30) {
  const to = opsRecipients()
  logger.warn({ key, lines }, `alerta de operação: ${title}`)
  if (!to.length) return
  const { rows } = await pool.query(
    `insert into ops_alert_state (key, last_sent_at) values ($1, now())
     on conflict (key) do update set last_sent_at = now()
       where ops_alert_state.last_sent_at < now() - make_interval(mins => $2)
     returning key`,
    [key, cooldownMinutes],
  )
  if (!rows[0]) return
  await enqueue(null, null, 'ops', to, opsEmail(title, lines))
}

// ---------- monitores (rodam no roteador, 1x por minuto) ----------

async function watchUnstable() {
  const { rows } = await pool.query<{ id: string }>(
    `select i.id from instances i
     where i.desired_running and i.status = 'connecting'
       and i.status_changed_at < now() - make_interval(mins => $1)
       and exists (select 1 from auth_creds a where a.instance_id = i.id)
       and not exists (select 1 from instance_incidents x where x.instance_id = i.id)`,
    [config.UNSTABLE_ALERT_MINUTES],
  )
  for (const { id } of rows) {
    // Com dois roteadores rodando, só quem abriu o incidente manda o e-mail
    const opened = await pool.query(`insert into instance_incidents (instance_id, kind) values ($1, 'unstable') on conflict do nothing returning 1`, [id])
    if (!opened.rowCount) continue
    const inst = await instanceInfo(id)
    if (inst) await enqueue(inst.accountId, id, 'unstable', await recipientsFor(inst.accountId), unstableEmail(inst.info, config.UNSTABLE_ALERT_MINUTES))
  }
}

// Leituras seguidas com muitos números fora (uma só pode ser um deploy passando os números)
let fleetDownStreak = 0

async function watchFleet() {
  const { rows } = await pool.query<{ total: number; down: number }>(
    `select count(*)::int as total, count(*) filter (where status <> 'connected')::int as down
     from instances i where desired_running and exists (select 1 from auth_creds a where a.instance_id = i.id)`,
  )
  const { total, down } = rows[0]
  // Muitos números fora ao mesmo tempo = problema geral (servidor, rede ou mudança do WhatsApp)
  fleetDownStreak = total >= 3 && down >= Math.max(3, Math.ceil(total * 0.2)) ? fleetDownStreak + 1 : 0
  if (fleetDownStreak >= 2) {
    await opsAlert('queda-em-massa', 'Muitos números fora do ar ao mesmo tempo', [
      `${down} de ${total} números conectáveis estão fora do ar agora.`,
      'Pode ser queda do servidor, da rede ou mudança do WhatsApp (verificar atualização do Baileys).',
    ])
  }
  const hooks = await pool.query<{ pending: number; oldest_min: number | null }>(
    `select count(*)::int as pending, extract(epoch from now() - min(created_at))::int / 60 as oldest_min
     from webhook_outbox where delivered_at is null and failed_at is null`,
  )
  const h = hooks.rows[0]
  if (h.pending > 500 || (h.oldest_min ?? 0) > 15) {
    await opsAlert('fila-webhooks', 'Webhooks acumulando', [
      `${h.pending} webhooks esperando entrega; o mais antigo há ${h.oldest_min ?? 0} min.`,
      'O sistema que recebe (ex.: CRM) pode estar fora do ar ou lento.',
    ])
  }
}

// ---------- envio da fila ----------

async function dispatchTick() {
  const { rows } = await pool.query<{ id: string; recipients: string[]; subject: string; html: string; attempts: number; created_at: Date }>(
    `with batch as (
       select id from alert_outbox where sent_at is null and failed_at is null and next_attempt_at <= now()
       order by id limit 20 for update skip locked
     )
     update alert_outbox o set next_attempt_at = now() + interval '2 minutes'
     from batch where o.id = batch.id
     returning o.id, o.recipients, o.subject, o.html, o.attempts, o.created_at`,
  )
  for (const r of rows) {
    try {
      await sendEmail(r.recipients, r.subject, r.html)
      await pool.query('update alert_outbox set sent_at = now(), attempts = attempts + 1, last_error = null where id = $1', [r.id])
    } catch (err) {
      const attempts = r.attempts + 1
      const message = (err as Error).message
      // Sem provedor configurado: guarda por até 24 h (se configurar, sai); com provedor, 12 tentativas
      const giveUp = emailConfigured() ? attempts >= 12 : Date.now() - r.created_at.getTime() > 86_400_000
      const delay = emailConfigured() ? Math.min(30 * 2 ** attempts, 3600) : 3600
      await pool.query(
        `update alert_outbox set attempts = $2, last_error = $3,
           failed_at = case when $4 then now() else null end,
           next_attempt_at = now() + make_interval(secs => $5) where id = $1`,
        [r.id, attempts, message.slice(0, 300), giveUp, delay],
      )
      if (attempts === 1) logger.warn({ err: message, subject: r.subject }, 'e-mail de alerta não enviado; vai tentar de novo')
    }
  }
}

export function startAlerts() {
  const timers = [
    setInterval(() => dispatchTick().catch((err) => logger.error({ err }, 'erro enviando alertas')), 15_000),
    setInterval(() => {
      watchUnstable().catch((err) => logger.error({ err }, 'erro no monitor de instabilidade'))
      watchFleet().catch((err) => logger.error({ err }, 'erro no monitor geral'))
    }, 60_000),
  ]
  return () => timers.forEach(clearInterval)
}
