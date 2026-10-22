# Arquitetura

Este documento registra as decisões técnicas, o porquê de cada uma, os trade-offs aceitos e as limitações conhecidas. Setup e comandos estão no [README.md](README.md).

## 1. Visão geral

**Monólito modular com arquitetura hexagonal (portas e adaptadores), modelagem tática de DDD e integração orientada a eventos via transactional outbox.**

- **Monólito:** saldo, ledger, inbox e outbox precisam entrar no mesmo `COMMIT`. Separar em serviços exigiria sagas ou commit distribuído para garantir o que um banco único garante com uma transação.
- **Hexagonal:** HTTP e SQS chamam o mesmo use case; PostgreSQL e SQS são adaptadores atrás de portas. O domínio não importa NestJS, MikroORM nem AWS SDK.
- **DDD tático:** aggregate root (`Wallet`), value object (`Money`), máquina de estados explícita (`WagerTransaction`), lançamento imutável (`WalletLedgerEntry`), construtores privados com factories `create` / `rehydrate`.

```text
            ┌──────────────── uma instância (escala horizontal: N iguais) ─────────────────┐
  HTTP ───▶ │ Controllers ─┐                                                               │
  SQS  ───▶ │ Consumer ────┼──▶ ProcessWagerTransaction ──▶ settleWagerTransaction (domínio)│
            │ Worker ──────┘            │  (uma transação SQL)                              │
            │ OutboxRelay ──────────────┼─────────────────────────────┐                     │
            └───────────────────────────┼─────────────────────────────┼─────────────────────┘
                                        ▼                             ▼
                          PostgreSQL: wallets, wager_transactions,   SQS: wagering-events
                          wallet_ledger_entries, inbox, outbox
```

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `settleWagerTransaction`, `FailureCode` | nada (só `node:crypto` para SHA-256) |
| `src/application` | Use cases e portas (`UnitOfWork`, repositórios, `EventPublisher`, `Clock`, `IdGenerator`, `AppLogger`, `Metrics`) | domínio |
| `src/infrastructure` | MikroORM, SQS, pino, prom-client, injeção de falha | aplicação, domínio |
| `src/interfaces` | Controllers HTTP, consumer SQS, workers, health | aplicação |
| `src/app.module.ts` | Raiz de composição: liga portas a adaptadores por factory | tudo |

As classes de aplicação não usam decorators do Nest. São criadas por factory no módulo, então domínio e use cases são testáveis sem framework.

## 2. Modelo de domínio

### Money

- **Representação:** `bigint` em centavos (escala fixa 2). Nenhuma operação usa `number`; `0.10 + 0.20` é exatamente `0.30`.
- **Contrato:** `{ "amount": "25.00", "currency": "BRL" }`. A entrada aceita 0 a 2 casas e normaliza para 2 (`"25"` → `"25.00"`). Mais de 2 casas é erro, **nunca arredonda**.
- **Rejeitados:** `NaN`, `Infinity`, notação científica, string vazia, espaços, sinal, zeros à esquerda, valor numérico em vez de string, negativos em contratos de entrada, mais de 18 dígitos inteiros (não caberia em `NUMERIC(20,2)`), moeda fora de `^[A-Z]{3}$`.
- Imutável. Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda; os testes usam BRL e USD para provar o conflito.

**Mapeamento na persistência:** `NUMERIC(20,2)` no PostgreSQL, lido pelo driver como string decimal (`"975.00"`) e reidratado com `Money.from`. O valor nunca passa por `float` em nenhuma camada.

### Wallet (aggregate root)

- `Wallet.open` cria a wallet com `version = 1`. Se o saldo inicial for positivo, devolve também o lançamento `CREDIT` de abertura (de 0 até o saldo inicial).
- `debit` / `credit` são a única forma de mudar o saldo e **sempre devolvem o lançamento do ledger** que explica a mudança, com saldo antes, saldo depois e a nova `version`. Assim, saldo e ledger não têm como divergir no código.
- `version` incrementa somente quando o saldo muda.

