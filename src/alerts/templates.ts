import { config } from '../config.js'

/**
 * E-mails de alerta. HTML de e-mail (tabela + estilo inline) para abrir igual no Gmail,
 * Outlook e celular. Todo texto variável passa por esc()
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const formatPhone = (p?: string | null) => {
  if (!p) return '—'
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`
}

type Tone = 'danger' | 'warning' | 'success' | 'info'
const TONES: Record<Tone, { pill: string; pillBg: string; button: string }> = {
  danger: { pill: '#b42318', pillBg: '#fdecea', button: '#d9534f' },
  warning: { pill: '#9a6200', pillBg: '#fdf3e0', button: '#d4a017' },
  success: { pill: '#12805c', pillBg: '#e6f5ef', button: '#16a34a' },
  info: { pill: '#1d4ed8', pillBg: '#e6f0ff', button: '#16243b' },
}

function layout(o: {
  tone: Tone
  pill: string
  title: string
  greeting: string
  bodyHtml: string
  rows: [string, string][]
  button?: { label: string; url: string }
  note?: string
}) {
  const t = TONES[o.tone]
  const rows = o.rows
    .map(
      ([label, value]) => `
      <tr><td style="padding:8px 0 2px;font-size:14px;color:#5a6475">${esc(label)}</td></tr>
      <tr><td style="padding:0 0 10px;font-size:17px;font-weight:700;color:#1b2330">${esc(value)}</td></tr>`,
    )
    .join('')
  const button = o.button
    ? `<tr><td align="center" style="padding:26px 0 8px">
        <a href="${esc(o.button.url)}" style="display:inline-block;background:${t.button};color:#ffffff;text-decoration:none;font-weight:700;font-size:17px;padding:14px 34px;border-radius:999px">${esc(o.button.label)}</a>
      </td></tr>`
    : ''
  const note = o.note ? `<tr><td align="center" style="padding:8px 0 0;font-size:13px;color:#6c7380">${esc(o.note)}</td></tr>` : ''
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:34px 28px">
    <tr><td align="center"><span style="display:inline-block;background:${t.pillBg};color:${t.pill};font-size:12px;font-weight:700;letter-spacing:.08em;padding:7px 16px;border-radius:999px">${esc(o.pill)}</span></td></tr>
    <tr><td align="center" style="padding:20px 0 8px;font-size:26px;font-weight:800;color:#1b2330">${esc(o.title)}</td></tr>
    <tr><td align="center" style="padding:6px 0;font-size:15px;color:#1b2330">${esc(o.greeting)}</td></tr>
    <tr><td align="center" style="padding:4px 8px 18px;font-size:15px;line-height:1.55;color:#1b2330">${o.bodyHtml}</td></tr>
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="background:#f1f4fa;border-radius:10px;padding:14px 38px;text-align:center">${rows}</table>
    </td></tr>
    ${button}${note}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td align="center" style="padding:16px 8px;font-size:12px;color:#8a919d">Enviado por <b>${esc(config.BRAND_NAME)}</b><br>Você recebeu este e-mail porque é responsável por esta conta.</td></tr>
  </table>
</td></tr></table></body></html>`
}

type InstanceInfo = { accountName: string; instanceName: string; phone: string | null; instanceId: string }

const panelLink = (instanceId: string) => `${config.PUBLIC_URL.replace(/\/$/, '')}/painel/#/instancias/${instanceId}/conexao`

export function disconnectedEmail(i: InstanceInfo, reason: string) {
  return {
    subject: `⚠️ Canal desconectado: ${i.instanceName} ${formatPhone(i.phone)}`,
    html: layout({
      tone: 'danger',
      pill: 'AÇÃO NECESSÁRIA',
      title: 'Canal desconectado',
      greeting: `Olá, ${i.accountName}!`,
      bodyHtml: `O canal de WhatsApp abaixo <b>foi desconectado</b> e, enquanto estiver assim, <b>não envia nem recebe mensagens</b>.<br><span style="color:#5a6475;font-size:14px">Motivo: ${esc(reason)}</span>`,
      rows: [
        ['Conta', i.accountName],
        ['Canal', i.instanceName],
        ['Número', formatPhone(i.phone)],
      ],
      button: { label: 'Reconectar agora', url: panelLink(i.instanceId) },
      note: 'Você precisará ler o QR Code com o WhatsApp deste número.',
    }),
  }
}

export function flappingEmail(i: InstanceInfo, quedas: number, segundosFora: number) {
  return {
    subject: `Canal caindo com frequência: ${i.instanceName} ${formatPhone(i.phone)}`,
    html: layout({
      tone: 'warning',
      pill: 'ATENÇÃO',
      title: 'Canal caindo e voltando',
      greeting: `Olá, ${i.accountName}!`,
      bodyHtml: `O canal abaixo caiu <b>${quedas} vezes na última hora</b>, somando cerca de <b>${segundosFora} segundos fora</b>. Ele volta sozinho a cada vez, e nada foi perdido — mas essa frequência costuma indicar internet instável no celular ou oscilação do WhatsApp.`,
      rows: [
        ['Conta', i.accountName],
        ['Canal', i.instanceName],
        ['Número', formatPhone(i.phone)],
        ['Quedas na última hora', String(quedas)],
        ['Tempo fora somado', `${segundosFora} segundos`],
      ],
    }),
  }
}

export function unstableEmail(i: InstanceInfo, minutes: number) {
  return {
    subject: `Canal instável: ${i.instanceName} ${formatPhone(i.phone)}`,
    html: layout({
      tone: 'warning',
      pill: 'ATENÇÃO',
      title: 'Canal tentando reconectar',
      greeting: `Olá, ${i.accountName}!`,
      bodyHtml: `O canal abaixo está <b>há ${minutes} minutos tentando reconectar</b> sozinho, sem sucesso. Mensagens podem atrasar.<br>Confira se o celular está ligado e com internet.`,
      rows: [
        ['Conta', i.accountName],
        ['Canal', i.instanceName],
        ['Número', formatPhone(i.phone)],
      ],
      button: { label: 'Ver o canal', url: panelLink(i.instanceId) },
      note: 'Se voltar sozinho, você recebe outro e-mail avisando.',
    }),
  }
}

export function reconnectedEmail(i: InstanceInfo, downMinutes: number) {
  return {
    subject: `✅ Canal reconectado: ${i.instanceName} ${formatPhone(i.phone)}`,
    html: layout({
      tone: 'success',
      pill: 'TUDO CERTO',
      title: 'Canal reconectado',
      greeting: `Olá, ${i.accountName}!`,
      bodyHtml: `O canal abaixo <b>voltou a funcionar</b> e já envia e recebe mensagens normalmente.<br><span style="color:#5a6475;font-size:14px">Ficou fora por cerca de ${downMinutes} min.</span>`,
      rows: [
        ['Conta', i.accountName],
        ['Canal', i.instanceName],
        ['Número', formatPhone(i.phone)],
      ],
    }),
  }
}

/** Alerta interno da operação (time técnico) */
export function opsEmail(title: string, lines: string[]) {
  return {
    subject: `[${config.BRAND_NAME}] ${title}`,
    html: layout({
      tone: 'info',
      pill: 'OPERAÇÃO',
      title,
      greeting: 'Aviso automático do servidor',
      bodyHtml: lines.map(esc).join('<br>'),
      rows: [['Servidor', config.PUBLIC_URL]],
      button: { label: 'Ver saúde do servidor', url: `${config.PUBLIC_URL.replace(/\/$/, '')}/health` },
    }),
  }
}
