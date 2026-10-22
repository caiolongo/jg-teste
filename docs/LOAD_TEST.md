# Teste de carga

`bun run test:load` · script em [`scripts/load-test.ts`](../scripts/load-test.ts) · resultados brutos em [`docs/load-test/`](load-test/)

## Resumo

O objetivo era medir o deploy real com 3 réplicas sob carga e **verificar que nenhuma invariante quebra**. Também procurei gargalos. Não havia meta de RPS.

- **Correção sob carga:** nas 6 execuções (cerca de 25 mil a 45 mil operações cada), **todas as 201 wallets reconciliaram**, com saldo igual ao ledger. Nenhuma mensagem foi para a DLQ, nenhuma resposta 5xx, nenhum lock timeout.
- **Vazão (configuração final, 3 rodadas):**
  - 350–460 req/s com wallets distribuídas;
  - cerca de 200 req/s numa **única** wallet;
  - 540–610 req/s com 50% de reenvios;
  - 160–200 msg/s pela fila.
- **Gargalo encontrado e corrigido:** o outbox relay não acompanhava a produção de eventos. O atraso de entrega (p50) era de **13,2 s**, com 18 mil eventos represados. Duas mudanças medidas, uma de cada vez, o levaram para **0,4–3,0 s** no pior cenário e cerca de 0,2 s nos demais.
- **Gargalo restante:** o banco, ou seja, o PostgreSQL no Docker Desktop disputado por 3 pools de 10 conexões. Uma hipótese alternativa, a de que faltavam pollers no consumer, foi testada e **refutada**.

## Ambiente

| | |
|---|---|
| Máquina | Apple M1, 8 núcleos, 8 GiB, macOS (Darwin 24.3) |
| Docker | Docker Desktop: VM com 8 CPUs e ~3,8 GiB |
| Aplicação | 3 réplicas (`docker compose --scale app=3`), imagem de produção, cada uma com HTTP + consumer SQS (4 pollers) + outbox relay + worker; pool de 10 conexões; logs em `info` |
| PostgreSQL | 18.1 (container, configuração padrão) |
| SQS | LocalStack 4.14.0 (container) |
| Gerador de carga | Bun 1.4.3, **na mesma máquina** |

## Metodologia

**Fases**, de 30 s cada, com 50 usuários virtuais em loop fechado (cada um envia a próxima requisição assim que recebe a resposta), distribuídos em rodízio entre as 3 réplicas:

| Fase | Carga | O que isola |
|---|---|---|
| `spread` | 200 wallets; mix 70% BET, 20% WIN, 10% LOSS; 5% de reenvios da requisição anterior (mesma `Idempotency-Key`) | Vazão sem contenção de lock |
| `hot-wallet` | Os mesmos 50 usuários numa **única** wallet | Custo da serialização por wallet |
| `replay-storm` | Como `spread`, mas com 50% de reenvios | Custo da idempotência |
| `queue burst` | 2.000 mensagens no SQS, 200 grupos FIFO, enviadas por 20 produtores em paralelo | Vazão do consumer |

As wallets começam com saldo alto, para que nenhuma aposta seja rejeitada por saldo e a fase meça só o processamento.

**Medições:**
- **Latência no cliente:** do envio até a resposta completa, para cada requisição; p50, p95, p99 e máximo calculados sobre todas as amostras.
- **Tempo no servidor:** média do histograma `wagering_processing_duration_seconds` (diferença antes/depois de cada fase, somada nas 3 réplicas). Serve para separar o custo do sistema do custo da rede do Docker.
- **Taxa de erro:** tudo o que não é uma resposta final de negócio, ou seja, tudo exceto 2xx e 422. Inclui 5xx, 409 e falhas de rede.
- **Conflitos de concorrência:** diferença de `wagering_lock_conflicts_total` (lock timeout, deadlock, conflito de versão) e respostas 503.
- **Outbox lag:** medido no PostgreSQL como `published_at − occurred_at` de **cada evento** criado na fase, com p50, p95, p99 e máximo. O backlog e a idade do evento pendente mais antigo são amostrados a cada 500 ms durante a fase. Também registro o tempo de drenagem depois da carga.
- **Fila:** cronômetro do **primeiro envio** até a última mensagem processada (contador `wagering_transactions_total`).
- **Consistência:** ao final, reconciliação de todas as wallets usadas pela API.

