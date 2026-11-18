# MiMimei

App web simples para o planejamento financeiro de Robs e Lari: substitui a planilha
“Planejamento Financeiro (Robs e Lari)” por uma página de entrada de dados e um painel.

Funciona no navegador (celular ou computador), sem servidor e sem login. Os dados ficam
salvos no próprio navegador, e dá para instalar na tela inicial do celular.

## O que faz

**Lançar**
- Formulário rápido de gasto ou entrada: data, valor, descrição, local, categoria,
  quem pagou (Robs, Lari ou Dividido 50/50) e forma de pagamento.
- **Leitura de nota fiscal** (NFC-e / NF-e):
  - 📷 escaneia o QR Code pela câmera, ou lê de uma foto;
  - cola o link do QR Code ou digita a chave de acesso de 44 dígitos;
  - importa o XML da nota (traz estabelecimento, data, valor, forma de pagamento e
    todos os itens). Dá para mandar vários XML de uma vez.
- **Sem duplicar notas:** cada nota é identificada pela chave de acesso. Se ela já foi
  lançada, o app avisa e não lança de novo.
- Aprende as categorias: na próxima nota do mesmo CNPJ ou com a mesma descrição, já
  sugere a categoria que vocês usaram.

**Importar extrato**
- Arquivos **OFX** (quase todo banco exporta) e **CSV** (detecta as colunas de data,
  descrição e valor; dá para ajustar). Lê faturas de cartão também.
- **Sem duplicar extratos:** reimportar o mesmo arquivo, ou um extrato que se sobrepõe
  a um anterior, ignora o que já entrou.
- **Avisa duplicatas entre fontes:** se uma linha do extrato tem o mesmo valor (até 3
  dias de diferença) de uma nota fiscal ou lançamento manual, ela vem desmarcada e
  marcada como “parecido com…”.

**Painel**
- Período por **semana, mês, ano** ou intervalo personalizado, com setas para navegar.
- Entradas, gastos e saldo; balanço **por pessoa** (o que é “Dividido 50/50” conta
  metade para cada um).
- Gráfico de entradas × gastos ao longo do período (por dia, semana ou mês).
- Totais por grupo, como na planilha: **Contas apê, Mercado, Outras compras**, e
  ranking de gastos por categoria.

**Lançamentos e Ajustes**
- Lista do período com busca (inclusive pelos itens das notas) e filtros; toque para
  editar ou excluir.
- Nomes das pessoas e categorias editáveis (cada categoria pertence a um grupo).
- Backup em JSON e restauração (junta sem duplicar), e exportação em CSV para abrir
  no Google Sheets/Excel.

## Como usar

Precisa ser servido por HTTP (abrir o arquivo direto não funciona por causa dos
módulos JavaScript). Para testar no computador:

```bash
python3 -m http.server 8000
```

e abra http://localhost:8000.

### Publicar para usar no celular (GitHub Pages, grátis)

1. No GitHub, vá em **Settings → Pages**.
2. Em *Build and deployment*, escolha **Deploy from a branch**, a branch `main`
   (depois de juntar esta branch) e a pasta `/ (root)`.
3. Em alguns minutos o app fica em `https://<usuario>.github.io/plan_financeiro/`.
4. No celular, abra o link e use **“Adicionar à tela inicial”**.

A câmera só funciona em HTTPS (o GitHub Pages já é HTTPS).

> ⚠️ Repositório público + GitHub Pages expõe só o *código* do app — os dados de
> vocês ficam no navegador de cada aparelho e não vão para o GitHub.

## Limitações a saber

- **Os dados ficam em cada aparelho.** Para os dois verem a mesma coisa, use
  *Ajustes → Baixar backup* em um aparelho e *Restaurar backup* no outro (não duplica).
  Sincronização automática entre os celulares seria o próximo passo.
- **QR Code da NFC-e normalmente não traz o valor nem os itens** (só a chave). O app
  preenche CNPJ, mês e número, e você digita o valor; o link “ver nota na SEFAZ”
  mostra a nota completa. Para itens automáticos, use o XML (muitos apps de nota
  fiscal e e-mails de compra online enviam o XML).

## Estrutura

```
index.html          telas
css/style.css       visual (claro/escuro)
js/parsers.js       leitura de nota fiscal, OFX e CSV (sem dependências)
js/store.js         armazenamento, deduplicação e sugestão de categorias
js/app.js           interface
js/qr.js            leitura de QR Code (ZXing em WebAssembly, incluído em vendor/zxing)
sw.js               funciona offline depois de aberto uma vez
tests/              testes dos leitores: node tests/parsers.test.mjs
```
