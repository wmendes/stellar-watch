/**
 * Histórico profundo pelo RPC: `getLedgers`.
 *
 * De todos os métodos do Stellar RPC, este é o único que pode enxergar além da
 * janela de retenção da instância — o RPC 23.0 integrou data lake a ele. Os
 * demais seguem presos ao `HISTORY_RETENTION_WINDOW` do nó.
 *
 * Isto é o par do `lake.ts`: mesmo dado, dois caminhos.
 *   aqui        você pergunta ao provedor, que consulta o data lake dele
 *   lake.ts     você baixa o arquivo do bucket público e decodifica local
 *
 * O primeiro é mais simples e depende do plano do provedor. O segundo não
 * depende de ninguém, e é o que sobra quando o provedor não tem archive.
 */
import { rpc } from "./config.js";
import { withRetry } from "./retry.js";

/** Código JSON-RPC de pedido inválido — inclui "ledger fora da janela". */
const INVALID_REQUEST = -32600;

const jsonRpcCode = (error: unknown): number | undefined => {
  const e = error as { code?: number; response?: { data?: { error?: { code?: number } } } };
  return e?.code ?? e?.response?.data?.error?.code;
};

export interface LedgerSummary {
  sequence: number;
  hash: string;
  closedAt: string;
  transactions: number;
}

export interface LedgersResult {
  ledgers: LedgerSummary[];
  /** Janela da instância no momento da consulta. */
  oldestLedger: number;
  latestLedger: number;
  /** true = o pedido caiu abaixo do piso e ainda assim foi atendido. */
  belowFloor: boolean;
  cursor: string;
}

/**
 * Lê uma faixa de ledgers a partir de `startLedger`.
 * Se o pedido estiver abaixo do piso da instância e ela não tiver data lake,
 * o RPC devolve -32600 — e é essa a resposta que interessa demonstrar.
 */
export async function readLedgers(startLedger: number, limit = 3): Promise<LedgersResult> {
  const health = await withRetry(() => rpc.getHealth(), { label: "getHealth" });

  try {
    const response = await withRetry(
      () => rpc.getLedgers({ startLedger, pagination: { limit } }),
      { label: "getLedgers" },
    );

    return {
      ledgers: response.ledgers.map((l) => ({
        sequence: l.sequence,
        hash: l.hash,
        closedAt: l.ledgerCloseTime,
        // O metadado vem inteiro; daqui sai a contagem real de transações.
        transactions: l.metadataXdr.value.txProcessing.length,
      })),
      oldestLedger: health.oldestLedger,
      latestLedger: response.latestLedger,
      belowFloor: startLedger < health.oldestLedger,
      cursor: response.cursor,
    };
  } catch (error) {
    if (jsonRpcCode(error) === INVALID_REQUEST && startLedger < health.oldestLedger) {
      throw new Error(
        `Ledger ${startLedger} está abaixo do oldestLedger (${health.oldestLedger}) e esta ` +
          `instância não tem data lake configurado (-32600).\n` +
          `   Alternativa: pnpm run lake ${startLedger} — lê o mesmo ledger do bucket público.`,
      );
    }
    throw error;
  }
}

export function printLedgers(result: LedgersResult): void {
  console.log("Janela da instância:", `${result.oldestLedger} … ${result.latestLedger}`);
  if (result.belowFloor) {
    console.log("Abaixo do piso:      sim — respondido via data lake / RPC Archive ✅");
  }
  for (const l of result.ledgers) {
    const data = new Date(Number(l.closedAt) * 1000).toISOString();
    console.log(`  ${l.sequence}  ${data}  ${l.transactions} tx  ${l.hash.slice(0, 16)}…`);
  }
  if (result.cursor) console.log("Próximo cursor:     ", result.cursor);
}
