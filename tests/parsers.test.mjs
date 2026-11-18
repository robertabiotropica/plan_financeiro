import assert from 'node:assert/strict';
import { parseMoney, parseDate, parseNfQr, isValidChave, parseOfx, parseCsvRows, guessCsvColumns, csvToTransactions } from '../js/parsers.js';

// chave fictícia com DV calculado
function withDv(c43) {
  let w = 2, s = 0;
  for (let i = 42; i >= 0; i--) { s += +c43[i] * w; w = w === 9 ? 2 : w + 1; }
  const r = s % 11; return c43 + (r < 2 ? 0 : 11 - r);
}
const chave = withDv('3526081234567800019065001000123456' + '112345678');
assert.equal(chave.length, 44);
assert.ok(isValidChave(chave));
assert.ok(!isValidChave(chave.slice(0, 43) + ((+chave[43] + 1) % 10)));

assert.equal(parseMoney('1.234,56'), 1234.56);
assert.equal(parseMoney('-1234.56'), -1234.56);
assert.equal(parseMoney('R$ 12,30'), 12.3);
assert.equal(parseMoney('12,30 D'), -12.3);
assert.equal(parseMoney('(5,00)'), -5);
assert.equal(parseDate('01/08/2026'), '2026-08-01');
assert.equal(parseDate('20260801120000[-3:BRT]'), '2026-08-01');

let q = parseNfQr(`https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${chave}|2|1|1|ABCDEF`);
assert.equal(q.chave, chave); assert.equal(q.uf, 'SP'); assert.equal(q.ano, 2026); assert.equal(q.mes, 8); assert.equal(q.valor, null);
q = parseNfQr(`https://x/?p=${chave}|2|1|15|87.40|abc|1|HASH`);
assert.equal(q.valor, 87.4); assert.equal(q.data, '2026-08-15');
q = parseNfQr(chave.replace(/(\d{4})/g, '$1 '));
assert.equal(q.chave, chave);

const ofx = `OFXHEADER:100
<OFX><BANKACCTFROM><BANKID>341<ACCTID>12345</BANKACCTFROM>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260805120000[-3:BRT]<TRNAMT>-45.90<FITID>A1<MEMO>PADARIA &amp; CIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260806<TRNAMT>3000.00<FITID>A2<NAME>SALARIO</STMTTRN>
</OFX>`;
const o = parseOfx(ofx);
assert.equal(o.length, 2); assert.equal(o[0].amount, -45.9); assert.equal(o[0].description, 'PADARIA & CIA');
assert.equal(o[0].dedupKey, 'ofx:12345:A1'); assert.equal(o[1].date, '2026-08-06');

const csv = `Data;Lançamento;Valor;Saldo
01/08/2026;PIX ENVIADO FULANO;-50,00;100,00
01/08/2026;PIX ENVIADO FULANO;-50,00;50,00
02/08/2026;SALDO DO DIA;0;50,00
03/08/2026;"MERCADO; LTDA";-1.234,56;0`;
const rows = parseCsvRows(csv);
const map = guessCsvColumns(rows);
assert.equal(map.headerRow, 0); assert.equal(map.date, 0); assert.equal(map.value, 2); assert.equal(map.desc, 1);
const t = csvToTransactions(rows, map);
assert.equal(t.length, 3);
assert.notEqual(t[0].dedupKey, t[1].dedupKey);
assert.equal(t[2].description, 'MERCADO; LTDA'); assert.equal(t[2].amount, -1234.56);
// reimportar gera as mesmas chaves
assert.deepEqual(csvToTransactions(rows, map).map(x => x.dedupKey), t.map(x => x.dedupKey));

const nubank = `date,title,amount
2026-08-10,Uber *Trip,23.50
2026-08-11,Pagamento recebido,-500.00`;
const nr = parseCsvRows(nubank); const nm = guessCsvColumns(nr);
const nt = csvToTransactions(nr, nm, { invert: true });
assert.equal(nt[0].amount, -23.5); assert.equal(nt[0].description, 'Uber *Trip');
console.log('ok - todos os testes passaram');
