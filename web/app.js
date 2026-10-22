// Demo UI: everything goes through the public HTTP API (nginx proxies /api to the replicas).
// Data from the API is always rendered with textContent, never innerHTML.

const PROVIDER = 'demo-provider';
const state = { wallets: [], selected: undefined, sent: new Map(), lastBody: undefined, instances: new Set() };
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'on') for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

const brl = (amount) => ({ amount, currency: 'BRL' });
const money = (m) => (m ? `${m.amount} ${m.currency}` : '—');
const statusClass = (s) => (s === 202 ? 's202' : `s${String(s)[0]}`);

// ------------------------------------------------------------------------------------------------ API

async function api(method, path, body, headers = {}) {
  const started = performance.now();
  let status = 0;
  let json;
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    status = response.status;
    const text = await response.text();
    json = text ? JSON.parse(text) : undefined;
  } catch (error) {
    json = { error: { code: 'NETWORK', message: String(error) } };
  }
  const ms = performance.now() - started;
  const instance = response?.headers.get('x-instance-id') ?? '—';
  const correlationId = response?.headers.get('x-correlation-id') ?? '—';
  if (instance !== '—') {
    state.instances.add(instance);
    $('instances').textContent = `instâncias vistas: ${state.instances.size}`;
  }
  logRequest({ method, path, status, ms, instance, correlationId });
  return { status, body: json, instance };
}

function logRequest({ method, path, status, ms, instance, correlationId }) {
  const row = el(
    'tr',
    {},
    el('td', { class: `code ${statusClass(status)}` }, status || 'rede'),
    el('td', { class: 'mono' }, `${method} ${path}`),
    el('td', {}, ms.toFixed(0)),
    el('td', { class: 'mono' }, instance),
    el('td', { class: 'mono' }, correlationId),
  );
  const log = $('log');
  log.prepend(row);
  while (log.children.length > 300) log.lastChild.remove();
}

const createWallet = (amount) =>
  api('POST', '/wallets', { playerId: crypto.randomUUID(), initialBalance: brl(amount) });

function wager(wallet, kind, amount, extra = {}) {
  return {
    providerId: PROVIDER,
    externalTransactionId: extra.externalTransactionId || `tx-${crypto.randomUUID().slice(0, 13)}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: extra.roundId || 'round-1',
    gameId: 'demo-game',
    kind,
    money: brl(amount),
    ...(extra.referenceExternalTransactionId ? { referenceExternalTransactionId: extra.referenceExternalTransactionId } : {}),
  };
}

const submit = (body) =>
  api('POST', '/wagering/transactions', body, { 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` });

// ------------------------------------------------------------------------------------------------ health

async function checkHealth() {
  const pill = $('health');
  try {
    const response = await fetch('/api/health/ready');
    const report = await response.json();
    const ok = response.status === 200;
    pill.className = `pill ${ok ? 'ok' : 'bad'}`;
    pill.textContent = ok ? 'pronto · Postgres e SQS ok' : `indisponível · ${JSON.stringify(report.checks)}`;
  } catch {
    pill.className = 'pill bad';
    pill.textContent = 'backend inacessível';
  }
}

// ------------------------------------------------------------------------------------------------ wallets

function renderWalletList() {
  const list = $('wallet-list');
  list.replaceChildren(
    ...state.wallets.map((w) =>
      el(
        'li',
        {},
        el(
          'button',
          { class: w.id === state.selected?.id ? 'active' : '', on: { click: () => selectWallet(w) } },
          el('span', { class: 'mono' }, `${w.id.slice(0, 8)}…`),
          ` · ${money(w.balance)}`,
        ),
      ),
    ),
  );
}

function addWallet(wallet) {
  state.wallets.unshift(wallet);
  state.sent.set(wallet.id, []);
  renderWalletList();
}

async function selectWallet(wallet) {
  state.selected = wallet;
  $('wallet-empty').hidden = true;
  $('wallet-detail').hidden = false;
  $('wallet-ids').textContent = `wallet ${wallet.id} · player ${wallet.playerId}`;
  $('tx-result').replaceChildren();
  $('reconcile-result').replaceChildren();
  renderReferences();
  await refreshWallet();
}

