import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, tx } from './db.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())')
const { rows } = await pool.query<{ name: string }>('select name from schema_migrations')
const applied = new Set(rows.map((r) => r.name))

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) continue
  const sql = await readFile(join(dir, file), 'utf8')
  await tx(async (c) => {
    await c.query(sql)
    await c.query('insert into schema_migrations (name) values ($1)', [file])
  })
  console.log(`aplicada: ${file}`)
}

// Dados de antes da criptografia: cifra o que ainda estiver em texto puro
const { encryptLegacyData } = await import('./security/encrypt-legacy.js')
const cifrados = await encryptLegacyData(pool)
if (cifrados) console.log(`cifrados: ${cifrados} registros antigos`)

await pool.end()
