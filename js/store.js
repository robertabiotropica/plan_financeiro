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
      houseSize: state.houseSize || 3, migrations: state.migrations || {}, cards: this.cards,
    };
  },
  defaultSettings() {
    const e = emptyState();
    return { people: e.people, categories: e.categories, memory: {}, merchants: {}, houseSize: 3, migrations: {}, cards: e.cards };
  },
  /** Cartões cadastrados (o primeiro é o padrão para gastos antigos no “Crédito”). */
  get cards() {
    let list = Array.isArray(state.cards) && state.cards.length ? state.cards : null;
    if (!list) {
      // versão antiga guardava um único cartão em state.card
      const c = state.card || {};
      list = [{ id: 'cartao', name: `Cartão ${c.owner || state.people[1]}`, owner: c.owner, closingDay: c.closingDay }];
    }
    return list.map((c) => {
      const owner = state.people.includes(c.owner) ? c.owner : state.people[1];
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

  setPeople(a, b) {
    const old = [...state.people];
    state.people = [a || 'Pessoa 1', b || 'Pessoa 2'];
    const changed = [];
    state.transactions.forEach((t) => {
      const i = old.indexOf(t.paidBy);
      if (i !== -1 && t.paidBy !== state.people[i]) { t.paidBy = state.people[i]; changed.push(t); }
    });
    backend.saveSettings(this.settings());
    changed.forEach((t) => backend.patchTx(t.id, { paidBy: t.paidBy }));
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
    state.transactions = state.transactions.filter((t) => t.id !== id);
    backend.deleteTx(id);
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
