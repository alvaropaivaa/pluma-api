import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { pool } from '../db.js'
import { HttpError, parse } from './common.js'
import { accountFromSession } from './panel-auth.js'

// Mesmo fuso de src/alerts/downtime.ts: "hoje" é o dia no Brasil, não o dia em UTC
const FUSO = 'America/Sao_Paulo'
// Prazos da limpeza periódica em src/index.ts. Depois disso o dado não existe mais,
// então comparar com um período mais antigo daria uma queda que nunca aconteceu.
const DIAS_GUARDADOS = { envios: 30, webhooks: 7, mensagens: config.MESSAGE_RETENTION_DAYS }

const PERIODOS = {
  today: { dias: 1, grao: 'hour' },
  '7d': { dias: 7, grao: 'day' },
  '30d': { dias: 30, grao: 'day' },
} as const

type Janela = { inicio: Date; agora: Date; inicioAnterior: Date; fimAnterior: Date }

// Trechos fixos deste arquivo (nunca dado do usuário). `quando` é o instante do evento;
// `indexada` é a coluna que usa índice para cortar a busca.
const FONTES = {
  enviadas: { de: 'send_jobs', quando: 't.sent_at', indexada: 't.sent_at', filtro: `t.status = 'sent'`, dias: DIAS_GUARDADOS.envios },
  falhas: { de: 'send_jobs', quando: 't.updated_at', indexada: 't.updated_at', filtro: `t.status = 'failed'`, dias: DIAS_GUARDADOS.envios },
  // O horário do WhatsApp: histórico importado hoje não conta como mensagem recebida hoje
  recebidas: {
    de: 'messages',
    quando: 'coalesce(to_timestamp(t.ts), t.created_at)',
    indexada: 't.created_at',
    filtro: `not t.from_me and t.remote_jid <> 'status@broadcast'`,
    dias: DIAS_GUARDADOS.mensagens,
  },
  webhooksEntregues: { de: 'webhook_outbox', quando: 't.delivered_at', indexada: 't.created_at', filtro: 't.delivered_at is not null', dias: DIAS_GUARDADOS.webhooks },
  webhooksFalhos: { de: 'webhook_outbox', quando: 't.failed_at', indexada: 't.created_at', filtro: 't.failed_at is not null', dias: DIAS_GUARDADOS.webhooks },
} as const

const diasAtras = (d: Date, dias: number) => new Date(d.getTime() - dias * 86_400_000)

/** Total do período e do anterior. `previous` é null quando o anterior já foi limpo; `partial` avisa que o período inteiro não existe mais. */
async function contar(contaId: string, j: Janela, f: (typeof FONTES)[keyof typeof FONTES]) {
  const { rows } = await pool.query<{ atual: number; anterior: number }>(
    // Sem teto em "agora" de propósito: o horário vem do WhatsApp e pode estar uns segundos à frente do nosso relógio
    `select count(*) filter (where ${f.quando} >= $2)::int as atual,
            count(*) filter (where ${f.quando} >= $3 and ${f.quando} < $4)::int as anterior
       from ${f.de} t join instances i on i.id = t.instance_id
      where i.account_id = $1 and ${f.filtro} and ${f.indexada} >= $3`,
    [contaId, j.inicio, j.inicioAnterior, j.fimAnterior],
  )
  const limite = diasAtras(j.agora, f.dias)
  return {
    value: rows[0].atual,
    previous: j.inicioAnterior >= limite ? rows[0].anterior : null,
    partial: j.inicio < limite,
  }
}

