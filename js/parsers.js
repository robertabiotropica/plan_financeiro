// Parsers puros (sem DOM): nota fiscal (QR/link/XML), extrato OFX e CSV.
// Podem ser testados no Node: node tests/parsers.test.mjs

const UF_CODES = {
  11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO',
  21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA',
  31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS',
  50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF',
};

// ---------- números e datas ----------

/** Converte "1.234,56", "-1234.56", "R$ 12,30", "12,30 D" em número. */
export function parseMoney(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  let s = String(raw).trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\bD$/i.test(s)) { negative = true; s = s.replace(/\s*D$/i, ''); }
  s = s.replace(/\s*C$/i, '');
  s = s.replace(/R\$\s?/gi, '').replace(/\s/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  s = s.replace(/^\+/, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma && lastComma !== -1) {
    s = s.replace(/,/g, '');
  } else if (lastComma === -1 && (s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}

const pad = (n) => String(n).padStart(2, '0');

/** Converte dd/mm/aaaa, dd/mm/aa, aaaa-mm-dd, aaaammdd em "aaaa-mm-dd". */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = Number(m[1]); const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Hash curto e estável (FNV-1a 32 bits) para chaves de deduplicação. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------- Nota fiscal ----------

/** Valida o dígito verificador (módulo 11) da chave de acesso de 44 dígitos. */
export function isValidChave(chave) {
  if (!/^\d{44}$/.test(chave)) return false;
  const digits = chave.slice(0, 43);
  let weight = 2; let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  const dv = rest < 2 ? 0 : 11 - rest;
  return dv === Number(chave[43]);
}

/** Decompõe a chave de acesso. */
export function parseChave(chave) {
  const c = String(chave).replace(/\D/g, '');
  if (c.length !== 44) return null;
  const cnpj = c.slice(6, 20);
  return {
    chave: c,
    uf: UF_CODES[Number(c.slice(0, 2))] || c.slice(0, 2),
    ano: 2000 + Number(c.slice(2, 4)),
    mes: Number(c.slice(4, 6)),
    cnpj,
    cnpjFormatado: cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
    modelo: c.slice(20, 22) === '65' ? 'NFC-e' : c.slice(20, 22) === '55' ? 'NF-e' : `mod ${c.slice(20, 22)}`,
    serie: Number(c.slice(22, 25)),
    numero: Number(c.slice(25, 34)),
    valida: isValidChave(c),
  };
}

/**
 * Lê o conteúdo de um QR Code de NFC-e (ou um link colado, ou a chave digitada).
 * Formatos suportados:
 *  - v2 online:  ...?p=CHAVE|2|1|1|HASH
 *  - v2 offline: ...?p=CHAVE|2|1|DIA|VALOR|DIGVAL|IDTOKEN|HASH
 *  - v1:         ...?chNFe=CHAVE&...&vNF=12.34&dhEmi=<hex>
 *  - só a chave (com ou sem espaços)
 */
export function parseNfQr(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let chave = null; let valor = null; let dia = null; let url = null; let data = null;

  if (/^https?:\/\//i.test(raw)) url = raw;

  const pMatch = raw.match(/[?&]p=([^&#\s]+)/i);
  if (pMatch) {
    const parts = decodeURIComponent(pMatch[1]).split('|');
    chave = parts[0].replace(/\D/g, '');
    if (parts.length >= 8) {
      // offline (contingência): dia e valor vêm no QR
      dia = Number(parts[3]) || null;
      const v = Number(parts[4]);
      if (Number.isFinite(v)) valor = v;
    }
  }
  if (!chave) {
    const ch = raw.match(/chNFe=(\d{44})/i);
    if (ch) chave = ch[1];
    const v = raw.match(/[?&]vNF=([\d.]+)/i);
    if (v) valor = Number(v[1]);
    const dh = raw.match(/[?&]dhEmi=([0-9a-f]+)/i);
    if (dh) {
      try {
        const decoded = dh[1].match(/../g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
        data = parseDate(decoded);
      } catch { /* ignora */ }
    }
  }
  if (!chave) {
    const only = raw.replace(/[\s.-]/g, '').match(/\d{44}/);
    if (only) chave = only[0];
  }
  if (!chave || chave.length !== 44) return null;

  const info = parseChave(chave);
  if (!data && dia) data = `${info.ano}-${pad(info.mes)}-${pad(dia)}`;
  return { ...info, valor, data, url };
}

function xmlText(el, tag) {
  if (!el) return '';
  const found = el.getElementsByTagName(tag)[0];
  return found ? found.textContent.trim() : '';
}

/**
 * Lê o XML de uma NF-e / NFC-e (procNFe ou NFe). Recebe um Document já parseado
 * (DOMParser no navegador) para não depender de biblioteca.
 */
export function parseNfXml(doc) {
  const inf = doc.getElementsByTagName('infNFe')[0];
  if (!inf) throw new Error('XML não parece ser uma NF-e/NFC-e (sem <infNFe>).');
  const id = inf.getAttribute('Id') || '';
  let chave = id.replace(/\D/g, '');
  if (chave.length !== 44) chave = xmlText(doc, 'chNFe');
  const ide = inf.getElementsByTagName('ide')[0];
  const emit = inf.getElementsByTagName('emit')[0];
  const total = inf.getElementsByTagName('ICMSTot')[0];
  const dhEmi = xmlText(ide, 'dhEmi') || xmlText(ide, 'dEmi');
  const itens = Array.from(inf.getElementsByTagName('det')).map((det) => {
    const prod = det.getElementsByTagName('prod')[0];
    return {
      descricao: xmlText(prod, 'xProd'),
      quantidade: Number(xmlText(prod, 'qCom')) || 1,
      unidade: xmlText(prod, 'uCom'),
      valorUnitario: Number(xmlText(prod, 'vUnCom')) || 0,
      valor: Number(xmlText(prod, 'vProd')) || 0,
    };
  });
  const pagamentos = Array.from(inf.getElementsByTagName('detPag')).map((p) => xmlText(p, 'tPag'));
  return {
    ...(parseChave(chave) || { chave }),
    data: parseDate(dhEmi),
    emitente: xmlText(emit, 'xFant') || xmlText(emit, 'xNome'),
    valor: Number(xmlText(total, 'vNF')) || itens.reduce((s, i) => s + i.valor, 0),
    desconto: Number(xmlText(total, 'vDesc')) || 0,
    formaPagamento: tPagToForma(pagamentos[0]),
    itens,
  };
}

function tPagToForma(code) {
  switch (code) {
    case '01': return 'Dinheiro';
    case '03': return 'Crédito';
    case '04': return 'Débito';
    case '17': return 'Pix';
    case '10': case '11': case '12': case '13': return 'Vale';
    default: return '';
  }
}

// ---------- Extrato OFX ----------

function ofxTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

/** Lê um arquivo OFX (SGML ou XML) e devolve lançamentos. */
export function parseOfx(text) {
  const account = ofxTag(text, 'ACCTID') || ofxTag(text, 'BANKID') || 'conta';
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  return blocks.map((b) => {
    const amount = parseMoney(ofxTag(b, 'TRNAMT'));
    const fitid = ofxTag(b, 'FITID');
    const date = parseDate(ofxTag(b, 'DTPOSTED'));
    const memo = ofxTag(b, 'MEMO');
    const name = ofxTag(b, 'NAME');
    const description = [name, memo].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' - ') || ofxTag(b, 'TRNTYPE');
    return {
      date,
      amount,
      description: decodeEntities(description),
      dedupKey: fitid
        ? `ofx:${account}:${fitid}`
        : `ofx:${account}:${hashString(`${date}|${amount}|${description}`)}`,
    };
  }).filter((t) => t.date && Number.isFinite(t.amount) && t.amount !== 0);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------- Extrato CSV ----------

/** Divide CSV respeitando aspas. Detecta ; , ou tab. */
export function parseCsvRows(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Procura a linha de cabeçalho e sugere quais colunas são data, descrição e valor. */
export function guessCsvColumns(rows) {
  const isDate = (v) => !!parseDate(v);
  const isMoney = (v) => /\d/.test(v) && Number.isFinite(parseMoney(v));
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = rows[h].map(normalizeText);
    const find = (re) => header.findIndex((c) => re.test(c));
    const date = find(/^data|^date|^dt\b/);
    const value = find(/^valor|^value|^amount|^quantia|^montante|^r\$|^entrada.*saida/);
    const desc = find(/descri|historico|lancamento|^title|^titulo|^memo|estabelecimento|^detalhe/);
    if (date !== -1 && value !== -1) {
      return { headerRow: h, date, value, desc: desc === -1 ? null : desc, credit: null, debit: null };
    }
    const credit = find(/credito|entrada/);
    const debit = find(/debito|saida/);
    if (date !== -1 && credit !== -1 && debit !== -1) {
      return { headerRow: h, date, value: null, desc: desc === -1 ? null : desc, credit, debit };
    }
  }
  // sem cabeçalho: adivinha pelo conteúdo da primeira linha com data
  const sample = rows.find((r) => r.some(isDate)) || rows[0] || [];
  const date = sample.findIndex(isDate);
  let value = -1;
  for (let i = sample.length - 1; i >= 0; i--) if (i !== date && isMoney(sample[i])) { value = i; break; }
  const desc = sample.findIndex((c, i) => i !== date && i !== value && /[a-z]/i.test(c));
  return { headerRow: -1, date, value, desc: desc === -1 ? null : desc, credit: null, debit: null };
}

/**
 * Converte linhas de CSV em lançamentos usando o mapeamento de colunas.
 * invert=true para faturas de cartão, onde compras vêm positivas.
 * Lançamentos idênticos no mesmo arquivo recebem um contador para não colidirem.
 */
export function csvToTransactions(rows, map, { invert = false, account = 'csv' } = {}) {
  const out = []; const seen = {};
  rows.slice(map.headerRow + 1).forEach((r) => {
    const date = parseDate(r[map.date]);
    let amount;
    if (map.value != null && map.value !== -1) amount = parseMoney(r[map.value]);
    else {
      const c = parseMoney(r[map.credit]); const d = parseMoney(r[map.debit]);
      amount = (Number.isFinite(c) ? Math.abs(c) : 0) - (Number.isFinite(d) ? Math.abs(d) : 0);
    }
    if (!date || !Number.isFinite(amount) || amount === 0) return;
    if (invert) amount = -amount;
    const description = map.desc != null ? (r[map.desc] || '') : '';
    if (/saldo/i.test(description) && !/pix|transf/i.test(description)) return; // linhas de saldo
    const base = `${date}|${amount.toFixed(2)}|${normalizeText(description)}`;
    seen[base] = (seen[base] || 0) + 1;
    out.push({ date, amount, description, dedupKey: `csv:${account}:${hashString(`${base}|${seen[base]}`)}` });
  });
  return out;
}
