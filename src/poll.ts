/**
 * Monitor de pagamentos: polling de eventos `transfer` com cursor durável.
 *
 * O protocolo Stellar RPC não tem streaming. A rede nunca avisa — você
 * pergunta em intervalos. E é aí que aparece a falha silenciosa:
 *
 *   PERGUNTA ERRADA  "o que está acontecendo agora?"
 *   PERGUNTA CERTA   "o que aconteceu desde a última vez que eu perguntei?"
 *
 * A primeira funciona perfeitamente enquanto o processo não cai. Quando cai e
 * volta, tudo que aconteceu no intervalo simplesmente não é visto. Não há
 * exceção, não há log, não há métrica: para o seu código, nada deu errado.
 *
 * O modo `fromNow` existe para demonstrar essa perda ao vivo. Não é o modo
 * correto — é o bug, reproduzível sob demanda.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config, rpc } from "./config.js";
import { type CursorState, loadCursor, saveCursor } from "./cursor.js";
import { withRetry } from "./retry.js";

/** Eventos de `transfer` cobrem pagamento clássico e transferência via SAC. */
const TRANSFER_TOPIC = StellarSdk.xdr.ScVal.scvSymbol("transfer").toXdr("base64");

export interface PollOptions {
  /** Contratos a observar. Vazio = todos os eventos de `transfer` da rede. */
  contractIds?: string[];
  /**
   * Só transfers com este destinatário. O filtro roda NO SERVIDOR, via topic —
   * é a diferença entre receber os eventos da rede toda e receber os seus.
   */
  to?: string;
  /** Espera entre um ciclo e o próximo. Padrão 5 s, o ritmo de um ledger. */
  intervalMs?: number;
  /** Encerra após N ciclos. Sem isso, roda indefinidamente até Ctrl+C. */
  maxCycles?: number;
  /**
   * `true` retoma do ledger atual, descartando o cursor salvo — a falha que
   * a aula demonstra. `false` (padrão) retoma de onde parou.
   */
  fromNow?: boolean;
}

export interface Transfer {
  ledger: number;
  closedAt: string;
  txHash: string;
  contractId: string;
  from: string;
  to: string;
  asset: string;
  amount: bigint;
  /** Presente quando o destino é uma conta muxed (ou carrega memo). */
  muxedId?: string;
}

/**
 * O `value` de um evento `transfer` tem DUAS formas, e essa é a pegadinha que
 * mais quebra indexador ingênuo:
 *
 *   i128           → o valor, direto           (transferência simples)
 *   map            → { amount, to_muxed_id }   (destino muxed, ou com memo)
 *
 * Quem só trata o primeiro caso descarta o segundo em silêncio — exatamente a
 * classe de falha desta aula, agora dentro de um único evento.
 */
function readAmount(value: StellarSdk.xdr.ScVal): { amount: bigint; muxedId?: string } | null {
  const native = StellarSdk.scValToNative(value);

  if (typeof native === "bigint") return { amount: native };

  if (native && typeof native === "object" && "amount" in native) {
    const record = native as { amount: unknown; to_muxed_id?: unknown };
    return {
      amount: BigInt(record.amount as string | bigint),
      muxedId: record.to_muxed_id === undefined ? undefined : String(record.to_muxed_id),
    };
  }

  return null;
}

/** Traduz um evento de `transfer` do XDR para algo exibível. */
function toTransfer(event: StellarSdk.rpc.Api.EventResponse): Transfer | null {
  try {
    // topic = [symbol("transfer"), address(from), address(to), string(asset)]
    const [, from, to, asset] = event.topic;
    if (!from || !to) return null;

    const value = readAmount(event.value);
    if (!value) return null;

    return {
      ledger: event.ledger,
      closedAt: event.ledgerClosedAt,
      txHash: event.txHash,
      contractId: event.contractId?.toString() ?? "?",
      from: String(StellarSdk.scValToNative(from)),
      to: String(StellarSdk.scValToNative(to)),
      asset: asset ? String(StellarSdk.scValToNative(asset)) : "?",
      amount: value.amount,
      muxedId: value.muxedId,
    };
  } catch {
    // Contratos não-SAC também emitem `transfer` com formatos próprios.
    return null;
  }
}

/**
 * O cursor do `getEvents` é um TOID: os 32 bits altos são o número do ledger.
 * Decodificá-lo é o que permite dizer, em ledgers, o quanto estamos atrasados.
 */
export function ledgerOfCursor(cursor: string): number | null {
  const head = cursor.split("-")[0];
  if (!head) return null;
  try {
    return Number(BigInt(head) >> 32n);
  } catch {
    return null;
  }
}

/**
 * Espera que pode ser interrompida. Um `setTimeout` comum faz o Ctrl+C esperar
 * o intervalo inteiro antes de agir — num monitor com intervalo de 30 s isso
 * parece travamento. Aqui a interrupção acorda a espera na hora.
 */
function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const xlm = (stroops: bigint): string => (Number(stroops) / 1e7).toFixed(7);

