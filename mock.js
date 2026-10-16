// 模擬模式（網址加 ?mock=1）：不連 Firebase，資料存在這台瀏覽器的 localStorage，用來測畫面。
// ?as=名字 切換登入身分；?mock=reset 清空模擬資料。會模擬主要的權限規則（非成員讀不到、邀請碼要對、記帳轉帳只有 vis 裡的人讀得到）。
// &oldrules=1：模擬還沒換新規則的狀態（成員讀得到全部記帳、getAll 可用），用來測主辦人補舊資料的 vis。
const K = 'tt-mock';
const P = new URLSearchParams(location.search);
if (P.get('mock') === 'reset') { try { localStorage.removeItem(K); localStorage.removeItem(K + '-me'); } catch (e) {} }
let S; try { S = JSON.parse(localStorage.getItem(K) || 'null'); } catch (e) {}
S = S || { users: {}, trips: {} };
const save = () => { try { localStorage.setItem(K, JSON.stringify(S)); } catch (e) {} fire(); };
const subs = new Set();
const fire = () => setTimeout(() => subs.forEach(f => f()), 0);
let me = null, authCbs = [];
const asName = P.get('as') || (() => { try { return localStorage.getItem(K + '-me'); } catch (e) { return null; } })();
const mkUser = n => ({ uid: 'u_' + n, name: n, photo: '', email: n + '@example.com' });
if (asName) me = mkUser(asName);
const deny = () => { const e = new Error('permission-denied'); e.code = 'permission-denied'; return e; };
const T = id => S.trips[id];
const isMember = id => me && T(id) && (T(id).data.owner === me.uid || (T(id).members || {})[me.uid]);
const isOwner = id => me && T(id) && T(id).data.owner === me.uid;
let seq = Date.now();
const OLD = P.has('oldrules');
const PRIV = sub => sub === 'expenses' || sub === 'settles';
const inVis = d => !!(d && Array.isArray(d.vis) && me && d.vis.includes(me.uid));
const visOk = (sub, d) => OLD || (Array.isArray(d.vis) && (sub === 'settles'
  ? [d.from, d.to].every(u => d.vis.includes(u)) && [d.from, d.to].includes(me.uid)
  : [d.by, d.payer, ...Object.keys(d.shares || {})].every(u => d.vis.includes(u))));

