/**
 * Regras do histórico que o WhatsApp manda quando um aparelho vincula.
 *
 * O celular empurra as conversas antigas em vários pacotes, logo depois do pareamento.
 * Dois detalhes do protocolo enganam quem lê esses pacotes:
 *
 * - Eles NÃO vêm em ordem. Um pacote marcado como `isLatest` pode ser seguido de outros
 *   com conteúdo de verdade.
 * - Às vezes o pacote marcado como último vem VAZIO, só para sinalizar o fim de uma etapa.
 *
 * Encerrar a importação no primeiro `isLatest` descarta o que ainda viria. Foi o que
 * aconteceu em 20/10/2026: 15 mil mensagens chegaram e nenhuma entrou, porque um pacote
 * vazio marcou a importação como concluída e bloqueou o de 1.000 que veio em seguida.
 *
 * Por isso só encerramos quando o último pacote trouxe mensagens. Se ele vier vazio,
 * a instância continua aberta para receber os próximos; e se a conexão cair antes de
 * fechar, a próxima tentará de novo, que é melhor que perder o histórico.
 */

export type DecisaoHistorico = {
  /** Processar as mensagens deste pacote */
  importar: boolean
  /** Dar a importação por concluída (não aceitar mais pacotes do pareamento) */
  encerrar: boolean
}

export function decidirHistorico(p: {
  /** O pedido foi explícito ("buscar mensagens mais antigas desta conversa") */
  sobDemanda: boolean
  /** A instância está configurada para importar histórico */
  ligado: boolean
  /** Já concluímos a importação desta instância */
  jaImportado: boolean
  /** O WhatsApp marcou este pacote como o último */
  isLatest: boolean
  /** Quantas mensagens vieram neste pacote */
  quantidade: number
}): DecisaoHistorico {
  // Pedido explícito: entra sempre e não encerra nada, pode se repetir quantas vezes quiserem
  if (p.sobDemanda) return { importar: true, encerrar: false }
  if (!p.ligado || p.jaImportado) return { importar: false, encerrar: false }
  return { importar: true, encerrar: p.isLatest && p.quantidade > 0 }
}
