// =====================================================================
// Supabase Auth セッションを Electron userData 配下に永続化する (v0.2.9)
//
// 背景:
//   本番ビルドの .app は loadFile で file:// プロトコルで起動する。
//   Chromium の file:// オリジンは localStorage を安定して維持できず、
//   アプリ再起動のたびに Supabase セッションが消えて「毎回ログアウト」
//   される現象が起きていた。
//
//   解決策として、main プロセスで {userData}/auth-storage.json を読み書きする
//   IPC を提供し、renderer で supabase client の storage オプションに
//   contextBridge 経由で繋ぐ。
//
// セキュリティ:
//   - userData は OS ユーザー権限で守られた領域 (他ユーザーから見えない)
//   - ファイル権限は 0600 (本人のみ読み書き可)
//   - access_token / refresh_token を含むので扱いはセンシティブだが、
//     SalonBoard device_token と同じく PC ローカルにのみ存在する設計
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

function storagePath(app) {
  return path.join(app.getPath('userData'), 'auth-storage.json');
}

/** ファイル全体を読んで { key: value } のマップで返す。失敗時は空オブジェクト。 */
function readAll(app) {
  try {
    const p = storagePath(app);
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    if (json && typeof json === 'object') return json;
    return {};
  } catch (_e) {
    return {};
  }
}

function writeAll(app, obj) {
  const p = storagePath(app);
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch (_e) {
      /* ignore */
    }
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_e) {
      /* ignore */
    }
    throw e;
  }
}

/** 1 キーだけ取得 */
function getItem(app, key) {
  const all = readAll(app);
  return typeof all[key] === 'string' ? all[key] : null;
}

/** 1 キーだけ書き込み (null で削除) */
function setItem(app, key, value) {
  const all = readAll(app);
  if (value === null || value === undefined) {
    delete all[key];
  } else {
    all[key] = String(value);
  }
  writeAll(app, all);
}

function removeItem(app, key) {
  const all = readAll(app);
  if (key in all) {
    delete all[key];
    writeAll(app, all);
  }
}

module.exports = {
  storagePath,
  readAll,
  writeAll,
  getItem,
  setItem,
  removeItem,
};
