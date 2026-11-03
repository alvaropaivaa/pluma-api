import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.js'

/**
 * Criptografia dos dados sensíveis guardados no banco (AES-256-GCM):
 * sessões do WhatsApp, tokens, segredos de webhook, senha de proxy, mensagens.
 * Quem copiar o banco sem a DATA_KEY (que fica só no .env do servidor) não lê nada.
 *
 * Formato: "enc:v1:" + base64(iv 12 bytes | tag 16 bytes | texto cifrado).
 * Valor sem o prefixo é dado antigo em texto puro: é lido normalmente e o
 * script de migração cifra na próxima subida.
 */

const PREFIX = 'enc:v1:'

function loadKey() {
  if (config.DATA_KEY) {
    const key = Buffer.from(config.DATA_KEY, 'hex')
    if (key.length !== 32) throw new Error('DATA_KEY precisa ter 64 caracteres hexadecimais (32 bytes)')
    return key
  }
  // Só desenvolvimento (a config exige DATA_KEY em produção)
  return createHash('sha256').update(`dados:${config.ADMIN_KEY}`).digest()
}

const key = loadKey()

export const isEncrypted = (value: string) => value.startsWith(PREFIX)

export function encrypt(plain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decrypt(value: string) {
  if (!isEncrypted(value)) return value // legado em texto puro
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

export const encryptNullable = (value: string | null | undefined) => (value == null ? null : encrypt(value))
export const decryptNullable = (value: string | null | undefined) => (value == null ? null : decrypt(value))

/** Token aleatório (64 hex) para instâncias */
export const newToken = () => randomBytes(32).toString('hex')
