import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys'
import { pool, tx } from '../db.js'
import { decrypt, encrypt } from '../security/crypto.js'

// BufferJSON preserva os Buffers/Uint8Array das chaves; por isso as colunas são text e não jsonb.
// Tudo cifrado: com essas chaves alguém assumiria o número de WhatsApp
const serialize = (value: unknown) => encrypt(JSON.stringify(value, BufferJSON.replacer))
const deserialize = <T>(text: string): T => JSON.parse(decrypt(text), BufferJSON.reviver)

export async function usePgAuthState(instanceId: string) {
  const { rows } = await pool.query<{ creds: string }>(
    'select creds from auth_creds where instance_id = $1',
    [instanceId],
  )
  const creds: AuthenticationCreds = rows[0] ? deserialize(rows[0].creds) : initAuthCreds()

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {}
        if (!ids.length) return out
        const { rows } = await pool.query<{ id: string; value: string }>(
          'select id, value from auth_keys where instance_id = $1 and type = $2 and id = any($3)',
          [instanceId, type, ids],
        )
        for (const row of rows) {
          let value = deserialize<any>(row.value)
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }
          out[row.id] = value
        }
        return out
      },
      // Tudo numa transação: gravação parcial de chaves Signal corrompe a sessão
      set: async (data: SignalDataSet) => {
        const upTypes: string[] = []
        const upIds: string[] = []
        const upValues: string[] = []
        const delTypes: string[] = []
        const delIds: string[] = []
        for (const type in data) {
          const entries = data[type as keyof SignalDataTypeMap]!
          for (const id in entries) {
            const value = entries[id]
            if (value) {
              upTypes.push(type)
              upIds.push(id)
              upValues.push(serialize(value))
            } else {
              delTypes.push(type)
              delIds.push(id)
            }
          }
        }
        await tx(async (c) => {
          if (upIds.length) {
            await c.query(
              `insert into auth_keys (instance_id, type, id, value)
               select $1, t, i, v from unnest($2::text[], $3::text[], $4::text[]) as x(t, i, v)
               on conflict (instance_id, type, id) do update set value = excluded.value`,
              [instanceId, upTypes, upIds, upValues],
            )
          }
          if (delIds.length) {
            await c.query(
              `delete from auth_keys k using unnest($2::text[], $3::text[]) as x(t, i)
               where k.instance_id = $1 and k.type = x.t and k.id = x.i`,
              [instanceId, delTypes, delIds],
            )
          }
        })
      },
    },
  }

  const saveCreds = async () => {
    await pool.query(
      `insert into auth_creds (instance_id, creds, updated_at) values ($1, $2, now())
       on conflict (instance_id) do update set creds = excluded.creds, updated_at = now()`,
      [instanceId, serialize(creds)],
    )
  }

  return { state, saveCreds }
}

export async function clearAuthState(instanceId: string) {
  await tx(async (c) => {
    await c.query('delete from auth_keys where instance_id = $1', [instanceId])
    await c.query('delete from auth_creds where instance_id = $1', [instanceId])
  })
}
