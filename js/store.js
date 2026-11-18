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
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...emptyState(), ...JSON.parse(raw) };
  } catch (e) { console.warn('Falha ao ler dados salvos', e); }
  return emptyState();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('Não foi possível salvar os dados neste navegador. Faça um backup.');
    throw e;
  }
}

export const store = {
  get state() { return state; },
  get people() { return state.people; },
  get transactions() { return state.transactions; },

  categoriesFor(type) {
    return state.categories.filter((c) => (type === 'entrada') === (c.group === 'Entradas'));
  },
  groupOf(categoryName) {
    return state.categories.find((c) => c.name === categoryName)?.group || 'Outras compras';
  },

  setPeople(a, b) {
    const old = [...state.people];
    state.people = [a || 'Pessoa 1', b || 'Pessoa 2'];
    state.transactions.forEach((t) => {
      const i = old.indexOf(t.paidBy);
      if (i !== -1) t.paidBy = state.people[i];
    });
    save();
  },
  addCategory(name, group) {
    if (!name || state.categories.some((c) => normalizeText(c.name) === normalizeText(name))) return false;
    state.categories.push({ name, group });
    save();
    return true;
  },
  setCategoryGroup(name, group) {
    const c = state.categories.find((x) => x.name === name);
    if (c) { c.group = group; save(); }
  },
  removeCategory(name) {
    state.categories = state.categories.filter((c) => c.name !== name);
    save();
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
    const full = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      ...tx,
    };
    state.transactions.push(full);
    this.learn(full);
    save();
    return full;
  },
  addMany(list) {
    let added = 0;
    list.forEach((tx) => {
      if (tx.dedupKey && this.findByDedupKey(tx.dedupKey)) return;
      state.transactions.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: new Date().toISOString(),
        ...tx,
      });
      this.learn(tx);
      added++;
    });
    save();
    return added;
  },
  update(id, patch) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    this.learn(t);
    save();
  },
  remove(id) {
    state.transactions = state.transactions.filter((t) => t.id !== id);
    save();
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

  /** Junta um backup ao estado atual sem duplicar (por id e por dedupKey). */
  mergeBackup(json) {
    const data = JSON.parse(json);
    if (!Array.isArray(data.transactions)) throw new Error('Arquivo de backup inválido.');
    const ids = new Set(state.transactions.map((t) => t.id));
    const keys = new Set(state.transactions.map((t) => t.dedupKey).filter(Boolean));
    let added = 0;
    data.transactions.forEach((t) => {
      if (ids.has(t.id) || (t.dedupKey && keys.has(t.dedupKey))) return;
      state.transactions.push(t); ids.add(t.id); if (t.dedupKey) keys.add(t.dedupKey);
      added++;
    });
    (data.categories || []).forEach((c) => {
      if (!state.categories.some((x) => x.name === c.name)) state.categories.push(c);
    });
    state.memory = { ...data.memory, ...state.memory };
    state.merchants = { ...data.merchants, ...state.merchants };
    save();
    return added;
  },
  wipe() { state = emptyState(); save(); },
};
