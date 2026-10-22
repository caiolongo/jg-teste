# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem, processadas em paralelo por várias instâncias e com processos morrendo no meio do caminho.

- **Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · SQS (LocalStack) · Docker Compose
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](ARCHITECTURE.md)

## Garantias

| Garantia | Como é obtida |
|---|---|
| Nunca saldo negativo | `CHECK (balance >= 0)` no banco + checagem no domínio sob lock |
| Nunca débito ou crédito duplicado | Idempotência persistente (`UNIQUE` em idempotency key e em provider + external id) + inbox por `(consumer, messageId)` |
| Saldo sempre explicado pelo ledger | Ledger append-only com cadeia verificada por trigger; bijeção saldo ↔ ledger checada no `COMMIT` |
| Sem lost update entre instâncias | `SELECT … FOR UPDATE` por wallet (sem lock global) + guarda de `version` |
| Nenhum evento perdido, nenhum publicado antes do commit | Transactional outbox na mesma transação SQL + publisher com `SKIP LOCKED` |
| Dinheiro exato | `bigint` em centavos no domínio, `NUMERIC(20,2)` no banco, `string` nos contratos. Nenhum `number` |

## Pré-requisitos

- Docker com Compose v2
- Bun ≥ 1.4 (`curl -fsSL https://bun.sh/install | bash`)

## Subindo

```bash
bun install
cp .env.example .env

# Opção A — tudo em containers, com 3 réplicas da aplicação (portas 3000–3002)
docker compose up -d --build --scale app=3 --wait

# Opção B — infraestrutura em containers, aplicação local (porta 3000)
bun run infra:up          # Postgres + LocalStack (filas criadas no boot)
bun run migrate:up
bun run start
```

Cada instância roda, no mesmo processo, a API HTTP, o consumer SQS, o outbox relay e o worker de referências pendentes. No Compose, um serviço `migrate` aplica as migrations uma única vez antes de as réplicas subirem.

> O LocalStack está fixado na versão `4.14.0`, a última imagem Community que sobe sem token de licença. Assim ninguém precisa de conta para rodar o projeto.

## Demonstração web (opcional)

```bash
bun run localweb      # = docker compose --profile localweb up -d --build --scale app=3 --wait
# abra http://localhost:8080
```

Uma página estática (HTML + JS, sem framework) servida por nginx, que faz proxy de `/api` para as 3 réplicas em rodízio. Ela usa só a API HTTP pública. Dá para criar carteiras, enviar transações, reenviar a última (replay), ver saldo, ledger e reconciliação, e rodar os cenários da seção 8, da mesma aposta 50× em paralelo, do conflito de idempotência, do ROLLBACK antes da BET e de saldo insuficiente. O painel de requisições mostra status, latência, **qual réplica respondeu** (`X-Instance-Id`) e o `X-Correlation-Id`. Sem o profile `localweb`, nada disso sobe.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run dev` | Sobe a aplicação (dev: com watch) |
| `bun run typecheck` | TypeScript strict, sem emitir |
| `bun run migrate:up` / `migrate:down` / `migrate:pending` | Migrations versionadas e reversíveis |
| `bun run infra:up` / `infra:down` | Postgres + LocalStack (`down` apaga os volumes) |
| `bun test` | Todos os testes (precisa de `infra:up`); ~1 min |
| `bun run test:unit` | Domínio e mapeamentos, sem I/O |
| `bun run test:integration` | Postgres e LocalStack reais |
| `bun run test:concurrency` | 3+ processos reais da aplicação, com `SIGKILL` |
| `bun run test:compose` | Checagem contra as 3 réplicas do Docker Compose (Opção A) |
| `bun run localweb` | 3 réplicas + demonstração web em http://localhost:8080 |
| `bun run test:load` | Teste de carga contra as 3 réplicas (Opção A), ~3 min. Metodologia, resultados e análise em [docs/LOAD_TEST.md](docs/LOAD_TEST.md) |

Os testes usam um banco próprio (`wagering_test`), recriado com todas as migrations `down` + `up` a cada arquivo, e filas SQS criadas por teste. Não interferem no ambiente de desenvolvimento.

## API HTTP

Todas as respostas trazem `X-Correlation-Id` (enviado pelo cliente ou gerado) e `X-Instance-Id` (a réplica que respondeu). Erros seguem `{ "error": { "code", "message", "details?" } }`.

| Método e rota | Sucesso | Observações |
|---|---|---|
| `POST /wallets` | 201 | Saldo inicial > 0 vira uma transação interna `OPENING` + lançamento `CREDIT`, na mesma transação SQL. Duplicada (player + moeda) → 409 |
| `GET /wallets/:walletId` | 200 | |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | 200 | Cursor opaco e estável (`limit` 1–200, padrão 50) |
| `POST /wagering/transactions` | 200 / 202 / 422 | Header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | 200 | |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | |
| `POST /wallets/:walletId/reconciliation` | 200 | Divergência é sinalizada, logada e contada, nunca corrigida |
| `GET /health/live`, `GET /health/ready` | 200 / 503 | Abertos. `ready` checa Postgres e SQS |
| `GET /metrics` | 200 | Prometheus |

### Status HTTP

Um código diz ao provedor o que fazer, sem ler a mensagem. O mapeamento é o mesmo em todos os endpoints.

| Status | Significado | O provedor deve |
|---|---|---|
| 200 | `PROCESSED` (também no replay, com `idempotentReplay: true`) | seguir |
| 201 | Wallet criada | seguir |
| 202 | `PENDING_REFERENCE`: aceita, aguardando a transação referenciada | consultar depois |
| 400 | Payload, valor, header ou cursor inválido | corrigir o payload |
| 404 | Wallet, transação ou rota inexistente | corrigir a referência |
| 409 | `IDEMPOTENCY_CONFLICT` (mesma key, outro payload) ou `WALLET_ALREADY_EXISTS` | não reenviar como está |
| 422 | `REJECTED` por regra de negócio, com `failureCode` e `providerAction` | seguir `providerAction` |
| 503 | Falha transitória (`Retry-After: 1`) | reenviar a mesma requisição |

### Exemplo

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# → 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

## Filas

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | Entrada (envelope `WagerTransactionRequested`, `MessageGroupId` = walletId). Redrive para a DLQ após 8 recebimentos |
| `wager-transactions-dlq.fifo` | Mensagens que não podem ser aplicadas, com o motivo nos atributos (`errorCode`, `errorDetail`, `originalMessageId`, `receiveCount`) |
| `wagering-events` | Saída do outbox: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference` e `WagerTransactionFailed`. Atributo `eventId` para deduplicação |

