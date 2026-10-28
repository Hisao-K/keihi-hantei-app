"use strict";
/* ═══════════════ 保存（この端末の控え） ═══════════════
   正本は会社のドライブ（GAS が人ごとに保存する）。この端末の localStorage と IndexedDB は控え。
   控えはログインした人ごとに分け、「閉じる」で消す。 */
let ME = {email:"", name:"", role:""};          /* ログイン中の人。role＝admin（管理者）／user（利用者） */
const isAdmin = () => ME.role === "admin";
const LS = {
  key(k){ return "keihi." + (ME.email || "_") + "." + k },
  get(k,d){ try{ const v=localStorage.getItem(this.key(k)); return v?JSON.parse(v):d }catch(e){ return d } },
  set(k,v){ try{ localStorage.setItem(this.key(k),JSON.stringify(v)) }catch(e){} },
  del(k){ try{ localStorage.removeItem(this.key(k)) }catch(e){} },
};
/* 見た目は端末ごと（人の基本項目に入れない） */
const THEME = {
  get(){ try{ return localStorage.getItem("keihi.theme") || "auto" }catch(e){ return "auto" } },
  set(v){ try{ localStorage.setItem("keihi.theme", v) }catch(e){} },
};
const S_DEF = {v:3,entity:"kojin",aoiro:"shiroiro",aoiroAmt:"10",shohi:"menzei",kyuyo:"nashi",cmethod:"sohei",kenpo:"shakai",setupDone:false};
const S = {};
let ANS = {}, CAT = null;

/* ═══════════════ 台帳データ ═══════════════ */
const D = {};
const ROWK = Ledger.ROWK, MAPK = Ledger.MAPK;
/* 台帳を入れ替える（ログイン・ドライブからの読み込み・閉じる）。S と D は同じ入れ物のまま中身だけ替える */
function resetState(settings, data){
  Object.keys(S).forEach(k=>delete S[k]);
  Object.assign(S, S_DEF, settings||{});
  delete S.theme;
  Object.keys(D).forEach(k=>delete D[k]);
  Object.assign(D, Ledger.norm(data));
  snapTake();
}
/* 給与が出る最後の月（管理者の基本項目）。空なら給与が続く＝個人事業は副業として扱う */
const kyuyoEnd = () => { const m = String(S.kyuyoEnd||"").match(/^(\d{4})-(\d{2})$/); return m ? {y:+m[1], m:+m[2]} : null };
const hasSalaryYear = y => { const e = kyuyoEnd(); return !e || y <= e.y };
const honngyoFrom   = () => { const e = kyuyoEnd(); return e ? (e.m >= 12 ? e.y + 1 : e.y) : Infinity };
const isHonngyo     = y => y >= honngyoFrom();      // 給与が出なくなる年から本業

/* ═══════════════ 直した時刻 ═══════════════
   ほかの端末と合わせるとき、行ごと・年ごとの値ごと・基本項目ごとに、あとで直したほうを採る（ledger.js）。
   直した場所ごとに時刻を書くかわりに、保存のたびに前回の中身と比べ、変わったものに時刻を付ける。 */
let SNAP = new Map(), SNAP_S = "";
const rowSig = r => { const {t, ...rest} = r; return JSON.stringify(rest) };
const setSig = () => { const {t, ...rest} = S; return JSON.stringify(rest) };
function snapTake(){
  SNAP = new Map();
  ROWK.forEach(k => (D[k]||[]).forEach(r => SNAP.set(k+":"+r.id, rowSig(r))));
  MAPK.forEach(k => Object.keys(D[k]||{}).forEach(y => SNAP.set(k+"@"+y, JSON.stringify(D[k][y]))));
  SNAP_S = setSig();
}
function stamp(){
  const now = Date.now();
  ROWK.forEach(k => (D[k]||[]).forEach(r => {
    const s = rowSig(r);
    if(SNAP.get(k+":"+r.id) !== s){ r.t = now; SNAP.set(k+":"+r.id, s) }
  }));
  if(!D.mt) D.mt = {};
  MAPK.forEach(k => Object.keys(D[k]||{}).forEach(y => {
    const s = JSON.stringify(D[k][y]);
    if(SNAP.get(k+"@"+y) !== s){ D.mt[k+":"+y] = now; SNAP.set(k+"@"+y, s) }
  }));
}
const saveD = () => { if(!ME.email) return; stamp(); LS.set("data", D); markDirty() };
const saveS = () => {
  if(!ME.email) return;
  const s = setSig();
  if(s !== SNAP_S){ S.t = Date.now(); SNAP_S = setSig() }
  LS.set("settings", S); markDirty();
};

/* 行を消したら墓標を残す。残さないと、ほかの端末と合わせたときに復活する */
const dropRow = (k,id) => { D[k] = D[k].filter(x=>x.id!==id); if(D.tomb.indexOf(id)<0) D.tomb.push(id); };

/* ドライブから来た台帳と、この端末の台帳を合わせる（同じ行は、あとで直したほう）。
   戻り値 true＝この端末にしかない直しがある（ドライブへ送る必要がある） */
function applyServer(led){
  stamp();
  const data = Ledger.merge(led && led.data, D);
  const set  = JSON.parse(JSON.stringify(Ledger.mergeSettings(led && led.settings, S)));
  const mine = !led
    || JSON.stringify(Ledger.norm(led.data)) !== JSON.stringify(data)
    || JSON.stringify(led.settings || {}) !== JSON.stringify(set);
  const before = JSON.stringify([S, D]);
  resetState(set, data);
  LS.set("data", D); LS.set("settings", S);
  return {mine, changed: before !== JSON.stringify([S, D])};
}

let YEAR = new Date().getFullYear();
let INVTAB = "crypto";
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const yOf = s => +String(s||"").slice(0,4);
const today = () => new Date().toISOString().slice(0,10);

/* ═══════════════ 領収書（IndexedDB） ═══════════════ */
const IDB = {
  p:null,
  open(){
    return this.p || (this.p = new Promise((res,rej)=>{
      const r = indexedDB.open("keihi-receipts",1);
      r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains("r")) r.result.createObjectStore("r",{keyPath:"id"}); };
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    }));
  },
  async tx(mode,fn){
    const db = await this.open();
    return new Promise((res,rej)=>{
      const t = db.transaction("r",mode), s = t.objectStore("r");
      let out; try{ out = fn(s) }catch(e){ rej(e); return }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  put(rec){ return this.tx("readwrite", s => s.put(rec)) },
  get(id){  return this.tx("readonly",  s => s.get(id)).then(r => (r && r.id) ? r : null) },
  del(id){  return this.tx("readwrite", s => s.delete(id)) },
  all(){    return this.tx("readonly",  s => s.getAll()) },
};

/* 撮った写真を縮小して data URL に */
function shrink(file, max=1600, q=0.72){
  return new Promise((res,rej)=>{
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max/Math.max(img.width,img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1,Math.round(img.width*k));
      c.height= Math.max(1,Math.round(img.height*k));
      const g = c.getContext("2d");
      g.fillStyle="#fff"; g.fillRect(0,0,c.width,c.height);
      g.drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      res({data:c.toDataURL("image/jpeg",q), w:c.width, h:c.height});
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("この画像は読み込めませんでした")) };
    img.src = url;
  });
}

/* ═══════════════ 領収書の写真をドライブへ ═══════════════
   撮った写真は端末（IndexedDB）に置いてから、つながっていればすぐ 利用者/<自分>/領収書/<年>/ に上げる。
   上げた写真のIDを記録（photoId）に入れ、ほかの端末は一覧の「写真」を押したときに受け取る。
   つながらないときは端末に残し、つながったときに送る（送れていない間は「未送信」と出す）。
   撮り直し・削除で要らなくなった写真はドライブのゴミ箱へ（送れないときは、あとで送る）。 */
let SHOTS = new Set();                 /* この端末にある、自分の写真のキー */
async function refreshShots(){
  try{ SHOTS = new Set((await IDB.all()).filter(r => r && r.data && (!r.owner || r.owner === ME.email)).map(r => r.id)) }
  catch(e){ SHOTS = new Set() }
}
async function putShot(rec){
  rec.owner = ME.email;
  await IDB.put(rec); SHOTS.add(rec.id);
}
async function uploadShot(rec, date, recId){
  try{
    const r = await api("uploadReceipt", {data: String(rec.data).split(",")[1] || "", date, recId});
    if(!r.ok) return null;
    rec.driveId = r.fileId; rec.name = r.name;
    await putShot(rec);
    return r.fileId;
  }catch(e){ return null }
}
function trashLater(fileId){
  if(!fileId) return;
  const q = LS.get("trashQ", []);
  if(q.indexOf(fileId) < 0) q.push(fileId);
  LS.set("trashQ", q); drawPend(); pumpPhotos();
}
/* 撮ったが記録に使わなかった写真を片づける */
async function discardShot(id){
  if(!id) return;
  const rec = await IDB.get(id).catch(() => null);
  if(rec && rec.driveId) trashLater(rec.driveId);
  IDB.del(id).catch(()=>{}); SHOTS.delete(id);
}
const unsentShots = () => (D.entries||[]).filter(e => e.receiptId && !e.photoId && SHOTS.has(e.receiptId));

let PUMP_BUSY = false;
async function pumpPhotos(){
  if(PUMP_BUSY || !ME.email || !navigator.onLine) return;
  PUMP_BUSY = true;
  try{
    const q = LS.get("trashQ", []);
    while(q.length){
      const r = await api("trashReceipt", {fileId:q[0]}).catch(() => null);
      if(!r || (!r.ok && r.code !== "FORBIDDEN")) break;
      q.shift(); LS.set("trashQ", q);
    }
    let sent = 0;
    for(const e of unsentShots()){
      const rec = await IDB.get(e.receiptId).catch(() => null);
      if(!rec || !rec.data) continue;
      const fid = rec.driveId || await uploadShot(rec, e.date, e.id);
      if(!fid) break;
      const row = D.entries.find(x => x.id === e.id);
      if(row && !row.photoId){ row.photoId = fid; saveD(); sent++ }
    }
    if(sent && $("p-rec").classList.contains("on") && S.setupDone && RECTAB === "keihi") drawLedger();
  }finally{ PUMP_BUSY = false; drawPend() }
}

/* ═══════════════ 領収書の読み取り ═══════════════
   上げた写真のIDで GAS に頼み、Gemini が写真から金額・日付・相手先・品目を読む（写真は2回送らない）。
   空いている欄だけを埋める（手で入れたものは上書きしない）。科目と按分は自分で選ぶ。 */
var OCR = {busy:false, msg:"", file:""};

/* Gemini が金額・日付を返さなかったときの受け皿。写真の文字の並びから拾う */
function ocrRules(txt){
  const lines = String(txt).split("\n").map(s => s.trim()).filter(Boolean);
  const flat  = lines.join("\n");
  let amount = null;
  const m = flat.match(/合\s*計[^0-9]{0,12}([0-9][0-9,]*)/);
  if(m) amount = +m[1].replace(/,/g, "");
  if(!amount){
    const cand = lines.filter(l => !/預|釣|銭|ポイント|消費税|内税|外税/.test(l))
                      .map(l => { const x = l.match(/([0-9][0-9,]{1,8})\s*円/); return x ? +x[1].replace(/,/g,"") : 0 });
    amount = Math.max(0, ...cand) || null;
  }
  let date = null;
  const d = flat.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
            flat.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if(d) date = ocrDate(d[1] + "-" + d[2] + "-" + d[3]);
  return {amount:amount, date:date, payee:(lines[0] || null), item:null};
}

/* 返ってきた日付を YYYY-MM-DD に整える。読めなければ null（＝日付は触らない） */
function ocrDate(v){
  const s = String(v || "").trim().replace(/[／\/．.]/g, "-").replace(/\s/g, "");
  const w = s.match(/^(?:令和|R)-?(\d{1,2})[年-](\d{1,2})[月-](\d{1,2})日?$/);  /* 令和8年9月7日 */
  const g = s.match(/^(\d{4})[年-](\d{1,2})[月-](\d{1,2})日?$/);               /* 2026-9-7・2026年9月7日 */
  const p = w ? [2018 + (+w[1]), +w[2], +w[3]] : g ? [+g[1], +g[2], +g[3]] : null;
  if(!p || p[1] < 1 || p[1] > 12 || p[2] < 1 || p[2] > 31) return null;
  if(p[0] < 2000 || p[0] > 2100) return null;
  return p[0] + "-" + String(p[1]).padStart(2,"0") + "-" + String(p[2]).padStart(2,"0");
}


async function ocrRun(){
  if(OCR.busy) return;
  if(!REC.receiptId){ OCR = {busy:false, msg:"先に写真を撮る・選んでください。", file:""}; drawRec(); return }

  const rec = await IDB.get(REC.receiptId).catch(() => null);
  let fid = (rec && rec.driveId) || (REC.receiptId === REC.origReceiptId ? REC.origPhotoId : null);
  if(!fid){
    if(!rec || !rec.data){ OCR = {busy:false, msg:"写真を読み出せませんでした。", file:""}; drawRec(); return }
    OCR = {busy:true, msg:"写真をドライブへ送っています…", file:""}; drawRec();
    fid = await uploadShot(rec, REC.date, REC.id || REC.pid);
    if(!fid){ OCR = {busy:false, msg:"写真をドライブへ送れませんでした。電波のよい場所で、もう一度押してください。", file:""}; drawRec(); return }
  }

  OCR = {busy:true, msg:"領収書を読み取っています。10秒ほどかかります…", file:""}; drawRec();
  let res;
  try{ res = await api("ocr", {fileId:fid}) }catch(e){ res = {ok:false, message:e.message} }
  const name = res.fileName || (rec && rec.name) || "";
  if(res.ok && res.history){
    OCR = {busy:false, file:name, history: historyRows(res.history), card: res.history.card || "",
      msg: "交通系ICカードの利用履歴として読み取りました。記録する乗車を選んでください。"};
    drawRec(); return;
  }
  const askDesk = name ?"デスクに頼むときは「" + name + " を読み取って」と伝えてください（写真はドライブに保存済みです）。" : "";

  if(!res.ok){
    OCR = {busy:false, file:name, msg: res.code === "OCR_EMPTY"
      ? "この写真からは文字を読み取れませんでした。金額などは下の欄に入れてください。" + askDesk
      : res.code === "NOT_RECEIPT"
      ? "この写真は、1回の支払いの領収書・レシートではないようです（利用履歴や明細の一覧など）。1回分ずつ、金額・日付・相手先を下の欄に入れてください。"
      : "読み取れませんでした。" + (res.message || "") + " 金額などは下の欄に入れてください。"};
    drawRec(); return;
  }

  /* 金額か日付が取れなかったときは、写真の文字の並びから拾う。
     相手先は拾わない（文字の1行目は店名とは限らず、画面の時刻などが入ることがある） */
  let j = res.result || {};
  if(j.text && (!(+j.amount > 0) || !j.date)){
    const r2 = ocrRules(j.text);
    j = {amount: +j.amount > 0 ? j.amount : r2.amount, date: j.date || r2.date, payee: j.payee, item: j.item};
  }

  const got = [];
  /* 「1,200」「¥600」「600円」で返ってくることがあるので数字だけ取り出す */
  const rawA = j && j.amount;
  const amt  = Math.round(Number(typeof rawA === "string" ? rawA.replace(/[^0-9.]/g,"") : rawA));
  if(isFinite(amt) && amt > 0 && !(+REC.amount > 0)){ REC.amount = amt; got.push(yen(amt)) }

  const dt = ocrDate(j && j.date);
  if(dt && dt !== REC.date){ REC.date = dt; got.push(dt) }
  const pe = String((j && j.payee) || "").trim();
  if(pe && !REC.payee){ REC.payee = pe.slice(0,60); got.push(REC.payee) }
  const it = String((j && j.item) || "").trim();
  if(it && !REC.memo){ REC.memo = it.slice(0,40); got.push(REC.memo) }

  OCR = {busy:false, file:name, msg: got.length
    ? "読み取りました：" + got.join("／") + "　違っていれば直してください。科目と按分は下で選んでください。"
    : "文字は取れましたが、金額と日付を読み分けられませんでした。下の欄に入れてください。" + askDesk};
  drawRec();
}

/* ═══════════════ 交通系ICカードの利用履歴 ═══════════════
   利用履歴の画面を読み取ったら、乗車を1件ずつ一覧にし、選んだものをまとめて交通費として記録する。
   台帳にすでにある乗車（同じ日付・金額で、区間が摘要にある／勘定科目が旅費交通費）は「記録済み」としてチェックを外す。 */
/* 年が写っていない日付は今日の年。今日より先になるなら前の年 */
function histDate(s){
  const t = String(s || "").trim();
  const full = ocrDate(t);
  if(full) return full;
  const m = t.match(/^(\d{1,2})[\/\-.月](\d{1,2})日?$/);
  if(!m) return null;
  const now = today(), y = +now.slice(0,4);
  const d = `${y}-${String(+m[1]).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`;
  return d > now ? `${y-1}${d.slice(4)}` : d;
}
const routeOf = r => [r.from, r.to].filter(Boolean).join("→");
function historyRows(h){
  const used = new Set();
  return (h.rows || []).map(r => {
    const date = histDate(r.date), ride = r.kind === "ride" && !!date;
    const row = {date, kind:r.kind, from:r.from || "", to:r.to || "", amount:+r.amount || 0, dup:false, on:false};
    if(!ride) return row;
    const same = D.entries.filter(e => !used.has(e.id) && e.date === date && +e.amount === row.amount);
    const hit = same.find(e => routeOf(row) && String(e.memo || "").includes(routeOf(row)))
             || same.find(e => e.kamoku === "旅費交通費");
    if(hit){ used.add(hit.id); row.dup = true }
    row.on = !row.dup;
    return row;
  });
}
/* 同じ写真をほかの記録も使っているか（利用履歴から作った記録は、1枚の写真を共有する） */
const photoShared = (receiptId, photoId, exceptId) =>
  D.entries.some(e => e.id !== exceptId && ((receiptId && e.receiptId === receiptId) || (photoId && e.photoId === photoId)));

function historyPanel(){
  const rows = OCR.history || [];
  const w = el(`<div class="card" style="margin-top:12px"><ul class="hist"></ul></div>`);
  const ul = w.querySelector("ul");
  const KIND = {charge:"チャージ（経費にしない）", purchase:"買い物（1件ずつ手で）", other:"そのほか（1件ずつ手で）"};
  rows.forEach(r => {
    const ride = r.kind === "ride" && r.date;
    const li = el(`<li>
      ${ride ? `<input type="checkbox" style="width:20px;height:20px;flex:0 0 auto"${r.on?" checked":""}>` : `<span style="width:20px;flex:0 0 auto"></span>`}
      <span class="hbody"><span class="ht">${ride ? esc(routeOf(r) || "乗車") : esc(KIND[r.kind] || "そのほか")}${r.dup?`<span class="tag" style="color:var(--ok);border:1px solid var(--ok-line);background:var(--ok-soft)">記録済み</span>`:""}</span>
      <span class="hs">${esc(r.date || "日付不明")}${!ride && r.from ? " ・ " + esc(r.from) : ""}</span></span>
      <span class="hamt"${ride?"":` style="color:var(--ink3)"`}>${yen(r.amount)}</span></li>`);
    const cb = li.querySelector("input");
    if(cb) cb.onchange = () => { r.on = cb.checked; drawHistoryBtn() };
    ul.appendChild(li);
  });
  const btn = el(`<button class="go" id="histSave" style="margin-top:12px"></button>`);
  btn.onclick = recordHistory;
  const note = el(`<p class="qhint" style="margin:8px 0 0">勘定科目は旅費交通費、摘要は区間で記録します。だれと・何のための移動かは、あとで台帳の各行の「更新」から摘要に足してください。</p>`);
  const box = el(`<div></div>`);
  box.appendChild(w); box.appendChild(btn); box.appendChild(note);
  return box;
}
function drawHistoryBtn(){
  const b = $("histSave"); if(!b) return;
  const n = (OCR.history || []).filter(r => r.on).length;
  b.textContent = n ? `選んだ ${n} 件を交通費として記録する` : "記録する乗車を選んでください";
  b.disabled = !n;
}
function recordHistory(){
  const pick = (OCR.history || []).filter(r => r.on && r.kind === "ride" && r.date);
  if(!pick.length) return;
  const keep = REC;
  const cat = CATS.find(c => c.id === "transport");
  pick.forEach(r => {
    /* 手で入れるときと同じ初期の答えで判定する（業務のための移動・事業専用 など） */
    REC = Object.assign(blankRec(), {catId:"transport", date:r.date, amount:r.amount});
    resetAns();
    const {v} = computeJudge();
    D.entries.push({id:uid(), date:r.date, amount:r.amount, ratio:100, biz:r.amount, kamoku:REC.kamoku,
      payee: OCR.card || "交通系ICカード", memo: routeOf(r), catName: cat.n, verdict:v,
      receiptId: keep.receiptId, photoId:null, ans:Object.assign({}, REC.ans)});
  });
  saveD(); pumpPhotos();
  REC = blankRec(); resetAns(); OCR = {busy:false, msg:"", file:""};
  drawRec(); drawLedger(); drawYears();
  say(`${pick.length}件を交通費として記録しました。`);
  window.scrollTo({top:0,behavior:"smooth"});
}