### WagerTransaction: estados

```text
PENDING ──┬──▶ PROCESSED
          ├──▶ REJECTED
          ├──▶ FAILED
          └──▶ PENDING_REFERENCE ──┬──▶ PENDING_REFERENCE (nova tentativa, backoff)
                                   ├──▶ PROCESSED
                                   ├──▶ REJECTED
                                   └──▶ FAILED
PROCESSED, REJECTED e FAILED são terminais.
```

Transicionar uma transação terminal lança `InvalidTransactionStateError`, que é erro de programação, nunca uma resposta ao provedor. O banco reforça a mesma regra por trigger. `rehydrate` reconstrói o estado persistido sem revalidar transições.

**Quando cada estado terminal acontece:** `PROCESSED`, quando a transação é aplicada (inclusive `LOSS`). `REJECTED`, quando viola uma regra de negócio. `FAILED`, quando o reprocessamento de uma transação já gravada (`PENDING_REFERENCE`) falha por erro **não transitório**, como dado inconsistente ou bug: repetir falharia para sempre, então ela é encerrada com `PROCESSING_FAILED` e o evento `WagerTransactionFailed`. Erros transitórios nunca levam a `FAILED`; a transação continua pendente. Erros permanentes **antes** de a transação existir (contrato inválido, conflito, wallet inexistente) não geram linha: viram 4xx na API ou DLQ na fila.

`OPENING` é interno: nasce `PROCESSED` junto com a wallet e não é aceito pela API nem pela fila.

### WalletLedgerEntry

Só tem campos `readonly`, nenhum método de transição, e o construtor chama `Object.freeze`. A imutabilidade vale também em tempo de execução. `create` valida que `balanceBefore ± money === balanceAfter`, que o valor é positivo e que o saldo resultante não é negativo.

### Adaptações de assinatura (a seção 6 permite)

| Desafio | Aqui | Por quê |
|---|---|---|
| `Wallet.open(props): Wallet` | devolve `{ wallet, openingEntry }` | A abertura com saldo precisa produzir o lançamento correspondente |
| `markPendingReference()` | `markPendingReference(at, policy)` | Conta a tentativa e agenda a próxima com backoff exponencial |
| `reject(code)` | `reject(code, observedBalance, at)` | O replay precisa devolver o saldo observado naquele momento (regra 7) |
| `Decimal` em `Money` | `bigint` em centavos | Sem dependência externa; exatidão garantida pela aritmética inteira |
| — | `walletVersion` no lançamento | Chave da cadeia do ledger no banco e cursor estável da paginação |

## 3. Persistência e ORM

**MikroORM 7** (opção preferencial), usado assim:

- **`EntitySchema` com records planos, sem decorators**, mais mappers que convertem para o domínio sempre via `rehydrate`. As entidades de domínio não conhecem o ORM.
- **Estratégia transacional:** a porta `UnitOfWork.run(repos => …)` abre `em.fork().transactional()` e entrega repositórios presos àquela transação. Tudo o que um use case escreve (transação, wallet, ledger, inbox, outbox) commita junto ou é desfeito junto.
- **Leituras** com `disableIdentityMap`, para que uma leitura com `FOR UPDATE` nunca devolva uma cópia em cache.
- **Escritas** nativas (`insert`, `nativeUpdate`, `INSERT … ON CONFLICT DO NOTHING`), na ordem exata do use case. A ordem importa por causa das FKs e dos triggers diferidos, e não depende da ordenação de flush do Unit of Work.
- **Locks** com `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) na wallet e `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) nos workers.
- **Erros:** cada transação faz `SET LOCAL lock_timeout`. Lock timeout, deadlock, falha de serialização e erros de conexão viram `TransientInfrastructureError` (503 na API, retry na fila).

