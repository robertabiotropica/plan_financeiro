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
const ours = (t) => (t.paidBy === HOUSE ? (t.amount * 2) / store.houseSize : t.amount);

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
function peopleOptions() { return [...store.people, SPLIT, HOUSE]; }
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
  if (t.paidBy === SPLIT) return t.amount / 2;
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
    <p class="hint" style="margin:8px 0 0">“${SPLIT}” conta metade para cada um. “${HOUSE}” (contas do apê) conta 1/${store.houseSize} para cada um — só a parte de vocês entra nos totais.</p>`;

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

function fillFormSelects(category, paidBy, payment) {
  form.category.innerHTML = options(store.categoriesFor(formType).map((c) => c.name), category);
  form.paidBy.innerHTML = options(peopleOptions(), paidBy);
  form.payment.innerHTML = options(['', ...PAYMENTS], payment);
  $('#paidby-label').textContent = formType === 'entrada' ? 'Recebido por' : 'Pago por';
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
  };
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
  if (nf.formaPagamento) form.payment.value = nf.formaPagamento;
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
        paidBy: store.people[0], payment: nf.formaPagamento, note: '', source: 'nf', dedupKey: `nf:${nf.chave}`, nf,
      });
      ok++;
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  setStatus(nfStatus, `${ok} nota(s) lançada(s) como pagas por ${esc(store.people[0])}${dup ? `, ${dup} já existia(m) e foi(ram) ignorada(s)` : ''}.${errors.length ? `<br>Erros: ${errors.map(esc).join('<br>')}` : ''} Ajuste quem pagou na aba Lançamentos, se precisar.`, errors.length ? 'warn' : 'ok');
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

// ---------- importar extrato ----------
let imp = null; // { kind, rows?, map?, items: [...] }
const impStatus = $('#imp-status');

$('#imp-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await readText(file);
  const name = file.name.toLowerCase();
  $('#imp-account').value = file.name.replace(/\.[^.]+$/, '');
  $('#imp-paidby').innerHTML = options(peopleOptions(), store.people[0]);
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
    if (/<CREDITCARDMSGSRSV1>/i.test(text)) $('#imp-payment').value = 'Crédito';
    imp = { kind: 'ofx', text };
    $('#csv-map').innerHTML = '';
  } else {
    const rows = parseCsvRows(text);
    if (!rows.length) { setStatus(impStatus, 'Arquivo vazio.', 'err'); return; }
    imp = { kind: 'csv', rows, map: guessCsvColumns(rows) };
    if (/fatura|cartao|card/i.test(name)) { $('#imp-invert').checked = true; $('#imp-payment').value = 'Crédito'; }
    renderCsvMap();
  }
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
  const paidBy = $('#imp-paidby').value; const payment = $('#imp-payment').value;
  imp.items = parsed.map((p) => {
    const type = p.amount < 0 ? 'gasto' : 'entrada';
    const amount = Math.round(Math.abs(p.amount) * 100) / 100;
    const already = store.findByDedupKey(p.dedupKey);
    const similar = !already && store.findSimilar({ date: p.date, amount, type, source: 'extrato' });
    return {
      tx: {
        type, date: p.date, amount, description: p.description, place: '',
        category: store.suggestCategory({ description: p.description, type }),
        paidBy, payment: type === 'gasto' ? payment : 'Transferência', note: `Importado de ${account}`,
        source: 'extrato', dedupKey: p.dedupKey,
      },
      already, similar, include: !already && !similar,
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
  $('#imp-table').innerHTML = `<thead><tr><th></th><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th></tr></thead><tbody>${
    items.map((it, i) => {
      if (it.already) return '';
      const t = it.tx;
      return `<tr data-i="${i}" class="${it.include ? '' : 'dim'}">
        <td><input type="checkbox" class="imp-inc" ${it.include ? 'checked' : ''}></td>
        <td>${fmtDate(t.date)}</td>
        <td>${esc(t.description)}${it.similar ? `<span class="badge warn" title="${esc(it.similar.description || '')}">parecido com ${sourceName(it.similar.source)} de ${fmtDate(it.similar.date)}</span>` : ''}</td>
        <td><select class="imp-cat">${options(store.categoriesFor(t.type).map((c) => c.name), t.category)}</select></td>
        <td class="num ${t.type === 'entrada' ? 'pos' : ''}">${t.type === 'entrada' ? '+' : '−'}${money(t.amount)}</td>
      </tr>`;
    }).join('')}</tbody>`;
  $$('#imp-table tr[data-i]').forEach((tr) => {
    const it = items[Number(tr.dataset.i)];
    $('.imp-inc', tr).addEventListener('change', (e) => { it.include = e.target.checked; tr.classList.toggle('dim', !it.include); updateImportButton(); });
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
  closeImport();
  showTab('painel');
});
$('#imp-cancel').addEventListener('click', closeImport);
function closeImport() {
  imp = null;
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
        <td>${esc(t.description || t.place || '—')}${t.source === 'nf' ? '<span class="badge">🧾 NF</span>' : t.source === 'extrato' ? '<span class="badge">🏦</span>' : ''}${t.itens?.length ? `<span class="badge">🛒 ${t.itens.length} itens</span>` : ''}
          <span class="sub">${esc([t.place && t.place !== t.description ? t.place : '', t.paidBy, t.payment, t.createdByName && store.backendKind === 'cloud' ? `lançado por ${t.createdByName}` : ''].filter(Boolean).join(' · '))}</span></td>
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
  $('#person-0').value = store.people[0];
  $('#person-1').value = store.people[1];
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
['#person-0', '#person-1'].forEach((s) => $(s).addEventListener('change', () => {
  store.setPeople($('#person-0').value.trim(), $('#person-1').value.trim());
  toast('Nomes atualizados.');
  resetForm();
}));
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
store.onChange(() => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const active = $('.panel.active')?.id;
    if (active === 'tab-painel') renderDashboard();
    if (active === 'tab-lista') renderList();
    if (active === 'tab-ajustes' && !document.activeElement?.closest('#tab-ajustes')) renderSettings();
    fillFormSelects(form.category.value, form.paidBy.value, form.payment.value);
    refreshDatalists();
  }, 50);
});

function fixHouseSplit() {
  const n = store.migrateHouseSplit(SPLIT, HOUSE);
  if (n) toast(`${n} contas do apê corrigidas para “${HOUSE}” (÷${store.houseSize}).`);
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
