// 旅行記帳・餐廳（測試版）主程式
// 網址加 ?mock=1 走模擬模式（不連 Firebase）；正式走 fb.js。
const QS = new URLSearchParams(location.search);
const MOCK = QS.has('mock');
// ?embed=行程ID：嵌在行程網站裡（iframe）。不顯示測試橫條、分頁移到上方、鎖在這一趟（沒有「我的行程」）
const EMBED = QS.get('embed') || '';
if (EMBED) document.documentElement.classList.add('embed');
// &wide=1：電腦版行程網站用。分頁列交給行程網站畫（不顯示），內容拆成左右兩欄（cols()），表單改成置中彈窗
const WIDE = !!EMBED && QS.get('wide') === '1';
if (WIDE) document.documentElement.classList.add('wide');
// 兩欄：手機照原本順序上下排；wide 時 a 在左、b 在右（sw＝a 放右邊，例如記帳把總額放右）
const cols = (a, b, sw) => `<div class="cols${sw ? ' sw' : ''}"><div class="cA">${a}</div><div class="cB">${b}</div></div>`;
const HOME = EMBED ? '#/t/' + encodeURIComponent(EMBED) + '/exp' : '#/';
let api;
try { api = (await import(MOCK ? './mock.js' : './fb.js')).default; }
catch (e) {   // 連不到 Firebase（沒網路、被擋）：不要停在「載入中…」
  document.getElementById('app').innerHTML = `<div class="hero"><div style="font-size:40px">📡</div><h1 class="cap">連不上記帳伺服器</h1><p>請確認網路連線後重新整理。</p><button class="btn s" onclick="location.reload()">重新整理</button></div>`;
  throw e;
}

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
  if (h[0] === 't' && h[1]) return { page: h[2] || 'exp', id: decodeURIComponent(h[1]), add: h[3] === 'add' };   // …/resto/add：行程網站的「＋ 新增餐廳」直接開推薦表單
  if (h[0] === 'join' && h[1]) return { page: 'join', id: decodeURIComponent(h[1]), key: h[2] || '' };
  return { page: 'home' };
}
const go = h => { location.hash = h; };
window.addEventListener('hashchange', () => { route = parse(); show(); });

function closeTrip() { if (cur) (cur.unsub || []).forEach(f => { try { f(); } catch (e) {} }); cur = null; }
function openTrip(id) {
  if (cur && cur.id === id) return;
  closeTrip();
  cur = { id, trip: null, members: [], expenses: [], settles: [], restos: [], budget: [], unsub: [], err: null, loaded: false };
  const c = cur, fail = e => { if (c !== cur) return; c.err = e; render(); };
  c.unsub.push(api.watchTrip(id, t => { if (c !== cur) return; c.trip = t; c.loaded = true; render(); }, fail));
  for (const sub of ['members', 'expenses', 'settles', 'restos', 'budget'])
    c.unsub.push(api.watch(id, sub, rows => { if (c !== cur) return; c[sub] = rows; if (sub === 'budget') c.bErr = null; render(); },
      sub === 'budget' ? e => { if (c !== cur) return; c.bErr = e; render(); } : fail));   // 預算讀不到（規則還沒更新）只影響預算頁
}

/* ───────── 畫面 ───────── */
const app = () => $('#app');
const testBar = () => EMBED ? '' : `<div class="test">測試版${MOCK ? '（模擬資料）' : ''}・不影響正式行程網站</div>`;
// 嵌在行程網站時：推薦（餐廳頁裡）是一整頁、不顯示分頁列；行程網站的「記帳」分頁裡是 花費／記帳／結算／成員
function tabs(on) {
  if (EMBED && on === 'resto' || WIDE) return '';
  const T = EMBED ? [['budget', '📋', '花費'], ['exp', '🧾', '記帳'], ['settle', '⚖️', '結算'], ['mem', '👥', '成員']]
    : [['budget', '📋', '預算'], ['exp', '🧾', '記帳'], ['settle', '⚖️', '結算'], ['resto', '🍽', '餐廳'], ['mem', '👥', '成員']];
  return `<nav class="tabs">${T.map(([k, i, t]) => `<a href="#/t/${encodeURIComponent(cur.id)}/${k}" class="${k === on ? 'on' : ''}"><i>${i}</i>${t}</a>`).join('')}</nav>`;
}
function head(title) {
  const t = cur.trip;
  return `<div class="top"><div><div class="t">${EMBED ? '' : '<a href="#/" style="text-decoration:none">‹ 我的行程</a>　'}${esc(t.title)}　${t.start ? fmtD(t.start) + '–' + fmtD(t.end) : ''}</div><h1 class="cap">${title}</h1></div>${ava(me.uid, 32)}</div>`;
}

function show() {
  if (me === undefined) return;
  if (route.page === 'home' && EMBED) return go(HOME);
  if (route.page === 'home') { closeTrip(); return renderHome(); }
  if (route.page === 'join') { closeTrip(); return renderJoin(); }
  if (!me) { closeTrip(); return renderLogin('登入後才能看這趟的記帳與餐廳'); }
  openTrip(route.id); render();
}
function render() {
  if (!cur) return;
  if (cur.err) return app().innerHTML = testBar() + `<div class="hero"><div style="font-size:40px">🔒</div><h1 class="cap">進不去這趟</h1><p>${esc(errMsg(cur.err))}。<br>請向主辦人要一個新的邀請連結。</p>${EMBED ? '' : '<a class="btn s" href="#/">回我的行程</a>'}</div>`;
  if (!cur.loaded) return app().innerHTML = testBar() + '<div class="hero"><p>讀取中…</p></div>';
  if (!cur.trip) return app().innerHTML = testBar() + `<div class="hero"><h1 class="cap">找不到這趟</h1><p>可能還沒建立。</p>${EMBED ? '' : '<a class="btn s" href="#/">回我的行程</a>'}</div>`;
  const p = route.page;
  app().innerHTML = testBar() + ({ budget: pBudget, exp: pExp, settle: pSettle, resto: pResto, mem: pMem }[p] || pExp)() + tabs(p);
  if (route.add && p === 'resto') { route.add = false; history.replaceState(null, '', location.pathname + location.search + '#/t/' + encodeURIComponent(cur.id) + '/resto'); RF = null; openResto(); }
}

