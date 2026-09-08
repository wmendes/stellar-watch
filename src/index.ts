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

Rede e credenciais vêm do .env — veja .env.example.
`;

// Um `| head` fecha o stdout antes de terminarmos de escrever. Sem isto,
// o Node derruba o processo com EPIPE e uma stack trace — feio numa demo.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

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

    default:
      console.log(USAGE.trim());
      if (command) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
