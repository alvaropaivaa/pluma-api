import pg from 'pg'
import { clearAuthState } from '../auth/pg-auth-state.js'
import {
  HEARTBEAT_MS,
  RELEASED_CHANNEL,
  acquireLease,
  fairShare,
  handOff,
  heartbeat,
  leasedToMe,
  loopLagMs,
  markDraining,
  orphanInstances,
  receivingWorkers,
  releaseLease,
  renewLeases,
  stillOrphan,
  syncConnectedStatus,
  unregisterWorker,
  workerId,
} from '../cluster/leases.js'
import { wapiDisconnected } from '../compat/wapi/webhooks.js'
import { config } from '../config.js'
import { pool } from '../db.js'
import { logger } from '../logger.js'
import { failInterruptedJobs } from './send-queue.js'
import { Session } from './session.js'

// Quantas instâncias um worker assume por ciclo (evita reconectar dezenas de números no mesmo segundo)
const CLAIM_PER_TICK = 20
const CLAIM_STAGGER_MS = 150
// Deploy: quantos números passam por vez para o outro container, e quanto esperar ele assumir
const HANDOFF_BATCH = 10
const HANDOFF_WAIT_MS = 8_000
const HANDOFF_SETTLE_MS = 700

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class OwnedElsewhereError extends Error {}

/**
 * Sessões deste processo. Cada instância só roda em um worker por vez (lease no banco):
 * conectar pega a posse; desligar solta; se o worker morre, outro assume sozinho.
 */
class InstanceManager {
  private sessions = new Map<string, Session>()
  private loop?: NodeJS.Timeout
  private ticking = false
  private tickAgain = false
  private listener?: pg.Client
  private leaving = false

  get(instanceId: string) {
    return this.sessions.get(instanceId)
  }

  get size() {
    return this.sessions.size
  }

  async connect(instanceId: string, pairingPhone?: string) {
    const existing = this.sessions.get(instanceId)
    if (existing?.active) return existing
    const lease = await acquireLease(instanceId)
    if (!lease.ok) throw new OwnedElsewhereError('instância já está ligada em outro worker')
    // Tomou de um worker que morreu: envios que ficaram "no meio" viram falha (não duplica mensagem)
    if (lease.tookOver) await failInterruptedJobs(instanceId)
    const session = new Session(instanceId, pairingPhone)
    this.sessions.set(instanceId, session)
    await pool.query('update instances set desired_running = true, last_error = null where id = $1', [instanceId])
    try {
      await session.start()
    } catch (err) {
      this.sessions.delete(instanceId)
      await releaseLease(instanceId)
      throw err
    }
    return session
  }

  async disconnect(instanceId: string) {
    const wasConnected = this.sessions.get(instanceId)?.status === 'connected'
    this.sessions.get(instanceId)?.stop()
    this.sessions.delete(instanceId)
    await releaseLease(instanceId)
    if (wasConnected) await wapiDisconnected(instanceId)
    await pool.query(
      `update instances set desired_running = false, status = 'disconnected', updated_at = now() where id = $1`,
      [instanceId],
    )
  }

  async restart(instanceId: string) {
    this.sessions.get(instanceId)?.stop()
    this.sessions.delete(instanceId)
    return this.connect(instanceId)
  }

  async logout(instanceId: string) {
    const session = this.sessions.get(instanceId)
    this.sessions.delete(instanceId)
    if (session) {
      // logout() marca logged_out, que já dispara o webhookDisconnected
      await session.logout()
    } else {
      await clearAuthState(instanceId)
      await pool.query(
        `update instances set desired_running = false, status = 'logged_out', updated_at = now() where id = $1`,
        [instanceId],
      )
    }
    await releaseLease(instanceId)
  }

  async remove(instanceId: string) {
    await this.logout(instanceId)
    await pool.query('delete from instances where id = $1', [instanceId])
  }

  /** Sessão que terminou sozinha (deslogada, banida...): libera a posse */
  async onSessionEnded(instanceId: string) {
    if (this.sessions.get(instanceId)?.active) return
    this.sessions.delete(instanceId)
    await releaseLease(instanceId)
  }

  /** Liga o ciclo do worker e a escuta de números sem dono */
  startLoop() {
    // Worker reiniciado pelo supervisor volta com o mesmo nome: retoma na hora o que já era dele,
    // sem esperar o lease vencer. Envios que estavam "no meio" viram falha (não duplica)
    void (async () => {
      try {
        for (const id of await leasedToMe()) {
          await failInterruptedJobs(id)
          this.connect(id).catch((err) => logger.error({ err, instanceId: id }, 'falha ao retomar instância'))
          await new Promise((r) => setTimeout(r, CLAIM_STAGGER_MS))
        }
      } catch (err) {
        logger.error({ err }, 'falha ao retomar instâncias')
      }
    })()
    void this.tick()
    this.loop = setInterval(() => void this.tick(), HEARTBEAT_MS)
    void this.listen()
  }

  /** Aviso do Postgres: algum número ficou sem dono (deploy ou worker saindo). Assume na hora */
  private async listen() {
    if (this.leaving) return
    const client = new pg.Client({ connectionString: config.DATABASE_URL })
    const retry = () => {
      if (this.listener !== client) return
      this.listener = undefined
      client.end().catch(() => undefined)
      setTimeout(() => void this.listen(), 5_000)
    }
    this.listener = client
    client.on('error', retry)
    client.on('end', retry)
    client.on('notification', (n) => {
      if (n.payload !== workerId) void this.tick()
    })
    try {
      await client.connect()
      await client.query(`listen ${RELEASED_CHANNEL}`)
    } catch (err) {
      logger.warn({ err }, 'não consegui escutar avisos de números sem dono; sigo pelo ciclo normal')
      retry()
    }
  }

