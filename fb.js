// Firebase 實作：登入（Google）＋ Firestore。介面和 mock.js 一模一樣，app.js 只認這組函式。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut as fbSignOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, query, where, Timestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// 這段設定本來就會公開在網頁上，不是密碼；資料靠 firestore.rules 保護
const firebaseConfig = {
  apiKey: 'AIzaSyBL1D01Tdjqd1_gjJtXFaJdEo0GsLgz-7M',
  authDomain: 'trip-tools-21847.firebaseapp.com',
  projectId: 'trip-tools-21847',
  storageBucket: 'trip-tools-21847.firebasestorage.app',
  messagingSenderId: '877309827746',
  appId: '1:877309827746:web:6995a142e468b3a53a55fb'
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// 離線快取：旅途中沒網路也能看、能記帳，連上網後自動同步
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = initializeFirestore(app, {}); }

const out = s => ({ id: s.id, ...conv(s.data()) });
function conv(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) r[k] = v instanceof Timestamp ? v.toMillis() : v; return r; }

export default {
  mode: 'firebase',
  onAuth(cb) { return onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, name: u.displayName || u.email || '我', photo: u.photoURL || '', email: u.email || '' } : null)); },
  signIn() { return signInWithPopup(auth, new GoogleAuthProvider()); },
  signOut() { return fbSignOut(auth); },

  async getUser(uid) { const s = await getDoc(doc(db, 'users', uid)); return s.exists() ? conv(s.data()) : {}; },
  setUserTrip(uid, tripId, info) { return setDoc(doc(db, 'users', uid), { trips: { [tripId]: info } }, { merge: true }); },
  removeUserTrip(uid, tripId, all) { const t = { ...all }; delete t[tripId]; return updateDoc(doc(db, 'users', uid), { trips: t }); },

  async getTrip(id) { const s = await getDoc(doc(db, 'trips', id)); return s.exists() ? { id, ...conv(s.data()) } : null; },
  createTrip(id, data) { return setDoc(doc(db, 'trips', id), data); },
  updateTrip(id, patch) { return updateDoc(doc(db, 'trips', id), patch); },
  watchTrip(id, cb, err) { return onSnapshot(doc(db, 'trips', id), s => cb(s.exists() ? { id, ...conv(s.data()) } : null), err); },

  async getInvite(id) { const s = await getDoc(doc(db, 'trips', id, 'private', 'invite')); return s.exists() ? conv(s.data()) : null; },
  setInvite(id, inv) { return setDoc(doc(db, 'trips', id, 'private', 'invite'), { key: inv.key, expires: Timestamp.fromMillis(inv.expires) }); },

  watch(id, sub, cb, err, filter) {
    let q = collection(db, 'trips', id, sub);
    if (filter) q = query(q, where(filter[0], '==', filter[1]));
    return onSnapshot(q, s => cb(s.docs.map(out)), err);
  },
  add(id, sub, data) { return addDoc(collection(db, 'trips', id, sub), data); },
  set(id, sub, docId, data) { return setDoc(doc(db, 'trips', id, sub, docId), data); },
  update(id, sub, docId, patch) { return updateDoc(doc(db, 'trips', id, sub, docId), patch); },
  remove(id, sub, docId) { return deleteDoc(doc(db, 'trips', id, sub, docId)); },
};
