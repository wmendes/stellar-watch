# ADR 0002: Diagnóstico Híbrido no Comando Probe e Fallback para Data Lake

- **Status:** Aceito
- **Data:** 2026-09-07
- **Contexto de Domínio:** `stellar-watch` (CLI e Monitor de Rede Stellar / Soroban)

---

## Contexto e Problema

Na arquitetura da rede Stellar e do Soroban RPC:
1. **Dados Quentes (Nós RPC):** As instâncias de RPC mantêm em memória rápida apenas uma janela limitada de ledgers recentes (`oldestLedger` até `latestLedger`). Solicitações de transações ou ledgers abaixo de `oldestLedger` falham com o código JSON-RPC `-32600` (Invalid Request), a menos que o provedor tenha um archive integrado.
2. **Dados Frios (Data Lake na Nuvem):** O histórico completo e imutável da blockchain Stellar (desde os blocos gênesis) é persistido no Data Lake público hospedado no Amazon S3 via programa AWS Open Data (`aws-public-blockchain.s3.amazonaws.com`), consumido pelo módulo `lake.ts`.
3. **Lacuna no Diagnóstico:** O comando `probe` original avaliava se o RPC furava a janela de histórico (`deepHistory`), mas, se a resposta fosse negativa, não oferecia nenhum diagnóstico alternativo ao desenvolvedor, nem indicava se o Data Lake público estava acessível para consultas históricas.

---

## Decisão Arquitetural

Decidimos expandir o comando `probe` para operar como um **diagnosticador híbrido**:

1. **Separação Visual Clara no Terminal:**
   - Exibe a seção de **Dados do Servidor RPC (Dados Quentes)** com status, protocolo e janela de retenção em dias.
   - Exibe a seção de **Diagnóstico de Dados Frios & Data Lake**, informando a viabilidade de consultas históricas.

2. **Checagem Resiliente de Conectividade com o Data Lake (AWS S3):**
   - Quando o nó de RPC não possui histórico profundo acoplado (`deepHistory: false`), o comando executa automaticamente uma requisição `HEAD` contra o bucket do S3 público.
   - A requisição utiliza `AbortController` com timeout de 3 segundos para evitar bloqueios ou atrasos em caso de instabilidade de rede/DNS.

3. **Feedback Acionável (Actionable Guidance):**
   - Se o Data Lake estiver online, o CLI orienta expressamente o desenvolvedor sobre como consultar ledgers arquivados que excederam a retenção do RPC:
     `👉 pnpm run lake <ledger>`

---

## Consequências

### Positivas
- **Ponte Teoria-Prática:** Reflete diretamente a distinção entre armazenamento quente (nós RPC) e armazenamento frio (Data Lake) abordada no curso.
- **Eficiência de Rede:** O teste no S3 é feito via método `HEAD`, consumindo zero tráfego de download de dados e retornando em menos de 100ms.
- **Resiliência:** O uso de `AbortController` impede que o comando `probe` fique travado indefinidamente caso o ambiente tenha restrições de proxy ou firewall.
- **Zero Impacto Retroativo:** Nenhuma assinatura de função pública ou script existente foi quebrado.

### Negativas / Trade-offs
- O comando `probe` realiza uma chamada HTTP adicional caso o nó de RPC não tenha data lake integrado. Esse efeito é mitigado pelo timeout estrito de 3 segundos.
