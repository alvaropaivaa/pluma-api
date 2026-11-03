import { fetchLatestBaileysVersion, type WAVersion } from 'baileys'
import { logger } from '../logger.js'

const TTL_MS = 6 * 60 * 60 * 1000
let cached: { version: WAVersion; at: number } | undefined

/** Versão do WhatsApp Web anunciada ao servidor; se a busca falhar, usa a embutida no Baileys */
export async function getWaVersion(): Promise<WAVersion | undefined> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.version
  try {
    const { version } = await fetchLatestBaileysVersion()
    cached = { version, at: Date.now() }
    return version
  } catch (err) {
    logger.warn({ err }, 'não consegui buscar a versão mais recente do WhatsApp Web')
    return cached?.version
  }
}
