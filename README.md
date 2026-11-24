# MiMimei

_Criado por Roberta Carvalho._

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
- **O que precisa de atenção**: quem deve a quem (gastos de cartão não acertados),
  fatura aberta de cada cartão com dias até fechar, gastos sem forma de pagamento e
  gastos em “Outros gastos” — cada item abre a tela certa já filtrada.
- Entradas, gastos e saldo **comparados ao período anterior** (se o período está em
  andamento, até o mesmo dia — ex.: “▲ 12% vs outubro (até dia 24)”).
- **Ritmo de gastos**: gasto acumulado dia a dia contra o período anterior, com
  previsão de fechamento (“novembro deve fechar em ~R$ X”).
- Entradas, gastos e saldo; balanço **por pessoa** (o que é “Dividido 50/50” conta
  metade para cada um).
- **Gastos por categoria** agrupados (Contas apê, Mercado, Outras compras) com
  subtotais, variação contra o período anterior e toque para abrir a Lista.
- **Metas por categoria**: limite mensal (🎯 no painel ou em Ajustes), barra de
  progresso e status — ok, atenção (90% ou acima do ritmo) e estourou.
- **Por pessoa** em cartões (saldo, entradas × gastos, variação) e botão **+** para
  lançar.

**Cartões (faturas)**
- Vários cartões, cada um com nome/banco, dono (Lari ou Robs) e dia de fechamento;
  cadastre em *Cartão → + Novo* e alterne no seletor do topo.
- Fatura por mês de cada cartão, pelo dia de fechamento (ex.: fecha dia 10 → a fatura
  de setembro tem as compras de 11/08 a 10/09), com navegação entre faturas.
- No formulário geral, “Crédito” pergunta em qual cartão foi.
- Cada gasto com descrição, tipo e **quem vai pagar: o dono, o casal ou Outros**
  (com o nome da pessoa). Dá para trocar direto na lista.
- Resumo: total da fatura, quanto é de cada um e **quanto a Lari tem a receber**,
  (ou o Robs, no cartão dele), com marcação de “acertado”.
- Entrada rápida ou importação da fatura (CSV/OFX) escolhendo quem paga em cada linha.
- No painel geral, gastos de “Outros” não contam como gastos de vocês, e o pagamento
  da fatura que aparece no extrato do banco vem desmarcado (para não contar duas vezes).

**Acertos**
- Quando alguém devolve o que deve, registre um **acerto** (pode ser parcial): ele
  abate as dívidas do cartão da mais antiga para a mais nova e não conta como renda.
- Ao importar o extrato do banco, Pix/transferências de quem deve são reconhecidos e
  sugeridos como acerto. Também dá para registrar à mão na aba Cartão.

**Contas fixas e parcelas**
- “🔁 Repetir todo mês” transforma o lançamento em conta fixa: os próximos meses são
  lançados sozinhos como “a conferir”, com o último valor como estimativa.
  Ajustes lista as contas fixas e sugere as contas do apê do mês anterior.
- Compra parcelada no cartão (ex.: 2/5) cria as próximas parcelas como “previstas”;
  ao importar a fatura real, a parcela já prevista vem desmarcada.

**Lançamentos e Ajustes**
- Lista do período com busca (inclusive pelos itens das notas) e filtros; toque para
  editar ou excluir.
- **Pessoas da conta**: adicione, renomeie (muda em todos os lançamentos) ou remova
  (só quem não tem lançamentos). Membros que entram por convite podem virar pessoa
  com um toque em *Ajustes → Membros*.
- “Pago por” lista todas as pessoas; com mais de duas, “Dividido entre…” deixa
  escolher quem divide.
- Categorias editáveis (cada categoria pertence a um grupo).
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

## Login e contas compartilhadas (Firebase)

Com o login ativado:
- **cada pessoa tem o próprio login** (e-mail e senha, ou conta Google);
- os dados ficam numa **conta compartilhada** (ex.: “Casa”): todos os membros veem e
  lançam nos mesmos dados, ao vivo, e cada lançamento mostra **quem lançou**;
- dá para **criar contas novas** (começam vazias) e alternar entre elas em *Ajustes*;
- para alguém entrar numa conta: *Ajustes → Convidar alguém* gera um código/link
  que vale 7 dias;
- funciona offline e sincroniza quando a internet volta;
- dados salvos no aparelho antes do login podem ser enviados para a conta (sem duplicar).

Sem configuração, o app continua funcionando só no aparelho, como antes.

### Como ativar (uma vez, ~10 minutos, plano gratuito)

> Dica: no console em português os menus podem estar recolhidos ou com outros
> nomes. Os links diretos abaixo funcionam em qualquer idioma — se pedir, escolha
> o projeto `mimimei`. Também dá para digitar o nome do produto na busca do topo.
>
> - Login: https://console.firebase.google.com/project/_/authentication/providers
> - Domínios autorizados: https://console.firebase.google.com/project/_/authentication/settings
> - Banco de dados: https://console.firebase.google.com/project/_/firestore
> - Regras: https://console.firebase.google.com/project/_/firestore/rules
> - Configurações do projeto: https://console.firebase.google.com/project/_/settings/general

1. Acesse https://console.firebase.google.com → **Adicionar projeto** → nome
   `mimimei` → pode desativar o Google Analytics → **Criar projeto**.
2. **Authentication** → *Vamos começar* → aba **Método de login**:
   ative **E-mail/senha** e **Google** (escolha um e-mail de suporte).
3. Ainda em **Authentication** → **Configurações** → **Domínios autorizados** →
   *Adicionar domínio* → `robertabiotropica.github.io`.
4. **Firestore Database** → *Criar banco de dados* → local **southamerica-east1
   (São Paulo)** → **modo de produção**.
5. Firestore → aba **Regras** → apague o que estiver lá, cole todo o conteúdo de
   [`firebase/firestore.rules`](firebase/firestore.rules) → **Publicar**.
6. ⚙️ **Configurações do projeto** → *Seus apps* → ícone **Web `</>`** → apelido
   `MiMimei` → **Registrar app** → copie o bloco `firebaseConfig = { ... }`.
7. Cole esses valores em [`js/firebase-config.js`](js/firebase-config.js) no lugar
   de `null` (ou mande para o Claude colocar). Esses valores não são secretos; quem
   protege os dados são as regras do passo 5.

### Testes

```bash
npm install            # uma vez: Playwright, Firebase e firebase-tools
npm test               # leitores de nota fiscal, OFX e CSV
npm run test:e2e       # o app no navegador, com dados fictícios e data fixa (24/11/2026)
npm run test:regras    # regras de segurança no emulador do Firebase (precisa de Java)
npm run test:tudo      # os três
```

Os testes usam só dados fictícios (`tests/fixtures/`). Para testar o login à mão,
rode os emuladores (`npx firebase emulators:start --only auth,firestore`) e abra o
app em `http://localhost:8000/?emulador`.

## Limitações a saber

- **Sem login, os dados ficam em cada aparelho.** Ative o login (acima) para os dois
  verem e lançarem nos mesmos dados.
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
js/cloud.js         login, contas, convites e sincronização (Firebase)
js/account.js       telas de login e de contas
js/firebase-config.js  configuração do projeto Firebase
firebase/           regras de segurança do banco de dados
js/qr.js            leitura de QR Code (ZXing em WebAssembly, incluído em vendor/zxing)
sw.js               funciona offline depois de aberto uma vez
tests/              testes (leitores, app no navegador e regras de segurança)
```
