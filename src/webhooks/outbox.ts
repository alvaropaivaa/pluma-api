import pg from 'pg'
import { createHmac } from 'node:crypto'
import { pool } from '../db.js'
import { logger } from '../logger.js'
import { safeFetch } from '../net/safe-fetch.js'
import { decrypt, encrypt } from '../security/crypto.js'

import { config } from '../config.js'

// Tentativas antes de desistir; a espera dobra até 10 min (40 tentativas ≈ 5 h de janela)
const MAX_ATTEMPTS = config.WEBHOOK_MAX_ATTEMPTS
const MAX_DELAY_SECONDS = 600
const BATCH = 50
const LEASE_SECONDS = 60
const TIMEOUT_MS = 10_000

// Só grava se a instância tem webhook e assina o evento (lista vazia = todos)
export async function enqueueWebhook(instanceId: string, event: string, data: unknown) {
  await pool.query(
    `insert into webhook_outbox (instance_id, event, payload)
     select id, $2, $3 from instances
     where id = $1 and webhook_url is not null
       and (cardinality(webhook_events) = 0 or $2 = any(webhook_events))`,
    [instanceId, event, encrypt(JSON.stringify({ event, instanceId, data, timestamp: new Date().toISOString() }))],
  )
  await acordarEntregador()
}

/**
 * Webhook no formato W-API: vai para a URL configurada para aquele tipo de evento
 * (received, delivery, connected, disconnected, status, presence). Sem URL, não grava nada
 */
/**
 * Enfileira um webhook no formato W-API, no endereço cadastrado para aquele tipo de evento.
 *
 * `fallbackToAny`: avisos de canal caiu/voltou vão por qualquer endereço cadastrado quando
 * o tipo 'disconnected' não tiver um só para ele. Sem isso, um sistema que só cadastrou
 * "mensagem recebida" (o caso do CRM) nunca fica sabendo que o número caiu e segue
 * mostrando "conectado" - foi o que aconteceu em 23/09/2026 com um número em atendimento
 */
export async function enqueueWapiWebhook(
  instanceId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { fallbackToAny?: boolean } = {},
) {
  await pool.query(
    `insert into webhook_outbox (instance_id, event, payload, target_url)
     select id, $3, $4,
       coalesce(
         nullif(wapi_webhooks->>$2, ''),
         case when $5 then (select value from jsonb_each_text(wapi_webhooks) order by key limit 1) end
       )
     from instances
     where id = $1
       and coalesce(
         nullif(wapi_webhooks->>$2, ''),
         case when $5 then (select value from jsonb_each_text(wapi_webhooks) order by key limit 1) end
       ) is not null`,
    [instanceId, kind, payload.event, encrypt(JSON.stringify(payload)), opts.fallbackToAny ?? false],
  )
  await acordarEntregador()
}

/** Acorda quem entrega os webhooks, em vez de esperar a próxima ronda */
export const WEBHOOK_CHANNEL = 'webhook_pendente'
const acordarEntregador = () => pool.query('select pg_notify($1, $2)', [WEBHOOK_CHANNEL, '']).catch(() => undefined)

type Row = { id: string; event: string; payload: string; attempts: number; webhook_url: string; webhook_secret: string }

