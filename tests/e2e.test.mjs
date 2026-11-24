// Testes de ponta a ponta do app no navegador (Chromium via Playwright), com dados fictícios.
// Rodar:  npm run test:e2e
// A data do navegador fica fixa em 24/11/2026, para os resultados não dependerem do dia em que rodam.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TODAY = new Date('2026-11-24T12:00:00');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};

let server; let base; let browser;
before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

/** Abre o app “sem login”, com dados vazios, num celular de 390px. */
async function openApp({ dialogs = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? (dialogs.shift() ?? '') : undefined));
  await page.clock.setFixedTime(TODAY);
  await page.goto(base);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('mimimei-modo', 'local'); });
  await page.reload();
  return page;
}
const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
/** Grava lançamentos direto no armazenamento do app (mesmo caminho que a interface usa). */
const seed = (page, list) => page.evaluate(async (items) => {
  const { store } = await import('/js/store.js');
  items.forEach((t) => store.add({ source: 'manual', category: 'Outros gastos', ...t }));
}, list);
const fatura = [
  { type: 'gasto', date: '2026-11-01', amount: 400, description: 'Farmácia', paidBy: 'Lari', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-03', amount: 340.58, description: 'Mercado', paidBy: 'Dividido 50/50', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-04', amount: 300, description: 'Jantar', paidBy: 'Dividido 50/50', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-05', amount: 1000, description: 'Passagem', paidBy: 'Outros', otherName: 'Thaís', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-05', amount: 57.76, description: 'Uber', paidBy: 'Outros', otherName: 'Thaís', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-06', amount: 99, description: 'Presente', paidBy: 'Outros', otherName: 'Papis', payment: 'Crédito', card: 'cartao' },
  { type: 'gasto', date: '2026-11-07', amount: 82.80, description: 'Pizza', paidBy: 'Outros', otherName: 'Thais e Lari', payment: 'Crédito', card: 'cartao' },
];

test('lança um gasto e não deixa lançar a mesma nota fiscal duas vezes', async () => {
  const page = await openApp();
  await page.click('[data-tab=lancar]');
  await page.fill('#tx-form [name=amount]', '42,50');
  await page.fill('#tx-form [name=description]', 'Padaria');
  await page.click('#form-submit');
  const chave = '35261176543210000198650020004567891876543210';
  await page.fill('#nf-text', chave); await page.click('#nf-read');
  assert.match(await text(page, '#nf-status'), /Nota lida/);
  await page.fill('#tx-form [name=amount]', '99'); await page.fill('#tx-form [name=place]', 'Mercado X');
  await page.click('#form-submit');
  await page.fill('#nf-text', chave); await page.click('#nf-read');
  assert.match(await text(page, '#nf-status'), /já foi lançada/);
  const n = await page.evaluate(async () => (await import('/js/store.js')).store.transactions.length);
  assert.equal(n, 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('importa extrato OFX e não duplica ao importar de novo', async () => {
  const page = await openApp();
  await page.click('[data-tab=importar]');
  await page.setInputFiles('#imp-file', join(FIX, 'extrato.ofx'));
  await page.waitForSelector('#imp-review:not(.hidden)');
  assert.match(await text(page, '#imp-summary'), /4 lançamentos no arquivo · 4 novos/);
  await page.click('#imp-confirm');
  await page.click('[data-tab=importar]');
  await page.setInputFiles('#imp-file', join(FIX, 'extrato.ofx'));
  await page.waitForSelector('#imp-review:not(.hidden)');
  assert.match(await text(page, '#imp-summary'), /4 já importados antes/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('fatura: parte de cada pessoa, nomes iguais juntos e “Thaís e Lari” dividido', async () => {
  const page = await openApp();
  await seed(page, fatura);
  await page.click('[data-tab=cartao]');
  await page.click('#fat-prev'); // fatura de novembro (11/10 a 10/11)
  assert.equal(await text(page, '#fat-total'), 'R$ 2.280,14');
  const rows = await page.$$eval('#fat-payers .payer-row', (r) => r.map((x) => `${x.dataset.name}=${x.querySelector('.num').firstChild.textContent.replace(/\s+/g, ' ').trim()}`));
  assert.deepEqual(rows, ['Lari=R$ 761,69', 'Robs=R$ 320,29', 'Thaís=R$ 1.099,16', 'Papis=R$ 99,00']);
  assert.equal(await text(page, '#fat-receive'), 'R$ 1.518,45');
  // marcar o Papis como acertado baixa a fatura a pagar
  await page.locator('#fat-table tr', { hasText: 'Presente' }).locator('.settled-cb').check();
  assert.equal(await text(page, '#fat-total'), 'R$ 2.181,14');
  assert.equal(await text(page, '#fat-receive'), 'R$ 1.419,45');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('acertos: Pix de quem deve vira acerto (parcial) e não conta como renda', async () => {
  const page = await openApp();
  await seed(page, fatura);
  await page.click('[data-tab=importar]');
  await page.setInputFiles('#imp-file', join(FIX, 'extrato-acertos.csv'));
  await page.waitForSelector('#imp-review:not(.hidden)');
  const choice = await page.$$eval('#imp-table tr[data-i]', (r) => r.map((x) => x.querySelector('.imp-settle')?.selectedOptions[0].textContent || ''));
  assert.match(choice[0], /Acerto: Thaís → Lari/);
  assert.match(choice[1], /Acerto: Robs → Lari/);
  assert.match(choice[2], /É entrada/);
  await page.click('#imp-confirm');
  await page.click('[data-tab=painel]');
  assert.match(await text(page, '#kpi-in'), /3\.000,00/);
  const alerts = await text(page, '#alerts');
  assert.match(alerts, /Thaís deve R\$ 599,16 a Lari/);
  assert.doesNotMatch(alerts, /Robs deve/);
  // registrar à mão o pagamento do Papis
  await page.click('[data-tab=cartao]'); await page.click('#fat-prev');
  await page.click('#settle-open'); await page.selectOption('#settle-who', 'Papis');
  assert.equal(await page.inputValue('#settle-form [name=amount]'), '99,00');
  await page.click('#settle-form button[type=submit]');
  assert.match(await text(page, '#fat-payers .payer-row[data-name=Papis]'), /✓ acertado/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('metas por categoria: atenção, estourou e aviso no painel', async () => {
  const page = await openApp({ dialogs: ['1.200,00'] });
  await seed(page, [
    { type: 'gasto', date: '2026-11-03', amount: 700, description: 'Compra do mês', category: 'Mercado', paidBy: 'Lari', payment: 'Pix' },
    { type: 'gasto', date: '2026-11-15', amount: 380, description: 'Feira', category: 'Mercado', paidBy: 'Lari', payment: 'Pix' },
    { type: 'gasto', date: '2026-11-10', amount: 340, description: 'iFood', category: 'Restaurante & Delivery', paidBy: 'Robs', payment: 'Pix' },
  ]);
  await page.click('[data-tab=painel]');
  await page.click('#chart-cat .cat-item[data-cat="Mercado"] [data-act=goal]');
  await page.evaluate(async () => (await import('/js/store.js')).store.setBudget('Restaurante & Delivery', 300));
  await page.click('[data-tab=lista]'); await page.click('[data-tab=painel]');
  assert.match(await text(page, '#chart-cat .cat-item[data-cat="Mercado"] .cat-meta'), /90% da meta/);
  assert.match(await text(page, '#chart-cat .cat-item[data-cat="Restaurante & Delivery"] .cat-meta'), /estourou em R\$ 40,00/);
  assert.match(await text(page, '#alerts'), /Mercado: R\$ 1\.080,00 de R\$ 1\.200,00/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('contas fixas: gera o mês seguinte para conferir, sem duplicar nem recriar excluída', async () => {
  const page = await openApp();
  await page.click('[data-tab=lancar]');
  await page.fill('#tx-form [name=date]', '2026-10-15');
  await page.fill('#tx-form [name=amount]', '129,90');
  await page.fill('#tx-form [name=description]', 'Academia');
  await page.check('#tx-form [name=repeat]');
  await page.click('#form-submit');
  await page.reload(); await page.waitForTimeout(600);
  const list = () => page.evaluate(async () => (await import('/js/store.js')).store.transactions
    .filter((t) => t.description === 'Academia').map((t) => `${t.date}${t.toConfirm ? '?' : ''}`).sort());
  assert.deepEqual(await list(), ['2026-10-15', '2026-11-15?']);
  await page.evaluate(async () => {
    const { store } = await import('/js/store.js');
    store.remove(store.transactions.find((t) => t.date === '2026-11-15').id);
  });
  await page.reload(); await page.waitForTimeout(600);
  assert.deepEqual(await list(), ['2026-10-15']);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('parcelas: compra 2/5 prevê 3/5 a 5/5 e a fatura real não duplica', async () => {
  const page = await openApp();
  await page.click('[data-tab=cartao]');
  await page.fill('#card-form [name=date]', '2026-11-04');
  await page.fill('#card-form [name=amount]', '120');
  await page.fill('#card-form [name=description]', 'Sofá');
  await page.fill('#card-form [name=installment]', '2/5');
  await page.click('#card-form button[type=submit]');
  const parcels = await page.evaluate(async () => (await import('/js/store.js')).store.transactions
    .filter((t) => t.description === 'Sofá').map((t) => `${t.date} ${t.installment}${t.projected ? ' prevista' : ''}`).sort());
  assert.deepEqual(parcels, ['2026-11-04 2/5', '2026-12-04 3/5 prevista', '2027-01-04 4/5 prevista', '2027-02-04 5/5 prevista']);
  await page.evaluate(() => { document.querySelector('#imp-file').click = () => {}; });
  await page.click('#card-import');
  await page.setInputFiles('#imp-file', join(FIX, 'fatura-parcela.csv'));
  await page.waitForSelector('#imp-review:not(.hidden)');
  const checked = await page.$$eval('#imp-table tr[data-i]', (r) => r.map((x) => x.querySelector('.imp-inc').checked));
  assert.deepEqual(checked, [false, true]); // parcela já prevista vem desmarcada; a padaria, marcada
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('lista: filtros por pessoa e por forma de pagamento', async () => {
  const page = await openApp();
  await seed(page, [
    { type: 'gasto', date: '2026-11-18', amount: 100, description: 'Jantar', paidBy: 'Dividido 50/50', payment: 'Pix' },
    { type: 'gasto', date: '2026-11-17', amount: 82.80, description: 'Pizza', paidBy: 'Outros', otherName: 'Thaís e Lari', payment: 'Crédito', card: 'cartao' },
    { type: 'gasto', date: '2026-11-16', amount: 40, description: 'Uber', paidBy: 'Robs', payment: 'Débito' },
  ]);
  await page.click('[data-tab=lista]');
  await page.selectOption('#list-person', 'Lari');
  assert.match(await text(page, '#list-table tfoot'), /parte de Lari: gastos R\$ 91,40/);
  await page.selectOption('#list-person', '');
  await page.selectOption('#list-payment', 'pay:Débito');
  const rows = await page.$$eval('#list-table tbody tr[data-id]', (r) => r.length);
  assert.equal(rows, 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('nenhuma aba passa da largura do celular', async () => {
  const page = await openApp();
  await seed(page, fatura);
  for (const tab of ['painel', 'lancar', 'cartao', 'importar', 'lista', 'ajustes']) {
    await page.click(`[data-tab=${tab}]`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, `aba ${tab}`);
  }
  assert.deepEqual(page.errors, []);
  await page.close();
});
