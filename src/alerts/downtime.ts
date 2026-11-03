import { pool } from '../db.js'

/**
 * Registro de quedas com começo e fim. Existe para responder, com número,
 * "quanto tempo esse WhatsApp ficou fora hoje?" — a pergunta que em 25/09/2026
 * só deu para responder garimpando log, porque instance_incidents apaga a linha
 * quando o número volta.
 */

/** Marca o começo de uma queda. Se já houver uma aberta, mantém a primeira. */
export async function quedaComecou(instanceId: string, code?: number, reason?: string) {
  await pool.query(
    `insert into channel_downtime (instance_id, code, reason) values ($1, $2, $3)
     on conflict (instance_id) where ended_at is null do nothing`,
    [instanceId, code ?? null, reason ?? null],
  )
}

/** Fecha a queda aberta e devolve quantos segundos durou (ou undefined se não havia queda). */
export async function quedaTerminou(instanceId: string) {
  const { rows } = await pool.query<{ seconds: number }>(
    `update channel_downtime set ended_at = now(), seconds = greatest(0, extract(epoch from now() - started_at)::int)
      where instance_id = $1 and ended_at is null
      returning seconds`,
    [instanceId],
  )
  return rows[0]?.seconds
}

/** Quantas quedas este número teve na última hora — base do alerta de instabilidade. */
export async function quedasNaUltimaHora(instanceId: string) {
  const { rows } = await pool.query<{ total: number }>(
    `select count(*)::int as total from channel_downtime
      where instance_id = $1 and started_at > now() - interval '1 hour'`,
    [instanceId],
  )
  return rows[0]?.total ?? 0
}

/** Resumo do dia por número: quantas quedas e quantos segundos fora. */
export async function resumoDoDia(instanceId: string) {
  const { rows } = await pool.query<{ quedas: number; segundos: number }>(
    `select count(*)::int as quedas, coalesce(sum(coalesce(seconds, extract(epoch from now() - started_at)::int)), 0)::int as segundos
       from channel_downtime
      where instance_id = $1 and started_at > date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'`,
    [instanceId],
  )
  return rows[0] ?? { quedas: 0, segundos: 0 }
}
