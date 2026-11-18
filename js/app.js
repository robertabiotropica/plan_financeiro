import {
  parseMoney, parseNfQr, parseNfXml, parseOfx, parseCsvRows, guessCsvColumns, csvToTransactions,
} from './parsers.js';
import { store, GROUPS, PAYMENTS } from './store.js';
import { decodeFrame, decodeImage, warmUp } from './qr.js';
import { initAccount, renderCard } from './account.js';

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (n) => brl.format(n || 0);
const moneyShort = (n) => {
  const a = Math.abs(n);
  if (a >= 1000) return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return Math.round(n).toLocaleString('pt-BR');
};
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => new Date(`${s}T12:00:00`);
const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SPLIT = 'Dividido 50/50';
const HOUSE = 'Dividido com a casa'; // contas do apê: divididas por todas as pessoas da casa
/** Parte do valor que é de vocês dois (contas da casa: só a fração do casal). */
const OTHERS = 'Outros'; // gasto pago por outra pessoa (não entra nos gastos de vocês)
/** Quem divide um gasto “Dividido”: os escolhidos (splitWith) ou todas as pessoas da conta. */
const splitPeople = (t) => {
  const w = (t.splitWith || []).filter((p) => store.people.includes(p));
  return w.length >= 2 ? w : store.people;
};
const joinNames = (l) => (l.length <= 1 ? (l[0] || '') : `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}`);
/** Como mostrar o “Pago por” de um lançamento. */
function paidByLabel(t) {
  if (t.paidBy === SPLIT) {
    const w = splitPeople(t);
    return w.length === 2 && store.people.length === 2 ? SPLIT : `Dividido: ${joinNames(w)}`;
  }
  if (t.paidBy === OTHERS && t.otherName) return `Outros: ${t.otherName}`;
  return t.paidBy || '';
}
/** Pessoas da conta que moram na casa (para “Dividido com a casa”). */
const houseCount = () => Math.min(store.people.length, store.houseSize);
const ours = (t) => (t.paidBy === OTHERS ? 0 : t.paidBy === HOUSE ? (t.amount * houseCount()) / store.houseSize : t.amount);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
}
function setStatus(el, msg, kind = '') {
  el.className = `status ${kind}`;
  el.innerHTML = msg;
}
function options(list, selected) {
  return list.map((v) => `<option ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
/** <option>s do “Pago por”: cada pessoa + formas de dividir + Outros. */
function paidByOptions(selected) {
  const list = [
    ...store.people.map((p) => [p, p]),
    [SPLIT, store.people.length === 2 ? SPLIT : 'Dividido entre… (escolher)'],
    [HOUSE, HOUSE],
    [OTHERS, OTHERS],
  ];
  return list.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- abas ----------
function showTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'painel') renderDashboard();
  if (name === 'lista') renderList();
  if (name === 'cartao') { renderCardForm(); renderFatura(); }
  if (name === 'ajustes') renderSettings();
  window.scrollTo({ top: 0 });
}
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- período ----------
const period = { mode: 'mes', anchor: new Date(), from: null, to: null };

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const dow = (x.getDay() + 6) % 7; // segunda = 0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function periodRange() {
  const a = period.anchor;
  if (period.mode === 'semana') {
    const s = startOfWeek(a);
    return { from: iso(s), to: iso(addDays(s, 6)) };
  }
  if (period.mode === 'mes') {
    return { from: iso(new Date(a.getFullYear(), a.getMonth(), 1)), to: iso(new Date(a.getFullYear(), a.getMonth() + 1, 0)) };
  }
  if (period.mode === 'ano') return { from: `${a.getFullYear()}-01-01`, to: `${a.getFullYear()}-12-31` };
  return { from: period.from, to: period.to };
}
function periodLabel() {
  const a = period.anchor;
  const { from, to } = periodRange();
  if (period.mode === 'semana') return `${fmtDate(from).slice(0, 5)} a ${fmtDate(to)}`;
  if (period.mode === 'mes') return `${MONTHS_LONG[a.getMonth()]} ${a.getFullYear()}`;
  if (period.mode === 'ano') return String(a.getFullYear());
  return `${fmtDate(from)} a ${fmtDate(to)}`;
}
function shiftPeriod(dir) {
  const a = period.anchor;
  if (period.mode === 'semana') period.anchor = addDays(a, 7 * dir);
  else if (period.mode === 'mes') period.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1, 12);
  else if (period.mode === 'ano') period.anchor = new Date(a.getFullYear() + dir, 0, 1, 12);
  renderDashboard();
}
/** Divide o período em barras: dias (semana), semanas (mês), meses (ano/longo). */
function buckets() {
  const { from, to } = periodRange();
  const out = [];
  const end = fromIso(to);
  const spanDays = (end - fromIso(from)) / 86400000;
  if (period.mode === 'semana' || (period.mode === 'custom' && spanDays <= 31)) {
    for (let d = fromIso(from); d <= end; d = addDays(d, 1)) {
      const s = iso(d);
      out.push({ from: s, to: s, label: period.mode === 'semana' ? ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'][(d.getDay() + 6) % 7] : String(d.getDate()), title: fmtDate(s) });
    }
  } else if (period.mode === 'mes' || (period.mode === 'custom' && spanDays <= 92)) {
    let s = fromIso(from);
    let i = 1;
    while (s <= end) {
      let e = addDays(startOfWeek(s), 6);
      if (e > end) e = end;
      out.push({ from: iso(s), to: iso(e), label: `${pad(s.getDate())}–${pad(e.getDate())}`, title: `Semana ${i}: ${fmtDate(iso(s))} a ${fmtDate(iso(e))}` });
      s = addDays(e, 1); i++;
    }
  } else {
    let s = fromIso(from);
    while (s <= end) {
      const e0 = new Date(s.getFullYear(), s.getMonth() + 1, 0, 12);
      const e = e0 > end ? end : e0;
      out.push({ from: iso(s), to: iso(e), label: MONTHS[s.getMonth()], title: `${MONTHS_LONG[s.getMonth()]} ${s.getFullYear()}` });
      s = addDays(e, 1);
    }
  }
  return out;
}
function txInRange(from, to) {
  return store.transactions.filter((t) => t.date >= from && t.date <= to);
}

$$('#period-mode button').forEach((b) => b.addEventListener('click', () => {
  period.mode = b.dataset.mode;
  $$('#period-mode button').forEach((x) => x.classList.toggle('on', x === b));
  if (period.mode === 'custom' && !period.from) {
    const { from, to } = { from: iso(new Date(period.anchor.getFullYear(), period.anchor.getMonth() - 2, 1)), to: iso(new Date()) };
    period.from = from; period.to = to;
    $('#custom-from').value = from; $('#custom-to').value = to;
  }
  renderDashboard();
}));
$('#period-prev').addEventListener('click', () => shiftPeriod(-1));
$('#period-next').addEventListener('click', () => shiftPeriod(1));
['#custom-from', '#custom-to'].forEach((s) => $(s).addEventListener('change', () => {
  period.from = $('#custom-from').value; period.to = $('#custom-to').value;
  if (period.from && period.to && period.from > period.to) [period.from, period.to] = [period.to, period.from];
  renderDashboard();
}));

// ---------- painel ----------
function shareOf(t, person) {
  if (t.paidBy === person) return t.amount;
  if (t.paidBy === SPLIT) { const w = splitPeople(t); return w.includes(person) ? t.amount / w.length : 0; }
  if (t.paidBy === HOUSE) return t.amount / store.houseSize;
  return 0;
}

function renderDashboard() {
  $('#period-label').textContent = periodLabel();
  const custom = period.mode === 'custom';
  $('#period-custom').classList.toggle('hidden', !custom);
  $('#period-prev').style.visibility = custom ? 'hidden' : '';
  $('#period-next').style.visibility = custom ? 'hidden' : '';
  const { from, to } = periodRange();
  if (!from || !to) return;
  const txs = txInRange(from, to);
  const sum = (list) => list.reduce((s, t) => s + ours(t), 0);
  const gastos = txs.filter((t) => t.type === 'gasto');
  const entradas = txs.filter((t) => t.type === 'entrada');
  const tin = sum(entradas); const tout = sum(gastos); const bal = tin - tout;
  $('#kpi-in').textContent = money(tin);
  $('#kpi-out').textContent = money(tout);
  $('#kpi-bal').textContent = money(bal);
  $('#kpi-bal').className = bal >= 0 ? 'pos' : 'neg';

  // por pessoa
  const rows = store.people.map((p) => {
    const inn = entradas.reduce((s, t) => s + shareOf(t, p), 0);
    const out = gastos.reduce((s, t) => s + shareOf(t, p), 0);
    return { p, inn, out, bal: inn - out };
  });
  $('#people-table').innerHTML = `<table>
    <thead><tr><th></th><th class="num">Entradas</th><th class="num">Gastos</th><th class="num">Balanço</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.p)}</b></td><td class="num">${money(r.inn)}</td><td class="num">${money(r.out)}</td>
      <td class="num ${r.bal >= 0 ? 'pos' : 'neg'}">${money(r.bal)}</td></tr>`).join('')}</tbody></table>
    <p class="hint" style="margin:8px 0 0">“Dividido” conta a parte de cada pessoa que divide. “${HOUSE}” (contas do apê) conta 1/${store.houseSize} para cada pessoa da conta — só a parte de vocês entra nos totais. “${OTHERS}” não entra.</p>`;

  // grupos
  const groupTotals = GROUPS.filter((g) => g !== 'Entradas').map((g) => ({
    g, v: sum(gastos.filter((t) => store.groupOf(t.category) === g)),
  }));
  $('#groups').innerHTML = `<div class="groups">${groupTotals.map(({ g, v }) => `<div><span>${esc(g)}</span><strong>${money(v)}</strong></div>`).join('')}</div>`;

  renderTimeChart();
  renderCategoryChart(gastos, tout);
}

