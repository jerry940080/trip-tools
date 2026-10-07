// 旅行記帳・餐廳（測試版）主程式
// 網址加 ?mock=1 走模擬模式（不連 Firebase）；正式走 fb.js。
const MOCK = new URLSearchParams(location.search).has('mock');
const api = (await import(MOCK ? './mock.js' : './fb.js')).default;

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BASE = location.pathname.replace(/[^/]*$/, '');           // /trip-tools/
const KNOWN = ['IzuAtami-trip', '2025-osaka-kanazawa-miokokoen-nagano-tokyo', 'Osaka_Kyoto_Kobe', 'TaiwanTrip2026'];
const COLORS = ['#c67139', '#3f4f8a', '#b4507a', '#3c9a72', '#8a6d1f', '#5e3f7a', '#2b7a8a', '#a33b3b'];
const MEALS = ['早餐', '午餐', '點心', '晚餐'];
const ICONS = ['🍽', '🍣', '🍢', '🍜', '☕', '🍓', '🚕', '🚗', '🚆', '🎫', '♨', '🛍', '🏨', '✈', '💴'];

let me = null, cur = null; // cur：目前打開的行程 {id, trip, members, expenses, settles, restos, unsub[]}
let route = { page: 'home' };

/* ───────── 小工具 ───────── */
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 1800); }
const yen = v => '¥' + Math.round(v).toLocaleString('en-US');
const nt = v => 'NT ' + Math.round(v).toLocaleString('en-US');
const money = (v, c) => c === 'TWD' ? nt(v) : yen(v);
const rnd = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join(''); };
const fmtD = s => { const [y, m, d] = s.split('-').map(Number); return m + '/' + d; };
const WD = '日一二三四五六';
const wd = s => WD[new Date(s + 'T12:00:00').getDay()];
function days(trip) { const out = []; if (!trip.start || !trip.end) return out; for (let t = new Date(trip.start + 'T12:00:00'); t <= new Date(trip.end + 'T12:00:00'); t.setDate(t.getDate() + 1)) out.push(t.toISOString().slice(0, 10)); return out; }
const todayISO = () => { const n = new Date(); return new Date(n.getTime() - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
function memberList() { return (cur.members || []).slice().sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || (a.joinedAt || 0) - (b.joinedAt || 0)); }
function mInfo(uid) { const L = memberList(); const i = L.findIndex(m => m.uid === uid); const m = L[i]; return { name: m ? m.name : '（已離開）', color: COLORS[(i < 0 ? 7 : i) % COLORS.length], photo: m && m.photo }; }
function ava(uid, sz) { const m = mInfo(uid); const st = `background-color:${m.color};${sz ? `width:${sz}px;height:${sz}px;font-size:${Math.round(sz * .42)}px;` : ''}`; return m.photo ? `<span class="ava" style="${st}background-image:url('${esc(m.photo)}')"></span>` : `<span class="ava" style="${st}">${esc([...m.name][0] || '?')}</span>`; }
const isOwner = () => cur && cur.trip && me && cur.trip.owner === me.uid;
async function tripMeta(repo) { try { const r = await fetch('/' + repo + '/trip.json', { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) {} return null; }
function errMsg(e) { return e && (e.code === 'permission-denied' || /permission/i.test(e.message || '')) ? '沒有權限（不是這趟的成員，或邀請連結已失效）' : '發生錯誤：' + (e && e.message || e); }

/* ───────── 算錢 ───────── */
// 每筆換成台幣；分攤：equal/ratio/treat 依份數、amount 依指定金額
function calc() {
  const rate = +cur.trip.rate || 4.8;
  const toNT = (v, c) => c === 'TWD' ? v : v / rate;
  const paid = {}, owe = {};
  memberList().forEach(m => { paid[m.uid] = 0; owe[m.uid] = 0; });
  let total = 0;
  for (const e of cur.expenses || []) {
    const v = toNT(+e.amount || 0, e.cur); total += v;
    paid[e.payer] = (paid[e.payer] || 0) + v;
    const sh = e.shares || {}; const sum = Object.values(sh).reduce((a, b) => a + (+b || 0), 0) || 1;
    for (const [u, s] of Object.entries(sh)) owe[u] = (owe[u] || 0) + v * (+s || 0) / (e.mode === 'amount' ? (+e.amount || 1) : sum);
  }
  const bal = {}; Object.keys({ ...paid, ...owe }).forEach(u => bal[u] = (paid[u] || 0) - (owe[u] || 0));
  for (const s of cur.settles || []) { bal[s.from] = (bal[s.from] || 0) + s.amount; bal[s.to] = (bal[s.to] || 0) - s.amount; }
  // 最少轉帳筆數：欠最多的先付給收最多的
  const cr = Object.entries(bal).filter(x => x[1] < -1).map(x => [...x]), dr = Object.entries(bal).filter(x => x[1] > 1).map(x => [...x]);
  cr.sort((a, b) => a[1] - b[1]); dr.sort((a, b) => b[1] - a[1]);
  const tr = []; let i = 0, j = 0;
  while (i < cr.length && j < dr.length) { const x = Math.min(-cr[i][1], dr[j][1]); tr.push({ from: cr[i][0], to: dr[j][0], amount: x }); cr[i][1] += x; dr[j][1] -= x; if (cr[i][1] > -1) i++; if (dr[j][1] < 1) j++; }
  return { rate, total, paid, owe, bal, tr, toNT };
}

/* ───────── 路由 ───────── */
function parse() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 't' && h[1]) return { page: h[2] || 'exp', id: decodeURIComponent(h[1]) };
  if (h[0] === 'join' && h[1]) return { page: 'join', id: decodeURIComponent(h[1]), key: h[2] || '' };
  return { page: 'home' };
}
const go = h => { location.hash = h; };
window.addEventListener('hashchange', () => { route = parse(); show(); });

function closeTrip() { if (cur) (cur.unsub || []).forEach(f => { try { f(); } catch (e) {} }); cur = null; }
function openTrip(id) {
  if (cur && cur.id === id) return;
  closeTrip();
  cur = { id, trip: null, members: [], expenses: [], settles: [], restos: [], unsub: [], err: null, loaded: false };
  const c = cur, fail = e => { if (c !== cur) return; c.err = e; render(); };
  c.unsub.push(api.watchTrip(id, t => { if (c !== cur) return; c.trip = t; c.loaded = true; render(); }, fail));
  for (const sub of ['members', 'expenses', 'settles', 'restos'])
    c.unsub.push(api.watch(id, sub, rows => { if (c !== cur) return; c[sub] = rows; render(); }, fail));
}

/* ───────── 畫面 ───────── */
const app = () => $('#app');
const testBar = () => `<div class="test">測試版${MOCK ? '（模擬資料）' : ''}・不影響正式行程網站</div>`;
function tabs(on) {
  const T = [['exp', '🧾', '記帳'], ['settle', '⚖️', '結算'], ['resto', '🍽', '餐廳'], ['mem', '👥', '成員']];
  return `<nav class="tabs">${T.map(([k, i, t]) => `<a href="#/t/${encodeURIComponent(cur.id)}/${k}" class="${k === on ? 'on' : ''}"><i>${i}</i>${t}</a>`).join('')}</nav>`;
}
function head(title) {
  const t = cur.trip;
  return `<div class="top"><div><div class="t"><a href="#/" style="text-decoration:none">‹ 我的行程</a>　${esc(t.title)}　${t.start ? fmtD(t.start) + '–' + fmtD(t.end) : ''}</div><h1 class="cap">${title}</h1></div>${ava(me.uid, 32)}</div>`;
}

function show() {
  if (me === undefined) return;
  if (route.page === 'home') { closeTrip(); return renderHome(); }
  if (route.page === 'join') { closeTrip(); return renderJoin(); }
  if (!me) { closeTrip(); return renderLogin('登入後才能看這趟的記帳與餐廳'); }
  openTrip(route.id); render();
}
function render() {
  if (!cur) return;
  if (cur.err) return app().innerHTML = testBar() + `<div class="hero"><div style="font-size:40px">🔒</div><h1 class="cap">進不去這趟</h1><p>${esc(errMsg(cur.err))}。<br>請向主辦人要一個新的邀請連結。</p><a class="btn s" href="#/">回我的行程</a></div>`;
  if (!cur.loaded) return app().innerHTML = testBar() + '<div class="hero"><p>讀取中…</p></div>';
  if (!cur.trip) return app().innerHTML = testBar() + `<div class="hero"><h1 class="cap">找不到這趟</h1><p>可能還沒建立。</p><a class="btn s" href="#/">回我的行程</a></div>`;
  const p = route.page;
  app().innerHTML = testBar() + ({ exp: pExp, settle: pSettle, resto: pResto, mem: pMem }[p] || pExp)() + tabs(p);
}

/* 登入 */
function renderLogin(msg) {
  app().innerHTML = testBar() + `<div class="hero"><div style="font-size:44px">🧳</div><h1 class="cap">旅行記帳・餐廳</h1><p>${esc(msg || '和同行的人一起記帳、分帳、推薦餐廳。')}<br>行程內容不用登入也能在行程網站看。</p>
  <button class="btn g" data-act="login">用 Google 帳號登入</button></div>`;
}
/* 首頁：我的行程 */
async function renderHome() {
  if (!me) return renderLogin();
  app().innerHTML = testBar() + `<div class="top"><div><div class="t">${esc(me.name)}</div><h1 class="cap">我的行程</h1></div><button data-act="logout" class="small">登出</button></div><div id="mt"><div class="empty">讀取中…</div></div>`;
  const u = await api.getUser(me.uid).catch(() => ({}));
  const L = Object.entries(u.trips || {}).sort((a, b) => (b[1].start || '') > (a[1].start || '') ? 1 : -1);
  let h = L.length ? L.map(([id, t]) => `<a class="tl" href="#/t/${encodeURIComponent(id)}/exp" style="--c:${esc(t.color || '#c67139')}"><div class="cv" style="${t.cover ? `background-image:url('/${esc(id)}/${esc(t.cover)}')` : ''}"></div><div class="b"><div class="n cap">${esc(t.title)}</div><div class="m">${t.start ? fmtD(t.start) + '–' + fmtD(t.end) : ''}・${t.role === 'owner' ? '我是主辦人' : '成員'}</div></div></a>`).join('')
    : `<div class="empty">還沒有加入任何行程。<br>向主辦人要邀請連結，或自己建立一趟。</div>`;
  h += `<div class="card"><b>建立一趟（你當主辦人）</b><div class="small" style="margin-top:4px">從你已經上線的行程網站挑一趟，標題和日期會自動帶入（讀網站的 trip.json）。</div><div id="mk" class="small" style="margin-top:8px">讀取中…</div></div>`;
  $('#mt').innerHTML = h;
  const metas = await Promise.all(KNOWN.map(async r => [r, await tripMeta(r)]));
  const mk = $('#mk'); if (!mk) return;
  mk.innerHTML = metas.filter(([r, m]) => m && !(u.trips || {})[r]).map(([r, m]) => `<button class="btn s" style="margin-top:6px;text-align:left" data-act="create" data-repo="${esc(r)}">＋ ${esc(m.title)}　<span class="small">${esc(m.start || '')}</span></button>`).join('') || '可以建立的行程都已經建好了。';
}
/* 邀請加入 */
async function renderJoin() {
  const { id, key } = route; const m = await tripMeta(id);
  const title = m ? m.title : id;
  app().innerHTML = testBar() + `<div class="hero"><div style="height:170px;border-radius:24px;background:${m && m.cover ? `url('/${esc(id)}/${esc(m.cover)}') center/cover` : esc(m && m.color || '#c67139')};margin-bottom:18px"></div>
  <p style="margin:0">你收到一趟行程的邀請</p><h1 class="cap">${esc(title)}</h1><p>登入後可以記一筆花費、看大家的分帳、推薦想吃的店。<br>只有這趟的成員看得到花費。</p>
  ${me ? `<button class="btn" data-act="join">以 ${esc(me.name)} 加入</button><button class="btn s" data-act="logout">換一個帳號</button>` : `<button class="btn g" data-act="login">用 Google 帳號登入並加入</button>`}<div class="err" id="jerr"></div></div>`;
  if (me && !key) $('#jerr').textContent = '連結不完整，請向主辦人重新要一次。';
}

/* 記帳 */
function pExp() {
  const c = calc(); const L = memberList();
  const ex = (cur.expenses || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || 0) - (a.at || 0));
  const mine = c.bal[me.uid] || 0;
  let h = head('花費記帳');
  h += `<div class="sum"><div style="display:flex;justify-content:space-between;gap:10px"><div><div class="k">這趟總花費（換算台幣）</div><div class="v">${nt(c.total)}</div></div><div style="text-align:right"><div class="k">我目前</div><div class="v ${mine >= 0 ? 'pos' : 'neg'}">${Math.abs(mine) < 1 ? '兩清' : (mine > 0 ? '應收 ' : '應付 ') + nt(Math.abs(mine))}</div></div></div>
    <div class="ppl">${L.map(m => { const b = c.bal[m.uid] || 0; return `<div class="pp">${ava(m.uid, 26)}<div><div class="n">${esc(m.name)}</div><div class="b ${b >= 0 ? 'pos' : 'neg'}">${Math.abs(b) < 1 ? '兩清' : (b > 0 ? '+' : '−') + Math.round(Math.abs(b)).toLocaleString()}</div></div></div>`; }).join('')}</div></div>`;
  if (!ex.length) h += `<div class="empty">還沒有任何一筆。<br>按右下角「＋ 記一筆」開始。</div>`;
  let last = '';
  for (const e of ex) {
    if (e.date !== last) { last = e.date; const dt = ex.filter(x => x.date === e.date).reduce((a, x) => a + c.toNT(+x.amount, x.cur), 0); h += `<div class="day"><span>${fmtD(e.date)}（${wd(e.date)}）</span><span>${nt(dt)}</span></div>`; }
    const n = Object.keys(e.shares || {}).length;
    const tag = e.mode === 'treat' ? `${mInfo(e.payer).name}請客` : e.mode === 'ratio' ? '比例' : e.mode === 'amount' ? '指定金額' : '';
    h += `<button class="it" data-act="edit" data-id="${esc(e.id)}"><div class="ic">${esc(e.icon || '🧾')}</div><div><div class="n">${esc(e.title)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</div><div class="m">${esc(mInfo(e.payer).name)} 付・${e.mode === 'treat' ? '不分攤' : n + ' 人分'}</div></div><div class="a">${money(+e.amount, e.cur)}${e.cur !== 'TWD' ? `<small>≈ ${nt(c.toNT(+e.amount, e.cur))}</small>` : ''}</div></button>`;
  }
  h += `<button class="fab" data-act="add">＋ 記一筆</button>`;
  return h;
}