**Migrations:** 3 versões em `src/infrastructure/persistence/migrations/`, todas com `down`, listadas explicitamente em código. O teste de migrations desce tudo até zero, confere que não sobrou objeto algum e sobe de novo. No Compose, um serviço `migrate` roda uma única vez antes das réplicas, para que elas não disputem o schema no boot.

## 4. Garantias no schema

A seção 5 (item 9) exige que unicidade, imutabilidade e não negatividade estejam no banco. Elas valem para qualquer processo que escreva no banco, não só para este código.

| Tabela | Garantias |
|---|---|
| `wallets` | `UNIQUE(player_id, currency)` · `CHECK(balance >= 0)` · `CHECK(version >= 1)` · moeda ISO. **Trigger:** nasce com `version = 1`; id, player e moeda imutáveis; saldo muda ⇔ `version + 1`; nunca é apagada. **Trigger diferido (no COMMIT):** toda mudança de saldo tem um lançamento com `wallet_version = version` e `balance_after = balance` |
| `wager_transactions` | `UNIQUE(idempotency_key)` · `UNIQUE(provider_id, external_transaction_id)` · `CHECK` de kind e status · valor > 0 exceto `LOSS` · referência obrigatória em `REFUND`/`ROLLBACK` e proibida em `BET` · coerência entre status e `processed_at` / `failure_code` / `next_reference_attempt_at`. **Índice único parcial** `(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` (uma reversão por transação). **Trigger:** nunca é apagada; campos de negócio imutáveis; status terminal é final; `PENDING_REFERENCE` não volta a `PENDING` |
| `wallet_ledger_entries` | `CHECK(amount > 0)` · `CHECK(balance_before >= 0 AND balance_after >= 0)` · `CHECK(balance_after = balance_before ± amount)` · `UNIQUE(transaction_id, wallet_id)` · `UNIQUE(wallet_id, wallet_version)` · FK composta `(wallet_id, currency)` → wallets (lançamento na moeda da wallet) · FK composta `(transaction_id, wallet_id)` → wager_transactions. **Triggers:** bloqueia `UPDATE`, `DELETE` e `TRUNCATE`; cadeia sem buracos (cada `balance_before` é o `balance_after` anterior; o primeiro parte de 0); diferido: o lançamento precisa estar refletido na wallet |
| `inbox_messages` | Chave primária `(consumer_name, message_id)` |
| `outbox_messages` | PK = `eventId`; índice parcial dos pendentes; publicado não pode estar agendado |

O resultado é uma **bijeção entre saldo e ledger verificada pelo próprio banco**: não há como commitar uma mudança de saldo sem lançamento, nem um lançamento que a wallet não reflita.

## 5. Concorrência

A unidade de concorrência é a `walletId`.

**Estratégia: lock pessimista por wallet** (`SELECT … FOR UPDATE` na linha da wallet), dentro da transação que aplica a operação.

| Alternativa | Por que não |
|---|---|
| Lock otimista (`version`) com retry | Numa *hot wallet* (muitas apostas na mesma carteira) gera uma tempestade de conflitos e retries. O pessimista enfileira, e cada operação passa uma vez |
| `UPDATE … SET balance = balance - x WHERE balance >= x` | Rápido, mas o ledger precisa do saldo antes e depois, e as reversões precisam ler e validar a referência. Com a linha travada, tudo isso é simples e correto |
| Lock global ou advisory lock único | Proibido pelo desafio e serializaria wallets independentes |

Camadas de defesa:

1. `FOR UPDATE` serializa quem mexe na mesma wallet. Wallets diferentes nunca esperam umas pelas outras.
2. O `UPDATE` da wallet tem guarda de versão (`WHERE id = ? AND version = <carregada>`). Se mudar, gera `ConcurrencyConflictError`, que é transitório.
3. `CHECK(balance >= 0)` e os triggers do ledger são a última barreira, mesmo contra um bug.
4. `lock_timeout` (padrão 5 s): uma hot wallet não segura conexões indefinidamente. Estourou, vira 503 na API ou retry na fila, e conta em `wagering_lock_conflicts_total`.

