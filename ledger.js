/**
 * ledger.gs（＝ web/ledger.js と同じ中身。片方を直したらもう片方も同じにする。test/check.js が突き合わせる）
 * 台帳（{settings, data}）の合わせ方。GAS（保存のとき）と画面（読み込んだとき）が同じ決まりで合わせる。
 *
 * - 行（経費・運行・仮想通貨・株・FX・給与・売上）は id で突き合わせ、t（最後に直した時刻・ミリ秒）が新しいほうを採る
 * - 時刻が同じ（どちらも時刻を持たない移行前の行を含む）ときは base（保存してあるほう）を採る
 * - 消した行は墓標（tomb＝消した行の id の一覧）で伝え、戻さない
 * - 年ごとの値（売上の旧入力・株とFXの繰越損失・メーター）は mt["<種類>:<年>"] の時刻で同じように採る
 * - 基本項目は settings.t の時刻で、新しいほうを丸ごと採る
 * - 形をそろえるとき（norm）に、id・項目名・数値・文字の長さを確かめ、合わないものは落とす／直す
 *   （細工した台帳で画面を壊したり、画面に HTML を差し込んだりできないようにする）
 */

var Ledger = (function () {
  var ROWK = ['entries', 'trades', 'opens', 'stocks', 'fx', 'salary', 'trips', 'rev'];
  var MAPK = ['sales', 'stockCarry', 'fxCarry', 'odo'];
  /* 管理者だけが使う記録（利用者の台帳には持たせない） */
  var ADMIN_ONLY_ROWS = ['trades', 'opens', 'stocks', 'fx', 'salary', 'rev'];
  var ADMIN_ONLY_MAPS = ['sales', 'stockCarry', 'fxCarry'];
  var ADMIN_ONLY_SETTINGS = ['kyuyoEnd'];

  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;          /* __proto__ などは通さない */
  var YEAR_RE = /^\d{4}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MAX_ROWS = 20000, MAX_FIELDS = 40, MAX_STR = 500;
  /* 数値でなければならない項目 */
  var NUM = { amount: 1, biz: 1, ratio: 1, km: 1, qty: 1, value: 1, payment: 1, withheld: 1, shakai: 1, afterD: 1,
              income: 1, cost: 1, wI: 1, wR: 1, div: 1, profit: 1, fee: 1, year: 1, t: 1 };
  /* 文字でなければならない項目（null を許すのは写真の2つだけ） */
  var STR = { date: 1, kamoku: 1, payee: 1, memo: 1, catName: 1, verdict: 1, dest: 1, purpose: 1, coin: 1, kind: 1,
              venue: 1, broker: 1, type: 1, fleaType: 1, receiptId: 1, photoId: 1 };
  var NULLABLE = { receiptId: 1, photoId: 1 };
  var VERDICTS = ['ok', 'warn', 'ng', ''];

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  /* id として使える形か（constructor・__proto__ など、入れ物の決まった名前とぶつかるものは使わない） */
  function okId(x) { return typeof x === 'string' && ID_RE.test(x) && !(x in Object.prototype); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function blank() {
    var d = {};
    ROWK.forEach(function (k) { d[k] = []; });
    MAPK.forEach(function (k) { d[k] = {}; });
    d.tomb = [];
    d.mt = {};
    return d;
  }

  /* 値をそろえる。数・文字（長さを制限）・真偽・null と、1段だけの入れ物（判定の答え ans など）を通す */
  function cleanVal(v, deep) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'string') return v.slice(0, MAX_STR);
    if (typeof v === 'boolean' || v === null) return v;
    if (deep && isObj(v)) {
      var o = {};
      Object.keys(v).slice(0, MAX_FIELDS).forEach(function (k) {
        if (!KEY_RE.test(k)) return;
        var x = cleanVal(v[k], false);
        if (x !== undefined) o[k] = x;
      });
      return o;
    }
    return undefined;
  }

  function cleanRow(r) {
    var o = {};
    Object.keys(r).slice(0, MAX_FIELDS).forEach(function (k) {
      if (!KEY_RE.test(k)) return;
      var v = cleanVal(r[k], true);
      if (v === undefined) return;
      if (NUM[k]) v = num(v);
      else if (STR[k]) v = (v === null && NULLABLE[k]) ? null : (typeof v === 'object' ? '' : String(v).slice(0, MAX_STR));
      o[k] = v;
    });
    o.id = String(r.id);
    if ('verdict' in o && VERDICTS.indexOf(o.verdict) < 0) o.verdict = '';
    if ('date' in o && !(typeof o.date === 'string' && DATE_RE.test(o.date))) o.date = '';
    return o;
  }

  function cleanMap(k, src) {
    var out = {};
    if (!isObj(src)) return out;
    Object.keys(src).forEach(function (y) {
      if (!YEAR_RE.test(y)) return;
      var v = src[y];
      if (k === 'odo') {
        if (isObj(v)) out[y] = { start: num(v.start), end: num(v.end) };
      } else {
        out[y] = num(v);
      }
    });
    return out;
  }

  /** 形をそろえる（足りない入れ物を作り、id のない行・壊れた値を落とす） */
  function norm(src) {
    var s = isObj(src) ? src : {};
    var d = blank();
    ROWK.forEach(function (k) {
      d[k] = (Array.isArray(s[k]) ? s[k] : []).slice(0, MAX_ROWS)
        .filter(function (r) { return isObj(r) && okId(r.id); })
        .map(cleanRow);
    });
    MAPK.forEach(function (k) { d[k] = cleanMap(k, s[k]); });
    d.tomb = (Array.isArray(s.tomb) ? s.tomb : []).filter(okId);
    if (isObj(s.mt)) {
      Object.keys(s.mt).forEach(function (key) {
        var p = key.split(':');
        if (p.length === 2 && MAPK.indexOf(p[0]) >= 0 && YEAR_RE.test(p[1])) d.mt[key] = num(s.mt[key]);
      });
    }
    return d;
  }

  /**
   * @param {Object} base 保存してあるほう（時刻が同じならこちら）
   * @param {Object} inc  新しく来たほう
   * @returns {Object} 合わせた data（base・inc は書き換えない）
   */
  function merge(base, inc) {
    var a = norm(base), b = norm(inc), out = blank();
    var tomb = Object.create(null);
    a.tomb.concat(b.tomb).forEach(function (id) { tomb[id] = true; });
    out.tomb = Object.keys(tomb);

    ROWK.forEach(function (k) {
      var pos = Object.create(null), rows = [];
      a[k].forEach(function (r) { if (!(r.id in pos)) { pos[r.id] = rows.length; rows.push(r); } });
      b[k].forEach(function (r) {
        if (!(r.id in pos)) { pos[r.id] = rows.length; rows.push(r); return; }
        var cur = rows[pos[r.id]];
        if ((+r.t || 0) > (+cur.t || 0)) rows[pos[r.id]] = r;
      });
      out[k] = rows.filter(function (r) { return !tomb[r.id]; });
    });

    MAPK.forEach(function (k) {
      var m = {};
      Object.keys(a[k]).forEach(function (y) { m[y] = a[k][y]; });
      Object.keys(b[k]).forEach(function (y) {
        var key = k + ':' + y;
        var ta = +a.mt[key] || 0, tb = +b.mt[key] || 0;
        if (!(y in a[k]) || tb > ta) m[y] = b[k][y];
      });
      out[k] = m;
    });

    var mt = {};
    [a.mt, b.mt].forEach(function (src) {
      Object.keys(src).forEach(function (key) { mt[key] = Math.max(+mt[key] || 0, +src[key] || 0); });
    });
    out.mt = mt;
    return out;
  }

  /** 基本項目をそろえる（項目名と値の形だけ確かめる） */
  function cleanSettings(s) {
    var o = {};
    if (!isObj(s)) return o;
    Object.keys(s).slice(0, MAX_FIELDS).forEach(function (k) {
      if (!KEY_RE.test(k)) return;
      var v = cleanVal(s[k], false);
      if (v !== undefined) o[k] = k === 't' ? num(v) : v;
    });
    return o;
  }

  function mergeSettings(base, inc) {
    var a = isObj(base) ? cleanSettings(base) : null, b = isObj(inc) ? cleanSettings(inc) : null;
    if (!a) return b || {};
    if (!b) return a;
    return (+b.t || 0) > (+a.t || 0) ? b : a;
  }

  /** 利用者の台帳から、管理者だけの記録を外す */
  function stripAdminOnly(data, settings) {
    if (data) {
      ADMIN_ONLY_ROWS.forEach(function (k) { data[k] = []; });
      ADMIN_ONLY_MAPS.forEach(function (k) { data[k] = {}; });
      Object.keys(data.mt || {}).forEach(function (key) {
        if (ADMIN_ONLY_MAPS.indexOf(key.split(':')[0]) >= 0) delete data.mt[key];
      });
    }
    if (settings) ADMIN_ONLY_SETTINGS.forEach(function (k) { delete settings[k]; });
  }

  return {
    ROWK: ROWK, MAPK: MAPK, ID_RE: ID_RE,
    blank: blank, norm: norm, merge: merge, mergeSettings: mergeSettings, cleanSettings: cleanSettings, stripAdminOnly: stripAdminOnly,
  };
})();
