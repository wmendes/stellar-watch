# Domain Context: StellarWatch

Este documento define o vocabulário e conceitos de domínio do projeto `stellar-watch`, garantindo consistência arquitetural entre código, documentação e testes.

---

## 1. Glossário de Domínio

### StellarWatchClient
O **módulo** principal que concentra o comportamento de interação com a rede Stellar/Soroban. Oferece uma **interface** enxuta e coesa para os chamadores (CLI, testes, automações), encapsulando detalhes de conexão de rede, chaves criptográficas e políticas de resiliência.

### RPC Adapter (Seam de Rede)
O **seam** onde o cliente se conecta ao nó Soroban RPC. 
- **Adapters concretos**:
  - `SorobanRpcAdapter` (produção): encapsula `rpc.Server` da biblioteca `@stellar/stellar-sdk`.
  - `MockRpcAdapter` (testes): simula respostas de ledger e transações sem tráfego de rede real.

### Signer (Seam de Assinatura)
O **seam** responsável por autorizar transações com credenciais criptográficas.
- **Adapters concretos**:
  - `KeypairSigner`: utiliza uma chave privada carregada na borda da aplicação (variável de ambiente no CLI).
  - `MockSigner`: chave efêmera ou dummy para execução determinística em testes unitários.

### Probe
Diagnóstico de conectividade e sincronia com a rede Stellar. Mede latência do RPC, último ledger fechado e disponibilidade da rede.

### Payment
Operação de transferência de fundos nativos ou tokens Soroban. Envolve construção de transação, resolução de sequence number, assinatura via `Signer`, submissão ao RPC e monitoramento de status com retry.

### Lake
Ingestão contínua de eventos, transações e alterações de estado da blockchain para armazenamento e análise analítica local ou remota.