**Workers sem coordenador:** outbox relay e worker de referências pendentes rodam em todas as instâncias e reivindicam linhas com `FOR UPDATE SKIP LOCKED`. Cada instância pega um lote disjunto, sem eleição de líder.

**Deadlock evitado por desenho:** o caminho principal trava a wallet e depois "acorda" as transações pendentes que esperavam por ela. O worker trava a pendente e depois a wallet. Como essas são ordens inversas, o "acordar" usa `SKIP LOCKED`: se o worker já está com a linha, o caminho principal pula, sem esperar.

**Ordenação:** a fila FIFO usa `MessageGroupId = walletId` e o consumer processa em ordem dentro do grupo. Isso é **otimização**: a correção não depende da ordem de chegada. Referências fora de ordem viram `PENDING_REFERENCE`, e duplicatas são absorvidas pelo banco.

## 6. Idempotência

- **Chave:** o header `Idempotency-Key` (ou `data.idempotencyKey` na fila) é a fonte da verdade. Default recomendado: `{providerId}:{externalTransactionId}`.
- **`payloadHash`:** SHA-256 hexadecimal do **JSON canônico** (chaves ordenadas recursivamente, campos `undefined` omitidos) de `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado, então `"25"` e `"25.00"` são iguais) e `referenceExternalTransactionId`. Ficam de fora: header, `messageId`, `idempotencyKey` e campos desconhecidos do corpo.
- **Persistência:** `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`. Não existe cache em memória.
- **Corrida:** duas cópias chegam juntas, as duas não encontram nada, as duas tentam inserir. A inserção usa `ON CONFLICT DO NOTHING`, e o PostgreSQL faz a segunda esperar a primeira commitar. A segunda recebe "já existe" **sem abortar a transação**, relê a linha e responde como replay. Testado com 50 cópias em paralelo, distribuídas entre 3 processos.
- **Replay:** devolve o resultado original, inclusive o saldo observado naquele momento (`result_balance` + `result_currency`), o mesmo status HTTP e `idempotentReplay: true`.
- **Conflito:** a mesma key com outro payload, ou o mesmo external id com outra key, gera 409 `IDEMPOTENCY_CONFLICT`, com o id da transação existente. Nunca é tratado como replay.
- **Inbox:** na fila, `(consumerName, messageId)` é inserido **na mesma transação SQL** do efeito financeiro. Uma redelivery encontra a linha e só recebe ack.

## 7. Fluxo do processamento

Tudo entre `BEGIN` e `COMMIT` é uma única transação SQL:

1. Fora do banco: valida o contrato (zod), `Money.from`, calcula o hash, cria a transação candidata.
2. `BEGIN`. Na fila: inbox `ON CONFLICT DO NOTHING`; se já existia, ack.
3. Busca por key ou por (provider, external id), **sem lock**: mesmo payload devolve replay; payload diferente devolve 409.
4. `FOR UPDATE` na wallet. Wallet inexistente: 404 na API, DLQ na fila.
5. `INSERT … ON CONFLICT DO NOTHING` da transação. Se perdeu a corrida, relê e devolve replay.
6. Resolve a referência por `(providerId, referenceExternalTransactionId)` e verifica se ela já foi revertida.
7. `settleWagerTransaction`: as regras da seção 7, numa função pura do domínio.
8. Grava a transação. Se o saldo mudou: wallet (`version + 1`) e lançamento. Eventos na outbox. Antecipa as pendentes que esperavam por esta transação.
9. Marca a inbox como processada. `COMMIT`. **Só então** sai a resposta HTTP ou o ack na fila.

Nenhuma escrita acontece antes do lock da wallet, e o replay não espera lock.

## 8. Regras de negócio e interpretações

As regras da seção 7 estão em `src/domain/wager/wager-settlement.ts`. Ordem das checagens: moeda → player → referência (contexto → tipo → status → já revertida → valor) → saldo.

| Operação | Saldo | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | proibida |
| `WIN` | crédito | 1 `CREDIT` | opcional, deve ser uma `BET` |
| `LOSS` | — | — | opcional, deve ser uma `BET` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória, só `BET` |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | obrigatória: `BET`, `WIN` ou `REFUND` |

**Interpretações adotadas** (o desafio pede que sejam documentadas):

1. **Uma reversão por transação, no total.** A regra 4 diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". Lida ao pé da letra, uma `BET` aceitaria um `REFUND` e também um `ROLLBACK`, creditando duas vezes. Adotamos uma reversão no total, garantida pelo índice único parcial. Desfazer um `REFUND` continua possível: o `ROLLBACK` referencia o `REFUND`, não a `BET`.
2. **Valor zero:** `BET`, `WIN`, `REFUND` e `ROLLBACK` exigem valor > 0 (400). `LOSS` aceita 0, porque não move saldo. Assim, toda operação que move saldo gera lançamento e incrementa `version`, sem caso especial.
3. **Referência ainda não terminal** (`PENDING` / `PENDING_REFERENCE`) é tratada como ausente: a transação espera.
4. **Referência `REJECTED`/`FAILED`:** a transação é rejeitada com `REFERENCE_NOT_PROCESSED`.
5. **`ROLLBACK` não referencia outro `ROLLBACK`.**
6. **Reversão sem saldo:** `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS` (regra 9). Fica auditável como `REJECTED`.
7. **Wallet inexistente:** nada é gravado (a FK impede). A API responde 404; na fila a mensagem vai para a DLQ.
8. **Eventos do `OPENING`:** `WalletBalanceChanged` e `WagerTransactionProcessed` com `kind = OPENING`. Consumidores filtram por kind.

### Referências fora de ordem (seção 7.1)

A transação fica `PENDING_REFERENCE` (HTTP 202, evento `WagerTransactionPendingReference`). O worker reprocessa com backoff exponencial: **8 buscas, espera de 15 s · 2^(n−1) entre elas, a última cerca de 32 min após a chegada**. Esgotado o orçamento, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected` é publicado.

