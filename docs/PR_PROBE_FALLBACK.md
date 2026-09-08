# 🚀 Proposta de Pull Request: Diagnóstico Híbrido & Fallback do Data Lake no `probe`

## 📌 Contexto & Motivação
Na arquitetura da rede Stellar / Soroban, existe uma separação fundamental entre:
- **Dados Quentes (Memória RPC):** O nó mantém apenas uma janela recente de ledgers em memória rápida (`oldestLedger` até `latestLedger`).
- **Dados Frios (Data Lake na Nuvem):** O histórico completo de ledgers e transações reside no bucket público S3 da AWS Open Data.

Esta PR transforma o comando `pnpm run probe` em um **assistente de diagnóstico híbrido**, ajudando o desenvolvedor a identificar de imediato se o provedor RPC suporta histórico profundo ou se é necessário consultar os dados frios via `pnpm run lake`.

---

## 🛠️ O que mudou
1. **Diagnóstico Estruturado no Terminal:**
   - Seção dedicada para **Dados do Servidor RPC (Dados Quentes)** com a janela de retenção calculada em dias.
   - Seção dedicada para **Diagnóstico de Dados Frios & Data Lake**.
2. **Checagem Resiliente do S3 (AWS Open Data):**
   - Caso o RPC não possua data lake integrado, o CLI valida automaticamente a conectividade com o bucket público S3 (`aws-public-blockchain.s3.amazonaws.com`).
   - Requisição leve utilizando método `HEAD` e `AbortController` com timeout de 3 segundos, garantindo zero desperdício de banda e sem risco de travar o terminal.
3. **Instrução Acionável:**
   - Se a consulta requisitada estiver abaixo do `oldestLedger`, o terminal sugere explicitamente a utilização do comando de dados frios:
     `👉 pnpm run lake <ledger>`

---

## 🧪 Como Testar
1. Execute o comando de sondagem:
   ```bash
   pnpm run probe
   ```
2. Verifique a saída estruturada com a validação de Dados Quentes e a camada de Dados Frios.
3. Validação de tipagem e integridade:
   ```bash
   pnpm run typecheck
   ```

---

## 📚 Documentação
- Arquitetura detalhada registrada no [ADR 0002: docs/adr/0002-diagnostico-hibrido-probe-datalake.md](docs/adr/0002-diagnostico-hibrido-probe-datalake.md).