function renderTimeChart() {
  const bs = buckets().map((b) => {
    const txs = txInRange(b.from, b.to);
    return {
      ...b,
      inn: txs.filter((t) => t.type === 'entrada').reduce((s, t) => s + ours(t), 0),
      out: txs.filter((t) => t.type === 'gasto').reduce((s, t) => s + ours(t), 0),
    };
  });
  const el = $('#chart-time');
  const max = Math.max(0, ...bs.map((b) => Math.max(b.inn, b.out)));
  if (!max) { el.innerHTML = '<p class="empty">Nenhum lançamento neste período.</p>'; return; }

  const W = Math.max(280, Math.round(el.clientWidth || 640)); const H = 220; const L = 44; const R = 4; const T = 8; const B = 24;
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / bs.length;
  const gap = 2;
  const barW = Math.max(2, Math.min(22, (slot * 0.7 - gap) / 2));
  const labelEvery = Math.ceil(bs.length / 12);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entradas e gastos por período">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis-label" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }
  bs.forEach((b, i) => {
    const cx = L + slot * i + slot / 2;
    const bar = (v, x, cls) => {
      if (v <= 0) return '';
      const h = Math.max(1, y(0) - y(v));
      const r = Math.min(4, barW / 2, h);
      // topo arredondado, base reta no eixo
      return `<path class="${cls}" d="M${x},${y(0)} V${y(0) - h + r} q0,-${r} ${r},-${r} H${x + barW - r} q${r},0 ${r},${r} V${y(0)} Z"/>`;
    };
    svg += bar(b.inn, cx - barW - gap / 2, 'bar-in');
    svg += bar(b.out, cx + gap / 2, 'bar-out');
    if (i % labelEvery === 0) svg += `<text class="axis-label" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}"/>`;
  });
  svg += '</svg>';
  el.innerHTML = svg;

  const tip = $('#tooltip');
  $$('.hit', el).forEach((r) => {
    const show = (ev) => {
      const b = bs[Number(r.dataset.i)];
      tip.innerHTML = `<b>${esc(b.title)}</b><span class="sw sw-in"></span>Entradas ${money(b.inn)}<br><span class="sw sw-out"></span>Gastos ${money(b.out)}<br>Saldo ${money(b.inn - b.out)}`;
      tip.style.display = 'block';
      const x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${ev.clientY + 12}px`;
    };
    r.addEventListener('pointermove', show);
    r.addEventListener('pointerdown', show);
    r.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  });
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function renderCategoryChart(gastos, total) {
  const by = {};
  gastos.forEach((t) => { by[t.category || 'Sem categoria'] = (by[t.category || 'Sem categoria'] || 0) + ours(t); });
  const list = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const el = $('#chart-cat');
  if (!list.length) { el.innerHTML = '<p class="empty">Nenhum gasto neste período.</p>'; return; }
  const max = list[0][1];
  el.innerHTML = list.map(([name, v]) => `<div class="hbar" title="${esc(name)}: ${money(v)}">
      <span class="name">${esc(name)}</span>
      <div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div>
      <span class="val">${money(v)}<small>${Math.round((v / total) * 100)}%</small></span>
    </div>`).join('');
}

// ---------- formulário de lançamento ----------
const form = $('#tx-form');
let formType = 'gasto';
let editingId = null;
let attachedNf = null; // dados da nota fiscal anexada ao formulário

function syncCardField(cardId) {
  const show = formType === 'gasto' && form.payment.value === 'Crédito';
  $('#tx-card-wrap').classList.toggle('hidden', !show);
  const keep = cardId || form.card.value || curCard().id;
  form.card.innerHTML = store.cards.map((c) => `<option value="${esc(c.id)}" ${c.id === keep ? 'selected' : ''}>${esc(cardLabel(c))}</option>`).join('');
}
function fillFormSelects(category, paidBy, payment) {
  form.category.innerHTML = options(store.categoriesFor(formType).map((c) => c.name), category);
  form.paidBy.innerHTML = paidByOptions(paidBy);
  form.payment.innerHTML = options(['', ...PAYMENTS], payment);
  $('#paidby-label').textContent = formType === 'entrada' ? 'Recebido por' : 'Pago por';
  syncCardField();
  syncSplit();
}
form.payment.addEventListener('change', () => syncCardField());

/** Com mais de 2 pessoas, “Dividido” pergunta entre quem. */
function syncSplit(keep) {
  const show = form.paidBy.value === SPLIT && store.people.length > 2;
  $('#split-wrap').classList.toggle('hidden', !show);
  const prev = keep || $$('#split-people input:checked').map((i) => i.value);
  const sel = prev.length >= 2 ? prev : store.people;
  $('#split-people').innerHTML = store.people.map((p) => `<label class="check"><input type="checkbox" value="${esc(p)}" ${sel.includes(p) ? 'checked' : ''}> ${esc(p)}</label>`).join('');
}
form.paidBy.addEventListener('change', () => syncSplit());
function formSplitWith() {
  if (form.paidBy.value !== SPLIT || store.people.length <= 2) return null;
  const w = $$('#split-people input:checked').map((i) => i.value);
  return w.length >= 2 && w.length < store.people.length ? w : null;
}
function setFormType(type) {
  formType = type;
  $$('#tx-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  fillFormSelects(store.suggestCategory({ description: form.description.value, place: form.place.value, type }), form.paidBy.value, form.payment.value);
}
$$('#tx-type button').forEach((b) => b.addEventListener('click', () => setFormType(b.dataset.type)));

function resetForm() {
  editingId = null;
  attachedNf = null;
  form.reset();
  form.date.value = iso(new Date());
  $('#form-title').textContent = 'Novo lançamento';
  $('#form-submit').textContent = 'Salvar';
  $('#form-delete').classList.add('hidden');
  $('#nf-attached').classList.add('hidden');
  $('#form-warning').classList.add('hidden');
  setFormType('gasto');
  form.category.value = 'Mercado';
  if (store.me) form.paidBy.value = store.me;
  refreshDatalists();
}
$('#form-cancel').addEventListener('click', resetForm);

// Conta do apê (aluguel, luz…) → sugere “Dividido com a casa”.
function applyHouseDefault() {
  if (editingId || formType !== 'gasto') return;
  const house = store.groupOf(form.category.value) === 'Contas apê';
  if (house) form.paidBy.value = HOUSE;
  else if (form.paidBy.value === HOUSE) form.paidBy.value = store.me || store.people[0];
}
form.category.addEventListener('change', applyHouseDefault);

function refreshDatalists() {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].slice(-200);
  $('#desc-list').innerHTML = uniq(store.transactions.map((t) => t.description)).map((v) => `<option value="${esc(v)}">`).join('');
  $('#place-list').innerHTML = uniq(store.transactions.map((t) => t.place)).map((v) => `<option value="${esc(v)}">`).join('');
}

// sugere categoria ao digitar descrição/local
['description', 'place'].forEach((n) => form[n].addEventListener('change', () => {
  if (editingId) return;
  const s = store.suggestCategory({ description: form.description.value, place: form.place.value, cnpj: attachedNf?.cnpj, type: formType });
  if (s) form.category.value = s;
  applyHouseDefault();
}));

function editTx(id) {
  const t = store.transactions.find((x) => x.id === id);
  if (!t) return;
  showTab('lancar');
  resetForm();
  editingId = id;
  attachedNf = t.nf || null;
  setFormType(t.type);
  form.date.value = t.date;
  form.amount.value = t.amount.toFixed(2).replace('.', ',');
  form.description.value = t.description || '';
  form.place.value = t.place || '';
  fillFormSelects(t.category, t.paidBy, t.payment || '');
  syncCardField(store.cardOf(t)?.id);
  syncSplit(t.splitWith || []);
  form.note.value = t.note || '';
  $('#form-title').textContent = 'Editar lançamento';
  $('#form-submit').textContent = 'Salvar alterações';
  $('#form-delete').classList.remove('hidden');
  if (t.nf) showAttachedNf(t.nf);
  else if (t.itens?.length) {
    const box = $('#nf-attached');
    box.innerHTML = `🛒 <b>${t.itens.length} itens</b><details><summary>ver itens</summary><ul>${t.itens.map((i) => `<li>${esc(i.descricao)}${i.quantidade !== 1 ? ` — ${i.quantidade} ${esc(i.unidade || '')}` : ''} = ${money(i.valor)}</li>`).join('')}</ul></details>`;
    box.classList.remove('hidden');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = Math.abs(parseMoney(form.amount.value));
  if (!Number.isFinite(amount) || amount === 0) { form.amount.focus(); toast('Informe um valor válido.'); return; }
  const tx = {
    type: formType,
    date: form.date.value,
    amount: Math.round(amount * 100) / 100,
    description: form.description.value.trim(),
    place: form.place.value.trim(),
    category: form.category.value,
    paidBy: form.paidBy.value,
    payment: form.payment.value,
    note: form.note.value.trim(),
    card: formType === 'gasto' && form.payment.value === 'Crédito' ? form.card.value : null,
    splitWith: formSplitWith(),
  };
  if (tx.paidBy === SPLIT && store.people.length > 2 && $$('#split-people input:checked').length < 2) {
    toast('Marque pelo menos duas pessoas para dividir.'); return;
  }
  if (attachedNf && !editingId && tx.place && /^NF(C)?-e nº/.test(tx.description)) tx.description = `Compra ${tx.place}`;
  if (editingId) {
    store.update(editingId, tx);
    toast('Lançamento atualizado.');
  } else {
    if (attachedNf) {
      tx.source = 'nf';
      tx.dedupKey = `nf:${attachedNf.chave}`;
      tx.nf = attachedNf;
      if (store.findByDedupKey(tx.dedupKey)) { toast('Esta nota já foi lançada.'); return; }
    } else tx.source = 'manual';
    store.add(tx);
    toast(`${tx.type === 'gasto' ? 'Gasto' : 'Entrada'} de ${money(tx.amount)} salvo.`);
  }
  const keep = { paidBy: tx.paidBy, payment: tx.payment };
  resetForm();
  form.paidBy.value = keep.paidBy;
  form.payment.value = keep.payment;
  setStatus($('#nf-status'), '');
});

// aviso de possível duplicata enquanto preenche
['amount', 'date'].forEach((n) => form[n].addEventListener('change', checkFormSimilar));
function checkFormSimilar() {
  const amount = Math.abs(parseMoney(form.amount.value));
  const w = $('#form-warning');
  if (!Number.isFinite(amount) || !form.date.value) { w.classList.add('hidden'); return; }
  const sim = store.findSimilar({ date: form.date.value, amount, type: formType, source: attachedNf ? 'nf' : 'manual', excludeId: editingId });
  if (sim) {
    w.innerHTML = `⚠️ Já existe um lançamento parecido: <b>${esc(sim.description || sim.place || sim.category)}</b> em ${fmtDate(sim.date)} (${money(sim.amount)}, via ${sourceName(sim.source)}). Confira se não é o mesmo gasto antes de salvar.`;
    w.classList.remove('hidden');
  } else w.classList.add('hidden');
}
function sourceName(s) { return { nf: 'nota fiscal', extrato: 'extrato', manual: 'lançamento manual' }[s] || s; }

// ---------- nota fiscal ----------
const nfStatus = $('#nf-status');

function showAttachedNf(nf) {
  const box = $('#nf-attached');
  const itens = nf.itens?.length
    ? `<details><summary>${nf.itens.length} itens</summary><ul>${nf.itens.map((i) => `<li>${esc(i.descricao)} — ${i.quantidade} ${esc(i.unidade)} × ${money(i.valorUnitario)} = ${money(i.valor)}</li>`).join('')}</ul></details>`
    : '';
  box.innerHTML = `🧾 <b>${esc(nf.modelo || 'Nota')} nº ${nf.numero ?? ''}</b> · ${esc(nf.emitente || nf.cnpjFormatado || '')} · ${esc(nf.uf || '')} ${String(nf.mes).padStart(2, '0')}/${nf.ano}
    ${nf.url ? ` · <a href="${esc(nf.url)}" target="_blank" rel="noopener">ver nota na SEFAZ</a>` : ''}${itens}`;
  box.classList.remove('hidden');
}

function handleNf(nf) {
  if (!nf) { setStatus(nfStatus, 'Não encontrei uma chave de acesso de 44 dígitos nesse conteúdo.', 'err'); return; }
  if (nf.valida === false) {
    setStatus(nfStatus, 'A chave lida não passou na verificação (dígito verificador). Confira se foi lida/digitada corretamente.', 'err');
    return;
  }
  const existing = store.findByDedupKey(`nf:${nf.chave}`);
  if (existing) {
    setStatus(nfStatus, `🔁 Esta nota já foi lançada em <b>${fmtDate(existing.date)}</b>: ${esc(existing.place || existing.description)} — ${money(existing.amount)}. Nada foi duplicado.`, 'warn');
    return false;
  }
  resetForm();
  attachedNf = { ...nf };
  delete attachedNf.valida;
  const place = nf.emitente || store.merchantName(nf.cnpj);
  form.place.value = place;
  form.description.value = nf.itens?.length === 1 ? nf.itens[0].descricao : (place ? `Compra ${place}` : `${nf.modelo} nº ${nf.numero}`);
  const today = new Date();
  form.date.value = nf.data || ((nf.ano === today.getFullYear() && nf.mes === today.getMonth() + 1)
    ? iso(today) : iso(new Date(nf.ano, nf.mes, 0)));
  if (nf.valor) form.amount.value = nf.valor.toFixed(2).replace('.', ',');
  if (nf.formaPagamento) { form.payment.value = nf.formaPagamento; syncCardField(); }
  form.category.value = store.suggestCategory({ description: form.description.value, place, cnpj: nf.cnpj, type: 'gasto' });
  applyHouseDefault();
  showAttachedNf(attachedNf);
  const missing = [];
  if (!nf.valor) missing.push('o <b>valor</b>');
  if (!nf.data) missing.push('a <b>data</b>');
  if (!place) missing.push('o <b>local</b>');
  setStatus(nfStatus, `✅ Nota lida (${esc(nf.modelo)} nº ${nf.numero}, CNPJ ${esc(nf.cnpjFormatado)}).${missing.length ? ` Complete ${missing.join(', ')} abaixo${nf.url ? ' — dá pra conferir no link da SEFAZ' : ''}.` : ' Confira e salve.'}`, 'ok');
  checkFormSimilar();
  (nf.valor ? form.paidBy : form.amount).focus();
  return true;
}

$('#nf-read').addEventListener('click', () => {
  handleNf(parseNfQr($('#nf-text').value));
  $('#nf-text').value = '';
});
$('#nf-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#nf-read').click(); } });

async function readXmlFiles(files) {
  let ok = 0; let dup = 0; const errors = [];
  for (const f of files) {
    try {
      const doc = new DOMParser().parseFromString(await f.text(), 'application/xml');
      const nf = parseNfXml(doc);
      if (files.length === 1) { handleNf(nf); return; }
      // várias notas: lança direto
      if (store.findByDedupKey(`nf:${nf.chave}`)) { dup++; continue; }
      const place = nf.emitente;
      store.add({
        type: 'gasto', date: nf.data, amount: nf.valor, description: `Compra ${place}`, place,
        category: store.suggestCategory({ place, cnpj: nf.cnpj, type: 'gasto' }),
        paidBy: store.me || store.people[0], payment: nf.formaPagamento, note: '', source: 'nf', dedupKey: `nf:${nf.chave}`, nf,
      });
      ok++;
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  setStatus(nfStatus, `${ok} nota(s) lançada(s) como pagas por ${esc(store.me || store.people[0])}${dup ? `, ${dup} já existia(m) e foi(ram) ignorada(s)` : ''}.${errors.length ? `<br>Erros: ${errors.map(esc).join('<br>')}` : ''} Ajuste quem pagou na aba Lançamentos, se precisar.`, errors.length ? 'warn' : 'ok');
}
$('#nf-xml').addEventListener('change', (e) => { readXmlFiles(Array.from(e.target.files)); e.target.value = ''; });

// --- leitura de QR Code ---
let scanStream = null;
let scanStarted = 0;
let torchOn = false;

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(nfStatus, 'Este navegador não libera a câmera aqui. Use “Foto do QR” ou digite a chave.', 'err');
    return;
  }
  warmUp();
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    setStatus(nfStatus, `Não consegui abrir a câmera (${esc(e.message)}). Confira a permissão de câmera do navegador, ou use “Foto do QR”.`, 'err');
    return;
  }
  const track = scanStream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  $('#scanner-torch').classList.toggle('hidden', !caps.torch);
  torchOn = false;

  const video = $('#scanner-video');
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  $('#scanner').classList.remove('hidden');
  $('#scanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setStatus(nfStatus, 'Aponte para o QR Code da nota, deixando-o dentro do quadrado e bem iluminado.');
  scanStarted = Date.now();
  let attempt = 0;
  let hinted = false;
  const tick = async () => {
    if (!scanStream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const text = await decodeFrame(video, video.videoWidth, video.videoHeight, attempt++);
        if (!scanStream) return;
        if (text) {
          navigator.vibrate?.(80);
          stopScan();
          handleNf(parseNfQr(text));
          return;
        }
      } catch (e) {
        console.error(e);
        stopScan();
        setStatus(nfStatus, `Falha no leitor de QR: ${esc(e.message)}. Use “Foto do QR” ou digite a chave.`, 'err');
        return;
      }
      if (!hinted && Date.now() - scanStarted > 15000) {
        hinted = true;
        setStatus(nfStatus, 'Ainda não consegui ler. Dicas: afaste um pouco o celular (uns 15 cm) para focar, evite reflexo no papel, ou tire uma foto com “Foto do QR”. Também dá para digitar a chave de 44 dígitos que vem embaixo do QR.', 'warn');
      }
    }
    requestAnimationFrame(() => setTimeout(tick, 60));
  };
  tick();
}
function stopScan() {
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('#scanner-video').srcObject = null;
  $('#scanner').classList.add('hidden');
}
$('#nf-scan').addEventListener('click', startScan);
$('#scanner-stop').addEventListener('click', () => { stopScan(); setStatus(nfStatus, ''); });
$('#scanner-torch').addEventListener('click', () => {
  const track = scanStream?.getVideoTracks()[0];
  if (!track) return;
  torchOn = !torchOn;
  track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
});

$('#nf-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setStatus(nfStatus, 'Lendo a foto…');
  try {
    const bmp = await createImageBitmap(file);
    const text = await decodeImage(bmp);
    if (text) handleNf(parseNfQr(text));
    else setStatus(nfStatus, 'Não achei um QR Code na foto. Tire de novo mais perto, com o QR ocupando boa parte da foto e sem reflexo — ou digite a chave de 44 dígitos.', 'err');
  } catch (err) { setStatus(nfStatus, esc(err.message), 'err'); }
});

// ---------- cartões de crédito ----------
// Cada gasto no crédito pertence a um cartão (t.card = id). Gastos antigos no “Crédito”
// sem cartão ficam no primeiro cartão cadastrado.
const CARD_KEY = 'mimimei-cartao';
let currentCardId = (() => { try { return localStorage.getItem(CARD_KEY); } catch { return null; } })();
const curCard = () => store.cards.find((c) => c.id === currentCardId) || store.cards[0];
const isCardTx = (t) => !!store.cardOf(t);
const cardLabel = (c) => `${c.name} · ${c.owner}`;
const cardOwner = (card = curCard()) => card.owner;
function selectCard(id) {
  currentCardId = id;
  try { localStorage.setItem(CARD_KEY, id); } catch { /* ignora */ }
  cardPayer = null;
}
/** Opções de “quem vai pagar”: o dono do cartão, o dono junto com cada pessoa, e Outros. */
function payerChoices(card = curCard()) {
  const others = store.people.filter((p) => p !== card.owner);
  return [
    { value: card.owner, label: card.owner },
    ...others.map((p) => ({ value: `split:${p}`, label: `${card.owner} e ${p}`, debtor: p })),
    { value: OTHERS, label: 'Outros' },
  ];
}
/** Converte a escolha (“split:Robs”…) nos campos do lançamento. */
function payerPatch(value, card = curCard()) {
  if (value.startsWith('split:')) return { paidBy: SPLIT, splitWith: [card.owner, value.slice(6)] };
  return { paidBy: value, splitWith: null };
}
function payerValue(t, card = curCard()) {
  if (t.paidBy === SPLIT) {
    const w = splitPeople(t);
    return w.length === 2 && w.includes(card.owner) ? `split:${w.find((p) => p !== card.owner)}` : 'custom';
  }
  return t.paidBy;
}
function payerLabel(t, card = store.cardOf(t) || curCard()) {
  if (t.paidBy === SPLIT) {
    const w = splitPeople(t);
    return joinNames(w.includes(card.owner) ? [card.owner, ...w.filter((p) => p !== card.owner)] : w);
  }
  if (t.paidBy === OTHERS) return t.otherName ? `Outros: ${t.otherName}` : 'Outros';
  if (t.paidBy === HOUSE) return 'Casa (contas do apê)';
  return t.paidBy || '—';
}
/** Fatura (aaaa-mm) a que uma compra pertence, pelo dia de fechamento do cartão. */
function faturaOf(date, card = curCard()) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1 + (d > card.closingDay ? 1 : 0), 1, 12);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}
function faturaRange(key, card = curCard()) {
  const [y, m] = key.split('-').map(Number);
  const close = card.closingDay;
  const to = new Date(y, m - 1, Math.min(close, new Date(y, m, 0).getDate()), 12);
  const prevLast = new Date(y, m - 1, 0).getDate();
  const from = new Date(y, m - 2, Math.min(close, prevLast) + 1, 12);
  return { from: iso(from), to: iso(to) };
}
let fatura = faturaOf(iso(new Date()));
function shiftFatura(dir) {
  const [y, m] = fatura.split('-').map(Number);
  const d = new Date(y, m - 1 + dir, 1, 12);
  fatura = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderFatura();
}
$('#fat-prev').addEventListener('click', () => shiftFatura(-1));
$('#fat-next').addEventListener('click', () => shiftFatura(1));

/** Quanto cada pessoa deve ao dono do cartão por um gasto. */
function debtsOf(t, card = store.cardOf(t) || curCard()) {
  const n = store.houseSize;
  if (t.paidBy === SPLIT) {
    const w = splitPeople(t);
    return w.filter((p) => p !== card.owner).map((p) => [p, t.amount / w.length]);
  }
  if (t.paidBy === OTHERS) return [[t.otherName || 'Outros', t.amount]];
  if (t.paidBy === HOUSE) {
    const out = store.people.filter((p) => p !== card.owner).slice(0, n - 1).map((p) => [p, t.amount / n]);
    const rest = n - houseCount();
    if (rest > 0) out.push(['Casa (outros moradores)', (t.amount * rest) / n]);
    return out;
  }
  if (t.paidBy && t.paidBy !== card.owner) return [[t.paidBy, t.amount]];
  return [];
}

// --- cadastro de cartões ---
const cconf = $('#card-config');
let editingCardId = null;
function renderCardPicker() {
  const card = curCard();
  $('#card-select').innerHTML = store.cards.map((c) => {
    const n = store.transactions.filter((t) => store.cardOf(t)?.id === c.id).length;
    return `<option value="${esc(c.id)}" ${c.id === card.id ? 'selected' : ''}>${esc(cardLabel(c))} (${n})</option>`;
  }).join('');
}
function openCardConfig(card) {
  editingCardId = card?.id || null;
  $('#card-config-title').textContent = card ? `Editar “${card.name}”` : 'Novo cartão';
  cconf.name.value = card?.name || '';
  cconf.owner.innerHTML = options(store.people, card?.owner || store.me || store.people[0]);
  cconf.closingDay.value = card?.closingDay || 10;
  const used = card && store.transactions.some((t) => store.cardOf(t)?.id === card.id);
  $('#card-config-remove').classList.toggle('hidden', !card || store.cards.length < 2);
  $('#card-config-remove').title = used ? 'Mova os gastos para outro cartão antes de excluir' : '';
  cconf.classList.remove('hidden');
  cconf.name.focus();
}
$('#card-new-btn').addEventListener('click', () => openCardConfig(null));
$('#card-edit-btn').addEventListener('click', () => openCardConfig(curCard()));
$('#card-config-cancel').addEventListener('click', () => cconf.classList.add('hidden'));
$('#card-select').addEventListener('change', (e) => { selectCard(e.target.value); renderCardForm(); renderFatura(); });
cconf.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = { name: cconf.name.value.trim(), owner: cconf.owner.value, closingDay: Number(cconf.closingDay.value) || 10 };
  if (!data.name) { cconf.name.focus(); return; }
  if (editingCardId) {
    store.updateCard(editingCardId, data);
    toast(`Cartão “${data.name}” atualizado.`);
  } else {
    selectCard(store.addCard(data));
    fatura = faturaOf(iso(new Date()));
    toast(`Cartão “${data.name}” (${data.owner}) criado.`);
  }
  cconf.classList.add('hidden');
  renderCardForm(); renderFatura();
});
$('#card-config-remove').addEventListener('click', () => {
  const card = store.cards.find((c) => c.id === editingCardId);
  if (!card) return;
  const n = store.transactions.filter((t) => store.cardOf(t)?.id === card.id).length;
  if (n) { alert(`O cartão “${card.name}” tem ${n} gasto(s). Mude esses gastos para outro cartão (editando cada um) antes de excluir.`); return; }
  if (!confirm(`Excluir o cartão “${card.name}”?`)) return;
  store.removeCard(card.id);
  selectCard(store.cards[0].id);
  cconf.classList.add('hidden');
  renderCardForm(); renderFatura();
});

function renderFatura() {
  renderCardPicker();
  const card = curCard();
  const [y, m] = fatura.split('-').map(Number);
  const { from, to } = faturaRange(fatura, card);
  $('#fat-label').textContent = `Fatura ${card.name} · ${MONTHS_LONG[m - 1]} ${y}`;
  $('#fat-range').textContent = `compras de ${fmtDate(from).slice(0, 5)} a ${fmtDate(to)} · cartão de ${card.owner} · fecha dia ${card.closingDay}`;
  const all = store.transactions.filter((t) => store.cardOf(t)?.id === card.id && faturaOf(t.date, card) === fatura)
    .sort((a, b) => (b.date + (b.createdAt || '')).localeCompare(a.date + (a.createdAt || '')));
  const total = all.reduce((s, t) => s + t.amount, 0);

  const groups = new Map();
  all.forEach((t) => {
    const k = payerLabel(t, card);
    const g = groups.get(k) || { total: 0, n: 0 };
    g.total += t.amount; g.n++;
    groups.set(k, g);
  });
  const owed = new Map();
  all.forEach((t) => {
    if (t.settled) return;
    debtsOf(t, card).forEach(([who, v]) => owed.set(who, (owed.get(who) || 0) + v));
  });
  const pending = [...owed.values()].reduce((s, v) => s + v, 0);
  $('#fat-total').textContent = money(total);
  $('#fat-receive').textContent = money(pending);
  $('#fat-receive-label').textContent = `${card.owner} tem a receber`;

  const order = payerChoices(card).map((c) => c.label);
  const rows = [...groups.entries()].sort((a, b) => {
    const ia = order.findIndex((o) => a[0].startsWith(o)); const ib = order.findIndex((o) => b[0].startsWith(o));
    return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib) || b[1].total - a[1].total;
  });
  const debtorOf = new Map(payerChoices(card).filter((c) => c.debtor).map((c) => [c.label, c.debtor]));
  $('#fat-payers').innerHTML = all.length
    ? `${rows.map(([k, g]) => `<div class="payer-row"><div class="who"><b>${esc(k)}</b><span>${g.n} gasto${g.n === 1 ? '' : 's'} · ${Math.round((g.total / total) * 100)}% da fatura</span></div>
        <div class="num">${money(g.total)}${debtorOf.has(k) ? `<small>${esc(debtorOf.get(k))} deve ${money(g.total / 2)}</small>` : ''}</div></div>`).join('')}
       ${owed.size ? `<h3>Pendente para ${esc(card.owner)} receber</h3>${[...owed.entries()].sort((a, b) => b[1] - a[1]).map(([who, v]) => `<div class="payer-row"><div class="who"><b>${esc(who)}</b></div><div class="num">${money(v)}</div></div>`).join('')}`
    : `<p class="hint" style="margin:8px 0 0">✅ Nada pendente: tudo o que não era de ${esc(card.owner)} já foi acertado.</p>`}`
    : '<p class="empty">Nenhum gasto nesta fatura ainda.</p>';

  const filterSel = $('#fat-filter');
  const cur = filterSel.value;
  filterSel.innerHTML = `<option value="">Todos</option>${[...groups.keys()].map((k) => `<option ${k === cur ? 'selected' : ''}>${esc(k)}</option>`).join('')}`;
  const list = cur ? all.filter((t) => payerLabel(t, card) === cur) : all;
  const payerOpts = (t) => {
    const opts = payerChoices(card);
    const v = payerValue(t, card);
    if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: payerLabel(t, card) });
    return opts.map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  };
  $('#fat-table').innerHTML = list.length
    ? `<thead><tr><th>Data</th><th>Descrição / tipo</th><th class="num">Valor</th><th>Quem paga</th></tr></thead><tbody>${
      list.map((t) => {
        const debt = debtsOf(t, card).length > 0;
        return `<tr data-id="${t.id}" class="${t.settled ? 'settled' : ''}">
        <td>${fmtDate(t.date).slice(0, 5)}</td>
        <td><button type="button" class="desc-link" data-act="edit">${esc(t.description || t.place || '—')}</button>${t.installment ? ` <span class="badge">${esc(t.installment)}</span>` : ''}
          <span class="sub">${esc(t.category)}${t.paidBy === OTHERS && t.otherName ? ` · ${esc(t.otherName)}` : ''}</span></td>
        <td class="num">${money(t.amount)}</td>
        <td><select class="payer">${payerOpts(t)}</select>
          ${debt ? `<label class="settle"><input type="checkbox" class="settled-cb" ${t.settled ? 'checked' : ''}> acertado</label>` : ''}</td>
      </tr>`;
      }).join('')}</tbody>`
    : '<tbody><tr><td class="empty">Sem gastos para mostrar.</td></tr></tbody>';

  $('#other-list').innerHTML = [...new Set(store.transactions.map((t) => t.otherName).filter(Boolean))].map((v) => `<option value="${esc(v)}">`).join('');
}
$('#fat-filter').addEventListener('change', renderFatura);
$('#fat-table').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const t = store.transactions.find((x) => x.id === tr.dataset.id);
  if (!t) return;
  if (e.target.classList.contains('payer')) {
    if (e.target.value === 'custom') return;
    const patch = { ...payerPatch(e.target.value, store.cardOf(t) || curCard()), settled: false };
    if (e.target.value === OTHERS) {
      const name = prompt('Quem vai pagar? (nome)', t.otherName || '');
      patch.otherName = (name || '').trim();
    }
    store.update(t.id, patch);
    toast(`Agora quem paga “${t.description}” é ${payerLabel({ ...t, ...patch })}.`);
  }
  if (e.target.classList.contains('settled-cb')) {
    store.update(t.id, { settled: e.target.checked });
  }
  renderFatura();
});
$('#fat-table').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act=edit]');
  if (b) editTx(b.closest('tr').dataset.id);
});

// formulário rápido do cartão
const cform = $('#card-form');
let cardPayer = null;
function renderCardForm() {
  const card = curCard();
  if (!cform.date.value) cform.date.value = iso(new Date());
  const cats = store.categoriesFor('gasto').map((c) => c.name);
  const curCat = cform.category.value || 'Outros gastos';
  cform.category.innerHTML = options(cats, cats.includes(curCat) ? curCat : 'Outros gastos');
  if (!cardPayer || !payerChoices(card).some((c) => c.value === cardPayer)) cardPayer = card.owner;
  $('#card-payer').innerHTML = payerChoices(card).map((c) => `<button type="button" data-v="${esc(c.value)}" class="${c.value === cardPayer ? 'on' : ''}">${esc(c.label)}</button>`).join('');
  $('#card-other-wrap').classList.toggle('hidden', cardPayer !== OTHERS);
  $('#card-form h2').textContent = `Novo gasto no ${card.name}`;
}
$('#card-payer').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  cardPayer = b.dataset.v;
  renderCardForm();
  if (cardPayer === OTHERS) cform.otherName.focus();
});
cform.description.addEventListener('change', () => {
  cform.category.value = store.suggestCategory({ description: cform.description.value, type: 'gasto' });
});
cform.addEventListener('submit', (e) => {
  e.preventDefault();
  const card = curCard();
  const amount = Math.abs(parseMoney(cform.amount.value));
  if (!Number.isFinite(amount) || !amount) { toast('Informe um valor válido.'); cform.amount.focus(); return; }
  if (cardPayer === OTHERS && !cform.otherName.value.trim()) { toast('Diga quem vai pagar.'); cform.otherName.focus(); return; }
  const tx = {
    type: 'gasto', date: cform.date.value, amount: Math.round(amount * 100) / 100,
    description: cform.description.value.trim(), place: '', category: cform.category.value,
    ...payerPatch(cardPayer, card), payment: 'Crédito', card: card.id, source: 'manual', note: '',
    ...(cardPayer === OTHERS ? { otherName: cform.otherName.value.trim() } : {}),
    ...(cform.installment.value.trim() ? { installment: cform.installment.value.trim() } : {}),
  };
  store.add(tx);
  fatura = faturaOf(tx.date, card);
  toast(`Adicionado à fatura ${card.name} de ${MONTHS_LONG[Number(fatura.slice(5)) - 1]}: ${money(tx.amount)} (${payerLabel(tx, card)}).`);
  const keepDate = cform.date.value;
  cform.reset();
  cform.date.value = keepDate;
  renderCardForm();
  renderFatura();
  cform.description.focus();
});
$('#card-import').addEventListener('click', () => {
  importKind = 'cartao';
  $('#imp-file').click();
});

// ---------- importar extrato ----------
let imp = null; // { kind, rows?, map?, items: [...] }
let importKind = 'extrato'; // 'extrato' (banco) ou 'cartao' (fatura do cartão)
const impStatus = $('#imp-status');
const FATURA_PAYMENT = /pagamento.{0,20}(fatura|cart)|pgto.{0,10}(fat|cart)|fatura.{0,20}cart|pagto.{0,10}cart/i;

function setImportKind(kind) {
  importKind = kind;
  $$('#imp-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  const card = kind === 'cartao';
  $('#imp-paidby').closest('label').classList.toggle('hidden', card);
  $('#imp-payment').closest('label').classList.toggle('hidden', card);
  $('#imp-card-wrap').classList.toggle('hidden', !card);
  if (card) {
    const sel = $('#imp-card');
    const keep = sel.value || curCard().id;
    sel.innerHTML = store.cards.map((c) => `<option value="${esc(c.id)}" ${c.id === keep ? 'selected' : ''}>${esc(cardLabel(c))}</option>`).join('');
    $('#imp-payment').value = 'Crédito';
    if (!$('#imp-account').dataset.touched) $('#imp-account').value = importCard().name;
    if (imp?.kind === 'csv') $('#imp-invert').checked = true;
  }
}
const importCard = () => store.cards.find((c) => c.id === $('#imp-card').value) || curCard();
$('#imp-card').addEventListener('change', () => {
  if (!$('#imp-account').dataset.touched) $('#imp-account').value = importCard().name;
  buildImport();
});
$$('#imp-kind button').forEach((b) => b.addEventListener('click', () => { setImportKind(b.dataset.kind); buildImport(); }));
$('#imp-account').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });

$('#imp-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await readText(file);
  const name = file.name.toLowerCase();
  $('#imp-account').value = file.name.replace(/\.[^.]+$/, '');
  $('#imp-account').dataset.touched = '';
  $('#imp-paidby').innerHTML = paidByOptions(store.me || store.people[0]);
  $('#imp-payment').innerHTML = options(PAYMENTS, 'Débito');
  $('#imp-invert').checked = false;

  if (name.endsWith('.xml') || /<infNFe/i.test(text)) {
    showTab('lancar');
    readXmlFiles([file]);
    return;
  }
  if (name.endsWith('.ofx') || name.endsWith('.qfx') || /<OFX>/i.test(text)) {
    const acct = (text.match(/<ACCTID>([^<\r\n]+)/i) || [])[1];
    if (acct) $('#imp-account').value = acct.trim();
    imp = { kind: 'ofx', text };
    if (/<CREDITCARDMSGSRSV1>/i.test(text)) importKind = 'cartao';
    $('#csv-map').innerHTML = '';
  } else {
    const rows = parseCsvRows(text);
    if (!rows.length) { setStatus(impStatus, 'Arquivo vazio.', 'err'); return; }
    imp = { kind: 'csv', rows, map: guessCsvColumns(rows) };
    if (/fatura|cartao|card|credito/i.test(name)) importKind = 'cartao';
    renderCsvMap();
  }
  showTab('importar');
  setImportKind(importKind);
  $('#imp-config').classList.remove('hidden');
  buildImport();
});

async function readText(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // muitos bancos exportam em Latin-1/Windows-1252
  if (utf8.includes('�')) return new TextDecoder('windows-1252').decode(buf);
  return utf8;
}

function renderCsvMap() {
  const { rows, map } = imp;
  const header = map.headerRow >= 0 ? rows[map.headerRow] : rows[0].map((_, i) => `Coluna ${i + 1}`);
  const sample = rows[map.headerRow + 1] || [];
  const opts = (sel, allowNone) => `${allowNone ? '<option value="">—</option>' : ''}${header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || `Coluna ${i + 1}`)}${sample[i] ? ` (ex.: ${esc(sample[i].slice(0, 20))})` : ''}</option>`).join('')}`;
  const useSplit = map.value == null;
  $('#csv-map').innerHTML = `
    <label>Coluna da data<select data-k="date">${opts(map.date)}</select></label>
    <label>Coluna da descrição<select data-k="desc">${opts(map.desc, true)}</select></label>
    ${useSplit
    ? `<label>Coluna de crédito<select data-k="credit">${opts(map.credit)}</select></label>
         <label>Coluna de débito<select data-k="debit">${opts(map.debit)}</select></label>`
    : `<label>Coluna do valor<select data-k="value">${opts(map.value)}</select></label>`}
    <label>Primeira linha é cabeçalho?<select data-k="headerRow">
      <option value="${Math.max(map.headerRow, 0)}" ${map.headerRow >= 0 ? 'selected' : ''}>Sim (linha ${Math.max(map.headerRow, 0) + 1})</option>
      <option value="-1" ${map.headerRow < 0 ? 'selected' : ''}>Não</option></select></label>`;
  $$('#csv-map select').forEach((s) => s.addEventListener('change', () => {
    imp.map[s.dataset.k] = s.value === '' ? null : Number(s.value);
    buildImport();
  }));
}
['#imp-invert', '#imp-account', '#imp-paidby', '#imp-payment'].forEach((s) => $(s).addEventListener('change', buildImport));

function buildImport() {
  if (!imp) return;
  const account = $('#imp-account').value.trim() || 'conta';
  let parsed;
  try {
    parsed = imp.kind === 'ofx'
      ? parseOfx(imp.text).map((t) => ($('#imp-invert').checked ? { ...t, amount: -t.amount } : t))
      : csvToTransactions(imp.rows, imp.map, { invert: $('#imp-invert').checked, account });
  } catch (e) { setStatus(impStatus, `Não consegui ler o arquivo: ${esc(e.message)}`, 'err'); return; }
  if (!parsed.length) {
    setStatus(impStatus, 'Nenhum lançamento encontrado. Confira as colunas abaixo.', 'warn');
    $('#imp-review').classList.add('hidden');
    return;
  }
  const card = importKind === 'cartao';
  const icard = importCard();
  const paidBy = card ? icard.owner : $('#imp-paidby').value;
  const payment = card ? 'Crédito' : $('#imp-payment').value;
  imp.items = parsed.map((p) => {
    const type = p.amount < 0 ? 'gasto' : 'entrada';
    const amount = Math.round(Math.abs(p.amount) * 100) / 100;
    const already = store.findByDedupKey(p.dedupKey);
    const similar = !already && store.findSimilar({ date: p.date, amount, type, source: 'extrato' });
    // na fatura, créditos são pagamentos/estornos; no extrato, o pagamento da fatura já está na aba Cartão
    const skip = card ? (type === 'entrada' ? 'crédito na fatura (pagamento ou estorno)' : '')
      : (type === 'gasto' && FATURA_PAYMENT.test(p.description) ? 'pagamento da fatura — os gastos já estão na aba Cartão' : '');
    const inst = p.description.match(/(?:parc(?:ela)?\.?\s*)?\b(\d{1,2})\s*\/\s*(\d{1,2})\b/i);
    return {
      tx: {
        type, date: p.date, amount, description: p.description, place: '',
        category: store.suggestCategory({ description: p.description, type }),
        paidBy, payment: type === 'gasto' ? payment : 'Transferência', note: `Importado de ${account}`,
        source: 'extrato', dedupKey: p.dedupKey,
        ...(card ? { card: icard.id } : {}),
        ...(card && inst ? { installment: `${inst[1]}/${inst[2]}` } : {}),
      },
      already, similar, skip, include: !already && !similar && !skip,
    };
  });
  setStatus(impStatus, '');
  renderImportTable();
}

function renderImportTable() {
  const items = imp.items;
  const fresh = items.filter((i) => !i.already);
  const dup = items.length - fresh.length;
  const sim = items.filter((i) => i.similar).length;
  $('#imp-summary').innerHTML = `${items.length} lançamentos no arquivo · <b>${fresh.length} novos</b>${dup ? ` · ${dup} já importados antes (ignorados)` : ''}${sim ? ` · <span class="badge warn">${sim} parecem já ter sido lançados por nota fiscal ou à mão — vêm desmarcados</span>` : ''}`;
  const card = importKind === 'cartao';
  const payerSelect = (t) => payerChoices(importCard()).map((c) => `<option value="${esc(c.value)}" ${c.value === payerValue(t, importCard()) ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  $('#imp-table').innerHTML = `<thead><tr><th></th><th>Data</th><th>Descrição</th><th>${card ? 'Tipo / quem paga' : 'Categoria'}</th><th class="num">Valor</th></tr></thead><tbody>${
    items.map((it, i) => {
      if (it.already) return '';
      const t = it.tx;
      return `<tr data-i="${i}" class="${it.include ? '' : 'dim'}">
        <td><input type="checkbox" class="imp-inc" ${it.include ? 'checked' : ''}></td>
        <td>${fmtDate(t.date)}</td>
        <td>${esc(t.description)}${it.similar ? `<span class="badge warn" title="${esc(it.similar.description || '')}">parecido com ${sourceName(it.similar.source)} de ${fmtDate(it.similar.date)}</span>` : ''}${it.skip ? `<span class="badge warn">${esc(it.skip)}</span>` : ''}</td>
        <td><select class="imp-cat">${options(store.categoriesFor(t.type).map((c) => c.name), t.category)}</select>
          ${card && t.type === 'gasto' ? `<select class="imp-payer" style="margin-top:4px">${payerSelect(t)}</select><input type="text" class="imp-other ${t.paidBy === OTHERS ? '' : 'hidden'}" placeholder="Quem? (nome)" value="${esc(t.otherName || '')}" style="margin-top:4px">` : ''}</td>
        <td class="num ${t.type === 'entrada' ? 'pos' : ''}">${t.type === 'entrada' ? '+' : '−'}${money(t.amount)}</td>
      </tr>`;
    }).join('')}</tbody>`;
  $$('#imp-table tr[data-i]').forEach((tr) => {
    const it = items[Number(tr.dataset.i)];
    $('.imp-inc', tr).addEventListener('change', (e) => { it.include = e.target.checked; tr.classList.toggle('dim', !it.include); updateImportButton(); });
    $('.imp-payer', tr)?.addEventListener('change', (e) => {
      Object.assign(it.tx, payerPatch(e.target.value, importCard()));
      $('.imp-other', tr).classList.toggle('hidden', e.target.value !== OTHERS);
      if (e.target.value === OTHERS) $('.imp-other', tr).focus(); else it.tx.otherName = '';
    });
    $('.imp-other', tr)?.addEventListener('input', (e) => { it.tx.otherName = e.target.value.trim(); });
    $('.imp-cat', tr).addEventListener('change', (e) => {
      it.tx.category = e.target.value;
      // aplica a mesma categoria às outras linhas com a mesma descrição
      items.forEach((o, j) => {
        if (o !== it && !o.already && o.tx.type === it.tx.type && o.tx.description === it.tx.description) {
          o.tx.category = e.target.value;
          const sel = $(`#imp-table tr[data-i="${j}"] .imp-cat`);
          if (sel) sel.value = e.target.value;
        }
      });
    });
  });
  $('#imp-all').checked = fresh.every((i) => i.include);
  $('#imp-review').classList.remove('hidden');
  updateImportButton();
}
function updateImportButton() {
  const n = imp.items.filter((i) => i.include && !i.already).length;
  $('#imp-confirm').textContent = `Importar ${n} lançamento${n === 1 ? '' : 's'}`;
  $('#imp-confirm').disabled = n === 0;
}
$('#imp-all').addEventListener('change', (e) => {
  imp.items.forEach((i) => { if (!i.already) i.include = e.target.checked; });
  renderImportTable();
});
$('#imp-confirm').addEventListener('click', () => {
  const list = imp.items.filter((i) => i.include && !i.already).map((i) => i.tx);
  const n = store.addMany(list);
  toast(`${n} lançamento(s) importado(s).`);
  const wasCard = importKind === 'cartao';
  const icard = importCard();
  const first = list[0];
  closeImport();
  if (wasCard && first) { selectCard(icard.id); fatura = faturaOf(first.date, icard); showTab('cartao'); } else showTab('painel');
});
$('#imp-cancel').addEventListener('click', closeImport);
function closeImport() {
  imp = null;
  importKind = 'extrato';
  $('#imp-card').value = '';
  $('#imp-config').classList.add('hidden');
  $('#imp-review').classList.add('hidden');
  setStatus(impStatus, '');
}