*Justificativa:* 32 minutos absorvem atrasos normais de rede, fila e reprocessamento do provedor sem deixar transações abertas indefinidamente. Quando a referência chega, as pendentes que a aguardavam são antecipadas para a próxima rodada do worker, então na prática a resolução leva cerca de 1 segundo e não 15. Os valores são configuráveis por variável de ambiente.

### Códigos de falha (seção 7.2)

Cada código traz um `providerAction` legível por máquina.

| `failureCode` | Situação | `providerAction` |
|---|---|---|
| `INSUFFICIENT_FUNDS` | Aposta sem saldo | `DO_NOT_RETRY` |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão deixaria o saldo negativo | `CONTACT_SUPPORT` |
| `CURRENCY_MISMATCH` | Moeda da operação ≠ moeda da wallet | `FIX_PAYLOAD` |
| `PLAYER_WALLET_MISMATCH` | Player não é dono da wallet | `FIX_PAYLOAD` |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro do orçamento | `FIX_PAYLOAD` |
| `REFERENCE_MISMATCH` | Referência de outro player, wallet, moeda ou rodada | `FIX_PAYLOAD` |
| `INVALID_REFERENCE_KIND` | Tipo de referência não permitido (ex.: `REFUND` de um `WIN`) | `FIX_PAYLOAD` |
| `REFERENCE_NOT_PROCESSED` | Referência terminou `REJECTED`/`FAILED` | `DO_NOT_RETRY` |
| `ALREADY_REVERSED` | Referência já revertida | `DO_NOT_RETRY` |
| `AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | `FIX_PAYLOAD` |
| `PROCESSING_FAILED` | Status `FAILED`: reprocessamento falhou por erro não transitório | `CONTACT_SUPPORT` |

## 9. API HTTP

O mapeamento de status é único (`mapErrorToHttp`) e consistente em todos os endpoints: 400 payload inválido, 404 recurso inexistente, 409 conflito, 422 rejeição de negócio, 202 pendente, 503 transitório (`Retry-After`). As respostas 503 não expõem detalhes internos. A validação acontece em duas camadas: zod confere a forma, o domínio confere o valor.

O cursor do ledger é o `walletVersion` do último item (base64url com o id da wallet). Como a versão é única e sem buracos por wallet, as páginas não pulam nem repetem lançamentos quando entram lançamentos novos, ao contrário de `OFFSET`.

## 10. Processamento por SQS

O consumer chama o mesmo `ProcessWagerTransaction` da API, com os dados da inbox. Faz ack só depois que o use case retorna, ou seja, depois do `COMMIT`.

**Classificação de erros** — o critério é: repetir pode dar outro resultado, e o problema já ficou registrado?

| Situação | Reação | Por quê |
|---|---|---|
| `PROCESSED`, replay, mensagem duplicada | ack | Já aplicado e gravado |
| `REJECTED`, `PENDING_REFERENCE` (negócio) | ack | Já gravado e com evento na outbox; repetir dá o mesmo resultado |
| Infraestrutura (Postgres fora, lock timeout, deadlock) | sem ack; visibility `5 s · 2^(n−1)`, teto 5 min | Tende a se resolver sozinho |
| Erro inesperado | igual ao transitório | Pode ser transitório não previsto; o limite abaixo encerra |
| Envelope ou JSON inválido, valor inválido, `kind` proibido, conflito de idempotência, wallet inexistente (permanente) | **DLQ imediatamente**, com `errorCode`, `errorDetail`, `originalMessageId`, `receiveCount` | Nenhuma repetição conserta, e nada foi gravado: um ack faria a mensagem sumir sem rastro |

Só se faz ack de erro de negócio porque ele **já está persistido e publicado**. Erros transitórios persistentes são movidos para a DLQ pelo próprio SQS após `maxReceiveCount = 8` recebimentos (cerca de 10 minutos de tentativas, o suficiente para um restart do banco).

**FIFO:** as mensagens de um grupo (wallet) são processadas em ordem; se uma falha transitoriamente, o resto do grupo naquele lote é devolvido à fila. Grupos diferentes rodam em paralelo (`SQS_CONSUMER_CONCURRENCY` pollers por instância).

**SIGTERM:** a readiness passa a responder 503, o long poll é abortado, as mensagens em andamento terminam (até `SHUTDOWN_TIMEOUT_MS`) e as recebidas e ainda não iniciadas voltam à fila com visibility 0. Isso acontece antes de o ORM fechar o pool.

## 11. Transactional outbox

Os eventos são gravados na tabela `outbox_messages` **na mesma transação SQL** do efeito financeiro. O `OutboxRelay` roda em todas as instâncias:

```text
BEGIN → claim due rows FOR UPDATE SKIP LOCKED (lote ≤ 100) → SendMessageBatch de 10, em paralelo
      → um UPDATE marca o lote publicado / retry agendado por linha → COMMIT