/* 登入：Google 不准在 LINE／FB／IG 內建瀏覽器登入，先提示改用 Safari／Chrome */
const INAPP = /\bLine\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(navigator.userAgent);
const inappTip = () => INAPP ? `<div class="card" style="text-align:left;background:#fde3cf;margin:14px 0 0"><b>請改用 Safari 或 Chrome 開啟</b><div class="small" style="color:var(--ink)">Google 不允許在 LINE 裡面登入。請按右上角「⋯」或右下角的指南針圖示，選「用預設瀏覽器開啟」，或複製網址貼到 Safari／Chrome。</div><button class="btn s" data-act="copy" data-u="${esc(location.href)}">複製這個網址</button></div>` : '';
function renderLogin(msg) {
  app().innerHTML = testBar() + `<div class="hero"><div style="font-size:44px">🧳</div><h1 class="cap">旅行記帳・餐廳</h1><p>${esc(msg || '和同行的人一起記帳、分帳、推薦餐廳。')}${EMBED ? '<br>只有這趟同行的人看得到。' : '<br>行程內容不用登入也能在行程網站看。'}</p>
  ${inappTip()}<button class="btn g" data-act="login">用 Google 帳號登入</button>${EMBED ? `<p class="small" style="margin-top:14px">按了沒反應？<a class="lnk" href="${esc(BASE + location.hash)}" target="_blank" rel="noopener">改在新視窗打開記帳</a></p>` : ''}</div>`;
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
  ${me ? `<button class="btn" data-act="join">以 ${esc(me.name)} 加入</button><button class="btn s" data-act="logout">換一個帳號</button>` : `${inappTip()}<button class="btn g" data-act="login">用 Google 帳號登入並加入</button>`}<div class="err" id="jerr"></div></div>`;
  if (me && !key) $('#jerr').textContent = '連結不完整，請向主辦人重新要一次。';
}

/* 記帳 */
function pExp() {
  const c = calc(); const L = memberList();
  const ex = (cur.expenses || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || 0) - (a.at || 0));
  const mine = c.bal[me.uid] || 0;
  let h = head('花費記帳'), top = '';
  top += `<div class="sum"><div style="display:flex;justify-content:space-between;gap:10px"><div><div class="k">這趟總花費（換算台幣）</div><div class="v">${nt(c.total)}</div></div><div style="text-align:right"><div class="k">我目前</div><div class="v ${mine >= 0 ? 'pos' : 'neg'}">${Math.abs(mine) < 1 ? '兩清' : (mine > 0 ? '應收 ' : '應付 ') + nt(Math.abs(mine))}</div></div></div>
    <div class="ppl">${L.map(m => { const b = c.bal[m.uid] || 0; return `<div class="pp">${ava(m.uid, 26)}<div><div class="n">${esc(m.name)}</div><div class="b ${b >= 0 ? 'pos' : 'neg'}">${Math.abs(b) < 1 ? '兩清' : (b > 0 ? '+' : '−') + Math.round(Math.abs(b)).toLocaleString()}</div></div></div>`; }).join('')}</div></div>`;
  if (WIDE) top += `<button class="btn wadd" data-act="add">＋ 記一筆</button>`;
  let lst = '';
  if (!ex.length) lst += `<div class="empty">還沒有任何一筆。<br>按${WIDE ? '右邊' : '右下角'}「＋ 記一筆」開始。</div>`;
  let last = '';
  for (const e of ex) {
    if (e.date !== last) { last = e.date; const dt = ex.filter(x => x.date === e.date).reduce((a, x) => a + c.toNT(+x.amount, x.cur), 0); lst += `<div class="day"><span>${fmtD(e.date)}（${wd(e.date)}）</span><span>${nt(dt)}</span></div>`; }
    const n = Object.keys(e.shares || {}).length;
    const tag = e.mode === 'treat' ? `${mInfo(e.payer).name}請客` : e.mode === 'ratio' ? '比例' : e.mode === 'amount' ? '指定金額' : '';
    lst += `<button class="it" data-act="edit" data-id="${esc(e.id)}"><div class="ic">${esc(e.icon || '🧾')}</div><div><div class="n">${esc(e.title)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</div><div class="m">${eDates(e).length > 1 ? `<span class="rg">${esc(dTxt(eDates(e), false))}</span>` : ''}${esc(mInfo(e.payer).name)} 付・${e.mode === 'treat' ? '不分攤' : n + ' 人分'}</div></div><div class="a">${money(+e.amount, e.cur)}${e.cur !== 'TWD' ? `<small>≈ ${nt(c.toNT(+e.amount, e.cur))}</small>` : ''}</div></button>`;
  }
  h += cols(top, lst, true);
  if (!WIDE) h += `<button class="fab" data-act="add">＋ 記一筆</button>`;
  return h;
}

/* 記一筆／修改 */
let F = null;
function openExp(id) {
  const L = memberList(); const D = days(cur.trip); const t = todayISO();
  const e = id && (cur.expenses || []).find(x => x.id === id);
  F = e ? { id, date: e.date, dates: eDates(e), title: e.title, icon: e.icon || '🧾', amount: String(e.amount), cur: e.cur, payer: e.payer, mode: e.mode, shares: { ...e.shares }, by: e.by }
    : { date: D.includes(t) ? t : (D[0] || t), dates: [D.includes(t) ? t : (D[0] || t)], title: '', icon: '🍽', amount: '', cur: 'JPY', payer: me.uid, mode: 'equal', shares: Object.fromEntries(L.map(m => [m.uid, 1])) };
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
  <div class="lab">日期<span class="small" style="font-weight:500;margin-left:6px">可以勾好幾天（機票去回、住宿每一晚）</span></div>
  <button class="inp dbtn" data-act="dcal"><span>${esc(dTxt(F.dates))}</span><small>${F.dates.length > 1 ? F.dates.length + ' 天' : ''}</small><i>📅</i></button>
  <div class="lab">誰先付的</div><div class="chips">${L.map(m => `<button class="chip ${F.payer === m.uid ? 'on' : ''}" data-act="payer" data-u="${esc(m.uid)}">${ava(m.uid)}${esc(m.name)}</button>`).join('')}</div>
  <div class="lab">怎麼分</div><div class="split">${[['equal', '平均'], ['ratio', '比例'], ['amount', '指定金額'], ['treat', '有人請客']].map(([k, t]) => `<button data-act="mode" data-m="${k}" class="${F.mode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
  <div style="margin-top:4px">${rows}</div>
  <div class="err" id="ferr"></div>
  ${can ? `<button class="btn" data-act="save">存檔</button>${F.id ? '<button class="btn s" data-act="del">刪除這筆</button>' : ''}` : '<div class="small" style="margin-top:12px">這筆是別人記的，只有記帳的人或主辦人能改。</div>'}`;
  $('#dim').hidden = false;
  $('#sheet').oninput = ev => { if (ev.target.id === 'fAmt' || ev.target.dataset.sh) liveExp(); };
}
// 日期（可複選）：expenses 存 dates（排序好的陣列）＋ date＝第一天（排序、每日小計、舊版相容）
function eDates(e) { if (Array.isArray(e.dates) && e.dates.length) return e.dates.slice().sort(); if (e.date2 && e.date2 > e.date) { const o = []; for (let d = e.date; d <= e.date2; d = dNext(d, 1)) o.push(d); return o; } return [e.date]; }
function dNext(d, n) { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); }
// 「2/11–2/13、2/17」：連續的日期合成一段
function dTxt(L, wdOn = true) { L = (L || []).slice().sort(); if (!L.length) return '選日期'; const seg = []; let a = L[0], b = L[0];
  for (const d of L.slice(1).concat([null])) { if (d && d === dNext(b, 1)) { b = d; continue; } seg.push(a === b ? fmtD(a) + (wdOn && L.length === 1 ? `（${wd(a)}）` : '') : `${fmtD(a)}–${fmtD(b)}`); if (d) a = b = d; }
  return seg.join('、'); }
let CAL = null;   // 月曆：{m:'YYYY-MM', sel:[...]}
function openCal() { CAL = { m: (F.dates[0] || todayISO()).slice(0, 7), sel: F.dates.slice() }; drawCal(); }
function drawCal() {
  let el = $('#calp'); if (!el) { el = document.createElement('div'); el.id = 'calp'; el.className = 'calp'; document.body.appendChild(el); }
  const [y, m] = CAL.m.split('-').map(Number), first = new Date(y, m - 1, 1, 12), nd = new Date(y, m, 0).getDate(), D = days(cur.trip), today = todayISO();
  let cells = ''; for (let i = 0; i < first.getDay(); i++) cells += '<span></span>';
  for (let d = 1; d <= nd; d++) { const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, on = CAL.sel.includes(iso);
    cells += `<button data-act="cald" data-d="${iso}" class="${on ? 'on' : ''}${D.includes(iso) ? ' trip' : ''}${iso === today ? ' td' : ''}">${d}${on ? '<i>✓</i>' : ''}</button>`; }
  el.innerHTML = `<div class="cal"><div class="calh"><button data-act="calm" data-d="-1" aria-label="上個月">‹</button><b>${y} 年 ${m} 月</b><button data-act="calm" data-d="1" aria-label="下個月">›</button></div>
    <div class="calw">${'日一二三四五六'.split('').map(x => `<span>${x}</span>`).join('')}</div><div class="calg">${cells}</div>
    <div class="calf"><span>${CAL.sel.length ? `已選 ${CAL.sel.length} 天：${esc(dTxt(CAL.sel, false))}` : '至少選一天'}</span>${D.length ? '<em>底色＝行程期間</em>' : ''}</div>
    <div class="calb"><button class="btn s" data-act="calx">取消</button><button class="btn" data-act="calok" ${CAL.sel.length ? '' : 'disabled'}>完成</button></div></div>`;
}
function closeCal() { CAL = null; const el = $('#calp'); if (el) el.remove(); }
function convTxt() { const r = calc().rate; return F.cur === 'JPY' ? '≈ ' + nt((+F.amount || 0) / r) + `（匯率 1：${r}，可在結算頁改）` : ''; }
function amtChk() { const s = Object.values(F.shares).reduce((a, b) => a + (+b || 0), 0), amt = +F.amount || 0; return `指定金額合計 ${money(s, F.cur)}／這筆 ${money(amt, F.cur)}${Math.abs(s - amt) > .5 ? '　<b style="color:var(--bad)">對不上</b>' : '　✓'}`; }
function liveExp() {
  readExp(); const amt = +F.amount || 0; const sum = Object.values(F.shares).reduce((a, b) => a + (+b || 0), 0) || 1;
  document.querySelectorAll('[data-ea]').forEach(b => { const u = b.dataset.ea; if (!(u in F.shares)) return; const s = +F.shares[u] || 0; b.textContent = money(F.mode === 'amount' ? s : amt * (F.mode === 'equal' ? 1 : s) / (F.mode === 'equal' ? Object.keys(F.shares).length || 1 : sum), F.cur); });
  const c = $('#fConv'); if (c) c.textContent = convTxt(); const k = $('#fChk'); if (k) k.innerHTML = amtChk();
}
function readExp() { const a = $('#fAmt'), t = $('#fTitle'); if (a) F.amount = a.value.replace(/[^\d.]/g, ''); if (t) F.title = t.value; F.dates = (F.dates || [F.date]).slice().sort(); F.date = F.dates[0]; document.querySelectorAll('[data-sh]').forEach(i => { if (i.dataset.sh in F.shares) F.shares[i.dataset.sh] = i.value.replace(/[^\d.]/g, ''); }); }
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
  const data = { date: F.dates[0], dates: F.dates, date2: null, title: F.title.trim(), icon: F.icon, amount: amt, cur: F.cur, payer: F.payer, mode: F.mode, shares, by: F.by || me.uid, at: F.id ? (cur.expenses.find(x => x.id === F.id) || {}).at || Date.now() : Date.now() };
  bg(F.id ? api.set(cur.id, 'expenses', F.id, data) : api.add(cur.id, 'expenses', data)); closeSheet(); toast(navigator.onLine === false ? '已存在手機，連上網路後自動同步' : '已存檔');
}
// 寫入不等伺服器回應（離線時會一直等），失敗才跳提示
function bg(p) { Promise.resolve(p).catch(e => { toast(errMsg(e)); console.error(e); }); }
(function sheetSwipe() {
  const sh = document.getElementById('sheet'); if (!sh) return; let y0 = null, dy = 0, on = false;
  sh.addEventListener('touchstart', e => { if (sh.scrollTop > 0 || e.touches.length > 1) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; on = false; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0;
    if (!on && (dy < 6 || sh.scrollTop > 0)) { if (dy < 0) y0 = null; return; }
    on = true; e.preventDefault(); sh.classList.add('dragging'); sh.style.transform = `translateY(${Math.max(0, dy * .9)}px)`; }, { passive: false });
  sh.addEventListener('touchend', () => { if (y0 == null) return; y0 = null; sh.classList.remove('dragging'); if (!on) return;
    if (dy > 100) { sh.style.transform = 'translateY(110%)'; setTimeout(() => { closeSheet(); sh.style.transform = ''; }, 200); } else sh.style.transform = ''; on = false; });
})();
function closeSheet() { closeCal(); $('#dim').hidden = true; F = null; RF = null; if (B) B.f = null; }

/* 結算 */
function pSettle() {
  const c = calc(), L = memberList();
  let h = head('結算'), A = '', B = '';
  A += `<div class="rate"><span>匯率　1 台幣 ＝ <input id="rate" inputmode="decimal" value="${esc(c.rate)}"> 日圓</span><button class="lnk" data-act="rate">更新</button></div>`;
  A += `<div class="card"><div style="font-weight:800;margin-bottom:4px">${c.tr.length ? `還要轉帳 ${c.tr.length} 筆` : '目前兩清，不用轉帳 🎉'}</div><div class="small">已把互相欠的錢抵掉，算出最少的轉帳次數。付完按「已付」，會記成一筆轉帳。</div>
    ${c.tr.map(t => `<div class="tr">${ava(t.from)}<span class="arr">→</span>${ava(t.to)}<div class="v">${nt(t.amount)}<div class="small" style="font-weight:400">≈ ${yen(t.amount * c.rate)}</div></div><button class="sbtn" data-act="paid" data-f="${esc(t.from)}" data-t="${esc(t.to)}" data-a="${Math.round(t.amount)}">已付</button></div>`).join('')}</div>`;
  const S = (cur.settles || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  if (S.length) A += `<div class="day"><span>已付的轉帳</span></div><div class="card">${S.map(s => `<div class="tr">${ava(s.from)}<span class="arr">→</span>${ava(s.to)}<div class="v">${nt(s.amount)}</div><button class="small" data-act="unpaid" data-id="${esc(s.id)}">取消</button></div>`).join('')}</div>`;
  B += `<div class="day"><span>每個人</span></div><div class="card">${L.map(m => { const b = c.bal[m.uid] || 0; return `<div class="pc">${ava(m.uid)}<div><div class="n">${esc(m.name)}</div><div class="m">先付 ${nt(c.paid[m.uid] || 0)}・應分 ${nt(c.owe[m.uid] || 0)}</div></div><div class="bal ${b >= 0 ? 'posd' : 'negd'}">${Math.abs(b) < 1 ? '兩清' : (b > 0 ? '+' : '−') + Math.round(Math.abs(b)).toLocaleString()}</div></div>`; }).join('')}</div>`;
  B += `<div class="small" style="margin:6px 20px">「有人請客」的帳只算在請客的人身上。<button class="lnk" data-act="csv">匯出表格（CSV）</button></div>`;
  return h + cols(A, B);
}
function csv() {
  const c = calc(); const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const rows = [['日期', '名稱', '金額', '幣別', '台幣', '誰付', '分法', '分攤']];
  for (const e of (cur.expenses || []).slice().sort((a, b) => a.date.localeCompare(b.date)))
    rows.push([eDates(e).join(' '), e.title, e.amount, e.cur === 'TWD' ? '台幣' : '日圓', Math.round(c.toNT(+e.amount, e.cur)), mInfo(e.payer).name, { equal: '平均', ratio: '比例', amount: '指定金額', treat: '請客' }[e.mode], Object.entries(e.shares || {}).map(([u, s]) => mInfo(u).name + ':' + s).join(' ')]);
  rows.push([]); rows.push(['成員', '先付', '應分', '結餘']);
  memberList().forEach(m => rows.push([m.name, Math.round(c.paid[m.uid] || 0), Math.round(c.owe[m.uid] || 0), Math.round(c.bal[m.uid] || 0)]));
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = cur.trip.title + '-記帳.csv'; a.click();
}

/* 預算（出發前的預估花費）：只有成員看得到，只有主辦人能改。
   每項 {g 分組, name, note, amt(null＝未知), cur 'NT'|'JPY', mode, rooms, approx, opt(選項不計入), order}
   mode：total 總價÷人數、pp 每人單價×人數、room 每間×間數÷人數。人數＝trip.ppl（主辦人設定，預設 4）。 */
const BG = ['機票', '住宿', '交通', '門票・體驗', '餐飲', '其他', '選項'];
const BMODE = { total: '總價 ÷ 人數', pp: '每人單價 × 人數', room: '每間 × 間數 ÷ 人數' };
let B = null;
const pplOf = () => Math.max(1, +(cur.trip && cur.trip.ppl) || 4);
function bPer(it) { const v = it.amt; if (v == null || v === '') return null; const n = pplOf(); return it.mode === 'pp' ? +v : it.mode === 'room' ? v * (+it.rooms || 1) / n : v / n; }
function bAll(it) { const v = it.amt; if (v == null || v === '') return null; const n = pplOf(); return it.mode === 'pp' ? v * n : it.mode === 'room' ? v * (+it.rooms || 1) : +v; }
const bMoney = (v, c) => v == null ? '' : money(v, c === 'NT' ? 'TWD' : 'JPY');
// 晚數：有填 nights 用 nights；住宿組沒填時從說明裡的「N 晚」讀（舊資料也能顯示每人每晚）
function bNights(it) { if (+it.nights > 0) return +it.nights; if (it.g !== '住宿') return 0; const m = /(\d+)\s*晚/.exec(it.note || ''); if (m) return +m[1];
  const r = /(\d{1,2})\/(\d{1,2})\s*[–\-～~]\s*(?:\d{1,2}\/)?(\d{1,2})/.exec(it.name || ''); if (r && +r[3] >= +r[2]) return +r[3] - +r[2] + 1; // 名稱「2/15–16」＝住 15、16 兩晚
  return /^\s*\d{1,2}\/\d{1,2}(?!\s*[–\-～~])/.test(it.name || '') ? 1 : 0; }
function bNightTxt(it) { const p = bPer(it), n = bNights(it); return p != null && n > 0 && +it.amt !== 0 ? `每人每晚 ${bMoney(p / n, it.cur)}` : ''; }
function bHow(it) { const n = pplOf(); return it.mode === 'pp' ? `每人價 × ${n} 人` : it.mode === 'room' ? `每間 × ${+it.rooms || 1} 間 ÷ ${n} 人` : `總價 ÷ ${n} 人`; }
function bSum(list) { const per = { NT: 0, JPY: 0 }, all = { NT: 0, JPY: 0 }; let u = 0; for (const it of list) { const p = bPer(it); if (p == null) { u++; continue; } per[it.cur] += p; all[it.cur] += bAll(it); } return { per, all, u }; }
function bTxt(o) { const t = []; if (o.NT) t.push(nt(o.NT)); if (o.JPY) t.push(yen(o.JPY)); return t.join(' ＋ ') || '—'; }
const BICO = { 機票: '✈️', 住宿: '🛏', 交通: '🚆', '門票・體驗': '🎟', 餐飲: '🍜', 其他: '📦', 選項: '✨' };
const BCOL = ['#2b4c7e', '#c67139', '#56633f', '#b2622d', '#8a3f5c', '#7a8a5e', '#3f6fa8'];
const BOPEN = {};   // 明細展開的分組（只存在這次開啟）；wide（電腦版）預設全部展開，所以存的是「收起來」
const bOpen = g => WIDE ? !BOPEN[g] : !!BOPEN[g];
// 每人每晚長條：住宿項目依名稱的起始日期攤成一晚一根；讀不到日期的排在後面
function bNightBars(L, rate) {
  const toNT = (v, c) => c === 'NT' ? v : v / rate, bars = [], hotels = [];
  for (const it of L.filter(x => x.g === '住宿' && !x.opt)) {
    const n = bNights(it), p = bPer(it); if (!n || p == null || +it.amt === 0) continue;
    const lab = (it.name || '').replace(/^[\s\d/–\-～~（）()一二三四五六日・]+/, '').replace(/（.*?）|\(.*?\)/g, '').trim() || it.name;
    if (!hotels.includes(lab)) hotels.push(lab);
    const d = /(\d{1,2})\/(\d{1,2})/.exec(it.name || '');
    for (let i = 0; i < n; i++) bars.push({ m: d ? +d[1] : 99, dd: d ? +d[2] + i : 99, v: toNT(p / n, it.cur), lab, ord: it.order || 0 });
  }
  bars.sort((x, y) => x.m - y.m || x.dd - y.dd || x.ord - y.ord);
  return { bars, hotels };
}
function pBudget() {
  const own = isOwner(), L = (cur.budget || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)), n = pplOf(), rate = +cur.trip.rate || 4.8;
  let h = head('花費預算');
  if (cur.bErr) return h + `<div class="empty">預算還讀不到。<br>${own ? '請到 Firebase 主控台把最新的 firestore.rules 貼上並發布（多了「預算」的權限）。' : '主辦人還在設定，晚點再來看。'}</div>`;
  const rateH = `<div class="rate"><span>同行人數</span>${own ? `<span class="ppl"><button data-act="ppl" data-d="-1">−</button><b>${n} 人</b><button data-act="ppl" data-d="1">＋</button></span>` : `<b>${n} 人</b>`}</div>`;
  if (!WIDE) h += rateH;
  if (!L.length) return h + (WIDE ? rateH : '') + (own ? `<div class="empty">還沒有預算項目。<br><button class="btn" data-act="bimport" id="bimp" hidden>匯入行程網站原本的預估</button><button class="btn s" data-act="badd">＋ 自己新增一項</button></div>` : `<div class="empty">主辦人還沒填預算。</div>`) + (own ? (setTimeout(bSeedCheck, 0), '') : '');
  const toNT = o => o.NT + o.JPY / rate, S = bSum(L.filter(x => !x.opt));
  let A = WIDE ? rateH : '', B = '';
  A += `<div class="sum bsum"><div class="k">每人大約要準備</div><div class="v">${nt(toNT(S.per))}</div>
    <div class="k" style="margin-top:3px">全體 ${n} 人 約 ${nt(toNT(S.all))}${S.u ? `・另有 ${S.u} 項金額未知` : ''}</div></div>`;
  const groups = BG.concat([...new Set(L.map(x => x.g))].filter(g => !BG.includes(g))).filter(g => L.some(x => x.g === g));
  // 各類每人花費長條（台幣）
  const gs = groups.filter(g => g !== '選項').map((g, i) => ({ g, v: toNT(bSum(L.filter(x => x.g === g && !x.opt)).per), c: BCOL[i % BCOL.length] }));
  const mx = Math.max(1, ...gs.map(x => x.v));
  A += `<div class="bbars">${gs.map(x => `<div class="bb"><b>${esc(x.g)}</b><div class="t"><i style="width:${Math.max(x.v ? 3 : 0, x.v / mx * 100).toFixed(1)}%;background:${x.c}"></i></div><span>${x.v ? Math.round(x.v).toLocaleString('en-US') : '—'}</span></div>`).join('')}
    <div class="bbn">每人・台幣（日圓 ÷ ${rate}）・選項不計入</div></div>`;
  // 每人每晚住宿
  const NB = bNightBars(L, rate);
  if (NB.bars.length) {
    const nmx = Math.max(...NB.bars.map(x => x.v)), avg = NB.bars.reduce((a, x) => a + x.v, 0) / NB.bars.length, col = l => BCOL[NB.hotels.indexOf(l) % BCOL.length];
    const top = NB.bars.reduce((a, x) => x.v > a.v ? x : a, NB.bars[0]);
    A += `<div class="bnight"><b>每人每晚住宿</b><p>${NB.bars.length} 晚・平均 ${nt(avg)}／晚${NB.hotels.length > 1 ? `・最貴：${esc(top.lab)}` : ''}</p>
      <div class="nc" style="grid-template-columns:repeat(${NB.bars.length},1fr)">${NB.bars.map(x => `<div><em>${Math.round(x.v).toLocaleString('en-US')}</em><i style="height:${Math.max(4, x.v / nmx * 92).toFixed(0)}px;background:${col(x.lab)}"></i><small>${x.m < 99 ? x.m + '/' + x.dd : ''}</small></div>`).join('')}</div>
      <div class="lg">${NB.hotels.map(l => `<span><i style="background:${col(l)}"></i>${esc(l)}</span>`).join('')}</div></div>`;
  }
  if (WIDE && own) B += `<div class="whd"><b>明細</b><span>點分類展開・點項目可修改</span><button class="lnk" data-act="badd">＋ 新增項目</button></div>`;
  // 明細：每類一張卡，點開才列項目
  for (const g of groups) {
    const G = L.filter(x => x.g === g), opt = g === '選項', s2 = bSum(G), on = bOpen(g);
    const sub = [`${G.length} 項`]; if (s2.u) sub.push(`${s2.u} 項未知`); if (opt) sub.push('去了才算・不計入');
    if (g === '住宿' && NB.bars.length) sub.push(`共 ${NB.bars.length} 晚`);
    const yenTxt = s2.per.JPY ? `<small>${s2.per.NT ? nt(s2.per.NT) + ' ＋ ' : ''}${yen(s2.per.JPY)}</small>` : '';
    B += `<div class="bcard${opt ? ' opt' : ''}${on ? ' on' : ''}"><button class="bch" data-act="btog" data-g="${esc(g)}"><i>${BICO[g] || '•'}</i><div><b>${esc(g)}</b><small>${sub.join('・')}</small></div><div class="r">${toNT(s2.per) ? nt(toNT(s2.per)) : '—'}${yenTxt}</div><span class="ar">${on ? '⌄' : '›'}</span></button>`;
    if (on) for (const it of G) {
      const unk = it.amt == null || it.amt === '', free = +it.amt === 0 && !unk, ap = it.approx ? '約 ' : '', ni = bNights(it), nTxt = bNightTxt(it);
      const meta = [ni && g === '住宿' ? `${ni} 晚` : '', esc(it.note), unk || free ? '' : bHow(it)].filter(Boolean).join('・');
      const right = unk ? '<span class="unk">未知</span>' : free ? '<b>免費</b>' : `<b>${ap}${bMoney(bPer(it), it.cur)}</b><small>全體 ${bMoney(bAll(it), it.cur)}</small>`;
      B += `<${own ? 'button' : 'div'} class="bit"${own ? ` data-act="bedit" data-id="${esc(it.id)}"` : ''}><div><b>${esc(it.name)}</b>${meta ? `<span>${meta}</span>` : ''}${nTxt ? `<em>${nTxt}</em>` : ''}</div><div class="r">${right}</div></${own ? 'button' : 'div'}>`;
    }
    B += `</div>`;
  }
  B += `<div class="small" style="margin:8px 20px">${own ? '點分類展開明細，點任一項可以修改金額與計算方式。' : '點分類展開明細；只有主辦人能修改預算。'}這頁是出發前的預估；實際花了多少請到「記帳」。</div>`;
  h += cols(A, B);
  if (own && !WIDE) h += `<button class="fab" data-act="badd">＋ 新增項目</button>`;
  return h;
}
async function bSeedCheck() { const b = $('#bimp'); if (!b) return; try { const r = await fetch('seeds/' + encodeURIComponent(cur.id) + '.json', { cache: 'no-cache' }); if (!r.ok) return; const d = await r.json(); B = { seed: d }; b.hidden = false; b.textContent = `匯入行程網站原本的預估（${d.items.length} 項）`; } catch (e) {} }
function openBudget(id) {
  const it = id && (cur.budget || []).find(x => x.id === id);
  B = Object.assign(B || {}, { f: it ? { ...it } : { g: '交通', name: '', note: '', amt: null, cur: 'JPY', mode: 'pp', rooms: 1, approx: false, opt: false, order: ((cur.budget || []).reduce((m, x) => Math.max(m, x.order || 0), 0)) + 10 } });
  drawBudget();
}
function drawBudget() {
  const f = B.f, groups = BG.concat([...new Set((cur.budget || []).map(x => x.g))].filter(g => !BG.includes(g)));
  const n = pplOf(), prev = { ...f, amt: f.amt === '' ? null : f.amt };
  $('#sheet').innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">${f.id ? '修改預算項目' : '新增預算項目'}</b><button class="small" data-act="close">取消</button></div>
  <div class="lab">分組</div><select class="inp" id="bG">${groups.map(g => `<option ${g === f.g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
  <div class="lab">名稱</div><input class="inp" id="bN" value="${esc(f.name)}" placeholder="例如：2/13–14 LiVEMAX 熱海">
  <div class="lab">說明（選填）</div><input class="inp" id="bNote" value="${esc(f.note)}" placeholder="例如：4 人一間">
  <div class="lab">住幾晚（住宿才填，用來算每人每晚）</div><input class="inp" id="bNi" inputmode="numeric" placeholder="不是住宿就留空" value="${f.nights ? esc(f.nights) : (f.g === '住宿' && bNights(f) ? bNights(f) : '')}">
  <div class="lab">金額</div><div class="amt"><input id="bA" inputmode="decimal" placeholder="不知道就留空" value="${f.amt == null ? '' : esc(f.amt)}"><div class="cur"><button data-act="bcur" data-c="JPY" class="${f.cur === 'JPY' ? 'on' : ''}">日圓</button><button data-act="bcur" data-c="NT" class="${f.cur === 'NT' ? 'on' : ''}">台幣</button></div></div>
  <div class="lab">計算方式</div><div class="split" style="grid-template-columns:repeat(3,1fr)">${Object.entries(BMODE).map(([k, t]) => `<button data-act="bmode" data-m="${k}" class="${f.mode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
  ${f.mode === 'room' ? `<div class="lab">間數</div><input class="inp" id="bR" inputmode="numeric" value="${esc(f.rooms || 1)}">` : ''}
  <div class="small" style="margin-top:8px" id="bPrev">${bPrevTxt(prev, n)}</div>
  <label class="ck"><input type="checkbox" id="bAp" ${f.approx ? 'checked' : ''}> 金額是估的（顯示「約」）</label>
  <label class="ck"><input type="checkbox" id="bOpt" ${f.opt ? 'checked' : ''}> 選項，去了才算（不計入合計）</label>
  <div class="err" id="berr"></div><button class="btn" data-act="bsave">存檔</button>${f.id ? '<button class="btn s" data-act="bdel">刪除這項</button>' : ''}`;
  $('#dim').hidden = false;
  $('#sheet').oninput = () => { readBudget(); const p = $('#bPrev'); if (p) p.innerHTML = bPrevTxt(B.f, pplOf()); };
}
function bPrevTxt(f, n) { const pp = bPer(f), aa = bAll(f), ni = bNightTxt(f); if (pp == null) return `同行 ${n} 人・金額留空會顯示「未知」`; if (ni) return `同行 ${n} 人 → 每人 <b>${bMoney(pp, f.cur)}</b>・全體 <b>${bMoney(aa, f.cur)}</b>・<b>${ni}</b>`; return `同行 ${n} 人 → 每人 <b>${bMoney(pp, f.cur)}</b>・全體 <b>${bMoney(aa, f.cur)}</b>`; }
function readBudget() { const f = B.f, v = id => { const e = $(id); return e ? e.value : null; };
  if ($('#bG')) f.g = v('#bG'); if ($('#bN')) f.name = v('#bN'); if ($('#bNote')) f.note = v('#bNote');
  if ($('#bA')) { const a = v('#bA').replace(/[^\d.]/g, ''); f.amt = a === '' ? null : +a; }
  if ($('#bR')) f.rooms = Math.max(1, +v('#bR').replace(/\D/g, '') || 1);
  if ($('#bNi')) { const x = v('#bNi').replace(/\D/g, ''); f.nights = x ? +x : 0; }
  if ($('#bAp')) f.approx = $('#bAp').checked; if ($('#bOpt')) f.opt = $('#bOpt').checked; }
function saveBudget() { readBudget(); const f = B.f; if (!f.name.trim()) return $('#berr').textContent = '請填名稱';
  const data = { g: f.g, name: f.name.trim(), note: (f.note || '').trim(), nights: +f.nights || 0, amt: f.amt, cur: f.cur, mode: f.mode, rooms: f.mode === 'room' ? (+f.rooms || 1) : 1, approx: !!f.approx, opt: !!f.opt, order: f.order || 0, by: me.uid, at: Date.now() };
  bg(f.id ? api.set(cur.id, 'budget', f.id, data) : api.add(cur.id, 'budget', data)); closeSheet(); toast('已存檔'); }

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
  let h = head(EMBED ? '家人推薦・收錄' : '餐廳') + `<div class="seg">${tabsR.map(([k, t]) => `<button data-act="rtab" data-k="${k}" class="${RTAB === k ? 'on' : ''}">${t} ${cnt(k)}</button>`).join('')}</div>`;
  h += `<div class="small" style="margin:0 20px 8px">${own ? '家人推薦的店先放在「待收錄」，你按「收錄」才進正式名單，並出現在行程網站的「餐廳」頁。' : '你推薦的店會先進「待收錄」，等主辦人收錄。'}</div>`;
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
  <div><div class="lab">哪一餐</div><select class="inp" id="pMeal">${MEALS.map(m => `<option ${(r.meal || '晚餐') === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
  <div class="small" style="margin-top:8px">收錄後會出現在行程網站的「餐廳」頁，標「家人推薦」。</div>
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
  let h = head('成員'), A = `<div class="card">${L.map(m => `<div class="mrow">${ava(m.uid)}<b>${esc(m.name)}${m.uid === me.uid ? '（我）' : ''}</b><span class="r">${m.role === 'owner' ? '主辦人' : '成員'}${own && m.email ? '<br>' + esc(m.email) : ''}</span>${own && m.uid !== me.uid ? `<button class="small" data-act="kick" data-u="${esc(m.uid)}" style="margin-left:6px">移除</button>` : ''}</div>`).join('')}</div>`;
  let B = '';
  if (own) B += `<div class="card"><b>邀請連結</b><div class="small" style="margin-top:4px">傳到 LINE 群組，家人點開、用 Google 登入就會加入這趟。</div><div id="inv"><div class="small" style="margin-top:8px">讀取中…</div></div></div>`;
  else B += `<div class="card small">要邀請其他人，請主辦人 ${esc((L.find(m => m.role === 'owner') || {}).name || '')} 產生邀請連結。</div>`;
  B += `<div class="card small">登入帳號：${esc(me.name)}　<button class="lnk" data-act="logout">登出</button></div>`;
  if (own) setTimeout(drawInvite, 0);
  return h + cols(A, B);
}
async function drawInvite() {
  const box = $('#inv'); if (!box) return;
  let inv = null; try { inv = await api.getInvite(cur.id); } catch (e) {}
  const live = inv && inv.expires > Date.now();
  const url = live ? location.origin + BASE + (MOCK ? '?mock=1&' : '?') + 'openExternalBrowser=1#/join/' + encodeURIComponent(cur.id) + '/' + inv.key : '';
  box.innerHTML = live ? `<div class="link"><code>${esc(url)}</code><button class="lnk" data-act="copy" data-u="${esc(url)}">複製</button></div><div class="small" style="margin-top:8px">${new Date(inv.expires).toLocaleDateString('zh-TW')} 失效・<button class="lnk" data-act="newinv">重新產生（舊連結作廢）</button></div>`
    : `<div class="small" style="margin-top:8px">${inv ? '舊的邀請連結已過期。' : '還沒有邀請連結。'}</div><button class="btn" data-act="newinv">產生邀請連結（7 天有效）</button>`;
}

/* ───────── 動作 ───────── */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]'); if (!el) { if (ev.target.id === 'calp') closeCal(); else if (ev.target.id === 'dim') closeSheet(); return; }
  const a = el.dataset.act;
  try {
    if (a === 'login') { try { return await api.signIn(); } catch (e) { if (e && e.code === 'auth/popup-closed-by-user') return; return toast(e && e.code === 'auth/popup-blocked' ? '登入視窗被瀏覽器擋住了，請允許彈出視窗後再按一次' : e && e.code === 'auth/unauthorized-domain' ? '這個網址還沒加進 Firebase 已授權的網域' : '登入失敗：' + (e && (e.code || e.message))); } }
    if (a === 'logout') { await api.signOut(); return go(HOME); }
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
      if (a === 'dcal') return openCal();
      if (CAL && a === 'cald') { const d = el.dataset.d, i = CAL.sel.indexOf(d); if (i >= 0) CAL.sel.splice(i, 1); else CAL.sel.push(d); CAL.sel.sort(); return drawCal(); }
      if (CAL && a === 'calm') { const [y, m] = CAL.m.split('-').map(Number), t = new Date(y, m - 1 + (+el.dataset.d), 1, 12); CAL.m = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); return drawCal(); }
      if (CAL && a === 'calok') { if (!CAL.sel.length) return; F.dates = CAL.sel.slice(); F.date = F.dates[0]; closeCal(); return drawExp(); }
      if (a === 'calx') { closeCal(); return; }
      if (a === 'payer') { F.payer = el.dataset.u; return drawExp(); }
      if (a === 'mode') { const m = el.dataset.m; if (m !== F.mode) { F.mode = m; const amt = +F.amount || 0, ks = Object.keys(F.shares).length ? Object.keys(F.shares) : memberList().map(x => x.uid); F.shares = Object.fromEntries(ks.map(u => [u, m === 'amount' ? Math.round(amt / ks.length) : 1])); } return drawExp(); }
      if (a === 'tog') { const u = el.dataset.u; if (u in F.shares) delete F.shares[u]; else F.shares[u] = F.mode === 'amount' ? 0 : 1; return drawExp(); }
      if (a === 'save') return await saveExp();
      if (a === 'del') { if (!confirm('確定刪除這筆？')) return; bg(api.remove(cur.id, 'expenses', F.id)); closeSheet(); return toast('已刪除'); }
    }
    if (a === 'ppl') { const v = Math.max(1, Math.min(20, pplOf() + (+el.dataset.d))); bg(api.updateTrip(cur.id, { ppl: v })); return; }
    if (a === 'badd') return openBudget();
    if (a === 'bedit') return openBudget(el.dataset.id);
    if (a === 'btog') { const g = el.dataset.g; BOPEN[g] = !BOPEN[g]; return render(); }
    if (B && B.f && ['bcur', 'bmode', 'bsave', 'bdel'].includes(a)) {
      readBudget();
      if (a === 'bcur') { B.f.cur = el.dataset.c; return drawBudget(); }
      if (a === 'bmode') { B.f.mode = el.dataset.m; return drawBudget(); }
      if (a === 'bsave') return saveBudget();
      if (a === 'bdel') { if (!confirm('確定刪除這項？')) return; bg(api.remove(cur.id, 'budget', B.f.id)); closeSheet(); return toast('已刪除'); }
    }
    if (a === 'bimport') { const d = B && B.seed; if (!d) return; el.disabled = true; el.textContent = '匯入中…';
      if (d.ppl && !cur.trip.ppl) await api.updateTrip(cur.id, { ppl: d.ppl });
      for (const it of d.items) await api.add(cur.id, 'budget', { ...it, by: me.uid, at: Date.now() });
      return toast(`已匯入 ${d.items.length} 項`); }
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
