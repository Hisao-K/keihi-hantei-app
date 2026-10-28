// 経費判定君の設定。秘密の値は置かない（このファイルは公開される）。
// googleClientId＝経費判定君用の Google Cloud プロジェクトで作る OAuth クライアントID（ウェブアプリ）。公開されても問題ない値。
// apiUrl＝この会社の GAS（データの出し入れ）の URL。ここで決め打ちにし、リンクの ?api= では差し替えない
//   （偽の GAS へのリンクを踏ませて、ログインの情報を送らせる攻撃を防ぐ）。会社ごとに配るときは、この値を会社ごとに変える。
window.KEIHI_CONFIG = {
  googleClientId: '280111176960-rplmodo3fiepkbounnkf05vsnsd9hgnh.apps.googleusercontent.com',
  apiUrl: 'https://script.google.com/macros/s/AKfycbwnn6dTEYuYP77aSfyLjEq2eOdHPx4MxdlxqrD4FUygm9K7pM1RJVHXR1tF0iSO83_B/exec',
};