```

- **Nunca antes do commit:** em `READ COMMITTED`, o relay simplesmente não enxerga um evento cuja transação não commitou. Há um teste que prova isso.
- **Vários publishers:** as linhas ficam travadas durante a publicação, e os outros publishers pulam essas linhas.
- **Crash depois de o broker aceitar e antes do `COMMIT`:** os locks somem com a conexão, e outra instância republica. O evento sai **duplicado, com o mesmo `eventId`**, nunca perdido. Consumidores deduplicam pelo `eventId` (atributo da mensagem e campo do envelope).
- **Broker fora:** `attempts` + 1, `last_error`, próxima tentativa em `1 s · 2^(n−1)` com teto de 5 min. Sem limite de tentativas: evento confirmado não pode ser descartado.
- **Destino:** fila standard `wagering-events`. A ordem não é garantida pelo transporte; consumidores ordenam por `walletVersion` (`WalletBalanceChanged`) e `occurredAt`.
- **Envelope:** classe abstrata `IntegrationEvent<T>` com `eventType` e `version` definidos em cada subclasse. `data` usa `MoneyProps` (string), nunca a instância de `Money`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected` | Rejeição por regra de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | Somente quando o saldo muda (um por lançamento), com `walletVersion` |
| `WagerTransactionPendingReference` | A cada tentativa sem a referência |
| `WagerTransactionFailed` | Além do mínimo exigido: transação encerrada como `FAILED` |

