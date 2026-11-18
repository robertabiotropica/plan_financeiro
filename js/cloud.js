// Login e sincronização com o Firebase (Auth + Firestore).
// Modelo de dados:
//   users/{uid}                       perfil: nome, e-mail, contas, conta atual
//   households/{hid}                  "conta" compartilhada: membros + ajustes (pessoas, categorias…)
//   households/{hid}/transactions/{id} lançamentos
//   invites/{código}                  convite para entrar numa conta (vale 7 dias)
import {
  initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile, GoogleAuthProvider, signInWithPopup, connectAuthEmulator,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  connectFirestoreEmulator, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  writeBatch, arrayUnion, Timestamp,
} from '../vendor/firebase/firebase.js';
import { store } from './store.js';

let auth = null;
let db = null;
let user = null;
let profile = null;
let current = null;           // { id, ...dados da conta }
let unsubs = [];
const errorHandlers = new Set();
const statusHandlers = new Set();
let syncStatus = 'offline';

export const cloud = {
  get enabled() { return !!db; },
  get user() { return user; },
  get profile() { return profile; },
  get household() { return current; },
  get status() { return syncStatus; },
  onError(fn) { errorHandlers.add(fn); },
  onStatus(fn) { statusHandlers.add(fn); },
};

function reportError(e, what) {
  console.error(what, e);
  errorHandlers.forEach((fn) => fn(friendlyError(e), what));
}
function setStatus(s) {
  syncStatus = s;
  statusHandlers.forEach((fn) => fn(s));
}

export function friendlyError(e) {
  const code = e?.code || '';
  const map = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/missing-password': 'Digite a senha.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/email-already-in-use': 'Já existe um login com esse e-mail. Use “Entrar”.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'Não existe login com esse e-mail. Use “Criar login”.',
    'auth/too-many-requests': 'Muitas tentativas. Espere um pouco e tente de novo.',
    'auth/network-request-failed': 'Sem internet. Tente de novo quando conectar.',
    'auth/popup-closed-by-user': 'A janela do Google foi fechada antes de terminar.',
    'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Permita pop-ups ou use e-mail e senha.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication → Configurações → Domínios autorizados).',
    'auth/operation-not-allowed': 'Este tipo de login não está ativado no Firebase (Authentication → Método de login).',
    'permission-denied': 'Sem permissão para isso nesta conta.',
    unavailable: 'Sem conexão com o servidor; os dados serão enviados quando a internet voltar.',
  };
  return map[code] || e?.message || String(e);
}

/** Inicializa o Firebase. Retorna false se não houver configuração. */
export function initCloud(config, { emulator = false } = {}) {
  if (!config) return false;
  const app = initializeApp(config);
  auth = getAuth(app);
  let cache;
  try { cache = persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch { cache = memoryLocalCache(); }
  db = initializeFirestore(app, { localCache: cache, ignoreUndefinedProperties: true });
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return true;
}

export function watchAuth(cb) {
  onAuthStateChanged(auth, async (u) => {
    user = u;
    if (!u) {
      stopSync();
      profile = null; current = null;
      store.useLocal();
      cb(null);
      return;
    }
    try {
      await loadProfile();
      cb(u);
    } catch (e) { reportError(e, 'perfil'); cb(u); }
  });
}

// ---------- login ----------
export async function signIn(email, password) {
  await signInWithEmailAndPassword(auth, email.trim(), password);
}
export async function signUp(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (name) await updateProfile(cred.user, { displayName: name.trim() });
}
export async function signInGoogle() {
  await signInWithPopup(auth, new GoogleAuthProvider());
}
export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}
export async function logout() {
  stopSync();
  await signOut(auth);
}

function displayName() {
  return profile?.name || user?.displayName || (user?.email || '').split('@')[0] || 'Eu';
}

// ---------- perfil ----------
async function loadProfile() {
  const ref = doc(db, 'users', user.uid);
  let snap;
  try { snap = await getDoc(ref); } catch (e) { if (e.code !== 'unavailable') throw e; }
  if (snap?.exists()) {
    profile = snap.data();
  } else {
    profile = { name: user.displayName || (user.email || '').split('@')[0], email: user.email || '', households: [], current: null };
    await setDoc(ref, profile, { merge: true });
  }
}
async function saveProfile(patch) {
  Object.assign(profile, patch);
  await setDoc(doc(db, 'users', user.uid), patch, { merge: true });
}
export async function setMyName(name) {
  await saveProfile({ name });
  if (current) {
    await updateDoc(doc(db, 'households', current.id), { [`memberNames.${user.uid}`]: name });
    store.useBackend(backendFor(current.id), { uid: user.uid, name });
  }
}

