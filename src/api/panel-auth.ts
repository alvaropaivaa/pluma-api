import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { pool } from '../db.js'
import { gerarChave, registrarChave } from './account-keys.js'
import { HttpError, parse } from './common.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const SESSION_DAYS = 7
// Cookie não separa por porta: com nome próprio, outro sistema no mesmo servidor não derruba esta sessão
export const SESSION_COOKIE = 'roxa_sid'

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

async function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(actual, expected)
}

export async function createPanelUser(accountId: string, email: string, password: string, name?: string) {
  const { rows } = await pool
    .query<{ id: string }>('insert into panel_users (account_id, email, name, password_hash) values ($1, lower($2), $3, $4) returning id', [
      accountId,
      email,
      name ?? null,
      await hashPassword(password),
    ])
    .catch((err) => {
      if (err.code === '23505') throw new HttpError(409, 'já existe um usuário com esse e-mail')
      throw err
    })
  return rows[0].id
}

/** Conta dona do cookie de sessão, ou undefined */
export async function accountFromSession(req: FastifyRequest) {
  const sid = req.cookies?.[SESSION_COOKIE]
  if (!sid) return undefined
  const { rows } = await pool.query<{ account_id: string; user_id: string }>(
    `select u.account_id, u.id as user_id from panel_sessions s join panel_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(sid)],
  )
  return rows[0]
}

// Freio simples contra tentativa de senha em massa: 10 erros por e-mail/IP a cada 15 min
const failures = new Map<string, { count: number; until: number }>()
function checkThrottle(key: string) {
  const f = failures.get(key)
  if (f && f.until > Date.now() && f.count >= 10) throw new HttpError(429, 'muitas tentativas; tente de novo em alguns minutos')
}
function recordFailure(key: string) {
  const f = failures.get(key)
  const until = Date.now() + 15 * 60_000
  failures.set(key, { count: f && f.until > Date.now() ? f.count + 1 : 1, until })
}

const cookieOptions = () => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: config.PUBLIC_URL.startsWith('https://'),
  maxAge: SESSION_DAYS * 86_400,
})

export async function panelAuthRoutes(app: FastifyInstance) {
  // Público: a tela de login e a documentação mostram nome e cor da marca
  app.get('/painel/api/brand', async () => ({ name: config.BRAND_NAME, color: config.BRAND_COLOR, logo: config.BRAND_LOGO || null, publicUrl: config.PUBLIC_URL }))

  app.post('/painel/api/login', async (req, reply: FastifyReply) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body)
    const key = `${email.toLowerCase()}|${req.ip}`
    checkThrottle(key)
    const { rows } = await pool.query<{ id: string; password_hash: string }>('select id, password_hash from panel_users where email = lower($1)', [email])
    if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) {
      recordFailure(key)
      throw new HttpError(401, 'e-mail ou senha incorretos')
    }
    failures.delete(key)
    const sid = randomBytes(32).toString('base64url')
    await pool.query(`insert into panel_sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [
      sha256(sid),
      rows[0].id,
      SESSION_DAYS,
    ])
    await pool.query('update panel_users set last_login_at = now() where id = $1', [rows[0].id])
    await pool.query('delete from panel_sessions where expires_at < now()')
    return reply.setCookie(SESSION_COOKIE, sid, cookieOptions()).send({ ok: true })
  })

  app.post('/painel/api/logout', async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE]
    if (sid) await pool.query('delete from panel_sessions where token_hash = $1', [sha256(sid)])
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true })
  })

  app.get('/painel/api/me', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    const { rows } = await pool.query<{ email: string; name: string | null; account_name: string }>(
      'select u.email, u.name, a.name as account_name from panel_users u join accounts a on a.id = u.account_id where u.id = $1',
      [s.user_id],
    )
    return { ...rows[0], brand: { name: config.BRAND_NAME, color: config.BRAND_COLOR, logo: config.BRAND_LOGO || null }, publicUrl: config.PUBLIC_URL }
  })

  app.post('/painel/api/password', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    if (req.headers['x-painel'] !== '1') throw new HttpError(403, 'requisição inválida')
    const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(10, 'a senha nova precisa de pelo menos 10 caracteres') }), req.body)
    const { rows } = await pool.query<{ password_hash: string }>('select password_hash from panel_users where id = $1', [s.user_id])
    if (!(await verifyPassword(current, rows[0].password_hash))) throw new HttpError(401, 'senha atual incorreta')
    await pool.query('update panel_users set password_hash = $2 where id = $1', [s.user_id, await hashPassword(next)])
    return { ok: true }
  })

  /** Chaves de parceiro da conta. A chave em si nunca volta: fica só o hash. */
  app.get('/painel/api/api-keys', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    const { rows } = await pool.query(
      `select k.id, k.name, k.hint, k.created_at, k.last_used_at, k.revoked_at,
              autor.email as created_by_email, quem_revogou.email as revoked_by_email
         from account_keys k
         left join panel_users autor on autor.id = k.created_by
         left join panel_users quem_revogou on quem_revogou.id = k.revoked_by
        where k.account_id = $1
        order by k.revoked_at is not null, k.created_at desc`,
      [s.account_id],
    )
    return { keys: rows }
  })

  /** Cria mais uma chave, sem mexer nas que já existem. Ela aparece só nesta resposta. */
  app.post('/painel/api/api-keys', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    if (req.headers['x-painel'] !== '1') throw new HttpError(403, 'requisição inválida')
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'dê um apelido à chave').max(60) }), req.body ?? {})
    const apiKey = gerarChave()
    const id = await registrarChave(s.account_id, name, apiKey, { userId: s.user_id, ip: req.ip })
    return { id, name, apiKey }
  })

  /** Revoga uma chave. As outras continuam valendo. */
  app.post('/painel/api/api-keys/:id/revoke', async (req) => {
    const s = await accountFromSession(req)
    if (!s) throw new HttpError(401, 'não autenticado')
    if (req.headers['x-painel'] !== '1') throw new HttpError(403, 'requisição inválida')
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params)
    const { rowCount } = await pool.query(
      `update account_keys set revoked_at = now(), revoked_by = $3, revoked_ip = $4
        where id = $1 and account_id = $2 and revoked_at is null`,
      [id, s.account_id, s.user_id, req.ip],
    )
    if (!rowCount) throw new HttpError(404, 'chave não encontrada')
    return { ok: true }
  })
}
