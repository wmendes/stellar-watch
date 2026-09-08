# ADR 0001: Injeção de Dependências e Seams para Testabilidade

- **Status:** Aceito
- **Data:** 2026-09-07
- **Contexto de Domínio:** `stellar-watch` (CLI e Monitor de Rede Stellar / Soroban)

---

## Contexto e Problema

O `stellar-watch` foi concebido como um CLI pedagógico e ferramenta de monitoramento da rede Stellar e do Soroban RPC. Na implementação original:

1. **Singleton Global de RPC:** O módulo `config.ts` instanciava e exportava um objeto `rpc` único (`new StellarSdk.rpc.Server(...)`), consumido diretamente por `read.ts`, `pay.ts` e `probe.ts`.
2. **Acoplamento de Credenciais a Nível Profundo:** O módulo `pay.ts` lia diretamente `process.env.STELLAR_SECRET_KEY` dentro da função interna de geração de chaves.
3. **Efeitos Colaterais na Importação:** Variáveis de ambiente eram validadas no momento da avaliação do módulo `config.ts`, exigindo o uso de imports dinâmicos (`await import(...)`) em `index.ts` para evitar que comandos como `--help` falhassem na ausência de arquivo `.env`.
4. **Impossibilidade de Testes em CI/CD:** Sem uma conexão real com a internet e nós de rede ativos (Testnet/Mainnet), nenhuma função do sistema podia ser testada de forma determinística em pipelines automatizados de integração contínua.

---

## Decisão Arquitetural

Decidimos introduzir **seams** (pontos de costura arquitetural) por meio de injeção de dependências:

1. **Interface Estrutural `RpcAdapter`:**
   - Criamos uma interface que descreve apenas as operações de RPC consumidas pela aplicação (`getHealth`, `getLatestLedger`, `getLedgers`, `getLedgerEntries`, `getAccount`, `simulateTransaction`, `sendTransaction`, `getTransaction`).
   - O objeto `StellarSdk.rpc.Server` nativo já satisfaz essa interface diretamente, dispensando wrappers complexos em produção.
   - Em ambiente de testes, permite conectar um `MockRpcAdapter` determinístico e em memória.

2. **Injeção com Fallback Transparente (100% Retrocompatível):**
   - As funções públicas dos módulos continuam com as mesmas assinaturas básicas e aceitam o adapter de RPC e o `signer` como argumentos opcionais.
   - Caso nenhum adapter seja injetado, o sistema assume transparentemente a configuração padrão do `.env`.
   - Dessa forma, nenhum comando CLI existente (`pnpm probe`, `pnpm read`, etc.) sofre alterações ou quebras.

3. **Desacoplamento do Signer:**
   - A operação de pagamento passa a aceitar um objeto `Signer` (interface estrutural com `publicKey()` e `sign()`, atendida nativamente por `StellarSdk.Keypair`), permitindo assinar transações com diferentes contas em um mesmo processo ou com chaves efêmeras em testes.

4. **Suíte de Testes com Vitest:**
   - Adiciona-se o Vitest com testes unitários cobrindo leitura de XDR, montagem de transação e tratamento de erros sem tráfego de rede.

---

## Consequências

### Positivas
- **Testabilidade em CI/CD:** Testes unitários executam em milissegundos sem gastar taxas, sem depender de nós públicos da Stellar e sem expor chaves secretas no repositório.
- **Reutilização como Biblioteca:** As funções agora podem ser consumidas programaticamente por outras ferramentas e scripts em Node.js com múltiplas contas e nós arbitrários.
- **Previsibilidade:** Elimina falhas precoces em tempo de importação e simplifica o fluxo de execução.
- **Zero Breaking Changes:** O CLI preserva exatamente o mesmo comportamento, parâmetros de terminal e formatação esperada para o usuário.

### Negativas / Trade-offs
- Adição de novos tipos (`RpcAdapter`, `Signer`) e sobrecarga opcional nas assinaturas de função.
- Necessidade de manter mocks alinhados aos tipos do `@stellar/stellar-sdk` na suíte de testes.