/* ═══════════════ ファイル保存（CSV） ═══════════════ */
/* 保存先フォルダは指定できないため、ファイル名を「名前＿年＿種類」で固定して年ごとにまとめる */
const safeName = s => String(s||"").replace(/[\\\/:*?"<>|]/g,"").trim() || "経費判定君";
const fname = (year, kind, ext) => `${safeName(S.exportName)}_${year}_${kind}.${ext||"csv"}`;
/* ブラウザのダウンロードで保存する。iPhone のホーム画面アプリはダウンロードできないことがあるので、
   そのときは共有メニュー（「ファイルに保存」など）にファイルを渡す。どちらもだめならコピーする。 */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_STANDALONE = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
async function saveFile(filename, text, btn){
  const label = btn ? btn.textContent : null;
  const flash = m => { if(btn){ btn.textContent = m; setTimeout(()=>btn.textContent = label, 2200); } };
  // Excelで文字化けしないよう BOM を付ける
  const body = /\.csv$/i.test(filename) ? "﻿" + text : text;
  const type = /\.csv$/i.test(filename) ? "text/csv" : "application/json";
  if(IS_IOS && IS_STANDALONE && navigator.canShare){
    try{
      const file = new File([body], filename, {type});
      if(navigator.canShare({files:[file]})){ await navigator.share({files:[file]}); flash("保存しました"); return }
    }catch(e){ if(e && e.name === "AbortError"){ flash("保存をやめました"); return } }
  }
  try{
    const url = URL.createObjectURL(new Blob([body], {type}));
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    flash("保存しました"); return;
  }catch(e){ /* 下でコピーを試す */ }
  try{ await navigator.clipboard.writeText(text); flash("コピーしました"); }
  catch(err){ flash("保存もコピーもできませんでした"); }
}

/* ═══════════════ 勘定科目（青色申告決算書 一般用の並び） ═══════════════ */
const KAMOKU = [
  "租税公課","荷造運賃","水道光熱費","旅費交通費","通信費","広告宣伝費","接待交際費",
  "損害保険料","修繕費","消耗品費","減価償却費","福利厚生費",
  "給料賃金","外注工賃","利子割引料","地代家賃","貸倒金",
  "会議費","新聞図書費","研修費","支払手数料","車両費","諸会費",
  "雑費","専従者給与",
];
/* 決算書に印字済みの科目（それ以外は空欄行に自分で書く） */
const KAMOKU_FIXED = new Set(["租税公課","荷造運賃","水道光熱費","旅費交通費","通信費","広告宣伝費","接待交際費","損害保険料","修繕費","消耗品費","減価償却費","福利厚生費","給料賃金","外注工賃","利子割引料","地代家賃","貸倒金","雑費","専従者給与"]);
const qty8 = n => +(+n||0).toFixed(8);
/* 経費にしないもの */
const NOT_EXPENSE = ["経費にしない（所得控除）","経費にしない（資産に計上）","経費にしない（家事費）"];
const ALL_KAMOKU = [...KAMOKU, ...NOT_EXPENSE];

const CAT_KAMOKU = {
  meal_client:"接待交際費", meal_meeting:"会議費", meal_solo:"会議費", meal_staff:"福利厚生費",
  gift:"接待交際費", keicho:"接待交際費",
  travel:"旅費交通費", transport:"旅費交通費", parking:"旅費交通費", car_run:"車両費", car_buy:"減価償却費",
  home_office:"地代家賃", shataku:"地代家賃",
  supplies:"消耗品費", pc_asset:"消耗品費", clothes:"消耗品費",
  outsourcing:"外注工賃", senju:"専従者給与",
  book_seminar:"新聞図書費", subscription:"通信費", comm:"通信費",
  ad:"広告宣伝費", kyosai:"損害保険料", kaihi:"諸会費", health:"福利厚生費",
  client_cost:"旅費交通費", seminar_host:"支払手数料", hojokin:"消耗品費",
};

/* ═══════════════ 小道具 ═══════════════ */
const yen = n => "¥" + Math.round(n||0).toLocaleString("ja-JP");
const F  = (level,text,src) => ({level,text,src});
const isHojin = () => S.entity==="hojin";
const el = (h) => { const t=document.createElement("template"); t.innerHTML=h.trim(); return t.content.firstElementChild; };
const esc = s => String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* この画面ではブラウザの confirm/alert/prompt が出せない（サンドボックスが黙って握りつぶす）。
   確認や通知は必ず下の say()／ask() を使う。confirm を使うと「いいえ」を押した扱いになり、無反応になる。 */
function say(msg){
  document.querySelectorAll(".toast").forEach(x=>x.remove());
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2800);
}
function ask(msg, okLabel){
  return new Promise(res=>{
    const m = el(`<div class="modal"><div class="box">
      <p class="mt">確認</p>
      <p class="mb">${esc(msg)}</p>
      <div class="mrow">
        <button class="go" style="margin:0;flex:1">${esc(okLabel||"はい")}</button>
        <button class="ghost" style="flex:1">やめる</button>
      </div></div></div>`);
    const bs = m.querySelectorAll("button");
    const done = v => { document.removeEventListener("keydown", key, true); m.remove(); res(v) };
    const key = e => { if(e.key==="Escape"){ e.preventDefault(); done(false) } };
    bs[0].onclick = () => done(true);
    bs[1].onclick = () => done(false);
    m.onclick = e => { if(e.target===m) done(false) };
    document.addEventListener("keydown", key, true);
    document.body.appendChild(m);
    bs[0].focus();
  });
}

/* ═══════════════ 出典 ═══════════════ */
const R = {
  keihi:   ["No.2210 必要経費の知識","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm"],
  kaji:    ["所得税基本通達 45-1・45-2（家事関連費）","https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/07/01.htm"],
  kosai:   ["No.5265 交際費等の範囲と損金不算入額の計算","https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5265.htm"],
  fukuri:  ["No.5261 交際費等と福利厚生費との区分","https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5261_qa.htm"],
  shokuji: ["No.2594 食事を支給したとき","https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2594.htm"],
  shokuji2:["食事の現物支給に係る所得税の非課税限度額の引上げ","https://www.nta.go.jp/users/gensen/2026shokuji/index.htm"],
  shataku: ["No.2600 役員に社宅などを貸したとき","https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2600.htm"],
  shogaku: ["No.5403 少額の減価償却資産になるかどうかの判定の例示","https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5403.htm"],
  tokurei: ["No.5408 中小企業者等の少額減価償却資産の取得価額の損金算入の特例","https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5408.htm"],
  chuko:   ["No.5404 中古資産の耐用年数","https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5404.htm"],
  genka:   ["No.2100 減価償却のあらまし","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm"],
  senju:   ["No.2075 青色事業専従者給与と事業専従者控除","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2075.htm"],
  jigyo:   ["No.1350 事業所得の課税のしくみ","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm"],
  invoice: ["インボイス制度 令和8年度税制改正特集","https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm"],
  shogakuT:["少額特例（一定規模以下の事業者に対する事務負担の軽減措置）","https://www.nta.go.jp/publication/pamph/shohi/kaisei/202304/02.htm"],
  shiire:  ["No.6496 仕入税額控除をするための帳簿及び請求書等の保存","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6496.htm"],
  tebiki:  ["令和7年分 確定申告の手引き・様式一覧","https://www.nta.go.jp/taxes/shiraberu/shinkoku/syotoku/r07.htm"],
  hojokin: ["No.2202 国庫補助金等を受け取ったとき","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2202.htm"],
  gensen:  ["No.2795 原稿料や講演料等を支払ったとき","https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2795.htm"],
  gensen2: ["No.2792 源泉徴収が必要な報酬・料金等とは","https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2792.htm"],
  gensen3: ["No.2793 報酬・料金等の源泉徴収義務者","https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2793.htm"],
  crypto:  ["No.1524 暗号資産を使用することにより利益が生じた場合の課税関係","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1524.htm"],
  crypto2: ["暗号資産等に関する税務上の取扱い及び計算書について","https://www.nta.go.jp/publication/pamph/shotoku/kakuteishinkokukankei/kasoutuka/"],
  stock1:  ["No.1463 株式等を譲渡したときの課税（申告分離課税）","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1463.htm"],
  stock2:  ["No.1463 株式等を譲渡したときの課税（申告分離課税）","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1463.htm"],
  stock3:  ["No.1476 特定口座制度","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1476.htm"],
  fx1:     ["No.1521 外国為替証拠金取引（FX）の課税関係","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1521.htm"],
  fx2:     ["No.1522 先物取引に係る雑所得等の課税の特例","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1522.htm"],
  fx3:     ["No.1523 先物取引の差金等決済に係る損失の繰越控除","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1523.htm"],
  zatsu:   ["所得税基本通達 35-2（事業所得と業務に係る雑所得の区分）","https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/04/09.htm"],
  kyuyo:   ["No.1410 給与所得控除","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1410.htm"],
  kyuyo2:  ["No.1900 給与所得者で確定申告が必要な人","https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900_qa.htm"],
};

/* 給与所得控除（令和7年分以降）／No.1410 */
function kyuyoKojo(sh){
  if(sh <= 1900000) return Math.min(sh, 650000);
  if(sh <= 3600000) return sh*0.30 + 80000;
  if(sh <= 6600000) return sh*0.20 + 440000;
  if(sh <= 8500000) return sh*0.10 + 1100000;
  return 1950000;
}
const kyuyoShotoku = sh => Math.max(0, Math.floor(sh - kyuyoKojo(sh)));

/* 個人で給与の支払がなければ、報酬・料金の源泉徴収義務がない（ホステス等を除く） */
function needsGensen(){ return isHojin() || S.kyuyo==="ari"; }
function gensenNote(o){
  if(needsGensen()){
    o.tax.push(F("warn","個人へ支払う報酬・料金は<b>源泉徴収が必要</b>です。100万円以下は 10.21%、100万円超の部分は（支払額−100万円）×20.42%＋102,100円。<b>支払った月の翌月10日まで</b>に納付します。徴収漏れは支払者の責任です。",R.gensen[0]));
    o.tax.push(F("info","請求書で報酬額と消費税額が明確に区分されていれば、報酬額のみを源泉徴収の対象にして構いません。",R.gensen[0]));
  } else {
    o.tax.push(F("ok","<b>源泉徴収は不要です。</b>個人であって給与等の支払をしていない場合、報酬・料金の源泉徴収義務がありません（ホステス等への報酬を除く）。設定で「給与の支払 あり」に変えると判定が変わります。",R.gensen3[0]));
  }
  o.refs.push(R.gensen,R.gensen2,R.gensen3);
}

/* ═══════════════ 共通の質問 ═══════════════ */
const Q_COMMON_HEAD = [
  {id:"amount",type:"num",label:"金額（税込）",unit:"円",def:0,hint:"レシートの合計額を入れてください。"},
];
const Q_COMMON_TAIL = [
  {id:"relate",type:"seg",label:"「誰に・何のために」を説明できますか",
   hint:"税務調査で最初に聞かれます。答えられない支出はここで落ちます。",
   opts:[["yes","はっきり説明できる"],["weak","少し曖昧"],["no","説明が難しい"]],def:"yes"},
  {id:"mix",type:"seg",label:"私用と兼ねていますか",
   opts:[["biz","事業専用"],["mixed","事業と私用の兼用"],["priv","ほぼ私用"]],def:"biz"},
  {id:"ratio",type:"ratio",label:"事業で使う割合",showIf:a=>a.mix==="mixed",
   hint:"時間・面積・距離・使用回数など、あとで説明できる基準で決めてください。",def:50},
  {id:"doc",type:"seg",label:"手元にある書類",
   opts:[["invoice","適格請求書（登録番号あり）"],["receipt","領収書・レシートのみ"],["none","記録なし"]],def:"receipt"},
  {id:"pay",type:"seg",label:"支払方法",
   opts:[["card","事業用カード"],["bank","口座振込"],["cash","現金・個人カード"]],def:"card"},
];

/* ═══════════════ 中古資産の耐用年数（簡便法） ═══════════════ */
function chukoNen(legal, months){
  const e = months/12;
  const y = (e>=legal) ? legal*0.2 : (legal-e)+e*0.2;
  return Math.max(2, Math.floor(y));
}

/* ═══════════════ 費目定義 ═══════════════ */
const CATS = [
/* ── 飲食 ── */
{id:"meal_client",g:"飲食",n:"接待・会食",s:"社外の人と",acct:{kojin:"接待交際費",hojin:"交際費／会議費"},
 q:[{id:"people",type:"num",label:"参加人数（自分を含む）",unit:"人",def:2},
    {id:"outside",type:"seg",label:"社外の人（取引先・見込客など）は同席していますか",opts:[["y","同席あり"],["n","社内・自分だけ"]],def:"y"},
    {id:"record",type:"seg",label:"日付・店名・参加者の氏名と関係をメモに残せますか",hint:"1人1万円以下で交際費から外すには、この記録の保存が要件です。",opts:[["y","残せる"],["n","残せない"]],def:"y"}],
 judge(a,o){
   const per = a.people>0 ? a.amount/a.people : a.amount;
   o.tax.push(F("info",`1人あたり <b>${yen(per)}</b>（${yen(a.amount)} ÷ ${a.people}人）。`));
   if(a.people<=1){ o.tax.push(F("ng","1人での飲食は、生活費との区別がつかず否認されやすい代表格です。相手がいない飲食は経費に入れないのが安全です。")); return; }
   if(a.outside==="n"){
     if(isHojin()){
       o.tax.push(F("warn","社内だけの飲食は<b>1人1万円以下の除外基準が使えません</b>（この基準は社外の人が同席する飲食費だけが対象）。法人では原則すべて交際費となり、年800万円の枠を使います。",R.kosai[0]));
     } else {
       o.tax.push(F("info","社内だけの飲食は1人1万円の除外基準の対象外ですが、個人事業では交際費に上限がないため、必要経費になるかどうかは変わりません。",R.kosai[0]));
     }
   } else if(per<=10000){
     if(a.record==="y"){
       o.tax.push(F("ok","1人あたり1万円以下＋記録の保存あり。<b>交際費等から除外</b>できます（令和6年4月1日以後の支出。それ以前は5,000円基準）。",R.kosai[0]));
       if(isHojin()) o.tax.push(F("ok","法人では交際費の800万円枠を使わずに、全額を会議費などで損金にできます。"));
     } else if(isHojin()){
       o.tax.push(F("ng","1万円以下でも<b>記録がなければ除外できません</b>。参加者の氏名と関係を書いた書類の保存が法令上の要件です。全額が交際費になり、800万円の枠を使います。",R.kosai[0]));
     } else {
       o.tax.push(F("warn","記録がないため1万円の除外基準は使えませんが、個人事業では交際費に上限がないので必要経費にはなります。相手と目的だけはメモに残してください。",R.kosai[0]));
     }
   } else {
     if(isHojin()){
       o.tax.push(F("warn",`1人あたり1万円を超えています（${yen(per)}）。<b>全額が交際費</b>です（1円でも超えると全額。店ごとに判定）。中小法人は年800万円まで全額損金、または接待飲食費の50%損金の選択制。枠の残りを確認してください。`,R.kosai[0]));
     } else {
       o.tax.push(F("info",`1人あたり1万円を超えるため交際費に区分します（${yen(per)}）。個人事業は交際費に上限がないので、事業関連であれば全額が必要経費です。`,R.kosai[0]));
     }
   }
   if(a.amount>=30000) o.cpa.push(F("info","1回の飲食を複数の領収書に分けて金額を下げるのは脱税と判断されます。分割はしないでください。"));
   o.ev.push("参加者の氏名・会社名・自分との関係を書いたメモ","店名と所在地が分かる領収書","打合せの目的（案件名）");
   o.gyo.push(F("info","接待の報告書を1枚の様式に決めておくと、記録の保存要件を自動的に満たせます。領収書の裏に書くだけでも構いません。"));
   o.refs.push(R.kosai,R.fukuri);
 }},

{id:"meal_meeting",g:"飲食",n:"打合せの飲食",s:"会議・商談",acct:{kojin:"会議費",hojin:"会議費"},
 q:[{id:"place",type:"seg",label:"場所",opts:[["office","会議室・カフェ・昼の飲食店"],["night","居酒屋・夜の飲食店"]],def:"office"},
    {id:"minutes",type:"seg",label:"議事録や打合せメモを残せますか",hint:"会議費は「業務の議論が主目的」であることが要件です。メモが唯一の証明になります。",opts:[["y","残せる"],["n","残せない"]],def:"y"}],
 judge(a,o){
   if(a.minutes==="n") o.tax.push(F("ng","議事録・打合せメモがない会議費は、会議の実態を証明できず否認されます。決めたこと3行でも構いません、必ず残してください。"));
   else o.tax.push(F("ok","議事録があれば会議費として通ります。日付・参加者・議題・決めたことの4点を書いてください。"));
   if(a.place==="night") o.tax.push(F(isHojin()?"warn":"info","夜の飲食店は、会議費ではなく<b>交際費</b>と判断されるのが通常です。"+(isHojin()?"接待として扱い、1人1万円基準で判定し直してください。":"個人事業では交際費に上限がないため、必要経費になるかどうかは変わりません。"),R.kosai[0]));
   o.cpa.push(F("info","会議室代・コーヒー・軽食は会議費。ただし毎日のように外で食事していると、生活費とみなされます。"));
   o.ev.push("議事録または打合せメモ（日付・参加者・議題・結論）","領収書");
   o.refs.push(R.kosai,R.keihi);
 }},

{id:"meal_solo",g:"飲食",n:"1人の飲食",s:"カフェ作業など",acct:{kojin:"会議費／雑費",hojin:"会議費／雑費"},
 q:[{id:"kind",type:"seg",label:"内容",opts:[["cafe","作業場所として使ったカフェ代"],["food","食事"]],def:"cafe"},
    {id:"work",type:"seg",label:"そこで何の作業をしたか記録できますか",opts:[["y","できる"],["n","できない"]],def:"y"}],
 judge(a,o){
   if(a.kind==="food"){
     o.tax.push(F("ng","1人での食事は<b>生活費</b>です。誰でも食事はするため、事業のために特別に必要だったと説明できません。経費に入れないでください。",R.kaji[0]));
     return;
   }
   if(a.work==="y"){
     o.tax.push(F("ok","カフェを作業場所として使った「場所代」は、作業内容を記録していれば経費になります。席の利用が目的で、食事が含まれていないことが前提です。"));
     o.cpa.push(F("info","レシートに作業内容（案件名・何をしたか）を1行書いてください。回数が多いなら、コワーキングスペースの月額契約に切り替えたほうが説明が要りません。"));
   } else {
     o.tax.push(F("ng","作業内容を記録できないカフェ代は、私的な飲食と区別がつきません。"));
   }
   if(a.amount>=2000) o.tax.push(F("warn","場所代として説明するには金額が大きいです。食事が含まれていないか確認してください。"));
   o.ev.push("レシート（作業内容を裏に記入）");
   o.refs.push(R.keihi,R.kaji);
 }},

{id:"meal_staff",g:"飲食",n:"従業員との飲食",s:"食事補助・懇親会",acct:{kojin:"福利厚生費",hojin:"福利厚生費"},
 q:[{id:"who",type:"seg",label:"対象",opts:[["all","従業員全員が対象"],["some","一部だけ"],["exec","役員（自分）だけ"]],def:"all"},
    {id:"style",type:"seg",label:"形態",opts:[["event","懇親会・忘年会など単発"],["monthly","毎月の食事補助"]],def:"event"},
    {id:"selfpay",type:"num",label:"本人（従業員）の自己負担割合",unit:"%",def:50,showIf:a=>a.style==="monthly"},
    {id:"burden",type:"num",label:"会社負担額（1人あたり・月）",unit:"円",def:0,showIf:a=>a.style==="monthly"}],
 judge(a,o){
   if(!isHojin() && a.who!=="exec"){
     o.tax.push(F("info","個人事業では、事業主本人は福利厚生の対象になりません。従業員がいる場合だけ福利厚生費が成立します。"));
   }
   if(a.who==="exec"){
     o.tax.push(F("ng","役員・事業主だけの飲食は福利厚生費になりません。法人なら<b>役員給与</b>として源泉徴収の対象、個人事業なら家事費です。",R.fukuri[0]));
     return;
   }
   if(a.who==="some") o.tax.push(F("warn","一部の人だけが対象だと福利厚生費として認められにくく、その人への給与とみなされます。全員が使える制度にしてください。",R.fukuri[0]));
   if(a.style==="monthly"){
     const ok1 = a.selfpay>=50, ok2 = a.burden<=7500;
     if(ok1&&ok2) o.tax.push(F("ok",`本人負担 ${a.selfpay}%（半分以上）かつ会社負担 ${yen(a.burden)}（月7,500円以下）。<b>給与課税されません</b>。`,R.shokuji[0]));
     else {
       if(!ok1) o.tax.push(F("ng",`本人負担が ${a.selfpay}% で半分未満です。会社負担分の全額が給与として課税されます。`,R.shokuji[0]));
       if(!ok2) o.tax.push(F("ng",`会社負担が月 ${yen(a.burden)} で7,500円を超えています。超えた分ではなく<b>会社負担額の全額</b>が給与課税です。`,R.shokuji[0]));
     }
     o.tax.push(F("info","非課税限度額は<b>令和8年4月1日以後</b>に支給する食事から月7,500円（それ以前は3,500円）。消費税を除いた金額で判定します。",R.shokuji2[0]));
     o.cpa.push(F("warn","現金で食事代を渡すと、金額にかかわらず全額が給与です。<b>現物支給</b>（社員食堂・弁当・食事券）でなければ非課税になりません。"));
     o.cpa.push(F("warn","社会保険料は税とは別の基準（都道府県ごとの現物給与価額）で判定します。税だけ見て社保を見落とす例が多いところです。年金事務所の最新の価額表で確認してください。"));
     o.refs.push(R.shokuji,R.shokuji2);
   } else {
     o.tax.push(F("ok","全員が参加できる懇親会・忘年会なら福利厚生費です。社会通念上の金額であること、参加者名簿を残すことが条件。",R.fukuri[0]));
     o.refs.push(R.fukuri);
   }
   o.ev.push("参加者名簿","案内文（全員が対象と分かるもの）","領収書");
   o.gyo.push(F("info","慶弔・食事補助・懇親会を<b>福利厚生規程</b>に落としておくと、一部だけ優遇しているという疑いを断てます。就業規則とセットで作ってください。"));
 }},

{id:"gift",g:"交際",n:"贈答品・手土産",s:"お中元・お歳暮",acct:{kojin:"接待交際費",hojin:"交際費"},
 q:[{id:"to",type:"seg",label:"渡す相手",opts:[["client","取引先・見込客"],["self","自分・家族"],["unknown","決まっていない"]],def:"client"},
    {id:"list",type:"seg",label:"送り先と自分との関係を記録できますか",opts:[["y","できる"],["n","できない"]],def:"y"}],
 judge(a,o){
   if(a.to==="self"){ o.tax.push(F("ng","自分や家族に渡すものは贈答ではなく<b>家事費</b>です。経費に入れると重加算税の対象になり得ます。",R.kaji[0])); return; }
   if(a.to==="unknown") o.tax.push(F("ng","渡す相手が決まっていないものは、その時点では経費になりません。手元にあるだけなら貯蔵品です。"));
   if(a.list==="n") o.tax.push(F("ng","誰に何を渡したか説明できない贈答は、税務調査で真っ先に否認されます。送り先リストは必ず作ってください。"));
   else o.tax.push(F("ok","送り先リストがあれば交際費として通ります。相手先名・関係・品名・金額・日付の5点を残してください。"));
   if(a.amount>=30000) o.tax.push(F("warn","高額なブランド品・時計・貴金属は、私物の購入を疑われます。相手が受け取った事実（お礼状・納品書の送り先）まで揃えてください。"));
   if(isHojin()) o.tax.push(F("info","法人の交際費は原則損金不算入。中小法人（資本金1億円以下）は年800万円まで全額損金にできます。",R.kosai[0]));
   else o.tax.push(F("info","個人事業の接待交際費に上限はありません。事業関連であれば全額が必要経費です。"));
   o.ev.push("送り先リスト（相手先名・関係・品名・金額・日付）","購入時の領収書","配送伝票の控え");
   o.refs.push(R.kosai);
 }},

{id:"keicho",g:"交際",n:"慶弔費",s:"香典・祝金",acct:{kojin:"接待交際費",hojin:"交際費／福利厚生費"},
 q:[{id:"rel",type:"seg",label:"相手",opts:[["client","取引先"],["staff","従業員・その家族"],["private","親族・友人"]],def:"client"}],
 judge(a,o){
   if(a.rel==="private"){ o.tax.push(F("ng","親族・友人への香典や祝金は完全な私的支出です。事業とのつながりがありません。")); return; }
   if(a.rel==="staff") o.tax.push(F("ok","従業員とその家族への慶弔金は、慶弔規程の範囲内なら福利厚生費です。規程がないと給与になります。",R.fukuri[0]));
   else o.tax.push(F("ok","取引先への慶弔費は交際費です。",R.kosai[0]));
   o.cpa.push(F("warn","香典・祝金は領収書が出ません。<b>会葬礼状・案内状・招待状</b>を保存し、出金伝票に日付・相手・金額・関係を書いてください。これが領収書の代わりになります。"));
   o.gyo.push(F("info","金額を都度決めていると恣意的と見られます。慶弔規程で「取引先の葬儀は1万円」のように定額を決めておいてください。"));
   o.ev.push("会葬礼状・案内状・招待状","出金伝票（日付・相手・金額・関係）","慶弔規程");
   o.refs.push(R.kosai,R.fukuri);
 }},

/* ── 移動 ── */
{id:"travel",g:"移動",n:"出張・旅費",s:"宿泊を伴う",acct:{kojin:"旅費交通費",hojin:"旅費交通費"},
 q:[{id:"family",type:"seg",label:"家族が同行していますか",opts:[["n","していない"],["y","している"]],def:"n"},
    {id:"days",type:"num",label:"日数",unit:"日",def:1},
    {id:"bizdays",type:"num",label:"うち業務の日数",unit:"日",def:1},
    {id:"nitto",type:"seg",label:"日当（出張手当）を含みますか",opts:[["n","含まない"],["y","含む"]],def:"n"}],
 judge(a,o){
   if(a.family==="y") o.tax.push(F("ng","家族の分は経費になりません。宿泊費・交通費の明細で人数はすぐ分かります。<b>家族分を除いた金額</b>で申請し直してください。"));
   if(a.days>a.bizdays && a.bizdays>0){
     const r = Math.round(a.bizdays/a.days*100);
     o.tax.push(F("warn",`${a.days}日のうち業務は${a.bizdays}日。宿泊費など日数に比例する費用は <b>${r}%</b>（${yen(Math.floor(a.amount*r/100))}）が上限の目安です。往復の交通費は主目的が業務なら全額。`));
   } else if(a.bizdays<=0){
     o.tax.push(F("ng","業務の日がない旅行は経費になりません。"));
   } else {
     o.tax.push(F("ok","全日程が業務なら全額が旅費交通費です。"));
   }
   if(a.nitto==="y"){
     if(isHojin()) o.tax.push(F("warn","法人は<b>旅費規程</b>があれば役員・従業員に日当を出せます（会社は損金、受け取る側は非課税）。規程がないと給与です。"));
     else o.tax.push(F("ng","個人事業主が<b>自分に</b>日当を払っても必要経費になりません。自分に払う給与・手当という概念がないためです。従業員への日当は経費になります。"));
   }
   o.cpa.push(F("info","出張報告書（訪問先・面談者・目的・成果）を1枚残せば、この費目の指摘はほぼ防げます。"));
   o.ev.push("出張報告書（訪問先・面談者・目的）","宿泊明細（人数が分かるもの）","交通機関の領収書","スケジュール表");
   if(isHojin()) o.gyo.push(F("info","旅費規程を整えると日当が使えます。役職ごとの日当額・宿泊上限を定め、株主総会または取締役会で決議してください。"));
   o.refs.push(R.keihi,R.tebiki);
 }},

{id:"transport",g:"移動",n:"日常の移動",s:"電車・タクシー",acct:{kojin:"旅費交通費",hojin:"旅費交通費"},
 q:[{id:"mode",type:"seg",label:"手段",opts:[["public","電車・バス"],["taxi","タクシー"]],def:"public"},
    {id:"purpose",type:"seg",label:"行き先の用件",opts:[["work","打合せ・納品・現場"],["settai","接待の会場へ"],["mixed","私用と兼ねた移動"]],def:"work"}],
 judge(a,o){
   if(a.purpose==="mixed") o.tax.push(F("warn","私用と兼ねた移動は、業務のために追加でかかった分だけが経費です。往復とも私用でも行くなら経費になりません。"));
   else o.tax.push(F("ok","業務のための移動は全額が旅費交通費です。"));
   if(a.purpose==="settai") o.tax.push(F("warn","接待の会場へ向かう電車代・タクシー代は、旅費交通費ではなく<b>交際費</b>です。法人の800万円枠に入ります。",R.kosai[0]));
   if(a.mode==="public"&&a.amount<30000) o.cpa.push(F("ok","公共交通機関で税込3万円未満の運賃は、インボイスがなくても帳簿の保存だけで仕入税額控除ができます（公共交通機関特例）。",R.shiire[0]));
   if(a.mode==="taxi") o.cpa.push(F("info","タクシーはこの特例の対象外です。領収書に登録番号があるか確認してください。深夜・重い荷物など、タクシーを使った理由を1行書いておくと安全です。"));
   o.ev.push("交通系ICの利用履歴または経路メモ","訪問先が分かる予定表");
   o.refs.push(R.shiire,R.keihi);
 }},

{id:"parking",g:"移動",n:"駐車料金",s:"コインパーキング・月極",acct:{kojin:"旅費交通費",hojin:"旅費交通費"},
 q:[{id:"ptype",type:"seg",label:"駐車のしかた",
     opts:[["spot","一時（コインパーキング）"],["month","月極・定期契約"]],def:"spot"},
    {id:"pwhy",type:"seg",label:"停めた用件",showIf:a=>a.ptype!=="month",
     opts:[["work","打合せ・納品・現場"],["ride","駅に停めて電車で移動"],["settai","接待の会場へ"]],def:"work"}],
 judge(a,o){
   const y = yOf(REC.date) || YEAR;
   if(a.ptype === "month"){
     const r = carRatio(y);
     o.tax.push(F("warn","<b>月極・定期契約の駐車場は、車を持ち続けるための費用です。</b>ガソリン代や車検と同じ扱いで、事業で使う割合だけが経費になります。上の「私用と兼ねていますか」で<b>事業と私用の兼用</b>を選び、運行記録から出た割合を入れてください。",R.kaji[0]));
     if(r === null) o.tax.push(F("ng","<b>運行記録がないと按分割合を証明できません。</b>記録タブの<b>「運行」</b>で、年初・年末のメーターと業務で走った分を入れてください。",R.kaji[0]));
     else           o.tax.push(F("ok",`運行記録から、${y}年の事業使用割合は <b>${r}%</b>（業務 ${km(carBiz(y))} ÷ 総走行距離 ${km(carTotal(y))}）。`,R.kaji[0]));
     o.cpa.push(F("info","勘定科目は下の欄で<b>車両費</b>に変えてください（自宅の駐車場を事務所の一部として按分するなら地代家賃でも構いませんが、毎年同じ扱いを続けてください）。"));
     o.ev.push("駐車場の契約書","毎月の引き落としが分かる通帳","運行記録（日付・行き先・目的・走行距離）");
   } else {
     if(a.pwhy === "settai"){
       o.tax.push(F("warn","<b>接待の会場へ向かうための駐車料金は、旅費交通費ではなく交際費です。</b>会食代と同じ相手・同じ日でまとめて記録してください。法人なら800万円枠に入ります。",R.kosai[0]));
       o.cpa.push(F("info","勘定科目は下の欄で<b>接待交際費</b>に変えてください。"));
     } else {
       o.tax.push(F("ok","<b>その日の用事のために払った一時駐車は、全額が旅費交通費です。</b>ガソリン代のような走行距離の按分は要りません。タンクから私用でも減るガソリンと違い、この支出は業務のためだけに発生しているからです。",R.keihi[0]));
     }
     if(a.pwhy === "ride") o.cpa.push(F("info","最寄り駅に停めて電車で向かった場合は、<b>同じ日の運賃と一組で</b>残しておくと、移動の全体が一目で説明できます。"));
     o.tax.push(F("info","停めた先と用件を摘要に1行残してください（例：打合せのため◯◯へ、最寄り駅に駐車）。金額が小さくても、説明できるかどうかで判断が分かれます。"));
     o.ev.push("駐車券・領収書","訪問先が分かる予定表");
   }
   if(a.doc === "invoice") o.cpa.push(F("info","駐車場の精算機の券にも登録番号（Tから始まる13桁）が印字されていることがあります。あれば適格請求書として保存してください。"));
   o.refs.push(R.keihi,R.kaji);
 }},

{id:"car_run",g:"移動",n:"車の維持費",s:"ガソリン・車検・保険",acct:{kojin:"車両費",hojin:"車両費"},
 q:[],
 judge(a,o){
   const y = yOf(REC.date) || YEAR;
   const r = carRatio(y);
   if(r === null){
     o.tax.push(F("ng","<b>運行記録がないと按分割合を証明できません。</b>事業使用割合を何%と書いても、調査では根拠なしとして崩されます。記録タブの<b>「運行」</b>で、年初・年末のメーターと業務で走った分を入れてください。",R.kaji[0]));
   } else {
     o.tax.push(F("ok",`運行記録から、${y}年の事業使用割合は <b>${r}%</b>（業務 ${km(carBiz(y))} ÷ 総走行距離 ${km(carTotal(y))}）。事業走行距離 ÷ 総走行距離は、最も説明しやすい基準です。`,R.kaji[0]));
   }
   if(a.mix==="biz") o.tax.push(F("warn","車を事業専用と申告する場合、通勤・買い物などの私用が一切ないことが前提です。<b>青色申告決算書には事業使用割合を書く欄があり</b>、100%と書けばそこが確認の対象になります。",R.tebiki[0]));
   o.cpa.push(F("info","対象になるのは、ガソリン代・車検費用・自動車税・自賠責/任意保険料・月極駐車場代・修理代。すべて同じ割合で按分します。<b>業務の日の高速代・現地の駐車場代は全額を旅費交通費にできます</b>ので、駐車料金は費目の<b>「駐車料金」</b>から入れてください。"));
   o.ev.push("運行記録（日付・行き先・目的・走行距離）","給油・車検・保険の領収書","車検証の写し");
   o.refs.push(R.kaji,R.keihi,R.tebiki);
 }},

{id:"car_buy",g:"移動",n:"車の購入",s:"社用車・中古車",acct:{kojin:"車両運搬具",hojin:"車両運搬具"},
 q:[{id:"ctype",type:"seg",label:"車種",opts:[["futsu","普通乗用車（法定6年）"],["kei","軽自動車（法定4年）"],["kamotsu","小型貨物（法定5年）"]],def:"futsu"},
    {id:"used",type:"seg",label:"新車／中古",opts:[["new","新車"],["used","中古"]],def:"used"},
    {id:"months",type:"num",label:"初度登録からの経過月数",unit:"ヶ月",def:46,showIf:a=>a.used==="used"},
    {id:"timing",type:"seg",label:"取得の時期",hint:"減価償却は月割りです。期首に近いほど初年度の経費が大きくなります。",opts:[["kishu","期首（事業年度の1ヶ月目）"],["kichu","期の途中"]],def:"kishu"},
    {id:"mmonths",type:"num",label:"取得月から期末までの月数",unit:"ヶ月",def:6,showIf:a=>a.timing==="kichu"}],
 judge(a,o){
   const legal = a.ctype==="futsu"?6:a.ctype==="kei"?4:5;
   let nen = legal, how = `新車のため法定耐用年数 ${legal}年`;
   if(a.used==="used"){
     nen = chukoNen(legal, a.months);
     const e=(a.months/12).toFixed(2);
     how = `中古のため簡便法：経過${e}年 → ${a.months/12>=legal?`${legal}年 × 20%`:`(${legal}年 − ${e}年) + ${e}年 × 20%`} → 1年未満切捨て・最短2年で <b>${nen}年</b>`;
   }
   o.tax.push(F("info",`耐用年数は <b>${nen}年</b>。${how}`,R.chuko[0]));
   if(a.used==="used"&&nen===2){
     o.tax.push(F("ok","耐用年数2年は定率法の償却率1.000。<b>期首に取得すれば初年度で全額</b>を経費にできます（残存1円）。",R.genka[0]));
   }
   const m = a.timing==="kishu"?12:Math.max(0,Math.min(12,a.mmonths));
   if(a.timing==="kichu"){
     o.tax.push(F("warn",`期の途中の取得は月割りです。初年度に落とせるのは <b>${m}/12</b>。${nen===2?`全額償却を狙うなら期首に納車させてください（納車の遅れで丸1年ずれます）。`:""}`));
   }
   if(nen===2&&a.timing==="kishu") o.cpa.push(F("info",`初年度の償却費の目安：${yen(a.amount)}（事業使用割合を掛ける前）。実際は事業使用割合で按分します。`));
   else o.cpa.push(F("info",`定率法での初年度の目安：取得価額 × 償却率（耐用年数${nen}年） × ${m}/12。正確な償却率は減価償却資産の償却率表で確認してください。`,R.genka[0]));
   if(!isHojin()) o.tax.push(F("warn","個人事業の法定償却方法は<b>定額法</b>です。定率法を使うには「所得税の減価償却資産の償却方法の届出書」の提出が必要。届出がないと1年償却はできません。",R.genka[0]));
   if(a.amount>=5000000) o.tax.push(F("warn","高額車・スポーツカーは事業に必要だったかを強く問われます。同じ用途を果たす安価な車で足りないか、説明を用意してください。"));
   if(a.mix==="biz") o.tax.push(F("warn","車の事業使用割合100%は、税務調査で最も崩されやすい主張です。私用が1回でも確認されると全体の按分が崩れます。"));
   o.gyo.push(F("info","名義変更・車庫証明は行政書士の領域です。<b>車両管理規程</b>と<b>運転日報</b>を用意し、業務で使っている実態を書面で残してください。"));
   if(isHojin()) o.gyo.push(F("warn","自分の車を法人に移すなら、<b>贈与ではなく適正時価での売買</b>にしてください。贈与だと法人に受贈益、個人に譲渡所得が立ちます。役員と会社の取引は<b>利益相反取引</b>なので、株主総会（または取締役会）の決議と議事録が必要です。査定書は複数残してください。任意保険の等級引継ぎは保険会社ごとに要件が違うので、名義変更の前に確認を。"));
   o.ev.push("売買契約書・注文書","車検証の写し（初度登録年月）","車両管理規程・運転日報");
   if(isHojin()) o.ev.push("査定書（個人→法人の売買の場合・複数社）","株主総会または取締役会の議事録（利益相反取引）");
   o.refs.push(R.chuko,R.genka,R.kaji);
 }},

/* ── 場所 ── */
{id:"home_office",g:"場所",n:"自宅兼事務所",s:"家賃・光熱費",acct:{kojin:"地代家賃／水道光熱費",hojin:"—"},
 q:[{id:"own",type:"seg",label:"住まい",opts:[["rent","賃貸"],["own","持ち家"]],def:"rent"},
    {id:"basis",type:"seg",label:"按分の基準",opts:[["area","床面積"],["time","使用時間"],["other","その他"]],def:"area"},
    {id:"loan",type:"seg",label:"住宅ローン控除を受けていますか",opts:[["n","受けていない"],["y","受けている"]],def:"n",showIf:a=>a.own==="own"}],
 judge(a,o){
   if(isHojin()){ o.tax.push(F("ng","法人にはこの処理はありません。自宅を使うなら<b>役員社宅</b>として会社が契約するか、会社と個人で賃貸借契約を結んでください。費目「役員社宅」で判定し直してください。")); return; }
   o.tax.push(F("info","家事関連費は原則として必要経費になりませんが、<b>業務の遂行上必要で、その部分を明らかに区分できる</b>ときだけ、その分を必要経費にできます（所得税法施行令96条）。",R.kaji[0]));
   if(a.basis==="area") o.tax.push(F("ok","床面積での按分がいちばん説明しやすい基準です。間取り図に業務スペースを塗り、面積を書き込んで保存してください。"));
   if(a.basis==="time") o.tax.push(F("ok","時間按分も認められる基準です。稼働時間のログを残し、毎年同じ数え方にしてください。"));
   if(a.basis==="other") o.tax.push(F("warn","基準が曖昧だと按分そのものが否認されます。面積・時間・コンセント数など、数字で示せる基準を1つ決めてください。"));
   if(a.own==="own"){
     o.cpa.push(F("info","持ち家は、家賃ではなく<b>建物の減価償却費・固定資産税・火災保険料</b>を按分します。住宅ローンは<b>元本は経費にならず、利息だけ</b>が按分の対象です。"));
     if(a.loan==="y") o.tax.push(F("warn","住宅ローン控除との関係に注意。事業使用割合が大きいと控除が制限されます。事業割合を決める前に、控除の要件を必ず確認してください。金額的にはローン控除のほうが有利なことがよくあります。"));
   } else {
     o.cpa.push(F("info","賃貸なら家賃・共益費・水道光熱費・火災保険料を同じ考え方で按分します。敷金は経費になりません（返還されるため）。"));
   }
   o.tax.push(F("info","按分の割合は所得税基本通達45-2の考え方で判断します。業務に必要な部分が50%以下でも、明らかに区分できればその分は必要経費です。",R.kaji[0]));
   o.ev.push("間取り図（業務スペースを明示）","賃貸借契約書または登記事項証明書","家賃・光熱費の明細","按分計算のメモ");
   o.refs.push(R.kaji,R.keihi,R.tebiki);
 }},

{id:"shataku",g:"場所",n:"役員社宅",s:"法人のみ",acct:{kojin:"—",hojin:"地代家賃"},
 q:[{id:"contract",type:"seg",label:"賃貸借契約の名義",hint:"ここを間違えると全額が給与課税になります。",opts:[["corp","会社名義"],["person","個人名義"]],def:"corp"},
    {id:"area",type:"num",label:"床面積（共用部の按分を含む）",unit:"㎡",def:60},
    {id:"durable",type:"seg",label:"建物の法定耐用年数",opts:[["le30","30年以下（木造など）"],["gt30","30年超（RCマンションなど）"]],def:"gt30"},
    {id:"koteiB",type:"num",label:"建物の固定資産税の課税標準額",unit:"円",def:0,hint:"分からなければ0のまま。借主でも所有者の同意なく市区町村で取得できます。"},
    {id:"koteiL",type:"num",label:"敷地の固定資産税の課税標準額",unit:"円",def:0},
    {id:"selfpay",type:"num",label:"自分が会社に払っている家賃（月）",unit:"円",def:0}],
 judge(a,o){
   if(!isHojin()){ o.tax.push(F("ng","役員社宅は法人だけの制度です。個人事業では自分に社宅を貸すことができません。費目「自宅兼事務所」で判定してください。")); return; }
   if(a.contract==="person"){ o.tax.push(F("ng","<b>個人名義の契約では成立しません</b>。会社が家賃を払っても、それは役員個人の家賃の肩代わり＝全額が給与です。会社名義に切り替えるまで、この処理は使えません。",R.shataku[0])); }
   const limit = a.durable==="gt30"?99:132;
   const small = a.area<=limit;
   const gouka = a.area>240;
   if(gouka){
     o.tax.push(F("ng","床面積240㎡超は<b>豪華社宅</b>の目安に当たります。この場合は通常支払うべき使用料（＝実際の家賃相当）が賃貸料相当額になり、節税効果はなくなります。",R.shataku[0]));
   } else if(small){
     o.tax.push(F("ok",`床面積 ${a.area}㎡ は<b>小規模な住宅</b>（耐用年数${a.durable==="gt30"?"30年超は99㎡以下":"30年以下は132㎡以下"}）に当たります。賃貸料相当額が安く計算でき、効果が最も大きい形です。`,R.shataku[0]));
     if(a.koteiB>0||a.koteiL>0){
       const x1=a.koteiB*0.002, x2=12*a.area/3.3, x3=a.koteiL*0.0022;
       const t=Math.round(x1+x2+x3);
       o.tax.push(F("info",`賃貸料相当額の計算：<br>① 建物の課税標準額 ${yen(a.koteiB)} × 0.2% = ${yen(x1)}<br>② 12円 × ${a.area}㎡ ÷ 3.3㎡ = ${yen(x2)}<br>③ 敷地の課税標準額 ${yen(a.koteiL)} × 0.22% = ${yen(x3)}<br><b>合計 ${yen(t)}／月</b>`,R.shataku[0]));
       if(a.selfpay>=t) o.tax.push(F("ok",`自己負担 ${yen(a.selfpay)} は賃貸料相当額 ${yen(t)} 以上です。<b>給与課税されません</b>。会社が払う家賃と自己負担の差額が、そのまま損金になります。`,R.shataku[0]));
       else o.tax.push(F("ng",`自己負担 ${yen(a.selfpay)} が賃貸料相当額 ${yen(t)} を下回っています。差額 <b>${yen(t-a.selfpay)}／月</b> が給与として課税されます。`,R.shataku[0]));
     } else {
       o.tax.push(F("warn","固定資産税の課税標準額を入れると、賃貸料相当額（自己負担の下限）を計算します。①建物の課税標準額×0.2% ②12円×総床面積÷3.3㎡ ③敷地の課税標準額×0.22% の合計です。",R.shataku[0]));
     }
   } else {
     o.tax.push(F("warn",`床面積 ${a.area}㎡ は小規模住宅（${limit}㎡以下）を超えています。賃貸料相当額は別の式（自社所有なら建物の課税標準額×12%〈耐用年数30年超は10%〉＋敷地×6% を12で除した額／借上げなら会社が払う家賃の50%と比べて多いほう）になり、自己負担がかなり増えます。`,R.shataku[0]));
   }
   o.cpa.push(F("info","無償で貸すと賃貸料相当額の全額が、賃貸料相当額より低い家賃だと差額が、それぞれ役員給与として課税されます。毎年、固定資産税の課税標準額を取り直して再計算してください。",R.shataku[0]));
   o.gyo.push(F("info","<b>社宅規程</b>を作り、対象者・自己負担額の決め方・原状回復の負担を明記してください。既に個人で借りている部屋は、不動産会社に「法人契約に切り替えたい」と申し入れる形で移せます。名義変更手数料はかかります。"));
   o.ev.push("会社名義の賃貸借契約書","固定資産税の課税標準額が分かる書類（評価証明等）","社宅規程","給与からの自己負担額の控除記録");
   o.refs.push(R.shataku);
 }},

/* ── モノ ── */
{id:"supplies",g:"モノ",n:"消耗品",s:"10万円未満",acct:{kojin:"消耗品費",hojin:"消耗品費"},
 q:[{id:"yearend",type:"seg",label:"買った時期",opts:[["normal","期の途中"],["end","期末近くにまとめ買い"]],def:"normal"},
    {id:"used",type:"seg",label:"期内に使い始めますか",opts:[["y","使う・使い始める"],["n","在庫として残る"]],def:"y"}],
 judge(a,o){
   if(a.used==="n"||a.yearend==="end"&&a.used!=="y"){
     o.tax.push(F("ng","使っていない分は<b>貯蔵品</b>として資産に計上します。期末に大量購入して全額を経費にするのは、税務署が必ず見るところです。",R.shogaku[0]));
   } else if(a.yearend==="end"){
     o.tax.push(F(a.amount>=100000?"warn":"info","期末のまとめ買いは目立ちます。期内に使ったこと（使用開始日・設置写真・配布記録）を証明できるようにしてください。使い切れない分は貯蔵品です。"));
   } else {
     o.tax.push(F("ok","期内に使う消耗品は、その年の必要経費になります。"));
   }
   o.cpa.push(F("info","毎期おおむね同じ量を買って使っている事務用品などは、重要性が乏しいものとして買った時に経費処理して構いません。年によって大きくぶれるときは貯蔵品計上が必要です。"));
   o.ev.push("納品書・領収書","（期末購入の場合）使用開始が分かる記録");
   o.refs.push(R.shogaku,R.keihi);
 }},

{id:"pc_asset",g:"モノ",n:"PC・機材",s:"資産になるか判定",acct:{kojin:"工具器具備品／消耗品費",hojin:"工具器具備品／消耗品費"},
 q:[{id:"set",type:"seg",label:"一式でひとつの機能を果たしますか",hint:"本体とモニタを別々に買っても、セットでなければ使えないものは合計額で判定します。",opts:[["single","単体で使える"],["set","一式で1つ"]],def:"single"}],
 judge(a,o){
   const taxfree = S.shohi==="menzei";
   const base = a.amount;
   o.tax.push(F("info",`判定は<b>${taxfree?"税込":"税抜"}</b>金額で行います（${taxfree?"免税事業者・税込経理":"税抜経理"}のため）。ここでは ${yen(base)} を使います。`,R.shogaku[0]));
   if(base<100000){
     o.tax.push(F("ok","10万円未満は<b>少額の減価償却資産</b>。使い始めた年に全額を経費にできます。",R.shogaku[0]));
   } else if(base<200000){
     o.tax.push(F("ok","20万円未満なら<b>一括償却資産</b>を選べます。3年間で3分の1ずつ均等償却。償却資産税（固定資産税）の対象外になるのが利点です。",R.shogaku[0]));
     o.tax.push(F("info","30万円未満の特例（下記）と比べて、どちらが有利か検討してください。早く落としたいなら特例、償却資産税を避けたいなら一括償却です。"));
   }
   if(base>=100000&&base<300000){
     if(S.aoiro==="aoiro"){
       o.tax.push(F("warn","30万円未満は<b>中小企業者等の少額減価償却資産の特例</b>で全額経費にできます（青色申告・従業員500人以下・年間合計300万円まで）。ただし国税庁 No.5408 の適用期限は<b>令和8年3月31日まで</b>と書かれたままで延長の記載がありません。<b>2026年4月以降に買ったものは、申告前に必ず最新のページで確認してください。</b>",R.tokurei[0]));
     } else {
       o.tax.push(F("ng","30万円未満の特例は<b>青色申告が要件</b>です。白色申告では使えません。通常の減価償却か、20万円未満なら一括償却資産になります。",R.tokurei[0]));
     }
   }
   if(base>=300000){
     o.tax.push(F("info","30万円以上は通常の減価償却です。パソコンの法定耐用年数は4年（サーバー用は5年）が目安。使い始めた月から月割りで償却します。",R.genka[0]));
   }
   if(a.set==="set") o.cpa.push(F("warn","一式で1つの機能を果たすものは、<b>合計額</b>で10万・20万・30万の判定をします。分割して買っても判定は変わりません。",R.shogaku[0]));
   o.cpa.push(F("info","経費にできるのは「買った日」ではなく「事業に使い始めた日」の属する年です。年末に買って翌年セットアップだと翌年分になります。"));
   o.ev.push("納品書・領収書（型番と金額）","使用開始日が分かる記録","（特例利用時）少額減価償却資産の明細");
   o.refs.push(R.shogaku,R.tokurei,R.genka);
 }},

{id:"clothes",g:"モノ",n:"衣服・美容",s:"スーツ・眼鏡など",acct:{kojin:"消耗品費／雑費",hojin:"消耗品費／福利厚生費"},
 q:[{id:"kind",type:"seg",label:"種類",opts:[["uniform","制服・作業着・ロゴ入り"],["suit","スーツ・靴・鞄・眼鏡"],["beauty","美容院・化粧品"]],def:"suit"}],
 judge(a,o){
   if(a.kind==="uniform"){
     o.tax.push(F("ok","制服・作業着・社名やロゴが入ったものは、私用に転用しにくいため経費として通ります。"));
     o.cpa.push(F("info","従業員に支給する制服も、業務に必要で私用に適さないものなら福利厚生費です。"));
   } else {
     o.tax.push(F("ng","スーツ・靴・鞄・眼鏡・化粧品・美容院代は、<b>私生活でも使えるため原則として必要経費になりません</b>。「仕事で着る」だけでは理由になりません。",R.kaji[0]));
     o.tax.push(F("warn","例外は、業務でしか使わないと客観的に説明でき、その割合を区分できる場合だけ。撮影・登壇専用の衣装を業務用に保管しているなど、かなり限定的です。"));
   }
   o.ev.push("領収書","（制服の場合）ロゴ入りが分かる写真");
   o.refs.push(R.kaji,R.keihi);
 }},

/* ── 人 ── */
{id:"outsourcing",g:"人",n:"外注費",s:"業務委託",acct:{kojin:"外注工賃",hojin:"外注費"},
 q:[{id:"contract",type:"seg",label:"業務委託契約書はありますか",opts:[["y","ある"],["n","ない"]],def:"n"},
    {id:"invoice",type:"seg",label:"請求書を受け取っていますか",opts:[["y","受け取っている"],["n","受け取っていない"]],def:"y"},
    {id:"control",type:"seg",label:"働き方",hint:"ここで外注費か給与かが決まります。",opts:[["free","成果物単位・時間も方法も相手の裁量"],["managed","時間拘束あり・作業を指示している"]],def:"free"},
    {id:"regular",type:"seg",label:"支払額",opts:[["vary","案件ごとに変わる"],["same","毎月同じ丸い金額"]],def:"vary"}],
 judge(a,o){
   if(a.control==="managed"){
     o.tax.push(F("ng","時間を拘束し作業を指示しているなら、契約書の名前が何であれ<b>給与</b>と判断されます。外注費が否認されると、①源泉徴収漏れ（不納付加算税・延滞税）②消費税の仕入税額控除の否認、が同時に来ます。"));
   } else {
     o.tax.push(F("ok","成果物単位で、作業の時間・方法・場所が相手の裁量なら外注費です。代替（別の人にやらせてよい）が認められていればさらに強くなります。"));
   }
   if(a.contract==="n") o.tax.push(F("ng","業務委託契約書がないのが、給与認定される最大の入口です。作業範囲・報酬・納期・再委託の可否を書いた契約書を必ず結んでください。"));
   if(a.invoice==="n") o.tax.push(F("warn","請求書がない支払いは、相手先の実在と金額の根拠を示せません。"));
   if(a.pay==="cash") o.tax.push(F("ng","現金払いの外注費は、相手の実在すら疑われます。振込にしてください。振込記録そのものが証拠になります。"));
   if(a.regular==="same") o.tax.push(F("warn","毎月同じ丸い金額の支払いは、給与とみなされやすい形です。作業内容と数量に応じた金額にしてください。"));
   if(S.shohi==="honsoku") o.cpa.push(F("info","相手が免税事業者なら、いまは支払額に含まれる消費税相当額の<b>80%</b>まで控除できます（令和8年9月30日まで）。令和8年10月1日からは<b>70%</b>に下がります。",R.invoice[0]));
   o.gyo.push(F("info","契約書は行政書士の領域です。個人へ継続的に発注するなら、<b>下請法</b>（書面交付義務・支払期日）と、報酬の種類によっては<b>源泉徴収の要否</b>（原稿料・デザイン料など）も確認してください。"));
   o.ev.push("業務委託契約書","請求書","銀行の振込記録","成果物・納品物");
   o.refs.push(R.keihi,R.invoice);
 }},

{id:"senju",g:"人",n:"家族への給与",s:"専従者給与",acct:{kojin:"専従者給与",hojin:"役員報酬／給与手当"},
 q:[{id:"notified",type:"seg",label:"「青色事業専従者給与に関する届出書」を出していますか",opts:[["y","出している"],["n","出していない"]],def:"n"},
    {id:"months",type:"num",label:"その年に専ら従事した月数",unit:"ヶ月",def:12},
    {id:"age15",type:"seg",label:"その年の12月31日時点で15歳以上ですか",opts:[["y","15歳以上"],["n","15歳未満"]],def:"y"},
    {id:"other",type:"seg",label:"他に仕事や学業がありますか",opts:[["n","ない"],["y","ある"]],def:"n"}],
 judge(a,o){
   if(isHojin()){
     o.tax.push(F("info","法人では専従者給与ではなく、通常の給与または役員報酬です。家族を役員にするなら<b>定期同額給与</b>（期首から3ヶ月以内に決めて毎月同額）でないと損金になりません。"));
     o.tax.push(F("warn","実際に働いていない家族への支払いは、金額にかかわらず否認されます。労働時間・業務内容の記録を残してください。"));
     o.ev.push("タイムカード・業務日報","雇用契約書または役員報酬の決議書","源泉徴収簿");
     o.refs.push(R.keihi); return;
   }
   if(S.aoiro!=="aoiro"){
     o.tax.push(F("warn","白色申告では専従者給与は使えません。代わりに<b>事業専従者控除</b>（配偶者は最高86万円、その他の親族は最高50万円）になります。実際に払った金額ではなく、限度額と「事業所得等 ÷（専従者数＋1）」のいずれか低いほうです。",R.senju[0]));
   } else if(a.notified==="n"){
     o.tax.push(F("ng","<b>届出書がなければ1円も経費になりません</b>。提出期限は経費にしたい年の3月15日まで（年の途中で開業・専従者が生じた場合はその日から2ヶ月以内）。来年分から間に合わせてください。",R.senju[0]));
   } else {
     o.tax.push(F("ok","届出書があり、届け出た金額の範囲内であれば必要経費になります。",R.senju[0]));
   }
   if(a.age15==="n") o.tax.push(F("ng","その年の12月31日時点で15歳未満は、専従者になれません。",R.senju[0]));
   if(a.months<=6) o.tax.push(F("ng",`専従期間が ${a.months}ヶ月です。<b>その年を通じて6ヶ月を超える期間</b>、専ら事業に従事していることが要件です。`,R.senju[0]));
   if(a.other==="y") o.tax.push(F("ng","他に仕事や学業があると「専ら従事」に当たりません。パート・別会社の勤務・学生はここで外れます。",R.senju[0]));
   o.tax.push(F("warn","金額は<b>労務の対価として相当</b>である必要があります。同じ仕事を他人に頼んだらいくら払うかが基準。時給に直して不自然に高いと、過大な部分が否認されます。",R.senju[0]));
   o.cpa.push(F("info","専従者給与を出すと、その家族は配偶者控除・扶養控除の対象から外れます。世帯全体の税と社会保険で比べてください。"));
   o.gyo.push(F("info","出勤簿・業務日報を本人の字で残してください。筆跡が本人のものでない、勤務実態の記録がない、が否認の典型です。"));
   o.ev.push("青色事業専従者給与に関する届出書の控え","出勤簿・業務日報","給与の振込記録","源泉徴収簿");
   o.refs.push(R.senju,R.tebiki);
 }},

/* ── 知識 ── */
{id:"book_seminar",g:"知識",n:"書籍・研修",s:"セミナー・資格",acct:{kojin:"新聞図書費／研修費",hojin:"新聞図書費／研修費"},
 q:[{id:"kind",type:"seg",label:"内容",opts:[["direct","いまの業務に直結する知識"],["license","新たな資格の取得"],["hobby","教養・趣味"]],def:"direct"}],
 judge(a,o){
   if(a.kind==="direct"){ o.tax.push(F("ok","現在の業務に直結する書籍・セミナー・研修は必要経費です。何の案件・どの提案に使ったかを1行残しておくと確実です。")); }
   if(a.kind==="license"){
     o.tax.push(F("ng","<b>新たな資格の取得費用は原則として必要経費になりません</b>。資格は本人に一身専属的に帰属するもので、事業の経費ではなく自己投資と扱われます。税理士・弁護士などの資格取得費が否認された事例は有名です。"));
     o.tax.push(F("warn","例外は、業務に必要な技能の更新・法定講習など、すでにある業務のために継続して必要なもの。従業員に取らせる場合は判断が変わることがあります。"));
   }
   if(a.kind==="hobby") o.tax.push(F("ng","教養・趣味の書籍やセミナーは家事費です。",R.kaji[0]));
   o.ev.push("領収書","（研修の場合）受講案内・カリキュラム","業務との関連メモ");
   o.refs.push(R.keihi,R.kaji);
 }},

{id:"subscription",g:"知識",n:"サブスク・AIツール",s:"ソフト・クラウド",acct:{kojin:"通信費／支払手数料",hojin:"通信費／支払手数料"},
 q:[{id:"term",type:"seg",label:"支払い",opts:[["month","月払い"],["year","年払い（前払い）"]],def:"month"},
    {id:"acct",type:"seg",label:"アカウント",opts:[["biz","事業専用アカウント"],["share","私用と同じアカウント"]],def:"biz"}],
 judge(a,o){
   if(a.acct==="share") o.tax.push(F("warn","私用と同じアカウントだと按分が必要になり、割合の説明が面倒です。<b>事業用アカウントを分ける</b>のが最も安く済む対策です。"));
   else o.tax.push(F("ok","事業専用アカウントなら全額が経費です。"));
   if(a.term==="year"){
     o.cpa.push(F("info","年払いは本来、期間に応じて前払費用として按分します。ただし<b>支払日から1年以内にサービスの提供を受けるもの</b>を、継続して支払時に経費処理しているなら、そのまま経費にできます（短期前払費用）。<b>毎年同じ処理を続けること</b>が条件で、年によって変えると否認されます。"));
   }
   o.cpa.push(F("info","海外事業者のサービス（AIツールなど）は、消費税の扱いが国内取引と異なる場合があります。仕入税額控除を取るなら、その事業者が「登録国外事業者」かを確認してください。",R.shiire[0]));
   o.ev.push("請求書・カード明細","利用アカウントが事業用と分かる記録");
   o.refs.push(R.keihi,R.shiire);
 }},

{id:"comm",g:"知識",n:"通信費",s:"スマホ・ネット",acct:{kojin:"通信費",hojin:"通信費"},
 q:[{id:"line",type:"seg",label:"回線",opts:[["sep","事業用に分けている"],["share","私用と同じ回線"]],def:"share"}],
 judge(a,o){
   if(a.line==="sep"){ o.tax.push(F("ok","事業用の回線・端末を分けているなら全額が経費です。按分の説明が要らないのが最大の利点。")); }
   else {
     o.tax.push(F("warn","私用と同じ回線は按分が必要です。通話明細の事業用件数の割合、または業務日数（平日 ÷ 全日 ＝ おおむね60%前後）など、説明できる基準を1つ決めて毎年同じにしてください。",R.kaji[0]));
     o.cpa.push(F("info","2台目を持つか、格安SIMで事業用回線を1本引くほうが、按分の説明コストより安く済むことが多いです。"));
   }
   o.ev.push("通信料の明細","按分の基準を書いたメモ");
   o.refs.push(R.kaji,R.keihi);
 }},

/* ── その他 ── */
{id:"ad",g:"その他",n:"広告宣伝費",s:"SNS運用・制作",acct:{kojin:"広告宣伝費",hojin:"広告宣伝費"},
 q:[{id:"to",type:"seg",label:"支払先",opts:[["corp","法人（広告代理店・媒体）"],["indiv","個人（ライター・デザイナー等）"]],def:"corp"}],
 judge(a,o){
   o.tax.push(F("ok","事業の宣伝のための支出は広告宣伝費です。"));
   if(a.to==="indiv") gensenNote(o);
   o.cpa.push(F("info","制作物のうち、ソフトウェアやWebサイトの一部は資産計上（無形固定資産）になることがあります。1回の制作費が高額なら、内容ごとに区分してください。"));
   o.gyo.push(F("info","景品表示法・薬機法など、業種によって広告表現の規制があります。制作を外注するときは契約書に、表現の最終責任の所在を書いておいてください。"));
   o.ev.push("請求書・契約書","制作物・掲載実績","（個人払いの場合）支払調書と源泉徴収の記録");
   o.refs.push(R.keihi);
 }},

{id:"kyosai",g:"その他",n:"共済・保険",s:"経費か所得控除か",acct:{kojin:"—（所得控除）／保険料",hojin:"保険料"},
 q:[{id:"which",type:"seg",label:"種類",opts:[["shokibo","小規模企業共済"],["safety","経営セーフティ共済"],["ideco","iDeCo"],["life","生命保険"]],def:"shokibo"}],
 judge(a,o){
   if(a.which==="shokibo"||a.which==="ideco"){
     o.tax.push(F("ng",`<b>${a.which==="shokibo"?"小規模企業共済":"iDeCo"}の掛金は事業の経費ではありません。</b>「小規模企業共済等掛金控除」という<b>所得控除</b>です。ここを経費に入れると青色申告決算書が誤りになります。`));
     o.cpa.push(F("info","節税効果は同じ（課税所得が減る）ですが、置き場所が違います。決算書ではなく確定申告書の所得控除欄に書きます。事業の所得金額そのものは減らないため、国民健康保険料の計算にも影響しません。"));
     o.ev.push("掛金払込証明書（年末に届くもの）");
   }
   if(a.which==="safety"){
     o.tax.push(F("ok","経営セーフティ共済（中小企業倒産防止共済）の掛金は、個人事業では必要経費、法人では損金になります。年間240万円・累計800万円まで。"));
     o.tax.push(F("info","<b>解約した場合、その後2年間に再加入しても掛金が経費になりません</b>（令和6年10月1日以後の解約が対象）。解約と再加入を繰り返す使い方はできなくなっています。適用の詳細は中小機構の最新の制度案内で確認してください。"));
     o.cpa.push(F("info","個人事業は「特定の基金に対する負担金等の必要経費算入に関する明細書」の添付が必要です。付け忘れると経費になりません。"));
     o.ev.push("掛金の払込記録","必要経費算入に関する明細書");
   }
   if(a.which==="life"){
     if(isHojin()) o.tax.push(F("warn","法人契約の生命保険は、保険の種類と解約返戻率によって損金になる割合が変わります（全額損金・4割損金・資産計上など）。契約前に必ず設計書で確認してください。"));
     else o.tax.push(F("ng","個人事業主が自分にかける生命保険は<b>経費ではありません</b>。生命保険料控除という所得控除です。"));
   }
   o.refs.push(R.tebiki,R.keihi);
 }},

{id:"kaihi",g:"その他",n:"会費・ゴルフ",s:"団体・クラブ",acct:{kojin:"諸会費",hojin:"諸会費／交際費"},
 q:[{id:"kind",type:"seg",label:"種類",opts:[["assoc","商工会・同業者団体"],["golf","ゴルフ会員権"],["play","ゴルフのプレー費"],["club","社交クラブ"]],def:"assoc"}],
 judge(a,o){
   if(a.kind==="assoc"){ o.tax.push(F("ok","商工会・商工会議所・同業者団体の会費は諸会費として経費になります。")); }
   if(a.kind==="golf"){
     o.tax.push(F("ng","<b>ゴルフ会員権の取得費は経費になりません</b>。資産（無形固定資産等）に計上します。償却もしません。名義書換料は繰延資産として償却の対象です。"));
   }
   if(a.kind==="play"){
     o.tax.push(F("warn","取引先を接待するプレー費は<b>交際費</b>です。自分だけ・友人とのプレーは経費になりません。同伴者の氏名と会社名を必ず残してください。",R.kosai[0]));
   }
   if(a.kind==="club"){
     o.tax.push(F("warn","社交クラブの入会金・会費は、法人会員なら交際費、個人会員として使うなら給与とされることがあります。誰が使うかで扱いが変わります。",R.kosai[0]));
   }
   o.ev.push("会費の請求書・領収書","（プレー費）同伴者の氏名と会社名");
   o.refs.push(R.kosai,R.keihi);
 }},

{id:"health",g:"その他",n:"健康診断・ジム",s:"医療・健康",acct:{kojin:"—",hojin:"福利厚生費"},
 q:[{id:"who",type:"seg",label:"対象",opts:[["self","自分だけ"],["all","従業員全員が対象"]],def:"self"},
    {id:"kind",type:"seg",label:"内容",opts:[["kenshin","健康診断・人間ドック"],["gym","ジム・スポーツクラブ"],["iryo","治療・医療費"]],def:"kenshin"}],
 judge(a,o){
   if(a.kind==="iryo"){ o.tax.push(F("ng","治療費・薬代は事業の経費になりません。確定申告の<b>医療費控除</b>（所得控除）で処理します。")); o.refs.push(R.tebiki); return; }
   if(!isHojin()&&a.who==="self"){
     o.tax.push(F("ng","個人事業主本人の健康診断・人間ドック・ジム代は必要経費になりません。事業主自身は福利厚生の対象外だからです。",R.fukuri[0]));
     return;
   }
   if(a.who==="self"&&isHojin()){
     o.tax.push(F("ng","役員だけを対象にすると、福利厚生ではなく<b>役員給与</b>です。全従業員が対象の制度にしてください（従業員が自分だけの一人法人なら、全員対象＝自分だけ、という整理は可能ですが、規程と実施記録が必須です）。",R.fukuri[0]));
   } else {
     if(a.kind==="kenshin") o.tax.push(F("ok","一定年齢以上の全従業員が対象で、会社が医療機関に直接支払い、常識的な金額であれば福利厚生費です。",R.fukuri[0]));
     if(a.kind==="gym") o.tax.push(F("warn","法人契約で全従業員が利用でき、実際に利用の記録があれば福利厚生費です。特定の人しか使っていないと給与になります。",R.fukuri[0]));
   }
   o.gyo.push(F("info","健康診断・スポーツ施設の利用を<b>福利厚生規程</b>に書き、実施記録（受診者一覧・利用記録）を残してください。規程と記録の両方がないと通りません。"));
   o.ev.push("福利厚生規程","医療機関・施設への直接支払いの記録","受診者・利用者の一覧");
   o.refs.push(R.fukuri);
 }},

/* ── 受託・開催 ── */
{id:"client_cost",g:"受託・開催",n:"受託案件の経費",s:"立替・実費精算",acct:{kojin:"外注工賃／旅費交通費／立替金",hojin:"外注費／旅費交通費／立替金"},
 q:[{id:"who",type:"seg",label:"この費用は最終的に誰が負担しますか",opts:[["bill","クライアントに請求する"],["self","自社負担"]],def:"bill"},
    {id:"addr",type:"seg",label:"領収書の宛名",showIf:a=>a.who==="bill",opts:[["self","自分（屋号）宛"],["client","クライアント宛"]],def:"self"},
    {id:"defined",type:"seg",label:"契約書・発注書に実費の負担と精算方法の定めがありますか",showIf:a=>a.who==="bill",opts:[["y","ある"],["n","ない"]],def:"n"},
    {id:"straddle",type:"seg",label:"案件は期をまたぎますか",hint:"未完成の案件にかかった費用は、期末に仕掛品として資産に振り替えます。",opts:[["n","期内に完了する"],["y","期をまたぐ"]],def:"n"}],
 judge(a,o){
   if(a.who==="self"){
     o.tax.push(F("ok","自社負担の案件費用は、その案件の原価としてそのまま必要経費になります。"));
   } else {
     if(a.addr==="client"){
       o.tax.push(F("info","領収書の宛名がクライアントなら、これは<b>立替金</b>です。経費にも売上にも計上せず、立替金として資産に置き、精算時に消し込みます。"));
       o.cpa.push(F("warn","立替金を経費に計上したうえで請求額も売上に計上すると<b>二重計上</b>になります。どちらか一方の処理に統一してください。"));
     } else {
       o.tax.push(F("ok","領収書が自分（屋号）宛なら、これは自分の経費です。クライアントへの請求額は<b>売上</b>に計上します。経費と売上を相殺（ネット）しないでください。"));
       o.cpa.push(F("info","相殺すると売上規模が実態より小さく見え、消費税の課税事業者判定や融資審査に影響します。"));
     }
     if(a.defined==="n") o.tax.push(F("warn","契約書・発注書に実費の負担の定めがないと、請求できない可能性があります。請求できなければ自社負担です。着手前に書面で決めてください。"));
   }
   if(a.straddle==="y") o.cpa.push(F("warn","期をまたぐ案件は、未完成の部分に対応する費用を期末に<b>仕掛品</b>として資産に振り替えます。売上を計上していない案件の原価だけを先に落とすと、費用収益が対応しません。"));
   o.cpa.push(F("info","案件ごとに費用を紐付けておくと、どの案件が儲かったかが分かり、次の見積の根拠にもなります。摘要欄に案件名を入れてください。"));
   o.gyo.push(F("info","契約書に「交通費・宿泊費などの実費は誰が負担し、どう精算するか」を明記してください。定めがないまま請求すると揉めます。継続的に個人へ再委託するなら<b>下請法</b>（書面交付・支払期日60日以内）も確認を。"));
   o.ev.push("案件名が分かる摘要または管理表","契約書・発注書（実費の定め）","クライアントへの請求書控え","（立替の場合）精算書");
   o.refs.push(R.keihi,R.jigyo);
 }},

{id:"seminar_host",g:"受託・開催",n:"セミナー開催",s:"会場・謝金・教材",acct:{kojin:"会場費／支払手数料／外注工賃",hojin:"会議費／支払報酬／外注費"},
 q:[{id:"kind",type:"seg",label:"内容",opts:[["place","会場費・機材レンタル"],["fee","登壇者・講師への謝金"],["material","教材・スライド制作の外注"]],def:"place"},
    {id:"to",type:"seg",label:"支払先",showIf:a=>a.kind==="fee"||a.kind==="material",opts:[["indiv","個人"],["corp","法人"]],def:"indiv"},
    {id:"held",type:"seg",label:"開催",opts:[["held","開催した／これから開催する"],["cancel","中止・延期になった"]],def:"held"}],
 judge(a,o){
   if(a.kind==="place"){
     o.tax.push(F("ok","会場費・機材レンタル代は、集客や受注につながる事業活動の費用として必要経費になります。"));
     if(a.held==="cancel") o.tax.push(F("ok","中止でも、支払ったキャンセル料は必要経費です。中止の経緯が分かる連絡記録を残してください。"));
   }
   if(a.kind==="fee"){
     o.tax.push(F("ok","登壇者・講師への謝金は必要経費です。"));
     if(a.to==="indiv") gensenNote(o);
     else o.tax.push(F("info","法人への支払いは源泉徴収の対象外です。"));
     o.gyo.push(F("info","講師とは<b>業務委託契約</b>を結び、登壇日・内容・報酬・資料の著作権の帰属・中止時の扱いを決めておいてください。とくに資料の著作権は揉めやすいところです。"));
   }
   if(a.kind==="material"){
     o.tax.push(F("ok","教材・スライドの制作外注費は必要経費です。"));
     if(a.to==="indiv") gensenNote(o);
     o.cpa.push(F("info","繰り返し使う教材で制作費が高額な場合は、無形固定資産として資産計上したうえで償却する扱いになることがあります。1回のセミナー用なら経費で構いません。"));
   }
   if(a.held==="cancel"&&a.kind!=="place") o.cpa.push(F("info","中止時に返金が発生する場合、受け取った参加費の返金は売上の減額として処理します。"));
   o.gyo.push(F("info","有料講座をネットで募集するなら<b>特定商取引法に基づく表示</b>（事業者名・連絡先・返金条件）が必要です。参加者名簿は個人情報なので、取得目的と保管方法を決めておいてください。"));
   o.ev.push("会場・機材の請求書","（謝金）業務委託契約書と支払記録","開催案内・当日の記録（写真・参加者数）","（源泉徴収した場合）納付書の控えと支払調書");
   o.refs.push(R.keihi);
 }},

/* ── 補助金 ── */
{id:"hojokin",g:"補助金",n:"補助金の対象経費",s:"交付決定・圧縮記帳",acct:{kojin:"（費目による）／雑収入",hojin:"（費目による）／雑収入"},
 q:[{id:"stage",type:"seg",label:"発注のタイミング",hint:"補助金でいちばん多い失敗がここです。",opts:[["after","交付決定の通知を受けた後に発注した"],["before","交付決定の前に発注・契約した"]],def:"after"},
    {id:"asset",type:"seg",label:"買ったもの",opts:[["fixed","機械・システムなど固定資産"],["cost","広告費・専門家経費など"]],def:"fixed"},
    {id:"got",type:"seg",label:"補助金の受給",opts:[["not","まだ交付決定を受けていない"],["decided","交付決定の通知を受けた"],["paid","入金された"]],def:"not"}],
 judge(a,o){
   o.tax.push(F("info","<b>補助対象経費になるかどうかと、税務上の必要経費になるかどうかは別の話です。</b>補助対象外でも、事業のための支出なら必要経費にはなります。ここでは両方を見ます。"));
   if(a.stage==="before"){
     o.tax.push(F("ng","<b>交付決定の前に発注・契約したものは、原則として補助の対象外です。</b>ほぼすべての補助金に共通する要件で、後から覆せません。税務上の必要経費にはなりますが、補助金は出ません。"));
   } else {
     o.tax.push(F("ok","交付決定の後の発注なので、補助対象経費の基本要件は満たしています。あとは公募要領の対象経費の区分に当てはまるかを確認してください。"));
   }
   if(a.got==="decided"||a.got==="paid"){
     o.tax.push(F("warn","補助金は<b>交付決定の通知を受けた年</b>の収入です（入金した年ではありません）。事業所得の総収入金額（雑収入）に計上します。年をまたぐと計上漏れになります。",R.hojokin[0]));
     if(a.asset==="fixed"){
       o.tax.push(F("ok","固定資産の取得に充てた分は、<b>総収入金額に算入しない特例</b>が使えます（法人の圧縮記帳に相当）。補助金の分だけ取得価額を減らし、減額後の金額で減価償却します。",R.hojokin[0]));
       o.cpa.push(F("warn","この特例は<b>確定申告書への記載と明細書の添付</b>が要件です。付け忘れると特例が使えず、補助金がまるごと課税されます。",R.hojokin[0]));
     } else {
       o.tax.push(F("info","固定資産以外に充てた補助金は、この特例の対象外です。受け取った年の収入として課税されます。対応する経費も同じ年に落ちていれば、実質の負担は小さくなります。",R.hojokin[0]));
     }
   }
   if(S.shohi!=="menzei") o.cpa.push(F("warn","課税事業者は、補助対象経費に含まれる消費税のうち仕入税額控除をした分について、<b>補助金の返還</b>を求められます（消費税等仕入控除税額の報告）。実績報告の後に別途手続があります。"));
   else o.cpa.push(F("info","免税事業者は仕入税額控除をしていないため、消費税相当額の返還は原則不要です。ただし報告書の提出を求められることがあります。"));
   o.gyo.push(F("warn","実績報告で必要になる書類は、買った後では揃えられません。<b>相見積（原則3社）・発注書・納品書・請求書・振込記録・現物写真</b>を、支払いのたびに揃えてください。1つ欠けるとその経費だけ補助対象から外されます。"));
   o.gyo.push(F("info","取得した財産には<b>処分制限期間</b>があり、期間内に売却・廃棄・目的外使用をするには事前の承認が要ります。取得財産管理台帳を作って保管してください。"));
   o.ev.push("交付決定通知書","相見積（原則3社）","発注書・契約書","納品書・検収書","請求書と振込記録","現物写真（型番が写るもの）","取得財産管理台帳");
   o.refs.push(R.hojokin,R.keihi,R.tebiki);
 }},
];

/* ═══════════════ 共通の判定 ═══════════════ */
function commonJudge(a,o){
  if(a.relate==="no") o.tax.push(F("ng","「誰に・何のために」を説明できない支出は、必要経費になりません。事業の売上に対応する費用であることが出発点です。",R.keihi[0]));
  else if(a.relate==="weak") o.tax.push(F("warn","関連の説明が曖昧です。領収書の裏に「案件名・相手・目的」を1行書いてください。あとから思い出すのは不可能です。"));

  if(a.mix==="priv"){
    o.tax.push(F("ng","主に私用のものは家事費です。事業で使う部分を明らかに区分できないかぎり、必要経費になりません。",R.kaji[0]));
  } else if(a.mix==="mixed"){
    const r = Math.max(0,Math.min(100,+a.ratio||0));
    const biz = Math.floor(a.amount*r/100);
    if(r>=100) o.tax.push(F("ng","兼用と答えているのに事業使用割合100%は矛盾です。私用の事実が1つ出た時点で、按分そのものの信用が崩れます。",R.kaji[0]));
    else if(r>=95) o.tax.push(F("warn",`事業使用割合 ${r}% はほぼ全額です。客観的な記録（走行距離・面積・使用ログ）がないと、この割合は維持できません。`,R.kaji[0]));
    else o.tax.push(F("ok",`事業使用割合 ${r}% で按分します。基準（面積・時間・距離・回数）を毎年同じにしてください。`,R.kaji[0]));
    o.cpa.push(F("info",`按分：${yen(a.amount)} × ${r}% = <b>${yen(biz)}</b> を計上。残り ${yen(a.amount-biz)} は${isHojin()?"役員への貸付金または給与":"事業主貸"}で処理します。`));
    o.split = {total:a.amount, ratio:r, biz};
  }

  if(a.doc==="none") o.tax.push(F("warn","領収書もレシートもない支出は、金額の根拠がありません。出金伝票に日付・相手・金額・内容を書いて残してください。帳簿書類は原則7年間の保存義務があります。"));
  if(S.shohi==="honsoku"){
    if(a.doc==="invoice") o.cpa.push(F("ok","適格請求書があるので、消費税の仕入税額控除が取れます。",R.shiire[0]));
    else if(a.amount<10000) o.cpa.push(F("ok","税込1万円未満なので<b>少額特例</b>で帳簿の保存だけで控除できます（基準期間の課税売上高1億円以下または特定期間5,000万円以下の事業者、令和11年9月30日まで）。1回の取引単位で判定します。",R.shogakuT[0]));
    else o.cpa.push(F("warn","適格請求書がないと消費税の仕入税額控除が取れません。相手が免税事業者なら、いまは経過措置で<b>80%</b>まで控除可（令和8年9月30日まで／10月1日からは70%）。",R.invoice[0]));
  } else if(S.shohi==="menzei"){
    o.cpa.push(F("info","免税事業者のため、消費税の仕入税額控除は関係ありません。ただし所得税の記帳・保存義務は同じようにかかります。"));
  } else {
    o.cpa.push(F("info",`${S.shohi==="kani"?"簡易課税":"2割特例"}のため、仕入側のインボイスの有無は消費税の納税額に影響しません。所得税の証憑としての保存は必要です。`));
  }
  if(a.pay==="cash"&&a.amount>=100000) o.cpa.push(F("warn","10万円以上の現金払いは、支払先と事実の裏付けが弱くなります。事業用のカードか口座振込にしてください。通帳の履歴そのものが証拠になります。"));
  else if(a.pay==="cash"&&a.amount>=30000) o.cpa.push(F("info","事業用の口座とカードを私用と分けるだけで、記帳と説明の手間がまとめて減ります。"));
}

/* ═══════════════ 記録（1画面） ═══════════════ */
let REC = null;

function blankRec(){
  /* pid＝新しい記録に付ける予定のid（写真のファイル名に使う）。orig…＝直している記録にもともと付いていた写真 */
  return {id:null, pid:uid(), receiptId:null, origReceiptId:null, origPhotoId:null, date:today(), amount:0, payee:"", memo:"",
          catId:"supplies", kamoku:null, ans:{}};
}
function catOf(){ return CATS.find(c=>c.id===REC.catId) || CATS[0] }
function recQs(){ return [...catOf().q, ...Q_COMMON_TAIL] }
function resetAns(){
  REC.ans = {};
  recQs().forEach(q=>{ if(q.def!==undefined) REC.ans[q.id]=q.def });
  REC.kamoku = CAT_KAMOKU[REC.catId] || "雑費";
  /* 車は運行記録から出た事業使用割合を最初から入れる */
  if(REC.catId === "car_run" || REC.catId === "car_buy"){
    const r = carRatio(yOf(REC.date) || YEAR);
    if(r !== null){ REC.ans.mix = "mixed"; REC.ans.ratio = r }
  }
}

/* 汎用の1問レンダラ */
function qNode(q, store, onChange){
  const w = el(`<div class="q"><div class="qlab">${esc(q.label)}</div></div>`);
  if(q.hint) w.appendChild(el(`<div class="qhint">${esc(q.hint)}</div>`));
  if(q.type==="seg"){
    const s = el(`<div class="seg"></div>`);
    q.opts.forEach(([v,l])=>{
      const b = el(`<button aria-pressed="${store[q.id]===v}">${esc(l)}</button>`);
      b.onclick = () => { store[q.id]=v; onChange(true) };
      s.appendChild(b);
    });
    w.appendChild(s);
  } else if(q.type==="num"){
    const r = el(`<div class="numrow"><input type="number" inputmode="decimal" value="${store[q.id]??q.def}" min="0"><span class="unit">${esc(q.unit||"")}</span></div>`);
    r.querySelector("input").oninput = e => { store[q.id] = +e.target.value||0; onChange(false) };
    w.appendChild(r);
  } else if(q.type==="ratio"){
    const v = store[q.id]??q.def;
    const r = el(`<div class="numrow"><span class="ratioval">${v}</span><span class="unit">%</span></div>`);
    const sl = el(`<input type="range" min="0" max="100" step="5" value="${v}">`);
    sl.oninput = () => { store[q.id]=+sl.value; r.querySelector(".ratioval").textContent = sl.value; onChange(false) };
    w.appendChild(r); w.appendChild(sl);
  }
  return w;
}

function drawRec(){
  if(!REC) { REC = blankRec(); resetAns(); }
  const box = document.getElementById("recForm"); box.innerHTML = "";
  const redraw = full => { if(full) drawRec(); else drawVerdict(); };

  /* 「更新」を押しただけでは台帳は変わらない。保存が要ることを画面に出す */
  const editing = !!REC.id;
  $("recSave").textContent = editing ? "この内容で上書きする" : "台帳に保存する";
  if(editing) box.appendChild(el(`<div class="note" style="margin-bottom:14px"><b>いま、登録済みの記録を直しています。</b>直したら下の<b>「この内容で上書きする」</b>を押してください。押すまで台帳は変わりません。</div>`));

  /* 1 領収書 */
  const shot = el(`<div class="q">
    <div class="qlab">領収書・レシート</div>
    <div class="qhint">撮っておくと、台帳の行から見返せます。写真は会社のドライブに保存し、ほかの端末からも見られます。</div>
    <div class="shot"><label class="pick"><svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.5"/></svg>撮る・選ぶ
      <input type="file" accept="image/*" style="display:none"></label><span id="shotHold"></span>
      <button class="ghost" id="ocrGo" style="display:none">文字を読み取る</button></div>
    <div class="qhint" id="ocrMsg" style="margin:9px 0 0"></div></div>`);
  const fi = shot.querySelector("input");
  fi.onchange = async () => {
    const f = fi.files && fi.files[0]; if(!f) return;
    const hold = shot.querySelector("#shotHold"); hold.textContent = "読み込み中…";
    try{
      const im = await shrink(f), id = uid();
      const rec = {id, data:im.data, w:im.w, h:im.h, size:im.data.length, at:today()};
      await putShot(rec);
      if(REC.receiptId && REC.receiptId !== REC.origReceiptId) await discardShot(REC.receiptId);
      REC.receiptId = id;
      OCR = {busy:false, msg:"", file:""};
      drawRec();
      uploadShot(rec, REC.date, REC.id || REC.pid).then(() => drawPend());   /* つながっていればすぐ送る */
    }catch(e){ hold.textContent = e.message || "取り込めませんでした" }
  };

  const go = shot.querySelector("#ocrGo");
  go.style.display = REC.receiptId ? "" : "none";
  go.disabled = !!OCR.busy;
  go.textContent = OCR.busy ? "読み取り中…" : "文字を読み取る";
  go.onclick = () => ocrRun();        /* 読み取りは待たない。終わったら画面を書き直す */

  const om = shot.querySelector("#ocrMsg");
  om.textContent = OCR.msg || "";
  om.style.color = OCR.busy ? "var(--accent-ink)" : "";
  om.style.display = OCR.msg ? "" : "none";
  box.appendChild(shot);
  if(OCR.history && !OCR.busy){ box.appendChild(historyPanel()); setTimeout(drawHistoryBtn) }
  if(REC.receiptId) showEntryPhoto(shot.querySelector("#shotHold"),
    {receiptId:REC.receiptId, photoId: REC.receiptId === REC.origReceiptId ? REC.origPhotoId : null}, false, false,
    () => { if(REC.receiptId !== REC.origReceiptId) discardShot(REC.receiptId); REC.receiptId = null; drawRec() });

  /* 2 金額・日付 */
  const amt = el(`<div class="q"><div class="qlab">金額（税込）</div>
    <div class="numrow"><input type="number" inputmode="numeric" min="0" value="${REC.amount}"><span class="unit">円</span></div></div>`);
  amt.querySelector("input").oninput = e => { REC.amount = +e.target.value||0; drawVerdict() };
  box.appendChild(amt);

  const dt = el(`<div class="q"><div class="qlab">日付</div><input type="date" value="${esc(REC.date)}"></div>`);
  dt.querySelector("input").oninput = e => { REC.date = e.target.value };
  box.appendChild(dt);

  /* 3 費目 */
  const groups = [...new Set(CATS.map(c=>c.g))];
  const csel = el(`<div class="q"><div class="qlab">何に使いましたか</div>
    <select class="yearsel" style="width:100%">${
      groups.map(g=>`<optgroup label="${esc(g)}">${
        CATS.filter(c=>c.g===g).map(c=>`<option value="${c.id}"${c.id===REC.catId?" selected":""}>${esc(c.n)}（${esc(c.s)}）</option>`).join("")
      }</optgroup>`).join("")}</select></div>`);
  csel.querySelector("select").onchange = e => { REC.catId = e.target.value; resetAns(); drawRec() };
  box.appendChild(csel);

  /* 4 費目ごとの質問 ＋ 共通の質問 */
  recQs().forEach(q=>{
    if(q.showIf && !q.showIf(REC.ans)) return;
    box.appendChild(qNode(q, REC.ans, redraw));
  });

  /* 5 勘定科目 */
  const ksel = el(`<div class="q"><div class="qlab">勘定科目</div>
    <div class="qhint">費目から自動で選んでいます。決算書に印字されていない科目は空欄行に書きます。</div>
    <select class="yearsel" style="width:100%">${
      ALL_KAMOKU.map(k=>`<option value="${esc(k)}"${k===REC.kamoku?" selected":""}>${esc(k)}${KAMOKU.includes(k)&&!KAMOKU_FIXED.has(k)?"（空欄行）":""}</option>`).join("")
    }</select></div>`);
  ksel.querySelector("select").onchange = e => { REC.kamoku = e.target.value; drawVerdict() };
  box.appendChild(ksel);

  /* 6 相手先・摘要 */
  const py = el(`<div class="q"><div class="qlab">相手先</div><input type="text" value="${esc(REC.payee)}" placeholder="店名・支払先"></div>`);
  py.querySelector("input").oninput = e => REC.payee = e.target.value;
  box.appendChild(py);
  const mm = el(`<div class="q"><div class="qlab">摘要</div>
    <div class="qhint">誰と・何のために・どの案件か。ここが税務調査で効きます。</div>
    <input type="text" value="${esc(REC.memo)}" placeholder="一言で構いません"></div>`);
  mm.querySelector("input").oninput = e => REC.memo = e.target.value;
  box.appendChild(mm);

  drawVerdict();
}

/* ═══════════════ 判定（記録画面の下にライブ表示） ═══════════════ */
function computeJudge(){
  const cat = catOf();
  const a = Object.assign({}, REC.ans, {amount:+REC.amount||0});
  const o = {tax:[],cpa:[],gyo:[],ev:[],refs:[],split:null};
  commonJudge(a,o);
  cat.judge(a,o);
  const all = [...o.tax,...o.cpa,...o.gyo];
  const v = all.some(f=>f.level==="ng") ? "ng" : all.some(f=>f.level==="warn") ? "warn" : "ok";
  return {a,o,v,cat};
}
function drawVerdict(){
  const {a,o,v,cat} = computeJudge();
  REC.verdict = v;
  const box = document.getElementById("recVerdict"); box.innerHTML = "";
  if(!a.amount){ box.appendChild(el(`<div class="note" style="margin-top:14px">金額を入れると、税理士・公認会計士・行政書士の3つの視点で判定します。</div>`)); return }

  const meta = {
    ok:  {mark:"○",t:"経費にできます",s:"入力した条件のかぎりでは問題ありません。下の証憑を揃えて保存してください。"},
    warn:{mark:"△",t:"条件つきで経費になります",s:"このままだと指摘されます。下の△と×を潰してから計上してください。"},
    ng:  {mark:"×",t:"このままでは否認されます",s:"×が1つでもあると税務調査で落ちる可能性が高い状態です。処理を変えるか、経費に入れない判断を。"}
  }[v];
  const off = NOT_EXPENSE.includes(REC.kamoku);
  const biz = off ? 0 : Math.floor(a.amount * (a.mix==="mixed" ? (+a.ratio||0) : 100) / 100);

  box.appendChild(el(`<div class="verdict v-${v}" style="margin-top:16px">
    <span class="mark">${meta.mark}</span>
    <span><span class="vt">${esc(meta.t)}</span><span class="vs">${esc(meta.s)}</span></span></div>`));

  box.appendChild(el(`<div class="card pad" style="margin-top:12px">
    <div class="kv big"><span>${off?"台帳の経費に入れない":"経費に計上する額"}</span><b>${off?esc(REC.kamoku.replace("経費にしない","")):yen(biz)}</b></div>
    ${!off && biz<a.amount?`<div class="kv"><span>事業主貸（私用分）</span><b>${yen(a.amount-biz)}</b></div>`:""}
    <div class="kv"><span>勘定科目</span><b>${esc(REC.kamoku)}</b></div></div>`));

  [["税理士","必要経費・損金になるか",o.tax],["公認会計士","会計処理・消費税・証憑",o.cpa],["行政書士","契約書・規程・許認可",o.gyo]].forEach(([n,d,fs])=>{
    if(!fs.length) return;
    const r = el(`<div class="role"><div class="rolehd"><span class="chip">${n}</span><span class="rd">${d}</span></div><ul class="finds"></ul></div>`);
    const ul = r.querySelector("ul");
    fs.forEach(f=>ul.appendChild(el(`<li><span class="dot d-${f.level}"></span><span>${f.text}${f.src?`<span class="src">出典：${esc(f.src)}</span>`:""}</span></li>`)));
    box.appendChild(r);
  });

  const ev = [...new Set([...o.ev,"領収書・請求書（7年間保存）"])];
  const eb = el(`<div class="role"><div class="rolehd"><span class="chip">証憑</span><span class="rd">これが揃えば説明できます</span></div><ul class="checks"></ul></div>`);
  const eu = eb.querySelector("ul");
  ev.forEach(t=>eu.appendChild(el(`<li><label><input type="checkbox"><span>${esc(t)}</span></label></li>`)));
  box.appendChild(eb);

  const refs = [...new Map(o.refs.map(x=>[x[1],x])).values()];
  if(refs.length){
    const rb = el(`<div class="role"><div class="rolehd"><span class="chip">根拠</span><span class="rd">国税庁（2026-08-16 確認）</span></div><ul class="refs"></ul></div>`);
    const ul = rb.querySelector("ul");
    refs.forEach(([t,u])=>ul.appendChild(el(`<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a><span class="rn">${esc(u)}</span></li>`)));
    box.appendChild(rb);
  }
}

function saveRec(){
  if(!REC.amount){ say("金額を入れてください。"); return }
  const wasEdit = !!REC.id;
  const {a,v} = computeJudge();
  const off = NOT_EXPENSE.includes(REC.kamoku);
  const ratio = a.mix==="mixed" ? (+a.ratio||0) : 100;
  const keepPhoto = !!REC.receiptId && REC.receiptId === REC.origReceiptId;
  const row = {id: REC.id||REC.pid||uid(), date:REC.date, amount:+REC.amount||0, ratio,
    biz: off ? 0 : Math.floor(REC.amount*ratio/100), kamoku:REC.kamoku,
    payee:REC.payee, memo:REC.memo, catName:catOf().n, verdict:v, receiptId:REC.receiptId,
    photoId: keepPhoto ? (REC.origPhotoId || null) : null,
    ans: Object.assign({}, REC.ans)};
  /* 撮り直した・外した写真は、保存したときに片づける（やめたときは元の写真が残る） */
  if(wasEdit && REC.origReceiptId && !keepPhoto && !photoShared(REC.origReceiptId, REC.origPhotoId, REC.id)){
    IDB.del(REC.origReceiptId).catch(()=>{}); SHOTS.delete(REC.origReceiptId);
    trashLater(REC.origPhotoId);
  }
  const i = D.entries.findIndex(x=>x.id===row.id);
  if(i>=0) D.entries[i] = row; else D.entries.push(row);
  saveD(); pumpPhotos();
  const keep = REC.date;
  REC = blankRec(); REC.date = keep; resetAns(); OCR = {busy:false, msg:"", file:""};
  drawRec(); drawLedger(); drawYears();
  say(wasEdit ? "上書きしました。" : "台帳に保存しました。");
  window.scrollTo({top:0,behavior:"smooth"});
}

/* 記録の写真を出す。この端末になければ「写真」ボタンを出し、押したときにドライブから受け取る。
   other＝ほかの人の記録（管理者が見るだけ）。ほかの人の写真は端末に控えない */
async function showEntryPhoto(host, e, small, other, onDel){
  if(!host) return;
  const key = e.receiptId || e.photoId;
  const put = data => {
    host.innerHTML = "";
    const img = el(`<img class="thumb${small?" sm":""}" src="${data}" alt="領収書">`);
    img.onclick = () => lightbox(data);
    host.appendChild(img);
    if(onDel){ const b = el(`<button class="ghost" style="margin-left:8px;padding:6px 10px;font-size:12px">外す</button>`); b.onclick = onDel; host.appendChild(b); }
  };
  if(!other && key){
    const rec = await IDB.get(key).catch(() => null);
    if(rec && rec.data){ put(rec.data); return }
  }
  if(!e.photoId) return;
  host.innerHTML = "";
  const b = el(`<button class="photoBtn" type="button" title="押すとドライブから受け取ります">写真</button>`);
  b.onclick = async ev => {
    ev.stopPropagation();
    b.textContent = "…"; b.disabled = true;
    const r = await api("receiptImage", {fileId:e.photoId}).catch(err => ({ok:false, message:err.message}));
    if(!r.ok){ b.textContent = "写真"; b.disabled = false; say(r.message || "写真を受け取れませんでした。"); return }
    const data = "data:" + (r.mimeType || "image/jpeg") + ";base64," + r.data;
    if(!other) await putShot({id:key, data, size:data.length, at:today(), driveId:e.photoId}).catch(()=>{});
    put(data); lightbox(data);
  };
  host.appendChild(b);
  if(onDel){ const x = el(`<button class="ghost" style="margin-left:8px;padding:6px 10px;font-size:12px">外す</button>`); x.onclick = onDel; host.appendChild(x); }
}
function lightbox(src){
  const lb = el(`<div class="lightbox"><img src="${src}" alt="領収書"><button>閉じる</button></div>`);
  const close = () => lb.remove();
  lb.onclick = e => { if(e.target === lb) close(); };
  lb.querySelector("button").onclick = close;
  document.body.appendChild(lb);
}

function drawLedger(){
  const rows = D.entries.filter(e=>yOf(e.date)===YEAR).sort((a,b)=> a.date<b.date?1:-1);
  const ul = document.getElementById("histList"); ul.innerHTML = "";
  const sum = rows.reduce((s,e)=>s+(e.biz||0),0);
  const cnt = rows.length;
  const noRec = rows.filter(e=>!e.receiptId && !e.photoId).length;
  const mini = document.getElementById("ledgerMini");
  if(mini) mini.textContent = `${cnt}件 ・ ${yen(sum)}${noRec?` ・ 写真なし ${noRec}`:""}`;
  if(!cnt){ ul.appendChild(el(`<li class="empty" style="display:block">${YEAR}年の記録はまだありません。</li>`)); return }
  const M = {ok:["○","var(--ok)"],warn:["△","var(--warn)"],ng:["×","var(--ng)"]};
  rows.forEach(e=>{
    const [mk,c] = M[e.verdict] || ["・","var(--ink3)"];
    const li = el(`<li>
      <span class="hbadge" style="color:${c}">${mk}</span>
      <span class="hbody"><span class="ht">${esc(e.kamoku)}${e.payee?" ・ "+esc(e.payee):""}${e.receiptId && !e.photoId && SHOTS.has(e.receiptId)?`<span class="tag pend">未送信</span>`:""}</span>
      <span class="hs">${esc(e.date)}${e.ratio<100?" ・ "+e.ratio+"%":""}${e.memo?" ・ "+esc(e.memo.slice(0,18)):""}</span></span>
      <span class="hamt">${yen(e.biz||0)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    if(e.receiptId || e.photoId){ const s = el(`<span></span>`); li.insertBefore(s, li.querySelector(".hamt")); showEntryPhoto(s, e, true, false); }
    li.querySelector('[data-a=edit]').onclick = () => {
      REC = {id:e.id, receiptId:e.receiptId || (e.photoId ? e.photoId : null), date:e.date, amount:e.amount, payee:e.payee,
             memo:e.memo, catId:(CATS.find(c=>c.n===e.catName)||{}).id||"supplies", kamoku:e.kamoku, ans:{}};
      REC.origReceiptId = REC.receiptId; REC.origPhotoId = e.photoId || null;
      OCR = {busy:false, msg:"", file:""};
      recQs().forEach(q=>{ if(q.def!==undefined) REC.ans[q.id]=q.def });
      Object.assign(REC.ans, e.ans || {});                                  /* 保存してある回答を戻す */
      if(!(e.ans && e.ans.mix) && e.ratio<100){ REC.ans.mix="mixed"; REC.ans.ratio=e.ratio }
      drawRec(); window.scrollTo({top:0,behavior:"smooth"});
    };
    li.querySelector('[data-a=del]').onclick = async () => {
      if(!await ask("この記録を削除します。もとに戻せません。","削除する")) return;
      if(!photoShared(e.receiptId, e.photoId, e.id)){
        if(e.receiptId){ IDB.del(e.receiptId).catch(()=>{}); SHOTS.delete(e.receiptId) }
        trashLater(e.photoId);
      }
      dropRow("entries", e.id); saveD(); drawLedger();
    };
    ul.appendChild(li);
  });
}

/* ═══════════════ 仮想通貨 ═══════════════ */
const coins = () => [...new Set([...D.trades.map(t=>t.coin), ...D.opens.map(o=>o.coin)])].filter(Boolean).sort();

function cryptoCalc(coin, year){
  const op = D.opens.find(o=>o.coin===coin && +o.year===year) || {qty:0,value:0};
  const ts = D.trades.filter(t=>t.coin===coin && yOf(t.date)===year).sort((a,b)=> a.date<b.date?-1:1);
  const buys = ts.filter(t=>t.kind==="buy"), sells = ts.filter(t=>t.kind==="sell");
  const buyQty = buys.reduce((s,t)=>s+(+t.qty||0),0);
  const buyVal = buys.reduce((s,t)=>s+(+t.amount||0)+(+t.fee||0),0);
  const sellQty= sells.reduce((s,t)=>s+(+t.qty||0),0);
  const sellVal= sells.reduce((s,t)=>s+(+t.amount||0),0);
  const sellFee= sells.reduce((s,t)=>s+(+t.fee||0),0);

  let unit, cost;
  if(S.cmethod === "ido"){
    let q = +op.qty||0, v = +op.value||0, c = 0;
    ts.forEach(t=>{
      if(t.kind==="buy"){ q += +t.qty||0; v += (+t.amount||0)+(+t.fee||0); }
      else { const u = q>0 ? v/q : 0; const cc = u*(+t.qty||0); c += cc; v -= cc; q -= (+t.qty||0); }
    });
    cost = c; unit = q>0 ? v/q : 0;
    return {coin, open:op, buyQty:qty8(buyQty), buyVal, sellQty:qty8(sellQty), sellVal, sellFee, unit, cost,
            need: cost+sellFee, income: sellVal-cost-sellFee, endQty:qty8(q), endVal:v};
  }
  const totQty = (+op.qty||0) + buyQty, totVal = (+op.value||0) + buyVal;
  unit = totQty>0 ? totVal/totQty : 0;
  cost = unit * sellQty;
  const endQty = qty8(totQty - sellQty);
  return {coin, open:op, buyQty:qty8(buyQty), buyVal, sellQty:qty8(sellQty), sellVal, sellFee, unit, cost,
          need: cost+sellFee, income: sellVal-cost-sellFee, endQty, endVal: unit*endQty};
}
const cryptoAll = year => coins().map(c=>cryptoCalc(c,year)).filter(r=>r.sellQty>0||r.buyQty>0||r.open.qty>0);

function drawCrypto(){
  const rs = cryptoAll(YEAR);
  const total = rs.reduce((s,r)=>s+r.income,0);
  const box = document.getElementById("cryptoSum");
  box.innerHTML = rs.length ? `
    <div class="eyebrow">${YEAR}年 ・ ${S.cmethod==="ido"?"移動平均法":"総平均法"}</div>
    <div class="scroller"><table class="jr"><tr><th>銘柄</th><th style="width:auto">譲渡収入</th><th style="width:auto">必要経費</th><th style="width:auto">所得</th></tr>
    ${rs.map(r=>`<tr><th>${esc(r.coin)}<span class="rn" style="display:block;font-weight:400;font-family:var(--mono);font-size:10.5px;color:var(--ink3)">平均単価 ${yen(r.unit)}／期末 ${r.endQty}</span></th>
      <td>${yen(r.sellVal)}</td><td>${yen(r.need)}</td><td class="${r.income<0?"neg":"pos"}">${yen(r.income)}</td></tr>`).join("")}
    </table></div>
    <div class="kv big" style="margin-top:8px"><span>雑所得の金額</span><b class="${total<0?"neg":""}">${yen(total)}</b></div>
    ${total<0?`<div class="note warnbox" style="margin-top:10px"><b>マイナスでも他の所得と引けません。</b>仮想通貨の雑所得の損失は、事業所得や給与とは通算できず、翌年へ繰り越すこともできません。雑所得の中でだけ相殺します。</div>`:""}
    <div class="note" style="margin-top:10px">評価方法は${S.cmethod==="ido"?"移動平均法":"総平均法"}で計算しています。届出をしていなければ法定は総平均法です。<b>一度決めたら継続して使ってください</b>（設定で変更できます）。</div>`
    : `<div class="empty">${YEAR}年の取引はまだありません。</div>`;

  const ol = document.getElementById("openList"); ol.innerHTML = "";
  const ops = D.opens.filter(o=>+o.year===YEAR);
  if(!ops.length) ol.appendChild(el(`<li class="empty" style="display:block">繰越なし。前年から持ち越した数量と取得価額があれば追加してください。</li>`));
  ops.forEach(o=>{
    const li = el(`<div class="q" style="display:flex;gap:10px;align-items:center">
      <span class="hbody"><span class="ht">${esc(o.coin)}</span><span class="hs">${o.qty} ／ ${yen(o.value)}</span></span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></div>`);
    li.querySelector('[data-a=edit]').onclick = () => openOpen({...o});
    li.querySelector('[data-a=del]').onclick  = async () => {
      if(!await ask(`${o.coin} の繰越を削除します。もとに戻せません。`,"削除する")) return;
      dropRow("opens", o.id); saveD(); drawCrypto();
    };
    ol.appendChild(li);
  });

  const ul = document.getElementById("tradeList"); ul.innerHTML = "";
  const ts = D.trades.filter(t=>yOf(t.date)===YEAR).sort((a,b)=> a.date<b.date?1:-1);
  if(!ts.length){ ul.appendChild(el(`<li class="empty" style="display:block">取引の記録はまだありません。</li>`)); return }
  ts.forEach(t=>{
    const li = el(`<li>
      <span class="hbadge" style="color:${t.kind==="buy"?"var(--accent-ink)":"var(--ok)"};font-size:13px">${t.kind==="buy"?"取得":"譲渡"}</span>
      <span class="hbody"><span class="ht">${esc(t.coin)} ${t.qty}</span><span class="hs">${esc(t.date)}${t.venue?" ・ "+esc(t.venue):""}${t.memo?" ・ "+esc(t.memo):""}</span></span>
      <span class="hamt">${yen(t.amount)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    li.querySelector('[data-a=edit]').onclick = () => openTrade({...t});
    li.querySelector('[data-a=del]').onclick  = async () => {
      if(!await ask("この取引を削除します。もとに戻せません。","削除する")) return;
      dropRow("trades", t.id); saveD(); drawCrypto();
    };
    ul.appendChild(li);
  });
}

let TF = null;
function openTrade(pre){
  TF = Object.assign({id:null,date:today(),coin:"BTC",kind:"buy",qty:0,amount:0,fee:0,venue:"",memo:""}, pre||{});
  document.getElementById("tradeForm").style.display = "";
  document.getElementById("addTrade").style.display = "none";
  drawTrade();
}
function closeTrade(){
  TF = null;
  document.getElementById("tradeForm").style.display = "none";
  document.getElementById("addTrade").style.display = "";
  drawCrypto();
}
function drawTrade(){
  const box = document.getElementById("tradeFields"); box.innerHTML = "";
  const row = (label,hint,node) => {
    const w = el(`<div class="q"><div class="qlab">${esc(label)}</div></div>`);
    if(hint) w.appendChild(el(`<div class="qhint">${esc(hint)}</div>`));
    w.appendChild(node); box.appendChild(w);
  };
  const inp = (val,type,unit,key,step) => {
    const n = el(`<div class="numrow"><input type="${type}" ${type==="number"?`inputmode="decimal" step="${step||"any"}" min="0"`:""} value="${esc(val)}"><span class="unit">${esc(unit||"")}</span></div>`);
    n.querySelector("input").oninput = e => TF[key] = type==="number" ? (+e.target.value||0) : e.target.value;
    return n;
  };
  row("日付",null,inp(TF.date,"date","","date"));
  const kd = el(`<div class="seg"></div>`);
  [["buy","取得（買った）"],["sell","譲渡（売った・使った・交換した）"]].forEach(([v,l])=>{
    const b = el(`<button aria-pressed="${TF.kind===v}">${l}</button>`);
    b.onclick = () => { TF.kind = v; drawTrade(); }; kd.appendChild(b);
  });
  row("種別","暗号資産どうしの交換は、売る側を「譲渡」、買う側を「取得」の2行に分けて入れてください。買い物に使った場合も「譲渡」です。",kd);
  row("銘柄",null,inp(TF.coin,"text","","coin"));
  row("数量",null,inp(TF.qty,"number","枚・単位","qty"));
  row(TF.kind==="buy"?"取得価額（円）":"譲渡収入（円）",
      TF.kind==="buy"?"支払った日本円の額。交換で取得した場合は、そのときの時価。":"受け取った日本円の額。交換・決済に使った場合は、そのときの時価。",
      inp(TF.amount,"number","円","amount"));
  row("手数料",null,inp(TF.fee,"number","円","fee"));
  row("取引所",null,inp(TF.venue,"text","","venue"));
  row("摘要",null,inp(TF.memo,"text","","memo"));
}
function saveTrade(){
  if(!TF.qty || !TF.amount){ say("数量と金額を入れてください。"); return }
  const edit = !!TF.id;
  if(edit){ const i = D.trades.findIndex(x=>x.id===TF.id); if(i>=0) D.trades[i] = {...TF}; else D.trades.push({...TF}) }
  else { TF.id = uid(); D.trades.push({...TF}) }
  saveD(); say(edit ? "上書きしました。" : "保存しました。"); closeTrade();
}

/* ═══════════════ 株式 ═══════════════ */
const ACCT_TYPE = {gensen:"特定口座（源泉徴収あり）", nashi:"特定口座（源泉徴収なし）", ippan:"一般口座"};

function stockCalc(year){
  const list = D.stocks.filter(s=>+s.year===year).map(s=>({...s, pl:(+s.income||0)-(+s.cost||0)}));
  const sum = k => list.reduce((t,s)=>t+(+s[k]||0),0);
  const pl = list.reduce((t,s)=>t+s.pl,0);
  const div = sum("div");
  const wI = sum("wI"), wR = sum("wR");
  const carry = +(D.stockCarry||{})[year-1] || 0;
  const afterDiv = pl + div;                       // 譲渡損益と配当等の通算後
  const afterCarry = afterDiv - carry;             // 繰越控除後
  return {list, pl, div, wI, wR, carry, afterDiv, afterCarry,
          nextCarry: afterCarry < 0 ? -afterCarry : 0};
}

function drawStock(){
  const r = stockCalc(YEAR);
  document.getElementById("stockSum").innerHTML = r.list.length ? `
    <div class="eyebrow">${YEAR}年 ・ 申告分離課税</div>
    <div class="kv"><span>譲渡損益の合計</span><b class="${r.pl<0?"neg":"pos"}">${yen(r.pl)}</b></div>
    ${r.div?`<div class="kv"><span>配当等（申告分離を選ぶ場合）</span><b>${yen(r.div)}</b></div>
    <div class="kv"><span>通算後</span><b class="${r.afterDiv<0?"neg":"pos"}">${yen(r.afterDiv)}</b></div>`:""}
    ${r.carry?`<div class="kv"><span>前年から繰り越した損失</span><b class="neg">−${yen(r.carry)}</b></div>`:""}
    <div class="kv big"><span>${r.carry?"繰越控除後の":""}課税される譲渡所得等</span><b class="${r.afterCarry<0?"neg":""}">${yen(Math.max(0,r.afterCarry))}</b></div>
    ${r.afterCarry>0?`<div class="kv"><span>税額の目安（所得税15.315%）</span><b>${yen(r.afterCarry*0.15315)}</b></div>
    <div class="kv"><span>住民税5%</span><b>${yen(r.afterCarry*0.05)}</b></div>`:""}
    <div class="kv"><span>源泉徴収された所得税</span><b>${yen(r.wI)}</b></div>
    <div class="kv"><span>株式等譲渡所得割額（住民税）</span><b>${yen(r.wR)}</b></div>
    ${r.nextCarry?`<div class="kv"><span>翌年へ繰り越せる損失</span><b class="neg">${yen(r.nextCarry)}</b></div>`:""}`
    : `<div class="empty">${YEAR}年の口座はまだ登録されていません。</div>`;

  const ul = document.getElementById("stockList"); ul.innerHTML = "";
  if(!r.list.length) ul.appendChild(el(`<li class="empty" style="display:block">年間取引報告書が届いたら、口座ごとに数字を入れてください。</li>`));
  r.list.forEach(s=>{
    const li = el(`<li>
      <span class="hbody"><span class="ht">${esc(s.broker||"（証券会社）")}</span><span class="hs">${esc(ACCT_TYPE[s.type]||"")}</span></span>
      <span class="hamt ${s.pl<0?"neg":"pos"}">${yen(s.pl)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    li.querySelector('[data-a=edit]').onclick = () => openStock({...s});
    li.querySelector('[data-a=del]').onclick = async () => {
      if(!await ask("この口座の記録を削除します。もとに戻せません。","削除する")) return;
      dropRow("stocks", s.id); saveD(); drawStock();
    };
    ul.appendChild(li);
  });

  /* 申告するかどうかの判定 */
  const adv = document.getElementById("stockAdvice");
  const gensenOnly = r.list.length>0 && r.list.every(s=>s.type==="gensen");
  const F2 = [];
  if(r.list.length){
    if(r.list.some(s=>s.type!=="gensen")) F2.push(F("ng","特定口座（源泉徴収なし）と一般口座の分は、<b>確定申告が必要</b>です。利益が出ていれば申告して納めます。"));
    if(gensenOnly){
      if(r.afterCarry < 0 || r.carry) F2.push(F("warn","損失があります。<b>申告すれば翌年以後3年間の繰越控除</b>が使えますが、それには<b>損失が出た年も、その後の年も毎年申告し続ける</b>ことが要件です。1年でも抜けると使えなくなります。",R.stock2[0]));
      else if(r.list.length>1 && r.list.some(s=>s.pl<0) && r.list.some(s=>s.pl>0)) F2.push(F("warn","利益の口座と損失の口座があります。<b>申告すれば口座をまたいで通算でき</b>、源泉徴収された税金が戻る可能性があります。",R.stock1[0]));
      else F2.push(F("ok","源泉徴収ありの特定口座だけなので、<b>申告しないことも選べます</b>。そのままなら源泉徴収で課税は完結します。",R.stock3[0]));
    }
    F2.push(F("warn","<b>申告すると合計所得金額に入ります。</b>国民健康保険料・各種の所得制限・扶養の判定に響くことがあります。源泉徴収ありの口座を申告不要のままにすればこれらに影響しません。税金の還付額と保険料の増加を見比べてください。"));
  }
  adv.innerHTML = "";
  if(F2.length){
    const b = el(`<div class="role" style="margin-top:14px"><div class="rolehd"><span class="chip">判定</span><span class="rd">申告したほうがよいか</span></div><ul class="finds"></ul></div>`);
    const u = b.querySelector("ul");
    F2.forEach(f=>u.appendChild(el(`<li><span class="dot d-${f.level}"></span><span>${f.text}${f.src?`<span class="src">出典：${esc(f.src)}</span>`:""}</span></li>`)));
    adv.appendChild(b);
  }
  const cIn = el(`<div class="card" style="margin-top:12px"><div class="q"><div class="qlab">前年から繰り越した譲渡損失</div>
    <div class="qhint">前年の申告で繰り越した金額を入れてください。繰越は最大3年です。</div>
    <div class="numrow"><input type="number" inputmode="numeric" min="0" value="${+(D.stockCarry||{})[YEAR-1]||0}"><span class="unit">円</span></div></div></div>`);
  cIn.querySelector("input").oninput = e => { D.stockCarry = D.stockCarry||{}; D.stockCarry[YEAR-1] = +e.target.value||0; saveD(); drawStock(); };
  adv.appendChild(cIn);
}

let SF = null;
function openStock(pre){
  SF = Object.assign({id:null,year:YEAR,broker:"",type:"gensen",income:0,cost:0,wI:0,wR:0,div:0}, pre||{});
  document.getElementById("stockForm").style.display = "";
  document.getElementById("addStock").style.display = "none";
  drawStockForm();
}
function closeStock(){
  SF = null;
  document.getElementById("stockForm").style.display = "none";
  document.getElementById("addStock").style.display = "";
  drawStock();
}
function drawStockForm(){
  const box = document.getElementById("stockFields"); box.innerHTML = "";
  const row = (label,hint,node) => {
    const w = el(`<div class="q"><div class="qlab">${esc(label)}</div></div>`);
    if(hint) w.appendChild(el(`<div class="qhint">${esc(hint)}</div>`));
    w.appendChild(node); box.appendChild(w);
  };
  const num = (key,unit) => {
    const n = el(`<div class="numrow"><input type="number" inputmode="numeric" min="0" value="${SF[key]}"><span class="unit">${unit||"円"}</span></div>`);
    n.querySelector("input").oninput = e => SF[key] = +e.target.value||0;
    return n;
  };
  const b = el(`<input type="text" value="${esc(SF.broker)}" placeholder="証券会社名">`);
  b.oninput = () => SF.broker = b.value;
  row("証券会社",null,b);
  const t = el(`<div class="seg"></div>`);
  Object.entries(ACCT_TYPE).forEach(([v,l])=>{
    const bt = el(`<button aria-pressed="${SF.type===v}">${l}</button>`);
    bt.onclick = () => { SF.type = v; drawStockForm(); }; t.appendChild(bt);
  });
  row("口座の種類","源泉徴収ありなら申告しない選択もできます。なし・一般口座は申告が必要です。",t);
  row("譲渡の対価の額（収入）","年間取引報告書の「譲渡の対価の額」。一般口座は自分で計算した売却額の合計。",num("income"));
  row("取得費及び譲渡に要した費用の額","年間取引報告書の同名の欄。一般口座は取得費＋手数料の合計。",num("cost"));
  row("源泉徴収税額（所得税）","源泉徴収ありの口座のみ。",num("wI"));
  row("株式等譲渡所得割額（住民税）","源泉徴収ありの口座のみ。",num("wR"));
  row("配当等の額","この口座で受け取り、申告分離課税で通算する分だけ。0でも構いません。",num("div"));
  box.appendChild(el(`<div class="q"><div class="kv big"><span>譲渡損益</span><b class="${(SF.income-SF.cost)<0?"neg":"pos"}">${yen(SF.income-SF.cost)}</b></div></div>`));
}
function saveStock(){
  SF.year = YEAR;
  const edit = !!SF.id;
  if(edit){ const i = D.stocks.findIndex(x=>x.id===SF.id); if(i>=0) D.stocks[i] = {...SF} }
  else { SF.id = uid(); D.stocks.push({...SF}) }
  saveD(); say(edit ? "上書きしました。" : "保存しました。"); closeStock();
}

/* ═══════════════ FX（先物取引に係る雑所得等） ═══════════════ */
function fxCalc(year){
  const list = D.fx.filter(f=>+f.year===year).map(f=>({...f, pl:(+f.profit||0)-(+f.cost||0)}));
  const pl = list.reduce((t,f)=>t+f.pl,0);
  const carry = +(D.fxCarry||{})[year-1] || 0;
  const after = pl - carry;
  return {list, pl, carry, after, nextCarry: after<0 ? -after : 0};
}
function drawFx(){
  const r = fxCalc(YEAR);
  document.getElementById("fxSum").innerHTML = r.list.length ? `
    <div class="eyebrow">${YEAR}年 ・ 申告分離課税 20.315%</div>
    <div class="kv"><span>差金等決済に係る損益</span><b class="${r.pl<0?"neg":"pos"}">${yen(r.pl)}</b></div>
    ${r.carry?`<div class="kv"><span>前年から繰り越した損失</span><b class="neg">−${yen(r.carry)}</b></div>`:""}
    <div class="kv big"><span>先物取引に係る雑所得等</span><b class="${r.after<0?"neg":""}">${yen(Math.max(0,r.after))}</b></div>
    ${r.after>0?`<div class="kv"><span>税額の目安（所得税15.315%）</span><b>${yen(r.after*0.15315)}</b></div>
    <div class="kv"><span>住民税5%</span><b>${yen(r.after*0.05)}</b></div>`:""}
    ${r.nextCarry?`<div class="kv"><span>翌年へ繰り越せる損失</span><b class="neg">${yen(r.nextCarry)}</b></div>`:""}`
    : `<div class="empty">${YEAR}年の口座はまだ登録されていません。</div>`;

  const ul = document.getElementById("fxList"); ul.innerHTML = "";
  if(!r.list.length) ul.appendChild(el(`<li class="empty" style="display:block">年間損益報告書が出たら、口座ごとに入れてください。</li>`));
  r.list.forEach(f=>{
    const li = el(`<li>
      <span class="hbody"><span class="ht">${esc(f.broker||"（FX会社）")}</span><span class="hs">必要経費 ${yen(f.cost)}</span></span>
      <span class="hamt ${f.pl<0?"neg":"pos"}">${yen(f.pl)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    li.querySelector('[data-a=edit]').onclick = () => openFx({...f});
    li.querySelector('[data-a=del]').onclick = async () => {
      if(!await ask("この口座の記録を削除します。もとに戻せません。","削除する")) return;
      dropRow("fx", f.id); saveD(); drawFx();
    };
    ul.appendChild(li);
  });

  const adv = document.getElementById("fxAdvice"); adv.innerHTML = "";
  const F2 = [];
  if(r.list.length){
    if(r.pl > 0) F2.push(F("warn","利益が出ています。<b>確定申告が必要</b>です。FXは源泉徴収されないので、そのままだと納税漏れになります。",R.fx1[0]));
    if(r.pl < 0) F2.push(F("warn","損失は<b>翌年以後3年間</b>繰り越せます。ただし<b>損失の年も、その後の年も毎年続けて申告する</b>ことが要件です。1年でも抜けると使えません。",R.fx3[0]));
    F2.push(F("ng","このFXの損益は、<b>株式等とも仮想通貨とも通算できません</b>。同じ枠で通算できるのは、先物・オプション・CFDなど「先物取引に係る雑所得等」に入るものだけです。",R.fx2[0]));
    F2.push(F("info","「先物取引に係る雑所得等の金額の計算明細書」を申告書に付けます。損失を繰り越す年は「申告書付表（先物取引に係る繰越損失用）」も必要です。",R.fx3[0]));
  }
  if(F2.length){
    const b = el(`<div class="role" style="margin-top:14px"><div class="rolehd"><span class="chip">判定</span><span class="rd">申告と通算</span></div><ul class="finds"></ul></div>`);
    const u = b.querySelector("ul");
    F2.forEach(f=>u.appendChild(el(`<li><span class="dot d-${f.level}"></span><span>${f.text}${f.src?`<span class="src">出典：${esc(f.src)}</span>`:""}</span></li>`)));
    adv.appendChild(b);
  }
  const cIn = el(`<div class="card" style="margin-top:12px"><div class="q"><div class="qlab">前年から繰り越した損失</div>
    <div class="qhint">前年の申告で繰り越した「先物取引に係る損失」の金額。株式の繰越とは別に管理します。</div>
    <div class="numrow"><input type="number" inputmode="numeric" min="0" value="${+(D.fxCarry||{})[YEAR-1]||0}"><span class="unit">円</span></div></div></div>`);
  cIn.querySelector("input").oninput = e => { D.fxCarry = D.fxCarry||{}; D.fxCarry[YEAR-1] = +e.target.value||0; saveD(); drawFx(); };
  adv.appendChild(cIn);
}
let XF = null;
function openFx(pre){
  XF = Object.assign({id:null,year:YEAR,broker:"",profit:0,cost:0}, pre||{});
  document.getElementById("fxForm").style.display = "";
  document.getElementById("addFx").style.display = "none";
  const box = document.getElementById("fxFields"); box.innerHTML = "";
  const row = (label,hint,node) => {
    const w = el(`<div class="q"><div class="qlab">${esc(label)}</div></div>`);
    if(hint) w.appendChild(el(`<div class="qhint">${esc(hint)}</div>`));
    w.appendChild(node); box.appendChild(w);
  };
  const b = el(`<input type="text" value="${esc(XF.broker)}" placeholder="FX会社名">`);
  b.oninput = () => XF.broker = b.value;
  row("FX会社",null,b);
  const n = (key,unit) => {
    const w = el(`<div class="numrow"><input type="number" inputmode="numeric" value="${XF[key]}"><span class="unit">${unit}</span></div>`);
    w.querySelector("input").oninput = e => XF[key] = +e.target.value||0;
    return w;
  };
  row("差金等決済に係る利益（損失はマイナス）","年間損益報告書の実現損益。スワップポイントも含めます。",n("profit","円"));
  row("必要経費","取引手数料、FXのために直接かかった費用。生活費と混ざるものは入れないでください。",n("cost","円"));
}
function closeFx(){ XF=null; document.getElementById("fxForm").style.display="none"; document.getElementById("addFx").style.display=""; drawFx(); }
function saveFx(){
  XF.year = YEAR;
  const edit = !!XF.id;
  if(edit){ const i=D.fx.findIndex(x=>x.id===XF.id); if(i>=0) D.fx[i]={...XF} }
  else { XF.id=uid(); D.fx.push({...XF}) }
  saveD(); say(edit ? "上書きしました。" : "保存しました。"); closeFx();
}

/* ═══════════════ 給与所得 ═══════════════ */
const salaryOf = year => D.salary.find(s=>+s.year===year) || null;
function salaryCalc(year){
  const s = salaryOf(year); if(!s) return null;
  const pay = +s.payment||0;
  const inc = s.afterD ? (+s.afterD||0) : kyuyoShotoku(pay);
  return {...s, payment:pay, income:inc, auto:!s.afterD};
}

/* ═══════════════ 申告タブ ═══════════════
   管理者の申告の一覧は、事業所得の経費を全員分の合計にする（ほかの人の記録は GAS の summary で受け取る）。 */
const OTHERS = {};          /* 年 → [{email, name, entries}]（自分以外。管理者だけ） */
let OTHERS_ERR = "";
async function loadOthers(year, force){
  if(!isAdmin()) return [];
  if(OTHERS[year] && !force) return OTHERS[year];
  const r = await api("summary", {year}).catch(e => ({ok:false, message:e.message}));
  if(!r.ok){ OTHERS_ERR = r.message || "読み込めませんでした"; return null }
  OTHERS_ERR = "";
  OTHERS[year] = r.people || [];
  return OTHERS[year];
}
/* その年の経費の記録（管理者は全員分）。ほかの人の行には who（記録した人）を付ける */
function allEntries(year){
  const mine = D.entries.filter(e=>yOf(e.date)===year).map(e=>Object.assign({who:ME.name||ME.email}, e));
  if(!isAdmin()) return mine;
  const others = (OTHERS[year]||[]).flatMap(p => (p.entries||[]).filter(e=>yOf(e.date)===year).map(e=>Object.assign({}, e, {who:p.name||p.email})));
  return mine.concat(others);
}
const hasOthers = year => isAdmin() && (OTHERS[year]||[]).some(p => (p.entries||[]).length);
function kamokuSum(year){
  const rows = allEntries(year).filter(e=>!NOT_EXPENSE.includes(e.kamoku));
  const m = new Map();
  rows.forEach(e=> m.set(e.kamoku, (m.get(e.kamoku)||0) + (e.biz||0)));
  return KAMOKU.filter(k=>m.has(k)).map(k=>({kamoku:k, amount:m.get(k), fixed:KAMOKU_FIXED.has(k)}));
}
function drawTax(){
  const box = document.getElementById("taxBody"); box.innerHTML = "";
  const y = YEAR;
  if(isAdmin() && !OTHERS[y]){
    box.appendChild(el(`<div class="note">ほかの人の記録を読み込んでいます…</div>`));
    loadOthers(y).then(() => { if($("p-tax").classList.contains("on") && YEAR === y) drawTaxBody() });
    if(!OTHERS_ERR) return;
  }
  drawTaxBody();
}
function drawTaxBody(){
  const box = document.getElementById("taxBody"); box.innerHTML = "";
  const y = YEAR;
  const sal = salaryCalc(y);
  const ks  = kamokuSum(y);
  const keihi = ks.reduce((s,r)=>s+r.amount,0);
  const senju = ks.find(r=>r.kamoku==="専従者給与");
  const cry = cryptoAll(y), cryTotal = cry.reduce((s,r)=>s+r.income,0);
  const st  = stockCalc(y), fx = fxCalc(y);
  const multi = hasOthers(y);
  const whoTag = e => multi ? `<span class="rn" style="display:block;font-weight:400;font-size:10.5px;color:var(--ink3)">${esc(e.who)}</span>` : "";
  const excluded = allEntries(y).filter(e=>NOT_EXPENSE.includes(e.kamoku));

  /* ── 状況 ── */
  const ke = kyuyoEnd();
  const fromNote = ke && y === ke.y && ke.m < 12 ? `（${ke.m+1}月から。${ke.m===1?"1月":"1〜"+ke.m+"月"}は給与あり）` : "";
  box.appendChild(el(`<div class="note">
    <b>${y}年の立ち位置。</b>${isHonngyo(y)
      ? `個人事業が本業${fromNote}。健康保険は国民健康保険の想定です。事業・雑・分離の所得がそのまま保険料に効きます。`
      : `個人事業は副業で、給与所得があります。健康保険は勤務先のものなので、<b>株・FX・仮想通貨の所得が増えても健康保険料は変わりません</b>。`}
  </div>`));
  if(S.kyuyoEnd === undefined) box.appendChild(el(`<div class="note warnbox" style="margin-top:10px"><b>「給与が出る最後の月」がまだ入っていません。</b>基本項目タブで入れると、本業か副業か・給与があるかの表示がその月に合わせて変わります。給与が続く場合は空欄のままで構いません。</div>`));
  if(OTHERS_ERR) box.appendChild(el(`<div class="note warnbox" style="margin-top:10px"><b>ほかの人の記録を読み込めませんでした。</b>下の経費は自分の分だけです。${esc(OTHERS_ERR)}</div>`));
  else if(multi) box.appendChild(el(`<div class="note" style="margin-top:10px"><b>事業所得の経費は全員分の合計です。</b>家事按分の内訳・経費に入れていないものも、全員分を記録した人つきで出しています。人ごとの内訳は「全体」タブで見られます。</div>`));

  if(!isHonngyo(y)) box.appendChild(el(`<div class="note warnbox" style="margin-top:10px">
    <b>副業の間は「事業所得か、業務に係る雑所得か」が問われます。</b>帳簿書類を保存していれば原則として事業所得になります。保存がないと業務に係る雑所得となり、<b>青色申告特別控除も、給与との損益通算も使えません</b>。この台帳を年間つけ切ることが、そのまま要件を満たす証拠になります。
    <span class="src" style="display:block;font-size:11px;color:var(--ink3);margin-top:5px;font-family:var(--mono)">出典：所得税基本通達 35-2</span></div>`));

  /* ── 給与 ── */
  const sw = el(`<div><h2 class="sec">給与所得</h2></div>`);
  if(sal){
    sw.appendChild(el(`<div class="card pad">
      <div class="kv"><span>支払金額（源泉徴収票）</span><b>${yen(sal.payment)}</b></div>
      <div class="kv big"><span>給与所得の金額</span><b>${yen(sal.income)}</b></div>
      ${sal.auto?`<div class="qhint" style="margin:6px 0 0">給与所得控除は令和7年分以降の速算表で自動計算しています（${yen(kyuyoKojo(sal.payment))}）。源泉徴収票に「給与所得控除後の金額」があれば、そちらを入れてください。</div>`:""}
      <div class="kv"><span>源泉徴収税額</span><b>${yen(sal.withheld||0)}</b></div>
      <div class="kv"><span>社会保険料等の金額</span><b>${yen(sal.shakai||0)}</b></div>
    </div>`));
  } else {
    sw.appendChild(el(`<div class="card"><div class="empty">${hasSalaryYear(y)?"源泉徴収票の数字を入れてください。":"この年の給与はありません。"}</div></div>`));
  }
  const sb = el(`<button class="ghost" style="margin-top:10px">${sal?"給与の数字を直す":"＋ 源泉徴収票の数字を入れる"}</button>`);
  sb.onclick = () => openSalary(sal ? {...salaryOf(y)} : null);
  sw.appendChild(sb);
  box.appendChild(sw);

  /* ── 事業所得 ── */
  box.appendChild(el(`<h2 class="sec">事業所得（青色申告決算書）</h2>`));
  box.appendChild(el(`<div class="card scroller"><table class="jr">
    <tr><th style="width:auto">科目</th><th style="width:auto;text-align:right">金額</th></tr>
    ${ks.length ? ks.map(r=>`<tr><th style="width:auto;font-weight:600">${esc(r.kamoku)}${r.fixed?"":`<span class="rn" style="display:block;font-weight:400;font-family:var(--mono);font-size:10.5px;color:var(--ink3)">決算書の空欄行に記入</span>`}</th><td style="text-align:right">${yen(r.amount)}</td></tr>`).join("")
      : `<tr><td colspan="2" style="text-align:center;color:var(--ink3)">この年の経費はまだありません</td></tr>`}
    <tr><th style="width:auto;font-weight:700">経費計${senju?"（専従者給与を含む）":""}</th><td style="text-align:right;font-weight:700">${yen(keihi)}</td></tr>
  </table></div>`));
  const bunp = allEntries(y).filter(e=>e.ratio<100 && !NOT_EXPENSE.includes(e.kamoku));
  if(bunp.length) box.appendChild(el(`<div class="card scroller" style="margin-top:12px"><table class="jr">
    <tr><th style="width:auto">家事按分の内訳</th><th style="width:auto;text-align:right">支払額</th><th style="width:auto;text-align:right">割合</th><th style="width:auto;text-align:right">経費</th></tr>
    ${bunp.map(e=>`<tr><th style="width:auto;font-weight:600">${esc(e.kamoku)}${e.payee?" ・ "+esc(e.payee):""}${whoTag(e)}</th><td style="text-align:right">${yen(e.amount)}</td><td style="text-align:right">${e.ratio}%</td><td style="text-align:right">${yen(e.biz)}</td></tr>`).join("")}
  </table></div>`));
  if(excluded.length) box.appendChild(el(`<div class="note" style="margin-top:12px"><b>経費に入れていないもの（${excluded.length}件・${yen(excluded.reduce((s,e)=>s+e.amount,0))}）。</b>所得控除・資産計上・家事費として台帳に残していますが、上の集計には入れていません。小規模企業共済やiDeCoは確定申告書の所得控除欄に書きます。${multi?`<span style="display:block;margin-top:6px">${excluded.map(e=>`${esc(e.who)}：${esc(e.kamoku.replace("経費にしない",""))} ${yen(e.amount)}`).join("／")}</span>`:""}</div>`));

  /* ── 雑所得（仮想通貨） ── */
  box.appendChild(el(`<h2 class="sec">雑所得（仮想通貨・総合課税）</h2>`));
  box.appendChild(el(`<div class="card pad">
    ${cry.length?`<div class="kv"><span>総収入金額（譲渡収入）</span><b>${yen(cry.reduce((s,r)=>s+r.sellVal,0))}</b></div>
    <div class="kv"><span>必要経費（譲渡原価＋手数料）</span><b>${yen(cry.reduce((s,r)=>s+r.need,0))}</b></div>
    <div class="kv big"><span>雑所得の金額</span><b class="${cryTotal<0?"neg":""}">${yen(cryTotal)}</b></div>`
    :`<div class="empty" style="padding:8px 0">この年の取引はありません。</div>`}
  </div>`));
  if(cryTotal!==0 && !isHonngyo(y)) box.appendChild(el(`<div class="note warnbox" style="margin-top:10px">
    <b>20万円以下でも書きます。</b>給与所得者で給与以外の所得が20万円以下なら申告不要という規定はありますが、これは「申告する場合に書かなくてよい」という意味ではありません。事業所得で確定申告をする以上、20万円以下の雑所得も併せて申告します。
    <span class="src" style="display:block;font-size:11px;color:var(--ink3);margin-top:5px;font-family:var(--mono)">出典：No.1900 給与所得者で確定申告が必要な人</span></div>`));

  /* ── 分離課税 ── */
  box.appendChild(el(`<h2 class="sec">申告分離課税</h2>`));
  box.appendChild(el(`<div class="card pad">
    <div class="kv"><span>上場株式等の譲渡所得等${st.carry?"（繰越控除後）":""}</span><b class="${st.afterCarry<0?"neg":""}">${yen(Math.max(0,st.afterCarry))}</b></div>
    <div class="kv"><span>先物取引に係る雑所得等（FX）${fx.carry?"（繰越控除後）":""}</span><b class="${fx.after<0?"neg":""}">${yen(Math.max(0,fx.after))}</b></div>
    <div class="qhint" style="margin:8px 0 0">この2つは互いに通算できません。仮想通貨の雑所得とも通算できません。それぞれ別の欄に書きます。</div>
  </div>`));

  /* ── 合計所得の目安 ── */
  const uriage = salesOf(y);
  const aoiroKojo = S.aoiro!=="aoiro" ? 0 : (S.aoiroAmt==="10" ? 100000 : S.aoiroAmt==="55" ? 550000 : 650000);
  const jigyoBefore = uriage - keihi;
  const kojoUsed = Math.max(0, Math.min(aoiroKojo, jigyoBefore));
  const jigyo = jigyoBefore - kojoUsed;
  const sougou = (sal?sal.income:0) + jigyo + Math.max(0,cryTotal);
  box.appendChild(el(`<h2 class="sec">合計所得金額の目安</h2>`));
  box.appendChild(el(`<div class="card pad">
    <div class="kv"><span>事業の売上</span><b>${yen(uriage)}</b></div>
    <div class="kv"><span>経費計</span><b>−${yen(keihi)}</b></div>
    ${aoiroKojo?`<div class="kv"><span>青色申告特別控除</span><b>−${yen(kojoUsed)}${kojoUsed<aoiroKojo?`（上限${yen(aoiroKojo)}のうち）`:""}</b></div>`:""}
    <div class="kv big"><span>事業所得</span><b class="${jigyo<0?"neg":""}">${yen(jigyo)}</b></div>
    <div class="kv" style="margin-top:6px"><span>給与所得</span><b>${yen(sal?sal.income:0)}</b></div>
    <div class="kv"><span>雑所得（仮想通貨）</span><b>${yen(Math.max(0,cryTotal))}</b></div>
    <div class="kv big"><span>総合課税の合計所得金額</span><b>${yen(sougou)}</b></div>
    <div class="kv" style="margin-top:6px"><span>分離・株式等</span><b>${yen(Math.max(0,st.afterCarry))}</b></div>
    <div class="kv"><span>分離・FX</span><b>${yen(Math.max(0,fx.after))}</b></div>
    ${!uriage?`<div class="qhint" style="margin:8px 0 0">売上は<b>基本項目</b>タブの「この年の収入」に入れてください。</div>`:""}
    ${jigyoBefore<0&&sal?`<div class="qhint" style="margin:8px 0 0">事業が赤字です。<b>事業所得なら給与所得と損益通算できます</b>（青色申告特別控除は赤字には使えないため0）。業務に係る雑所得と判定されると通算できません。</div>`:""}
  </div>`));

  /* ── 出力 ── */
  box.appendChild(el(`<h2 class="sec">CSVで保存</h2>`));
  const btns = el(`<div style="display:flex;gap:8px;flex-wrap:wrap"></div>`);
  const mk = (label, fn) => { const b = el(`<button class="ghost">${label}</button>`); b.onclick = () => fn(b); btns.appendChild(b); };
  mk("決算書の転記用", b => saveFile(fname(y,"決算書転記用"), csvKamoku(y), b));
  mk("経費の明細",     b => saveFile(fname(y,"経費明細"),     csvLedger(y), b));
  mk("暗号資産の計算用", b => saveFile(fname(y,"暗号資産"),   csvCrypto(y), b));
  mk("投資の損益",     b => saveFile(fname(y,"投資損益"),     csvInvest(y), b));
  box.appendChild(btns);
  box.appendChild(el(`<p class="lede" style="margin-top:10px">ファイル名は <span style="font-family:var(--mono)">${esc(safeName(S.exportName))}_${y}_○○.csv</span> になります。名前は<b>基本項目</b>タブで変えられます。保存先はブラウザの既定のダウンロード先です。iPhone のホーム画面から開いているときは、共有メニューが出るので「ファイルに保存」を選んでください。${multi?"経費の明細には「記録した人」の列が付きます。":""}</p>`));
}

/* ── CSV ── */
const q = v => `"${String(v==null?"":v).replace(/"/g,'""')}"`;
const csvKamoku = y => {
  const ks = kamokuSum(y);
  return ["科目,金額,決算書の記入欄",
    ...ks.map(r=>[q(r.kamoku),r.amount,q(r.fixed?"印字済みの行":"空欄行に記入")].join(",")),
    ["経費計",ks.reduce((s,r)=>s+r.amount,0),q("")].join(",")].join("\r\n");
};
/* 管理者でほかの人の記録があるとき（withWho）は、「記録した人」の列を足す */
const csvLedger = (y, withWho) => {
  const who = withWho === undefined ? hasOthers(y) : withWho;
  return ["日付,勘定科目,相手先,摘要,支払額,事業割合,経費計上額,判定,領収書" + (who ? ",記録した人" : ""),
  ...allEntries(y).sort((a,b)=>a.date<b.date?-1:1)
    .map(e=>[q(e.date),q(e.kamoku),q(e.payee),q(e.memo),e.amount,e.ratio,e.biz||0,
      q({ok:"可",warn:"条件付",ng:"否認リスク"}[e.verdict]||""),q(e.receiptId||e.photoId?"あり":"なし")].concat(who ? [q(e.who)] : []).join(","))].join("\r\n");
};
const csvCrypto = y => {
  const rs = cryptoAll(y);
  return [`銘柄,期首数量,期首評価額,取得数量,取得価額,譲渡数量,譲渡収入,平均単価,譲渡原価,手数料,所得,期末数量,期末評価額（翌年繰越）`,
    ...rs.map(r=>[q(r.coin),r.open.qty||0,r.open.value||0,r.buyQty,r.buyVal,r.sellQty,r.sellVal,
      Math.round(r.unit),Math.round(r.cost),r.sellFee,Math.round(r.income),r.endQty,Math.round(r.endVal)].join(",")),
    `,,,,,,,,,,${rs.reduce((s,r)=>s+Math.round(r.income),0)},,`,
    ``,`評価方法,${S.cmethod==="ido"?"移動平均法":"総平均法"}`].join("\r\n");
};
const csvInvest = y => {
  const st = stockCalc(y), fx = fxCalc(y);
  const L = ["区分,口座,種類,収入・利益,取得費・必要経費,損益,源泉所得税,住民税,配当等"];
  st.list.forEach(s=>L.push(["上場株式等",q(s.broker),q(ACCT_TYPE[s.type]),s.income||0,s.cost||0,s.pl,s.wI||0,s.wR||0,s.div||0].join(",")));
  fx.list.forEach(f=>L.push(["先物取引等（FX）",q(f.broker),q("申告分離"),f.profit||0,f.cost||0,f.pl,0,0,0].join(",")));
  L.push("");
  L.push(`上場株式等 譲渡損益合計,${st.pl}`);
  L.push(`上場株式等 前年繰越損失,${st.carry}`);
  L.push(`上場株式等 繰越控除後,${Math.max(0,st.afterCarry)}`);
  L.push(`上場株式等 翌年繰越,${st.nextCarry}`);
  L.push(`FX 損益合計,${fx.pl}`);
  L.push(`FX 前年繰越損失,${fx.carry}`);
  L.push(`FX 繰越控除後,${Math.max(0,fx.after)}`);
  L.push(`FX 翌年繰越,${fx.nextCarry}`);
  return L.join("\r\n");
};

/* ── 給与の入力 ── */
function openSalary(pre){
  const cur = Object.assign({id:null,year:YEAR,payment:0,withheld:0,shakai:0,afterD:0}, pre||{});
  const box = document.getElementById("taxBody"); box.innerHTML = "";
  box.appendChild(el(`<h2 class="sec">${YEAR}年の源泉徴収票</h2>`));
  const card = el(`<div class="card"></div>`);
  const row = (label,hint,key,unit) => {
    const w = el(`<div class="q"><div class="qlab">${esc(label)}</div>${hint?`<div class="qhint">${esc(hint)}</div>`:""}
      <div class="numrow"><input type="number" inputmode="numeric" min="0" value="${cur[key]}"><span class="unit">${unit}</span></div></div>`);
    w.querySelector("input").oninput = e => { cur[key] = +e.target.value||0; };
    card.appendChild(w);
  };
  row("支払金額","源泉徴収票のいちばん左の金額です。","payment","円");
  row("給与所得控除後の金額","記載があればそのまま入れてください。0のままなら速算表で自動計算します。","afterD","円");
  row("源泉徴収税額",null,"withheld","円");
  row("社会保険料等の金額","確定申告で社会保険料控除に使います。","shakai","円");
  box.appendChild(card);
  const acts = el(`<div style="display:flex;gap:8px;margin-top:12px"></div>`);
  const ok = el(`<button class="go" style="margin:0;flex:2">保存</button>`);
  ok.onclick = () => {
    cur.year = YEAR;
    const i = D.salary.findIndex(s=>+s.year===YEAR);
    if(i>=0) D.salary[i] = {...cur, id:D.salary[i].id};
    else { cur.id = uid(); D.salary.push({...cur}) }
    saveD(); drawTax();
  };
  const ng = el(`<button class="ghost" style="flex:1">やめる</button>`);
  ng.onclick = drawTax;
  acts.appendChild(ok); acts.appendChild(ng); box.appendChild(acts);
  if(pre && pre.id){
    const del = el(`<button class="ghost" style="margin-top:10px;width:100%">この年の給与を消す</button>`);
    del.onclick = () => { D.salary = D.salary.filter(s=>+s.year!==YEAR); saveD(); drawTax(); };
    box.appendChild(del);
  }
  window.scrollTo({top:0,behavior:"instant"});
}

/* ═══════════════ 設定 ═══════════════ */
const SETTINGS=[
  {id:"entity",label:"事業形態",hint:"交際費・社宅・日当の扱いが根本から変わります。",opts:[["kojin","個人事業"],["hojin","法人"]]},
  {id:"aoiro",label:"申告",hint:"「所得税の青色申告承認申請書」を出していれば青色、出していなければ白色です。あとから遡って青色にはできません。",
   note:`<b>出したかどうかの確かめ方。</b>①所轄の税務署に電話（いちばん確実）②e-Taxのメッセージボックスの受信通知 ③申告書等情報取得サービスで過去の申告書を取り、<b>青色申告決算書が出れば青色・収支内訳書なら白色</b> ④開業届と一緒に出した控え。※令和7年1月から書面の控えに収受日付印は押されないため、最近の提出だと印がありません。<br>
   <b>これから青色にするなら。</b>青色にしたい年の3月15日まで（1月16日以後に開業した年は開業から2か月以内）に申請書を出します。<br>
   <b>青色だと何が変わるか。</b>青色申告特別控除、青色事業専従者給与（白色は配偶者86万・その他50万が上限）、赤字の3年繰越、30万円未満の一括経費、貸倒引当金。<br>
   <span style="color:var(--ink3)">出典：No.2070 青色申告制度</span>`,
   opts:[["aoiro","青色申告"],["shiroiro","白色申告"]]},
  {id:"aoiroAmt",label:"青色申告特別控除",hint:"複式簿記＋e-Taxまたは電子帳簿保存なら65万円、複式簿記のみなら55万円、それ以外は10万円。",showIf:()=>S.aoiro==="aoiro",
   note:`⚠️ <b>65万円・55万円には複式簿記の帳簿（仕訳帳・総勘定元帳）と貸借対照表が要ります。このツールは作りません。</b>会計ソフトで複式簿記をつけていないなら10万円です。65万円にはさらに e-Tax での期限内申告か電子帳簿保存が必要。<br>
   <b>差額は大きい。</b>限界税率30%（所得税20%＋住民税10%）の帯なら、10万円控除で約3万円、65万円控除で約19.5万円。<b>その差 約16.5万円</b>。会計ソフトの年額を大きく上回ります。<br><span style="color:var(--ink3)">出典：No.2072 青色申告特別控除</span>`,
   opts:[["65","65万円"],["55","55万円"],["10","10万円"]]},
  {id:"shohi",label:"消費税",hint:"インボイスの要否がここで決まります。",
   note:`<b>どれを選ぶか。</b>インボイス登録をしていないなら、次の2つがどちらも1,000万円以下で<b>免税事業者</b>です。<br>
   ・基準期間＝<b>その年の前々年</b>の課税売上高<br>
   ・特定期間＝<b>前年の1月1日〜6月30日</b>の課税売上高（給与等支払額で判定してもよい）<br>
   <b>登録していると1,000万円以下でも免除されません。</b>また<b>2割特例はインボイス登録をした人だけ</b>の措置、簡易課税は課税事業者が届出をした場合の計算方法です。<br>
   <span style="color:var(--ink3)">出典：No.6501 納税義務の免除</span>`,
   opts:[["menzei","免税事業者"],["honsoku","本則課税"],["kani","簡易課税"],["niwari","2割特例"]]},
  {id:"kyuyo",label:"給与の支払",hint:"個人で給与を1円も払っていなければ、講師謝金やデザイン料の源泉徴収義務がありません。",opts:[["nashi","していない"],["ari","従業員・専従者に払っている"]]},
  {id:"cmethod",label:"暗号資産の評価方法",hint:"「所得税の暗号資産の評価方法の届出書」を出していなければ、法定は総平均法です。一度決めたら継続して使ってください。",opts:[["sohei","総平均法（届出なし）"],["ido","移動平均法（届出済み）"]]},
  {id:"kenpo",label:"健康保険",hint:"勤務先の健康保険なら、株や仮想通貨の所得が増えても保険料は変わりません。国民健康保険だと保険料に跳ねます。",opts:[["shakai","勤務先の健康保険"],["kokuho","国民健康保険"]]},
  {id:"kyuyoEnd",type:"month",label:"給与が出る最後の月",showIf:()=>isAdmin(),
   hint:"勤め先の給与が最後に出る月。申告の一覧の「給与があるか」「個人事業が本業か副業か」に使います。空欄なら、給与が続く（個人事業は副業）として扱います。"},
  {id:"exportName",type:"text",label:"保存ファイルの名前",placeholder:"経費判定君",
   hint:"CSVとバックアップのファイル名の先頭に付きます。",
   note:`<b>保存先フォルダは指定できません。</b>ブラウザの既定のダウンロード先に入ります。代わりに<b>ファイル名を「名前＿年＿種類」で固定</b>しているので、平らなフォルダでも年ごとにまとまって並びます。<br>
   例：<span style="font-family:var(--mono)">経費判定君_2026_経費明細.csv</span><br>
   PCでは、年ごとのフォルダを作って移すと探しやすくなります。`},
];
function drawSettings(){
  const box=document.getElementById("setList"); box.innerHTML="";
  SETTINGS.filter(s=>!s.showIf || s.showIf()).forEach(s=>{
    const w=el(`<div class="q"><div class="qlab">${esc(s.label)}</div><div class="qhint">${esc(s.hint)}</div></div>`);
    if(s.type==="month"){
      const i=el(`<input type="month" value="${esc(S[s.id]||"")}">`);
      i.onchange=()=>{ S[s.id]=i.value; saveS(); };
      w.appendChild(i);
      box.appendChild(w); return;
    }
    if(s.type==="text"){
      const i=el(`<input type="text" value="${esc(S[s.id]||"")}" placeholder="${esc(s.placeholder||"")}">`);
      i.oninput=()=>{ S[s.id]=i.value; saveS(); };
      w.appendChild(i);
      if(s.note) w.appendChild(el(`<div class="note" style="margin-top:10px">${s.note}</div>`));
      box.appendChild(w); return;
    }
    const seg=el(`<div class="seg"></div>`);
    s.opts.forEach(([v,l])=>{
      const b=el(`<button aria-pressed="${S[s.id]===v}">${esc(l)}</button>`);
      b.onclick=()=>{
        S[s.id]=v; saveS(); drawSettings(); drawMeta();
        if(document.getElementById("p-tax").classList.contains("on")) drawTax();
      };
      seg.appendChild(b);
    });
    w.appendChild(seg);
    if(s.note) w.appendChild(el(`<div class="note" style="margin-top:10px">${s.note}</div>`));
    box.appendChild(w);
  });
}
function drawMeta(){
  document.getElementById("hmeta").textContent =
    `${isHojin()?"法人":"個人"} / ${S.aoiro==="aoiro"?"青":"白"} / ${({menzei:"免税",honsoku:"本則",kani:"簡易",niwari:"2割"})[S.shohi]}`;
}
function applyTheme(){
  const r=document.documentElement;
  if(THEME.get()==="auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme",THEME.get());
  document.querySelectorAll("#themeSeg button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.v===THEME.get()));
}

/* ═══════════════ 根拠タブ ═══════════════ */
function drawRefs(){
  const ul=document.getElementById("refList");
  [...new Map(Object.values(R).map(r=>[r[1],r])).values()].forEach(([t,u])=>{
    ul.appendChild(el(`<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a><span class="rn">${esc(u)}</span></li>`));
  });
  const rows=[
    ["交際費から外せる飲食費","社外の人を含む飲食で1人あたり <b>10,000円以下</b>（令和6年4月1日以後の支出。それ以前は5,000円）。参加者の氏名・関係を書いた書類の保存が要件。","No.5265"],
    ["中小法人の交際費","資本金1億円以下は年 <b>800万円</b> まで全額損金、または接待飲食費の50%損金の選択。","No.5265"],
    ["食事支給の非課税限度","本人が半額以上を負担し、会社負担が月 <b>7,500円以下</b>（消費税を除く）。令和8年4月1日以後の支給から（改正前3,500円）。現金支給は不可。","No.2594"],
    ["役員社宅・小規模の判定","法定耐用年数30年以下は <b>132㎡以下</b>、30年超は <b>99㎡以下</b>。240㎡超は豪華社宅の目安。","No.2600"],
    ["賃貸料相当額（小規模）","①建物の固定資産税課税標準額×<b>0.2%</b> ＋ ②<b>12円</b>×総床面積÷3.3㎡ ＋ ③敷地の課税標準額×<b>0.22%</b>","No.2600"],
    ["少額の減価償却資産","<b>10万円未満</b>＝使用年に全額。<b>20万円未満</b>＝一括償却資産（3年均等）。","No.5403"],
    ["30万円未満の特例","青色申告・従業員500人以下、年間合計 <b>300万円</b> まで。適用期限は本文上 <b>令和8年3月31日</b>（延長の記載なし＝要確認）。","No.5408"],
    ["中古資産の簡便法","全部経過＝法定耐用年数×<b>20%</b>。一部経過＝(法定−経過)＋経過×<b>20%</b>。1年未満切捨て、<b>2年</b>が下限。","No.5404"],
    ["青色事業専従者","生計を一にする親族／12月31日時点で <b>15歳以上</b>／年を通じて <b>6ヶ月超</b> 専従／届出は <b>3月15日</b> まで（途中開業は2ヶ月以内）／労務の対価として相当な額。","No.2075"],
    ["白色の事業専従者控除","配偶者 <b>86万円</b>、その他の親族 <b>50万円</b> が上限。","No.2075"],
    ["家事関連費","業務に必要な部分が50%超なら必要経費。50%以下でも <b>明らかに区分できれば</b> その部分は必要経費。","所基通45-1・45-2"],
    ["インボイス経過措置","令和8年9月30日まで <b>80%</b> → 令和8年10月1日〜令和10年9月30日 <b>70%</b> → 50% → 30% → 0%。令和8年10月以降、同一事業者からの年間仕入が1億円超の部分は対象外。","令和8年度改正"],
    ["少額特例","税込 <b>1万円未満</b> は帳簿の保存だけで控除可。基準期間の課税売上高1億円以下または特定期間5,000万円以下。令和11年9月30日まで。1回の取引単位で判定。","少額特例の概要"],
    ["報酬・料金の源泉徴収税率","100万円以下は <b>10.21%</b>。100万円超は（支払額−100万円）×<b>20.42%</b>＋<b>102,100円</b>。納付は支払った月の<b>翌月10日</b>まで。請求書で報酬額と消費税額が明確に区分されていれば報酬額のみを対象にしてよい。","No.2795"],
    ["源泉徴収をしなくてよい個人","<b>個人であって給与等の支払をしていない者</b>、および常時2人以下の家事使用人のみに給与を支払う者は、報酬・料金の源泉徴収義務がない（ホステス等への報酬を除く）。","No.2793"],
    ["補助金の収入計上時期","交付決定の通知を受けた年（入金した年ではない）。","No.2202"],
    ["補助金の総収入金額不算入","固定資産の取得・改良に充てた分は総収入金額に算入せず、その分だけ取得価額を減額して償却する。<b>確定申告書への記載と明細書の添付</b>が要件。","No.2202"],
  ];
  document.getElementById("numTable").innerHTML =
    rows.map(([a,b,c])=>`<tr><th>${a}<span class="rn" style="display:block;font-weight:400;font-family:var(--mono);font-size:10.5px;color:var(--ink3)">${c}</span></th><td style="font-family:var(--gothic)">${b}</td></tr>`).join("");
}

/* ═══════════════ 起動 ═══════════════ */
const $ = id => document.getElementById(id);
let RECTAB = "keihi";

function switchTab(p){
  if(!isAdmin() && (p==="tax" || p==="all")) p = "rec";
  document.querySelectorAll("nav.tabs button").forEach(x=>x.setAttribute("aria-selected", x.dataset.p===p));
  document.querySelectorAll(".page").forEach(s=>s.classList.toggle("on", s.id==="p-"+p));
  if(p==="rec"){ drawRecTab() }
  if(p==="tax"){ drawTax() }
  if(p==="all"){ drawAll() }
  if(p==="set"){ drawSettings(); drawIncome(); drawStore(); drawDriveMsg() }
  window.scrollTo({top:0,behavior:"instant"});
}
/* 役割で出し分ける。利用者には申告の一覧・全体・投資・この年の収入を出さない */
function applyRole(){
  const adm = isAdmin();
  document.querySelector('nav.tabs button[data-p="tax"]').parentElement.hidden = !adm;
  $("navAll").hidden = !adm;
  document.querySelector('#recSeg button[data-v="inv"]').hidden = !adm;
  $("incomeWrap").hidden = !adm;
  if(!adm && RECTAB==="inv") RECTAB = "keihi";
}
function drawRecTab(){
  const gated = !S.setupDone;
  $("gate").style.display = gated ? "" : "none";
  $("recWrap").style.display = gated ? "none" : "";
  if(gated){
    $("gate").innerHTML = "";
    const c = el(`<div class="card pad"><div class="eyebrow">はじめに</div>
      <div style="font-family:var(--mincho);font-size:17px;font-weight:600;margin:2px 0 6px">基本項目を先に登録してください</div>
      <p class="lede" style="margin:0 0 4px">事業形態・申告の種類・消費税・給与の有無で、経費になるかどうかの判定が変わります。登録が済むと、この画面が経費の入力フォームに変わります。</p></div>`);
    const b = el(`<button class="go">基本項目を開く →</button>`);
    b.onclick = () => switchTab("set");
    c.appendChild(b);
    $("gate").appendChild(c);
    return;
  }
  $("recKeihi").style.display = RECTAB==="keihi" ? "" : "none";
  $("recCar").style.display   = RECTAB==="car"   ? "" : "none";
  $("recInv").style.display   = RECTAB==="inv"   ? "" : "none";
  document.querySelectorAll("#recSeg button").forEach(b=>b.setAttribute("aria-pressed", b.dataset.v===RECTAB));
  if(RECTAB==="keihi"){ drawRec(); drawLedger() }
  else if(RECTAB==="car"){ drawCar() }
  else { drawInv() }
}
/* ═══════════════ 運行記録（車の按分の根拠） ═══════════════ */
function carTotal(y){ const o = D.odo[y] || {}; return Math.max(0, (+o.end||0) - (+o.start||0)) }
function carBiz(y){ return D.trips.filter(t=>yOf(t.date)===y).reduce((s,t)=>s+(+t.km||0), 0) }
function carRatio(y){
  const t = carTotal(y), b = carBiz(y);
  if(!t || !b) return null;
  return Math.min(100, Math.round(b / t * 1000) / 10);
}
const km = n => (+n||0).toLocaleString() + " km";

function drawOdoSum(){
  const t = carTotal(YEAR);
  $("odoSum").innerHTML = t
    ? `この年の総走行距離 <b>${km(t)}</b>`
    : "年初と年末のメーターを入れると、総走行距離が出ます。";
}
function drawRatioBox(){
  const r = carRatio(YEAR), t = carTotal(YEAR), b = carBiz(YEAR);
  const box = $("carRatioBox"); box.innerHTML = "";
  if(r === null){
    box.appendChild(el(`<div class="note" style="margin-top:14px">総走行距離と業務の記録が<b>両方そろうと</b>、事業使用割合が出ます。いまは総走行距離 ${t?km(t):"未入力"}、業務 ${km(b)} です。</div>`));
    return;
  }
  box.appendChild(el(`<div class="card pad" style="margin-top:14px">
    <div class="eyebrow">この年の事業使用割合</div>
    <div style="font-family:var(--mono);font-size:34px;font-weight:600;letter-spacing:-.02em;margin:6px 0 2px">${r}%</div>
    <p class="lede" style="margin:0">業務 ${km(b)} ÷ 総走行距離 ${km(t)}。ガソリン・車検・自動車税・保険・駐車場は、すべてこの割合で按分します。</p>
    <p class="lede" style="margin:8px 0 0">経費の記録で<b>「車の維持費」「車の購入」</b>を選ぶと、この割合が最初から入ります。</p>
  </div>`));
}
function drawCar(){
  const o = D.odo[YEAR] || {};
  $("odoStart").value = o.start || "";
  $("odoEnd").value   = o.end   || "";
  drawOdoSum();

  const ul = $("tripList"); ul.innerHTML = "";
  const rows = D.trips.filter(t=>yOf(t.date)===YEAR).sort((a,b)=> a.date<b.date?1:-1);
  if(!rows.length) ul.appendChild(el(`<li class="empty" style="display:block">${YEAR}年の運行記録はまだありません。</li>`));
  rows.forEach(t=>{
    const li = el(`<li>
      <span class="hbody"><span class="ht">${esc(t.dest)}</span>
      <span class="hs">${esc(t.date)}${t.purpose?" ・ "+esc(t.purpose):""}</span></span>
      <span class="hamt">${km(t.km)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    li.querySelector('[data-a=edit]').onclick = () => openTrip({...t});
    li.querySelector('[data-a=del]').onclick = async () => {
      if(!await ask("この運行記録を削除します。もとに戻せません。","削除する")) return;
      dropRow("trips", t.id); saveD(); drawCar();
    };
    ul.appendChild(li);
  });
  drawRatioBox();
}
function odoChanged(){
  const o = D.odo[YEAR] = D.odo[YEAR] || {};
  o.start = +$("odoStart").value || 0;
  o.end   = +$("odoEnd").value   || 0;
  saveD(); drawOdoSum(); drawRatioBox();
}
let TRIP = null;
function openTrip(pre){
  TRIP = Object.assign({id:null, date:today(), dest:"", purpose:"", km:0}, pre||{});
  drawTripForm(); $("tripForm").style.display = ""; $("addTrip").style.display = "none";
  $("tripForm").scrollIntoView({behavior:"smooth", block:"nearest"});
}
function drawTripForm(){
  const f = $("tripFields"); f.innerHTML = "";
  const mk = (lab,hint,html) => el(`<div class="q"><div class="qlab">${lab}</div>${hint?`<div class="qhint">${hint}</div>`:""}${html}</div>`);
  const d  = mk("日付","",`<input type="date" value="${esc(TRIP.date)}">`);
  d.querySelector("input").oninput  = e => TRIP.date = e.target.value;
  const de = mk("行き先","市町村名でも訪問先の名前でも構いません。",`<input type="text" value="${esc(TRIP.dest)}" placeholder="宮崎市・〇〇商事">`);
  de.querySelector("input").oninput = e => TRIP.dest = e.target.value;
  const p  = mk("目的","何の用件だったか。これが無いと業務と認められません。",`<input type="text" value="${esc(TRIP.purpose)}" placeholder="打合せ・納品・現地調査">`);
  p.querySelector("input").oninput  = e => TRIP.purpose = e.target.value;
  const k  = mk("走行距離","<b>往復の距離</b>を入れてください。",`<div class="numrow"><input type="number" inputmode="numeric" min="0" value="${TRIP.km||""}"><span class="unit">km</span></div>`);
  k.querySelector("input").oninput  = e => TRIP.km = +e.target.value || 0;
  [d,de,p,k].forEach(x=>f.appendChild(x));
}

/* ═══════════════ 投資 ═══════════════ */
function drawInv(){
  drawRepList();
  $("invCrypto").style.display = INVTAB==="crypto" ? "" : "none";
  $("invStock").style.display  = INVTAB==="stock"  ? "" : "none";
  $("invFx").style.display     = INVTAB==="fx"     ? "" : "none";
  document.querySelectorAll("#invSeg button").forEach(b=>b.setAttribute("aria-pressed", b.dataset.v===INVTAB));
  if(INVTAB==="crypto") drawCrypto();
  if(INVTAB==="stock")  drawStock();
  if(INVTAB==="fx")     drawFx();
}
function years(){
  const now = new Date().getFullYear();
  const set = new Set([now, now-1, now+1, YEAR]);
  [...D.entries.map(e=>yOf(e.date)), ...D.trades.map(t=>yOf(t.date)), ...D.trips.map(t=>yOf(t.date)),
   ...D.stocks.map(s=>+s.year), ...D.fx.map(f=>+f.year), ...D.salary.map(s=>+s.year), ...D.rev.map(r=>+r.year),
   ...Object.keys(D.odo||{}).map(Number)]
    .filter(Boolean).forEach(y=>set.add(y));
  return [...set].sort((a,b)=>b-a);
}
function drawYears(){
  ["yearSel","yearSel2","yearSel3","yearSel4"].forEach(id=>{
    const s = $(id); if(!s) return;
    s.innerHTML = years().map(y=>`<option value="${y}"${y===YEAR?" selected":""}>${y}年</option>`).join("");
    s.onchange = () => {
      YEAR = +s.value; drawYears();
      if($("p-rec").classList.contains("on")) drawRecTab();
      if($("p-tax").classList.contains("on")) drawTax();
      if($("p-all").classList.contains("on")) drawAll();
      if($("p-set").classList.contains("on")) drawIncome();
    };
  });
}

/* ═══════════════ 売上の内訳 ═══════════════
   区分ごとに気をつける点が違うので、選ばせて注意を出す。
   メルカリ・ヤフオクは「不用品の売却」なら非課税で売上に入れない（所法9条1項9号）。 */
const REVKIND = [
  {id:"jutaku", n:"受託・コンサル", s:"請求書を出す仕事"},
  {id:"note",   n:"note の販売",    s:"記事・マガジン"},
  {id:"kindle", n:"Kindle（KDP）",  s:"ロイヤリティ"},
  {id:"flea",   n:"メルカリ・ヤフオク", s:"フリマ・オークション"},
  {id:"other",  n:"その他",          s:"広告・アフィリエイトなど"}
];
const revName = k => (REVKIND.find(x=>x.id===k)||{}).n || k;
/* 売上に入る金額（非課税のフリマ売却は入れない） */
const revBiz = r => (r.kind==="flea" && r.fleaType==="used") ? 0 : (+r.amount||0);
const revTotal = y => D.rev.filter(r=>+r.year===y).reduce((a,r)=>a+revBiz(r), 0);
/* 内訳があればその合計、なければ手入力の値 */
const salesOf = y => D.rev.some(r=>+r.year===y) ? revTotal(y) : (+(D.sales||{})[y] || 0);

function revNote(r){
  const o=[];
  if(r.kind==="flea"){
    if(r.fleaType==="used") o.push(["ok","<b>売上に入れません。</b>生活に使っていた物（衣類・家具・家電など）を売った代金は非課税です。ただし1個または1組が<b>30万円を超える貴金属・宝石・書画・骨とう</b>は課税されます。","所得税法9条1項9号"]);
    else o.push(["warn","<b>売上に入ります。</b>転売目的で仕入れて売ったものは棚卸資産です。<b>仕入代金・送料・手数料は経費</b>になるので、そちらも記録してください。",""]);
  }
  if(r.kind==="note")   o.push(["info","note の売上は<b>販売した時点</b>で計上します（振り込まれた時ではありません）。<b>note の手数料・決済手数料は支払手数料</b>として経費になります。",""]);
  if(r.kind==="kindle"){
    o.push(["warn","<b>W-8BEN を提出しているか確認してください。</b>出していないと米国で30%源泉徴収されます。提出済みなら日米租税条約で<b>0%</b>です。",""]);
    o.push(["info","ロイヤリティは<b>差し引かれる前の総額</b>が売上です。源泉された分があれば、それも記録してください。外貨で入るなら<b>入金日の為替</b>で円に換算します。",""]);
  }
  if(r.kind==="jutaku") o.push(["info","相手が源泉徴収している場合、<b>源泉される前の総額</b>が売上です。差引後の入金額ではありません。",""]);
  return o;
}

/* 売上の入力フォーム */
var REV = null;
function openRev(pre){
  REV = Object.assign({id:null, year:YEAR, date:today(), kind:"jutaku", fleaType:"used", payee:"", amount:0, memo:""}, pre||{});
  drawIncome();
  const w = $("revFormWrap"); if(w){ w.style.display=""; w.scrollIntoView({behavior:"smooth", block:"nearest"}) }
}
function closeRev(){ REV = null; drawIncome() }
function drawRevForm(){
  const w = $("revFormWrap"); if(!w || !REV) return;
  w.style.display = ""; w.innerHTML = "";
  const card = el(`<div class="card pad"></div>`);
  const mk = (lab,hint,html) => el(`<div class="q"><div class="qlab">${lab}</div>${hint?`<div class="qhint">${hint}</div>`:""}${html}</div>`);

  const kseg = mk("何の売上ですか","",`<div class="seg" style="flex-wrap:wrap">${REVKIND.map(k=>`<button data-v="${k.id}" aria-pressed="${REV.kind===k.id}">${k.n}</button>`).join("")}</div>`);
  kseg.querySelectorAll("button").forEach(b=>{ b.onclick = () => { REV.kind = b.dataset.v; drawRevForm() } });
  card.appendChild(kseg);

  if(REV.kind === "flea"){
    const f = mk("売ったもの","ここで扱いが変わります。",
      `<div class="seg"><button data-v="used" aria-pressed="${REV.fleaType==="used"}">自分が使っていた物</button><button data-v="sell" aria-pressed="${REV.fleaType==="sell"}">売るために仕入れた物</button></div>`);
    f.querySelectorAll("button").forEach(b=>{ b.onclick = () => { REV.fleaType = b.dataset.v; drawRevForm() } });
    card.appendChild(f);
  }

  const d = mk("日付","",`<input type="date" value="${esc(REV.date)}">`);
  d.querySelector("input").oninput = e => { REV.date = e.target.value; REV.year = yOf(e.target.value) || YEAR };
  card.appendChild(d);

  const p2 = mk("相手先・媒体","",`<input type="text" value="${esc(REV.payee)}" placeholder="${REV.kind==="kindle"?"Amazon KDP":REV.kind==="note"?"note":"会社名・サービス名"}">`);
  p2.querySelector("input").oninput = e => REV.payee = e.target.value;
  card.appendChild(p2);

  const a = mk("金額（税込）", REV.kind==="kindle"||REV.kind==="jutaku" ? "<b>差し引かれる前の総額</b>を入れてください。" : "",
    `<div class="numrow"><input type="number" inputmode="numeric" min="0" value="${REV.amount||""}"><span class="unit">円</span></div>`);
  a.querySelector("input").oninput = e => REV.amount = +e.target.value||0;
  card.appendChild(a);

  const m = mk("摘要","",`<input type="text" value="${esc(REV.memo)}" placeholder="案件名・商品名など">`);
  m.querySelector("input").oninput = e => REV.memo = e.target.value;
  card.appendChild(m);

  revNote(REV).forEach(([lv,txt,src])=>{
    card.appendChild(el(`<div class="note${lv==="warn"?" warnbox":lv==="ok"?" okbox":""}" style="margin-top:10px">${txt}${src?`<span style="display:block;font-size:11px;color:var(--ink3);margin-top:5px;font-family:var(--mono)">出典：${esc(src)}</span>`:""}</div>`));
  });

  w.appendChild(card);
  const btns = el(`<div style="display:flex;gap:8px;margin-top:12px">
    <button class="go" style="margin:0;flex:2">保存</button><button class="ghost" style="flex:1">やめる</button></div>`);
  const bb = btns.querySelectorAll("button");
  bb[0].onclick = () => {
    if(!REV.amount){ say("金額を入れてください。"); return }
    const edit = !!REV.id;
    const row = {id: REV.id || uid(), year: yOf(REV.date) || YEAR, date:REV.date, kind:REV.kind,
      fleaType:REV.fleaType, payee:REV.payee.trim(), amount:+REV.amount||0, memo:REV.memo.trim()};
    const i = D.rev.findIndex(x=>x.id===row.id);
    if(i>=0) D.rev[i] = row; else D.rev.push(row);
    saveD(); REV = null;
    say(edit ? "上書きしました。" : "売上を記録しました。");
    drawIncome(); drawYears(); drawTax();
  };
  bb[1].onclick = closeRev;
  w.appendChild(btns);
}

/* この年の収入（売上・給与） */
function drawIncome(){
  const box = $("incomeList"); box.innerHTML = "";

  /* 前々年の売上から、消費税の設定が合っているか自動で見る */
  const base = salesOf(YEAR-2);
  const prev = salesOf(YEAR-1);
  if(S.shohi==="menzei" && base > 10000000){
    box.appendChild(el(`<div class="q"><div class="note warnbox">
      <b>免税事業者のままで大丈夫ですか。</b>基準期間（${YEAR-2}年）の売上が ${yen(base)} で1,000万円を超えています。この年は<b>課税事業者</b>になる可能性が高いです。消費税の設定を見直してください。
      <span style="display:block;font-size:11px;color:var(--ink3);margin-top:5px;font-family:var(--mono)">出典：No.6501 納税義務の免除</span></div></div>`));
  } else if(S.shohi==="menzei" && prev > 10000000){
    box.appendChild(el(`<div class="q"><div class="note">
      <b>${YEAR-1}年の売上が ${yen(prev)} です。</b>1,000万円を超えているので、<b>${YEAR+1}年から課税事業者</b>になります（基準期間＝前々年）。また前年1〜6月だけで1,000万円を超えていれば、この年から課税事業者です。</div></div>`));
  }
  /* 売上（内訳） */
  const rows = D.rev.filter(r=>+r.year===YEAR).sort((a,b)=> String(a.date||"")<String(b.date||"")?1:-1);
  const rw = el(`<div class="q"><div class="qlab">事業の売上（${YEAR}年）</div>
    <div class="qhint">税込。売り先ごとに1件ずつ入れます。合計が一覧タブの売上になります。</div></div>`);
  box.appendChild(rw);

  const ul = el(`<ul class="hist"></ul>`);
  if(!rows.length) ul.appendChild(el(`<li class="empty" style="display:block">${YEAR}年の売上はまだありません。</li>`));
  rows.forEach(r=>{
    const off = revBiz(r)===0;
    const li = el(`<li>
      <span class="hbadge" style="color:${off?"var(--ink3)":"var(--ok)"};font-size:12px">${off?"対象外":"売上"}</span>
      <span class="hbody"><span class="ht">${esc(revName(r.kind))}${r.payee?" ・ "+esc(r.payee):""}</span>
      <span class="hs">${esc(r.date||String(YEAR))}${r.memo?" ・ "+esc(r.memo.slice(0,20)):""}</span></span>
      <span class="hamt">${yen(r.amount)}</span>
      <span class="rowacts"><button data-a="edit">更新</button><button data-a="del">削除</button></span></li>`);
    li.querySelector('[data-a=edit]').onclick = () => openRev({...r});
    li.querySelector('[data-a=del]').onclick = async () => {
      if(!await ask("この売上を削除します。もとに戻せません。","削除する")) return;
      dropRow("rev", r.id); saveD(); drawIncome(); drawTax();
    };
    ul.appendChild(li);
  });
  box.appendChild(el(`<div class="q" style="padding-top:0"></div>`)).appendChild(ul);

  const tot = revTotal(YEAR), gross = rows.reduce((a,r)=>a+(+r.amount||0),0);
  if(rows.length) box.appendChild(el(`<div class="q" style="padding-top:0"><div class="kv big"><span>売上に入る金額</span><b>${yen(tot)}</b></div>${gross!==tot?`<div class="qhint" style="margin-top:4px">受取総額 ${yen(gross)} のうち、${yen(gross-tot)} は非課税のため売上に入れていません。</div>`:""}</div>`));

  const addBtn = el(`<div class="q" style="padding-top:0"><button class="go" id="addRev" style="margin:0">＋ 売上を記録する</button></div>`);
  addBtn.querySelector("button").onclick = () => openRev(null);
  box.appendChild(addBtn);
  const rfWrap = el(`<div class="q" id="revFormWrap" style="padding-top:0;display:none"></div>`);
  box.appendChild(rfWrap);
  if(REV) drawRevForm();

  const sal = salaryOf(YEAR);
  const cur = Object.assign({payment:0,withheld:0,shakai:0,afterD:0}, sal||{});
  const has = el(`<div class="q"><div class="qlab">給与所得（${YEAR}年）</div>
    <div class="qhint">${hasSalaryYear(YEAR)?"源泉徴収票の数字を入れてください。" + (kyuyoEnd() ? `給与は${kyuyoEnd().y}年${kyuyoEnd().m}月までの想定です。` : ""):"この年の給与はない想定です。"}</div>
    <div class="seg"><button data-v="y" aria-pressed="${!!sal}">ある</button><button data-v="n" aria-pressed="${!sal}">ない</button></div></div>`);
  has.querySelectorAll("button").forEach(b=>{
    b.onclick = () => {
      if(b.dataset.v==="n"){ D.salary = D.salary.filter(s=>+s.year!==YEAR); saveD(); drawIncome(); drawTax() }
      else if(!sal){ D.salary.push({id:uid(), year:YEAR, payment:0, withheld:0, shakai:0, afterD:0}); saveD(); drawIncome() }
    };
  });
  box.appendChild(has);
  if(sal){
    const row = (label,hint,key) => {
      const n = el(`<div class="q"><div class="qlab">${esc(label)}</div>${hint?`<div class="qhint">${esc(hint)}</div>`:""}
        <div class="numrow"><input type="number" inputmode="numeric" min="0" value="${cur[key]}"><span class="unit">円</span></div></div>`);
      n.querySelector("input").oninput = e => {
        const i = D.salary.findIndex(s=>+s.year===YEAR);
        if(i>=0){ D.salary[i][key] = +e.target.value||0; saveD() }
      };
      box.appendChild(n);
    };
    row("支払金額","源泉徴収票のいちばん左の金額。","payment");
    row("給与所得控除後の金額","記載があればそのまま。0のままなら速算表で自動計算します。","afterD");
    row("源泉徴収税額",null,"withheld");
    row("社会保険料等の金額","社会保険料控除に使います。","shakai");
    const c = salaryCalc(YEAR);
    box.appendChild(el(`<div class="q"><div class="kv big"><span>給与所得の金額</span><b>${yen(c.income)}</b></div>
      ${c.auto&&c.payment?`<div class="qhint" style="margin:6px 0 0">給与所得控除 ${yen(kyuyoKojo(c.payment))} を自動で引いています。</div>`:""}</div>`));
  }
}
async function drawStore(){
  let n = 0, bytes = 0;
  try{ const all = (await IDB.all()).filter(r => r && r.data && (!r.owner || r.owner === ME.email)); n = all.length; bytes = all.reduce((s,r)=>s+(r.size||0),0) }catch(e){}
  const onDrive = D.entries.filter(e => e.photoId).length, unsent = unsentShots().length;
  $("storeInfo").innerHTML =
    `<div class="kv"><span>経費の記録</span><b>${D.entries.length} 件</b></div>
     <div class="kv"><span>ドライブにある領収書の写真</span><b>${onDrive} 枚</b></div>
     <div class="kv"><span>この端末に控えている写真</span><b>${n} 枚 ・ ${(bytes/1048576).toFixed(1)} MB</b></div>
     ${unsent?`<div class="kv"><span>まだ送れていない写真</span><b>${unsent} 枚</b></div>`:""}
     ${isAdmin()?`<div class="kv"><span>仮想通貨の取引</span><b>${D.trades.length} 件</b></div>
     <div class="kv"><span>株・FXの口座</span><b>${D.stocks.length + D.fx.length} 件</b></div>`:""}
     <div class="qhint" style="margin:8px 0 0">記録と写真は会社のドライブに保存し、この端末には控えを置いています。上の帯の<b>「閉じる」</b>を押すと、送り終えてからこの端末の控えを消します。</div>`;
}

document.querySelectorAll("nav.tabs button").forEach(b=>{ b.onclick = () => switchTab(b.dataset.p) });
document.querySelectorAll("#recSeg button").forEach(b=>{ b.onclick = () => { RECTAB = b.dataset.v; drawRecTab() } });

/* ── 運行記録 ── */
$("odoStart").oninput = odoChanged;
$("odoEnd").oninput   = odoChanged;
$("addTrip").onclick  = () => openTrip(null);
$("tripCancel").onclick = () => { $("tripForm").style.display = "none"; $("addTrip").style.display = ""; TRIP = null };
$("tripSave").onclick = () => {
  if(!TRIP) return;
  if(!TRIP.dest.trim())    { say("行き先を入れてください。"); return }
  if(!TRIP.purpose.trim()) { say("目的を入れてください。按分の根拠になります。"); return }
  if(!TRIP.km)             { say("走行距離を入れてください。"); return }
  const edit = !!TRIP.id;
  const row = {id: TRIP.id || uid(), date:TRIP.date, dest:TRIP.dest.trim(), purpose:TRIP.purpose.trim(), km:+TRIP.km||0};
  const i = D.trips.findIndex(x=>x.id===row.id);
  if(i>=0) D.trips[i] = row; else D.trips.push(row);
  saveD(); TRIP = null;
  $("tripForm").style.display = "none"; $("addTrip").style.display = "";
  say(edit ? "上書きしました。" : "保存しました。");
  drawCar();
};
document.querySelectorAll("#invSeg button").forEach(b=>{ b.onclick = () => { INVTAB = b.dataset.v; drawInv() } });
document.querySelectorAll("#themeSeg button").forEach(b=>{
  b.onclick = () => { THEME.set(b.dataset.v); applyTheme() };
});

$("recSave").onclick  = saveRec;
$("recReset").onclick = () => { if(REC && REC.receiptId && REC.receiptId !== REC.origReceiptId) discardShot(REC.receiptId); REC = blankRec(); resetAns(); OCR = {busy:false, msg:"", file:""}; drawRec(); window.scrollTo({top:0,behavior:"smooth"}) };
$("addTrade").onclick   = () => openTrade(null);
$("tradeSave").onclick  = saveTrade;
$("tradeCancel").onclick= closeTrade;
$("addStock").onclick   = () => openStock(null);
$("stockSave").onclick  = saveStock;
$("stockCancel").onclick= closeStock;
$("addFx").onclick      = () => openFx(null);
$("fxSave").onclick     = saveFx;
$("fxCancel").onclick   = closeFx;
$("openRefs").onclick   = () => {
  document.querySelectorAll(".page").forEach(s=>s.classList.toggle("on", s.id==="p-refs"));
  window.scrollTo({top:0,behavior:"instant"});
};
let OPEN = null;
function openOpen(pre){
  OPEN = Object.assign({id:null, coin:"", qty:0, value:0}, pre||{});
  drawOpenForm(); $("openForm").style.display = ""; $("addOpen").style.display = "none";
  $("openForm").scrollIntoView({behavior:"smooth", block:"nearest"});
}
function drawOpenForm(){
  const f = $("openFields"); f.innerHTML = "";
  const mk = (lab,hint,html) => el(`<div class="q"><div class="qlab">${lab}</div>${hint?`<div class="qhint">${hint}</div>`:""}${html}</div>`);
  const c = mk("銘柄","","<input type=\"text\" value=\""+esc(OPEN.coin)+"\" placeholder=\"BTC\">");
  c.querySelector("input").oninput = e => OPEN.coin = e.target.value;
  const q = mk("前年から繰り越した数量","",'<input type="number" inputmode="decimal" step="any" min="0" value="'+(OPEN.qty||"")+'">');
  q.querySelector("input").oninput = e => OPEN.qty = +e.target.value||0;
  const v = mk("その取得価額","前年末までに払った金額の合計です。",'<div class="numrow"><input type="number" inputmode="numeric" min="0" value="'+(OPEN.value||"")+'"><span class="unit">円</span></div>');
  v.querySelector("input").oninput = e => OPEN.value = +e.target.value||0;
  [c,q,v].forEach(x=>f.appendChild(x));
}
$("addOpen").onclick = () => openOpen(null);
$("openCancel").onclick = () => { $("openForm").style.display = "none"; $("addOpen").style.display = ""; OPEN = null };
$("openSave").onclick = () => {
  if(!OPEN) return;
  if(!OPEN.coin.trim()){ say("銘柄を入れてください。"); return }
  if(!OPEN.qty){ say("数量を入れてください。"); return }
  const edit = !!OPEN.id;
  const row = {id: OPEN.id || uid(), coin:OPEN.coin.trim().toUpperCase(), year: OPEN.year || YEAR, qty:OPEN.qty, value:OPEN.value};
  const i = D.opens.findIndex(x=>x.id===row.id);
  if(i>=0) D.opens[i] = row; else D.opens.push(row);
  saveD(); OPEN = null;
  $("openForm").style.display = "none"; $("addOpen").style.display = "";
  say(edit ? "上書きしました。" : "保存しました。");
  drawCrypto();
};

/* ═══════════════ ログイン（Google） ═══════════════
   会社の Google Workspace のアカウントでログインする。登録された人か・役割は GAS が確かめる。
   GAS の URL は、管理者が渡す設定用リンク（?api=<URL>）で端末に覚えさせる。 */
const CONFIG = window.KEIHI_CONFIG || {};
const API_STORE = "keihi.api", TOKEN_KEY = "keihi.idt", LAST_KEY = "keihi.last";
const GAS_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const DEV = IS_LOCAL && !!CONFIG.devIdToken;             /* 手元の模擬環境だけ */
let API_URL = "", ID_TOKEN = "", TOKEN_WAITERS = [];
const store = {
  get(k){ try{ return localStorage.getItem(k) || "" }catch(e){ return "" } },
  set(k,v){ try{ v ? localStorage.setItem(k,v) : localStorage.removeItem(k) }catch(e){} },
};
const sess = {
  get(k){ try{ return sessionStorage.getItem(k) || "" }catch(e){ return "" } },
  set(k,v){ try{ v ? sessionStorage.setItem(k,v) : sessionStorage.removeItem(k) }catch(e){} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function validApiUrl(u){
  if(IS_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) return true;
  return GAS_URL_RE.test(u);
}
function loadApiUrl(){
  const fromLink = new URLSearchParams(location.search).get("api");
  if(fromLink && validApiUrl(fromLink)){
    store.set(API_STORE, fromLink);
    try{ history.replaceState(null, "", location.pathname) }catch(e){}
  }
  const saved = store.get(API_STORE);
  API_URL = validApiUrl(saved) ? saved : "";
}
function loginMsg(t){ $("loginMsg").textContent = t || "" }
function busy(t){ $("busyText").textContent = t || "処理しています…"; $("busy").hidden = false }
function idle(){ $("busy").hidden = true }

/* setup＝GASのURLがない／login＝ログイン／main＝アプリ */
function showView(v){
  $("view-setup").hidden = v !== "setup";
  $("view-login").hidden = v !== "login";
  document.body.classList.toggle("authed", v === "main");
  $("logout").hidden = v !== "main";
  $("who").hidden = v !== "main";
  if(v !== "main") $("pend").hidden = true;
  window.scrollTo(0, 0);
}

function decodeJwt(t){
  try{
    const part = t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
    return JSON.parse(decodeURIComponent(atob(part).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")));
  }catch(e){ return null }
}
function tokenValid(t){ const p = t && decodeJwt(t); return !!(p && p.exp * 1000 - Date.now() > 60 * 1000) }
function setToken(t){ ID_TOKEN = t || ""; sess.set(TOKEN_KEY, ID_TOKEN) }

function onCredential(res){
  setToken(res.credential);
  TOKEN_WAITERS.splice(0).forEach(w => w(ID_TOKEN));
  const p = decodeJwt(ID_TOKEN) || {};
  const email = String(p.email || "").toLowerCase();
  if(!ME.email || (email && email !== ME.email)) enterApp();          /* 初めて／別の人 */
  else if(!$("view-login").hidden){ showView("main"); syncNow(false); pumpPhotos() }
}
function initGoogle(){
  if(DEV) return true;
  if(!CONFIG.googleClientId){ loginMsg("アプリの設定が終わっていません（Google のクライアントIDが未設定）。管理者にお知らせください。"); return false }
  if(!(window.google && google.accounts && google.accounts.id)) return false;
  google.accounts.id.initialize({
    client_id: CONFIG.googleClientId, callback: onCredential,
    auto_select: true, itp_support: true, use_fedcm_for_prompt: true,
  });
  google.accounts.id.renderButton($("gsiButton"), {theme:"outline", size:"large", text:"signin_with", locale:"ja"});
  GOOGLE_READY = true;
  return true;
}
let GOOGLE_READY = false, PROMPTING = false;
/* 有効なトークンを返す。切れていれば自動のログインを試す（ログイン部品の読み込みを待ってから） */
function freshToken(){
  if(DEV) return Promise.resolve(CONFIG.devIdToken);
  if(tokenValid(ID_TOKEN)) return Promise.resolve(ID_TOKEN);
  return new Promise((resolve, reject) => {
    let done = false;
    TOKEN_WAITERS.push(t => { done = true; resolve(t) });
    const tryPrompt = () => {
      if(done) return;
      if(!GOOGLE_READY){ setTimeout(tryPrompt, 300); return }
      if(PROMPTING) return;
      PROMPTING = true;
      try{ google.accounts.id.prompt() }catch(e){ /* 下のタイマーでログイン画面へ */ }
      setTimeout(() => { PROMPTING = false }, 9000);
    };
    tryPrompt();
    setTimeout(() => { if(!done) reject(Object.assign(new Error("ログインの有効期限が切れました。"), {code:"AUTH"})) }, 12000);
  });
}
/* ログインが切れた・使えないアカウント。記録は端末に残したまま、画面だけ隠してログインを求める */
function authLost(message, code){
  setToken("");
  showView("login");
  loginMsg((code === "DENIED" ? "このアカウントでは使えません。\n" : "ログインし直してください。\n") + (message || ""));
}

/* ═══════════════ GAS とのやり取り ═══════════════ */
async function api(action, params){
  if(!API_URL) throw Object.assign(new Error("設定用リンクから開き直してください。"), {code:"SETUP"});
  if(!navigator.onLine) throw Object.assign(new Error("電波がありません。"), {code:"NET"});
  let idToken;
  try{ idToken = await freshToken() }
  catch(e){ authLost(e.message, "AUTH"); throw e }
  let res;
  try{
    res = await fetch(API_URL, {
      method:"POST",
      /* text/plain にすると事前確認（プリフライト）が出ず、GAS がそのまま受け取れる */
      headers:{"Content-Type":"text/plain;charset=utf-8"},
      body: JSON.stringify(Object.assign({action, idToken}, params || {})),
      redirect:"follow",
    });
  }catch(e){ throw Object.assign(new Error("GAS から応答がありません。"), {code:"NET"}) }
  let j;
  try{ j = await res.json() }
  catch(e){ throw Object.assign(new Error("GAS の応答を読めませんでした（HTTP " + res.status + "）。"), {code:"NET"}) }
  if(!j.ok && (j.code === "AUTH" || j.code === "DENIED")) authLost(j.message, j.code);
  return j;
}
function driveErr(e){
  const c = e && e.code;
  if(c === "AUTH")   return "ログインが切れました。ログインし直してください。";
  if(c === "DENIED") return "このアカウントでは使えません。" + ((e && e.message) || "");
  if(c === "NET")    return "GAS から応答がありません。電波を確かめてください。記録はこの端末に残っていて、つながったときに送ります。";
  if(c === "SETUP")  return "GAS の URL が設定されていません。設定用リンクから開き直してください。";
  return "ドライブとやり取りできませんでした。" + ((e && e.message) || "");
}

/* ═══════════════ ドライブと合わせる ═══════════════
   記録を変えると少し待ってから GAS へ送る（save）。GAS がドライブの最新と合わせて保存し、合わせた結果を返す。
   開いたとき・アプリに戻ってきたとき・つながったときにも読み込む（load）。送れなかった分は「未送信」として残す。 */
let DIRTY = false, SYNC_BUSY = false, SYNC_TIMER = null, ONLINE_OK = null, DRIVE_ERR = "", MINE_LOOP = 0;
function markDirty(){
  DIRTY = true; LS.set("dirty", true); drawPend();
  if(SYNC_TIMER) clearTimeout(SYNC_TIMER);
  SYNC_TIMER = setTimeout(() => { SYNC_TIMER = null; syncNow(false) }, 2500);
}
async function syncNow(fromUser){
  if(!ME.email || !API_URL) return false;
  if(SYNC_BUSY){ if(fromUser) say("やり取りの途中です。少し待ってから押してください。"); return false }
  SYNC_BUSY = true;
  if(SYNC_TIMER){ clearTimeout(SYNC_TIMER); SYNC_TIMER = null }
  if(fromUser) driveMsg("ドライブとやり取りしています…");
  stamp();
  const sending = DIRTY, owner = ME.email;
  DIRTY = false;
  try{
    const r = sending
      ? await api("save", {expect: owner, ledger:{v:1, settings:S, data:D}})
      : await api("load");
    if(!r.ok) throw r;
    if(ME.email !== owner) return false;                    /* 待っている間に人が替わった */
    if(r.email && r.email !== ME.email){ enterApp(); return false }
    if(r.role && r.role !== ME.role){ ME.role = r.role; rememberMe(); applyRole() }
    const res = applyServer(r.ledger);
    MINE_LOOP = res.mine ? MINE_LOOP + 1 : 0;
    if(res.mine && MINE_LOOP <= 3) DIRTY = true;
    if(sending) LS.set("driveAt", new Date().toISOString());
    LS.set("dirty", DIRTY);
    ONLINE_OK = true; DRIVE_ERR = "";
    if(res.changed) redrawData();
    if(fromUser) say(sending ? "ドライブに保存しました。" : "ドライブから読み込みました。");
    return true;
  }catch(e){
    if(ME.email === owner){ DIRTY = DIRTY || sending; LS.set("dirty", DIRTY) }
    ONLINE_OK = false; DRIVE_ERR = driveErr(e);
    if(fromUser) say(sending ? "保存できませんでした。" : "読み込めませんでした。");
    return false;
  }finally{
    SYNC_BUSY = false; drawPend(); drawDriveMsg();
    if(DIRTY && ONLINE_OK && !SYNC_TIMER) SYNC_TIMER = setTimeout(() => { SYNC_TIMER = null; syncNow(false) }, 1500);
  }
}
/* ドライブから届いた内容で画面を描き直す（入力中のフォームは描き直さない） */
function redrawData(){
  drawMeta(); drawYears(); refreshGate();
  if($("p-rec").classList.contains("on")){
    if(!S.setupDone) drawRecTab();
    else if(RECTAB==="keihi") drawLedger();
    else if(RECTAB==="car") drawCar();
    else drawInv();
  }
  if($("p-tax").classList.contains("on")) drawTax();
  if($("p-set").classList.contains("on")){ drawSettings(); drawIncome(); drawStore() }
}
function driveMsg(t){ const n = $("driveMsg"); if(n) n.textContent = t }
function fmtAt(at){
  const d = new Date(at || ""), p = x => String(x).padStart(2,"0");
  return isNaN(d.getTime()) ? "—" : `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function drawDriveMsg(){
  if(!ME.email) return;
  const at = LS.get("driveAt", null);
  let t = `ログイン中：${ME.name && ME.name !== ME.email ? ME.name + "（" + ME.email + "）" : ME.email}${isAdmin() ? "・管理者" : ""}。`;
  if(ONLINE_OK === false) t += DRIVE_ERR;
  else if(!at) t += "この端末からはまだ保存していません。";
  else t += `この端末から最後にドライブへ保存したのは ${fmtAt(at)} です。`;
  if(DIRTY) t += "まだ送っていない変更があります。";
  driveMsg(t);
}
function drawPend(){
  const p = $("pend"); if(!p || !ME.email || !document.body.classList.contains("authed")) return;
  const shots = unsentShots().length, trash = LS.get("trashQ", []).length;
  p.hidden = !(DIRTY || shots || trash);
  p.textContent = shots ? `未送信 ${shots}枚` : "未送信";
}

$("driveSaveBtn").onclick = () => { DIRTY = true; syncNow(true) };
$("driveLoadBtn").onclick = () => syncNow(true);

/* ── 年間取引報告書（管理者の投資タブ） ── */
const fileB64 = f => new Promise((res,rej)=>{
  const fr = new FileReader();
  fr.onload  = () => res(String(fr.result).split(",")[1] || "");
  fr.onerror = () => rej({code:"upstream_error", message:"ファイルを読めませんでした。"});
  fr.readAsDataURL(f);
});
async function drawRepList(){
  const box = $("repList"); if(!box || !isAdmin()) return;
  const r = await api("listReports").catch(e => e);
  box.innerHTML = r && r.ok
    ? (r.names.length ? "ドライブにあるもの：" + r.names.map(esc).join("、") : "まだ1件も入っていません。")
    : esc(driveErr(r));
}
async function repUpload(files){
  const hold = $("repHold");
  if(!files || !files.length) return;
  try{
    let n = 0;
    for(const f of files){
      hold.textContent = `${f.name} を送っています…`;
      const r = await api("uploadReport", {name:f.name, mimeType:f.type || "application/octet-stream", data: await fileB64(f)});
      if(!r.ok) throw r;
      n++;
    }
    hold.textContent = "";
    say(`${n}件をドライブに保存しました。`);
    drawRepList();
  }catch(e){ hold.textContent = ""; say("保存できませんでした。"); $("repList").textContent = driveErr(e) }
}
$("repFile").onchange = e => { const f = e.target.files; repUpload(f); e.target.value = "" };

/* ── バックアップ ── */
$("saveBackup").onclick = async b => {
  let shots = [];
  try{ shots = (await IDB.all()).filter(r => r && r.data && (!r.owner || r.owner === ME.email)).map(({owner, ...r}) => r) }catch(e){}
  saveFile(fname(YEAR, "バックアップ_"+today(), "json"),
    JSON.stringify({v:2, at:new Date().toISOString(), settings:S, data:D, receipts:shots}, null, 1), b.target);
};
$("loadBackup").onclick = () => $("backupFile").click();
$("backupFile").onchange = async e => {
  const f = e.target.files && e.target.files[0]; if(!f) return;
  try{
    const j = JSON.parse(await f.text());
    if(!j || !j.data) throw new Error("形式が違います");
    if(!await ask("取り込むと、いまの台帳に追加されます。同じ記録が二重に入ることはありません。写真はドライブに送ります。","取り込む")) return;
    ROWK.forEach(k=>{
      (j.data[k]||[]).forEach(r=>{ if(r && r.id && !D[k].some(x=>x.id===r.id)) D[k].push(r) });
    });
    MAPK.forEach(k=>{ Object.assign(D[k], j.data[k]||{}) });
    if(!isAdmin()) Ledger.stripAdminOnly(D);
    for(const r of (j.receipts||[])){ try{ if(r && r.id && r.data) await putShot(Object.assign({}, r)) }catch(err){} }
    saveD(); drawYears(); drawStore(); drawPend();
    pumpPhotos();
    say("取り込みました。");
  }catch(err){ say("取り込めませんでした。" + (err.message||"")); }
  e.target.value = "";
};

/* 基本項目の登録完了 */
const doneWrap = el(`<div style="margin-top:14px"></div>`);
const doneBtn  = el(`<button class="go" id="setupDone" style="margin:0">この内容で登録して、経費の記録をはじめる</button>`);
doneBtn.onclick = () => { S.setupDone = true; saveS(); refreshGate(); switchTab("rec") };
doneWrap.appendChild(doneBtn);
doneWrap.appendChild(el(`<p class="lede" style="margin:8px 0 0">あとから何度でも変えられます。変えると、それまでの記録も新しい前提で判定し直されます。</p>`));
$("setupDoneSlot").appendChild(doneWrap);
function refreshGate(){
  doneWrap.style.display = S.setupDone ? "none" : "";
  const rec = $("p-rec");
  if(rec && rec.classList.contains("on")) drawRecTab();
}

/* ═══════════════ 全体（管理者） ═══════════════
   年を選ぶと、人ごとの一覧・勘定科目×人の表・全員分のCSVを出す。ほかの人の記録は見るだけ。 */
let PEEK = null;                 /* 記録を見ている人のメールアドレス */
const sumBiz = es => es.reduce((s,e)=>s+(e.biz||0), 0);
const lastOf = es => es.reduce((m,e)=> String(e.date||"") > m ? String(e.date) : m, "");
function everyone(year){
  const mine = D.entries.filter(e=>yOf(e.date)===year);
  return [{email:ME.email, name:ME.name||ME.email, role:ME.role, stopped:false, entries:mine, lastDate:lastOf(D.entries), me:true}]
    .concat(OTHERS[year] || []);
}
async function drawAll(force){
  const box = $("allBody"); if(!box || !isAdmin()) return;
  if(PEEK){ drawPeek(); return }
  const y = YEAR;
  box.innerHTML = `<div class="note">読み込んでいます…</div>`;
  const others = await loadOthers(y, force !== false);
  if(y !== YEAR || !$("p-all").classList.contains("on") || PEEK) return;
  box.innerHTML = "";
  if(!others) box.appendChild(el(`<div class="note warnbox" style="margin-bottom:12px"><b>ほかの人の記録を読み込めませんでした。</b>${esc(OTHERS_ERR)}</div>`));
  const ps = everyone(y);
  const nm = p => esc(p.name) + (p.me ? "（自分）" : "") + (p.stopped ? `<span class="rn" style="display:block;font-weight:400;font-size:10.5px;color:var(--ink3)">止めています</span>` : "");

  /* 1 人ごとの一覧 */
  box.appendChild(el(`<h2 class="sec" style="margin-top:0">人ごとの一覧（${y}年）</h2>`));
  const t1 = el(`<div class="card scroller"><table class="jr">
    <tr><th style="width:auto">人</th><th class="num">件数</th><th class="num">計上額</th><th class="num">× ／ △</th><th class="num">写真なし</th><th class="num">最後の記録</th></tr>
    ${ps.map((p,i)=>{ const es = p.entries||[];
      return `<tr data-i="${i}"${p.me?"":` class="rowlink"`}><th style="width:auto;font-weight:600;white-space:nowrap">${nm(p)}</th><td class="num">${es.length}</td><td class="num">${yen(sumBiz(es))}</td>
        <td class="num">${es.filter(e=>e.verdict==="ng").length} ／ ${es.filter(e=>e.verdict==="warn").length}</td>
        <td class="num">${es.filter(e=>!e.receiptId && !e.photoId).length}</td><td class="num">${esc(p.lastDate||"—")}</td></tr>` }).join("")}
    <tr><th style="width:auto;font-weight:700">合計</th><td class="num" style="font-weight:700">${ps.reduce((s,p)=>s+(p.entries||[]).length,0)}</td>
      <td class="num" style="font-weight:700">${yen(ps.reduce((s,p)=>s+sumBiz(p.entries||[]),0))}</td><td></td><td></td><td></td></tr>
  </table></div>`);
  t1.querySelectorAll("tr.rowlink").forEach(tr => { tr.onclick = () => { PEEK = ps[+tr.dataset.i].email; drawPeek() } });
  box.appendChild(t1);
  box.appendChild(el(`<p class="lede" style="margin:8px 0 0">人の名前を押すと、その人の記録を見られます（見るだけ。直せるのは本人だけです）。</p>`));

  /* 2 勘定科目 × 人 */
  const mx = kamokuMatrix(y);
  box.appendChild(el(`<h2 class="sec">勘定科目 × 人</h2>`));
  box.appendChild(el(`<div class="card scroller"><table class="jr">
    <tr><th style="width:auto">科目</th>${ps.map(p=>`<th class="num">${esc(p.name)}</th>`).join("")}<th class="num">合計</th></tr>
    ${mx.rows.length ? mx.rows.map(r=>`<tr><th style="width:auto;font-weight:600">${esc(r.kamoku)}</th>${r.byPerson.map(v=>`<td class="num">${v?yen(v):"—"}</td>`).join("")}<td class="num" style="font-weight:700">${yen(r.total)}</td></tr>`).join("")
      : `<tr><td colspan="${ps.length+2}" style="text-align:center;color:var(--ink3)">この年の経費はまだありません</td></tr>`}
    <tr><th style="width:auto;font-weight:700">経費計</th>${mx.colTotals.map(v=>`<td class="num" style="font-weight:700">${yen(v)}</td>`).join("")}<td class="num" style="font-weight:700">${yen(mx.total)}</td></tr>
  </table></div>`));

  /* 3 CSV */
  box.appendChild(el(`<h2 class="sec">CSVで保存</h2>`));
  const btns = el(`<div style="display:flex;gap:8px;flex-wrap:wrap"></div>`);
  const mk = (label, fn) => { const b = el(`<button class="ghost">${label}</button>`); b.onclick = () => fn(b); btns.appendChild(b); };
  mk("全員分の経費の明細", b => saveFile(fname(y,"経費明細_全員"), csvLedger(y, true), b));
  mk("勘定科目×人",       b => saveFile(fname(y,"科目別_人別"),  csvMatrix(y), b));
  box.appendChild(btns);

  drawUsers();
}
function kamokuMatrix(y){
  const ps = everyone(y);
  const rows = KAMOKU.map(k => {
    const byPerson = ps.map(p => sumBiz((p.entries||[]).filter(e => e.kamoku === k)));
    return {kamoku:k, byPerson, total: byPerson.reduce((s,v)=>s+v,0)};
  }).filter(r => r.byPerson.some(v => v));
  const colTotals = ps.map((p,i) => rows.reduce((s,r)=>s+r.byPerson[i],0));
  return {people:ps, rows, colTotals, total: colTotals.reduce((s,v)=>s+v,0)};
}
const csvMatrix = y => {
  const mx = kamokuMatrix(y);
  return [["科目", ...mx.people.map(p=>p.name), "合計"].map(q).join(","),
    ...mx.rows.map(r => [q(r.kamoku), ...r.byPerson, r.total].join(",")),
    [q("経費計"), ...mx.colTotals, mx.total].join(",")].join("\r\n");
};
async function drawPeek(){
  const box = $("allBody"); if(!box) return;
  const email = PEEK, y = YEAR;
  box.innerHTML = `<div class="note">読み込んでいます…</div>`;
  const r = await api("peek", {email}).catch(e => e);
  if(PEEK !== email || !$("p-all").classList.contains("on")) return;
  box.innerHTML = "";
  const back = el(`<button class="ghost" style="margin-bottom:12px">← 全体に戻る</button>`);
  back.onclick = () => { PEEK = null; drawAll(false) };
  box.appendChild(back);
  if(!r || !r.ok){ box.appendChild(el(`<div class="note warnbox">${esc(driveErr(r))}</div>`)); return }
  const s = r.ledger.settings || {}, d = r.ledger.data || {};
  const es = (d.entries||[]).filter(e=>yOf(e.date)===y).sort((a,b)=> a.date<b.date?1:-1);
  const trips = (d.trips||[]).filter(t=>yOf(t.date)===y);
  box.appendChild(el(`<div class="card pad">
    <div class="eyebrow">${r.person.role==="admin"?"管理者":"利用者"}${r.person.stopped?"・止めています":""}</div>
    <div style="font-family:var(--mincho);font-size:18px;font-weight:600;margin:2px 0 4px">${esc(r.person.name)}</div>
    <div class="qhint">${esc(r.person.email)}</div>
    <div class="kv" style="margin-top:8px"><span>基本項目</span><b>${s.entity==="hojin"?"法人":"個人"} / ${s.aoiro==="aoiro"?"青色":"白色"} / ${esc(({menzei:"免税",honsoku:"本則",kani:"簡易",niwari:"2割"})[s.shohi]||"未登録")} / 給与の支払 ${s.kyuyo==="ari"?"あり":"なし"}</b></div>
    <div class="kv"><span>${y}年の経費</span><b>${es.length}件 ・ ${yen(sumBiz(es))}</b></div>
    <div class="kv"><span>${y}年の運行記録</span><b>${trips.length}件 ・ ${km(trips.reduce((a,t)=>a+(+t.km||0),0))}</b></div>
    <div class="qhint" style="margin-top:8px">見るだけです。直せるのは本人だけです。最後に保存されたのは ${esc(fmtAt(r.ledger.at))}。</div>
  </div>`));
  const ul = el(`<ul class="hist"></ul>`);
  if(!es.length) ul.appendChild(el(`<li class="empty" style="display:block">${y}年の記録はありません。</li>`));
  const M = {ok:["○","var(--ok)"],warn:["△","var(--warn)"],ng:["×","var(--ng)"]};
  es.forEach(e => {
    const [mk2,c] = M[e.verdict] || ["・","var(--ink3)"];
    const li = el(`<li>
      <span class="hbadge" style="color:${c}">${mk2}</span>
      <span class="hbody"><span class="ht">${esc(e.kamoku)}${e.payee?" ・ "+esc(e.payee):""}</span>
      <span class="hs">${esc(e.date)}${e.ratio<100?" ・ "+e.ratio+"%":""}${e.memo?" ・ "+esc(String(e.memo).slice(0,18)):""}</span></span>
      <span class="hamt">${yen(e.biz||0)}</span></li>`);
    if(e.photoId){ const sp = el(`<span></span>`); li.insertBefore(sp, li.querySelector(".hamt")); showEntryPhoto(sp, e, true, true) }
    ul.appendChild(li);
  });
  box.appendChild(el(`<div class="card" style="margin-top:12px"></div>`)).appendChild(ul);
}

/* ── 利用者（管理者が追加・止める。管理者は GAS の設定でだけ決まる） ── */
async function drawUsers(){
  const box = $("userBody"); if(!box || !isAdmin()) return;
  box.innerHTML = `<div class="note">読み込んでいます…</div>`;
  renderUsers(await api("listUsers").catch(e => e));
}
function renderUsers(r){
  const box = $("userBody"); box.innerHTML = "";
  if(!r || !r.ok){ box.appendChild(el(`<div class="note warnbox">${esc(driveErr(r))}</div>`)); return }
  const ul = el(`<ul class="hist"></ul>`);
  (r.people||[]).forEach(p => {
    const li = el(`<li>
      <span class="hbody"><span class="ht">${esc(p.name)}${p.email===ME.email?"（自分）":""}</span>
      <span class="hs">${esc(p.email)} ・ ${p.role==="admin"?"管理者":p.stopped?"止めています":"利用者"}</span></span>
      ${p.role==="admin"?"":`<span class="rowacts"><button data-a="tog">${p.stopped?"戻す":"止める"}</button></span>`}</li>`);
    const b = li.querySelector('[data-a=tog]');
    if(b) b.onclick = async () => {
      const stop = !p.stopped;
      if(stop && !await ask(`${p.name}（${p.email}）を止めます。ログインできなくなりますが、記録は消えず、全体の集計にも残ります。`,"止める")) return;
      busy(stop ? "止めています…" : "戻しています…");
      const res = await api("stopUser", {email:p.email, stop}).catch(e => e);
      idle(); renderUsers(res); OTHERS[YEAR] = null;
    };
    ul.appendChild(li);
  });
  box.appendChild(el(`<div class="card"></div>`)).appendChild(ul);
  box.appendChild(el(`<p class="lede" style="margin:8px 0 0">管理者は GAS の設定（ADMIN_EMAILS）で決まり、この画面からは増やせません。</p>`));

  const dom = (r.domains||[])[0] || "";
  const form = el(`<div class="card pad" style="margin-top:12px">
    <div class="eyebrow">利用者を追加する</div>
    <div class="q"><div class="qlab">会社のメールアドレス</div><input type="email" placeholder="name@${esc(dom)}" autocomplete="off"></div>
    <div class="q"><div class="qlab">表示名</div><input type="text" placeholder="山田 太郎"></div>
    <button class="go" style="margin-top:6px">追加する</button>
    <p class="lede" style="margin:10px 0 0">追加した人には、下の「設定用リンク」を渡してください。リンクを開いて、会社の Google アカウントでログインすると使えます。</p>
    <button class="ghost" style="margin-top:6px">設定用リンクをコピー</button>
  </div>`);
  const [mail, name] = form.querySelectorAll("input");
  const [add, copy] = form.querySelectorAll("button");
  add.onclick = async () => {
    const email = mail.value.trim();
    if(!email){ say("メールアドレスを入れてください。"); return }
    busy("追加しています…");
    const res = await api("addUser", {email, name:name.value.trim()}).catch(e => e);
    idle();
    if(!res || !res.ok){ say((res && res.message) || "追加できませんでした。"); return }
    say("追加しました。"); renderUsers(res); OTHERS[YEAR] = null;
  };
  copy.onclick = async () => {
    const link = location.origin + location.pathname + "?api=" + encodeURIComponent(API_URL);
    try{ await navigator.clipboard.writeText(link); say("設定用リンクをコピーしました。") }
    catch(e){ say(link) }
  };
  box.appendChild(form);
}

/* ═══════════════ 起動・人の切り替え・閉じる ═══════════════ */
function rememberMe(){ store.set(LAST_KEY, JSON.stringify(ME)) }
/* その人の控え（台帳・写真）で画面を開く */
function openUser(who){
  ME = {email:String(who.email||"").toLowerCase(), name:who.name||"", role:who.role||"user"};
  resetState(LS.get("settings", {}), LS.get("data", {}));
  DIRTY = !!LS.get("dirty", false);
  ONLINE_OK = null; DRIVE_ERR = ""; PEEK = null;
  Object.keys(OTHERS).forEach(k => delete OTHERS[k]);
  REC = null; OCR = {busy:false, msg:"", file:""};
  $("who").textContent = ME.name || ME.email;
  showView("main");
  applyRole(); applyTheme(); drawMeta(); drawYears(); refreshGate();
  switchTab(S.setupDone ? "rec" : "set");
  refreshShots().then(() => { drawPend(); if($("p-rec").classList.contains("on") && S.setupDone && RECTAB==="keihi") drawLedger() });
}
async function enterApp(){
  const p = decodeJwt(ID_TOKEN) || {};
  let last = null; try{ last = JSON.parse(store.get(LAST_KEY) || "null") }catch(e){}
  const email = String(p.email || "").toLowerCase();
  if(last && last.email && (!email || last.email === email) && ME.email !== last.email) openUser(last);   /* 控えがあれば先に出す */
  if(!ME.email) busy("読み込んでいます…");
  let r;
  try{ r = await api("load") }catch(e){ r = {ok:false, code:e.code || "NET", message:e.message} }
  idle();
  if(!r.ok){
    if(r.code === "AUTH" || r.code === "DENIED") return;
    if(ME.email){ ONLINE_OK = false; DRIVE_ERR = driveErr(r); drawDriveMsg(); drawPend(); return }
    showView("login"); loginMsg(driveErr(r)); return;
  }
  const who = {email:r.email, name:r.name, role:r.role};
  const fresh = ME.email !== who.email;
  if(fresh) openUser(who);
  else { ME.name = who.name; ME.role = who.role; $("who").textContent = ME.name || ME.email; applyRole() }
  rememberMe();
  showView("main");
  const res = applyServer(r.ledger);
  ONLINE_OK = true; DRIVE_ERR = "";
  if(res.mine) markDirty();
  if(fresh) switchTab(S.setupDone ? "rec" : "set");
  else if(res.changed) redrawData();
  if($("p-set").classList.contains("on")) drawSettings();
  drawDriveMsg(); drawPend();
  pumpPhotos();
}

/* 「閉じる」＝ログアウト。ホーム画面のアプリは自分では閉じられないため。
   まだ送れていない記録・写真を送ってから、この端末の控え（台帳と写真）を消す。送れなければ消さない */
async function logout(){
  if(!await ask("閉じます（ログアウト）。まだ送っていない記録と写真を送ってから、この端末の控え（台帳と写真）を消します。次に開いたときはログインからです。","閉じる")) return;
  busy("ドライブへ送っています…");
  while(SYNC_BUSY || PUMP_BUSY) await sleep(300);
  if(DIRTY || SYNC_TIMER) await syncNow(false);
  await pumpPhotos();
  const left = (DIRTY ? 1 : 0) + unsentShots().length + LS.get("trashQ", []).length;
  idle();
  if(left){
    say("未送信があります。電波のよい場所で、もう一度「閉じる」を押してください。端末の控えは消していません。");
    drawPend(); return;
  }
  ["data","settings","dirty","driveAt","trashQ"].forEach(k => LS.del(k));
  try{ for(const r of await IDB.all()){ if(r && (!r.owner || r.owner === ME.email)) await IDB.del(r.id) } }catch(e){}
  store.set(LAST_KEY, "");
  setToken("");
  try{ google.accounts.id.disableAutoSelect() }catch(e){}
  ME = {email:"", name:"", role:""};
  resetState({}, {});
  SHOTS = new Set(); DIRTY = false; REC = null; PEEK = null;
  Object.keys(OTHERS).forEach(k => delete OTHERS[k]);
  showView("login");
  loginMsg("閉じました。アプリを閉じるときは、スマホの操作で閉じてください。");
}
$("logout").onclick = logout;

$("setupSave").onclick = () => {
  const u = $("setupUrl").value.trim();
  if(!validApiUrl(u)){ $("setupMsg").textContent = "設定コードの形が違います。https://script.google.com/macros/s/…/exec の形のURLを貼り付けてください。"; return }
  store.set(API_STORE, u); API_URL = u;
  boot();
};

/* つながったとき・アプリに戻ってきたときに、ドライブの最新を読み込み、送れていない分を送る */
window.addEventListener("online", () => { if(ME.email){ syncNow(false); pumpPhotos() } });
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible" && ME.email && document.body.classList.contains("authed")){ syncNow(false); pumpPhotos() }
});

function boot(){
  applyTheme(); drawRefs();
  loadApiUrl();
  if(!API_URL){ showView("setup"); return }
  setToken(sess.get(TOKEN_KEY));
  let last = null; try{ last = JSON.parse(store.get(LAST_KEY) || "null") }catch(e){}
  if(DEV || tokenValid(ID_TOKEN) || (last && last.email)) enterApp();     /* 控えがあれば電波がなくても開く */
  else showView("login");
  let tries = 0;
  (function waitGoogle(){
    if(initGoogle()) return;
    if(!CONFIG.googleClientId) return;
    if(++tries > 50){ loginMsg("Google のログイン部品を読み込めませんでした。電波を確かめて、アプリを開き直してください。"); return }
    setTimeout(waitGoogle, 200);
  })();
}

if("serviceWorker" in navigator && !IS_LOCAL){
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(()=>{}) });
}
boot();
