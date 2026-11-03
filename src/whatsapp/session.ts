import type { Boom } from '@hapi/boom'
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadContentFromMessage,
  getAggregateVotesInPollMessage,
  getContentType,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type AuthenticationCreds,
  type ChatModification,
  type ConnectionState,
  type Contact,
  type GroupMetadata,
  type MediaType,
  type WAMessage,
  type WAMessageKey,
  type WAPresence,
  type WASocket,
} from 'baileys'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { channelDown, channelUnstable, channelUp } from '../alerts/alerts.js'
import { quedaComecou, quedaTerminou } from '../alerts/downtime.js'
import { clearAuthState, usePgAuthState } from '../auth/pg-auth-state.js'
import { stillOwner } from '../cluster/leases.js'
import { wapiConnected, wapiDisconnected, wapiMessage, wapiPresence, wapiStatus, type WapiContext } from '../compat/wapi/webhooks.js'
import { decrypt, encrypt } from '../security/crypto.js'
import { extensionFor, mediaUrl, putMedia } from '../storage/media-storage.js'
import { config } from '../config.js'
import { pool } from '../db.js'
import { logger } from '../logger.js'
import { enqueueWebhook } from '../webhooks/outbox.js'
import { MEDIA_TYPES, storeIncomingMedia } from './incoming-media.js'
import { SendError, TARGETS_MESSAGE, loadStoredMessage, sendPayload } from './outgoing.js'
import { PAIRING_CODE_TTL_MS, pairingOnClose } from './pairing.js'
import { decidirHistorico } from './history.js'
import { claimNextJob, completeJob, countSent, createJob, failJob } from './send-queue.js'
import { getWaVersion } from './version.js'

export type InstanceStatus =
  | 'created'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'replaced'
  | 'forbidden'

export class NotConnectedError extends Error {}

export type InstanceSettings = {
  autoRead: boolean
  /** Importar o histórico que o WhatsApp entrega ao conectar (uma vez por número) */
  importHistory: boolean
  ignoreGroups: boolean
  rejectCalls: boolean
  callMessage: string | null
  sendPerMinute: number | null
  sendPerDay: number | null
}
type ProxyConfig = { protocol: 'http' | 'https' | 'socks5'; host: string; port: number; user?: string; pass?: string }

const TERMINAL: InstanceStatus[] = ['disconnected', 'logged_out', 'replaced', 'forbidden']
const PICTURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FROM_API_TTL_MS = 5 * 60 * 1000
// Vigia: de quanto em quanto tempo confere se a conexão "conectada" está viva de verdade
const WATCHDOG_MS = 30_000

const MAX_BACKOFF_MS = 60_000
const JID_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const GROUP_CACHE_TTL_MS = 10 * 60 * 1000
const QUEUE_POLL_MS = 5_000
// Mídia de mensagens mais antigas que isso (histórico) não é baixada
const MEDIA_MAX_AGE_S = 24 * 60 * 60
// Mensagens internas do protocolo que não interessam ao CRM
const IGNORED_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'])

const baileysLogger = logger.child({ module: 'baileys' })
baileysLogger.level = config.BAILEYS_LOG_LEVEL

