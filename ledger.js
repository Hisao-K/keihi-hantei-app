/**
 * ledger.gs（＝ web/ledger.js と同じ中身。片方を直したらもう片方も同じにする。test/check.js が突き合わせる）
 * 台帳（{settings, data}）の合わせ方。GAS（保存のとき）と画面（読み込んだとき）が同じ決まりで合わせる。
 *
 * - 行（経費・運行・仮想通貨・株・FX・給与・売上）は id で突き合わせ、t（最後に直した時刻・ミリ秒）が新しいほうを採る
 * - 時刻が同じ（どちらも時刻を持たない移行前の行を含む）ときは base（保存してあるほう）を採る
 * - 消した行は墓標（tomb＝消した行の id の一覧）で伝え、戻さない
 * - 年ごとの値（売上の旧入力・株とFXの繰越損失・メーター）は mt["<種類>:<年>"] の時刻で同じように採る
 * - 基本項目は settings.t の時刻で、新しいほうを丸ごと採る
 */

var Ledger = (function () {
  var ROWK = ['entries', 'trades', 'opens', 'stocks', 'fx', 'salary', 'trips', 'rev'];
  var MAPK = ['sales', 'stockCarry', 'fxCarry', 'odo'];
  /* 管理者だけが使う記録（利用者の台帳には持たせない） */
  var ADMIN_ONLY_ROWS = ['trades', 'opens', 'stocks', 'fx', 'salary', 'rev'];
  var ADMIN_ONLY_MAPS = ['sales', 'stockCarry', 'fxCarry'];
  var ADMIN_ONLY_SETTINGS = ['kyuyoEnd'];

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

  function blank() {
    var d = {};
    ROWK.forEach(function (k) { d[k] = []; });
    MAPK.forEach(function (k) { d[k] = {}; });
    d.tomb = [];
    d.mt = {};
    return d;
  }

  /** 形をそろえる（足りない入れ物を作り、id のない行・壊れた値を落とす） */
  function norm(src) {
    var s = isObj(src) ? src : {};
    var d = blank();
    ROWK.forEach(function (k) {
      d[k] = (Array.isArray(s[k]) ? s[k] : []).filter(function (r) { return isObj(r) && r.id; });
    });
    MAPK.forEach(function (k) { if (isObj(s[k])) d[k] = s[k]; });
    d.tomb = (Array.isArray(s.tomb) ? s.tomb : []).filter(function (x) { return typeof x === 'string' && x; });
    if (isObj(s.mt)) d.mt = s.mt;
    return d;
  }

  /**
   * @param {Object} base 保存してあるほう（時刻が同じならこちら）
   * @param {Object} inc  新しく来たほう
   * @returns {Object} 合わせた data（base・inc は書き換えない）
   */
  function merge(base, inc) {
    var a = norm(base), b = norm(inc), out = blank();
    var tomb = {};
    a.tomb.concat(b.tomb).forEach(function (id) { tomb[id] = true; });
    out.tomb = Object.keys(tomb);

    ROWK.forEach(function (k) {
      var pos = {}, rows = [];
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

  function mergeSettings(base, inc) {
    var a = isObj(base) ? base : null, b = isObj(inc) ? inc : null;
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
    ROWK: ROWK, MAPK: MAPK,
    blank: blank, norm: norm, merge: merge, mergeSettings: mergeSettings, stripAdminOnly: stripAdminOnly,
  };
})();
