/**
 * Persistência do cursor de leitura.
 *
 * O cursor é a única memória do monitor: onde ele parou de ler. Se ele vive só
 * em variável, cada reinício apaga essa memória — e o programa não tem como
 * distinguir "acabei de começar" de "estive fora por dez minutos".
 *
 * Guardamos em disco, por rede, porque o cursor de Testnet não vale em Mainnet.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CursorState {
  /** Cursor de paginação do `getEvents`, opaco: só o RPC o interpreta. */
  cursor: string;
  /** Último ledger cujos eventos já processamos. Legível por humanos. */
  ledger: number;
  updatedAt: string;
  /** Quantos eventos já passaram por aqui. Útil para conferir perdas. */
  processed: number;
}

const STATE_DIR = ".stellar-watch";

export const cursorPath = (network: string): string =>
  join(process.cwd(), STATE_DIR, `cursor-${network}.json`);

export function loadCursor(network: string): CursorState | null {
  try {
    return JSON.parse(readFileSync(cursorPath(network), "utf8")) as CursorState;
  } catch {
    // Arquivo ausente ou corrompido: tratamos como "nunca leu nada".
    return null;
  }
}

/**
 * Escrita atômica: gravamos num arquivo temporário e renomeamos. Sem isso, um
 * crash no meio do write deixa um cursor truncado — que é pior que cursor
 * nenhum, porque o programa volta achando que sabe onde parou.
 */
export function saveCursor(network: string, state: CursorState): void {
  const path = cursorPath(network);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

export function clearCursor(network: string): void {
  try {
    writeFileSync(cursorPath(network), "");
  } catch {
    /* nada a limpar */
  }
}