// ---------- contas (households) ----------
function randomId(len, alphabet = 'abcdefghijkmnpqrstuvwxyz23456789') {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export async function createHousehold(name, settings = store.defaultSettings()) {
  const id = randomId(20);
  const data = {
    name: name || 'Casa',
    members: [user.uid],
    memberNames: { [user.uid]: displayName() },
    personOf: {},
    createdBy: user.uid,
    createdAt: new Date().toISOString(),
    ...settings,
  };
  await setDoc(doc(db, 'households', id), data);
  await saveProfile({ households: [...new Set([...(profile.households || []), id])], current: id });
  return id;
}

export async function listHouseholds() {
  const ids = (profile?.households || []);
  const out = [];
  for (const id of ids) {
    try {
      const s = await getDoc(doc(db, 'households', id));
      if (s.exists()) out.push({ id, name: s.data().name, members: s.data().members.length });
    } catch { /* sem acesso: ignora */ }
  }
  return out;
}

/** Abre a conta atual do perfil (ou cria a primeira). */
export async function openDefault() {
  const ids = (profile.households || []);
  let id = profile.current && ids.includes(profile.current) ? profile.current : ids[0];
  if (!id) id = await createHousehold('Casa');
  return openHousehold(id);
}

export function openHousehold(id) {
  stopSync();
  setStatus('loading');
  if (profile.current !== id) saveProfile({ current: id }).catch((e) => reportError(e, 'perfil'));
  store.useBackend(backendFor(id), { uid: user.uid, name: displayName() });
  store.replace({ transactions: [] });

  let firstTx = true;
  return new Promise((resolve, reject) => {
    let gotHousehold = false; let gotTx = false;
    const done = () => { if (gotHousehold && gotTx) resolve(current); };
    unsubs.push(onSnapshot(doc(db, 'households', id), (snap) => {
      if (!snap.exists()) { reject(new Error('Conta não encontrada.')); return; }
      const d = snap.data();
      current = { id, ...d };
      const defaults = store.defaultSettings();
      store.replace({
        people: d.people || defaults.people,
        categories: d.categories || defaults.categories,
        memory: d.memory || {},
        merchants: d.merchants || {},
        personOf: d.personOf || {},
        houseSize: d.houseSize || 3,
        migrations: d.migrations || {},
        householdName: d.name,
        memberNames: d.memberNames || {},
      });
      gotHousehold = true; done();
    }, (e) => { reportError(e, 'conta'); reject(e); }));

    unsubs.push(onSnapshot(collection(db, 'households', id, 'transactions'), { includeMetadataChanges: true }, (snap) => {
      if (firstTx || snap.docChanges().length) {
        store.replace({ transactions: snap.docs.map((d) => ({ ...d.data(), id: d.id })) });
      }
      firstTx = false;
      setStatus(snap.metadata.hasPendingWrites ? 'saving' : snap.metadata.fromCache ? 'offline' : 'synced');
      gotTx = true; done();
    }, (e) => { reportError(e, 'lançamentos'); reject(e); }));
  });
}

function stopSync() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

export async function renameHousehold(name) {
  await updateDoc(doc(db, 'households', current.id), { name });
}
/** Diz qual "pessoa" (Robs/Lari) é o login atual nesta conta. */
export async function setMyPerson(person) {
  await updateDoc(doc(db, 'households', current.id), { [`personOf.${user.uid}`]: person });
}

// ---------- convites ----------
export async function createInvite() {
  const code = randomId(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  await setDoc(doc(db, 'invites', code), {
    householdId: current.id,
    householdName: current.name,
    createdBy: user.uid,
    createdByName: displayName(),
    expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86400000),
  });
  return code;
}

export async function joinWithCode(raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) throw new Error('O código de convite tem 8 letras/números.');
  const inv = await getDoc(doc(db, 'invites', code));
  if (!inv.exists()) throw new Error('Convite não encontrado. Confira o código.');
  const { householdId, householdName, expiresAt } = inv.data();
  if (expiresAt.toMillis() < Date.now()) throw new Error('Este convite expirou. Peça um novo.');
  if (!(profile.households || []).includes(householdId)) {
    await updateDoc(doc(db, 'households', householdId), {
      members: arrayUnion(user.uid),
      [`memberNames.${user.uid}`]: displayName(),
      joinedWith: code,
    });
    await saveProfile({ households: [...new Set([...(profile.households || []), householdId])] });
  }
  await openHousehold(householdId);
  return householdName;
}

// ---------- gravação ----------
function backendFor(hid) {
  const txRef = (id) => doc(db, 'households', hid, 'transactions', id);
  const fail = (what) => (e) => reportError(e, what);
  return {
    kind: 'cloud',
    saveSettings(settings) {
      setDoc(doc(db, 'households', hid), settings, { merge: true }).catch(fail('ajustes'));
    },
    putTxs(list) {
      for (let i = 0; i < list.length; i += 400) {
        const batch = writeBatch(db);
        list.slice(i, i + 400).forEach((t) => batch.set(txRef(t.id), t));
        batch.commit().catch(fail('salvar'));
      }
    },
    patchTx(id, patch) { updateDoc(txRef(id), patch).catch(fail('salvar')); },
    deleteTx(id) { deleteDoc(txRef(id)).catch(fail('excluir')); },
  };
}