**Tamanho do lote (medido):** a primeira versão publicava 10 eventos por rodada e marcava cada um com um `UPDATE`. No teste de carga isso represou 18 mil eventos, com atraso p50 de 13 s. Com lote de 100, envio em paralelo e um único `UPDATE` por lote, o atraso p50 caiu para menos de 1 s na maioria das rodadas ([docs/LOAD_TEST.md](docs/LOAD_TEST.md)).

**Trade-off:** a transação do relay fica aberta durante a chamada ao SQS. Descartei um esquema de *lease* (coluna `locked_until`, commit antes de publicar) porque acrescenta estado e recuperação de lease. Com o lote enviado em paralelo e timeout curto do SDK, a transação dura milissegundos.

## 12. Observabilidade

- **Logs:** pino em JSON. Um `AsyncLocalStorage` carrega `correlationId` (do header `X-Correlation-Id` ou gerado; na fila, o `messageId`) e `messageId`, e o pino os carimba em toda linha, sem passá-los de função em função. Os use cases registram `transactionId`, `walletId`, `providerId`, kind, status e `failureCode`, **nunca valores ou payloads**. `redact` em `money`, `amount`, `balance`, `payload`, `body` e `data` é a garantia extra. Os logs do Nest passam pelo mesmo logger.
- **Métricas** (`GET /metrics`, Prometheus):

  | Métrica | Exigência da seção 12 |
  |---|---|
  | `wagering_transactions_total{status,kind}` | transações por status |
  | `wagering_duplicates_detected_total{source}` | duplicatas (replay idempotente, inbox) |
  | `wagering_retries_total{source}` | retries (consumer, outbox) |
  | `wagering_dlq_messages_total{reason}` | mensagens em DLQ |
  | `wagering_lock_conflicts_total{kind}` | conflitos de lock (`lock_timeout`, `deadlock`, `version`) |
  | `wagering_outbox_lag_seconds`, `wagering_outbox_pending` | outbox lag |
  | `wagering_processing_duration_seconds{outcome}` | latência de processamento |

  Também há: `wagering_idempotency_conflicts_total`, `wagering_reconciliation_divergences_total`, `wagering_outbox_published_total`, `wagering_outbox_publish_failures_total`, `wagering_http_request_duration_seconds{method,route,status}` (rota pelo template, para não explodir a cardinalidade) e as métricas padrão do processo.
- **Health:** `/health/live` só verifica o processo, para que uma queda do banco não reinicie containers saudáveis. `/health/ready` checa Postgres (`select 1`) e SQS (`GetQueueAttributes`), com timeout de 2 s cada, e responde 503 se algum falhar ou se a instância está desligando. O healthcheck do container usa `ready`.
- **Reconciliação:** lê o saldo e a soma do ledger com a wallet travada, para os dois valores serem do mesmo instante. Divergência é sinalizada na resposta, logada como `error` e contada, **nunca corrigida silenciosamente**.

## 13. Autenticação

Não implementada, por decisão de timebox: a seção 14 atribui 0 pontos a ela.