export function printTransfer(t: Transfer): void {
  const extra = t.muxedId ? `  muxed=${t.muxedId}` : "";
  console.log(
    `  [${t.ledger}] ${xlm(t.amount)} ${t.asset}  ${short(t.from)} → ${short(t.to)}` +
      `  tx ${short(t.txHash)}${extra}`,
  );
}

export async function poll(options: PollOptions = {}): Promise<void> {
  const { contractIds, to, intervalMs = 5_000, maxCycles, fromNow = false } = options;
  const network = config.network;

  const saved = fromNow ? null : loadCursor(network);
  const health = await withRetry(() => rpc.getHealth(), { label: "getHealth" });
  const latest = await withRetry(() => rpc.getLatestLedger(), { label: "getLatestLedger" });

  if (saved) {
    const atraso = latest.sequence - saved.ledger;
    console.log(`Retomando do cursor salvo — ledger ${saved.ledger} (${atraso} ledgers atrás).`);
    if (saved.ledger < health.oldestLedger) {
      // O cursor envelheceu além da janela da instância: há uma lacuna real,
      // e ela não é recuperável por este endpoint.
      console.warn(
        `⚠️  O cursor salvo (${saved.ledger}) é anterior ao oldestLedger ` +
          `(${health.oldestLedger}). Os eventos desse intervalo não estão mais ` +
          `neste RPC — só em data lake ou indexador.`,
      );
    }
  } else if (fromNow) {
    console.log(`⚠️  Modo --agora: ignorando cursor salvo e lendo do ledger ${latest.sequence}.`);
    console.log("    Tudo que aconteceu antes deste instante será perdido.");
  } else {
    console.log(`Sem cursor salvo. Primeira leitura a partir do ledger ${latest.sequence}.`);
  }

  // topic = [symbol("transfer"), from, to, asset] — "*" é curinga por posição.
  const toTopic = to
    ? StellarSdk.nativeToScVal(to, { type: "address" }).toXdr("base64")
    : "*";

  const filters: StellarSdk.rpc.Api.EventFilter[] = [
    {
      type: "contract",
      topics: [[TRANSFER_TOPIC, "*", toTopic, "*"]],
      ...(contractIds?.length ? { contractIds } : {}),
    },
  ];

  if (to) console.log(`Filtrando transfers com destino ${to}.`);

  let state: CursorState | null = saved;
  let cycle = 0;

  // Parada limpa: o Ctrl+C não mata no meio de um ciclo. Ele pede a parada, o
  // ciclo em andamento termina, o cursor é gravado e só então saímos. É a
  // diferença entre "o processo morreu" e "o processo encerrou" — e é o que
  // garante que reiniciar retome exatamente de onde parou.
  const controller = new AbortController();
  let interrompido = false;
  const onSigint = () => {
    if (interrompido) process.exit(130); // segundo Ctrl+C: sai na marra
    interrompido = true;
    console.log("\n⏹  Encerrando: terminando o ciclo atual e gravando o cursor…");
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  if (maxCycles === undefined) {
    console.log(
      `Monitorando a cada ${(intervalMs / 1000).toFixed(0)} s. Ctrl+C encerra sem perder posição.`,
    );
  }

  try {
  while (!interrompido && (maxCycles === undefined || cycle < maxCycles)) {
    cycle++;

    const response = await withRetry(
      () =>
        rpc.getEvents(
          state
            ? { filters, cursor: state.cursor, limit: 100 }
            : { filters, startLedger: latest.sequence, limit: 100 },
        ),
      { label: "getEvents" },
    );

    const transfers = response.events.map(toTransfer).filter((t): t is Transfer => t !== null);
    for (const t of transfers) printTransfer(t);

    // O cursor só avança DEPOIS de processar. Salvar antes é a mesma classe de
    // bug: um crash no meio do processamento perderia o que não foi tratado.
    if (response.cursor) {
      state = {
        cursor: response.cursor,
        // A posição vem do PRÓPRIO cursor, não do último evento: o cursor do
        // getEvents marca o fim da faixa varrida, que costuma estar à frente
        // do último evento encontrado. Guardar o ledger do evento faria o
        // programa achar que está atrasado quando não está.
        ledger: ledgerOfCursor(response.cursor) ?? response.latestLedger,
        updatedAt: new Date().toISOString(),
        processed: (state?.processed ?? 0) + transfers.length,
      };
      // Em `fromNow` não gravamos nada: a implementação com esse bug não tem
      // cursor durável nenhum — é justamente por isso que ela reinicia do
      // "agora". Manter o arquivo intacto também deixa a demonstração
      // repetível: dá para alternar entre os dois modos e comparar.
      if (!fromNow) saveCursor(network, state);
    }

    const total = state?.processed ?? 0;
    console.log(
      `ciclo ${cycle} · ${transfers.length} transfer(s) · ` +
        `ledger ${state?.ledger ?? "?"} · total ${total}`,
    );

    if (!interrompido && (maxCycles === undefined || cycle < maxCycles)) {
      await sleepUntil(intervalMs, controller.signal);
    }
  }
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (interrompido) {
    console.log(
      `Encerrado no ledger ${state?.ledger ?? "?"} · ${state?.processed ?? 0} transfer(s) ` +
        `processados. Rode o mesmo comando para retomar daqui.`,
    );
  }
}
