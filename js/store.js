// Armazenamento local (localStorage) + regras de deduplicação.

import { normalizeText } from './parsers.js';

// Chave mantida do nome antigo para não perder dados já salvos nos aparelhos.
const KEY = 'nossas-financas-v1';

export const GROUPS = ['Contas apê', 'Mercado', 'Outras compras', 'Entradas'];

const DEFAULT_CATEGORIES = [
  ['Mercado', 'Mercado'],
  ['Feira', 'Outras compras'],
  ['Aluguel', 'Contas apê'], ['Condomínio', 'Contas apê'], ['IPTU', 'Contas apê'],
  ['Seguro', 'Contas apê'], ['Luz', 'Contas apê'], ['Gás', 'Contas apê'],
  ['Internet', 'Contas apê'], ['Caixinha', 'Contas apê'],
  ['Casa & Decoração', 'Outras compras'], ['Plantas & Jardim', 'Outras compras'],
  ['Vestuário', 'Outras compras'], ['Lazer', 'Outras compras'],
  ['Restaurante & Delivery', 'Outras compras'], ['Transporte', 'Outras compras'],
  ['Saúde & Farmácia', 'Outras compras'], ['Assinaturas', 'Outras compras'],
  ['Outros gastos', 'Outras compras'],
  ['Salário', 'Entradas'], ['Freela / Extra', 'Entradas'], ['Reembolso', 'Entradas'],
  ['Outras entradas', 'Entradas'],
].map(([name, group]) => ({ name, group }));

export const PAYMENTS = ['Débito', 'Crédito', 'Pix', 'Dinheiro', 'Boleto', 'Vale', 'Transferência'];

// Palavras-chave para sugerir categoria quando ainda não há histórico.
const KEYWORD_RULES = [
  [/supermerc|mercado|atacad|assai|carrefour|extra |pao de acucar|hortifruti|oba |sonda|dia brasil/, 'Mercado'],
  [/ceagesp|feira|sacolao/, 'Feira'],
  [/ifood|rappi|restaur|lanchon|padaria|pizz|burger|bar |cafe|cafeteria/, 'Restaurante & Delivery'],
  [/uber|99 ?app|99pop|taxi|metro|sptrans|bilhete|posto|combust|shell|ipiranga|estacion/, 'Transporte'],
  [/farmac|drogas|droga raia|drogasil|pague menos|hospital|clinica|laborat|unimed/, 'Saúde & Farmácia'],
  [/netflix|spotify|disney|prime video|amazon prime|hbo|max |youtube|apple\.com|google one|deezer/, 'Assinaturas'],
  [/enel|eletropaulo|light |cemig|copel|energia/, 'Luz'],
  [/comgas|naturgy|\bgas\b/, 'Gás'],
  [/vivo|claro|tim |oi fibra|net servicos|internet/, 'Internet'],
  [/aluguel|quinto ?andar|imobili/, 'Aluguel'],
  [/condomin/, 'Condomínio'],
  [/iptu/, 'IPTU'],
  [/seguro/, 'Seguro'],
  [/renner|riachuelo|c&a|zara|hering|marisa|shein/, 'Vestuário'],
  [/leroy|tok ?stok|etna|camicado|mobly/, 'Casa & Decoração'],
  [/cobasi|petz|floricult|plantas|garden/, 'Plantas & Jardim'],
  [/cinema|ingresso|show|teatro|sympla/, 'Lazer'],
  [/salario|pagamento de salario|folha/, 'Salário'],
  [/reembolso|estorno/, 'Reembolso'],
];

function emptyState() {
  return {
    version: 1,
    people: ['Robs', 'Lari'],
    categories: DEFAULT_CATEGORIES,
    transactions: [],
    // memória: texto normalizado (descrição/local/CNPJ) -> categoria escolhida
    memory: {},
    // memória: CNPJ -> nome do estabelecimento
    merchants: {},
    // quantas pessoas dividem as contas da casa (opção “Dividido com a casa”)
    houseSize: 3,
    // correções de dados já aplicadas
    migrations: {},
    // cartões de crédito acompanhados na aba Cartão: { id, name, owner, closingDay }
    cards: [{ id: 'cartao', name: 'Cartão Lari', owner: 'Lari', closingDay: 10 }],
    // metas mensais por categoria: { Mercado: 1500, … }
    budgets: {},
    // contas fixas: lançadas sozinhas todo mês como “a conferir”
    recurring: [],
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...emptyState(), ...JSON.parse(raw) };
  } catch (e) { console.warn('Falha ao ler dados salvos', e); }
  return emptyState();
}

