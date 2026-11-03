// Cria uma conta (se preciso) e um usuário do painel.
// Uso: npm run create-user -- --email voce@empresa.com --password 'senha-forte' [--account "Nome da conta"] [--name "Seu nome"]
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { gerarChave, registrarChave } from '../api/account-keys.js'
import { createPanelUser } from '../api/panel-auth.js'
import { pool } from '../db.js'

const { values } = parseArgs({ options: { email: { type: 'string' }, password: { type: 'string' }, account: { type: 'string' }, name: { type: 'string' } } })
if (!values.email || !values.password || values.password.length < 10) {
  console.error('informe --email e --password (mínimo 10 caracteres)')
  process.exit(1)
}
const accountName = values.account ?? 'Principal'
let { rows } = await pool.query<{ id: string }>('select id from accounts where name = $1 order by created_at limit 1', [accountName])
let apiKey: string | undefined
if (!rows[0]) {
  apiKey = gerarChave()
  ;({ rows } = await pool.query('insert into accounts (name, api_key_hash) values ($1, $2) returning id', [accountName, createHash('sha256').update(apiKey).digest('hex')]))
  await registrarChave(rows[0].id, 'Chave inicial', apiKey)
}
await createPanelUser(rows[0].id, values.email, values.password, values.name)
console.log(`usuário ${values.email} criado na conta "${accountName}"`)
if (apiKey) console.log(`chave de parceiro da conta nova (guarde, aparece só agora): ${apiKey}`)
await pool.end()
