import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import mime from 'mime-types'
import { config } from '../config.js'

const TTL_SECONDS = config.MEDIA_URL_TTL_DAYS * 24 * 60 * 60
export const localRoot = resolve(config.MEDIA_LOCAL_DIR)

const s3 =
  config.MEDIA_STORAGE === 's3'
    ? new S3Client({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
      })
    : undefined

export const extensionFor = (mimetype: string) => mime.extension(mimetype.split(';')[0].trim()) || 'bin'

export async function putMedia(key: string, body: Buffer, mimetype: string) {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: mimetype }))
  } else {
    const path = join(localRoot, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
}

export async function mediaUrl(key: string) {
  if (s3) {
    if (config.S3_PUBLIC_BASE_URL) return `${config.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn: Math.min(TTL_SECONDS, 604_800) })
  }
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/media/${key}?exp=${exp}&sig=${sign(key, exp)}`
}

// Links locais assinados: sem a assinatura ninguém lista nem adivinha arquivos
const sign = (key: string, exp: number) => createHmac('sha256', config.ADMIN_KEY).update(`${key}:${exp}`).digest('hex')

export function verifyLocalMediaSignature(key: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false
  const expected = Buffer.from(sign(key, exp))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * Apaga do disco a mídia cujo link já venceu. O link só é gerado quando o arquivo é salvo,
 * então arquivo mais velho que MEDIA_URL_TTL_DAYS (+1 dia de folga) não abre para mais ninguém.
 * Só mexe em arquivos: mensagens no celular e no sistema que recebeu o webhook não são tocadas.
 * No S3 o equivalente é uma regra de ciclo de vida no bucket
 */
/** Apaga a pasta de mídia de instâncias que não existem mais (excluídas no painel) */
export async function cleanupOrphanMedia(existingInstanceIds: Set<string>) {
  if (s3) return 0
  let dirs: string[]
  try {
    dirs = (await readdir(localRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return 0
  }
  let removed = 0
  for (const dir of dirs) {
    if (existingInstanceIds.has(dir)) continue
    await rm(join(localRoot, dir), { recursive: true, force: true }).catch(() => undefined)
    removed++
  }
  return removed
}

export async function cleanupLocalMedia(now = Date.now()) {
  if (s3) return 0
  const cutoff = now - (config.MEDIA_URL_TTL_DAYS + 1) * 86_400_000
  let entries: string[]
  try {
    entries = await readdir(localRoot, { recursive: true })
  } catch {
    return 0 // pasta ainda não existe
  }
  let removed = 0
  const dirs: string[] = []
  for (const entry of entries) {
    const path = join(localRoot, entry)
    try {
      const info = await stat(path)
      if (info.isDirectory()) dirs.push(path)
      else if (info.mtimeMs < cutoff) {
        await unlink(path)
        removed++
      }
    } catch {
      // apagado por outro processo no meio: ignora
    }
  }
  // Pastas que ficaram vazias (mais fundas primeiro); rmdir falha sozinho se ainda tiver arquivo
  for (const dir of dirs.sort((a, b) => b.length - a.length)) await rmdir(dir).catch(() => undefined)
  return removed
}
