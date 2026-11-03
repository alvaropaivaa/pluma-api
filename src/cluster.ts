// Supervisor de produção: sobe 1 roteador + N workers e reinicia qualquer um que cair.
// Uso: node dist/cluster.js   (WORKERS=0 → um worker por CPU)
import { fork, type ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { opsAlert } from './alerts/alerts.js'
import { logger } from './logger.js'

const entry = fileURLToPath(new URL(`./index${extname(fileURLToPath(import.meta.url))}`, import.meta.url))
const workers = config.WORKERS || availableParallelism()
let stopping = false

type Spec = { name: string; env: Record<string, string>; port: number }
const specs: Spec[] = [
  { name: 'router', env: { ROLE: 'router' }, port: config.PORT },
  ...Array.from({ length: workers }, (_, i) => ({
    name: `worker-${i + 1}`,
    env: {
      ROLE: 'worker',
      WORKER_ID: config.NODE_NAME ? `${config.NODE_NAME}-worker-${i + 1}` : `worker-${i + 1}`,
      INTERNAL_PORT: String(config.INTERNAL_PORT + i),
    },
    port: config.INTERNAL_PORT + i,
  })),
]

const children = new Map<string, ChildProcess>()
// Estado da vigia por processo: quando subiu, falhas seguidas e se já pedimos para reiniciar
const watch = new Map<string, { startedAt: number; failures: number; recycling: boolean }>()

const PROBE_EVERY_MS = 10_000
const PROBE_TIMEOUT_MS = 5_000
const MAX_FAILURES = 3
const STARTUP_GRACE_MS = 60_000

function start(spec: Spec, attempt = 0) {
  const startedAt = Date.now()
  const child = fork(entry, { env: { ...process.env, ...spec.env } })
  children.set(spec.name, child)
  watch.set(spec.name, { startedAt, failures: 0, recycling: false })
  child.on('exit', (code, signal) => {
    children.delete(spec.name)
    if (stopping) return
    // Espera crescente se cair em sequência; zera se ficou de pé mais de 1 minuto
    const next = Date.now() - startedAt > 60_000 ? 0 : attempt + 1
    const delay = Math.min(1000 * 2 ** next, 30_000)
    logger.error({ proc: spec.name, code, signal, delay }, 'processo caiu; reiniciando')
    const motivo = watch.get(spec.name)?.recycling ? 'reiniciado pela vigia (travado ou memória alta)' : `saiu sozinho (código ${code ?? signal})`
    void opsAlert(`processo:${spec.name}`, `Processo ${spec.name} reiniciado`, [`O processo ${spec.name} ${motivo}.`, 'Os números dele voltam sozinhos em segundos.'], 10).catch(() => undefined)
    setTimeout(() => start(spec, next), delay)
  })
}

logger.info({ workers }, 'subindo roteador + workers')
for (const spec of specs) start(spec)

/**
 * Vigia: processo que parou de responder (travado, loop infinito, event loop preso) é derrubado
 * e reiniciado; worker que passou do limite de memória é reiniciado com calma (solta os números antes).
 * Conta só como falha a falta de resposta: um 500 (ex.: banco fora) não adianta reiniciar
 */
async function probe(spec: Spec) {
  const state = watch.get(spec.name)
  const child = children.get(spec.name)
  if (!state || !child || state.recycling || Date.now() - state.startedAt < STARTUP_GRACE_MS) return
  try {
    const res = await fetch(`http://127.0.0.1:${spec.port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    state.failures = 0
    const body = (await res.json().catch(() => null)) as { rssMb?: number } | null
    if (config.MAX_WORKER_MEMORY_MB && spec.env.ROLE === 'worker' && body?.rssMb && body.rssMb > config.MAX_WORKER_MEMORY_MB) {
      logger.warn({ proc: spec.name, rssMb: body.rssMb, limite: config.MAX_WORKER_MEMORY_MB }, 'memória acima do limite; reiniciando com calma')
      state.recycling = true
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 25_000)
    }
  } catch {
    state.failures++
    logger.warn({ proc: spec.name, falhas: state.failures }, 'processo não respondeu à vigia')
    if (state.failures >= MAX_FAILURES) {
      logger.error({ proc: spec.name }, 'processo travado; derrubando para reiniciar')
      state.recycling = true
      child.kill('SIGKILL')
    }
  }
}
setInterval(() => {
  if (!stopping) for (const spec of specs) void probe(spec)
}, PROBE_EVERY_MS)

async function stopAll(signal: NodeJS.Signals) {
  if (stopping) return
  stopping = true
  logger.info('%s recebido; desligando todos os processos', signal)
  const exits = [...children.values()].map((c) => new Promise((r) => c.once('exit', r)))
  for (const c of children.values()) c.kill('SIGTERM')
  // Workers passam os números para o outro container antes de sair (até DRAIN_TIMEOUT_MS)
  await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, config.DRAIN_TIMEOUT_MS + 15_000))])
  process.exit(0)
}
process.on('SIGTERM', () => void stopAll('SIGTERM'))
process.on('SIGINT', () => void stopAll('SIGINT'))
