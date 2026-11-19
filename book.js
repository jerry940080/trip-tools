// 回憶錄私人媒體（2026-11-19）：給「書本版」回憶錄用的私人照片、影片與私人文字。
// 照片影片先用本機壓縮工具（tools/media-pack）壓好，這裡選工具的「輸出」資料夾 → 切成 512 KiB 分塊上傳到
//   trips/{id}/media/{mid}（索引：哪一頁、順序、說明、焦點…）＋ trips/{id}/media/{mid}/chunks/{t|p|f0…}（二進位）
// 私人文字放 trips/{id}/notes/{auto}。規則：成員讀得到、只有主辦人能寫。
// 頁的清單讀行程網站的 /<repo>/book-pages.json；對頁草稿讀資料夾裡的 draft.json（Claude 依時間、GPS、檔名編號排的）。
export const BOOK_TRIPS = ['2025-osaka-kanazawa-miokokoen-nagano-tokyo'];
const CH = (+new URLSearchParams(location.search).get('bkchunk')) || 512 * 1024;   // ?bkchunk=… 只給測試用（模擬模式的 localStorage 很小）
const QUOTA = 1024 * 1024 * 1024;          // Firestore 免費額度 1 GiB（整個專案共用）
let X;                                     // 主程式給的工具：api, cur(), me(), esc, toast, render, head, tabs, isOwner()
const BK = { pages: null, pErr: null, imp: null, up: null, urls: new Map(), full: new Map(), pend: new Set() };

export function bookInit(ctx) { X = ctx; document.addEventListener('click', onClick); document.addEventListener('change', onChange); }
export const isBookTrip = id => BOOK_TRIPS.includes(id);

/* ───────── 小工具 ───────── */
const e = s => X.esc(s);
const MB = b => (b / 1048576).toFixed(1) + ' MB';
const sizeOf = m => (m.bytes || 0) + (m.tb || 0) + (m.pb || 0);
const fNames = m => Array.from({ length: m.nf || 0 }, (_, i) => 'f' + i);
const allNames = m => [...fNames(m), 't', ...(m.kind === 'video' ? ['p'] : [])];
const pageOf = k => (BK.pages || []).find(p => p.k === k);
const pageLabel = k => { const p = pageOf(k); return p ? `${p.d ? 'Day ' + p.d + '・' : ''}${p.t}` : (k ? k + '（書裡找不到這頁）' : '還沒放到頁面'); };
const media = () => (X.cur().media || []).filter(m => m.ready);
const sortM = L => L.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.ts || '').localeCompare(String(b.ts || '')) || (a.num || 0) - (b.num || 0));
const fmtDur = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

async function loadPages() {
  if (BK.pages || BK.pErr) return;
  try { const r = await fetch('/' + X.cur().id + '/book-pages.json', { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); BK.pages = (await r.json()).pages || []; }
  catch (err) { BK.pErr = err; }
  X.render();
}
// 把分塊讀回來組成 Blob（縮圖一塊；本體依 nf 塊數平行讀，最多 4 塊同時）
async function blobOf(m, which) {
  const id = X.cur().id;
  if (which === 't') return new Blob([await X.api.getChunk(id, m.id, 't')], { type: 'image/webp' });
  if (which === 'p') return new Blob([await X.api.getChunk(id, m.id, 'p')], { type: 'image/jpeg' });
  const names = fNames(m), parts = new Array(names.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => { while (i < names.length) { const k = i++; parts[k] = await X.api.getChunk(id, m.id, names[k]); } }));
  return new Blob(parts, { type: m.mime || (m.kind === 'video' ? 'video/mp4' : 'image/webp') });
}
function thumbURL(m) { const k = m.id + '@' + (m.tb || 0); return BK.urls.get(k); }
// 縮圖依序載入（同時最多 6 張），載好就直接換掉畫面上的 <img>
let tq = [], trun = 0;
function wantThumb(m) { const k = m.id + '@' + (m.tb || 0); if (BK.urls.has(k) || BK.pend.has(k)) return; BK.pend.add(k); tq.push([m, k]); pumpThumb(); }
function pumpThumb() {
  while (trun < 6 && tq.length) {
    const [m, k] = tq.shift(); trun++;
    blobOf(m, 't').then(b => { const u = URL.createObjectURL(b); BK.urls.set(k, u); document.querySelectorAll(`img[data-th="${CSS.escape(m.id)}"]`).forEach(i => i.src = u); })
      .catch(() => {}).finally(() => { BK.pend.delete(k); trun--; pumpThumb(); });
  }
}
// 看大圖、播影片用的完整檔案：只留最近 3 個在記憶體
async function fullURL(m) {
  const k = m.id + '@' + m.bytes; if (BK.full.has(k)) return BK.full.get(k);
  const u = URL.createObjectURL(await blobOf(m, 'f')); BK.full.set(k, u);
  while (BK.full.size > 3) { const [k0, u0] = BK.full.entries().next().value; URL.revokeObjectURL(u0); BK.full.delete(k0); }
  return u;
}

/* ───────── 畫面 ───────── */
export function pBook() {
  const c = X.cur(), own = X.isOwner();
  loadPages();
  let h = X.head('回憶錄');
  if (c.mErr) return h + `<div class="card small"><b style="color:var(--bad)">讀不到私人媒體</b><div>${/permission/i.test(c.mErr.code || c.mErr.message || '') ? 'Firebase 的規則還沒有 media／notes。請主辦人把最新的 firestore.rules 貼到 Firebase 主控台並發布。' : e(c.mErr.message || c.mErr.code)}</div></div>`;
  if (BK.pErr) return h + `<div class="empty">讀不到這趟的 book-pages.json（書本版的頁面清單）。</div>`;
  if (!BK.pages) return h + `<div class="empty">讀取中…</div>`;
  loadBM();
  if (!BK.mode) BK.mode = 'layout';
  h += `<div class="seg"><button data-bk="mode" data-m="layout" class="${BK.mode === 'layout' ? 'on' : ''}">📐 排版</button><button data-bk="mode" data-m="pages" class="${BK.mode === 'pages' ? 'on' : ''}">📄 頁面</button><button data-bk="mode" data-m="files" class="${BK.mode === 'files' ? 'on' : ''}">🗂 檔案與匯入</button></div>`;
  if (BK.mode === 'pages') {
    if (BK.bmErr) return h + `<div class="empty">讀不到 book-media.json。</div>`;
    if (!BK.bm) return h + `<div class="empty">讀取中…</div>`;
    return h + pagesView(own) + `<div style="height:90px"></div>`;
  }
  if (BK.mode === 'layout') {
    if (BK.bmErr) return h + `<div class="empty">讀不到 book-media.json（排版用的頁面清單）。</div>`;
    if (!BK.bm) return h + `<div class="empty">讀取中…</div>`;
    return h + layoutView() + `<div style="height:90px"></div>`;
  }
  const L = media(), tot = L.reduce((s, m) => s + sizeOf(m), 0);
  const nP = L.filter(m => m.kind === 'photo').length, nV = L.length - nP;
  h += `<div class="card bkuse"><div><b>私人照片 ${nP} 張・影片 ${nV} 支</b><span>${MB(tot)}</span></div><i><u style="width:${Math.min(100, tot / QUOTA * 100).toFixed(1)}%"></u></i><div class="small">只有這趟的成員登入後看得到。免費額度 1 GiB（和記帳、其他行程共用），用到 600–700 MB 時要重新評估。</div></div>`;
  if (own) h += importCard();
  h += notesCard(own);
  if (L.length) h += `<div class="bktools">${own ? `<button class="btn s" data-bk="selmode">${BK.sel ? '✕ 結束選取' : '☑ 選取多張，一起移到某頁'}</button>` : ''}<button class="btn s" data-bk="copylist">📋 複製清單給 Claude</button><div class="small">清單只有文字（編號、在哪一頁、順序、直／橫、你寫的說明），沒有照片。</div></div>`;
  // 依書的頁序分組
  const by = new Map(); L.forEach(m => { const k = pageOf(m.page) ? m.page : ''; if (!by.has(k)) by.set(k, []); by.get(k).push(m); });
  const order = [...BK.pages.map(p => p.k).filter(k => by.has(k)), ...(by.has('') ? [''] : [])];
  if (!L.length) h += `<div class="empty">${own ? '還沒有私人照片影片。先用壓縮工具壓好，再按上面的「選擇資料夾」。' : '主辦人還沒放私人照片影片。'}</div>`;
  for (const k of order) {
    const G = sortM(by.get(k)), p = pageOf(k);
    h += `<div class="day"><span>${e(pageLabel(k))}${p && p.sp ? '　<i class="bksp">特殊頁</i>' : ''}${BK.sel ? `　<button class="lnk" data-bk="selall" data-k="${e(k)}">全選這頁</button>` : ''}</span><span>${G.filter(m => m.kind === 'photo').length} 張${G.some(m => m.kind === 'video') ? '・' + G.filter(m => m.kind === 'video').length + ' 支' : ''}</span></div><div class="bkgrid">`;
    for (const m of G) { wantThumb(m); const u = thumbURL(m);
      h += `<button class="bkt${m.h > m.w ? ' tall' : ''}${BK.sel && BK.sel.has(m.id) ? ' on' : ''}" data-bk="${BK.sel ? 'pick' : 'open'}" data-id="${e(m.id)}" title="${e(m.id)}"><img data-th="${e(m.id)}" ${u ? `src="${u}"` : ''} alt="">${m.kind === 'video' ? `<b>▶ ${fmtDur(m.dur)}</b>` : ''}${m.note ? '<em>✎</em>' : ''}${m.focus ? '<s>◎</s>' : ''}</button>`; }
    h += `</div>`;
  }
  if (BK.sel) h += `<div class="bksel"><b>已選 ${BK.sel.size} 項</b>${pageSelect('bkMoveTo', '')}<button class="btn" data-bk="move" ${BK.sel.size ? '' : 'disabled'}>移過去</button></div>`;
  return h + `<div style="height:${BK.sel ? 170 : 90}px"></div>`;
}

