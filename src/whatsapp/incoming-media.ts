import { downloadMediaMessage, type proto, type WAMessage, type WASocket } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { extensionFor, mediaUrl, putMedia } from '../storage/media-storage.js'

export const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'])

type MediaContent = {
  mimetype?: string | null
  fileLength?: number | { toNumber(): number } | null
  fileName?: string | null
  seconds?: number | null
  ptt?: boolean | null
}

export type MediaInfo = {
  url?: string
  mimetype?: string
  fileName?: string
  size?: number
  seconds?: number
  ptt?: boolean
  error?: string
}

/** Baixa, descriptografa e guarda a mídia recebida; devolve o link para o webhook */
export async function storeIncomingMedia(
  sock: WASocket,
  instanceId: string,
  msg: WAMessage,
  content: proto.IMessage,
  contentType: string,
): Promise<MediaInfo> {
  const media = (content as Record<string, MediaContent>)[contentType] ?? {}
  const size = typeof media.fileLength === 'number' ? media.fileLength : media.fileLength?.toNumber()
  const info: MediaInfo = {
    mimetype: media.mimetype ?? undefined,
    fileName: media.fileName ?? undefined,
    size,
    seconds: media.seconds ?? undefined,
    ptt: media.ptt ?? undefined,
  }
  if (size && size > config.MEDIA_MAX_MB * 1024 * 1024) {
    return { ...info, error: `arquivo maior que ${config.MEDIA_MAX_MB} MB, não baixado` }
  }
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      // Mídia antiga some do servidor do WhatsApp; reuploadRequest pede ao remetente para reenviar
      { logger, reuploadRequest: sock.updateMediaMessage },
    )
    const mimetype = info.mimetype ?? 'application/octet-stream'
    const month = new Date().toISOString().slice(0, 7)
    const key = `${instanceId}/${month}/${msg.key.id}.${extensionFor(mimetype)}`
    await putMedia(key, buffer, mimetype)
    return { ...info, size: buffer.length, url: await mediaUrl(key) }
  } catch (err) {
    logger.warn({ err, instanceId, messageId: msg.key.id }, 'falha ao baixar mídia')
    return { ...info, error: `falha ao baixar: ${(err as Error).message}` }
  }
}
