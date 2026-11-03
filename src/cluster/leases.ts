import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { config } from '../config.js'
import { pool } from '../db.js'

/**
 * Posse das instâncias entre workers (lease no Postgres).
 * Cada instância conectada tem um dono; o dono renova a posse a cada HEARTBEAT_MS.
 * Se o worker morre, a posse vence em LEASE_TTL_SECONDS e outro worker assume sozinho.
 */

export const HEARTBEAT_MS = 5_000
// Worker sem heartbeat há mais que isso é considerado morto
export const WORKER_DEAD_SECONDS = 20

export const workerId = config.WORKER_ID ?? `${config.ROLE}-${hostname()}-${process.pid}`
export const internalSecret =
  config.INTERNAL_SECRET ?? createHash('sha256').update(`interno:${config.ADMIN_KEY}`).digest('hex')

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()

/** Atraso do event loop (ms, p99 da última janela): se sobe, o processo está sobrecarregado */
export function loopLagMs() {
  const lag = Math.round(loopDelay.percentile(99) / 1e6)
  loopDelay.reset()
  return lag
}

// Worker saindo: passa os números adiante e não recebe novos
let draining = false
// Canal do Postgres avisado quando um número fica sem dono (os outros workers assumem na hora)
export const RELEASED_CHANNEL = 'lease_released'

export async function heartbeat(instances: number, lag: number) {
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
  await pool.query(
    `insert into workers (id, host, port, instances, rss_mb, loop_lag_ms, draining) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set heartbeat_at = now(), host = excluded.host, port = excluded.port, instances = excluded.instances,
       rss_mb = excluded.rss_mb, loop_lag_ms = excluded.loop_lag_ms, draining = excluded.draining`,
    [workerId, config.ADVERTISE_HOST ?? '127.0.0.1', config.INTERNAL_PORT, instances, rss, lag, draining],
  )
}

export async function markDraining(instances: number) {
  draining = true
  await heartbeat(instances, loopLagMs())
}

/** Workers vivos de outros containers/processos que podem receber números (não estão saindo) */
export async function receivingWorkers() {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from workers
     where id <> $1 and not draining and heartbeat_at > now() - make_interval(secs => $2)`,
    [workerId, WORKER_DEAD_SECONDS],
  )
  return rows[0].n
}

/** Solta a posse de várias instâncias e avisa os outros workers para assumirem já */
export async function handOff(instanceIds: string[]) {
  if (!instanceIds.length) return
  await pool.query('delete from instance_leases where worker_id = $1 and instance_id = any($2)', [workerId, instanceIds])
  await pool.query('select pg_notify($1, $2)', [RELEASED_CHANNEL, workerId])
}

/** Das instâncias passadas, quantas ainda estão sem dono (e deveriam ter um) */
export async function stillOrphan(instanceIds: string[]) {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from instances i
     where i.id = any($1) and i.desired_running
       and exists (select 1 from auth_creds a where a.instance_id = i.id)
       and not exists (select 1 from instance_leases l where l.instance_id = i.id and l.expires_at > now())`,
    [instanceIds],
  )
  return rows[0].n
}

export async function unregisterWorker() {
  await pool.query('delete from instance_leases where worker_id = $1', [workerId])
  await pool.query('delete from workers where id = $1', [workerId])
  await pool.query('select pg_notify($1, $2)', [RELEASED_CHANNEL, workerId])
}

/**
 * Tenta ficar com a instância. Consegue se ninguém tem, se o lease venceu ou se já é nossa.
 * Devolve se conseguiu e se tomou de um dono que sumiu (aí há envios "no meio" para resolver)
 */
export async function acquireLease(instanceId: string) {
  const { rows } = await pool.query<{ worker_id: string; took_over: boolean }>(
    `with prev as (select worker_id from instance_leases where instance_id = $1)
     insert into instance_leases (instance_id, worker_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     on conflict (instance_id) do update set worker_id = excluded.worker_id, expires_at = excluded.expires_at, acquired_at = now()
       where instance_leases.worker_id = excluded.worker_id or instance_leases.expires_at < now()
     returning worker_id, coalesce((select worker_id from prev) <> $2, false) as took_over`,
    [instanceId, workerId, config.LEASE_TTL_SECONDS],
  )
  return { ok: rows[0]?.worker_id === workerId, tookOver: !!rows[0]?.took_over }
}

export async function releaseLease(instanceId: string) {
  await pool.query('delete from instance_leases where instance_id = $1 and worker_id = $2', [instanceId, workerId])
}

/** Este worker ainda é o dono válido da instância? */
export async function stillOwner(instanceId: string) {
  const { rows } = await pool.query('select 1 from instance_leases where instance_id = $1 and worker_id = $2 and expires_at > now()', [instanceId, workerId])
  return rows.length > 0
}