function importCard() {
  const I = BK.imp, U = BK.up;
  let h = `<div class="card"><b>匯入壓縮好的照片影片</b><div class="small" style="margin-top:4px">選壓縮工具的「輸出」資料夾（裡面有 manifest.json）。已經上傳過的會略過，中斷了再選一次就會接著傳。</div>
    <label class="btn s bkpick">📁 選擇資料夾<input type="file" id="bkDir" webkitdirectory directory multiple hidden></label>`;
  if (I && I.err) h += `<div class="small" style="color:var(--bad);margin-top:8px">${e(I.err)}</div>`;
  if (I && I.items) {
    const nw = I.items.filter(x => x.st !== 'same'), bytes = nw.reduce((s, x) => s + x.size, 0);
    const miss = I.items.filter(x => x.st === 'miss').length;
    h += `<div class="bksum"><div>資料夾裡 <b>${I.items.length}</b> 項：要上傳 <b>${nw.length - miss}</b> 項（${MB(bytes)}）・已經上傳過 ${I.items.length - nw.length} 項${miss ? `・<b style="color:var(--bad)">${miss} 項缺檔</b>` : ''}</div>
      <div class="small">${I.draft ? `對頁草稿：${I.draftN} 項有預設的頁（draft.json）` : '沒有 draft.json：新的項目會先放在「還沒放到頁面」'}</div></div>`;
    if (U && U.run) h += `<div class="bkprog"><i><u style="width:${(U.done / Math.max(1, U.total) * 100).toFixed(1)}%"></u></i><div class="small">上傳中 ${U.n}/${U.N}：${e(U.now || '')}（${MB(U.done)} / ${MB(U.total)}）</div><button class="btn s" data-bk="stop">暫停</button></div>`;
    else if (nw.length - miss > 0) h += `<button class="btn" data-bk="upload">開始上傳 ${nw.length - miss} 項</button>`;
    else h += `<div class="small" style="margin-top:8px">✓ 這個資料夾的都已經上傳了。</div>`;
    if (U && U.msg) h += `<div class="small" style="margin-top:6px">${e(U.msg)}</div>`;
  }
  return h + `</div>`;
}

function notesCard(own) {
  const N = (X.cur().notes || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!own && !N.length) return '';
  let h = `<div class="card"><b>🔒 私人文字</b><div class="small" style="margin-top:4px">只有成員看得到的段落（例如不想公開的經驗）。公開的書裡完全不會出現，連「這裡有私人內容」都不顯示。</div>`;
  h += N.map(n => `<button class="bknote" data-bk="note" data-id="${e(n.id)}"><small>${e(pageLabel(n.page))}</small><b>${e(n.title || '（沒有標題）')}</b><span>${e((n.text || '').slice(0, 60))}${(n.text || '').length > 60 ? '…' : ''}</span></button>`).join('');
  if (own) h += `<button class="btn s" data-bk="note" data-id="">＋ 新增一段私人文字</button>`;
  return h + `</div>`;
}

const pageSelect = (id, val) => `<select class="inp" id="${id}"><option value="">還沒放到頁面</option>${[...new Set(BK.pages.map(p => p.d || 0))].map(d => `<optgroup label="${d ? 'Day ' + d : '開頭與結尾'}">${BK.pages.filter(p => (p.d || 0) === d).map(p => `<option value="${e(p.k)}"${p.k === val ? ' selected' : ''}>${e(p.t)}${p.sp ? '（特殊頁）' : ''}</option>`).join('')}</optgroup>`).join('')}</select>`;

/* 一項的編輯：看大圖／播影片、換頁、順序、說明、主角焦點、刪除 */
let ED = null;
async function openItem(id) {
  const m = media().find(x => x.id === id); if (!m) return;
  ED = { id, focus: m.focus || null };
  const own = X.isOwner(), sh = document.getElementById('sheet');
  const sib = sortM(media().filter(x => (pageOf(x.page) ? x.page : '') === (pageOf(m.page) ? m.page : ''))), i = sib.findIndex(x => x.id === id);
  sh.innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">${e(m.id)}<span class="small">　${m.kind === 'video' ? '影片 ' + fmtDur(m.dur) + (m.audio ? '' : '・無聲') : '照片'}・${m.w}×${m.h}・${MB(sizeOf(m))}</span></b><button class="small" data-act="close">關閉</button></div>
    <div class="bkview" id="bkView"><div class="small">讀取中…</div></div>
    ${own ? `${m.kind === 'photo' ? '<div class="small" id="bkFocusTip">點照片上「主角」的位置，書裡裁切時會以那一點為中心。沒點就完整顯示、不裁切。</div>' : ''}
    <div class="lab">放在哪一頁</div>${pageSelect('bkPage', pageOf(m.page) ? m.page : '')}
    <div class="lab"><span>在這一頁的順序</span><span>${i + 1} / ${sib.length}</span></div><div class="acts"><button data-bk="mv" data-d="-1" ${i <= 0 ? 'disabled' : ''}>↑ 往前</button><button data-bk="mv" data-d="1" ${i >= sib.length - 1 ? 'disabled' : ''}>↓ 往後</button></div>
    <div class="lab">說明（書裡照片下面的字，可以不寫）</div><textarea class="inp" id="bkNote" rows="2" placeholder="例如：朋友第一次滑雪">${e(m.note || '')}</textarea>
    <button class="btn" data-bk="save">存檔</button><button class="btn s" data-bk="del" style="color:var(--bad)">刪除這${m.kind === 'video' ? '支' : '張'}</button>`
    : `<div class="small" style="margin-top:8px">${e(pageLabel(m.page))}${m.note ? '・' + e(m.note) : ''}</div>`}`;
  document.getElementById('dim').hidden = false;
  try {
    const u = await fullURL(m); if (!ED || ED.id !== id) return;
    const v = document.getElementById('bkView');
    v.innerHTML = m.kind === 'video' ? `<video src="${u}" controls playsinline preload="metadata"></video>` : `<div class="bkfp"><img src="${u}" alt="" id="bkImg">${ED.focus ? `<i style="left:${ED.focus.x}%;top:${ED.focus.y}%"></i>` : ''}</div>${own ? `<button class="lnk" data-bk="nofocus" ${ED.focus ? '' : 'hidden'} id="bkNoF">清除焦點</button>` : ''}`;
  } catch (err) { const v = document.getElementById('bkView'); if (v) v.innerHTML = `<div class="small" style="color:var(--bad)">讀不到這${m.kind === 'video' ? '支影片' : '張照片'}：${e(err.message || err.code)}</div>`; }
}
function drawFocus() {
  const box = document.querySelector('.bkfp'); if (!box) return;
  box.querySelectorAll('i').forEach(i => i.remove());
  if (ED.focus) { const i = document.createElement('i'); i.style.left = ED.focus.x + '%'; i.style.top = ED.focus.y + '%'; box.appendChild(i); }
  const b = document.getElementById('bkNoF'); if (b) b.hidden = !ED.focus;
}

/* 私人文字 */
let NE = null;
function openNote(id) {
  const n = id ? (X.cur().notes || []).find(x => x.id === id) : null, own = X.isOwner();
  NE = { id: id || '' };
  const sh = document.getElementById('sheet');
  sh.innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">🔒 私人文字</b><button class="small" data-act="close">關閉</button></div>
  ${own ? `<div class="lab">放在哪一頁之後</div>${pageSelect('nPage', n ? n.page : '')}
  <div class="lab">標題</div><input class="inp" id="nTitle" value="${e(n ? n.title : '')}">
  <div class="lab">內容</div><textarea class="inp" id="nText" rows="9">${e(n ? n.text : '')}</textarea>
  <button class="btn" data-bk="nsave">存檔</button>${n ? '<button class="btn s" data-bk="ndel" style="color:var(--bad)">刪除這段</button>' : ''}`
  : `<div class="small">${e(pageLabel(n.page))}</div><h3>${e(n.title)}</h3><div style="white-space:pre-wrap;line-height:1.8">${e(n.text)}</div>`}`;
  document.getElementById('dim').hidden = false;
}

/* ───────── 匯入 ───────── */
async function readFolder(files) {
  BK.imp = { items: null }; BK.up = null;
  const F = new Map(); for (const f of files) { const r = (f.webkitRelativePath || f.name).split('/'); r.shift(); F.set(r.join('/'), f); }   // 去掉最上層資料夾名稱
  const man = F.get('manifest.json');
  if (!man) { BK.imp = { err: '這個資料夾裡沒有 manifest.json。請選壓縮工具的「輸出」資料夾。' }; return X.render(); }
  let M, D = null;
  try { M = JSON.parse((await man.text()).replace(/^﻿/, '')); } catch (err) { BK.imp = { err: 'manifest.json 讀不懂：' + err.message }; return X.render(); }
  const dr = F.get('draft.json');
  if (dr) try { const j = JSON.parse((await dr.text()).replace(/^﻿/, '')); D = new Map((j.items || j).map(x => [x.id, x])); } catch (err) {}
  const have = new Map((X.cur().media || []).map(m => [m.id, m]));
  const items = (M.items || []).map(m => {
    const f = F.get(m.file), t = F.get(m.thumb), p = m.poster ? F.get(m.poster) : null;
    const ex = have.get(mid(m.id));
    const st = !f || !t || (m.kind === 'video' && !p) ? 'miss' : ex && ex.ready && ex.bytes === f.size && ex.tb === t.size ? 'same' : ex ? 'changed' : 'new';
    return { m, f, t, p, st, size: (f ? f.size : 0) + (t ? t.size : 0) + (p ? p.size : 0), d: D && D.get(m.id) };
  });
  BK.imp = { items, draft: !!D, draftN: items.filter(x => x.d && x.d.pg).length };
  X.render();
}
const mid = s => String(s).replace(/[\/\s]/g, '_');
async function upload() {
  const I = BK.imp; if (!I || !I.items || (BK.up && BK.up.run)) return;
  const id = X.cur().id, me = X.me();
  const todo = I.items.filter(x => x.st === 'new' || x.st === 'changed');
  const U = BK.up = { run: true, stop: false, n: 0, N: todo.length, done: 0, total: todo.reduce((s, x) => s + x.size, 0), now: '', msg: '' };
  // 同一頁裡的順序：草稿的時間 ts（影片是估的），沒有就用拍攝時間
  const ord = new Map(); I.items.slice().sort((a, b) => String((a.d && a.d.ts) || a.m.taken || '').localeCompare(String((b.d && b.d.ts) || b.m.taken || '')) || (a.m.num || 0) - (b.m.num || 0)).forEach((x, i) => ord.set(x.m.id, (i + 1) * 10));
  X.render();
  let ok = 0, fail = [];
  for (const x of todo) {
    if (U.stop) break;
    U.n++; U.now = x.m.id; X.render();
    const key = mid(x.m.id), old = (X.cur().media || []).find(m => m.id === key);
    try {
      const buf = new Uint8Array(await x.f.arrayBuffer()), nf = Math.max(1, Math.ceil(buf.length / CH));
      if (old) await X.api.update(id, 'media', key, { ready: false });   // 換檔時先標成未完成，書裡不會讀到一半的檔
      for (let i = 0; i < nf; i++) { if (U.stop) throw new Error('stopped'); await X.api.putChunk(id, key, 'f' + i, buf.subarray(i * CH, (i + 1) * CH)); U.done += Math.min(CH, buf.length - i * CH); X.render(); }
      await X.api.putChunk(id, key, 't', new Uint8Array(await x.t.arrayBuffer())); U.done += x.t.size;
      if (x.p) { await X.api.putChunk(id, key, 'p', new Uint8Array(await x.p.arrayBuffer())); U.done += x.p.size; }
      if (old && (old.nf || 0) > nf) await X.api.delChunks(id, key, Array.from({ length: old.nf - nf }, (_, i) => 'f' + (nf + i)));
      const m = x.m, base = { kind: m.kind, mime: m.kind === 'video' ? 'video/mp4' : 'image/webp', w: m.w, h: m.h, dur: m.dur || 0, audio: !!m.audio, num: m.num || 0, src: m.src || '',
        taken: m.taken || '', takenReliable: !!m.takenReliable, ts: (x.d && x.d.ts) || m.taken || '', bytes: x.f.size, nf, tb: x.t.size, pb: x.p ? x.p.size : 0, ready: true, by: me.uid, at: Date.now() };
      // 已經有的：保留使用者調過的頁、順序、說明、焦點
      await X.api.set(id, 'media', key, old ? clean({ ...old, ...base }) : { ...base, page: (x.d && x.d.pg) || '', order: ord.get(m.id) || 0, note: '', focus: null });
      x.st = 'same'; ok++;
    } catch (err) { if (err.message === 'stopped') break; fail.push(x.m.id + '：' + (err.code || err.message)); }
  }
  U.run = false; U.msg = `${U.stop ? '已暫停。' : ''}這次上傳了 ${ok} 項${fail.length ? `，${fail.length} 項失敗（${fail.slice(0, 3).join('；')}${fail.length > 3 ? '…' : ''}）` : ''}。`;
  X.render();
}
const clean = o => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'id') r[k] = v; return r; };