const toNumber = (t: unknown) =>
  typeof t === 'number' ? t : typeof (t as { toNumber?: () => number })?.toNumber === 'function' ? (t as { toNumber: () => number }).toNumber() : undefined

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Session {
  status: InstanceStatus = 'created'
  qr?: string
  pairingCode?: string
  /** Já pedimos código neste socket? Só cabe um por socket */
  private pairingAsked = false
  /** Derruba o socket quando o código vence, para um código novo entrar no lugar */
  private pairingTimer?: NodeJS.Timeout
  /** Quando a tentativa por código começou: depois de PAIRING_WINDOW_MS desiste */
  private pairingStartedAt = 0
  private sock?: WASocket
  private creds?: AuthenticationCreds
  private stopped = false
  private retries = 0
  private reconnectTimer?: NodeJS.Timeout
  private queueTimer?: NodeJS.Timeout
  private watchdogTimer?: NodeJS.Timeout
  private draining = false
  // Entre o início do start() e o socket existir (lendo sessão no banco): conta como ativa
  private starting = false
  // Quando o WhatsApp disse "sessão trocada" (440). Uma vez só costuma ser a troca
  // de container no deploy; de verdade é quando repete
  private replacedAt: number[] = []
  // Histórico já importado uma vez? O WhatsApp reenvia o pacote a cada conexão
  private historyImported = false
  private historyRunning = false
  private lastSendAt = 0
  private firstConnectedAt?: Date
  private jidCache = new Map<string, { jid: string; at: number }>()
  private groupCache = new Map<string, { meta: GroupMetadata; at: number }>()
  private pictureCache = new Map<string, { url: string | null; at: number }>()
  // IDs de mensagens enviadas pela API (para o webhook dizer fromApi: true)
  private fromApi = new Map<string, number>()
  /** Foto do próprio perfil (mostrada no painel) */
  ownPicture: string | null = null
  settings: InstanceSettings = {
    autoRead: false,
    importHistory: false,
    ignoreGroups: false,
    rejectCalls: false,
    callMessage: null,
    sendPerMinute: null,
    sendPerDay: null,
  }
  private log

  constructor(
    readonly instanceId: string,
    private pairingPhone?: string,
  ) {
    this.log = logger.child({ instanceId })
  }

  /** Tem socket aberto, abrindo ou reconexão agendada */
  get active() {
    return !this.stopped && (this.starting || !!this.sock || !!this.reconnectTimer)
  }

  async start() {
    if (this.pairingPhone && !this.pairingStartedAt) this.pairingStartedAt = Date.now()
    this.starting = true
    try {
      await this.open()
    } finally {
      this.starting = false
    }
  }

  private async open() {
    this.stopped = false
    this.reconnectTimer = undefined
    this.pairingAsked = false
    const { state, saveCreds } = await usePgAuthState(this.instanceId)
    this.creds = state.creds
    const proxy = await this.reloadSettings()
    const agent = proxy ? proxyAgent(proxy) : undefined
    await this.setStatus('connecting')

    const sock = makeWASocket({
      agent,
      fetchAgent: agent,
      version: await getWaVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: (key) => this.loadMessage(key),
      // Sem cache, cada envio para grupo busca os participantes e o WhatsApp limita o número
      cachedGroupMetadata: async (jid) => this.cachedGroup(jid),
    })
    this.sock = sock

    sock.ev.process(async (events) => {
      try {
        if (events['creds.update']) await saveCreds()
        if (events['connection.update']) await this.onConnectionUpdate(sock, events['connection.update'])
        if (events['lid-mapping.update']) await this.onLidMapping(events['lid-mapping.update'])
        if (events['messages.upsert']) await this.onMessagesUpsert(sock, events['messages.upsert'])
        if (events['messages.update']) await this.onMessagesUpdate(events['messages.update'])
        if (events['groups.update']) await this.onGroupsUpdate(events['groups.update'])
        if (events['group-participants.update']) await this.onGroupParticipants(events['group-participants.update'])
        if (events['presence.update']) {
          await enqueueWebhook(this.instanceId, 'presence.update', events['presence.update'])
          await wapiPresence(this.wapiCtx(), events['presence.update'])
        }
        if (events.call) await this.onCalls(sock, events.call)
        if (events['contacts.upsert']) await this.saveContacts(events['contacts.upsert'])
        if (events['contacts.update']) await this.saveContacts(events['contacts.update'])
        if (events['messaging-history.set']) {
          const h = events['messaging-history.set']
          if (h.contacts.length) await this.saveContacts(h.contacts)
          const sobDemanda = h.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND
          await this.onHistory(sock, h.messages ?? [], !!h.isLatest, sobDemanda)
        }
      } catch (err) {
        this.log.error({ err }, 'erro processando eventos')
      }
    })
  }

  /** Desliga sem deslogar (a sessão continua salva e pode ser religada) */
  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.pairingTimer)
    clearInterval(this.queueTimer)
    clearInterval(this.watchdogTimer)
    this.reconnectTimer = undefined
    this.pairingTimer = undefined
    this.queueTimer = undefined
    this.sock?.end(undefined)
    this.sock = undefined
  }

  /** Desliga depois de terminar o envio que estiver no meio (não deixa mensagem pela metade) */
  async stopGracefully(timeoutMs = 10_000) {
    this.stopped = true
    const until = Date.now() + timeoutMs
    while (this.draining && Date.now() < until) await sleep(100)
    this.stop()
  }

  /** Desconecta o aparelho no WhatsApp e apaga a sessão */
  async logout() {
    // stopped antes, para o evento de close gerado pelo logout não disparar reconexão
    this.stopped = true
    try {
      await this.sock?.logout()
    } catch (err) {
      this.log.warn({ err }, 'logout falhou; apagando sessão local mesmo assim')
    }
    this.stop()
    await clearAuthState(this.instanceId)
    this.qr = undefined
    await this.setStatus('logged_out', { desiredRunning: false })
  }

  // ---------- conexão ----------

  private async onConnectionUpdate(sock: WASocket, update: Partial<ConnectionState>) {
    if (sock !== this.sock) return // evento atrasado de um socket antigo
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      this.qr = qr
      // Um código por socket. Pedir outro no mesmo socket gasta as rodadas de QR que o
      // WhatsApp concede: na quarta ele fecha com 408 e a tentativa morre em ~2,5 min
      // (medido em 05/10/2026). Quando o código vence, quem recomeça é o socket, no close
      if (this.pairingPhone && !this.pairingAsked) {
        this.pairingAsked = true
        try {
          this.pairingCode = await sock.requestPairingCode(this.pairingPhone.replace(/\D/g, ''))
          this.log.info('código de pareamento gerado')
          // O WhatsApp invalida o código em cerca de 1 minuto, mas o socket vive mais que
          // isso. Sem derrubar, a tela segue mostrando um código já morto e o celular
          // responde "não foi possível conectar o dispositivo". Derrubando, o close abre
          // socket novo e um código novo aparece sozinho na tela
          clearTimeout(this.pairingTimer)
          this.pairingTimer = setTimeout(() => {
            if (sock !== this.sock || this.status === 'connected') return
            this.log.info('código de pareamento venceu; trocando de socket')
            sock.end(new Error('código de pareamento venceu'))
          }, PAIRING_CODE_TTL_MS)
        } catch (err) {
          this.log.warn({ err }, 'falha ao pedir código de pareamento')
        }
      }
      await this.setStatus('qr', { webhookData: { qr, pairingCode: this.pairingCode } })
    }

    if (connection === 'open') {
      this.retries = 0
      this.qr = undefined
      this.pairingCode = undefined
      this.pairingPhone = undefined
      this.pairingStartedAt = 0
      clearTimeout(this.pairingTimer)
      this.pairingTimer = undefined
      const phone = sock.user?.id ? jidNormalizedUser(sock.user.id).split('@')[0] : null
      await this.setStatus('connected', { phone, connectedAt: true })
      const { rows } = await pool.query<{ first_connected_at: Date }>(
        'update instances set first_connected_at = coalesce(first_connected_at, now()) where id = $1 returning first_connected_at',
        [this.instanceId],
      )
      this.firstConnectedAt = rows[0]?.first_connected_at
      const segundosFora = await quedaTerminou(this.instanceId)
      this.log.info({ phone, ...(segundosFora === undefined ? {} : { segundosFora }) }, 'conectado')
      await wapiConnected(this.wapiCtx())
      await channelUp(this.instanceId)
      if (sock.user?.id) {
        this.ownPicture = await this.pictureOf(sock, jidNormalizedUser(sock.user.id))
        await pool.query('update instances set picture_url = $2 where id = $1', [this.instanceId, this.ownPicture])
      }
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = setInterval(() => this.watchdog(sock), WATCHDOG_MS)
      clearInterval(this.queueTimer)
      this.queueTimer = setInterval(() => this.kickQueue(), QUEUE_POLL_MS)
      this.kickQueue()
    }

    if (connection === 'close') {
      this.sock = undefined
      clearInterval(this.watchdogTimer)
      clearInterval(this.queueTimer)
      this.queueTimer = undefined
      if (this.stopped) return
      // Se outro worker assumiu enquanto este estava travado, sai sem gravar nada nem reconectar
      if (!(await stillOwner(this.instanceId).catch(() => false))) {
        this.log.warn('conexão fechou, mas a instância já é de outro worker; largando')
        this.stop()
        return
      }
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const reason = lastDisconnect?.error?.message
      // Os atributos do nó <failure> do WhatsApp dizem POR QUE ele recusou. Sem eles, um 401
      // de pareamento e um 401 de logout de verdade ficam indistinguíveis no log
      const detalhe = (lastDisconnect?.error as Boom | undefined)?.data
      this.log.info({ code, reason, ...(detalhe ? { detalhe } : {}) }, 'conexão fechada')

      // Pareamento por código ainda em andamento (pairingPhone só é limpo quando conecta).
      // O socket morre de duas formas aqui: 408 quando as rodadas de QR acabam e 401 quando
      // a reconexão usa a credencial pela metade que o requestPairingCode gravou. Nos dois
      // casos a resposta certa é socket novo com código novo, e nunca marcar o número como
      // deslogado pelo celular: não havia sessão nenhuma para o celular desconectar.
      // Fica antes do registro de queda de propósito: número que nunca conectou não "caiu",
      // e cada troca de socket aqui viraria uma piscada falsa no relatório
      if (this.pairingPhone) {
        this.pairingCode = undefined
        // requestPairingCode grava creds.me antes de parear. Sem limpar, o socket novo sobe
        // como se já fosse registrado e o WhatsApp devolve 401 (medido em 05/10/2026)
        await clearAuthState(this.instanceId)
        if (pairingOnClose(this.pairingStartedAt).do === 'novo-codigo') {
          this.retries = 0
          this.scheduleReconnect('gerando um código novo')
          return
        }
        this.stopped = true
        this.pairingPhone = undefined
        this.pairingStartedAt = 0
        await this.setStatus('disconnected', { desiredRunning: false, lastError: 'o código de pareamento expirou' })
        return
      }

      await quedaComecou(this.instanceId, code, reason)
      await channelUnstable(this.instanceId)

      switch (code) {
        case DisconnectReason.loggedOut:
          this.stopped = true
          await clearAuthState(this.instanceId)
          await this.setStatus('logged_out', { desiredRunning: false, lastError: 'desconectado pelo celular' })
          await channelDown(this.instanceId, 'o aparelho foi desconectado pelo celular')
          return
        case DisconnectReason.connectionReplaced: {
          // No deploy, o socket antigo pode ainda estar de pé quando o novo entra, e o
          // WhatsApp devolve "trocada" uma vez (medido em 23/09/2026: voltou em 1s, mas o
          // número ficou marcado como substituído e sem religamento). Só desiste se repetir
          const agora = Date.now()
          this.replacedAt = [...this.replacedAt.filter((t) => agora - t < 120_000), agora]
          if (this.replacedAt.length < 3) {
            this.scheduleReconnect('sessão trocada; tentando voltar')
            return
          }
          this.stopped = true
          await this.setStatus('replaced', { desiredRunning: false, lastError: 'sessão aberta em outro lugar' })
          await channelDown(this.instanceId, 'o número foi aberto em outro lugar (outro computador ou outra API)')
          return
        }
        case DisconnectReason.forbidden:
          this.stopped = true
          await this.setStatus('forbidden', { desiredRunning: false, lastError: 'acesso negado (possível banimento)' })
          await channelDown(this.instanceId, 'o WhatsApp recusou o acesso (possível bloqueio do número)')
          return
        case DisconnectReason.restartRequired:
          // Normal logo depois de ler o QR
          await this.start()
          return
      }

      // 408 é tanto "QR expirou" quanto "conexão perdida". Só é QR expirado se o número nunca pareou
      // (creds.me só existe depois do pareamento; creds.registered fica falso em quem conectou por QR)
      if (!this.creds?.me && code === DisconnectReason.timedOut) {
        // QR expirou sem ninguém ler: não fica gerando QR para sempre
        this.stopped = true
        this.qr = undefined
        await this.setStatus('disconnected', { desiredRunning: false, lastError: 'QR code expirou' })
        return
      }

      this.scheduleReconnect(`${code ?? '?'} ${reason ?? ''}`.trim())
    }
  }

  /**
   * Conexão que diz "conectada" mas o WebSocket já fechou (acontece em queda de rede silenciosa):
   * derruba de propósito para o fluxo normal de reconexão entrar
   */
  private watchdog(sock: WASocket) {
    if (sock !== this.sock || this.status !== 'connected') return
    if (!sock.ws.isOpen) {
      this.log.warn('conexão travada detectada pelo vigia; reconectando')
      sock.end(new Error('vigia: websocket fechado'))
    }
  }

  private scheduleReconnect(lastError: string) {
    this.retries++
    const base = Math.min(1000 * 2 ** this.retries, MAX_BACKOFF_MS)
    const delay = Math.round(base * (0.5 + Math.random()))
    this.log.info({ retries: this.retries, delay }, 'reconectando')
    void this.setStatus('connecting', { lastError })
    this.reconnectTimer = setTimeout(async () => {
      if (!(await stillOwner(this.instanceId).catch(() => false))) {
        this.log.warn('reconexão cancelada: a instância agora é de outro worker')
        this.stop()
        return
      }
      this.start().catch((err) => {
        this.log.error({ err }, 'falha ao reconectar')
        this.scheduleReconnect((err as Error).message)
      })
    }, delay)
  }

  private async setStatus(
    status: InstanceStatus,
    opts: {
      phone?: string | null
      connectedAt?: boolean
      desiredRunning?: boolean
      lastError?: string | null
      webhookData?: Record<string, unknown>
    } = {},
  ) {
    const changed = this.status !== status
    const wasUp = this.status === 'connected' || this.status === 'connecting'
    this.status = status
    if (changed && wasUp && TERMINAL.includes(status)) await wapiDisconnected(this.instanceId)
    await pool.query(
      `update instances set
         status_changed_at = case when status <> $2 then now() else status_changed_at end,
         status = $2,
         phone = coalesce($3, phone),
         connected_at = case when $4 then now() else connected_at end,
         desired_running = coalesce($5, desired_running),
         last_error = case when $2 = 'connected' then null else coalesce($6, last_error) end,
         updated_at = now()
       where id = $1`,
      [this.instanceId, status, opts.phone ?? null, !!opts.connectedAt, opts.desiredRunning ?? null, opts.lastError ?? null],
    )
    if (changed || opts.webhookData) {
      await enqueueWebhook(
        this.instanceId,
        status === 'qr' ? 'qr' : 'connection.update',
        { status, phone: opts.phone, lastError: opts.lastError, ...opts.webhookData },
      )
    }
  }

  // ---------- eventos ----------

  private async onLidMapping(mapping: { lid: string; pn: string }) {
    await pool.query(
      `insert into lid_mappings (instance_id, lid, pn) values ($1, $2, $3)
       on conflict (instance_id, lid) do update set pn = excluded.pn, updated_at = now()`,
      [this.instanceId, jidNormalizedUser(mapping.lid), jidNormalizedUser(mapping.pn)],
    )
  }

  /**
   * Histórico que o WhatsApp entrega quando o número conecta.
   *
   * Ele reenvia esse pacote a CADA conexão (o celular não sabe o que já temos), então
   * a memória de "já importei" é nossa: grava history_imported_at e ignora daí em diante.
   * Sai marcado como histórico para o sistema que recebe não tratar como novidade:
   * nada de reabrir atendimento, tocar celular ou acionar robô por mensagem de semanas atrás.
   * Processa em blocos com pausa, para não travar o worker nem estourar a memória
   */
  /**
   * Pede ao WhatsApp as mensagens ANTERIORES às que já temos de uma conversa.
   *
   * Funciona em número já conectado (diferente do pacote do pareamento). A resposta
   * não vem aqui: chega depois, em outro evento, e entra marcada como histórico.
   * Precisa de uma âncora — a mensagem mais antiga que guardamos daquela conversa —
   * porque o pedido é literalmente "o que veio antes desta"
   */
  async fetchOlderMessages(to: string, count: number) {
    if (!this.sock || this.status !== 'connected') throw new NotConnectedError('instância não está conectada')
    const jid = await this.resolveJid(this.sock, to)
    // A mesma conversa pode estar guardada pelo telefone (@s.whatsapp.net) ou pelo
    // identificador interno do WhatsApp (@lid). Procura a âncora nos dois
    const { rows } = await pool.query<{ id: string; from_me: boolean; participant: string | null; ts: string | null; segundos: string; remote_jid: string }>(
      `with alternativos as (
         select $2::text as jid
         union select lid from lid_mappings where instance_id = $1 and pn = $2
         union select pn from lid_mappings where instance_id = $1 and lid = $2
       )
       select m.id, m.from_me, m.participant, m.ts, extract(epoch from m.created_at)::bigint as segundos, m.remote_jid
         from messages m
        where m.instance_id = $1 and m.remote_jid in (select jid from alternativos)
        order by coalesce(m.ts, extract(epoch from m.created_at)::bigint) asc limit 1`,
      [this.instanceId, jid],
    )
    // Precisa de âncora real: medido em 23/09/2026, um identificador inventado é aceito
    // pelo WhatsApp e simplesmente não devolve nada. Melhor dizer que não dá
    const ancora = rows[0]
    if (!ancora) {
      throw new SendError(
        'message_not_found',
        'não temos nenhuma mensagem dessa conversa para usar como ponto de partida; o WhatsApp só devolve o que veio antes de uma mensagem que já temos',
      )
    }
    const segundos = Number(ancora.ts ?? ancora.segundos)
    // O pedido vai pelo mesmo jid em que a mensagem está guardada, senão o WhatsApp não acha
    const chave = { remoteJid: ancora.remote_jid, id: ancora.id, fromMe: ancora.from_me, participant: ancora.participant ?? undefined }
    await this.sock.fetchMessageHistory(count, chave, segundos * 1000)
    this.log.info({ jid: ancora.remote_jid, count, apartirDe: new Date(segundos * 1000).toISOString() }, 'pedi mensagens antigas ao WhatsApp')
    return { chatId: ancora.remote_jid, requested: count, olderThan: new Date(segundos * 1000).toISOString() }
  }

  private async onHistory(sock: WASocket, messages: WAMessage[], isLatest: boolean, sobDemanda: boolean) {
    this.log.info(
      { mensagens: messages.length, isLatest, sobDemanda, ligado: this.settings.importHistory, jaImportado: this.historyImported },
      'pacote de histórico recebido',
    )
    const decisao = decidirHistorico({
      sobDemanda,
      ligado: this.settings.importHistory,
      jaImportado: this.historyImported,
      isLatest,
      quantidade: messages.length,
    })
    if (!decisao.importar) return
    await this.importarHistorico(sock, messages, { marcarComoImportado: decisao.encerrar })
  }

  private async importarHistorico(sock: WASocket, messages: WAMessage[], opts: { marcarComoImportado: boolean }) {
    if (this.historyRunning) return
    this.historyRunning = true
    const corte = Date.now() / 1000 - config.HISTORY_MAX_DAYS * 86_400
    const porConversa = new Map<string, number>()
    let importadas = 0
    try {
      // Mais novas primeiro: o limite por conversa corta o que é antigo demais, não o recente
      const candidatas = messages
        .filter((m) => m.message && m.key?.remoteJid && m.key.id && (toNumber(m.messageTimestamp) ?? 0) >= corte)
        .sort((a, b) => (toNumber(b.messageTimestamp) ?? 0) - (toNumber(a.messageTimestamp) ?? 0))
      for (const [i, msg] of candidatas.entries()) {
        if (this.stopped) break
        const key = msg.key!
        const jid = key.remoteJid!
        const isGroup = jid.endsWith('@g.us')
        if (jid === 'status@broadcast') continue
        if (isGroup && this.settings.ignoreGroups) continue
        const jaNessaConversa = porConversa.get(jid) ?? 0
        if (jaNessaConversa >= config.HISTORY_MAX_PER_CHAT) continue
        porConversa.set(jid, jaNessaConversa + 1)

        const content = normalizeMessageContent(msg.message!)
        const contentType = getContentType(content)
        if (!content || !contentType || IGNORED_TYPES.has(contentType)) continue

        await this.saveMessage(msg)
        // Sem mídia de propósito: arquivo antigo quase nunca está mais disponível,
        // e baixar milhares de anexos na conexão derrubaria o processo
        await wapiMessage(this.wapiCtx(), msg, {
          isGroup,
          chatPhone: await this.phoneOf(sock, jid, key.remoteJidAlt),
          senderPhone: key.participant ? await this.phoneOf(sock, key.participant, key.participantAlt) : undefined,
          fromApi: false,
          historical: true,
        })
        importadas++
        if (importadas % config.HISTORY_BATCH === 0) await sleep(config.HISTORY_BATCH_PAUSE_MS)
        if (i % 200 === 0) this.log.info({ importadas }, 'importando histórico')
      }
      if (opts.marcarComoImportado && !this.stopped) {
        await pool.query('update instances set history_imported_at = now() where id = $1', [this.instanceId])
        this.historyImported = true
        this.log.info({ importadas, conversas: porConversa.size }, 'histórico importado')
      }
    } catch (err) {
      // Sem marcar como importado: na próxima conexão tenta de novo
      this.log.error({ err, importadas }, 'falha importando histórico')
    } finally {
      this.historyRunning = false
    }
  }

  private async onMessagesUpsert(sock: WASocket, { messages, type }: { messages: WAMessage[]; type: string }) {
    for (const msg of messages) {
      if (!msg.message || !msg.key.remoteJid || !msg.key.id) continue
      await this.saveMessage(msg)

      const content = normalizeMessageContent(msg.message)
      const contentType = getContentType(content)
      if (!content || !contentType || IGNORED_TYPES.has(contentType)) continue

      const { remoteJid, remoteJidAlt, participant, participantAlt, fromMe, id } = msg.key
      const isGroup = remoteJid.endsWith('@g.us')
      if (!fromMe && msg.pushName) await this.rememberPushName(participant ?? remoteJid, msg.pushName)
      if (isGroup && this.settings.ignoreGroups) continue
      if (type === 'notify' && !fromMe && this.settings.autoRead) {
        sock.readMessages([msg.key]).catch((err) => this.log.warn({ err }, 'leitura automática falhou'))
      }
      const timestamp = toNumber(msg.messageTimestamp)
      const inner = (content as Record<string, { contextInfo?: proto.IContextInfo } | undefined>)[contentType]
      const isRecent = !timestamp || Date.now() / 1000 - timestamp < MEDIA_MAX_AGE_S
      // Status (stories) dos contatos: avisa, mas não baixa a mídia
      const isStatus = remoteJid === 'status@broadcast'

      const chatPhone = await this.phoneOf(sock, remoteJid, remoteJidAlt)
      const senderPhone = participant ? await this.phoneOf(sock, participant, participantAlt) : undefined
      if (!isStatus) {
        const lidOf = (a?: string | null, b?: string | null) => [a, b].find((j) => j?.endsWith('@lid')) ?? undefined
        await wapiMessage(this.wapiCtx(), msg, {
          isGroup,
          chatPhone,
          senderPhone,
          senderLid: isGroup ? lidOf(participant, participantAlt) : lidOf(remoteJid, remoteJidAlt),
          fromApi: !!fromMe && this.isFromApi(id!),
          chatPicture: isGroup ? null : await this.pictureOf(sock, remoteJid),
        })
      }
      await enqueueWebhook(this.instanceId, 'messages.upsert', {
        type, // notify = tempo real; append = enviada por outro aparelho / histórico
        id,
        fromMe: !!fromMe,
        chatId: remoteJid,
        isGroup,
        isStatus,
        fromApi: !!fromMe && this.isFromApi(id!),
        chatPhone,
        sender: participant ?? undefined,
        senderPhone,
        pushName: msg.pushName ?? undefined,
        timestamp,
        messageType: contentType,
        text: extractText(content),
        quotedId: inner?.contextInfo?.stanzaId ?? undefined,
        reaction: content.reactionMessage
          ? { messageId: content.reactionMessage.key?.id, emoji: content.reactionMessage.text }
          : undefined,
        media: MEDIA_TYPES.has(contentType) && isRecent && !isStatus
          ? await storeIncomingMedia(sock, this.instanceId, msg, content, contentType)
          : undefined,
        message: msg.message,
      })
    }
  }

  private async onMessagesUpdate(updates: { key: WAMessageKey; update: Partial<WAMessage> }[]) {
    const statuses = updates
      .filter((u) => u.update.status != null)
      .map((u) => ({
        id: u.key.id,
        chatId: u.key.remoteJid,
        fromMe: !!u.key.fromMe,
        status: proto.WebMessageInfo.Status[u.update.status!]?.toLowerCase(),
      }))
    if (statuses.length) await enqueueWebhook(this.instanceId, 'messages.update', statuses)
    for (const u of updates) {
      if (u.update.status != null && u.key.id && u.key.remoteJid) {
        await wapiStatus(this.wapiCtx(), { id: u.key.id, chatId: u.key.remoteJid, fromMe: !!u.key.fromMe, status: u.update.status })
      }
    }

    for (const { key, update } of updates) {
      // Apagada para todos pela outra pessoa
      if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
        await enqueueWebhook(this.instanceId, 'messages.delete', { id: key.id, chatId: key.remoteJid, fromMe: !!key.fromMe })
      }
      // Editada
      const edited = update.message?.editedMessage?.message
      if (edited) {
        await enqueueWebhook(this.instanceId, 'messages.edit', {
          id: key.id,
          chatId: key.remoteJid,
          fromMe: !!key.fromMe,
          text: extractText(normalizeMessageContent(edited) ?? edited),
        })
      }
      // Votos de enquete: o Baileys já descriptografa; somamos com a enquete original
      if (update.pollUpdates?.length && key.id) {
        const poll = await loadStoredMessage(this.instanceId, key.id)
        if (poll?.message) {
          const votes = getAggregateVotesInPollMessage({ message: poll.message, pollUpdates: update.pollUpdates })
          await enqueueWebhook(this.instanceId, 'poll.update', {
            id: key.id,
            chatId: key.remoteJid,
            votes: votes.map((v) => ({ option: v.name, count: v.voters.length, voters: v.voters })),
          })
        }
      }
    }
  }

  private async onGroupsUpdate(updates: Partial<GroupMetadata>[]) {
    for (const u of updates) if (u.id) this.groupCache.delete(u.id)
    await enqueueWebhook(this.instanceId, 'groups.update', updates)
  }

  private async onGroupParticipants(update: { id: string; author: string; participants: unknown[]; action: string }) {
    this.groupCache.delete(update.id)
    await enqueueWebhook(this.instanceId, 'group-participants.update', update)
  }

  private wapiCtx(): WapiContext {
    const me = this.sock?.user
    return {
      instanceId: this.instanceId,
      connectedPhone: me?.id ? jidNormalizedUser(me.id).split('@')[0] : null,
      connectedLid: me?.lid ? jidNormalizedUser(me.lid) : null,
    }
  }

  markFromApi(messageId: string) {
    const now = Date.now()
    this.fromApi.set(messageId, now)
    for (const [id, at] of this.fromApi) if (now - at > FROM_API_TTL_MS) this.fromApi.delete(id)
  }

  private isFromApi(messageId: string) {
    return this.fromApi.has(messageId)
  }

  /** Lê as configurações da instância no banco; devolve o proxy (usado ao conectar) */
  async reloadSettings() {
    const { rows } = await pool.query<{
      auto_read: boolean
      import_history: boolean
      history_imported_at: Date | null
      ignore_groups: boolean
      reject_calls: boolean
      call_message: string | null
      send_per_minute: number | null
      send_per_day: number | null
      proxy: ProxyConfig | null
    }>(
      `select auto_read, import_history, history_imported_at, ignore_groups, reject_calls, call_message,
              send_per_minute, send_per_day, proxy
         from instances where id = $1`,
      [this.instanceId],
    )
    const r = rows[0]
    if (r) {
      this.historyImported = !!r.history_imported_at
      this.settings = {
        autoRead: r.auto_read,
        importHistory: r.import_history,
        ignoreGroups: r.ignore_groups,
        rejectCalls: r.reject_calls,
        callMessage: r.call_message,
        sendPerMinute: r.send_per_minute,
        sendPerDay: r.send_per_day,
      }
    }
    return r?.proxy ?? undefined
  }

  private async onCalls(sock: WASocket, calls: { id: string; from: string; callerPn?: string; isVideo?: boolean; isGroup?: boolean; status: string; date: Date }[]) {
    await enqueueWebhook(
      this.instanceId,
      'call',
      calls.map((c) => ({ id: c.id, from: c.from, callerPhone: c.callerPn, isVideo: !!c.isVideo, isGroup: !!c.isGroup, status: c.status, date: c.date })),
    )
    if (!this.settings.rejectCalls) return
    for (const c of calls) {
      if (c.status !== 'offer') continue
      try {
        await sock.rejectCall(c.id, c.from)
        if (this.settings.callMessage) {
          await createJob(this.instanceId, { to: c.callerPn ?? c.from, type: 'text', text: this.settings.callMessage })
          this.kickQueue()
        }
      } catch (err) {
        this.log.warn({ err }, 'falha ao recusar ligação')
      }
    }
  }

  /** Agenda: guarda o que o WhatsApp sincroniza (nome salvo, nome público, LID/telefone) */
  private async saveContacts(list: Partial<Contact>[]) {
    const rows = list.filter((c) => c.id)
    if (!rows.length) return
    const phoneOf = (c: Partial<Contact>) => {
      const pn = c.phoneNumber ?? (c.id && isPnUser(c.id) ? c.id : undefined)
      return pn ? jidNormalizedUser(pn).split('@')[0] : null
    }
    await pool.query(
      `insert into contacts (instance_id, jid, lid, phone, name, notify, verified_name)
       select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       on conflict (instance_id, jid) do update set
         lid = coalesce(excluded.lid, contacts.lid), phone = coalesce(excluded.phone, contacts.phone),
         name = coalesce(excluded.name, contacts.name), notify = coalesce(excluded.notify, contacts.notify),
         verified_name = coalesce(excluded.verified_name, contacts.verified_name), updated_at = now()`,
      [
        this.instanceId,
        rows.map((c) => jidNormalizedUser(c.id!)),
        rows.map((c) => c.lid ?? (c.id!.endsWith('@lid') ? jidNormalizedUser(c.id!) : null)),
        rows.map(phoneOf),
        rows.map((c) => c.name ?? null),
        rows.map((c) => c.notify ?? null),
        rows.map((c) => c.verifiedName ?? null),
      ],
    )
  }

  private async rememberPushName(jid: string, pushName: string) {
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return
    await this.saveContacts([{ id: jid, notify: pushName }])
  }

  /** Foto de perfil com cache de 24h (usada nos webhooks; nunca trava o evento) */
  private async pictureOf(sock: WASocket, jid: string) {
    const hit = this.pictureCache.get(jid)
    if (hit && Date.now() - hit.at < PICTURE_CACHE_TTL_MS) return hit.url
    let url: string | null = null
    try {
      url = (await Promise.race([sock.profilePictureUrl(jid, 'preview'), sleep(2000).then(() => undefined)])) ?? null
    } catch {
      // sem foto ou privada
    }
    this.pictureCache.set(jid, { url, at: Date.now() })
    return url
  }

  /** Baixa mídia a partir da chave (mediaKey + directPath), como a W-API */
  async downloadByKey(input: { mediaKey: string; directPath: string; url?: string; type: MediaType; mimetype: string }) {
    this.socket()
    const stream = await downloadContentFromMessage(
      { mediaKey: Buffer.from(input.mediaKey, 'base64'), directPath: input.directPath, url: input.url },
      input.type,
    )
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const buffer = Buffer.concat(chunks)
    const key = `${this.instanceId}/${new Date().toISOString().slice(0, 7)}/dl-${Date.now()}.${extensionFor(input.mimetype)}`
    await putMedia(key, buffer, input.mimetype)
    return { url: await mediaUrl(key), size: buffer.length, expiresAt: Date.now() + config.MEDIA_URL_TTL_DAYS * 86_400_000 }
  }

  /** Dados do aparelho conectado */
  async device() {
    const sock = this.socket()
    const me = sock.user!
    const jid = jidNormalizedUser(me.id)
    let about: string | null = null
    try {
      const [r] = (await sock.fetchStatus(jid)) ?? []
      about = (r as { status?: { status?: string } } | undefined)?.status?.status ?? null
    } catch {
      // sem recado
    }
    let isBusiness = false
    try {
      isBusiness = !!(await sock.getBusinessProfile(jid))
    } catch {
      // conta comum
    }
    return {
      phone: jid.split('@')[0],
      jid,
      lid: me.lid ?? null,
      name: me.name ?? me.notify ?? null,
      platform: this.creds?.platform ?? null,
      picture: await this.pictureOf(sock, jid),
      about,
      isBusiness,
    }
  }

  /** Telefone (só dígitos) de um JID que pode vir como número ou como LID */
  private async phoneOf(sock: WASocket, jid?: string | null, alt?: string | null) {
    if (!jid || jid.endsWith('@g.us')) return undefined
    let pn = isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : undefined
    if (!pn) pn = (await sock.signalRepository.lidMapping.getPNForLID(jid)) ?? undefined
    return pn ? jidNormalizedUser(pn).split('@')[0] : undefined
  }

  // ---------- armazenamento de mensagens (para getMessage, citar, reagir) ----------

  private async saveMessage(msg: WAMessage) {
    await pool.query(
      `insert into messages (instance_id, remote_jid, id, from_me, participant, message, ts) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (instance_id, remote_jid, id) do update set message = excluded.message, ts = coalesce(messages.ts, excluded.ts)`,
      [
        this.instanceId,
        msg.key.remoteJid,
        msg.key.id,
        !!msg.key.fromMe,
        msg.key.participant ?? null,
        encrypt(JSON.stringify(msg.message, BufferJSON.replacer)),
        toNumber(msg.messageTimestamp) ?? null,
      ],
    )
  }

  private async loadMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const { rows } = await pool.query<{ message: string }>(
      'select message from messages where instance_id = $1 and remote_jid = $2 and id = $3',
      [this.instanceId, key.remoteJid, key.id],
    )
    return rows[0] ? proto.Message.fromObject(JSON.parse(decrypt(rows[0].message), BufferJSON.reviver)) : undefined
  }

  // ---------- fila de envio ----------

  /** Processa a fila se estiver conectado (chamado ao criar job, ao conectar e a cada 5s) */
  kickQueue() {
    if (this.draining || this.status !== 'connected' || !this.sock) return
    this.draining = true
    this.drain()
      .catch((err) => this.log.error({ err }, 'erro na fila de envio'))
      .finally(() => (this.draining = false))
  }

  private async drain() {
    while (this.status === 'connected' && this.sock && !this.stopped) {
      if (!(await this.withinLimits())) return // o próximo kick (5s) tenta de novo

      // Intervalo mínimo + aleatório entre envios (reduz risco de banimento).
      // Encolhe quando o limite por minuto é alto, para o ritmo médio (base x 1,25) alcançar o limite.
      // Espera antes de pegar o job: se a sessão for desligada nesse meio, nada fica "enviando"
      const base = Math.min(config.SEND_MIN_INTERVAL_MS, 60_000 / this.perMinute() / 1.25)
      const wait = this.lastSendAt + base * (1 + Math.random() * 0.5) - Date.now()
      if (wait > 0) await sleep(wait)
      if (this.stopped || this.status !== 'connected') return
      const job = await claimNextJob(this.instanceId)
      if (!job) return

      const sock = this.sock
      if (!sock) {
        await failJob(job, 'send_error', 'instância desconectou antes do envio', true)
        return
      }
      try {
        const p = job.payload
        let jid: string | undefined
        let extra = {}
        if (p.to === 'status') {
          jid = 'status@broadcast'
          extra = { statusJidList: await this.statusAudience(sock, p.statusRecipients), backgroundColor: p.backgroundColor, font: p.font }
        } else if (!TARGETS_MESSAGE.has(p.type) && p.to) {
          jid = await this.resolveJid(sock, p.to)
        }
        // O ID foi gerado ao enfileirar; marca como "enviada pela API" antes do WhatsApp devolver o evento
        if (job.message_id) this.markFromApi(job.message_id)
        const { sent, jid: target } = await sendPayload(sock, this.instanceId, jid, p, { ...extra, messageId: job.message_id ?? undefined })
        if (sent) await this.saveMessage(sent)
        await completeJob(job, sent?.key.id ?? undefined, target)
      } catch (err) {
        const e = err instanceof SendError ? err : new SendError('send_error', (err as Error).message)
        this.log.warn({ jobId: job.id, code: e.code, err: e.message }, 'envio falhou')
        await failJob(job, e.code, e.message, e.retryable)
      } finally {
        this.lastSendAt = Date.now()
      }
    }
  }

  /** Quem vê o status: a lista informada ou, sem lista, os contatos que conversaram nos últimos dias */
  private async statusAudience(sock: WASocket, recipients?: string[]) {
    let jids: string[]
    if (recipients?.length) {
      jids = []
      for (const r of recipients) {
        try {
          jids.push(await this.resolveJid(sock, r))
        } catch {
          // número sem WhatsApp: ignora
        }
      }
    } else {
      const { rows } = await pool.query<{ remote_jid: string }>(
        `select distinct remote_jid from messages
         where instance_id = $1 and (remote_jid like '%@s.whatsapp.net' or remote_jid like '%@lid')`,
        [this.instanceId],
      )
      jids = rows.map((r) => r.remote_jid)
    }
    if (sock.user?.id) jids.push(jidNormalizedUser(sock.user.id))
    if (jids.length < 2) throw new SendError('invalid_request', 'status sem destinatários: informe statusRecipients')
    return [...new Set(jids)]
  }

  private perMinute() {
    return this.settings.sendPerMinute ?? config.SEND_MAX_PER_MINUTE
  }

  /** Acima do limite a fila só pausa: nada falha, o próximo kick (5s) continua de onde parou */
  private async withinLimits() {
    if ((await countSent(this.instanceId, 60)) >= this.perMinute()) return false
    let daily = this.settings.sendPerDay ?? config.SEND_MAX_PER_DAY
    if (daily === 0) return true
    if (config.SEND_WARMUP_DAYS > 0 && this.firstConnectedAt) {
      const days = (Date.now() - this.firstConnectedAt.getTime()) / 86_400_000
      daily = Math.floor(daily * Math.min(1, 0.2 + (0.8 * days) / config.SEND_WARMUP_DAYS))
    }
    if ((await countSent(this.instanceId, 86_400)) >= daily) {
      this.log.warn({ daily }, 'limite diário de envios atingido')
      return false
    }
    return true
  }

  /**
   * Aceita JID pronto ou telefone. Para telefone, pergunta ao WhatsApp o JID real
   * (resolve o 9º dígito de números brasileiros antigos)
   */
  private async resolveJid(sock: WASocket, to: string) {
    if (to.includes('@')) return to
    const digits = to.replace(/\D/g, '')
    const cached = this.jidCache.get(digits)
    if (cached && Date.now() - cached.at < JID_CACHE_TTL_MS) return cached.jid
    const [result] = (await sock.onWhatsApp(digits)) ?? []
    if (!result?.exists) throw new SendError('not_on_whatsapp', `${digits} não tem WhatsApp`)
    this.jidCache.set(digits, { jid: result.jid, at: Date.now() })
    return result.jid
  }

  // ---------- ações diretas (não passam pela fila) ----------

  /** Socket conectado, para as rotas que chamam o Baileys direto (grupos, perfil, contatos...) */
  socket() {
    if (this.status !== 'connected' || !this.sock) throw new NotConnectedError('instância não está conectada')
    return this.sock
  }

  /** Telefone ou JID -> JID real no WhatsApp */
  async jidFor(to: string) {
    return this.resolveJid(this.socket(), to)
  }

  /** Arquivar, fixar, silenciar, marcar como não lida, limpar, apagar conversa */
  async modifyChat(chatId: string, mod: 'archive' | 'unarchive' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'unread' | 'clear' | 'delete', muteSeconds?: number) {
    const sock = this.socket()
    const { rows } = await pool.query<{ id: string; from_me: boolean; participant: string | null; created_at: Date }>(
      'select id, from_me, participant, created_at from messages where instance_id = $1 and remote_jid = $2 order by created_at desc limit 1',
      [this.instanceId, chatId],
    )
    const last = rows[0]
    const needsLast = ['archive', 'unarchive', 'unread', 'clear', 'delete'].includes(mod)
    if (needsLast && !last) throw new SendError('message_not_found', 'nenhuma mensagem recente guardada dessa conversa; essa ação precisa da última mensagem')
    const lastMessages = last
      ? [{ key: { remoteJid: chatId, id: last.id, fromMe: last.from_me, participant: last.participant ?? undefined }, messageTimestamp: Math.floor(last.created_at.getTime() / 1000) }]
      : []
    const mods: Record<typeof mod, ChatModification> = {
      archive: { archive: true, lastMessages },
      unarchive: { archive: false, lastMessages },
      pin: { pin: true },
      unpin: { pin: false },
      mute: { mute: Date.now() + (muteSeconds ?? 8 * 3600) * 1000 },
      unmute: { mute: null },
      unread: { markRead: false, lastMessages },
      clear: { clear: true, lastMessages },
      delete: { delete: true, lastMessages },
    }
    await sock.chatModify(mods[mod], chatId)
  }

  /** Baixa de novo a mídia de uma mensagem guardada (link expirado, histórico...) */
  async redownloadMedia(messageId: string) {
    const sock = this.socket()
    const msg = await loadStoredMessage(this.instanceId, messageId)
    if (!msg?.message) throw new SendError('message_not_found', 'mensagem não encontrada')
    const content = normalizeMessageContent(msg.message)
    const contentType = getContentType(content)
    if (!content || !contentType || !MEDIA_TYPES.has(contentType)) throw new SendError('invalid_request', 'a mensagem não tem mídia')
    return storeIncomingMedia(sock, this.instanceId, msg, content, contentType)
  }

  async checkNumber(phone: string) {
    const sock = this.socket()
    try {
      return { exists: true, jid: await this.resolveJid(sock, phone) }
    } catch (err) {
      if (err instanceof SendError && err.code === 'not_on_whatsapp') return { exists: false, jid: null }
      throw err
    }
  }

  async profilePicture(to: string) {
    const sock = this.socket()
    const jid = to.includes('@') ? to : await this.resolveJid(sock, to)
    try {
      return { jid, url: (await sock.profilePictureUrl(jid, 'image')) ?? null }
    } catch {
      return { jid, url: null } // sem foto ou foto privada
    }
  }

  async presence(to: string, state: WAPresence) {
    const sock = this.socket()
    const jid = to.includes('@') ? to : await this.resolveJid(sock, to)
    await sock.sendPresenceUpdate(state, jid)
  }

  /** Marca como lidas; sem messageIds, marca as recebidas nos últimos 7 dias desse chat */
  async markRead(chatId: string, messageIds?: string[]) {
    const sock = this.socket()
    const { rows } = await pool.query<{ id: string; participant: string | null }>(
      `select id, participant from messages
       where instance_id = $1 and remote_jid = $2 and not from_me
         and ($3::text[] is null or id = any($3))
       order by created_at desc limit 200`,
      [this.instanceId, chatId, messageIds ?? null],
    )
    if (!rows.length) return 0
    await sock.readMessages(rows.map((r) => ({ remoteJid: chatId, id: r.id, fromMe: false, participant: r.participant ?? undefined })))
    return rows.length
  }

  async listGroups() {
    const sock = this.socket()
    const groups = Object.values(await sock.groupFetchAllParticipating())
    for (const g of groups) this.groupCache.set(g.id, { meta: g, at: Date.now() })
    return groups
  }

  async groupMetadata(jid: string) {
    const sock = this.socket()
    const meta = await sock.groupMetadata(jid)
    this.groupCache.set(jid, { meta, at: Date.now() })
    return meta
  }

  private async cachedGroup(jid: string) {
    const hit = this.groupCache.get(jid)
    if (hit && Date.now() - hit.at < GROUP_CACHE_TTL_MS) return hit.meta
    if (!this.sock) return undefined
    const meta = await this.sock.groupMetadata(jid)
    this.groupCache.set(jid, { meta, at: Date.now() })
    return meta
  }
}

function extractText(content: proto.IMessage) {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.reactionMessage?.text ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    undefined
  )
}

function proxyAgent(p: ProxyConfig) {
  const pass = p.pass ? decrypt(p.pass) : ''
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(pass)}@` : ''
  const url = `${p.protocol}://${auth}${p.host}:${p.port}`
  return p.protocol === 'socks5' ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)
}
