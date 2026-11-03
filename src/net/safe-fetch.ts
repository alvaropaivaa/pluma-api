import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch, type RequestInit } from 'undici'
import { config } from '../config.js'

/**
 * fetch que se recusa a acessar a rede interna (SSRF). Usado em toda URL que vem de fora:
 * mídia por URL e webhooks. Sem isso, um cliente da API poderia mandar "url": "http://169.254.169.254/..."
 * e ler dados do servidor
 */

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['64:ff9b::', 96]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isPrivateAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  return blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

export class BlockedUrlError extends Error {}

// A checagem acontece na conexão (inclusive após redirects), o que também cobre DNS rebinding
const agent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, options, (err, address, family) => {
        if (err) return callback(err, address as string, family)
        const list: LookupAddress[] = Array.isArray(address) ? address : [{ address, family: family ?? 4 }]
        if (list.some((a) => isPrivateAddress(a.address))) {
          return callback(new BlockedUrlError(`endereço interno bloqueado (${hostname})`), '', 4)
        }
        callback(null, address as string, family)
      })
    },
  },
})

export async function safeFetch(url: string, init: RequestInit = {}) {
  if (config.ALLOW_PRIVATE_URLS) return fetch(url, init)
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BlockedUrlError('só http e https')
  // IP literal não passa pelo lookup; checa aqui
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError(`endereço interno bloqueado (${host})`)
  return fetch(url, { ...init, dispatcher: agent })
}
