import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

/** Envia um e-mail pelo provedor configurado (Resend ou SMTP). Sem provedor ou sem remetente, lança erro (fica na fila) */
export async function sendEmail(to: string[], subject: string, html: string) {
  if (!config.ALERT_FROM) throw new Error('remetente de e-mail não configurado (ALERT_FROM)')
  if (config.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.ALERT_FROM, to, subject, html }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return
  }
  if (config.SMTP_URL) {
    await smtp().sendMail({ from: config.ALERT_FROM, to, subject, html })
    return
  }
  throw new Error('nenhum provedor de e-mail configurado (RESEND_API_KEY ou SMTP_URL)')
}

let transport: Transporter | undefined
const smtp = () => (transport ??= nodemailer.createTransport(config.SMTP_URL))

export const emailConfigured = () => Boolean(config.ALERT_FROM && (config.RESEND_API_KEY || config.SMTP_URL))