  /**
   * Ciclo do worker: heartbeat, renova posses, larga o que foi tomado e assume
   * instâncias órfãs até a sua parte justa
   */
  private async tick() {
    if (this.leaving) return
    if (this.ticking) {
      this.tickAgain = true
      return
    }
    this.ticking = true
    try {
      await heartbeat(this.sessions.size, loopLagMs())

      const mine = [...this.sessions.keys()]
      const kept = await renewLeases(mine)
      for (const id of mine) {
        if (kept.has(id)) continue
        // Outro worker assumiu (ex.: este ficou travado): larga sem mexer no banco
        logger.warn({ instanceId: id }, 'posse perdida para outro worker; largando a sessão')
        this.sessions.get(id)?.stop()
        this.sessions.delete(id)
      }
      for (const [id, s] of this.sessions) if (!s.active) await this.onSessionEnded(id)
      await syncConnectedStatus([...this.sessions].filter(([, s]) => s.status === 'connected').map(([id]) => id))

      const room = (await fairShare()) - this.sessions.size
      if (room > 0) {
        for (const id of await orphanInstances(Math.min(room, CLAIM_PER_TICK))) {
          if (this.leaving) break
          this.connect(id).catch((err) => {
            if (!(err instanceof OwnedElsewhereError)) logger.error({ err, instanceId: id }, 'falha ao assumir instância')
          })
          await sleep(CLAIM_STAGGER_MS)
        }
      }
    } catch (err) {
      logger.error({ err }, 'erro no ciclo do worker')
    } finally {
      this.ticking = false
      if (this.tickAgain) {
        this.tickAgain = false
        void this.tick()
      }
    }
  }


  /** Arruma status que ficaram velhos (processo que caiu sem avisar) */
  async fixStaleStatuses() {
    await pool.query(
      `update instances set desired_running = false, status = 'disconnected'
       where desired_running and not exists (select 1 from auth_creds a where a.instance_id = instances.id)`,
    )
    await pool.query(
      `update instances set status = 'disconnected'
       where not desired_running and status in ('connecting', 'qr', 'connected')`,
    )
  }

  /**
   * Deploy sem queda: passa os números, em lotes, para workers de outro container.
   * Cada número fica fora só o tempo de reconectar lá (1 a 3 s); a sessão continua salva,
   * ninguém precisa ler QR de novo, e o que chegar nesse meio o WhatsApp entrega na reconexão.
   * Sem ninguém para receber (um container só), não faz nada: o shutdown desliga tudo como antes
   */
  async handOffAll() {
    this.leaving = true
    clearInterval(this.loop)
    const listener = this.listener
    this.listener = undefined
    await listener?.end().catch(() => undefined)
    await markDraining(this.sessions.size)
    // Dá tempo dos workers irmãos (que também estão saindo) se marcarem, para não receberem nada
    await sleep(1_500)
    if (!(await receivingWorkers())) return

    // Enquanto passa os números, continua renovando os que ainda estão aqui
    const keepAlive = setInterval(() => {
      void heartbeat(this.sessions.size, loopLagMs()).catch(() => undefined)
      void renewLeases([...this.sessions.keys()]).catch(() => undefined)
    }, HEARTBEAT_MS)
    const deadline = Date.now() + config.DRAIN_TIMEOUT_MS - 10_000
    const ids = [...this.sessions.keys()]
    logger.info({ instances: ids.length }, 'passando os números para o outro container')
    try {
      for (let i = 0; i < ids.length && Date.now() < deadline; i += HANDOFF_BATCH) {
        const batch = ids.slice(i, i + HANDOFF_BATCH)
        await Promise.all(batch.map((id) => this.sessions.get(id)?.stopGracefully()))
        for (const id of batch) this.sessions.delete(id)
        // Um respiro para o WhatsApp registrar que o socket daqui fechou: sem ele, o
        // outro container entra com a conexão antiga ainda de pé e leva um "trocada" (440)
        await sleep(HANDOFF_SETTLE_MS)
        await handOff(batch)
        // Espera o outro lado assumir antes do próximo lote (não desliga todos de uma vez)
        const until = Math.min(Date.now() + HANDOFF_WAIT_MS, deadline)
        while (Date.now() < until && (await stillOrphan(batch)) > 0) await sleep(250)
      }
    } catch (err) {
      logger.error({ err }, 'falha passando os números; o restante sai no desligamento normal')
    } finally {
      clearInterval(keepAlive)
    }
    logger.info({ restantes: this.sessions.size }, 'passagem concluída')
  }

  /** Desliga tudo sem mudar desired_running e solta as posses, para outro worker assumir na hora */
  async shutdown() {
    this.leaving = true
    clearInterval(this.loop)
    await this.listener?.end().catch(() => undefined)
    this.listener = undefined
    await Promise.all([...this.sessions.values()].map((s) => s.stopGracefully(3_000)))
    this.sessions.clear()
    await unregisterWorker().catch(() => undefined)
  }
}

export const manager = new InstanceManager()