export default {
  mode: 'mock',
  onAuth(cb) { authCbs.push(cb); setTimeout(() => cb(me), 0); return () => {}; },
  async signIn() { const n = prompt('模擬登入：輸入名字', '哥哥') || '哥哥'; me = mkUser(n); try { localStorage.setItem(K + '-me', n); } catch (e) {} authCbs.forEach(f => f(me)); },
  async signOut() { me = null; try { localStorage.removeItem(K + '-me'); } catch (e) {} authCbs.forEach(f => f(null)); },

  async getUser(uid) { return JSON.parse(JSON.stringify(S.users[uid] || {})); },
  async setUserTrip(uid, tripId, info) { (S.users[uid] = S.users[uid] || { trips: {} }).trips = { ...(S.users[uid].trips || {}), [tripId]: info }; save(); },
  async removeUserTrip(uid, tripId) { if (S.users[uid]) delete S.users[uid].trips[tripId]; save(); },

  async getTrip(id) { if (!T(id)) return null; if (!isMember(id)) throw deny(); return { id, ...T(id).data }; },
  async createTrip(id, data) { if (T(id)) throw deny(); S.trips[id] = { data, members: {}, expenses: {}, settles: {}, restos: {}, budget: {}, private: {} }; save(); },
  async updateTrip(id, patch) { if (!isMember(id)) throw deny(); if (!isOwner(id) && Object.keys(patch).some(k => k !== 'rate')) throw deny(); Object.assign(T(id).data, patch); save(); },
  watchTrip(id, cb, err) { const f = () => { if (!T(id)) return cb(null); isMember(id) ? cb({ id, ...T(id).data }) : err && err(deny()); }; subs.add(f); setTimeout(f, 0); return () => subs.delete(f); },

  async getInvite(id) { if (!isOwner(id)) throw deny(); return T(id).private.invite || null; },
  async setInvite(id, inv) { if (!isOwner(id)) throw deny(); T(id).private.invite = inv; save(); },

  watch(id, sub, cb, err, filter) {
    const f = () => {
      if (!T(id)) return cb([]);
      let rows = Object.entries(T(id)[sub] || {}).map(([k, v]) => ({ id: k, ...v }));
      if (!isMember(id)) { if (sub === 'restos' && filter) rows = rows.filter(r => r[filter[0]] === filter[1]); else return err && err(deny()); }
      if (PRIV(sub) && !OLD && !(filter && filter[0] === 'vis' && filter[2] === 'array-contains' && filter[1] === me.uid)) return err && err(deny());   // 新規則：不帶 vis 條件的查詢整個被拒
      if (filter) rows = rows.filter(r => filter[2] === 'array-contains' ? (r[filter[0]] || []).includes(filter[1]) : r[filter[0]] === filter[1]);
      cb(JSON.parse(JSON.stringify(rows)));
    };
    subs.add(f); setTimeout(f, 0); return () => subs.delete(f);
  },
  async getAll(id, sub) { if (!isMember(id) || (PRIV(sub) && !OLD)) throw deny(); return JSON.parse(JSON.stringify(Object.entries(T(id)[sub] || {}).map(([k, v]) => ({ id: k, ...v })))); },
  async add(id, sub, data) { if (!isMember(id) || data.by !== me.uid || (sub === 'restos' && data.status !== 'pending') || (sub === 'budget' && !isOwner(id)) || (PRIV(sub) && !visOk(sub, data))) throw deny(); const k = 'd' + (++seq); (T(id)[sub] = T(id)[sub] || {})[k] = data; save(); return { id: k }; },
  async set(id, sub, docId, data) {
    if (sub === 'members') {
      const inv = T(id) && T(id).private.invite;
      const ok = me && docId === me.uid && data.uid === me.uid && ((isOwner(id) && data.role === 'owner') || (data.role === 'member' && inv && data.key === inv.key && Date.now() < inv.expires));
      if (!ok) throw deny();
    } else if (!isMember(id)) throw deny();
    else if (sub === 'expenses' && T(id)[sub][docId] && ((T(id)[sub][docId].by !== me.uid && !isOwner(id)) || (!OLD && !inVis(T(id)[sub][docId])))) throw deny();
    else if (sub === 'expenses' && (!visOk(sub, data) || (T(id)[sub][docId] && data.by !== T(id)[sub][docId].by))) throw deny();
    else if (sub === 'budget' && !isOwner(id)) throw deny();
    T(id)[sub] = T(id)[sub] || {};
    T(id)[sub][docId] = data; save();
  },
  async update(id, sub, docId, patch) {
    if (!isMember(id)) throw deny();
    if ((sub === 'restos' || sub === 'budget') && !isOwner(id)) throw deny();
    if (PRIV(sub)) { const d = T(id)[sub][docId]; if (!d || (d.by !== me.uid && !isOwner(id)) || (!OLD && (!inVis(d) || !visOk(sub, { ...d, ...patch })))) throw deny(); }
    Object.assign(T(id)[sub][docId], patch); save();
  },
  async remove(id, sub, docId) {
    if (!isMember(id)) throw deny();
    const d = T(id)[sub][docId] || {};
    if (PRIV(sub) && !OLD && !inVis(d)) throw deny();
    const ok = (sub === 'settles' && !OLD && inVis(d)) || isOwner(id) || (sub === 'budget' ? false : sub === 'members' ? docId === me.uid : sub === 'restos' ? d.by === me.uid && d.status === 'pending' : d.by === me.uid);
    if (!ok) throw deny();
    delete T(id)[sub][docId]; save();
  },
};
