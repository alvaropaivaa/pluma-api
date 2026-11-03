import type pg from 'pg'
import { encrypt, isEncrypted } from './crypto.js'

/**
 * Cifra o que ainda está em texto puro (dados de antes da criptografia).
 * Idempotente: só toca linhas sem o prefixo "enc:v1:". Roda junto das migrações.
 */

type Target = { table: string; column: string; key: string[] }

const TARGETS: Target[] = [
  { table: 'auth_creds', column: 'creds', key: ['instance_id'] },
  { table: 'auth_keys', column: 'value', key: ['instance_id', 'type', 'id'] },
  { table: 'instances', column: 'token', key: ['id'] },
  { table: 'instances', column: 'webhook_secret', key: ['id'] },
  { table: 'messages', column: 'message', key: ['instance_id', 'remote_jid', 'id'] },
  { table: 'send_jobs', column: 'payload', key: ['id'] },
  { table: 'webhook_outbox', column: 'payload', key: ['id'] },
]

const BATCH = 500

export async function encryptLegacyData(pool: pg.Pool) {
  let total = 0
  for (const t of TARGETS) {
    for (;;) {
      const { rows } = await pool.query(
        `select ${t.key.join(', ')}, ${t.column} as v from ${t.table}
         where ${t.column} is not null and ${t.column} not like 'enc:v1:%' limit ${BATCH}`,
      )
      if (!rows.length) break
      for (const row of rows) {
        const where = t.key.map((k, i) => `${k} = $${i + 2}`).join(' and ')
        await pool.query(`update ${t.table} set ${t.column} = $1 where ${where}`, [encrypt(row.v), ...t.key.map((k) => row[k])])
      }
      total += rows.length
    }
  }
  // Senha do proxy fica dentro do JSON da instância
  const { rows } = await pool.query<{ id: string; proxy: { pass?: string } }>(
    `select id, proxy from instances where proxy ? 'pass' and proxy->>'pass' is not null`,
  )
  for (const r of rows) {
    if (!r.proxy.pass || isEncrypted(r.proxy.pass)) continue
    await pool.query('update instances set proxy = $2 where id = $1', [r.id, JSON.stringify({ ...r.proxy, pass: encrypt(r.proxy.pass) })])
    total++
  }
  return total
}
