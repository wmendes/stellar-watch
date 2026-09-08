#!/usr/bin/env node
/**
 * Stellar Watch — CLI.
 */
// Imports dinâmicos de propósito: `config.ts` valida credenciais ao carregar,
// e `stellar-watch` sem argumentos deve imprimir a ajuda mesmo sem .env.
import type { Durability } from "./read.js";

const USAGE = `
stellar-watch — monitor de pagamentos Stellar

  probe                                      sonda a instância de RPC (rode isto primeiro)
  read <contractId> <chave> [durability]     lê estado de contrato (persistent | temporary)
  read <contractId> --instance               lê o storage de instância do contrato
  account <publicKey>                        o que o RPC sabe de uma conta (spoiler: pouco)
  pay <destino> <valor> [ativo] [memo]       ativo: native | CODE:ISSUER | <contract id C...>
  fund <publicKey>                           friendbot (Testnet/Futurenet)
  lake <ledger|--date YYYY-MM-DD> [rede]     lê um ledger do data lake público
                                             (rede: pubnet | testnet · +opção --xdr)
  poll [--para <G...>] [--intervalo S] [--ciclos N] [--agora] [contractId]
                                             monitora transfers com cursor durável.
                                             Sem --ciclos roda até Ctrl+C.
                                             (--agora reproduz a perda de eventos)
  ledgers <startLedger> [limite]             faixa de ledgers via RPC getLedgers
  cursor                                     mostra o cursor salvo
  cursor --reset                             apaga o cursor salvo

Rede e credenciais vêm do .env — veja .env.example.
`;

// Um `| head` fecha o stdout antes de terminarmos de escrever. Sem isto,
// o Node derruba o processo com EPIPE e uma stack trace — feio numa demo.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

/**
 * Lê o valor de uma flag validando que ele existe e não é outra flag.
 * Sem isto, `--para` sem valor engole o argumento seguinte e o erro só aparece
 * lá dentro do SDK ("Unsupported address type: --ciclos") — inútil para quem
 * está no terminal, e péssimo no meio de uma demonstração.
 */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;

  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      `${flag} exige um valor${value ? ` (recebeu \`${value}\`, que é outra flag)` : ""}. ` +
        `Se você usou uma variável, ela pode estar vazia: verifique com \`echo $VAR\`.`,
    );
  }
  return value;
}

const requireAddress = (value: string, flag: string): string => {
  if (!/^G[A-Z2-7]{55}$/.test(value)) {
    throw new Error(`${flag} espera uma chave pública (G..., 56 caracteres). Recebeu: ${value}`);
  }
  return value;
};

const requirePositiveInt = (value: string, flag: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} espera um inteiro positivo. Recebeu: ${value}`);
  }
  return n;
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "probe": {
      const { probe } = await import("./probe.js");
      await probe();
      break;
    }

    case "read": {
      const [contractId, key, durability] = args;
      if (!contractId) throw new Error("Uso: read <contractId> <chave> [durability] | --instance");

      if (!key) throw new Error("Uso: read <contractId> <chave> [durability] | --instance");

      // O espaço de instância não é endereçado por chave — vem inteiro.
      if (key === "--instance" || key === "instance") {
        const { readInstance } = await import("./read.js");
        const result = await readInstance(contractId);
        if (!result.found) {
          console.log("(contrato não encontrado neste RPC)");
          break;
        }
        console.log("executable:", result.executable);
        console.log("instance storage:");
        console.log(result.storage);
        if (result.liveUntilLedgerSeq) console.log("Vive até o ledger:", result.liveUntilLedgerSeq);
        break;
      }

      const { read } = await import("./read.js");
      
      const result = await read(contractId, key, (durability as Durability) ?? "persistent");
      console.log(
        result.found
          ? result.value
          : "(vazio — chave errada, nunca existiu, ou state archival. Tente --instance)",
      );
      if (result.liveUntilLedgerSeq) console.log("Vive até o ledger:", result.liveUntilLedgerSeq);
      break;
    }

    case "account": {
      const [publicKey] = args;
      if (!publicKey) throw new Error("Uso: account <publicKey>");
      const { readAccount } = await import("./read.js");
      console.log(await readAccount(publicKey));
      break;
    }

    case "pay": {
      const [destination, amount, asset, memo] = args;
      if (!destination || !amount) throw new Error("Uso: pay <destino> <valor> [ativo] [memo]");
      const { pay } = await import("./pay.js");
      await pay({ destination, amount, asset, memo });
      break;
    }

    case "fund": {
      const [publicKey] = args;
      if (!publicKey) throw new Error("Uso: fund <publicKey>");
      const { fund } = await import("./pay.js");
      await fund(publicKey);
      break;
    }

    case "lake": {
      const [alvo, rede] = args;
      if (!alvo) throw new Error("Uso: lake <ledger|--date YYYY-MM-DD> [pubnet|testnet]");
      const network = (alvo === "--date" ? args[2] : rede) === "testnet" ? "testnet" : "pubnet";
      const { readLedger, findLedgerByDate, printLedger } = await import("./lake.js");

      let sequence: number;
      if (alvo === "--date") {
        const iso = args[1];
        if (!iso) throw new Error("Uso: lake --date YYYY-MM-DD [pubnet|testnet]");
        const date = new Date(`${iso}T00:00:00Z`);
        if (Number.isNaN(date.getTime())) throw new Error(`Data inválida: ${iso}`);
        console.log(`Procurando o primeiro ledger de ${iso} por busca binária no lake…`);
        sequence = await findLedgerByDate(date, network);
      } else {
        sequence = Number(alvo);
        if (!Number.isInteger(sequence) || sequence < 2) {
          throw new Error(`Ledger inválido: ${alvo}`);
        }
      }

      const ledger = await readLedger(sequence, network);
      if (args.includes("--xdr")) {
        console.log(ledger.xdr.toString("base64"));
        break;
      }
      printLedger(ledger, args.includes("--txs") ? -1 : 10);
      break;
    }

    case "poll": {
      const { poll } = await import("./poll.js");
      const ciclos = flagValue(args, "--ciclos");
      const para = flagValue(args, "--para");
      const intervalo = flagValue(args, "--intervalo");
      await poll({
        fromNow: args.includes("--agora"),
        maxCycles: ciclos === undefined ? undefined : requirePositiveInt(ciclos, "--ciclos"),
        to: para === undefined ? undefined : requireAddress(para, "--para"),
        intervalMs:
          intervalo === undefined ? undefined : requirePositiveInt(intervalo, "--intervalo") * 1000,
        contractIds: args.filter((a) => a.startsWith("C") && a.length === 56),
      });
      break;
    }

    case "ledgers": {
      const [start, limite] = args;
      if (!start) throw new Error("Uso: ledgers <startLedger> [limite]");
      const { readLedgers, printLedgers } = await import("./ledgers.js");
      printLedgers(await readLedgers(Number(start), limite ? Number(limite) : 3));
      break;
    }

    case "cursor": {
      const { config } = await import("./config.js");
      const { loadCursor, cursorPath, clearCursor } = await import("./cursor.js");
      if (args.includes("--reset")) {
        clearCursor(config.network);
        console.log("Cursor apagado:", cursorPath(config.network));
        break;
      }
      const state = loadCursor(config.network);
      console.log("Arquivo:", cursorPath(config.network));
      console.log(state ?? "(nenhum cursor salvo)");
      break;
    }

    default:
      console.log(USAGE.trim());
      if (command) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
