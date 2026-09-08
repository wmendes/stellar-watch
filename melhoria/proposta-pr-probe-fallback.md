# Proposta de Pull Request: Diagnóstico Híbrido & Fallback do Data Lake no `probe.ts`

Esta proposta de melhoria conecta diretamente os conceitos da **Aula 1 (Arquitetura de Dados Quentes vs. Frios)** com a engenharia prática do **Stellar Watch**. Ela transforma o comando `probe` em um assistente de diagnóstico inteligente, auxiliando o desenvolvedor a entender onde seus dados estão e como recuperá-los de forma resiliente.

---

## 🛠️ O Código Alterado (`src/probe.ts`)

Aqui está a implementação completa e atualizada do arquivo `probe.ts` em TypeScript, utilizando o **`fetch` nativo do Node 22** e gerenciamento resiliente de timeouts via **`AbortC```typescript
/**
 * A primeira coisa que você roda contra QUALQUER provedor novo.
 *
 * Diagnóstico híbrido:
 *  1. Janela quente: sonda a retenção do RPC (oldestLedger .. latestLedger).
 *  2. Histórico profundo: avalia se o RPC integra data lake nativo.
 *  3. Fallback frio: se o RPC tiver memória curta, valida a conectividade direta
 *     com o Data Lake público da AWS (S3) e instrui o uso do comando `lake`.
 */
import { config, redactedRpcUrl, rpc } from "./config.js";
import { withRetry } from "./retry.js";

/** Código JSON-RPC devolvido ao pedir ledger fora da janela sem data lake. */
const INVALID_REQUEST = -32600;

/** Endpoint do Data Lake público oficial (AWS Open Data) usado pelo lake.ts */
const AWS_LAKE_BUCKET = "https://aws-public-blockchain.s3.amazonaws.com";

const jsonRpcCode = (error: unknown): number | undefined => {
  const e = error as { code?: number; response?: { data?: { error?: { code?: number } } } };
  return e?.code ?? e?.response?.data?.error?.code;
};

export interface ProbeResult {
  network: string;
  status: string;
  protocolVersion: string;
  latestLedger: number;
  oldestLedger: number;
  /** Profundidade real, em ledgers, desta instância. */
  windowLedgers: number;
  /** ~5s por ledger — só para dar noção humana da janela. */
  windowDays: number;
  /** true = getLedgers fura a janela (RPC Archive ou data lake configurado no RPC). */
  deepHistory: boolean;
  /** true = Data Lake público na AWS S3 está acessível para leitura direta via lake.ts */
  lakeOnline?: boolean;
}

/**
 * Valida conectividade com o bucket S3 público do Data Lake via HEAD request com timeout.
 */
async function checkS3DataLakeConnection(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${AWS_LAKE_BUCKET}?list-type=2&prefix=v1.1/stellar/ledgers/`, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok || response.status === 403;
  } catch {
    return false;
  }
}

export async function probe(): Promise<ProbeResult> {
  const [health, ledger] = await Promise.all([
    withRetry(() => rpc.getHealth(), { label: "getHealth" }),
    withRetry(() => rpc.getLatestLedger(), { label: "getLatestLedger" }),
  ]);

  const windowLedgers = ledger.sequence - health.oldestLedger;
  const deepHistory = await hasDeepHistory(health.oldestLedger);
  const lakeOnline = !deepHistory ? await checkS3DataLakeConnection() : undefined;

  const result: ProbeResult = {
    network: config.network,
    status: health.status,
    protocolVersion: ledger.protocolVersion,
    latestLedger: ledger.sequence,
    oldestLedger: health.oldestLedger,
    windowLedgers,
    windowDays: (windowLedgers * 5) / 86_400,
    deepHistory,
    lakeOnline,
  };

  console.log("--- 📊 DADOS DO SERVIDOR RPC (DADOS QUENTES) ---");
  console.log("Rede:         ", result.network);
  console.log("RPC:          ", redactedRpcUrl());
  console.log("Passphrase:   ", config.networkPassphrase);
  console.log("Status:       ", result.status);
  console.log("Protocolo:    ", result.protocolVersion);
  console.log("Latest ledger:", result.latestLedger);
  console.log("Oldest ledger:", result.oldestLedger);
  console.log(
    "Janela Quente:",
    `${result.windowLedgers} ledgers (~${result.windowDays.toFixed(1)} dias em memória)`,
  );

  console.log("\n--- 🌐 DIAGNÓSTICO DE DADOS FRIOS & DATA LAKE ---");
  if (result.deepHistory) {
    console.log("Histórico RPC: ✅ getLedgers fura a janela (RPC Archive / Data Lake integrado)");
  } else {
    console.log("Histórico RPC: ⚠️  Limitado ao oldestLedger (RPC sem data lake acoplado)");

    if (result.lakeOnline) {
      console.log("S3 Data Lake:  ✅ ONLINE (AWS Open Data acessível)");
      console.log("\n💡 Diagnóstico & Prática:");
      console.log(`   Consultas de ledgers abaixo de ${result.oldestLedger} falharão via RPC.`);
      console.log("   Como o Data Lake está acessível, utilize o comando de leitura direta:");
      console.log("   👉 pnpm run lake <ledger>\n");
    } else {
      console.log("S3 Data Lake:  ❌ Indisponível ou bloqueado por firewall/DNS.");
      console.log(`   Histórico restrito estritamente a [${result.oldestLedger}..${result.latestLedger}].\n`);
    }
  }

  return result;
}

/**
 * RPC 23.0 integrou data lake ao `getLedgers`, e SÓ a ele: os demais métodos
 * continuam presos ao HISTORY_RETENTION_WINDOW do nó. Sem data lake, pedir um
 * ledger abaixo do oldestLedger falha com -32600. É esse erro que sondamos aqui.
 */
async function hasDeepHistory(oldestLedger: number): Promise<boolean> {
  const belowFloor = Math.max(2, oldestLedger - 1_000);
  if (belowFloor >= oldestLedger) return false;

  try {
    await rpc.getLedgers({ startLedger: belowFloor, pagination: { limit: 1 } });
    return true;
  } catch (error) {
    if (jsonRpcCode(error) === INVALID_REQUEST) return false;
    return false;
  }
}
```
