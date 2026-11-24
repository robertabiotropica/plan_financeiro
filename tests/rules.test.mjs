// Testa as regras de segurança do Firestore (firebase/firestore.rules) no emulador oficial.
// Rodar: npm run test:regras   (precisa de Java e do firebase-tools)

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, getDocs, collection, arrayUnion, Timestamp } from 'firebase/firestore';
let n = 0;
async function client(name) {
  const app = initializeApp({ apiKey: 'k', projectId: 'demo-mimimei', authDomain: 'localhost' }, name + (n++));
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const { user } = await createUserWithEmailAndPassword(auth, `${name}${Date.now()}@t.com`, 'segredo123');
  return { db, uid: user.uid };
}
const ok = async (label, p) => { try { await p; console.log('✅ permitido:', label); } catch (e) { console.log('❌ ERRO (devia permitir):', label, e.code); process.exitCode = 1; } };
const no = async (label, p) => { try { await p; console.log('❌ FALHA DE SEGURANÇA (devia negar):', label); process.exitCode = 1; } catch (e) { console.log('✅ negado:', label); } };

const robs = await client('robs'), lari = await client('lari'), intruso = await client('intruso');
const hid = 'casa' + Date.now();
await ok('Robs cria conta', setDoc(doc(robs.db, 'households', hid), { name: 'Casa', members: [robs.uid], memberNames: { [robs.uid]: 'Robs' }, createdBy: robs.uid, people: ['Robs', 'Lari'] }));
await no('criar conta já com outro membro', setDoc(doc(intruso.db, 'households', 'x' + hid), { name: 'X', members: [intruso.uid, robs.uid], createdBy: intruso.uid }));
await ok('Robs lança', setDoc(doc(robs.db, 'households', hid, 'transactions', 't1'), { amount: 10 }));
await no('intruso lê a conta', getDoc(doc(intruso.db, 'households', hid)));
await no('intruso lê lançamentos', getDocs(collection(intruso.db, 'households', hid, 'transactions')));
await no('intruso escreve lançamento', setDoc(doc(intruso.db, 'households', hid, 'transactions', 'x'), { amount: 1 }));
await no('intruso se adiciona sem convite', updateDoc(doc(intruso.db, 'households', hid), { members: arrayUnion(intruso.uid), joinedWith: 'NAOEXISTE' }));
await no('intruso cria convite para a conta dos outros', setDoc(doc(intruso.db, 'invites', 'AAAAAAAA'), { householdId: hid, createdBy: intruso.uid, expiresAt: Timestamp.fromMillis(Date.now() + 1e8) }));
await no('intruso lista convites', getDocs(collection(intruso.db, 'invites')));
await ok('Robs cria convite', setDoc(doc(robs.db, 'invites', 'CODIGO12'), { householdId: hid, householdName: 'Casa', createdBy: robs.uid, expiresAt: Timestamp.fromMillis(Date.now() + 7 * 864e5) }));
await no('Lari com convite tenta mudar outros campos', updateDoc(doc(lari.db, 'households', hid), { members: arrayUnion(lari.uid), joinedWith: 'CODIGO12', name: 'Hackeada' }));
await ok('Lari entra com convite', updateDoc(doc(lari.db, 'households', hid), { members: arrayUnion(lari.uid), [`memberNames.${lari.uid}`]: 'Lari', joinedWith: 'CODIGO12' }));
await ok('Lari lê lançamentos', getDocs(collection(lari.db, 'households', hid, 'transactions')));
await ok('Lari lança', setDoc(doc(lari.db, 'households', hid, 'transactions', 't2'), { amount: 20 }));
await ok('Robs cria convite que já expirou', setDoc(doc(robs.db, 'invites', 'VELHO123'), { householdId: hid, createdBy: robs.uid, expiresAt: Timestamp.fromMillis(Date.now() - 1000) }));
await no('intruso usa convite expirado', updateDoc(doc(intruso.db, 'households', hid), { members: arrayUnion(intruso.uid), joinedWith: 'VELHO123' }));
await no('intruso lê perfil de outro', getDoc(doc(intruso.db, 'users', robs.uid)));
await no('apagar a conta', (await import('firebase/firestore')).deleteDoc(doc(robs.db, 'households', hid)));
process.exit(process.exitCode || 0);