- **Ponto de extensão:** um `AuthGuard` global no-op (`src/interfaces/http/auth.guard.ts`) e o decorator `@Public()` para health e métricas.
- **Desenho que eu adotaria:**
  - Um IdP externo (**Keycloak**) com um *client* por provedor e o fluxo OAuth2 **client credentials**.
  - O guard valida o JWT (assinatura via JWKS, `iss`, `aud`, expiração) e expõe a identidade do provedor.
  - O use case confere que `body.providerId` corresponde ao provedor autenticado. Divergência gera 403.
  - Mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.
  - No Compose, o Keycloak entraria como mais um serviço, com o realm importado no boot.

## 14. Estratégia de testes

| Camada | O quê | Infra |
|---|---|---|
| `test/unit` | Domínio (Money, Wallet, ledger, estados, regras, hash, eventos, outbox/inbox), mapeamento de erros HTTP, cursor, observabilidade | nenhuma |
| `test/integration` | Constraints e triggers via SQL direto, migrations up/down, repositórios (locks, `SKIP LOCKED`, `ON CONFLICT`, guarda de versão, atomicidade), use cases, API HTTP, consumer, outbox, worker | PostgreSQL e LocalStack reais |
| `test/concurrency` | Os 8 cenários da seção 13 com **3+ processos reais** da aplicação, `SIGKILL` incluído | idem + processos `bun run src/main.ts` |
| `bun run test:compose` | Seção 8, idempotência e reconciliação contra 3 réplicas Docker | Docker Compose |

**Injeção de falha:** para atingir de forma determinística as janelas "depois do commit e antes do ack" e "depois de publicar e antes do commit", `src/infrastructure/fault-injection.ts` tem dois decoradores que fazem o processo se matar com `SIGKILL` exatamente ali. Eles só são ligados pela composição quando `FAULT_KILL_AFTER_COMMIT_MESSAGE_IDS` ou `FAULT_KILL_AFTER_PUBLISH` estão definidos.

Nenhum teste substitui PostgreSQL ou SQS por mocks. As falhas transitórias são reais: por exemplo, um lock segurado por outra transação até estourar o `lock_timeout`.

## 15. Limitações e trade-offs conhecidos

- **`FAILED` só no reprocessamento de pendentes.** Uma falha permanente no caminho principal acontece antes de a transação ser gravada, e por isso vira 4xx ou DLQ, não uma linha `FAILED`.
- **Vazão de uma hot wallet** é limitada pela serialização no lock da linha: as operações de uma mesma wallet são sequenciais por definição. Medido: ~200 operações/s numa única wallet, com p99 de ~1 s sob 50 clientes simultâneos. Wallets diferentes escalam em paralelo.
- **Outbox sob saturação do banco:** relay e requisições usam o mesmo pool de conexões. Com o banco saturado, o atraso p95 de entrega chegou a ~7,6 s em 2 de 3 rodadas do teste de carga. Um pool dedicado ao relay é o próximo passo.
- **Transação aberta durante a publicação da outbox** (ver seção 11).
- **DLQ em duas operações** (enviar e depois apagar). Um crash entre elas pode duplicar a mensagem na DLQ, sem efeito financeiro. A deduplicação FIFO pelo id original do SQS reduz isso dentro da janela de 5 minutos.
- **Sem heartbeat de visibility** no consumer: o processamento leva milissegundos e o visibility timeout é de 30 s.
- **`correlationId` original não é guardado:** eventos gerados pelo worker de referências pendentes usam o id da transação como correlação.
- **Reconciliação sob demanda** (uma wallet por chamada). Não há job periódico de varredura.
- **Fila de eventos standard:** sem ordem garantida (ver seção 11).
- **Versões fixadas:** LocalStack 4.14.0 (a imagem atual exige licença). Bun 1.4, NestJS 12, MikroORM 7 e TypeScript 7 eram as versões estáveis no desenvolvimento.
- **Não implementados** (opcionais no desafio): autenticação, ledger de partidas dobradas e OpenTelemetry. O teste de carga está em [docs/LOAD_TEST.md](docs/LOAD_TEST.md).