// ---------- lista ----------
function renderList() {
  const { from, to } = periodRange();
  $('#list-period').textContent = periodLabel();
  const cats = [...new Set(store.state.categories.map((c) => c.name))];
  const catSel = $('#list-cat');
  const cur = catSel.value;
  catSel.innerHTML = `<option value="">Todas categorias</option>${options(cats, cur)}`;
  const q = $('#list-search').value.trim().toLowerCase();
  const type = $('#list-type').value;
  const list = txInRange(from, to)
    .filter((t) => !type || t.type === type)
    .filter((t) => !catSel.value || t.category === catSel.value)
    .filter((t) => !q || [t.description, t.place, t.category, t.note, t.paidBy, (t.nf?.itens || t.itens || []).map((i) => i.descricao).join(' ')]
      .join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const total = list.reduce((s, t) => s + (t.type === 'entrada' ? ours(t) : -ours(t)), 0);
  $('#list-table').innerHTML = list.length
    ? `<thead><tr><th>Data</th><th>Descrição</th><th class="col-cat">Categoria</th><th class="num">Valor</th></tr></thead><tbody>${
      list.map((t) => `<tr class="clickable" title="Toque para editar" data-id="${t.id}">
        <td>${fmtDate(t.date).slice(0, 5)}<span class="sub">${t.date.slice(0, 4)}</span></td>
        <td>${esc(t.description || t.place || '—')}${t.source === 'nf' ? '<span class="badge">🧾 NF</span>' : t.source === 'extrato' ? '<span class="badge">🏦</span>' : ''}${isCardTx(t) ? `<span class="badge">💳 ${esc(store.cardOf(t).name)}</span>` : ''}${t.itens?.length ? `<span class="badge">🛒 ${t.itens.length} itens</span>` : ''}
          <span class="sub">${esc([t.place && t.place !== t.description ? t.place : '', paidByLabel(t), t.payment, t.createdByName && store.backendKind === 'cloud' ? `lançado por ${t.createdByName}` : ''].filter(Boolean).join(' · '))}</span></td>
        <td class="col-cat">${esc(t.category)}</td>
        <td class="num ${t.type === 'entrada' ? 'pos' : ''}">${t.type === 'entrada' ? '+' : '−'}${money(ours(t))}${t.paidBy === HOUSE ? `<span class="sub">de ${money(t.amount)}</span>` : ''}<span class="sub only-mobile">${esc(t.category)}</span></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2"><b>${list.length} lançamentos</b></td><td class="col-cat"></td><td class="num ${total >= 0 ? 'pos' : 'neg'}"><b>${money(total)}</b></td></tr></tfoot>`
    : '<tbody><tr><td class="empty">Nada por aqui neste período.</td></tr></tbody>';
}
$('#list-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) editTx(tr.dataset.id);
});
$('#form-delete').addEventListener('click', () => {
  if (!editingId || !confirm('Excluir este lançamento?')) return;
  store.remove(editingId);
  toast('Lançamento excluído.');
  resetForm();
  showTab('lista');
});
['#list-search', '#list-type', '#list-cat'].forEach((s) => $(s).addEventListener('input', renderList));