/** Autocorreção: garante no banco o status "connected" das sessões conectadas neste worker */
export async function syncConnectedStatus(instanceIds: string[]) {
  if (!instanceIds.length) return
  await pool.query(
    `update instances i set status = 'connected', last_error = null, updated_at = now()
     from instance_leases l
     where i.id = any($1) and l.instance_id = i.id and l.worker_id = $2 and i.status <> 'connected'`,
    [instanceIds, workerId],
  )
}

/** Renova as posses deste worker; devolve as que continuam nossas (as que sumiram foram tomadas) */
export async function renewLeases(instanceIds: string[]) {
  if (!instanceIds.length) return new Set<string>()
  const { rows } = await pool.query<{ instance_id: string }>(
    `update instance_leases set expires_at = now() + make_interval(secs => $3)
     where worker_id = $1 and instance_id = any($2) returning instance_id`,
    [workerId, instanceIds, config.LEASE_TTL_SECONDS],
  )
  return new Set(rows.map((r) => r.instance_id))
}

/** Instâncias cujo lease está no nome deste worker (sobra de antes de um restart) */
export async function leasedToMe() {
  const { rows } = await pool.query<{ instance_id: string }>('select instance_id from instance_leases where worker_id = $1', [workerId])
  return rows.map((r) => r.instance_id)
}

/**
 * Quantas instâncias este worker deveria segurar: divisão igual entre os workers vivos.
 *
 * Com uma ressalva: worker sobrecarregado (atraso alto ou memória alta) devolve 0,
 * ou seja, para de PEGAR número novo enquanto não melhorar. Ele nunca solta o que já
 * tem — quem chama compara este número com o que já segura e só age quando sobra vaga
 * (`room > 0`). E só recua se houver outro worker folgado para assumir no lugar dele:
 * com todos ocupados, a divisão volta ao normal para nenhum número ficar sem dono.
 */
export async function fairShare() {
  const { rows } = await pool.query<{ alive: number; wanted: number; eu_ocupado: boolean; outros_folgados: number }>(
    `select (select count(*)::int from workers where not draining and heartbeat_at > now() - make_interval(secs => $1)) as alive,
            (select count(*)::int from instances where desired_running) as wanted,
            coalesce((select (loop_lag_ms > $3 or ($4 > 0 and rss_mb > $4)) from workers where id = $2), false) as eu_ocupado,
            (select count(*)::int from workers
              where id <> $2 and not draining and heartbeat_at > now() - make_interval(secs => $1)
                and loop_lag_ms <= $3 and ($4 = 0 or rss_mb <= $4)) as outros_folgados`,
    [WORKER_DEAD_SECONDS, workerId, config.WORKER_BUSY_LAG_MS, config.WORKER_BUSY_RSS_MB],
  )
  const { alive, wanted, eu_ocupado, outros_folgados } = rows[0]
  if (eu_ocupado && outros_folgados > 0) return 0
  return Math.ceil(wanted / Math.max(1, alive))
}

/** Instâncias que deveriam estar ligadas e não têm dono vivo */
export async function orphanInstances(limit: number) {
  const { rows } = await pool.query<{ id: string }>(
    `select i.id from instances i
     left join instance_leases l on l.instance_id = i.id and l.expires_at > now()
     where i.desired_running and l.instance_id is null
       and exists (select 1 from auth_creds a where a.instance_id = i.id)
     order by random() limit $1`,
    [limit],
  )
  return rows.map((r) => r.id)
}

/** Worker dono da instância (para o roteador repassar a chamada) */
export async function ownerOf(instanceId: string) {
  const { rows } = await pool.query<{ id: string; host: string; port: number }>(
    `select w.id, w.host, w.port from instance_leases l join workers w on w.id = l.worker_id
     where l.instance_id = $1 and l.expires_at > now() and w.heartbeat_at > now() - make_interval(secs => $2)`,
    [instanceId, WORKER_DEAD_SECONDS],
  )
  return rows[0]
}

/**
 * Worker vivo mais folgado, para ligar uma instância nova.
 *
 * Conta não é só quantidade: um worker com cinco números pesados sofre mais que outro
 * com seis leves. Então quem está ocupado (atraso ou memória alta) vai para o fim da
 * fila, e só é escolhido se não houver mais ninguém — número novo sem dono seria pior.
 */
export async function leastLoadedWorker() {
  const { rows } = await pool.query<{ id: string; host: string; port: number }>(
    `select id, host, port from workers
      where not draining and heartbeat_at > now() - make_interval(secs => $1)
      order by (loop_lag_ms > $2 or ($3 > 0 and rss_mb > $3)), instances, random()
      limit 1`,
    [WORKER_DEAD_SECONDS, config.WORKER_BUSY_LAG_MS, config.WORKER_BUSY_RSS_MB],
  )
  return rows[0]
}

export async function clusterStatus() {
  const { rows } = await pool.query(
    `select id, instances, rss_mb, loop_lag_ms, draining, extract(epoch from now() - heartbeat_at)::int as seconds_since_heartbeat
     from workers order by id`,
  )
  return rows
}