/* 記一筆／修改 */
let F = null;
function openExp(id) {
  const L = memberList(); const D = days(cur.trip); const t = todayISO();
  const e = id && (cur.expenses || []).find(x => x.id === id);
  F = e ? { id, date: e.date, title: e.title, icon: e.icon || '🧾', amount: String(e.amount), cur: e.cur, payer: e.payer, mode: e.mode, shares: { ...e.shares }, by: e.by }
    : { date: D.includes(t) ? t : (D[0] || t), title: '', icon: '🍽', amount: '', cur: 'JPY', payer: me.uid, mode: 'equal', shares: Object.fromEntries(L.map(m => [m.uid, 1])) };
  drawExp();
}
function drawExp() {
  const L = memberList(), D = days(cur.trip), c = calc();
  const amt = +F.amount || 0;
  const can = !F.id || F.by === me.uid || isOwner();
  let rows = '';
  if (F.mode === 'treat') rows = `<div class="small" style="margin-top:6px">這筆算 <b>${esc(mInfo(F.payer).name)}</b> 請客，只記在他身上，不分給其他人。</div>`;
  else {
    const sum = Object.values(F.shares).reduce((a, b) => a + (+b || 0), 0) || 1;
    rows = L.map(m => {
      const on = m.uid in F.shares; const s = F.shares[m.uid];
      const each = !on ? 0 : F.mode === 'amount' ? (+s || 0) : amt * (+s || 0) / sum;
      const inp = F.mode === 'equal' ? '' : `<input inputmode="decimal" data-sh="${esc(m.uid)}" value="${on ? esc(s) : ''}" placeholder="${F.mode === 'ratio' ? '份數' : '金額'}" ${on ? '' : 'disabled'}>`;
      return `<div class="shr"><button class="chip ${on ? 'on' : ''}" data-act="tog" data-u="${esc(m.uid)}">${ava(m.uid)}${esc(m.name)}</button><span></span>${inp}<b data-ea="${esc(m.uid)}" style="min-width:70px;text-align:right">${on ? money(each, F.cur) : '—'}</b></div>`;
    }).join('');
    if (F.mode === 'amount') rows += `<div class="small" style="margin-top:6px" id="fChk">${amtChk()}</div>`;
  }
  $('#sheet').innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">${F.id ? '修改這筆' : '記一筆'}</b><button class="small" data-act="close">取消</button></div>
  <div class="lab">金額</div><div class="amt"><input id="fAmt" inputmode="decimal" placeholder="0" value="${esc(F.amount)}"><div class="cur"><button data-act="cur" data-c="JPY" class="${F.cur === 'JPY' ? 'on' : ''}">日圓</button><button data-act="cur" data-c="TWD" class="${F.cur === 'TWD' ? 'on' : ''}">台幣</button></div></div>
  <div class="small" style="margin-top:4px" id="fConv">${convTxt()}</div>
  <div class="lab">名稱</div><input class="inp" id="fTitle" placeholder="例如：まぐろ館 午餐" value="${esc(F.title)}">
  <div class="chips" style="margin-top:8px">${ICONS.map(i => `<button class="chip ${F.icon === i ? 'on' : ''}" style="padding:4px 9px" data-act="icon" data-i="${i}">${i}</button>`).join('')}</div>
  <div class="lab">日期</div><select class="inp" id="fDate">${(D.length ? D : [F.date]).concat(D.includes(F.date) || !D.length ? [] : [F.date]).map(d => `<option value="${d}" ${d === F.date ? 'selected' : ''}>${fmtD(d)}（${wd(d)}）</option>`).join('')}</select>
  <div class="lab">誰先付的</div><div class="chips">${L.map(m => `<button class="chip ${F.payer === m.uid ? 'on' : ''}" data-act="payer" data-u="${esc(m.uid)}">${ava(m.uid)}${esc(m.name)}</button>`).join('')}</div>
  <div class="lab">怎麼分</div><div class="split">${[['equal', '平均'], ['ratio', '比例'], ['amount', '指定金額'], ['treat', '有人請客']].map(([k, t]) => `<button data-act="mode" data-m="${k}" class="${F.mode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
  <div style="margin-top:4px">${rows}</div>
  <div class="err" id="ferr"></div>
  ${can ? `<button class="btn" data-act="save">存檔</button>${F.id ? '<button class="btn s" data-act="del">刪除這筆</button>' : ''}` : '<div class="small" style="margin-top:12px">這筆是別人記的，只有記帳的人或主辦人能改。</div>'}`;
  $('#dim').hidden = false;
  $('#sheet').oninput = ev => { if (ev.target.id === 'fAmt' || ev.target.dataset.sh) liveExp(); };
}
function convTxt() { const r = calc().rate; return F.cur === 'JPY' ? '≈ ' + nt((+F.amount || 0) / r) + `（匯率 1：${r}，可在結算頁改）` : ''; }
function amtChk() { const s = Object.values(F.shares).reduce((a, b) => a + (+b || 0), 0), amt = +F.amount || 0; return `指定金額合計 ${money(s, F.cur)}／這筆 ${money(amt, F.cur)}${Math.abs(s - amt) > .5 ? '　<b style="color:var(--bad)">對不上</b>' : '　✓'}`; }
function liveExp() {
  readExp(); const amt = +F.amount || 0; const sum = Object.values(F.shares).reduce((a, b) => a + (+b || 0), 0) || 1;
  document.querySelectorAll('[data-ea]').forEach(b => { const u = b.dataset.ea; if (!(u in F.shares)) return; const s = +F.shares[u] || 0; b.textContent = money(F.mode === 'amount' ? s : amt * (F.mode === 'equal' ? 1 : s) / (F.mode === 'equal' ? Object.keys(F.shares).length || 1 : sum), F.cur); });
  const c = $('#fConv'); if (c) c.textContent = convTxt(); const k = $('#fChk'); if (k) k.innerHTML = amtChk();
}
function readExp() { const a = $('#fAmt'), t = $('#fTitle'), d = $('#fDate'); if (a) F.amount = a.value.replace(/[^\d.]/g, ''); if (t) F.title = t.value; if (d) F.date = d.value; document.querySelectorAll('[data-sh]').forEach(i => { if (i.dataset.sh in F.shares) F.shares[i.dataset.sh] = i.value.replace(/[^\d.]/g, ''); }); }
async function saveExp() {
  readExp(); const amt = +F.amount; const err = $('#ferr');
  if (!(amt > 0)) return err.textContent = '請輸入金額';
  if (!F.title.trim()) return err.textContent = '請輸入名稱';
  let shares = {};
  if (F.mode === 'treat') shares = { [F.payer]: 1 };
  else {
    for (const [u, s] of Object.entries(F.shares)) shares[u] = F.mode === 'equal' ? 1 : (+s || 0);
    shares = Object.fromEntries(Object.entries(shares).filter(([, v]) => v > 0));
    if (!Object.keys(shares).length) return err.textContent = '至少要有一個人分';
    if (F.mode === 'amount') { const s = Object.values(shares).reduce((a, b) => a + b, 0); if (Math.abs(s - amt) > .5) return err.textContent = '指定金額加起來要等於這筆的金額'; }
  }
  const data = { date: F.date, title: F.title.trim(), icon: F.icon, amount: amt, cur: F.cur, payer: F.payer, mode: F.mode, shares, by: F.by || me.uid, at: F.id ? (cur.expenses.find(x => x.id === F.id) || {}).at || Date.now() : Date.now() };
  bg(F.id ? api.set(cur.id, 'expenses', F.id, data) : api.add(cur.id, 'expenses', data)); closeSheet(); toast(navigator.onLine === false ? '已存在手機，連上網路後自動同步' : '已存檔');
}
// 寫入不等伺服器回應（離線時會一直等），失敗才跳提示
function bg(p) { Promise.resolve(p).catch(e => { toast(errMsg(e)); console.error(e); }); }
function closeSheet() { $('#dim').hidden = true; F = null; RF = null; }

/* 結算 */
function pSettle() {
  const c = calc(), L = memberList();
  let h = head('結算');
  h += `<div class="rate"><span>匯率　1 台幣 ＝ <input id="rate" inputmode="decimal" value="${esc(c.rate)}"> 日圓</span><button class="lnk" data-act="rate">更新</button></div>`;
  h += `<div class="card"><div style="font-weight:800;margin-bottom:4px">${c.tr.length ? `還要轉帳 ${c.tr.length} 筆` : '目前兩清，不用轉帳 🎉'}</div><div class="small">已把互相欠的錢抵掉，算出最少的轉帳次數。付完按「已付」，會記成一筆轉帳。</div>
    ${c.tr.map(t => `<div class="tr">${ava(t.from)}<span class="arr">→</span>${ava(t.to)}<div class="v">${nt(t.amount)}<div class="small" style="font-weight:400">≈ ${yen(t.amount * c.rate)}</div></div><button class="sbtn" data-act="paid" data-f="${esc(t.from)}" data-t="${esc(t.to)}" data-a="${Math.round(t.amount)}">已付</button></div>`).join('')}</div>`;
  const S = (cur.settles || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  if (S.length) h += `<div class="day"><span>已付的轉帳</span></div><div class="card">${S.map(s => `<div class="tr">${ava(s.from)}<span class="arr">→</span>${ava(s.to)}<div class="v">${nt(s.amount)}</div><button class="small" data-act="unpaid" data-id="${esc(s.id)}">取消</button></div>`).join('')}</div>`;
  h += `<div class="day"><span>每個人</span></div><div class="card">${L.map(m => { const b = c.bal[m.uid] || 0; return `<div class="pc">${ava(m.uid)}<div><div class="n">${esc(m.name)}</div><div class="m">先付 ${nt(c.paid[m.uid] || 0)}・應分 ${nt(c.owe[m.uid] || 0)}</div></div><div class="bal ${b >= 0 ? 'posd' : 'negd'}">${Math.abs(b) < 1 ? '兩清' : (b > 0 ? '+' : '−') + Math.round(Math.abs(b)).toLocaleString()}</div></div>`; }).join('')}</div>`;
  h += `<div class="small" style="margin:6px 20px">「有人請客」的帳只算在請客的人身上。<button class="lnk" data-act="csv">匯出表格（CSV）</button></div>`;
  return h;
}
function csv() {
  const c = calc(); const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const rows = [['日期', '名稱', '金額', '幣別', '台幣', '誰付', '分法', '分攤']];
  for (const e of (cur.expenses || []).slice().sort((a, b) => a.date.localeCompare(b.date)))
    rows.push([e.date, e.title, e.amount, e.cur === 'TWD' ? '台幣' : '日圓', Math.round(c.toNT(+e.amount, e.cur)), mInfo(e.payer).name, { equal: '平均', ratio: '比例', amount: '指定金額', treat: '請客' }[e.mode], Object.entries(e.shares || {}).map(([u, s]) => mInfo(u).name + ':' + s).join(' ')]);
  rows.push([]); rows.push(['成員', '先付', '應分', '結餘']);
  memberList().forEach(m => rows.push([m.name, Math.round(c.paid[m.uid] || 0), Math.round(c.owe[m.uid] || 0), Math.round(c.bal[m.uid] || 0)]));
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = cur.trip.title + '-記帳.csv'; a.click();
}

/* 餐廳 */
let RTAB = 'pending', RF = null;
function parseG(txt) { // 從貼上的 Google 地圖連結讀店名與座標（和行程網站的口袋名單同一套規則）
  const o = {}; const u = (txt || '').match(/https?:\/\/\S+/); if (u) o.url = u[0].replace(/[)）\]」]+$/, '');
  const before = u ? txt.slice(0, u.index).trim() : (txt || '').trim(); if (before && !/^https?:/.test(before)) o.name = before.split(/\n/)[0].trim().replace(/^[「『]|[」』]$/g, '');
  if (o.url) { let m = /\/maps\/place\/([^/@?]+)/.exec(o.url); if (m && !o.name) { try { o.name = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) {} }
    m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(o.url) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(o.url) || /[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(o.url);
    if (m) o.ll = [+m[1], +m[2]]; }
  return o;
}
function pResto() {
  const R = cur.restos || [], own = isOwner();
  const cnt = s => R.filter(r => r.status === s).length;
  const tabsR = [['in', '正式名單'], ['pending', '待收錄'], ['no', '已婉拒']];
  let h = head('餐廳') + `<div class="seg">${tabsR.map(([k, t]) => `<button data-act="rtab" data-k="${k}" class="${RTAB === k ? 'on' : ''}">${t} ${cnt(k)}</button>`).join('')}</div>`;
  h += `<div class="small" style="margin:0 20px 8px">${own ? '家人推薦的店先放在「待收錄」，你按「收錄」才進正式名單。（測試版：正式名單之後再接到行程網站的餐廳頁）' : '你推薦的店會先進「待收錄」，等主辦人收錄。'}</div>`;
  const L = R.filter(r => r.status === RTAB).sort((a, b) => (a.day || '9').localeCompare(b.day || '9') || (b.at || 0) - (a.at || 0));
  if (!L.length) h += `<div class="empty">${RTAB === 'pending' ? '目前沒有待收錄的店。按「＋ 推薦一家」貼 Google 地圖連結。' : '這裡還沒有店。'}</div>`;
  for (const r of L) {
    const q = r.url || 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.name);
    const acts = own && r.status === 'pending' ? `<div class="acts"><button class="y" data-act="rin" data-id="${esc(r.id)}">收錄</button><button data-act="rno" data-id="${esc(r.id)}">婉拒</button></div>`
      : own && r.status === 'in' ? `<div class="acts"><button data-act="rin" data-id="${esc(r.id)}">改日期</button><button data-act="rback" data-id="${esc(r.id)}">移回待收錄</button></div>`
      : own ? `<div class="acts"><button data-act="rback" data-id="${esc(r.id)}">移回待收錄</button><button data-act="rdel" data-id="${esc(r.id)}">刪除</button></div>`
      : r.by === me.uid && r.status === 'pending' ? `<div class="acts"><button data-act="rdel" data-id="${esc(r.id)}">撤回推薦</button></div>` : '';
    h += `<div class="rs"><div class="ph" style="background:${mInfo(r.by).color}">${esc([...(r.name || '?')][0])}</div><div class="b"><div class="n">${esc(r.name)}</div>
      <div class="m">${esc(mInfo(r.by).name)} 推薦・${r.day ? fmtD(r.day) + '（' + wd(r.day) + '）' : '日期未定'}${r.meal ? ' ' + esc(r.meal) : ''}</div>${r.note ? `<div class="m">${esc(r.note)}</div>` : ''}<div class="m"><a href="${esc(q)}" target="_blank" rel="noopener">📍 Google 地圖</a></div>${acts}</div></div>`;
  }
  h += `<button class="fab" data-act="radd">＋ 推薦一家</button>`;
  return h;
}
function openResto() {
  RF = RF || { name: '', url: '', ll: null, day: '', meal: '', note: '' };
  const D = days(cur.trip);
  $('#sheet').innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">推薦一家</b><button class="small" data-act="close">取消</button></div>
  <div class="lab">Google 地圖連結</div><textarea class="inp" id="rLink" rows="2" placeholder="在 Google 地圖按「分享」→ 複製連結，貼在這裡"></textarea><div class="small" id="rHint" style="margin-top:4px"></div>
  <div class="lab">店名</div><input class="inp" id="rName" value="${esc(RF.name)}" placeholder="必填">
  <div class="row2"><div><div class="lab">哪一天</div><select class="inp" id="rDay"><option value="">未定</option>${D.map(d => `<option value="${d}" ${RF.day === d ? 'selected' : ''}>${fmtD(d)}（${wd(d)}）</option>`).join('')}</select></div>
  <div><div class="lab">哪一餐</div><select class="inp" id="rMeal"><option value="">未定</option>${MEALS.map(m => `<option ${RF.meal === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
  <div class="lab">為什麼推薦（選填）</div><input class="inp" id="rNote" value="${esc(RF.note)}" placeholder="例如：金目鯛煮付很有名、要排隊">
  <div class="err" id="rerr"></div><button class="btn" data-act="rsave">送出推薦</button>`;
  $('#dim').hidden = false;
  $('#rLink').addEventListener('input', e => { const o = parseG(e.target.value); RF.url = o.url || ''; RF.ll = o.ll || null; if (o.name && !$('#rName').value) $('#rName').value = o.name;
    $('#rHint').textContent = !o.url ? '' : o.ll ? '已讀到位置 ✓' : /goo\.gl|maps\.app/.test(o.url) ? '短網址讀不到位置，沒關係，店名填好就可以' : ''; });
}
function openPlace(id) {   // 主辦人收錄：確認排在哪天哪餐
  const r = (cur.restos || []).find(x => x.id === id); if (!r) return; const D = days(cur.trip);
  $('#sheet').innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">${r.status === 'in' ? '改日期' : '收錄'}：${esc(r.name)}</b><button class="small" data-act="close">取消</button></div>
  <div class="small" style="margin-top:6px">${esc(mInfo(r.by).name)} 推薦${r.note ? '：' + esc(r.note) : ''}</div>
  <div class="row2"><div><div class="lab">排進哪一天</div><select class="inp" id="pDay"><option value="">未定</option>${D.map(d => `<option value="${d}" ${r.day === d ? 'selected' : ''}>${fmtD(d)}（${wd(d)}）</option>`).join('')}</select></div>
  <div><div class="lab">哪一餐</div><select class="inp" id="pMeal"><option value="">未定</option>${MEALS.map(m => `<option ${r.meal === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
  <button class="btn" data-act="rinok" data-id="${esc(id)}">${r.status === 'in' ? '存檔' : '收錄進正式名單'}</button>`;
  $('#dim').hidden = false;
}
async function saveResto() {
  const name = $('#rName').value.trim(); if (!name) return $('#rerr').textContent = '請填店名';
  const data = { name, url: RF.url || '', ll: RF.ll || null, day: $('#rDay').value, meal: $('#rMeal').value, note: $('#rNote').value.trim(), by: me.uid, byName: me.name, status: 'pending', at: Date.now() };
  try { await api.add(cur.id, 'restos', data); closeSheet(); RTAB = 'pending'; render(); toast('已送出，等主辦人收錄'); } catch (e) { $('#rerr').textContent = errMsg(e); }
}

/* 成員 */
function pMem() {
  const L = memberList(), own = isOwner();
  let h = head('成員') + `<div class="card">${L.map(m => `<div class="mrow">${ava(m.uid)}<b>${esc(m.name)}${m.uid === me.uid ? '（我）' : ''}</b><span class="r">${m.role === 'owner' ? '主辦人' : '成員'}${own && m.email ? '<br>' + esc(m.email) : ''}</span>${own && m.uid !== me.uid ? `<button class="small" data-act="kick" data-u="${esc(m.uid)}" style="margin-left:6px">移除</button>` : ''}</div>`).join('')}</div>`;
  if (own) h += `<div class="card"><b>邀請連結</b><div class="small" style="margin-top:4px">傳到 LINE 群組，家人點開、用 Google 登入就會加入這趟。</div><div id="inv"><div class="small" style="margin-top:8px">讀取中…</div></div></div>`;
  else h += `<div class="card small">要邀請其他人，請主辦人 ${esc((L.find(m => m.role === 'owner') || {}).name || '')} 產生邀請連結。</div>`;
  h += `<div class="card small">登入帳號：${esc(me.name)}　<button class="lnk" data-act="logout">登出</button></div>`;
  if (own) setTimeout(drawInvite, 0);
  return h;
}
async function drawInvite() {
  const box = $('#inv'); if (!box) return;
  let inv = null; try { inv = await api.getInvite(cur.id); } catch (e) {}
  const live = inv && inv.expires > Date.now();
  const url = live ? location.origin + BASE + (MOCK ? '?mock=1' : '') + '#/join/' + encodeURIComponent(cur.id) + '/' + inv.key : '';
  box.innerHTML = live ? `<div class="link"><code>${esc(url)}</code><button class="lnk" data-act="copy" data-u="${esc(url)}">複製</button></div><div class="small" style="margin-top:8px">${new Date(inv.expires).toLocaleDateString('zh-TW')} 失效・<button class="lnk" data-act="newinv">重新產生（舊連結作廢）</button></div>`
    : `<div class="small" style="margin-top:8px">${inv ? '舊的邀請連結已過期。' : '還沒有邀請連結。'}</div><button class="btn" data-act="newinv">產生邀請連結（7 天有效）</button>`;
}

/* ───────── 動作 ───────── */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]'); if (!el) { if (ev.target.id === 'dim') closeSheet(); return; }
  const a = el.dataset.act;
  try {
    if (a === 'login') return await api.signIn();
    if (a === 'logout') { await api.signOut(); return go('#/'); }
    if (a === 'create') {
      const repo = el.dataset.repo, m = await tripMeta(repo); if (!m) return toast('讀不到這趟的 trip.json');
      const ex = await api.getTrip(repo).catch(e => 'deny');   // 別人建的、自己不是成員 → 讀不到

      if (ex) return toast('這趟已經有人建立了');
      await api.createTrip(repo, { title: m.title, start: m.start || '', end: m.end || '', color: m.color || '#c67139', cover: m.cover || '', owner: me.uid, rate: 4.8, createdAt: Date.now() });
      await api.set(repo, 'members', me.uid, { uid: me.uid, name: me.name, photo: me.photo, email: me.email, role: 'owner', joinedAt: Date.now() });
      await api.setUserTrip(me.uid, repo, { title: m.title, start: m.start || '', end: m.end || '', color: m.color || '', cover: m.cover || '', role: 'owner' });
      return go('#/t/' + encodeURIComponent(repo) + '/mem');
    }
    if (a === 'join') {
      const { id, key } = route; const err = $('#jerr');
      try { await api.set(id, 'members', me.uid, { uid: me.uid, name: me.name, photo: me.photo, email: me.email, role: 'member', key, joinedAt: Date.now() }); }
      catch (e) { const t = await api.getTrip(id).catch(() => null); if (!t) return err.textContent = errMsg(e); }   // 已經是成員就直接進去
      const t = await api.getTrip(id);
      await api.setUserTrip(me.uid, id, { title: t.title, start: t.start, end: t.end, color: t.color || '', cover: t.cover || '', role: t.owner === me.uid ? 'owner' : 'member' });
      return go('#/t/' + encodeURIComponent(id) + '/exp');
    }
    if (a === 'add') return openExp();
    if (a === 'edit') return openExp(el.dataset.id);
    if (a === 'close') return closeSheet();
    if (F) {
      readExp();
      if (a === 'cur') { F.cur = el.dataset.c; return drawExp(); }
      if (a === 'icon') { F.icon = el.dataset.i; return drawExp(); }
      if (a === 'payer') { F.payer = el.dataset.u; return drawExp(); }
      if (a === 'mode') { const m = el.dataset.m; if (m !== F.mode) { F.mode = m; const amt = +F.amount || 0, ks = Object.keys(F.shares).length ? Object.keys(F.shares) : memberList().map(x => x.uid); F.shares = Object.fromEntries(ks.map(u => [u, m === 'amount' ? Math.round(amt / ks.length) : 1])); } return drawExp(); }
      if (a === 'tog') { const u = el.dataset.u; if (u in F.shares) delete F.shares[u]; else F.shares[u] = F.mode === 'amount' ? 0 : 1; return drawExp(); }
      if (a === 'save') return await saveExp();
      if (a === 'del') { if (!confirm('確定刪除這筆？')) return; bg(api.remove(cur.id, 'expenses', F.id)); closeSheet(); return toast('已刪除'); }
    }
    if (a === 'rate') { const v = +$('#rate').value; if (!(v > 0)) return toast('匯率要大於 0'); await api.updateTrip(cur.id, { rate: v }); return toast('匯率已更新'); }
    if (a === 'paid') { bg(api.add(cur.id, 'settles', { from: el.dataset.f, to: el.dataset.t, amount: +el.dataset.a, at: Date.now(), by: me.uid })); return toast('已記成一筆轉帳'); }
    if (a === 'unpaid') { bg(api.remove(cur.id, 'settles', el.dataset.id)); return; }
    if (a === 'csv') return csv();
    if (a === 'rtab') { RTAB = el.dataset.k; return render(); }
    if (a === 'radd') { RF = null; return openResto(); }
    if (a === 'rsave') return await saveResto();
    if (a === 'rin') return openPlace(el.dataset.id);
    if (a === 'rinok') { const was = ((cur.restos || []).find(x => x.id === el.dataset.id) || {}).status; bg(api.update(cur.id, 'restos', el.dataset.id, { status: 'in', day: $('#pDay').value, meal: $('#pMeal').value, decidedAt: Date.now() })); closeSheet(); return toast(was === 'in' ? '已更新' : '已收錄'); }
    if (a === 'rno') { bg(api.update(cur.id, 'restos', el.dataset.id, { status: 'no', decidedAt: Date.now() })); return toast('已婉拒'); }
    if (a === 'rback') { await api.update(cur.id, 'restos', el.dataset.id, { status: 'pending' }); return; }
    if (a === 'rdel') { if (!confirm('確定刪除？')) return; await api.remove(cur.id, 'restos', el.dataset.id); return; }
    if (a === 'newinv') { await api.setInvite(cur.id, { key: rnd(20), expires: Date.now() + 7 * 864e5 }); return drawInvite(); }
    if (a === 'copy') { try { await navigator.clipboard.writeText(el.dataset.u); toast('已複製，貼到 LINE 群組'); } catch (e) { prompt('複製這個連結', el.dataset.u); } return; }
    if (a === 'kick') { if (!confirm('把這位成員移出這趟？（他記過的帳會保留）')) return; await api.remove(cur.id, 'members', el.dataset.u); return; }
  } catch (e) { toast(errMsg(e)); console.error(e); }
});

/* ───────── 啟動 ───────── */
me = undefined;
api.onAuth(u => { me = u; route = parse(); show(); });