async function refreshWallet() {
  const wallet = state.selected;
  if (!wallet) return;
  const [current, ledger] = await Promise.all([api('GET', `/wallets/${wallet.id}`), api('GET', `/wallets/${wallet.id}/ledger?limit=200`)]);
  if (current.status === 200) {
    $('balance').textContent = money(current.body.balance);
    $('version').textContent = `version ${current.body.version}`;
    const entry = state.wallets.find((w) => w.id === wallet.id);
    if (entry) entry.balance = current.body.balance;
    renderWalletList();
  }
  if (ledger.status === 200) {
    $('ledger').replaceChildren(
      ...ledger.body.entries
        .slice()
        .reverse()
        .map((e) =>
          el(
            'tr',
            {},
            el('td', {}, e.walletVersion),
            el('td', { class: e.direction === 'DEBIT' ? 's4' : 's2' }, e.direction),
            el('td', {}, money(e.money)),
            el('td', {}, money(e.balanceBefore)),
            el('td', {}, money(e.balanceAfter)),
            el('td', { class: 'mono' }, `${e.transactionId.slice(0, 8)}…`),
          ),
        ),
    );
  }
}

function renderReferences() {
  const select = document.querySelector('#submit-tx select[name=reference]');
  const sent = state.sent.get(state.selected?.id) ?? [];
  select.replaceChildren(
    el('option', { value: '' }, '— nenhuma —'),
    ...sent.map((t) => el('option', { value: t.externalTransactionId }, `${t.kind} ${t.amount} · ${t.externalTransactionId}`)),
  );
}

function resultCard(title, { pass, lines = [], json } = {}) {
  return el(
    'div',
    { class: `result ${pass === undefined ? '' : pass ? 'pass' : 'fail'}` },
    el('strong', {}, title),
    lines.length ? el('ul', {}, lines.map((l) => el('li', {}, l))) : '',
    json === undefined ? '' : el('pre', { class: 'mono' }, JSON.stringify(json, null, 2)),
  );
}

async function sendTransaction(body) {
  const response = await submit(body);
  state.lastBody = body;
  if (response.status !== 400 && response.status !== 409 && response.status !== 404) {
    const sent = state.sent.get(state.selected.id);
    if (!sent.some((t) => t.externalTransactionId === body.externalTransactionId)) {
      sent.unshift({ externalTransactionId: body.externalTransactionId, kind: body.kind, amount: body.money.amount });
    }
    renderReferences();
  }
  $('tx-result').replaceChildren(resultCard(`HTTP ${response.status} · ${response.instance}`, { json: response.body }));
  await refreshWallet();
}

// ------------------------------------------------------------------------------------------------ scenarios

async function ledgerDebits(walletId) {
  const ledger = await api('GET', `/wallets/${walletId}/ledger?limit=200`);
  return ledger.body.entries.filter((e) => e.direction === 'DEBIT').length;
}

async function reconcile(walletId) {
  return (await api('POST', `/wallets/${walletId}/reconciliation`)).body;
}