**Repetição:** a configuração final rodou 3 vezes. As tabelas mostram a faixa (mínimo–máximo) entre as rodadas.

## Resultados (configuração final, 3 rodadas)

### HTTP

| Fase | Vazão (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | Servidor, média (ms) | Erros | Conflitos de lock | 503 |
|---|---|---|---|---|---|---|---|---|
| spread | 352–457 | 95–120 | 241–321 | 340–460 | 103–133 | 0–0,01% | 0 | 0 |
| hot-wallet | 192–203 | 61–141 | 724–775 | 845–1068 | 244–258 | 0% | 0 | 0 |
| replay-storm | 542–614 | 68–78 | 191–225 | 279–342 | 74–84 | 0% | 0 | 0 |

O único erro registrado foi **1 requisição em 13.771** (rodada 1), uma falha de rede no cliente (conexão encerrada). Não houve erro correspondente nos logs do servidor. A causa provável é o encaminhamento de portas do Docker Desktop, mas isso não foi verificado. Um provedor reenviaria com a mesma `Idempotency-Key`, e o sistema responderia com replay se a operação tivesse sido aplicada.

### Outbox lag (atraso de entrega dos eventos)

| Fase | p50 (s) | p95 (s) | p99 (s) | Backlog máximo | Drenagem após a carga (s) |
|---|---|---|---|---|---|
| spread | 0,38–2,96 | 0,67–7,59 | 0,76–7,86 | 726–4.047 | 0,2–1,2 |
| hot-wallet | 0,22–0,23 | 0,51–0,58 | 0,58–1,70 | 206–471 | 0,2 |
| replay-storm | 0,41–0,43 | 0,78–0,86 | 0,98–1,12 | 496–576 | 0,2–0,4 |

### Fila

| Mensagens | Grupos FIFO | Envio (s) | Primeiro envio → tudo processado (s) | Vazão (msg/s) | DLQ |
|---|---|---|---|---|---|
| 2.000 | 200 | 1,4–1,9 | 9,9–12,4 | 162–202 | 0 |

## O experimento: gargalo no outbox

A primeira rodada (linha de base) mostrou o problema mais sério que o teste encontrou:

| Versão | Mudança | spread: atraso p50 | spread: atraso p95 | Backlog máximo | spread: vazão HTTP |
|---|---|---|---|---|---|
| 1 · linha de base | lote de 10 eventos por rodada, um `UPDATE` por evento | **13,18 s** | 19,25 s | **17.999** | 480 req/s |
| 2 | lote de 100, enviado em 10 `SendMessageBatch` paralelos | 5,71 s | 9,70 s | 7.946 | 409 req/s |
| 3 · final | + um único `UPDATE … WHERE id IN (…)` por lote | **0,38–2,96 s** | 0,67–7,59 s | 726–4.047 | 352–457 req/s |

- **Diagnóstico:** sob carga distribuída o sistema produz ~800 eventos/s, cerca de dois por operação, e o relay não acompanhava. Cada rodada publicava no máximo 10 eventos, o limite de um `SendMessageBatch`, e pagava por isso uma transação SQL, uma chamada ao SQS e **10 `UPDATE`s individuais**, disputando o mesmo pool de 10 conexões com as requisições.
- **Mudança 1:** reivindicar 100 eventos por rodada e enviá-los em 10 lotes paralelos. O atraso caiu à metade, mas cada rodada passou a fazer 100 `UPDATE`s.
- **Mudança 2:** marcar o lote inteiro como publicado com um único `UPDATE`. O atraso p50 caiu para menos de 1 s na maioria das rodadas.
- **Efeito colateral honesto:** a vazão HTTP da fase `spread` caiu de 480 para 350–460 req/s. Isso não é perda de capacidade: na linha de base, **o trabalho de publicar estava sendo adiado**, acumulando 18 mil eventos para depois. Agora o relay faz a sua parte durante a carga, e o banco divide a mesma capacidade entre as duas coisas.

A mudança ficou como padrão (`OUTBOX_BATCH_SIZE=100`).

## Hipótese refutada: mais pollers no consumer

A fila processa ~180 msg/s, menos que o HTTP. Hipótese: o limite seriam os 12 pollers (3 réplicas × 4), já que mensagens do mesmo grupo FIFO são processadas em sequência. Rodei uma vez com **16 pollers por réplica**:

| | 4 pollers (final) | 16 pollers |
|---|---|---|
| Fila (msg/s) | 162–202 | 156 |
| spread (req/s) | 352–457 | 299 |
| spread p95 (ms) | 241–321 | 376 |

A fila não ficou mais rápida e o HTTP piorou. Os pollers extras só disputaram o mesmo pool de conexões. **A hipótese está errada**, e o padrão continua em 4.

## Análise

1. **O gargalo é o banco, não a aplicação nem a rede.**
   - O tempo médio medido dentro do servidor (103–133 ms em `spread`) é praticamente igual à latência p50 vista pelo cliente, então a rede do Docker contribui pouco.
   - Mais concorrência (pollers) só redistribuiu a mesma capacidade.
   - Cada operação é uma transação com ~8 idas ao banco (lock, insert, update, ledger, outbox, inbox) e um `COMMIT` com flush de WAL, num PostgreSQL de configuração padrão dentro de uma VM de 3,8 GiB, com 30 conexões disputadas.
   - Não medi CPU e I/O do container durante a carga, então essa conclusão é inferida, não provada.
2. **A hot wallet custa latência, não correção.** Uma wallet sustenta ~200 operações/s, um teto esperado do lock pessimista: as operações de uma wallet são sequenciais por definição, cerca de 5 ms de seção crítica cada. A cauda é longa (p99 de ~1 s) porque 50 usuários esperam o mesmo lock. **Nenhum lock timeout** aconteceu (o limite é 5 s), e o p50 varia muito entre rodadas (61–141 ms) porque a distribuição é bimodal: replays respondem sem lock, as demais esperam na fila do lock.
3. **Conflitos = 0 é consequência da estratégia, não ausência de contenção.** Com lock pessimista, a contenção vira **espera**, que aparece no p95/p99 da hot wallet, e não **conflito com retry**. Uma estratégia otimista teria transformado a mesma fase numa série de conflitos de versão e retries.
4. **Idempotência é barata.** Com 50% de reenvios, a vazão sobe para 540–610 req/s, porque o replay é resolvido por uma leitura indexada, sem lock e sem escrita.
5. **A correção não depende da carga.** Em todas as execuções, inclusive na linha de base com 18 mil eventos represados, as 201 wallets reconciliaram, e nenhuma mensagem foi duplicada ou perdida.

## Ameaças à validade

- **Gerador e sistema na mesma máquina:** os dois disputam CPU, então os números absolutos estão subestimados.
- **Loop fechado:** cada usuário espera a resposta antes de enviar a próxima, então quando o sistema fica lento a carga oferecida também diminui. Isso esconde parte da cauda (*coordinated omission*). Um teste com taxa de chegada fixa daria um p99 mais pessimista.
- **Fases de 30 s** não mostram comportamento de longa duração: crescimento de tabelas, autovacuum, índices maiores.
- **LocalStack não é SQS:** latência e vazão da fila não representam a AWS.
- **PostgreSQL com configuração padrão** e logs da aplicação em `info` durante a carga.
- **Variância:** com 3 rodadas, as faixas são indicativas, não intervalos de confiança.

## Próximos passos

- **Pool dedicado e pequeno para o relay e o worker,** separado das requisições, para o outbox não competir com o tráfego. O p95 de entrega ainda chega a ~7,6 s em `spread` em 2 de 3 rodadas.
- **Medir CPU, I/O e locks do PostgreSQL durante a carga** (`pg_stat_activity`, `pg_stat_statements`, `docker stats`) para confirmar o diagnóstico do item 1.
- **Testar** `synchronous_commit`, o tamanho do pool e um PgBouncer, e **reduzir as idas ao banco** por operação, agrupando inserts.
- **Repetir com gerador em outra máquina e taxa de chegada fixa** (por exemplo, k6), para obter um p99 sem *coordinated omission*.