export async function dashboardRoutes(app: FastifyInstance) {
  /** Números da tela inicial do painel: sempre calculados do banco, nada de valor de exemplo. */
  app.get('/painel/api/dashboard', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    const { period } = parse(z.object({ period: z.enum(['today', '7d', '30d']).default('30d') }), req.query ?? {})
    const { dias, grao } = PERIODOS[period]

    const { rows: agoraRows } = await pool.query<{ inicio: Date; agora: Date }>(
      `select (date_trunc('day', now() at time zone $1) - make_interval(days => $2)) at time zone $1 as inicio, now() as agora`,
      [FUSO, dias - 1],
    )
    const { inicio, agora } = agoraRows[0]
    // Mesmo trecho do período anterior: hoje às 10h compara com ontem até as 10h, não com o dia inteiro
    const j: Janela = { inicio, agora, inicioAnterior: diasAtras(inicio, dias), fimAnterior: diasAtras(agora, dias) }

    const [sent, failed, received, webhooksOk, webhooksBad, fila, quedas, serie, semanas] = await Promise.all([
      contar(s.account_id, j, FONTES.enviadas),
      contar(s.account_id, j, FONTES.falhas),
      contar(s.account_id, j, FONTES.recebidas),
      contar(s.account_id, j, FONTES.webhooksEntregues),
      contar(s.account_id, j, FONTES.webhooksFalhos),
      pool.query<{ n: number }>(
        `select count(*)::int as n from send_jobs t join instances i on i.id = t.instance_id where i.account_id = $1 and t.status = 'queued'`,
        [s.account_id],
      ),
      // Só o trecho da queda que caiu dentro do período
      pool.query<{ quedas: number; segundos: number }>(
        `select count(*)::int as quedas,
                coalesce(sum(extract(epoch from coalesce(t.ended_at, now()) - greatest(t.started_at, $2))), 0)::int as segundos
           from channel_downtime t join instances i on i.id = t.instance_id
          where i.account_id = $1 and coalesce(t.ended_at, now()) > $2`,
        [s.account_id, inicio],
      ),
      pool.query<{ t: string; sent: number }>(
        `with envios as (
           select date_trunc($3, t.sent_at at time zone $4) as balde, count(*)::int as n
             from send_jobs t join instances i on i.id = t.instance_id
            where i.account_id = $1 and t.status = 'sent' and t.sent_at >= $2
            group by 1
         )
         select to_char(g, 'YYYY-MM-DD"T"HH24:00') as t, coalesce(e.n, 0) as sent
           from generate_series(date_trunc($3, $2::timestamptz at time zone $4), date_trunc($3, now() at time zone $4), ('1 ' || $3)::interval) g
           left join envios e on e.balde = g
          order by g`,
        [s.account_id, inicio, grao, FUSO],
      ),
      // Quatro blocos de 7 dias contados de agora para trás (28 dias cabem nos 30 guardados)
      pool.query<{ idade: number; sent: number; failed: number }>(
        `select floor(extract(epoch from now() - coalesce(t.sent_at, t.updated_at)) / 604800)::int as idade,
                count(*) filter (where t.status = 'sent')::int as sent,
                count(*) filter (where t.status = 'failed')::int as failed
           from send_jobs t join instances i on i.id = t.instance_id
          where i.account_id = $1 and t.status in ('sent', 'failed')
            and coalesce(t.sent_at, t.updated_at) > now() - interval '28 days'
          group by 1`,
        [s.account_id],
      ),
    ])

    const weekly = [3, 2, 1, 0].map((idade) => {
      const r = semanas.rows.find((x) => x.idade === idade)
      return { from: diasAtras(agora, (idade + 1) * 7), to: diasAtras(agora, idade * 7), sent: r?.sent ?? 0, failed: r?.failed ?? 0 }
    })

    return {
      period,
      from: inicio,
      to: agora,
      retention: DIAS_GUARDADOS,
      sent,
      failed,
      received,
      webhooks: { delivered: webhooksOk.value, failed: webhooksBad.value, partial: webhooksOk.partial },
      queued: fila.rows[0].n,
      downtime: { drops: quedas.rows[0].quedas, seconds: quedas.rows[0].segundos },
      series: serie.rows,
      weekly,
    }
  })
}
