// Interface de login, contas compartilhadas e convites.
import { firebaseConfig } from './firebase-config.js';
import {
  cloud, initCloud, watchAuth, signIn, signUp, signInGoogle, resetPassword, logout, friendlyError,
  openDefault, openHousehold, createHousehold, listHouseholds, createInvite, joinWithCode,
  renameHousehold, setMyPerson, setMyName, setPersonOf,
} from './cloud.js';
import { store } from './store.js';

const $ = (s) => document.querySelector(s);
const MODE_KEY = 'mimimei-modo';
const INVITE_KEY = 'mimimei-convite';
let ui = null;
let loginMode = 'entrar';

function setStatus(el, msg, kind = '') { el.className = `status ${kind}`; el.innerHTML = msg; }
function busy(btn, on) { btn.disabled = on; btn.style.opacity = on ? 0.6 : ''; }

/** Lê ?convite=CÓDIGO do link e guarda para depois do login. */
function captureInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('convite');
  if (code) {
    sessionStorage.setItem(INVITE_KEY, code);
    params.delete('convite');
    const q = params.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
  }
}

function configFromEnvironment() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (local && new URLSearchParams(location.search).has('emulador')) {
    return { config: { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-mimimei', appId: 'demo' }, emulator: true };
  }
  return { config: firebaseConfig, emulator: false };
}

export function initAccount(deps) {
  ui = deps;
  captureInviteFromUrl();
  const { config, emulator } = configFromEnvironment();
  if (!initCloud(config, { emulator })) { renderCard(); return; }

  cloud.onError((msg, what) => ui.toast(`⚠️ ${what === 'salvar' ? 'Não salvou: ' : ''}${msg}`));
  cloud.onStatus(updateChip);
  wireLogin();
  $('#account-chip').addEventListener('click', () => ui.showTab('ajustes'));

  watchAuth(async (user) => {
    if (!user) {
      showOverlay(localStorage.getItem(MODE_KEY) === 'local' ? null : 'login');
      updateChip(); renderCard();
      return;
    }
    localStorage.removeItem(MODE_KEY);
    try {
      const pending = sessionStorage.getItem(INVITE_KEY);
      if (pending) {
        sessionStorage.removeItem(INVITE_KEY);
        try {
          const name = await joinWithCode(pending);
          ui.toast(`Você entrou na conta “${name}”.`);
        } catch (e) { ui.toast(`Convite: ${friendlyError(e)}`); }
      }
      if (!cloud.household) {
        if (!(cloud.profile?.households || []).length) { showOverlay('onboard'); updateChip(); return; }
        await openDefault();
      }
      showOverlay(null);
      afterOpen();
    } catch (e) {
      ui.toast(friendlyError(e));
      showOverlay('onboard');
    }
  });
}

function afterOpen() {
  updateChip();
  renderCard();
  offerMigration();
  ui.onAccountChange?.();
}

function showOverlay(which) {
  $('#login').classList.toggle('hidden', !which);
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#onboard').classList.toggle('hidden', which !== 'onboard');
  document.body.style.overflow = which ? 'hidden' : '';
}

function wireLogin() {
  const form = $('#login-form');
  const st = $('#login-status');
  $('#login-toggle').addEventListener('click', () => {
    loginMode = loginMode === 'entrar' ? 'criar' : 'entrar';
    const criar = loginMode === 'criar';
    $('#login-title').textContent = criar ? 'Criar login' : 'Entrar';
    $('#login-submit').textContent = criar ? 'Criar login' : 'Entrar';
    $('#login-toggle').textContent = criar ? 'Já tenho login — entrar' : 'Ainda não tenho login — criar';
    $('#login-name-wrap').classList.toggle('hidden', !criar);
    form.password.autocomplete = criar ? 'new-password' : 'current-password';
    setStatus(st, '');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy($('#login-submit'), true);
    setStatus(st, loginMode === 'criar' ? 'Criando login…' : 'Entrando…');
    try {
      if (loginMode === 'criar') await signUp(form.name.value, form.email.value, form.password.value);
      else await signIn(form.email.value, form.password.value);
      setStatus(st, '');
      form.password.value = '';
    } catch (err) { setStatus(st, friendlyError(err), 'err'); }
    busy($('#login-submit'), false);
  });
  $('#login-google').addEventListener('click', async () => {
    try { await signInGoogle(); } catch (err) { setStatus(st, friendlyError(err), 'err'); }
  });
  $('#login-reset').addEventListener('click', async () => {
    if (!form.email.value) { setStatus(st, 'Digite seu e-mail acima e toque de novo em “Esqueci a senha”.', 'warn'); return; }
    try { await resetPassword(form.email.value); setStatus(st, 'Enviamos um e-mail para criar uma nova senha.', 'ok'); } catch (err) { setStatus(st, friendlyError(err), 'err'); }
  });
  $('#login-local').addEventListener('click', () => {
    localStorage.setItem(MODE_KEY, 'local');
    showOverlay(null);
    ui.toast('Usando sem login: os dados ficam só neste aparelho.');
  });

  const ost = $('#onboard-status');
  $('#onboard-join').addEventListener('click', async () => {
    busy($('#onboard-join'), true);
    try {
      const name = await joinWithCode($('#onboard-code').value);
      ui.toast(`Você entrou na conta “${name}”.`);
      showOverlay(null); afterOpen();
    } catch (err) { setStatus(ost, friendlyError(err), 'err'); }
    busy($('#onboard-join'), false);
  });
  $('#onboard-create').addEventListener('click', async () => {
    busy($('#onboard-create'), true);
    try {
      const id = await createHousehold($('#onboard-name').value.trim() || 'Casa');
      await openHousehold(id);
      showOverlay(null); afterOpen();
    } catch (err) { setStatus(ost, friendlyError(err), 'err'); }
    busy($('#onboard-create'), false);
  });
  $('#onboard-logout').addEventListener('click', () => logout());
}

const STATUS_LABEL = { synced: '☁️ salvo', saving: '⏳ salvando', offline: '📴 offline', loading: '⏳' };
function updateChip() {
  const chip = $('#account-chip');
  if (!cloud.enabled) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  if (!cloud.user) { chip.textContent = 'Sem login'; return; }
  const h = cloud.household;
  chip.textContent = h ? `${h.name} · ${STATUS_LABEL[cloud.status] || ''}` : 'Escolher conta';
}

function offerMigration() {
  const local = store.localData();
  const n = local.transactions.length;
  const flag = `mimimei-migrado-${cloud.user.uid}`;
  if (!n || localStorage.getItem(flag)) return;
  localStorage.setItem(flag, 'perguntado');
  if (confirm(`Encontrei ${n} lançamento(s) salvos só neste aparelho (de antes do login). Enviar para a conta “${cloud.household.name}”? Não duplica o que já estiver lá.`)) {
    migrate();
  }
}
function migrate() {
  const added = store.mergeBackup(store.localData());
  localStorage.setItem(`mimimei-migrado-${cloud.user.uid}`, 'feito');
  ui.toast(`${added} lançamento(s) enviados para “${cloud.household.name}”.`);
  renderCard();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderCard() {
  const card = $('#account-card');
  if (!card) return;
  if (!cloud.enabled) {
    card.innerHTML = `<h2>Login e contas</h2><p class="hint">O login ainda não foi ativado neste app. Por enquanto, os dados ficam só neste aparelho (use backup para passar de um celular para o outro).</p>`;
    return;
  }
  if (!cloud.user) {
    card.innerHTML = `<h2>Login e contas</h2><p class="hint">Você está usando sem login: os dados ficam só neste aparelho.</p>
      <button class="btn primary" id="acct-login">Entrar ou criar login</button>`;
    $('#acct-login').addEventListener('click', () => showOverlay('login'));
    return;
  }
  const h = cloud.household;
  const p = cloud.profile || {};
  const people = store.people;
  const me = store.me || '';
  const members = h ? Object.entries(h.memberNames || {}).filter(([uid]) => h.members.includes(uid)) : [];
  const localCount = store.localData().transactions.length;
  const migrated = localStorage.getItem(`mimimei-migrado-${cloud.user.uid}`) === 'feito';
  card.innerHTML = `
    <h2>Login e contas</h2>
    <div class="acct-row"><div class="who"><b>${esc(p.name || cloud.user.displayName || 'Você')}</b><span>${esc(cloud.user.email || '')}</span></div>
      <button class="btn small" id="acct-logout">Sair</button></div>
    <div class="acct-row"><label style="flex:1">Seu nome<input type="text" id="acct-name" value="${esc(p.name || '')}"></label></div>

    <h3>Conta aberta</h3>
    <div class="acct-row"><select id="acct-switch" style="max-width:100%;flex:1"><option>${esc(h?.name || '…')}</option></select></div>
    <h3>Membros (logins com acesso)</h3>
    ${members.map(([uid, n]) => {
    const person = (store.state.personOf || {})[uid];
    const isMe = uid === cloud.user.uid;
    return `<div class="acct-row member" data-uid="${esc(uid)}"><div class="who"><b>${esc(n)}${isMe ? ' (você)' : ''}</b>
        <span>${person ? `é “${esc(person)}” no Pago por` : 'ainda não ligado a uma pessoa'}</span></div>
        ${person ? '' : `<button class="btn small" data-act="add-person" data-name="${esc(n)}">+ Adicionar como pessoa</button>`}</div>`;
  }).join('') || '<p class="hint">—</p>'}
    <div class="acct-row"><div class="who"><b>Você é</b><span>usado como “Pago por” padrão nos seus lançamentos</span></div>
      <select id="acct-person"><option value="">—</option>${people.map((x) => `<option ${x === me ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" id="acct-invite">👥 Convidar alguém</button>
      <button class="btn" id="acct-rename">Renomear</button>
    </div>
    <div id="acct-invite-box" class="nf-attached hidden" style="margin-top:12px"></div>

    <h3>Entrar em outra conta</h3>
    <div class="paste-row" style="margin-top:0"><input type="text" id="acct-code" placeholder="Código de convite" autocapitalize="characters" maxlength="12"><button class="btn" id="acct-join">Entrar</button></div>

    <h3>Criar uma conta nova (começa vazia)</h3>
    <div class="paste-row" style="margin-top:0"><input type="text" id="acct-new" placeholder="Ex.: Viagem 2027, Pessoal Robs"><button class="btn" id="acct-create">Criar</button></div>

    ${localCount && !migrated ? `<h3>Dados deste aparelho</h3><p class="hint">Há ${localCount} lançamento(s) salvos só neste aparelho, de antes do login.</p>
      <button class="btn" id="acct-migrate">Enviar para “${esc(h?.name)}”</button>` : ''}
    <div id="acct-status" class="status"></div>`;

  const st = $('#acct-status');
  const run = async (fn) => { try { await fn(); } catch (e) { setStatus(st, friendlyError(e), 'err'); } };
  $('#acct-logout').addEventListener('click', () => run(async () => { await logout(); }));
  $('#acct-name').addEventListener('change', (e) => run(async () => { await setMyName(e.target.value.trim()); ui.toast('Nome atualizado.'); }));
  card.querySelectorAll('[data-act=add-person]').forEach((b) => b.addEventListener('click', () => run(async () => {
    const uid = b.closest('[data-uid]').dataset.uid;
    let name = b.dataset.name;
    if (store.people.includes(name)) { /* já existe: só liga */ } else if (!store.addPerson(name)) {
      name = prompt('Nome dessa pessoa no app:', name);
      if (!name || !store.addPerson(name.trim())) { ui.toast('Esse nome já existe ou está vazio.'); return; }
      name = name.trim();
    }
    await setPersonOf(uid, name);
    ui.toast(`${name} agora aparece no “Pago por”.`);
    setTimeout(renderCard, 300);
  })));
  $('#acct-person').addEventListener('change', (e) => run(async () => { await setMyPerson(e.target.value); ui.toast(e.target.value ? `Ok, você é ${e.target.value}.` : 'Ok.'); }));
  $('#acct-rename').addEventListener('click', () => run(async () => {
    const n = prompt('Novo nome da conta:', h.name);
    if (n && n.trim()) { await renameHousehold(n.trim()); setTimeout(() => { updateChip(); renderCard(); }, 300); }
  }));
  $('#acct-invite').addEventListener('click', () => run(async () => {
    const code = await createInvite();
    const link = `${location.origin}${location.pathname}?convite=${code}`;
    const box = $('#acct-invite-box');
    box.innerHTML = `Código para entrar em “${esc(h.name)}” (vale 7 dias):<div class="invite-code">${code}</div>
      <p class="hint" style="margin:6px 0">A outra pessoa abre o link abaixo (ou digita o código em Ajustes) e entra com o login dela.</p>
      <div class="btn-row"><button class="btn small" id="inv-share">Compartilhar link</button><button class="btn small" id="inv-copy">Copiar link</button></div>`;
    box.classList.remove('hidden');
    $('#inv-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); ui.toast('Link copiado.'); } catch { prompt('Copie o link:', link); } });
    $('#inv-share').addEventListener('click', async () => {
      const text = `Entre na nossa conta “${h.name}” no MiMimei: ${link} (código ${code})`;
      if (navigator.share) navigator.share({ title: 'MiMimei', text, url: link }).catch(() => {});
      else { try { await navigator.clipboard.writeText(text); ui.toast('Convite copiado.'); } catch { prompt('Copie o convite:', text); } }
    });
  }));
  $('#acct-join').addEventListener('click', () => run(async () => {
    const name = await joinWithCode($('#acct-code').value);
    ui.toast(`Você entrou na conta “${name}”.`); afterOpen();
  }));
  $('#acct-create').addEventListener('click', () => run(async () => {
    const name = $('#acct-new').value.trim();
    if (!name) { setStatus(st, 'Dê um nome para a nova conta.', 'warn'); return; }
    const id = await createHousehold(name);
    await openHousehold(id);
    ui.toast(`Conta “${name}” criada. Ela começa vazia.`); afterOpen();
  }));
  $('#acct-migrate')?.addEventListener('click', migrate);

  // lista de contas para trocar
  const list = await listHouseholds().catch(() => []);
  const sel = $('#acct-switch');
  if (!sel || !list.length) return;
  sel.innerHTML = list.map((x) => `<option value="${x.id}" ${x.id === h?.id ? 'selected' : ''}>${esc(x.name)} (${x.members} ${x.members === 1 ? 'pessoa' : 'pessoas'})</option>`).join('');
  sel.addEventListener('change', () => run(async () => { await openHousehold(sel.value); afterOpen(); ui.toast(`Conta “${cloud.household.name}” aberta.`); }));
}

export function refreshAccountUi() { updateChip(); }