/**
 * Backend local: grava tudo no localStorage deste aparelho.
 * O backend da nuvem (cloud.js) implementa as mesmas funções gravando no Firestore.
 */
const localBackend = {
  kind: 'local',
  saveSettings() { saveLocal(); },
  putTxs() { saveLocal(); },
  patchTx() { saveLocal(); },
  deleteTx() { saveLocal(); },
};
function saveLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('Não foi possível salvar os dados neste navegador. Faça um backup.');
    throw e;
  }
}
let backend = localBackend;
let currentUser = null; // { uid, name } quando logado

function newId(tx) {
  // Lançamentos com chave de deduplicação (nota, extrato, planilha) usam um id
  // derivado dela: mesmo que dois aparelhos lancem ao mesmo tempo, vira um só.
  if (tx.dedupKey) return `k-${tx.dedupKey.replace(/[/\s]/g, '_').slice(0, 300)}`;
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function stamp(tx) {
  return {
    id: newId(tx),
    createdAt: new Date().toISOString(),
    ...(currentUser ? { createdBy: currentUser.uid, createdByName: currentUser.name } : {}),
    ...tx,
  };
}
function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

export const store = {
  get state() { return state; },
  get people() { return state.people; },
  get transactions() { return state.transactions; },
  get backendKind() { return backend.kind; },
  get user() { return currentUser; },
  /** Pessoa (ex.: Robs) associada ao login atual na conta aberta. */
  get me() { return currentUser ? state.personOf?.[currentUser.uid] || null : null; },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Liga a um backend (nuvem). `initial` é o estado vindo dele. */
  useBackend(b, user) {
    backend = b;
    currentUser = user || null;
  },
  useLocal() {
    backend = localBackend;
    currentUser = null;
    state = load();
    emit();
  },
  /** Substitui partes do estado (chamado pelos snapshots da nuvem). */
  replace(partial) {
    state = { ...state, ...partial };
    emit();
  },
  /** Dados salvos só neste aparelho (para enviar para a nuvem). */
  localData() { return load(); },
  clearLocalData() { localStorage.removeItem(KEY); },
  settings() {
    return {
      people: state.people, categories: state.categories, memory: state.memory, merchants: state.merchants,
      houseSize: state.houseSize || 3, migrations: state.migrations || {}, cards: this.cards, budgets: state.budgets || {}, recurring: state.recurring || [],
    };
  },
  defaultSettings() {
    const e = emptyState();
    return { people: e.people, categories: e.categories, memory: {}, merchants: {}, houseSize: 3, migrations: {}, cards: e.cards, budgets: {}, recurring: [] };
  },
  // ---------- contas fixas ----------
  get recurring() { return (state.recurring || []).filter((r) => r && r.id); },
  saveRecurring(list) {
    state.recurring = list;
    backend.saveSettings(this.settings());
    emit();
  },
  addRecurring(rule) {
    const id = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.saveRecurring([...this.recurring, { skip: [], active: true, ...rule, id }]);
    return id;
  },
  updateRecurring(id, patch) {
    this.saveRecurring(this.recurring.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  },
  removeRecurring(id) {
    this.saveRecurring(this.recurring.filter((r) => r.id !== id));
  },
  /**
   * Cria os lançamentos das contas fixas que ainda faltam, do mês de início até `untilMonth`
   * (aaaa-mm). Cada mês tem uma chave própria, então nunca duplica, nem entre celulares.
   */
  generateRecurring(untilMonth) {
    const out = [];
    this.recurring.filter((r) => r.active !== false).forEach((r) => {
      let [y, m] = r.start.split('-').map(Number);
      for (let guard = 0; guard < 120; guard++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if (key > untilMonth) break;
        const dedupKey = `rec:${r.id}:${key}`;
        // já existe um lançamento equivalente nesse mês (ex.: lançado à mão ou vindo da planilha)?
        const prefix = normalizeText(r.description || '').slice(0, 6);
        const already = state.transactions.some((t) => t.date.startsWith(key) && t.type === (r.type || 'gasto')
          && t.category === r.category && !t.recurring && normalizeText(t.description || '').startsWith(prefix));
        if (!already && !(r.skip || []).includes(key) && !this.findByDedupKey(dedupKey)) {
          const last = new Date(y, m, 0).getDate();
          out.push({
            type: r.type || 'gasto', date: `${key}-${String(Math.min(r.day || 1, last)).padStart(2, '0')}`,
            amount: r.amount, description: r.description, place: r.place || '', category: r.category,
            paidBy: r.paidBy, payment: r.payment || '', card: r.card || null, splitWith: r.splitWith || null,
            otherName: r.otherName || '', note: '', source: 'fixa', recurring: r.id, toConfirm: true, dedupKey,
          });
        }
        m++; if (m > 12) { m = 1; y++; }
      }
    });
    return out.length ? this.addMany(out) : 0;
  },
  /** Meta mensal de uma categoria (0 = sem meta). */
  budgetOf(category) { return Number((state.budgets || {})[category]) || 0; },
  setBudget(category, value) {
    const v = Math.round((Number(value) || 0) * 100) / 100;
    const b = { ...(state.budgets || {}) };
    if (v > 0) b[category] = v; else b[category] = 0;
    state.budgets = b;
    backend.saveSettings(this.settings());
    emit();
  },
  /** Cartões cadastrados (o primeiro é o padrão para gastos antigos no “Crédito”). */
  get cards() {
    let list = Array.isArray(state.cards) && state.cards.length ? state.cards : null;
    if (!list) {
      // versão antiga guardava um único cartão em state.card
      const c = state.card || {};
      list = [{ id: 'cartao', name: `Cartão ${c.owner || state.people[1] || state.people[0]}`, owner: c.owner, closingDay: c.closingDay }];
    }
    return list.map((c) => {
      const owner = state.people.includes(c.owner) ? c.owner : (state.people[1] || state.people[0]);
      return {
        id: c.id,
        name: (c.name || '').trim() || `Cartão ${owner}`,
        owner,
        closingDay: Math.min(28, Math.max(1, Number(c.closingDay) || 10)),
      };
    });
  },
  saveCards(list) {
    state.cards = list;
    backend.saveSettings(this.settings());
    emit();
  },
  addCard({ name, owner, closingDay }) {
    const id = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.saveCards([...this.cards, { id, name, owner, closingDay }]);
    return id;
  },
  updateCard(id, patch) {
    this.saveCards(this.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  },
  removeCard(id) {
    this.saveCards(this.cards.filter((c) => c.id !== id));
  },
  /** Cartão de um gasto: o marcado nele, ou o primeiro cartão se for “Crédito” sem cartão. */
  cardOf(t) {
    if (!t || t.type !== 'gasto') return null;
    const cards = this.cards;
    if (t.card) return cards.find((c) => c.id === t.card) || null;
    if (t.payment === 'Crédito') return cards[0] || null;
    return null;
  },
  get houseSize() { return Math.max(2, Number(state.houseSize) || 3); },
  setHouseSize(n) {
    state.houseSize = Math.max(2, Math.min(20, Math.round(Number(n)) || 3));
    backend.saveSettings(this.settings());
    emit();
  },
  /**
   * Correção única: contas do apê importadas da planilha estavam como “Dividido 50/50”,
   * mas são divididas com a casa toda. Roda uma vez por conta/aparelho.
   */
  /**
   * Correção única: os dados da planilha passam a valer só a partir de julho/2026.
   * Remove apenas lançamentos com origem “planilha” anteriores a essa data.
   */
  trimPlanilhaBefore(start = '2026-07-01') {
    if (state.migrations?.planilhaDesdeJulho || !state.transactions.length) return 0;
    const gone = state.transactions.filter((t) => t.source === 'planilha' && t.date < start);
    state.transactions = state.transactions.filter((t) => !gone.includes(t));
    gone.forEach((t) => backend.deleteTx(t.id));
    state.migrations = { ...(state.migrations || {}), planilhaDesdeJulho: true };
    backend.saveSettings(this.settings());
    if (gone.length) emit();
    return gone.length;
  },
  migrateHouseSplit(SPLIT, HOUSE) {
    if (state.migrations?.casaDividida || !state.transactions.length) return 0;
    const fix = state.transactions.filter((t) => t.source === 'planilha' && t.paidBy === SPLIT
      && this.groupOf(t.category) === 'Contas apê');
    fix.forEach((t) => { t.paidBy = HOUSE; backend.patchTx(t.id, { paidBy: HOUSE }); });
    state.migrations = { ...(state.migrations || {}), casaDividida: true };
    backend.saveSettings(this.settings());
    if (fix.length) emit();
    return fix.length;
  },

  categoriesFor(type) {
    return state.categories.filter((c) => (type === 'entrada') === (c.group === 'Entradas'));
  },
  groupOf(categoryName) {
    return state.categories.find((c) => c.name === categoryName)?.group || 'Outras compras';
  },

  /** Quantas vezes uma pessoa aparece (pagou, divide, é dona de cartão). */
  usageOf(name) {
    const tx = state.transactions.filter((t) => t.paidBy === name || (t.splitWith || []).includes(name)).length;
    const cards = this.cards.filter((c) => c.owner === name).length;
    return { tx, cards };
  },
  addPerson(name) {
    const n = String(name || '').trim();
    if (!n || state.people.some((p) => normalizeText(p) === normalizeText(n))) return false;
    state.people = [...state.people, n];
    backend.saveSettings(this.settings());
    emit();
    return true;
  },
  /** Renomeia em todo lugar: lançamentos, divisões, cartões e vínculo com logins. */
  renamePerson(oldName, newName) {
    const n = String(newName || '').trim();
    if (!n || n === oldName) return false;
    if (state.people.some((p) => p !== oldName && normalizeText(p) === normalizeText(n))) return false;
    state.people = state.people.map((p) => (p === oldName ? n : p));
    state.transactions.forEach((t) => {
      const patch = {};
      if (t.paidBy === oldName) patch.paidBy = n;
      if ((t.splitWith || []).includes(oldName)) patch.splitWith = t.splitWith.map((x) => (x === oldName ? n : x));
      if (Object.keys(patch).length) { Object.assign(t, patch); backend.patchTx(t.id, patch); }
    });
    state.cards = this.cards.map((c) => (c.owner === oldName ? { ...c, owner: n } : c));
    const personOf = { ...(state.personOf || {}) };
    Object.keys(personOf).forEach((uid) => { if (personOf[uid] === oldName) personOf[uid] = n; });
    state.personOf = personOf;
    backend.saveSettings({ ...this.settings(), personOf });
    emit();
    return true;
  },
  /** Só remove quem não tem lançamentos nem cartões (para nada ficar sem dono). */
  removePerson(name) {
    const u = this.usageOf(name);
    if (u.tx || u.cards || state.people.length <= 1) return false;
    state.people = state.people.filter((p) => p !== name);
    const personOf = { ...(state.personOf || {}) };
    Object.keys(personOf).forEach((uid) => { if (personOf[uid] === name) personOf[uid] = ''; });
    state.personOf = personOf;
    backend.saveSettings({ ...this.settings(), personOf });
    emit();
    return true;
  },
  addCategory(name, group) {
    if (!name || state.categories.some((c) => normalizeText(c.name) === normalizeText(name))) return false;
    state.categories.push({ name, group });
    backend.saveSettings(this.settings());
    return true;
  },
  setCategoryGroup(name, group) {
    const c = state.categories.find((x) => x.name === name);
    if (c) { c.group = group; backend.saveSettings(this.settings()); }
  },
  removeCategory(name) {
    state.categories = state.categories.filter((c) => c.name !== name);
    backend.saveSettings(this.settings());
  },

  findByDedupKey(key) {
    return key ? state.transactions.find((t) => t.dedupKey === key) : undefined;
  },

  /** Possível duplicata vinda de outra fonte: mesmo valor, até 3 dias de diferença. */
  findSimilar({ date, amount, type, source, excludeId }) {
    const d0 = new Date(`${date}T12:00:00`).getTime();
    return state.transactions.find((t) => t.id !== excludeId
      && t.type === type
      && t.source !== source
      && Math.abs(t.amount - amount) < 0.005
      && Math.abs(new Date(`${t.date}T12:00:00`).getTime() - d0) <= 3 * 86400000);
  },

  add(tx) {
    if (tx.dedupKey && this.findByDedupKey(tx.dedupKey)) return null;
    const full = stamp(tx);
    state.transactions.push(full);
    this.learn(full);
    backend.putTxs([full]);
    backend.saveSettings(this.settings());
    return full;
  },
  addMany(list) {
    const added = [];
    list.forEach((tx) => {
      if (tx.dedupKey && this.findByDedupKey(tx.dedupKey)) return;
      const full = stamp(tx);
      state.transactions.push(full);
      this.learn(full);
      added.push(full);
    });
    if (added.length) {
      backend.putTxs(added);
      backend.saveSettings(this.settings());
    }
    return added.length;
  },
  update(id, patch) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    const full = { ...patch, updatedAt: new Date().toISOString(), ...(currentUser ? { updatedByName: currentUser.name } : {}) };
    Object.assign(t, full);
    this.learn(t);
    backend.patchTx(id, full);
    backend.saveSettings(this.settings());
  },
  remove(id) {
    const t = state.transactions.find((x) => x.id === id);
    state.transactions = state.transactions.filter((x) => x.id !== id);
    backend.deleteTx(id);
    if (t?.recurring) {
      const r = this.recurring.find((x) => x.id === t.recurring);
      const month = t.date.slice(0, 7);
      if (r && !(r.skip || []).includes(month)) this.updateRecurring(r.id, { skip: [...(r.skip || []), month] });
    }
  },

  learn(t) {
    if (!t.category) return;
    if (t.description) state.memory[`d:${normalizeText(t.description)}`] = t.category;
    if (t.place) state.memory[`p:${normalizeText(t.place)}`] = t.category;
    if (t.nf?.cnpj) {
      state.memory[`c:${t.nf.cnpj}`] = t.category;
      if (t.place) state.merchants[t.nf.cnpj] = t.place;
    }
  },

  suggestCategory({ description, place, cnpj, type }) {
    const m = state.memory;
    const fromMemory = (cnpj && m[`c:${cnpj}`])
      || (place && m[`p:${normalizeText(place)}`])
      || (description && m[`d:${normalizeText(description)}`]);
    const valid = (name) => name && this.categoriesFor(type).some((c) => c.name === name);
    if (valid(fromMemory)) return fromMemory;
    const text = ` ${normalizeText(`${place || ''} ${description || ''}`)} `;
    for (const [re, cat] of KEYWORD_RULES) if (re.test(text) && valid(cat)) return cat;
    return type === 'entrada' ? 'Outras entradas' : 'Outros gastos';
  },
  merchantName(cnpj) { return state.merchants[cnpj] || ''; },

  exportJson() { return JSON.stringify(state, null, 2); },

  /** Junta um backup (objeto ou JSON) ao estado atual sem duplicar (por id e por dedupKey). */
  mergeBackup(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(data.transactions)) throw new Error('Arquivo de backup inválido.');
    const ids = new Set(state.transactions.map((t) => t.id));
    const keys = new Set(state.transactions.map((t) => t.dedupKey).filter(Boolean));
    const added = [];
    data.transactions.forEach((t) => {
      if (ids.has(t.id) || (t.dedupKey && keys.has(t.dedupKey))) return;
      const tx = t.id && !String(t.id).includes('/') ? t : { ...t, id: newId(t) };
      state.transactions.push(tx); added.push(tx);
      ids.add(tx.id); if (tx.dedupKey) keys.add(tx.dedupKey);
    });
    (data.categories || []).forEach((c) => {
      if (!state.categories.some((x) => x.name === c.name)) state.categories.push(c);
    });
    state.memory = { ...data.memory, ...state.memory };
    state.merchants = { ...data.merchants, ...state.merchants };
    if (added.length) backend.putTxs(added);
    backend.saveSettings(this.settings());
    return added.length;
  },
  /** Apaga todos os lançamentos do backend atual. */
  wipe() {
    const ids = state.transactions.map((t) => t.id);
    if (backend.kind === 'local') { state = emptyState(); saveLocal(); return; }
    state.transactions = [];
    ids.forEach((id) => backend.deleteTx(id));
  },
};