/* ───────── 事件 ───────── */
async function onChange(ev) {
  if (ev.target.classList.contains('mtt')) { const k = ev.target.dataset.k, v = ev.target.value.trim(), T = { ...((bpDoc('_meta') || {}).titles || {}) }; if (v) T[k] = v; else delete T[k];
    try { await mtSave({ titles: T }); X.toast(v ? '標題已改' : '已改回原本的標題'); } catch (err) { X.toast('存檔失敗：' + (err.code || err.message)); } return; }
  if (ev.target.classList.contains('tpn')) { const TP = tapesOf(), i = +ev.target.dataset.i; if (!TP[i]) return; TP[i].t = ev.target.value.trim(); try { await spSave('cass', { tapes: TP }); X.toast('卡帶名稱已存'); } catch (err) { X.toast('存檔失敗：' + (err.code || err.message)); } return; }
  if (ev.target.id === 'bkDir') { const fs = [...ev.target.files]; ev.target.value = ''; if (fs.length) await readFolder(fs); }
}
async function onClick(ev) {
  const img = ev.target.closest('#bkImg');
  if (img && ED && X.isOwner()) { const r = img.getBoundingClientRect(); ED.focus = { x: Math.round((ev.clientX - r.left) / r.width * 100), y: Math.round((ev.clientY - r.top) / r.height * 100) }; return drawFocus(); }
  const lt = ev.target.closest('.lst .lt'); if (lt && !BK.drag && X.isOwner()) { if (BK.lsel) { const i = lt.dataset.id; BK.lsel.has(i) ? BK.lsel.delete(i) : BK.lsel.add(i); return lselPaint(); } return openTile(lt.dataset.id); }   // 排版模式點縮圖：小選單
  const el = ev.target.closest('[data-bk]'); if (!el) return;
  const a = el.dataset.bk, c = X.cur(), id = c && c.id;
  try {
    if (a === 'open') return openItem(el.dataset.id);
    if (a === 'mode') { BK.mode = el.dataset.m; return X.render(); }
    if (a === 'tmv') return tileMove(el.dataset.id, '', +el.dataset.d);
    if (a === 'tto') { const to = document.getElementById('tmTo').value; if (!to) return X.toast('先選一頁'); return tileMove(el.dataset.id, to, 'to'); }
    if (a === 'tpool') return tileMove(el.dataset.id, '', 'pool');
    if (a === 'ttrash') { if (el.dataset.id.startsWith('pv:') && !confirm('確定刪除這項私人照片影片？刪掉後要重新上傳才會回來。')) return; return tileMove(el.dataset.id, '', 'trash'); }
    if (a === 'laypick') return openLayPick(el.dataset.k);
    if (a === 'mthide') { const k = el.dataset.k, H = new Set((bpDoc('_meta') || {}).hidden || []); const on = !H.has(k); on ? H.add(k) : H.delete(k); await mtSave({ hidden: [...H] }); X.render(); return X.toast(on ? '這頁在書上隱藏了' : '這頁放回書裡了'); }
    if (a === 'mtshowall') { await mtSave({ hidden: [] }); X.render(); return X.toast('全部頁都放回書裡了'); }
    if (a === 'cpadd') return cpForm({ after: el.dataset.after, guess: (BK.bm.pages || []).slice(-1)[0]?.k });
    if (a === 'lselmode') { BK.lsel = BK.lsel ? null : new Set(); return X.render(); }
    if (a === 'lselpool') { if (!BK.lsel) BK.lsel = new Set(); document.querySelectorAll('.lst[data-pool] .lt').forEach(t => BK.lsel.add(t.dataset.id)); return X.render(); }
    if (a === 'cside') { ev.stopPropagation(); BK.cside = BK.cside === 'l' ? 'r' : 'l'; try { localStorage.setItem('tt-cside', BK.cside); } catch (err) {} return X.render(); }
    if (a === 'ctog') { if (matchMedia('(min-width:900px)').matches) return; BK.copen = !BK.copen; return X.render(); }
    if (a === 'cf') { BK.cf = el.dataset.v; BK.cscroll = 0; return X.render(); }
    if (a === 'cday') { BK.cday = +el.dataset.v; BK.cscroll = 0; return X.render(); }
    if (a === 'cgrp') { const g = el.dataset.g; BK.cclosed.has(g) ? BK.cclosed.delete(g) : BK.cclosed.add(g); return X.render(); }
    if (a === 'lselgo') {
      const to = document.getElementById('lselTo').value, ids = [...BK.lsel]; if (!ids.length) return X.toast('還沒勾任何一張');
      if (!to) return X.toast('先選要移到哪裡');
      if (to === '__new') { const w = whereIs(ids[0]); return cpForm({ after: '', sel: ids.length, guess: w.pool || w.trash ? (BK.bm.pages || []).slice(-1)[0]?.k : w.k }); }
      el.disabled = true; el.textContent = '移動中…';
      try { const r = await batchMove(ids, to); if (!r) return X.render(); BK.lsel = new Set(); X.render(); return X.toast(`移了 ${r.n} 項` + (r.skip ? `（${r.skip} 項類型不合，沒有移）` : '')); }
      catch (err) { X.render(); return X.toast('存檔失敗：' + (err.code || err.message)); }
    }
    if (a === 'cpedit') return cpForm({ k: el.dataset.k });
    if (a === 'cpsave') {
      const t = document.getElementById('cpT').value.trim(); if (!t) return X.toast('先寫標題');
      const v = { t, pl: document.getElementById('cpPl').value.trim(), d: document.getElementById('cpD').value, x: document.getElementById('cpX').value.trim() };
      const L = cpList().map(x => ({ ...x }));
      if (el.dataset.k) { const c = L.find(x => x.k === el.dataset.k); if (c) Object.assign(c, v); }
      let nk = '';
      if (!el.dataset.k) { const af = el.dataset.after || (document.getElementById('cpA') || {}).value || ''; if (!af) return X.toast('先選放在哪一頁後面'); nk = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); L.push({ k: nk, after: af, ...v }); }
      await cpSaveAll(L); document.getElementById('dim').hidden = true;
      if (nk && el.dataset.sel && BK.lsel && BK.lsel.size) { cpMerge(); BK.pages0 = BK.pages0; const ids = [...BK.lsel];
        (BK.bm.pages || []).some(p => p.k === nk) || BK.bm.pages.push({ k: nk, t: v.t, d: +v.d || null, def: [], custom: 1 });
        const r = await batchMove(ids, nk); BK.lsel = new Set(); X.render(); return X.toast(`新增了「${v.t}」，放進 ${r ? r.n : 0} 項`); }
      X.render(); return X.toast(el.dataset.k ? '已存檔' : '加好了，把照片影片拖進這頁');
    }
    if (a === 'cpdel') {
      const k = el.dataset.k, ids = pageIds(k); if (!confirm(`刪除這一頁？${ids.length ? `裡面的 ${ids.length} 項會回到「不放進書裡」。` : ''}`)) return;
      const L = cpList(), me0 = L.find(x => x.k === k), L2 = L.filter(x => x.k !== k).map(x => x.after === k ? { ...x, after: me0 ? me0.after : x.after } : x);
      for (const m of media().filter(m => m.page === k)) await X.api.update(id, 'media', m.id, { page: '' });
      await cpSaveAll(L2); if (bpDoc(k)) await X.api.remove(id, 'bookpages', k);
      document.getElementById('dim').hidden = true; X.render(); return X.toast('已刪除這一頁');
    }
    if (a === 'sreset') { const k = el.dataset.k, d = bpDoc(k) || {}, sl = { ...(d.slots || {}) }; delete sl[el.dataset.s]; await spSave(k, { slots: sl }); X.render(); return X.toast('已還原成原本的內容'); }
    if (a === 'tadd') { const TP = tapesOf(); TP.push({ t: '新的卡帶 ' + (TP.length + 1), items: [] }); await spSave('cass', { tapes: TP }); X.render(); return X.toast('加了一捲，把照片或影片拖進去'); }
    if (a === 'tdel') { const TP = tapesOf(), i = +el.dataset.i; if (TP[i].items.length && !confirm(`刪除卡帶「${TP[i].t}」？裡面的 ${TP[i].items.length} 項會回到「不放進書裡」。`)) return; TP.splice(i, 1); await spSave('cass', { tapes: TP }); X.render(); return X.toast('已刪除這捲'); }
    if (a === 'tup') { const TP = tapesOf(), i = +el.dataset.i; if (i < 1) return; [TP[i - 1], TP[i]] = [TP[i], TP[i - 1]]; await spSave('cass', { tapes: TP }); return X.render(); }
    if (a === 'laysel') { const k = el.dataset.k, ids = pageIds(k); await X.api.set(id, 'bookpages', k, { layout: el.dataset.l, items: ids, by: X.me().uid, at: Date.now() }); document.getElementById('dim').hidden = true; X.render(); return X.toast('版型已換'); }
    if (a === 'selmode') { BK.sel = BK.sel ? null : new Set(); return X.render(); }
    if (a === 'pick') { BK.sel.has(el.dataset.id) ? BK.sel.delete(el.dataset.id) : BK.sel.add(el.dataset.id); return X.render(); }
    if (a === 'selall') { const k = el.dataset.k, ids = media().filter(m => (pageOf(m.page) ? m.page : '') === k).map(m => m.id); const all = ids.every(i => BK.sel.has(i)); ids.forEach(i => all ? BK.sel.delete(i) : BK.sel.add(i)); return X.render(); }
    if (a === 'move') {   // 依目前的順序接在目標頁最後面
      const to = document.getElementById('bkMoveTo').value, ids = sortM(media().filter(m => BK.sel.has(m.id))).map(m => m.id);
      if (!ids.length) return;
      let o = Math.max(0, ...media().filter(m => m.page === to && !BK.sel.has(m.id)).map(m => m.order || 0));
      el.disabled = true; el.textContent = '移動中…';
      for (const i of ids) { o += 10; await X.api.update(id, 'media', i, { page: to, order: o }); }
      BK.sel = new Set(); X.render(); return X.toast(`移了 ${ids.length} 項到「${pageLabel(to)}」`);
    }
    if (a === 'copylist') {
      const by = new Map(); media().forEach(m => { const k = pageOf(m.page) ? m.page : ''; if (!by.has(k)) by.set(k, []); by.get(k).push(m); });
      const ks = [...BK.pages.map(p => p.k).filter(k => by.has(k)), ...(by.has('') ? [''] : [])];
      const tr = [...trashSet()];
      const txt = (tr.length ? `等 Claude 從網站刪除的公開檔案（${tr.length}）：${tr.join(' ')}\n\n` : '') + '北陸回憶錄・私人照片影片清單（' + media().length + ' 項）\n' + ks.map(k => `\n## ${pageLabel(k)}${k ? `（${k}）` : ''}\n` + sortM(by.get(k)).map((m, i) => `${i + 1}. ${m.id}　${m.kind === 'video' ? '影片 ' + fmtDur(m.dur) : '照片'}・${m.h > m.w ? '直' : (m.w > m.h * 2.2 ? '全景' : '橫')}${m.focus ? '・有焦點' : ''}${m.note ? '　「' + m.note + '」' : ''}`).join('\n')).join('\n');
      try { await navigator.clipboard.writeText(txt); return X.toast('清單已複製，貼到對話裡就可以'); }
      catch (err) { const sh = document.getElementById('sheet'); sh.innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between"><b>複製清單</b><button class="small" data-act="close">關閉</button></div><div class="small">自動複製失敗，請全選下面的文字自己複製。</div><textarea class="inp" rows="16" readonly>${e(txt)}</textarea>`; document.getElementById('dim').hidden = false; return; }
    }
    if (a === 'note') return openNote(el.dataset.id);
    if (a === 'upload') return upload();
    if (a === 'stop') { if (BK.up) BK.up.stop = true; return; }
    if (a === 'nofocus') { ED.focus = null; return drawFocus(); }
    if (a === 'save' || a === 'mv') {
      const m = media().find(x => x.id === ED.id); if (!m) return;
      const pg = document.getElementById('bkPage').value, note = document.getElementById('bkNote').value.trim();
      const patch = { page: pg, note, focus: ED.focus };
      if (a === 'mv') {   // 和同一頁的前一張／後一張交換順序（整頁重新編號，避免 order 相同）
        const pk = x => pageOf(x.page) ? x.page : '', sib = sortM(media().filter(x => pk(x) === pk(m)));
        const i = sib.findIndex(x => x.id === m.id), j = i + (+el.dataset.d); if (j < 0 || j >= sib.length) return;
        [sib[i], sib[j]] = [sib[j], sib[i]];
        for (let k = 0; k < sib.length; k++) { const o = (k + 1) * 10; if (sib[k].id === m.id) patch.order = o; else if (sib[k].order !== o) await X.api.update(id, 'media', sib[k].id, { order: o }); }
        await X.api.update(id, 'media', m.id, { order: patch.order }); X.toast('已調整順序'); return openItem(m.id);
      }
      if (pg !== m.page) patch.order = Math.max(0, ...media().filter(x => x.page === pg).map(x => x.order || 0)) + 10;   // 換到別頁：排在那頁最後
      await X.api.update(id, 'media', m.id, patch);
      document.getElementById('dim').hidden = true; ED = null; return X.toast('已存檔');
    }
    if (a === 'del') {
      const m = media().find(x => x.id === ED.id); if (!m || !confirm(`確定刪除 ${m.id}？刪掉後要重新上傳才會回來。`)) return;
      await X.api.update(id, 'media', m.id, { ready: false });
      await X.api.delChunks(id, m.id, allNames(m));
      await X.api.remove(id, 'media', m.id);
      document.getElementById('dim').hidden = true; ED = null; return X.toast('已刪除');
    }
    if (a === 'nsave') {
      const d = { page: document.getElementById('nPage').value, title: document.getElementById('nTitle').value.trim(), text: document.getElementById('nText').value, by: X.me().uid, at: Date.now() };
      if (!d.title && !d.text.trim()) return X.toast('還沒有寫內容');
      if (NE.id) await X.api.update(id, 'notes', NE.id, d); else await X.api.add(id, 'notes', { ...d, order: Date.now() });
      document.getElementById('dim').hidden = true; NE = null; return X.toast('已存檔');
    }
    if (a === 'ndel') { if (!confirm('確定刪除這段私人文字？')) return; await X.api.remove(id, 'notes', NE.id); document.getElementById('dim').hidden = true; NE = null; return X.toast('已刪除'); }
  } catch (err) { X.toast(/permission/i.test(err.code || err.message || '') ? '沒有權限（規則還沒更新，或不是主辦人）' : '出錯了：' + (err.code || err.message)); console.error(err); }
}