Enviar uma transação pela fila (local):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id <qualquer-id> \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124",
    "playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

## Testes × seção 13 do desafio

Toda bateria termina com a invariante `wallet.balance == saldo reconstruído pelo ledger`, verificada pela reconciliação.

| Exigência | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `test/unit/domain/money.test.ts` |
| Invariantes da Wallet e do ledger | `test/unit/domain/wallet.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK; conflito de moeda | `test/unit/domain/wager-settlement.test.ts` |
| Idempotency key com payload divergente | `test/unit/domain/wager-transaction.test.ts`, `test/integration/use-cases.test.ts` |
| Migrations e constraints | `test/integration/migrations.test.ts`, `test/integration/schema.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/integration/repositories.test.ts` |
| Inbox, redelivery, retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/outbox.test.ts` |
| 1 · Mesma aposta 50× em paralelo | `test/concurrency/multi-instance.test.ts` (HTTP e SQS, 3 processos) |
| 2 · Disputa pelo saldo (cenário da seção 8) | `test/concurrency/multi-instance.test.ts` |
| 3 · Wallets distintas em paralelo | `test/concurrency/multi-instance.test.ts` |
| 4 · ≥ 3 instâncias | `test/concurrency/*` (processos reais) e `bun run test:compose` (3 réplicas Docker) |
| 5 · Worker morto depois do commit e antes do ack | `test/concurrency/crash-recovery.test.ts` (`SIGKILL` real) |
| 6 · Dois publishers; publisher morto antes do commit | `test/integration/outbox.test.ts`, `test/concurrency/crash-recovery.test.ts` |
| 7 · `ROLLBACK`/`REFUND` antes da referência | `test/concurrency/multi-instance.test.ts`, `test/integration/pending-reference-worker.test.ts` |
| 8 · Reinício com consistência final | `test/concurrency/crash-recovery.test.ts` (`SIGKILL` nas 3 instâncias sob carga) |

## Configuração

Todas as variáveis são validadas no boot: com configuração inválida, a instância não sobe. Veja `.env.example` e `src/config/env.ts`.

| Variável | Padrão | Uso |
|---|---|---|
| `LOCK_TIMEOUT_MS` | 5000 | Espera máxima pelo lock de uma wallet; estourou → 503 / retry na fila |
| `SQS_CONSUMER_ENABLED`, `OUTBOX_RELAY_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | true | Liga/desliga cada laço em segundo plano |
| `SQS_CONSUMER_CONCURRENCY` | 4 | Pollers por instância |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | 5 / 300 | Backoff de erro transitório (visibility timeout) |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `PENDING_REFERENCE_BASE_DELAY_MS` | 8 / 15000 | Orçamento de espera por referência (~32 min) |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` | 100 / 500 | Publicação da outbox (enviada em lotes paralelos de 10) |
| `SHUTDOWN_TIMEOUT_MS` | 25000 | Drenagem no `SIGTERM` (abaixo dos 30 s do Compose) |

`FAULT_*` existem só para os testes de crash e ficam desligadas por padrão (ver ARCHITECTURE.md).

## Estrutura

```text
src/
  domain/          Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras (TypeScript puro)
  application/     use cases e portas (UnitOfWork, repositórios, publisher, relógio, logger, métricas)
  infrastructure/  MikroORM (schemas, mappers, repositórios, migrations), SQS, observabilidade
  interfaces/      HTTP (controllers, validação, erros), consumer SQS, workers
  app.module.ts    composição (sem decorators do Nest nas camadas internas)
test/
  unit/  integration/  concurrency/
infra/localstack/  criação das filas
infra/nginx/       proxy da demonstração web
web/               demonstração web (profile localweb)
scripts/           checagem do deploy com 3 réplicas
```