async function deliver(row: Row) {
  const body = decrypt(row.payload)
  const signature = createHmac('sha256', decrypt(row.webhook_secret)).update(body).digest('hex')
  const started = Date.now()
  try {
    const res = await safeFetch(row.webhook_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-id': row.id,
        'x-webhook-event': row.event,
        'x-webhook-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    await pool.query('update webhook_outbox set response_status = $2, duration_ms = $3 where id = $1', [row.id, res.status, Date.now() - started])
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await pool.query('update webhook_outbox set delivered_at = now(), attempts = attempts + 1 where id = $1', [row.id])
  } catch (err) {
    const attempts = row.attempts + 1
    const message = (err as Error).message
    if (attempts >= MAX_ATTEMPTS) {
      await pool.query(
        'update webhook_outbox set attempts = $2, failed_at = now(), last_error = $3 where id = $1',
        [row.id, attempts, message],
      )
      logger.warn({ id: row.id, event: row.event }, 'webhook desistido após %d tentativas', attempts)
    } else {
      // 2s, 4s, 8s... até 10 min
      const delay = Math.min(2 ** attempts, MAX_DELAY_SECONDS)
      await pool.query(
        `update webhook_outbox set attempts = $2, last_error = $3,
           next_attempt_at = now() + make_interval(secs => $4) where id = $1`,
        [row.id, attempts, message, delay],
      )
    }
  }
}

/** Host do destino, para contar quantas entregas simultâneas cada um está recebendo */
export const destinoDe = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Reserva até `quantos` avisos (lease de 60s) e devolve os que têm para onde ir.
 *
 * `lotados` são os destinos que já estão no limite de entregas simultâneas: eles ficam
 * de fora da reserva, então um destino ocupado não rouba a vaga de outro nem é
 * reservado para esperar na memória. Entregar mais rápido do que o destino aguenta
 * não acelera nada — só move a fila para o lado dele.
 */
export async function reservarLote(quantos: number, lotados: string[] = []) {
  if (quantos < 1) return []
  const forasteiros = lotados.map((host) => `%//${host}/%`)
  const { rows } = await pool.query<Row>(
    `with batch as (
       select o.id from webhook_outbox o
       join instances i on i.id = o.instance_id
       where o.delivered_at is null and o.failed_at is null and o.next_attempt_at <= now()
         and ($3::text[] = '{}' or coalesce(o.target_url, i.webhook_url, '') || '/' not like any ($3))
       order by o.id limit $1 for update skip locked
     )
     update webhook_outbox o set next_attempt_at = now() + make_interval(secs => $2)
     from batch, instances i
     where o.id = batch.id and i.id = o.instance_id
     returning o.id, o.event, o.payload, o.attempts, coalesce(o.target_url, i.webhook_url) as webhook_url, i.webhook_secret`,
    [Math.min(quantos, BATCH), LEASE_SECONDS, forasteiros],
  )
  // Webhook removido depois de enfileirar: descarta
  const orphaned = rows.filter((r) => !r.webhook_url).map((r) => r.id)
  if (orphaned.length) {
    await pool.query(
      `update webhook_outbox set failed_at = now(), last_error = 'webhook removido' where id = any($1)`,
      [orphaned],
    )
  }
  return rows.filter((r) => r.webhook_url)
}

/**
 * Entrega os webhooks. Em vez de só rodar de segundo em segundo, acorda na hora em que
 * um aviso é enfileirado (pg_notify): é o que tira o segundo de espera que a mensagem
 * pegava à toa quando a fila estava vazia. A ronda de 1s continua como rede de segurança
 * (avisos de outro processo, tentativas remarcadas, notificação perdida)
 */
export function startWebhookDispatcher() {
  let stopped = false
  let acordar: (() => void) | undefined
  const esperar = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        acordar = undefined
        resolve()
      }, ms)
      acordar = () => {
        clearTimeout(t)
        acordar = undefined
        resolve()
      }
    })

  const ouvir = async () => {
    if (stopped) return
    const client = new pg.Client({ connectionString: config.DATABASE_URL })
    const reconectar = () => {
      client.end().catch(() => undefined)
      if (!stopped) setTimeout(() => void ouvir(), 5_000)
    }
    client.on('error', reconectar)
    client.on('end', reconectar)
    client.on('notification', () => acordar?.())
    try {
      await client.connect()
      await client.query(`listen ${WEBHOOK_CHANNEL}`)
    } catch (err) {
      logger.warn({ err }, 'sem aviso imediato de webhook; seguindo pela ronda de 1s')
      reconectar()
    }
  }

  const loop = async () => {
    // Entrega contínua: mantém um número fixo de avisos em voo e puxa o próximo assim
    // que uma vaga abre. Antes o laço esperava o lote inteiro terminar, então um destino
    // lento segurava quem chegou atrás — inclusive de outro cliente, inclusive já pronto.
    // Em 28/09/2026 isso respondia por ~0,6s do p90 de entrega, com o CRM em 61ms de mediana.
    let emVoo = 0
    const porDestino = new Map<string, number>()
    const lotados = () =>
      [...porDestino].filter(([, n]) => n >= config.WEBHOOK_EM_VOO_POR_DESTINO).map(([host]) => host)
    while (!stopped) {
      let pegou = 0
      try {
        const lote = await reservarLote(config.WEBHOOK_EM_VOO - emVoo, lotados())
        pegou = lote.length
        for (const row of lote) {
          const destino = destinoDe(row.webhook_url)
          emVoo++
          porDestino.set(destino, (porDestino.get(destino) ?? 0) + 1)
          void deliver(row)
            .catch((err) => logger.error({ err }, 'erro ao entregar webhook'))
            .finally(() => {
              emVoo--
              const n = (porDestino.get(destino) ?? 1) - 1
              if (n > 0) porDestino.set(destino, n)
              else porDestino.delete(destino)
              acordar?.() // vaga aberta: não espera o segundo da ronda
            })
        }
      } catch (err) {
        logger.error({ err }, 'erro no despacho de webhooks')
      }
      // Sem nada para pegar (ou lotado), dorme até o pg_notify, uma vaga abrir, ou 1s
      if (pegou === 0 || emVoo >= config.WEBHOOK_EM_VOO) await esperar(1000)
    }
  }
  void ouvir()
  void loop()
  return () => {
    stopped = true
    acordar?.()
  }
}
