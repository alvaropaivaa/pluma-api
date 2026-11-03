import { createHash, randomBytes } from 'node:crypto'
import { pool } from '../db.js'

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** Chave nova, no formato que o painel e a documentação já usam */
export const gerarChave = () => `wak_${randomBytes(24).toString('hex')}`

/** Últimos caracteres, só para reconhecer a chave na lista (o valor inteiro nunca é guardado) */
export const dicaDaChave = (key: string) => key.slice(-6)

const UM_MINUTO = 60_000

/**
 * Conta dona da chave, ou undefined. Chave revogada não vale mais.
 *
 * Marca o último uso no máximo uma vez por minuto: é o que responde, na tela,
 * se dá para revogar uma chave sem quebrar algum sistema esquecido.
 */
export async function contaPelaChave(key: string) {
  const { rows } = await pool.query<{ id: string; account_id: string; last_used_at: Date | null }>(
    'select id, account_id, last_used_at from account_keys where key_hash = $1 and revoked_at is null',
    [hashKey(key)],
  )
  const chave = rows[0]
  if (!chave) return undefined
  if (!chave.last_used_at || Date.now() - chave.last_used_at.getTime() > UM_MINUTO) {
    void pool.query('update account_keys set last_used_at = now() where id = $1', [chave.id]).catch(() => {})
  }
  return chave.account_id
}

/** Registra uma chave nova e devolve o id da linha. A chave em si só existe na resposta ao painel. */
export async function registrarChave(
  accountId: string,
  nome: string,
  key: string,
  autor?: { userId?: string; ip?: string },
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into account_keys (account_id, name, key_hash, hint, created_by, created_ip)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [accountId, nome, hashKey(key), dicaDaChave(key), autor?.userId ?? null, autor?.ip ?? null],
  )
  return rows[0].id
}
