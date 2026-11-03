/**
 * Regras do pareamento por código (conectar digitando o número, sem câmera).
 *
 * O WhatsApp trata esse fluxo de um jeito que engana quem lê os códigos de erro:
 *
 * - `requestPairingCode` grava `creds.me` na hora, antes de o celular confirmar. A credencial
 *   fica pela metade: parece registrada e não é. Reconectar com ela devolve 401.
 * - Cada socket recebe um número limitado de rodadas de QR. Pedir um código novo no mesmo
 *   socket gasta essas rodadas e o socket fecha com 408 ("QR refs attempts ended").
 * - O código em si vence em cerca de 1 minuto, antes do socket.
 *
 * Juntando os três: 401 e 408 aqui NÃO são "o celular desconectou" nem "o número caiu". São a
 * tentativa de pareamento falhando, e a resposta certa é um socket novo com um código novo.
 * Tratar como logout apagava a sessão e travava a instância (medido em 05/10/2026).
 */

/** Validade prática do código: pedimos outro um pouco antes disso */
export const PAIRING_CODE_TTL_MS = 50_000
/** Quanto tempo insistimos com códigos novos antes de desistir (o cliente pede outro na tela) */
export const PAIRING_WINDOW_MS = 5 * 60_000

export type PairingAction =
  /** Ainda dá tempo: limpa a credencial pela metade e sobe um socket novo com código novo */
  | { do: 'novo-codigo' }
  /** Passou a janela: para de insistir e deixa a tela pedir outro */
  | { do: 'desistir' }

/**
 * O que fazer quando o socket fecha no meio de uma tentativa de pareamento.
 * Nunca devolve "deslogar": não havia sessão para o celular desconectar.
 */
export function pairingOnClose(startedAt: number, now = Date.now()): PairingAction {
  return now - startedAt < PAIRING_WINDOW_MS ? { do: 'novo-codigo' } : { do: 'desistir' }
}
