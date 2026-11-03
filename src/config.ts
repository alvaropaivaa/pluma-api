import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  // URL pública da API (usada nos links de mídia quando o storage é local)
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  // Atrás de proxy (Caddy): usa o IP real do cliente (X-Forwarded-For) no freio de login e nos logs
  TRUST_PROXY: z.stringbool().default(false),
  ADMIN_KEY: z.string().min(24, 'ADMIN_KEY precisa ter pelo menos 24 caracteres'),
  // Chave de criptografia dos dados no banco (64 hex). Obrigatória em produção.
  // Gere com: openssl rand -hex 32. Perder essa chave = perder as sessões salvas
  DATA_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'DATA_KEY precisa ter 64 caracteres hexadecimais').optional(),
  // Rota POST /accounts (criar conta pela web). Desligada por padrão: contas se criam pelo terminal
  ADMIN_API_ENABLED: z.stringbool().default(false),
  // Limite de requisições por minuto por credencial (ou por IP, sem credencial)
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(1200),
  // Worker que passar disso (MB) é reiniciado com calma, passando os números para os outros. 0 = sem limite
  MAX_WORKER_MEMORY_MB: z.coerce.number().int().min(0).default(0),

  // Alertas por e-mail. Provedor: Resend (RESEND_API_KEY) ou SMTP (SMTP_URL, ex.: smtps://usuario:senha@smtp.gmail.com:465)
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  // Remetente, ex.: API Roxa <alertas@seudominio.com.br>. O domínio precisa estar autorizado no provedor. Sem remetente, nenhum e-mail sai
  ALERT_FROM: z.string().optional(),
  // Alertas internos da operação (processo reiniciado, memória, fila acumulando, queda em massa)
  OPS_ALERT_EMAILS: z.string().default(''),
  // Minutos tentando reconectar sem sucesso até avisar que o canal está instável
  // Worker sobrecarregado para de PEGAR número novo (nunca solta o que já tem).
  // Em 28/09/2026 um worker ficou com os cinco números mais pesados e passou de
  // 470ms de atraso enquanto os outros três estavam em 21ms.
  WORKER_BUSY_LAG_MS: z.coerce.number().int().min(0).default(200),
  WORKER_BUSY_RSS_MB: z.coerce.number().int().min(0).default(800),
  // Fora por mais de 2 minutos deixa de ser oscilação e vira aviso (25/09/2026)
  UNSTABLE_ALERT_MINUTES: z.coerce.number().int().min(1).default(2),
  // Quedas curtas são rotina do WhatsApp; acima disso na mesma hora, avisamos
  QUEDAS_POR_HORA_PARA_ALERTAR: z.coerce.number().int().min(2).default(5),
  // Webhook: tentativas antes de desistir (espera cresce até 10 min; 40 ≈ 5 h de janela)
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(40),
  // Entregas de webhook simultâneas. Mais que isso não acelera: o gargalo passa a ser
  // o destino. Menos que isso faz aviso pronto esperar destino lento de outro cliente.
  WEBHOOK_EM_VOO: z.coerce.number().int().min(1).default(24),
  // Teto por destino: 24 simultâneas em cima de UM CRM não acelera, só forma fila do
  // lado dele. Medido em 28/09/2026: entregar em rajada dobrou o p90 de resposta dele.
  WEBHOOK_EM_VOO_POR_DESTINO: z.coerce.number().int().min(1).default(6),
  // Marca exibida no painel e na documentação (white-label)
  BRAND_NAME: z.string().default('API Roxa'),
  BRAND_COLOR: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7C2D92'),
  // Logo (caminho ou URL). Vazio = usa a inicial do nome
  BRAND_LOGO: z.string().default('/painel/brand/api-roxa-mark.png'),
  LOG_LEVEL: z.string().default('info'),
  BAILEYS_LOG_LEVEL: z.string().default('warn'),
  MESSAGE_RETENTION_DAYS: z.coerce.number().default(7),

  // Cluster. all = um processo faz tudo (desenvolvimento); router = recebe HTTP e repassa;
  // worker = segura as conexões do WhatsApp. Em produção o supervisor (dist/cluster.js) sobe router + workers
  ROLE: z.enum(['all', 'router', 'worker']).default('all'),
  // Quantos workers o supervisor sobe (0 = um por CPU)
  WORKERS: z.coerce.number().int().min(0).default(0),
  WORKER_ID: z.string().optional(),
  // Nome deste container (ex.: a, b). Com dois containers, os IDs dos workers não se repetem
  NODE_NAME: z.string().regex(/^[a-z0-9-]+$/).optional(),
  // Endereço pelo qual os outros containers alcançam os workers deste (ex.: app_a).
  // Sem valor, workers só escutam na própria máquina (um container só)
  ADVERTISE_HOST: z.string().optional(),
  // Quanto tempo um worker tem para passar os números para outro antes de desligar
  DRAIN_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(90_000),
  DB_POOL_MAX: z.coerce.number().int().min(2).default(10),
  INTERNAL_PORT: z.coerce.number().default(9100),
  // Segredo entre router e workers; sem valor, deriva do ADMIN_KEY
  INTERNAL_SECRET: z.string().optional(),
  LEASE_TTL_SECONDS: z.coerce.number().int().min(10).default(30),
  // Só para desenvolvimento local: permite mídia/webhook em localhost e rede interna
  ALLOW_PRIVATE_URLS: z.stringbool().default(false),

  // Histórico entregue pelo WhatsApp ao conectar (só quando a instância pede)
  HISTORY_MAX_DAYS: z.coerce.number().int().min(1).default(30),
  HISTORY_MAX_PER_CHAT: z.coerce.number().int().min(1).default(500),
  // Quantas mensagens por bloco e quanto esperar entre blocos (não travar o worker)
  HISTORY_BATCH: z.coerce.number().int().min(1).default(50),
  HISTORY_BATCH_PAUSE_MS: z.coerce.number().int().min(0).default(250),

  // Envio
  // Padrões do servidor; cada instância pode ter o seu (painel ou PATCH /instances/:id/settings).
  // Mensagem acima do limite nunca falha: espera na fila e sai assim que houver vaga
  SEND_MIN_INTERVAL_MS: z.coerce.number().default(1000),
  SEND_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  // 0 = sem limite diário
  SEND_MAX_PER_DAY: z.coerce.number().int().min(0).default(0),
  // 0 = sem aquecimento. Com N > 0, o limite diário começa em 20% e sobe até 100% em N dias
  SEND_WARMUP_DAYS: z.coerce.number().default(0),
  // Quanto tempo o POST de envio espera o resultado antes de responder 202 (fila)
  SEND_WAIT_MS: z.coerce.number().default(25_000),

  // Mídia
  MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
  MEDIA_LOCAL_DIR: z.string().default('./data/media'),
  MEDIA_MAX_MB: z.coerce.number().default(64),
  // Quanto tempo o link da mídia vale. Arquivo local mais velho que isso é apagado (o link já venceu).
  // 7 dias: quem recebe o webhook baixa o arquivo na hora e guarda no próprio sistema
  MEDIA_URL_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Se o bucket for público, links diretos em vez de links assinados
  S3_PUBLIC_BASE_URL: z.string().optional(),
})

export const config = schema.parse(process.env)

if (process.env.NODE_ENV === 'production' && !config.DATA_KEY) {
  throw new Error('DATA_KEY é obrigatória em produção (openssl rand -hex 32)')
}

if (config.MEDIA_STORAGE === 's3' && !(config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY)) {
  throw new Error('MEDIA_STORAGE=s3 exige S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY')
}