// ---------- ajustes ----------
function renderSettings() {
  renderCard();
  $('#house-size').value = store.houseSize;
  renderPeople();
  $('#cat-new-group').innerHTML = options(GROUPS, 'Outras compras');
  const used = new Set(store.transactions.map((t) => t.category));
  $('#cat-list').innerHTML = store.state.categories.map((c) => `<div class="cat-row" data-name="${esc(c.name)}">
    <span>${esc(c.name)}</span>
    <select>${options(GROUPS, c.group)}</select>
    <button class="btn small danger" ${used.has(c.name) ? 'disabled title="Em uso"' : ''}>✕</button></div>`).join('');
  $$('#cat-list .cat-row').forEach((row) => {
    const name = row.dataset.name;
    $('select', row).addEventListener('change', (e) => store.setCategoryGroup(name, e.target.value));
    $('button', row).addEventListener('click', () => { store.removeCategory(name); renderSettings(); });
  });
}
$('#house-size').addEventListener('change', (e) => {
  store.setHouseSize(e.target.value);
  e.target.value = store.houseSize;
  toast(`Contas da casa divididas por ${store.houseSize}: cada um de vocês fica com 1/${store.houseSize}.`);
});
function renderPeople() {
  const meMap = store.state.personOf || {};
  const linked = (p) => Object.entries(meMap).filter(([, v]) => v === p).map(([uid]) => store.state.memberNames?.[uid]).filter(Boolean);
  $('#people-list').innerHTML = store.people.map((p) => {
    const u = store.usageOf(p);
    const who = linked(p);
    const info = [u.tx ? `${u.tx} lançamento${u.tx === 1 ? '' : 's'}` : 'sem lançamentos', u.cards ? `${u.cards} cartão(ões)` : '', who.length ? `login: ${who.join(', ')}` : ''].filter(Boolean).join(' · ');
    const canRemove = !u.tx && !u.cards && store.people.length > 1;
    return `<div class="cat-row person-row" data-name="${esc(p)}">
      <div style="flex:1;min-width:0"><input type="text" value="${esc(p)}" aria-label="Nome"><span class="sub">${esc(info)}</span></div>
      <button class="btn small danger" ${canRemove ? '' : 'disabled title="Só dá para remover quem não tem lançamentos nem cartões"'} aria-label="Remover">✕</button></div>`;
  }).join('');
  $$('#people-list .person-row').forEach((row) => {
    const old = row.dataset.name;
    $('input', row).addEventListener('change', (e) => {
      if (store.renamePerson(old, e.target.value)) { toast(`“${old}” agora é “${e.target.value.trim()}” em todo o app.`); resetForm(); }
      else { e.target.value = old; toast('Nome vazio ou já usado por outra pessoa.'); }
      renderPeople();
    });
    $('button', row).addEventListener('click', () => {
      if (confirm(`Remover “${old}” da conta?`) && store.removePerson(old)) { toast(`“${old}” removido.`); resetForm(); renderPeople(); }
    });
  });
}
$('#person-add').addEventListener('click', () => {
  const name = $('#person-new').value.trim();
  if (store.addPerson(name)) { $('#person-new').value = ''; toast(`${name} adicionado(a). Já aparece no “Pago por”.`); resetForm(); renderPeople(); }
  else toast('Nome vazio ou já existe.');
});
$('#person-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#person-add').click(); } });
$('#cat-add').addEventListener('click', () => {
  const name = $('#cat-new').value.trim();
  if (store.addCategory(name, $('#cat-new-group').value)) { $('#cat-new').value = ''; renderSettings(); resetForm(); }
  else toast('Categoria vazia ou já existe.');
});
$('#backup-export').addEventListener('click', () => {
  download(`mimimei-backup-${iso(new Date())}.json`, store.exportJson(), 'application/json');
});
$('#backup-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const n = store.mergeBackup(await f.text());
    fixHouseSplit();
    setStatus($('#backup-status'), `${n} lançamento(s) novo(s) restaurado(s). Os que já existiam foram mantidos sem duplicar.`, 'ok');
    renderSettings();
  } catch (err) { setStatus($('#backup-status'), esc(err.message), 'err'); }
});
$('#csv-export').addEventListener('click', () => {
  const head = ['Data', 'Tipo', 'Valor', 'Parte de vocês', 'Descrição', 'Local', 'Categoria', 'Grupo', 'Pago/Recebido por', 'Forma de pagamento', 'Origem', 'Chave NF', 'Observação'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [...store.transactions].sort((a, b) => a.date.localeCompare(b.date)).map((t) => [
    fmtDate(t.date), t.type, t.amount.toFixed(2).replace('.', ','), ours(t).toFixed(2).replace('.', ','), t.description, t.place, t.category,
    store.groupOf(t.category), t.paidBy, t.payment, sourceName(t.source), t.nf?.chave || '', t.note,
  ].map(cell).join(';'));
  download(`mimimei-${iso(new Date())}.csv`, `﻿${head.map(cell).join(';')}\n${lines.join('\n')}`, 'text/csv');
});
$('#wipe').addEventListener('click', () => {
  const where = store.backendKind === 'cloud' ? `da conta “${store.state.householdName}” (para todos os membros)` : 'deste aparelho';
  if (confirm(`Apagar TODOS os lançamentos ${where}? Faça um backup antes.`) && confirm('Tem certeza? Não dá para desfazer.')) {
    store.wipe(); toast('Dados apagados.'); renderSettings(); resetForm();
  }
});

// ---------- início ----------
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if ($('#tab-painel').classList.contains('active')) renderTimeChart(); }, 150);
});
// Quando os dados mudam (outro celular lançou, troca de conta…), redesenha sem apagar o que está sendo digitado.
let changeTimer;
let lastMe = null;
store.onChange(() => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const active = $('.panel.active')?.id;
    if (active === 'tab-painel') renderDashboard();
    if (active === 'tab-lista') renderList();
    if (active === 'tab-cartao') { renderCardForm(); renderFatura(); }
    if (active === 'tab-ajustes' && !document.activeElement?.closest('#tab-ajustes')) renderSettings();
    // se o login acabou de ser ligado a uma pessoa, o formulário em branco passa a usá-la
    const meChanged = store.me && store.me !== lastMe;
    lastMe = store.me;
    const blank = !editingId && !form.amount.value;
    fillFormSelects(form.category.value, meChanged && blank ? store.me : form.paidBy.value, form.payment.value);
    refreshDatalists();
  }, 50);
});

function fixHouseSplit() {
  const removed = store.trimPlanilhaBefore('2026-07-01');
  const n = store.migrateHouseSplit(SPLIT, HOUSE);
  const msgs = [];
  if (removed) msgs.push(`${removed} lançamentos da planilha anteriores a julho removidos`);
  if (n) msgs.push(`${n} contas do apê corrigidas para “${HOUSE}” (÷${store.houseSize})`);
  if (msgs.length) toast(`${msgs.join(' · ')}.`);
}
if (store.backendKind === 'local') fixHouseSplit();
resetForm();
renderDashboard();
initAccount({
  toast,
  showTab,
  onAccountChange: () => { fixHouseSplit(); if (!editingId) resetForm(); renderDashboard(); },
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