/* ═════════ 📐 排版（2026-11-19）：每一頁放哪些照片影片、順序、版型 ═════════
   資料 trips/{id}/bookpages/{頁 key}＝{layout, items:['pub:0508','pv:<私人 id>',…], by, at}。私人項目「在哪一頁」仍以 media.page 為準，items 只決定順序。
   可以排的頁、預設的公開項目、版型清單讀 /<repo>/book-media.json（書本 repo 產生）。拖曳用 vendor/sortable.esm.js（SortableJS 1.15.2，MIT）。 */
let SORT = null;
async function loadBM() {
  if (BK.bm || BK.bmErr) return;
  try { const r = await fetch('/' + X.cur().id + '/book-media.json', { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); BK.bm = await r.json(); }
  catch (err) { BK.bmErr = err; }
  X.render();
}
export function bkRender(render) { if (BK.drag) { BK.dirty = true; return; } render(); }
const bpDoc = k => (X.cur().bookpages || []).find(d => d.id === k);
const mById = id => media().find(m => m.id === id);
const isPano = (w, h) => w > h * 2.2;
function itInfo(id) {   // [縮圖網址, 'i'|'v', 'h'|'v'|'p', 說明, 私人?]
  const repo = X.cur().id;
  if (id.startsWith('pub:')) { const n = id.slice(4), x = (BK.bm.items || {})[n]; if (!x) return null; return [`/${repo}/thumb/IMG_${n}.webp`, x[1], x[2], x[0], 0]; }
  const m = mById(id.slice(3)); if (!m) return null; wantThumb(m); return [thumbURL(m) || '', m.kind === 'video' ? 'v' : 'i', isPano(m.w, m.h) ? 'p' : (m.h > m.w ? 'v' : 'h'), m.note || '', 1];
}
const trashSet = () => new Set(((bpDoc('_trash') || {}).items) || []);
/* 特殊頁的格子（2026-11-19）：bookpages/{特殊頁}＝{slots:{格子 id:[項目…]}}，卡帶 bookpages/cass＝{tapes:[{t 名稱, items}]}。
   沒設定的格子用 book-media.json 的 sp[].slots[].def（書上原本的內容）。 */
const spList = () => BK.bm.sp || [];
/* 自己加的照片頁（2026-11-19）：bookpages/_custom＝{pages:[{k:'c_…', after, t, pl, d, x}]}；照片與版型跟一般頁一樣存 bookpages/{k}。
   書本插頁的規則：放在 after 那頁後面（接在同一頁後面已經加過的頁之後）；after 是車票頁（t1…）時放在車票前面。這裡照同一套規則排清單。 */
const cpList = () => ((bpDoc('_custom') || {}).pages || []).filter(c => c && /^c_[\w-]+$/.test(c.k || ''));
function cpMerge() {
  if (!BK.pages0 && BK.pages) BK.pages0 = BK.pages; if (!BK.bmPages0 && BK.bm && BK.bm.pages) BK.bmPages0 = BK.bm.pages;
  if (!BK.pages0 || !BK.bmPages0) return;
  const L = cpList(), anc = {}; L.forEach(c => anc[c.k] = c.after);
  const seq = BK.pages0.map(p => p.k), chainOf = (k, a) => { let g = 0; while (k && g++ < 20) { if (anc[k] === a) return true; k = anc[k]; } return false; };
  for (const c of L) { let a = c.after, g = 0; while (a && !seq.includes(a) && anc[a] !== undefined && g++ < 20) a = anc[a]; let i = seq.indexOf(a); if (i < 0) { seq.push(c.k); continue; }
    if (/^t\d$/.test(a)) { seq.splice(i, 0, c.k); continue; } while (i + 1 < seq.length && chainOf(seq[i + 1], a)) i++; seq.splice(i + 1, 0, c.k); }
  const by = new Map(BK.pages0.map(p => [p.k, p])), bmk = new Map(BK.bmPages0.map(p => [p.k, p])), cm = new Map(L.map(c => [c.k, c]));
  const cp = c => ({ k: c.k, t: c.t || '（沒有標題）', d: +c.d || null, def: [], custom: 1 });
  const M = bpDoc('_meta') || {}, TT = M.titles || {}, HID = new Set(M.hidden || []), mt = p => ({ ...p, t0: p.t0 || p.t, t: TT[p.k] || p.t, hid: HID.has(p.k) });
  BK.pages = seq.map(k => by.get(k) || (cm.has(k) ? cp(cm.get(k)) : null)).filter(Boolean).map(mt);
  BK.bm.pages = seq.filter(k => bmk.has(k) || cm.has(k)).map(k => bmk.get(k) || cp(cm.get(k))).map(mt);
}
function cpForm(o) {   // o：{after} 新增、或 {k} 修改
  const c = o.k ? cpList().find(x => x.k === o.k) || {} : {}, after = o.k ? c.after : (o.after || ''), pg = pageOf(after);
  const asel = !o.k && !after ? `<div class="lab">放在哪一頁後面</div><select class="inp" id="cpA">${(BK.pages || []).map(p => `<option value="${e(p.k)}"${p.k === o.guess ? ' selected' : ''}>${p.d ? 'Day ' + p.d + '・' : ''}${e(p.t)}</option>`).join('')}</select>` : '';
  const dsel = `<select class="inp" id="cpD"><option value="">（不寫）</option>${Array.from({ length: 9 }, (_, i) => `<option value="${i + 1}"${String(c.d || (o.k ? '' : (pg && pg.d) || '')) === String(i + 1) ? ' selected' : ''}>Day ${i + 1}</option>`).join('')}</select>`;
  const sh = document.getElementById('sheet');
  sh.innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">${o.k ? '修改這一頁' : '加一頁照片頁'}</b><button class="small" data-act="close">關閉</button></div>
    <div class="small" style="margin:4px 0 10px">${after ? `放在「${e(pageLabel(after))}」後面${/^t\d$/.test(after) ? '（這是車票頁，新頁會放在車票前面）' : ''}。` : ''}${o.sel ? `存好之後，勾選的 <b>${o.sel} 項</b>會直接放進這一頁。` : '存好之後把照片影片拖進這頁、選版型；<b>還沒有任何照片的頁，書上不會出現</b>。'}</div>${asel}
    <div class="lab">標題</div><input class="inp" id="cpT" maxlength="40" value="${e(c.t || '')}" placeholder="例如：妙高高原站的雪牆">
    <div class="lab">地點（左上角的小字）</div><input class="inp" id="cpPl" maxlength="20" value="${e(c.pl || (o.k ? '' : ''))}" placeholder="例如：妙高高原">
    <div class="lab">哪一天</div>${dsel}
    <div class="lab">文字（可以空著，一兩句就好）</div><textarea class="inp" id="cpX" rows="3" maxlength="300">${e(c.x || '')}</textarea>
    <div class="acts" style="margin-top:14px"><button class="btn" data-bk="cpsave" data-k="${e(o.k || '')}" data-after="${e(after || '')}" data-sel="${o.sel ? 1 : ''}">存檔</button>${o.k ? `<button data-bk="cpdel" data-k="${e(o.k)}" style="color:var(--bad)">刪除這一頁</button>` : ''}</div>`;
  document.getElementById('dim').hidden = false;
}
/* 候選名單（2026-11-19）：還沒放進書裡的照片影片（公開＋私人），依原本屬於哪一頁／哪一天分組，固定在畫面側邊（手機是底部抽屜），直接拖到頁上。 */
const TRIP_D1 = Date.UTC(2025, 1, 22);
function dayOfTs(t) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t || '')); if (!m) return 0; const d = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - TRIP_D1) / 864e5) + 1; return d >= 1 && d <= 9 ? d : 0; }
function candCat(id) {
  const P = BK.pages || [];
  if (id.startsWith('pub:')) { const x = (BK.bm.items || {})[id.slice(4)] || [], src = x[3] || '', i = P.findIndex(p => p.k === src), pg = P[i];
    return pg ? { key: 'p:' + src, label: (pg.d ? 'Day ' + pg.d + '・' : '') + pg.t, d: pg.d || 0, ord: i } : { key: 'p:?', label: '其他', d: 99, ord: 9999 }; }
  const m = mById(id.slice(3)), d = m ? dayOfTs(m.taken || m.ts) : 0, i = P.findIndex(p => p.d === d);
  return { key: 'v:' + d, label: d ? `Day ${d}・🔒 私人` : '🔒 私人（沒有日期）', d: d || 98, ord: i < 0 ? 9000 : i + 0.5 };
}
function candPanel(pool, own) {
  const side = BK.cside || (BK.cside = (() => { try { return localStorage.getItem('tt-cside') || 'r'; } catch (e) { return 'r'; } })());
  const f = BK.cf || 'all', fd = BK.cday || 0, info = id => itInfo(id) || [];
  const L = pool.filter(id => f === 'all' || (f === 'pub' && id.startsWith('pub:')) || (f === 'pv' && id.startsWith('pv:')) || (f === 'v' && info(id)[1] === 'v')).map(id => ({ id, c: candCat(id) })).filter(o => !fd || o.c.d === fd);
  const G = new Map(); L.forEach(o => { if (!G.has(o.c.key)) G.set(o.c.key, { c: o.c, ids: [] }); G.get(o.c.key).ids.push(o.id); });
  const gs = [...G.values()].sort((a, b) => a.c.d - b.c.d || a.c.ord - b.c.ord), days = [...new Set(pool.map(id => candCat(id).d).filter(d => d && d < 10))].sort((a, b) => a - b);
  const CC = BK.cclosed || (BK.cclosed = new Set()), chip = (v, t, on, a) => `<button class="cchip${on ? ' on' : ''}" data-bk="${a}" data-v="${v}">${t}</button>`;
  return `<aside class="cand d${side}${BK.copen ? ' open' : ''}"><div class="cdh" data-bk="ctog"><b>候選 <em>${pool.length}</em></b><span class="small">還沒放進書裡・拖到頁上就放進去</span>
      <button class="small cside" data-bk="cside" title="換邊">${side === 'r' ? '⇤ 放左邊' : '放右邊 ⇥'}</button><span class="cmob">${BK.copen ? '▾ 收起' : '▴ 展開'}</span></div>
    <div class="cdf">${chip('all', '全部', f === 'all', 'cf')}${chip('pub', '公開', f === 'pub', 'cf')}${chip('pv', '🔒 私人', f === 'pv', 'cf')}${chip('v', '▶ 影片', f === 'v', 'cf')}<span class="csep"></span>${chip(0, '每天', !fd, 'cday')}${days.map(d => chip(d, 'D' + d, fd === d, 'cday')).join('')}${own && BK.lsel ? `<button class="cchip" data-bk="lselpool">☑ 全選看得到的</button>` : ''}</div>
    <div class="cdb">${gs.length ? gs.map(g => `<div class="cgh" data-bk="cgrp" data-g="${e(g.c.key)}">${CC.has(g.c.key) ? '▸' : '▾'} ${e(g.c.label)} <small>${g.ids.length}</small></div>${CC.has(g.c.key) ? '' : `<div class="lst cl" data-k="" data-pool="1">${g.ids.map(tileHTML).join('')}</div>`}`).join('')
      : `<div class="small" style="padding:18px 6px;text-align:center">${pool.length ? '這個篩選沒有東西' : '全部都放進書裡了 🎉'}</div>`}<div class="lst cl cdrop" data-k="" data-pool="1"></div></div></aside>`;
}
/* 多選（2026-11-19）：勾好幾張 → 一次移到某頁／某一格／用它們新增一頁 */
function lselTargets(sel) {   // 下拉：一般頁＋特殊頁的格子＋卡帶
  return (BK.bm.pages || []).map(p => `<option value="${e(p.k)}">${p.custom ? '（自己加的）' : ''}${p.d ? 'Day ' + p.d + '・' : ''}${e(p.t)}</option>`).join('')
    + spList().flatMap(sp => [...(sp.slots || []).map(z => `<option value="${e(sp.k + '|' + z.id)}">（特殊頁）${e(sp.t)}・${e(z.n)}</option>`), ...(sp.tapes ? tapesOf().map((t, i) => `<option value="cass|#${i}">（卡帶）${e(t.t || '未命名')}</option>`) : [])]).join('');
}
function lselBar() { return `<div class="bksel lsel"><b id="lselN">${BK.lsel.size} 項</b><select class="inp" id="lselTo"><option value="">移到…</option><option value="__new">＋ 用這些新增一頁…</option>${lselTargets()}<option value="__pool">不放進書裡</option></select><button class="btn" data-bk="lselgo">移過去</button><button class="small lsx" data-bk="lselmode">取消</button></div>`; }
function lselPaint() { if (!BK.lsel) return; document.querySelectorAll('.lst .lt').forEach(t => t.classList.toggle('sel', BK.lsel.has(t.dataset.id))); const n = document.getElementById('lselN'); if (n) n.textContent = BK.lsel.size + ' 項';
  document.querySelectorAll('.lst').forEach(el => { if (el._s) el._s.option('disabled', !!BK.lsel); }); }
async function batchMove(ids, toK) {
  const S = new Set(ids), wr = [], seen = new Set();
  let add = ids.slice(), skip = 0;
  if (toK.includes('|') && !toK.includes('#')) { const [k2, s2] = toK.split('|'), z = ((spOf(k2) || {}).slots || []).find(q => q.id === s2);
    if (z && z.k !== '*') { const ok = add.filter(i => ((itInfo(i) || [])[1] === 'v') === (z.k === 'v')); skip = add.length - ok.length; add = ok; } }
  if (!add.length) return X.toast('這一格放不進這些（' + (toK.includes('|') ? '格子有限制照片或影片' : '') + '）');
  const AS = new Set(add);
  for (const id of add) { const w = whereIs(id); if (w.pool) continue; const key = w.k + '|' + (w.slot || '') + '|' + (w.tape ?? '') + (w.trash ? '|t' : ''); if (seen.has(key)) continue; seen.add(key);
    wr.push({ k: w.k, ids: w.ids.filter(x => !AS.has(x)), sp: w.sp, trash: w.trash, slot: w.slot, tape: w.tape }); }
  if (toK === '__pool') wr.push({ k: '', ids: add, add: true });
  else if (toK.includes('|')) { const [k2, s2] = toK.split('|'); if (s2.startsWith('#')) { const t = tapesOf()[+s2.slice(1)]; wr.push({ k: 'cass', tape: s2.slice(1), ids: [...(t ? t.items : []).filter(x => !AS.has(x)), ...add] }); }
    else wr.push({ k: k2, slot: s2, ids: [...slotIds(k2, s2).filter(x => !AS.has(x)), ...add] }); }
  else wr.push({ k: toK, ids: [...pageIds(toK).filter(x => !AS.has(x)), ...add] });
  // 同一排同時是來源和目的地時，只留目的地那一筆（它已經是最後的樣子）
  const tgt = wr[wr.length - 1], same = o => o !== tgt && o.k === tgt.k && (o.slot || '') === (tgt.slot || '') && String(o.tape ?? '') === String(tgt.tape ?? '') && !o.trash && !tgt.trash && tgt.k;
  await writeAll(wr.filter(o => !same(o)));
  return { n: add.length, skip };
}
/* 📄 頁面（2026-11-19）：每一頁改標題、在書裡隱藏／顯示。存 bookpages/_meta＝{titles:{頁:標題}, hidden:[頁…]}。
   改標題＝換掉書上那頁的大標題（車票、每天一句話、題詞沒有大標題，只能隱藏）。 */
async function mtSave(patch) { const d = bpDoc('_meta') || {}; await X.api.set(X.cur().id, 'bookpages', '_meta', { titles: d.titles || {}, hidden: d.hidden || [], ...patch, by: X.me().uid, at: Date.now() }); }
function pagesView(own) {
  cpMerge();
  const M = bpDoc('_meta') || {}, TT = M.titles || {}, HID = new Set(M.hidden || []), repo = X.cur().id;
  const L = BK.pages || [], nh = L.filter(p => HID.has(p.k)).length;
  let h = `<div class="card small" style="line-height:1.7">改標題：直接打字，離開輸入框就存（清空＝用原本的標題）。按「👁 顯示中／🙈 已隱藏」切換這頁在不在書裡；隱藏的頁照片設定都還在，切回來就恢復。<br>共 ${L.length} 頁・隱藏 ${nh} 頁${own && nh ? `　<button class="small" data-bk="mtshowall">全部顯示</button>` : ''}</div>`;
  let lastD = -1;
  for (const p of L) {
    if ((p.d || 0) !== lastD) { lastD = p.d || 0; h += `<div class="day"><span>${p.d ? 'Day ' + p.d : '前面'}</span></div>`; }
    const hid = HID.has(p.k), can = p.ht !== false && !/^(q\d|t\d|endp)$/.test(p.k), orig = p.t0 || p.t;
    h += `<div class="pgrow${hid ? ' off' : ''}"><div class="pgk">${p.custom ? '自己加的' : p.sp ? '特殊頁' : ''}</div>
      ${can ? `<input class="inp mtt" data-k="${e(p.k)}" value="${e(TT[p.k] || '')}" placeholder="${e(orig)}" maxlength="40" ${own ? '' : 'disabled'}>` : `<div class="pgt">${e(orig)}<small>（沒有大標題，只能隱藏）</small></div>`}
      <button class="small mth${hid ? ' on' : ''}" data-bk="mthide" data-k="${e(p.k)}" ${own ? '' : 'disabled'}>${hid ? '🙈 已隱藏' : '👁 顯示中'}</button>
      <a class="lnk" href="/${repo}/index.html#pg=${e(p.k)}" target="_blank" rel="noopener" title="在書裡看">↗</a></div>`;
  }
  return h;
}
async function cpSaveAll(pages) { await X.api.set(X.cur().id, 'bookpages', '_custom', { pages, by: X.me().uid, at: Date.now() }); }
const spOf = k => spList().find(x => x.k === k);
const okIds = L => { const T = trashSet(); return L.filter(i => itInfo(i) && !T.has(i)); };
function slotIds(k, sid) { const d = bpDoc(k), sp = spOf(k), sl = sp && (sp.slots || []).find(z => z.id === sid); const set = d && d.slots && Array.isArray(d.slots[sid]); return okIds(set ? d.slots[sid] : (sl ? sl.def : [])); }
const slotSet = (k, sid) => { const d = bpDoc(k); return !!(d && d.slots && Array.isArray(d.slots[sid])); };
function tapesOf() { const d = bpDoc('cass'), sp = spOf('cass'); const src = d && Array.isArray(d.tapes) ? d.tapes : ((sp && sp.tapes) || []); return src.map(t => ({ t: t.t || '', items: okIds(t.items || []) })); }
function spUsed() { const u = new Set(); for (const sp of spList()) { (sp.slots || []).forEach(z => slotIds(sp.k, z.id).forEach(i => u.add(i))); if (sp.tapes) tapesOf().forEach(t => t.items.forEach(i => u.add(i))); } return u; }
const kindTxt = k => k === 'v' ? '只放影片' : k === 'i' ? '只放照片' : '照片或影片';
async function spSave(k, patch) {   // 保留這頁原本的欄位，只換 slots 或 tapes
  const d = bpDoc(k) || {}, o = {}; for (const [a, b] of Object.entries(d)) if (a !== 'id') o[a] = b;
  await X.api.set(X.cur().id, 'bookpages', k, { ...o, ...patch, by: X.me().uid, at: Date.now() });
}
function pageIds(k) {
  const T = trashSet(), d = bpDoc(k), mine = sortM(media().filter(m => m.page === k)).map(m => 'pv:' + m.id), pg = (BK.bm.pages || []).find(p => p.k === k);
  let ids = d && d.items ? d.items.filter(id => id.startsWith('pub:') || mine.includes(id)) : (pg ? pg.def.map(n => 'pub:' + n) : []).concat(mine);
  mine.forEach(id => { if (!ids.includes(id)) ids.push(id); });
  return ids.filter(id => itInfo(id) && !T.has(id));
}
function tileHTML(id) { const x = itInfo(id); if (!x) return ''; const n = id.replace(/^(pub|pv):(IMG_)?/, '');
  return `<div class="lt${x[4] ? ' pv' : ''}" data-id="${e(id)}" title="${e(x[3] || n)}"><img ${x[0] ? `src="${x[0]}"` : `data-th="${e(id.slice(3))}"`} loading="lazy" alt="" draggable="false"><i>${x[4] ? '🔒' : ''}${x[1] === 'v' ? '▶' : ''}${x[2] === 'v' ? '直' : x[2] === 'p' ? '全景' : ''}</i><b>${e(n)}</b></div>`; }
const LYMAP = () => { const o = {}; (BK.bm.layouts || []).forEach(l => o[l.k] = l); return o; };
function laySvg(l) {   // 版型的小示意圖
  const W = 44, H = 58, fill = (x, y, w, h, c) => `<rect x="${x + 1}" y="${y + 1}" width="${Math.max(1, w - 2)}" height="${Math.max(1, h - 2)}" rx="2" fill="${c || '#c9b9a0'}"/>`;
  let r = '';
  if (l.g) {
    const rows = l.g.match(/"[^"]+"/g).map(s => s.replace(/"/g, '').trim().split(/\s+/)), fr = s => s.split(/\s+/).map(parseFloat);
    const R = fr(l.r), C = fr(l.c), sR = R.reduce((a, b) => a + b), sC = C.reduce((a, b) => a + b), seen = {};
    rows.forEach((row, i) => row.forEach((a, j) => { if (seen[a]) return; seen[a] = 1; let i2 = i, j2 = j; while (rows[i2 + 1] && rows[i2 + 1][j] === a) i2++; while (row[j2 + 1] === a) j2++;
      const x = C.slice(0, j).reduce((p, q) => p + q, 0) / sC * W, y = R.slice(0, i).reduce((p, q) => p + q, 0) / sR * H, w = C.slice(j, j2 + 1).reduce((p, q) => p + q, 0) / sC * W, h = R.slice(i, i2 + 1).reduce((p, q) => p + q, 0) / sR * H;
      const s = (l.s || []).find(z => z[0] === a); r += fill(x, y, w, h, s && s[1] === 'v' ? '#a8432f' : null) + (s && s[1] === 'v' ? `<path d="M${x + w / 2 - 3} ${y + h / 2 - 4}l7 4-7 4z" fill="#fff"/>` : ''); })); }
  else if (l.k === 'main') r = fill(0, 0, W, 44) + [0, 1, 2, 3].map(i => fill(i * 11, 46, 11, 12)).join('');
  else if (l.k === 'wall') r = [[0, 0, 26, 18], [26, 0, 18, 18], [0, 18, 14, 22], [14, 18, 30, 22], [0, 40, 22, 18], [22, 40, 22, 18]].map(a => fill(...a)).join('');
  else if (l.k === 'pola') r = [[-6, 2, 4, 24, 26], [5, 18, 18, 24, 26], [-3, 4, 32, 22, 24]].map(([a, x, y, w, h]) => `<g transform="rotate(${a} ${x + w / 2} ${y + h / 2})"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#b9ab94"/><rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 8}" fill="#c9b9a0"/></g>`).join('');
  else if (l.k === 'film') r = `<rect width="${W}" height="${H}" fill="#2a2622" rx="2"/>` + [0, 1, 2].map(i => fill(2 + i * 14, 18, 13, 22, '#c9b9a0')).join('');
  else r = fill(0, 0, W, 28) + fill(0, 30, 21, 28) + fill(23, 30, 21, 28);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${r}</svg>`;
}
function recommend(ids) {   // 依這頁的組合推薦版型
  const X2 = ids.map(itInfo).filter(Boolean), v = X2.filter(x => x[1] === 'v'), vv = v.filter(x => x[2] === 'v').length, vh = v.length - vv, ph = X2.filter(x => x[1] !== 'v'), pv = ph.filter(x => x[2] === 'v').length, pp = ph.filter(x => x[2] === 'p').length;
  const r = new Set();
  if (vv >= 2) r.add('vduo'); if (vv >= 1 && ph.length >= 2) r.add('vside'); if (vh >= 1 && ph.length >= 3) r.add('vtop'); if (v.length >= 1 && ph.length <= 2) r.add('vfull');
  if (pp >= 1) r.add('pano'); if (ph.length >= 5) { r.add('wall'); r.add('main'); } if (ph.length >= 4) r.add('quad');
  if (pv >= 2) r.add('duo-v'); if (ph.length - pv - pp >= 2) r.add('duo-h'); if (ph.length >= 3) r.add(pv > ph.length / 2 ? 'trio-side' : 'trio'); if (X2.length >= 3 && X2.length <= 5) r.add('pola');
  return r;
}
function layoutView() {
  cpMerge();
  const c = X.cur(), own = X.isOwner(), LY = LYMAP(), repo = c.id;
  const pages = BK.bm.pages || [], editK = new Set(pages.map(p => p.k));
  let h = own ? `<div class="lseltop"><button class="btn${BK.lsel ? '' : ' ghost'}" data-bk="lselmode">${BK.lsel ? '✓ 多選中（點縮圖勾選）' : '☑ 多選：一次勾好幾張'}</button><button class="btn ghost" data-bk="cpadd" data-after="">＋ 新增一頁</button></div>` : '';
  h += `<div class="card small" style="line-height:1.7">${own ? '<b>點縮圖</b>：往前／往後、移到別頁、不放進書裡、刪除。<b>拖曳縮圖</b>：排順序、拖到別頁；拖的時候畫面下方會浮出「不放進書裡」「🗑 刪除」，放上去就好。每頁右上角選<b>版型</b>。改了馬上存。手機上請<b>按住縮圖一下</b>再拖。' : '主辦人排的版面（只能看）。'}</div>`;
  const used = new Set();
  for (const p of pages) {
    const ids = pageIds(p.k); ids.forEach(i => used.add(i)); const d = bpDoc(p.k), lay = (d && d.layout) || 'auto', l = LY[lay] || LY.auto;
    const v = ids.filter(i => (itInfo(i) || [])[1] === 'v').length;
    h += `<div class="lpg${p.custom ? ' cpp' : ''}" data-k="${e(p.k)}"><div class="lph"><div><small>${p.hid ? '<em style="color:var(--bad);font-style:normal">🙈 書上隱藏中・</em>' : ''}${p.custom ? '自己加的頁・' : ''}${p.d ? 'Day ' + p.d : ''}</small><b>${e(p.t)}${p.custom && own ? ` <button class="small" data-bk="cpedit" data-k="${e(p.k)}">✎ 修改</button>` : ''}</b><span>${ids.length - v} 張${v ? '・' + v + ' 支影片' : ''}${p.custom && !ids.length ? '・<em style="color:var(--bad);font-style:normal">還沒有照片，書上不會出現</em>' : ''}</span></div>
      <a class="lnk" href="/${repo}/index.html#pg=${e(p.k)}" target="_blank" rel="noopener">在書裡看 ↗</a>
      <button class="lay" data-bk="laypick" data-k="${e(p.k)}" ${own ? '' : 'disabled'}>${laySvg(l)}<span>${e(l.n)}</span></button></div>
      <div class="lst" data-k="${e(p.k)}">${ids.map(tileHTML).join('')}</div>${own ? `<button class="cpadd" data-bk="cpadd" data-after="${e(p.k)}">＋ 在這頁後面加一頁</button>` : ''}</div>`;
  }
  // 特殊頁：版面固定，每一格放哪些照片影片可以換（公開、私人都可以）
  const SPU = spUsed(); SPU.forEach(i => used.add(i));
  if (spList().length) h += `<div class="day"><span>特殊頁（版面固定，拖進每一格就換掉書上的內容）</span></div>`;
  for (const sp of spList()) {
    const pg = pageOf(sp.k), inSlot = new Set();
    h += `<div class="lpg spg" data-k="${e(sp.k)}"><div class="lph"><div><small>${pg && pg.d ? 'Day ' + pg.d + '・' : ''}${e(sp.kind)}</small><b>${e(sp.t)}</b></div><a class="lnk" href="/${repo}/index.html#pg=${e(sp.k)}" target="_blank" rel="noopener">在書裡看 ↗</a></div>`;
    for (const z of sp.slots || []) { const ids = slotIds(sp.k, z.id), set = slotSet(sp.k, z.id); ids.forEach(i => inSlot.add(i));
      h += `<div class="slh"><b>${e(z.n)}</b><small>${kindTxt(z.k)}・最多 ${z.max} 項${ids.length > z.max ? `<em>（超過的 ${ids.length - z.max} 項不會出現）</em>` : ''}${set ? '' : '・目前是原本的內容'}</small>${set && own ? `<button class="small" data-bk="sreset" data-k="${e(sp.k)}" data-s="${e(z.id)}">還原</button>` : ''}</div>
        <div class="lst" data-k="${e(sp.k)}" data-slot="${e(z.id)}" data-sk="${z.k}">${ids.map(tileHTML).join('')}</div>`; }
    if (sp.tapes) { const TP = tapesOf(); TP.forEach(t => t.items.forEach(i => inSlot.add(i)));
      TP.forEach((t, i) => { h += `<div class="slh tp"><input class="inp tpn" data-i="${i}" value="${e(t.t)}" placeholder="帶子的名字" ${own ? '' : 'disabled'}><small>${t.items.length ? (t.items.every(x => (itInfo(x) || [])[1] === 'v') ? t.items.length + ' 支影片（依序連播）' : t.items.length + ' 項（照片牆）') : '空的（書上不會出現）'}</small>${own ? `<button class="small" data-bk="tup" data-i="${i}" ${i ? '' : 'disabled'}>↑</button><button class="small" data-bk="tdel" data-i="${i}">刪除這捲</button>` : ''}</div>
        <div class="lst" data-k="cass" data-tape="${i}">${t.items.map(tileHTML).join('')}</div>`; });
      if (own) h += `<button class="btn ghost" data-bk="tadd" style="margin:6px 0 2px">＋ 新增一捲卡帶</button>`; }
    const rest = sortM(media().filter(m => m.page === sp.k && !inSlot.has('pv:' + m.id))).map(m => 'pv:' + m.id);
    if (own) h += `<button class="cpadd" data-bk="cpadd" data-after="${e(sp.k)}">＋ 在這頁後面加一頁照片頁</button>`;
    if (rest.length) h += `<div class="slh"><b>放在這頁、還沒放進格子的私人項目</b><small>書上只會在「🔒 私人」按鈕裡</small></div><div class="lst" data-k="${e(sp.k)}" data-sp="1">${rest.map(tileHTML).join('')}</div>`;
    h += `</div>`;
  }
  // 舊的：特殊頁清單裡沒有、但有私人項目指定到那頁
  const spk = new Set(spList().map(x => x.k)), sp0 = (BK.pages || []).filter(p => !editK.has(p.k) && !spk.has(p.k) && media().some(m => m.page === p.k));
  for (const p of sp0) h += `<div class="lpg sp" data-k="${e(p.k)}"><div class="lph"><div><small>${p.d ? 'Day ' + p.d : ''}</small><b>${e(p.t)}</b></div></div><div class="lst" data-k="${e(p.k)}" data-sp="1">${sortM(media().filter(m => m.page === p.k)).map(m => tileHTML('pv:' + m.id)).join('')}</div></div>`;
  // 不放進書裡：還沒指定頁的私人項目＋從頁上拿掉的公開照片
  const defAll = new Set(pages.flatMap(p => p.def)), T = trashSet();
  const pool = [...media().filter(m => !m.page || !(BK.pages || []).some(p => p.k === m.page)).map(m => 'pv:' + m.id), ...Object.keys(BK.bm.items || {}).map(n => 'pub:' + n).filter(i => !used.has(i) && !T.has(i))];   /* 2026-11-19：所有公開項目都算（原本只算各頁預設的，車票頁、相簿頁的照片永遠不會出現） */
  h += candPanel(pool, own);
  if (own) h += `<div class="lpg trash"><div class="lph"><div><b>🗑 刪除</b><span>拖進來：<b>私人</b>的會問你一次然後直接刪掉；<b>公開</b>的先從書裡全部拿掉，等 Claude 把網站上的檔案刪除（拖回任何一頁就取消）。</span></div></div><div class="lst" data-k="_trash" data-trash="1">${[...T].map(tileHTML).join('')}</div></div>`;
  if (own) h += `<div id="ldz"><div class="dz" data-z="pool"><span>拖到這裡：不放進書裡</span></div><div class="dz tr" data-z="trash"><span>🗑 拖到這裡：刪除</span></div></div>`;
  if (own && BK.lsel) h += lselBar();
  if (own) setTimeout(() => { initSort(); lselPaint(); const b = document.querySelector('.cand .cdb'); if (b) { b.scrollTop = BK.cscroll || 0; b.onscroll = () => { BK.cscroll = b.scrollTop; }; } }, 0);
  return h;
}
async function initSort() {
  if (!SORT) SORT = (await import('./vendor/sortable.esm.js')).default;
  document.querySelectorAll('.lst').forEach(el => {
    if (el._s) return;
    el._s = SORT.create(el, { group: { name: 'bk', put: (to, from, item) => { const t = to.el.dataset, id = item.dataset.id; if (t.sp && id.startsWith('pub:')) return false; const x = itInfo(id) || []; if (t.sk === 'v' && x[1] !== 'v') return false; if (t.sk === 'i' && x[1] === 'v') return false; return true; } }, animation: 160, delay: 180, delayOnTouchOnly: true, forceFallback: true, fallbackTolerance: 4, scrollSensitivity: 90, scrollSpeed: 14, ghostClass: 'gh', chosenClass: 'ch',
      onStart: ev => { BK.drag = true; BK.dragFrom = stripOf(ev.from); document.body.classList.add('ldrag'); },
      onMove: ev => { const z = zoneAt(ev.originalEvent); document.querySelectorAll('#ldz .dz').forEach(d => d.classList.toggle('hot', d === z)); return z ? false : true; },
      onEnd: ev => {
        const z = zoneAt(ev.originalEvent), id = ev.item.dataset.id;
        if (z) return dropZone(id, z.dataset.z);   // 放在浮動的投放區上：照拖之前的資料處理，畫面重畫
        if (ev.from === ev.to && ev.oldIndex === ev.newIndex) { BK.drag = false; document.body.classList.remove('ldrag'); return; }
        saveDrag(ev.from, ev.to); } });
  });
}
// 把一排（某頁／不放進書裡／刪除）的新內容寫回去。add＝浮動的投放區：只帶新放進來的項目，要跟原本的合併
async function writeStrip(o) {
  const id = X.cur().id, me = X.me(), { k, ids } = o;
  if (o.trash) {
    const pv = ids.filter(i => i.startsWith('pv:')), pubNew = ids.filter(i => i.startsWith('pub:'));
    if (pv.length && confirm(`確定刪除 ${pv.length} 項私人照片影片？刪掉後要重新上傳才會回來。`)) {
      for (const i of pv) { const m = mById(i.slice(3)); if (!m) continue; await X.api.update(id, 'media', m.id, { ready: false }); await X.api.delChunks(id, m.id, allNames(m)); await X.api.remove(id, 'media', m.id); }
    }
    const pub = o.add ? [...new Set([...trashSet(), ...pubNew])] : pubNew;
    await X.api.set(id, 'bookpages', '_trash', { items: pub, by: me.uid, at: Date.now() });
    return;
  }
  if (o.slot || o.tape != null) return writeAll([o]);   // 特殊頁的一格／一捲卡帶
  for (let i = 0; i < ids.length; i++) if (ids[i].startsWith('pv:')) { const m = mById(ids[i].slice(3)); if (m && (m.page !== k || (!o.add && m.order !== (i + 1) * 10))) await X.api.update(id, 'media', m.id, o.add ? { page: k } : { page: k, order: (i + 1) * 10 }); }
  if (k && !o.sp) { const d = bpDoc(k); await X.api.set(id, 'bookpages', k, { layout: (d && d.layout) || '', items: ids, by: me.uid, at: Date.now() }); }
}
/* 一次寫好幾排：同一個特殊頁（或卡帶）的幾格合成一次寫入，避免後寫的蓋掉先寫的 */
async function writeAll(ops) {
  const spOps = ops.filter(o => o.slot || o.tape != null), rest = ops.filter(o => !(o.slot || o.tape != null));
  for (const o of rest) await writeStrip(o);
  const byK = new Map(); spOps.forEach(o => { if (!byK.has(o.k)) byK.set(o.k, []); byK.get(o.k).push(o); });
  const id = X.cur().id;
  for (const [k, L] of byK) {
    const d = bpDoc(k) || {}, slots = { ...(d.slots || {}) }, TP = tapesOf().map(t => ({ t: t.t, items: t.items.slice() }));
    for (const o of L) {
      let ids = o.ids; if (o.add) ids = [...(o.slot ? slotIds(k, o.slot) : (TP[+o.tape] || { items: [] }).items).filter(x => !o.ids.includes(x)), ...o.ids];
      if (o.slot) { const z = ((spOf(k) || {}).slots || []).find(q => q.id === o.slot), prev = slotIds(k, o.slot), nw = ids.filter(x => !prev.includes(x)); if (z && z.max === 1 && ids.length > 1) ids = [nw[0] || ids[0]]; }   // 只能放一項的格子：新放進來的取代舊的
      for (const i of ids) if (i.startsWith('pv:')) { const m = mById(i.slice(3)); if (m && m.page !== k) await X.api.update(id, 'media', m.id, { page: k }); }
      if (o.slot) slots[o.slot] = ids; else if (TP[+o.tape]) TP[+o.tape].items = ids;
    }
    await spSave(k, L.some(o => o.slot) ? { slots } : { tapes: TP });
  }
}
const stripOf = el => ({ k: el.dataset.k, ids: [...el.children].map(t => t.dataset.id).filter(Boolean), sp: !!el.dataset.sp, trash: !!el.dataset.trash, add: !!el.dataset.add, slot: el.dataset.slot || '', tape: el.dataset.tape != null ? el.dataset.tape : null });
// 拖曳時畫面下方浮出的「不放進書裡／刪除」：用放開時的座標判斷有沒有落在上面
function zoneAt(e) {
  if (!e) return null; const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || e, x = t.clientX, y = t.clientY; if (x == null) return null;
  return [...document.querySelectorAll('#ldz .dz')].find(d => { const r = d.getBoundingClientRect(); return r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
}
async function dropZone(id, z) {
  document.body.classList.remove('ldrag'); BK.drag = false;
  if (z === 'trash' && id.startsWith('pv:') && !confirm('確定刪除這項私人照片影片？刪掉後要重新上傳才會回來。')) return X.render();
  await tileMove(id, '', z === 'trash' ? 'trash' : 'pool');
}
async function saveDrag(from, to) {
  document.body.classList.remove('ldrag');
  try { await writeAll([...new Set([from, to])].map(stripOf)); X.toast(to.dataset.trash ? '已放進刪除區' : to.dataset.pool ? '已從書裡拿掉' : '已存檔'); }
  catch (err) { X.toast(/permission/i.test(err.code || err.message || '') ? '沒有權限：Firebase 規則還沒有 bookpages，請貼上最新的 firestore.rules' : '存檔失敗：' + (err.code || err.message)); console.error(err); }
  BK.drag = false; BK.dirty = false; X.render();
}
// 一張縮圖目前在哪一排
function whereIs(id) {
  if (trashSet().has(id)) return { k: '_trash', ids: [...trashSet()], trash: true };
  for (const sp of spList()) { for (const z of sp.slots || []) { const ids = slotIds(sp.k, z.id); if (ids.includes(id)) return { k: sp.k, slot: z.id, ids, label: sp.t + '・' + z.n }; }
    if (sp.tapes) { const TP = tapesOf(); for (let i = 0; i < TP.length; i++) if (TP[i].items.includes(id)) return { k: 'cass', tape: String(i), ids: TP[i].items, label: '卡帶「' + (TP[i].t || '未命名') + '」' }; } }
  for (const p of BK.bm.pages || []) { const ids = pageIds(p.k); if (ids.includes(id)) return { k: p.k, ids }; }
  if (id.startsWith('pv:')) { const m = mById(id.slice(3)); if (m && m.page && (BK.pages || []).some(p => p.k === m.page)) return { k: m.page, ids: sortM(media().filter(x => x.page === m.page)).map(x => 'pv:' + x.id), sp: true }; }
  return { k: '', ids: [id], pool: true };
}
// 點縮圖：小選單（往前／往後、移到別頁、不放進書裡、刪除、私人的編輯說明）
const spOpts = (id, w) => { const x = itInfo(id) || []; let h = ''; for (const sp of spList()) { for (const z of sp.slots || []) { if ((z.k === 'v' && x[1] !== 'v') || (z.k === 'i' && x[1] === 'v')) continue; const v = sp.k + '|' + z.id; h += `<option value="${e(v)}"${w.slot === z.id && w.k === sp.k ? ' selected' : ''}>（特殊頁）${e(sp.t)}・${e(z.n)}</option>`; }
  if (sp.tapes) tapesOf().forEach((t, i) => { h += `<option value="cass|#${i}"${w.tape === String(i) ? ' selected' : ''}>（卡帶）${e(t.t || '未命名')}</option>`; }); } return h; };
function openTile(id) {
  const x = itInfo(id); if (!x) return; const w = whereIs(id), i = w.ids.indexOf(id), n = id.replace(/^(pub|pv):(IMG_)?/, '');
  const opts = (BK.bm.pages || []).map(p => `<option value="${e(p.k)}"${p.k === w.k ? ' selected' : ''}>${p.d ? 'Day ' + p.d + '・' : ''}${e(p.t)}</option>`).join('')
    + spOpts(id, w);
  const sh = document.getElementById('sheet'), canMove = !w.pool && !w.trash;
  sh.innerHTML = `<div class="grab"></div><div class="tmh"><img src="${x[0] || ''}" ${x[0] ? '' : `data-th="${e(id.slice(3))}"`} alt=""><div><b>${e(n)}</b><span>${x[4] ? '🔒 私人' : '公開'}・${x[1] === 'v' ? '影片' : '照片'}・${x[2] === 'v' ? '直' : x[2] === 'p' ? '全景' : '橫'}</span><small>${w.trash ? '在刪除區' : w.pool ? '沒有放進書裡' : '現在在：' + e(w.label || pageLabel(w.k)) + `（第 ${i + 1} / ${w.ids.length} 個）`}</small></div><button class="small" data-act="close">關閉</button></div>
    ${canMove ? `<div class="acts"><button data-bk="tmv" data-id="${e(id)}" data-d="-1" ${i <= 0 ? 'disabled' : ''}>← 往前</button><button data-bk="tmv" data-id="${e(id)}" data-d="1" ${i >= w.ids.length - 1 ? 'disabled' : ''}>往後 →</button></div>` : ''}
    <div class="lab">${canMove ? '移到別頁（排在那頁最後）' : '放回書裡'}</div><div class="tmto"><select class="inp" id="tmTo">${canMove ? '' : '<option value="">選一頁…</option>'}${opts}</select><button class="btn" data-bk="tto" data-id="${e(id)}">移過去</button></div>
    <div class="acts" style="margin-top:12px">${w.pool ? '' : `<button data-bk="tpool" data-id="${e(id)}">不放進書裡</button>`}${w.trash ? '' : `<button data-bk="ttrash" data-id="${e(id)}" style="color:var(--bad)">🗑 ${x[4] ? '刪除' : '刪除（等 Claude 刪檔）'}</button>`}${x[4] ? `<button data-bk="open" data-id="${e(id.slice(3))}">✎ 說明・焦點</button>` : ''}</div>`;
  document.getElementById('dim').hidden = false;
}
async function tileMove(id, toK, how) {   // how：'to' 移到 toK 最後、'pool' 不放、'trash' 刪除、±1 往前後
  const w = whereIs(id), wr = [];
  if (typeof how === 'number') { const L = w.ids.slice(), i = L.indexOf(id), j = i + how; if (j < 0 || j >= L.length) return; [L[i], L[j]] = [L[j], L[i]]; wr.push({ k: w.k, ids: L, sp: w.sp, slot: w.slot, tape: w.tape }); }
  else {
    if (!w.pool) wr.push({ k: w.k, ids: w.ids.filter(x => x !== id), sp: w.sp, trash: w.trash, slot: w.slot, tape: w.tape });
    if (how === 'trash') wr.push({ k: '_trash', ids: [id], trash: true, add: true });
    else if (how === 'pool') wr.push({ k: '', ids: [id], add: true });
    else if (toK.includes('|')) { const [k2, s2] = toK.split('|'); if (s2.startsWith('#')) { const t = tapesOf()[+s2.slice(1)]; wr.push({ k: 'cass', tape: s2.slice(1), ids: [...(t ? t.items : []).filter(x => x !== id), id] }); }
      else wr.push({ k: k2, slot: s2, ids: [...slotIds(k2, s2).filter(x => x !== id), id] }); }
    else { const sp = !(BK.bm.pages || []).some(p => p.k === toK); if (sp && id.startsWith('pub:')) return X.toast('特殊頁只能放私人照片影片'); const to = sp ? sortM(media().filter(m => m.page === toK)).map(m => 'pv:' + m.id) : pageIds(toK); wr.push({ k: toK, ids: [...to.filter(x => x !== id), id], sp }); }
  }
  try { await writeAll(wr); } catch (err) { return X.toast('存檔失敗：' + (err.code || err.message)); }
  X.render();
  if (typeof how === 'number') openTile(id); else { document.getElementById('dim').hidden = true; X.toast(how === 'trash' ? '已放進刪除區' : how === 'pool' ? '已從書裡拿掉' : '已移到「' + (toK.includes('|') ? (whereIs(id).label || '特殊頁') : pageLabel(toK)) + '」'); }
}
function openLayPick(k) {
  const LY = BK.bm.layouts || [], d = bpDoc(k), cur = (d && d.layout) || 'auto', ids = pageIds(k), rec = recommend(ids), pg = (BK.bm.pages || []).find(p => p.k === k);
  const card = l => `<button class="lyc${l.k === cur ? ' on' : ''}" data-bk="laysel" data-k="${e(k)}" data-l="${l.k}">${laySvg(l)}<div><b>${e(l.n)}${rec.has(l.k) ? '<em>推薦</em>' : ''}</b><span>${e(l.d)}</span><small>適合：${e(l.fit)}</small></div></button>`;
  const sh = document.getElementById('sheet');
  sh.innerHTML = `<div class="grab"></div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">版型・${e(pg ? pg.t : k)}</b><button class="small" data-act="close">關閉</button></div>
    <div class="small" style="margin:4px 0 8px">這頁：${ids.length} 項。紅色格子＝影片優先。照片比格子多時，每格會輪播。</div>
    ${rec.size ? `<div class="lab">推薦</div><div class="lyg">${LY.filter(l => rec.has(l.k)).map(card).join('')}</div><div class="lab">全部</div>` : ''}<div class="lyg">${LY.map(card).join('')}</div>`;
  document.getElementById('dim').hidden = false;
}