const scenarios = {
  async section8() {
    const wallet = (await createWallet('100.00')).body;
    addWallet(wallet);
    const [a, b] = await Promise.all([submit(wager(wallet, 'BET', '80.00')), submit(wager(wallet, 'BET', '80.00'))]);
    const final = (await api('GET', `/wallets/${wallet.id}`)).body;
    const debits = await ledgerDebits(wallet.id);
    const check = await reconcile(wallet.id);
    const statuses = [a.status, b.status].sort();
    return resultCard('§8 — duas apostas de 80,00 sobre 100,00', {
      pass: statuses.join() === '200,422' && final.balance.amount === '20.00' && debits === 1 && check.consistent,
      lines: [
        `respostas: ${a.status} (${a.instance}) e ${b.status} (${b.instance})`,
        `rejeitada com: ${[a, b].find((r) => r.status === 422)?.body.failureCode ?? '—'}`,
        `saldo final: ${money(final.balance)} · débitos no ledger: ${debits}`,
        `reconciliação: ${check.consistent ? 'consistente' : 'DIVERGENTE'}`,
      ],
    });
  },

  async replay() {
    const wallet = (await createWallet('100.00')).body;
    addWallet(wallet);
    const body = wager(wallet, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    const ids = new Set(results.map((r) => r.body.transactionId));
    const replays = results.filter((r) => r.body.idempotentReplay).length;
    const instances = new Set(results.map((r) => r.instance));
    const final = (await api('GET', `/wallets/${wallet.id}`)).body;
    const debits = await ledgerDebits(wallet.id);
    return resultCard('Mesma aposta 50× em paralelo', {
      pass: ids.size === 1 && replays === 49 && debits === 1 && final.balance.amount === '90.00',
      lines: [
        `transações distintas: ${ids.size} · replays: ${replays} de 50`,
        `atendidas por ${instances.size} instância(s): ${[...instances].join(', ')}`,
        `saldo final: ${money(final.balance)} · débitos no ledger: ${debits}`,
      ],
    });
  },

  async conflict() {
    const wallet = (await createWallet('100.00')).body;
    addWallet(wallet);
    const body = wager(wallet, 'BET', '25.00');
    const first = await submit(body);
    const replay = await submit(body);
    const conflict = await submit({ ...body, money: brl('30.00') });
    return resultCard('Mesma Idempotency-Key com outro valor', {
      pass: first.status === 200 && replay.body.idempotentReplay === true && conflict.status === 409,
      lines: [
        `original: ${first.status} · reenvio idêntico: ${replay.status} (idempotentReplay: ${replay.body.idempotentReplay})`,
        `mesma key com 30,00: ${conflict.status} ${conflict.body?.error?.code ?? ''}`,
      ],
      json: conflict.body,
    });
  },

  async outOfOrder() {
    const wallet = (await createWallet('100.00')).body;
    addWallet(wallet);
    const bet = wager(wallet, 'BET', '40.00');
    const rollback = wager(wallet, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const early = await submit(rollback);
    const betResult = await submit(bet);
    let status = early.body.status;
    const deadline = Date.now() + 15_000;
    while (status !== 'PROCESSED' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      status = (await api('GET', `/providers/${PROVIDER}/wagering/transactions/${rollback.externalTransactionId}`)).body.status;
    }
    const final = (await api('GET', `/wallets/${wallet.id}`)).body;
    return resultCard('ROLLBACK antes da BET', {
      pass: early.status === 202 && status === 'PROCESSED' && final.balance.amount === '100.00',
      lines: [
        `ROLLBACK primeiro: ${early.status} ${early.body.status}`,
        `BET depois: ${betResult.status} ${betResult.body.status}`,
        `ROLLBACK resolvido pelo worker: ${status}`,
        `saldo final: ${money(final.balance)} (aposta e estorno se anulam)`,
      ],
    });
  },

  async insufficient() {
    const wallet = (await createWallet('10.00')).body;
    addWallet(wallet);
    const bet = await submit(wager(wallet, 'BET', '25.00'));
    const win = wager(wallet, 'WIN', '50.00');
    await submit(win);
    await submit(wager(wallet, 'BET', '55.00'));
    const reversal = await submit(wager(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }));
    return resultCard('Sem saldo: aposta e reversão', {
      pass: bet.body.failureCode === 'INSUFFICIENT_FUNDS' && reversal.body.failureCode === 'REVERSAL_INSUFFICIENT_FUNDS',
      lines: [
        `aposta de 25,00 com 10,00: ${bet.status} ${bet.body.failureCode} → ${bet.body.providerAction}`,
        `estorno de um WIN já gasto: ${reversal.status} ${reversal.body.failureCode} → ${reversal.body.providerAction}`,
        'códigos distintos: situações operacionais diferentes (regra 9)',
      ],
    });
  },
};

// ------------------------------------------------------------------------------------------------ wiring

$('create-wallet').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = new FormData(event.target).get('amount');
  const response = await createWallet(String(amount));
  if (response.status === 201) {
    addWallet(response.body);
    await selectWallet(response.body);
  } else {
    alert(`HTTP ${response.status}: ${response.body?.error?.code ?? ''}`);
  }
});

$('submit-tx').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected) return;
  const form = new FormData(event.target);
  const body = wager(state.selected, String(form.get('kind')), String(form.get('amount')), {
    externalTransactionId: String(form.get('external') || ''),
    referenceExternalTransactionId: String(form.get('reference') || ''),
  });
  await sendTransaction(body);
});

$('resend').addEventListener('click', async () => {
  if (state.lastBody) await sendTransaction(state.lastBody);
});

$('refresh').addEventListener('click', refreshWallet);

$('reconcile').addEventListener('click', async () => {
  if (!state.selected) return;
  const report = await reconcile(state.selected.id);
  $('reconcile-result').replaceChildren(resultCard(report.consistent ? 'Consistente' : 'Divergente', { pass: report.consistent, json: report }));
});

for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', async () => {
    const buttons = document.querySelectorAll('[data-scenario]');
    buttons.forEach((b) => (b.disabled = true));
    try {
      const card = await scenarios[button.dataset.scenario]();
      $('scenario-result').prepend(card);
    } catch (error) {
      $('scenario-result').prepend(resultCard('Erro ao executar o cenário', { pass: false, lines: [String(error)] }));
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}

checkHealth();
setInterval(checkHealth, 5_000);
