// =====================================================================
// 拡張ブリッジ: 予約同期くん(main process) ⇔ Chrome拡張 のローカルHTTP連携。
//
// 127.0.0.1:32178 で HTTP を立て、Chrome拡張がポーリングしてジョブを取り、
// 画像をローカル経由で受け取り、結果を返す。Playwright は使わない。
//
//   GET  /health                    → { ok, version, pending, ... }
//   GET  /jobs/next                  → 次の pending ジョブ(無ければ 204)
//   GET  /jobs/:jobId                → ジョブ状態 (worker process のポーリング用・秘匿情報なし)
//   GET  /jobs/:jobId/image          → 画像バイト(拡張がfetchしてFile化)
//   POST /jobs                       → ジョブ作成 (worker process から。openChrome=true で普段使いChromeを開く)
//   POST /jobs/:jobId/cancel         → pending のジョブを取り消す (拡張が拾う前のみ)
//   POST /jobs/:jobId/complete       → { status:'success'|'failed', imageId?, error?, diag? }
//
// ジョブはメモリ保持(第一段階)。状態変化は onJobEvent コールバックで
// renderer/worker に通知する(状態表示・ログ用)。
// =====================================================================

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = 32178;
const HOST = '127.0.0.1';

const jobs = new Map(); // jobId -> job
let server = null;
let onEvent = () => {};
// Chrome拡張が最後に /jobs/next をポーリングした時刻 (ISO)。
// null = 一度もポーリングされていない (= 拡張未導入/Chrome未起動の可能性)。
let lastExtensionPollAt = null;

function now() { return new Date().toISOString(); }
function genId() { return 'job_' + crypto.randomBytes(8).toString('hex'); }

function emit(type, payload) {
  try { onEvent({ type, at: now(), ...payload }); } catch (_e) { /* noop */ }
}

// 画像URLをローカル一時ファイルに落としておく(拡張へはローカル経由で渡す)。
function downloadToTmp(url) {
  return new Promise((resolve, reject) => {
    try {
      const mod = url.startsWith('http://') ? http : https;
      const req = mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // リダイレクト追従(1段)
          downloadToTmp(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('image download HTTP ' + res.statusCode));
          res.resume();
          return;
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        let ext = 'jpg';
        if (ct.includes('png')) ext = 'png';
        else if (ct.includes('webp')) ext = 'webp';
        else if (ct.includes('gif')) ext = 'gif';
        const file = path.join(os.tmpdir(), `kd_ext_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);
        const ws = fs.createWriteStream(file);
        res.pipe(ws);
        ws.on('finish', () => resolve({ file, mime: ct || 'image/jpeg' }));
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('image download timeout')));
    } catch (e) { reject(e); }
  });
}

// 新規ジョブを作成 (renderer/main から呼ぶ)。
// opts: { type, target, salonboardUrl, imageUrl(公開URL), shopId?, meta? }
async function createJob(opts = {}) {
  const id = genId();
  const job = {
    jobId: id,
    type: opts.type || 'hair_style_front',
    target: opts.target || 'FRONT_IMG_ID',
    mode: 'hair-style-front',
    salonboardUrl: opts.salonboardUrl || null,
    shopId: opts.shopId || null,
    meta: opts.meta || null,
    // ログイン/会社切替/サロン選択用(ローカルのみ。/jobs/next で拡張へ渡す)。
    loginId: opts.loginId || null,
    password: opts.password || null,
    companyId: opts.companyId || null,
    salonId: opts.salonId || null,
    expectedSalonName: opts.expectedSalonName || null,
    style: opts.style || null,
    enablePost: !!opts.enablePost,
    sourceImageUrl: opts.imageUrl || null,
    // 拡張が叩く画像URL(ローカル)。
    imageUrl: `http://${HOST}:${PORT}/jobs/${id}/image`,
    status: 'pending', // pending → picked → uploading → done | failed
    error: null,
    result: null,
    createdAt: now(),
    updatedAt: now(),
    localImage: null,
  };
  jobs.set(id, job);
  emit('job_created', { jobId: id, type: job.type, salonboardUrl: job.salonboardUrl });

  // 画像を先に手元へ落としておく(失敗を早期検知)。
  if (job.sourceImageUrl) {
    try {
      const dl = await downloadToTmp(job.sourceImageUrl);
      job.localImage = dl;
    } catch (e) {
      job.status = 'failed';
      job.error = '画像のダウンロードに失敗: ' + (e?.message ?? e);
      job.updatedAt = now();
      emit('job_failed', { jobId: id, error: job.error });
    }
  }
  return job;
}

function getJob(id) { return jobs.get(id) || null; }
function listJobs() { return Array.from(jobs.values()); }
function pendingCount() { return listJobs().filter((j) => j.status === 'pending').length; }

function setEventHandler(fn) { if (typeof fn === 'function') onEvent = fn; }

// 普段使いの Google Chrome で URL を開く (Playwright は使わない)。
// main.cjs の extension:create-style-job もこの関数を使う。
//
// ⚠️ `open -a "Google Chrome" url` はプロファイルを指定できず、Chrome が
// 最後に使ったプロファイルで開く。マシンによっては拡張/SalonBoardログインの
// 無い別プロファイルが開いてしまうため、Chrome 実行ファイルを直接
// `--profile-directory` 付きで起動する (起動済みでも process singleton が
// 指定プロファイルで URL を開く)。プロファイル名は環境変数
// SALONBOARD_CHROME_PROFILE で上書き可 (既定 "Default")。
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PROFILE = process.env.SALONBOARD_CHROME_PROFILE || 'Default';

function openChromeWithUrl(url) {
  try {
    if (process.platform === 'darwin') {
      if (fs.existsSync(CHROME_BIN)) {
        const { spawn } = require('node:child_process');
        const child = spawn(CHROME_BIN, [`--profile-directory=${CHROME_PROFILE}`, url], {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', (err) => emit('chrome_open_failed', { url, error: String(err?.message ?? err) }));
        child.unref();
        emit('chrome_opened', { url, profile: CHROME_PROFILE });
        return;
      }
      execFile('open', ['-a', 'Google Chrome', url], (err) => {
        emit(err ? 'chrome_open_failed' : 'chrome_opened', { url, error: err ? String(err.message ?? err) : undefined });
      });
      return;
    }
    // 他OSは既定ブラウザ (electron 外でも落ちないよう lazy require)。
    try {
      const { shell } = require('electron');
      shell.openExternal(url).then(
        () => emit('chrome_opened', { url }),
        (err) => emit('chrome_open_failed', { url, error: String(err?.message ?? err) }),
      );
    } catch (_e) {
      execFile(process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', url] : [url], () => {});
    }
  } catch (e) {
    emit('chrome_open_failed', { url, error: String(e?.message ?? e) });
  }
}

// ---- HTTP server ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handle(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['jobs','job_xx','image']

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      app: 'kireidot-yoyaku-douki',
      pending: pendingCount(),
      jobs: listJobs().length,
      extensionLastPollAt: lastExtensionPollAt,
    });
  }

  // POST /jobs — ジョブ作成 (worker process から呼ぶ。127.0.0.1のみ)。
  // body: createJob と同じ opts + { openChrome?: boolean }
  if (req.method === 'POST' && url.pathname === '/jobs') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch (_e) {}
      if (!opts.imageUrl) return sendJson(res, 400, { error: '画像URL(imageUrl)がありません' });
      try {
        const job = await createJob(opts);
        if (job.status !== 'failed' && opts.openChrome) {
          openChromeWithUrl(job.salonboardUrl || 'https://salonboard.com/CNB/draft/styleList/');
        }
        return sendJson(res, 200, { ok: job.status !== 'failed', jobId: job.jobId, status: job.status, error: job.error });
      } catch (e) {
        return sendJson(res, 500, { error: String(e?.message ?? e) });
      }
    });
    return;
  }

  // GET /jobs/next
  if (req.method === 'GET' && url.pathname === '/jobs/next') {
    lastExtensionPollAt = now();
    const job = listJobs().find((j) => j.status === 'pending');
    if (!job) return sendJson(res, 204, {});
    job.status = 'picked';
    job.updatedAt = now();
    emit('job_picked', { jobId: job.jobId });
    return sendJson(res, 200, {
      jobId: job.jobId,
      type: job.type,
      mode: job.mode,
      target: job.target,
      imageUrl: job.imageUrl,
      salonboardUrl: job.salonboardUrl,
      // ログイン/会社切替/サロン選択用(ローカル127.0.0.1経由)。
      loginId: job.loginId || null,
      password: job.password || null,
      companyId: job.companyId || null,
      salonId: job.salonId || null,
      expectedSalonName: job.expectedSalonName || null,
      style: job.style || null,
      enablePost: !!job.enablePost,
    });
  }

  // GET /jobs/:jobId/image
  if (req.method === 'GET' && parts[0] === 'jobs' && parts[2] === 'image') {
    const job = getJob(parts[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    if (!job.localImage || !fs.existsSync(job.localImage.file)) {
      return sendJson(res, 404, { error: 'image not ready' });
    }
    try {
      const buf = fs.readFileSync(job.localImage.file);
      res.writeHead(200, {
        'Content-Type': job.localImage.mime || 'image/jpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      job.status = (job.status === 'picked') ? 'uploading' : job.status;
      job.updatedAt = now();
      emit('job_uploading', { jobId: job.jobId });
      return res.end(buf);
    } catch (e) {
      return sendJson(res, 500, { error: String(e) });
    }
  }

  // POST /jobs/:jobId/cancel — ジョブを取り消す。
  // pending だけでなく picked/uploading も取り消せる (workerがタイムアウトした後に
  // 古いジョブがChromeを動かし続け、新しいジョブと二重ループする問題の対策)。
  // 取り消し後は /jobs/next で配られず、NAVリトライの complete(retry) でも
  // pending に戻さない = 拡張は次のポーリングで自然に止まる。
  if (req.method === 'POST' && parts[0] === 'jobs' && parts[2] === 'cancel') {
    const job = getJob(parts[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    if (job.status === 'pending' || job.status === 'picked' || job.status === 'uploading') {
      job.status = 'cancelled';
      job.updatedAt = now();
      try { if (job.localImage?.file) fs.unlinkSync(job.localImage.file); } catch (_e) {}
      emit('job_cancelled', { jobId: job.jobId });
      return sendJson(res, 200, { ok: true, cancelled: true });
    }
    return sendJson(res, 200, { ok: true, cancelled: false, status: job.status });
  }

  // GET /jobs/:jobId — ジョブ状態 (worker のポーリング用)。認証情報は返さない。
  if (req.method === 'GET' && parts[0] === 'jobs' && parts[1] && !parts[2]) {
    const job = getJob(parts[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    return sendJson(res, 200, {
      jobId: job.jobId,
      status: job.status,
      error: job.error,
      result: job.result,
      retryCount: job.retryCount || 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  // POST /jobs/:jobId/complete
  if (req.method === 'POST' && parts[0] === 'jobs' && parts[2] === 'complete') {
    const job = getJob(parts[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_e) {}
      // 取り消し済みジョブは復活させない (retryでpendingに戻すと二重ループする)。
      if (job.status === 'cancelled') {
        return sendJson(res, 200, { ok: true, cancelled: true });
      }
      if (payload.status === 'retry') {
        // 画面遷移(styleList→styleEdit)等で再実行が必要 → pending に戻す。
        // 何度も遷移ループしないよう retry 回数を制限。
        job.retryCount = (job.retryCount || 0) + 1;
        // login→groupTop→サロン選択→styleList→新規追加→styleEdit と多段遷移するため
        // リトライ上限は多めに(各遷移ごとに1回 retry を消費する)。
        if (job.retryCount > 12) {
          job.status = 'failed';
          job.error = payload.error || 'styleEditへ遷移できませんでした(リトライ上限)';
          job.updatedAt = now();
          emit('job_failed', { jobId: job.jobId, error: job.error });
        } else {
          job.status = 'pending';
          job.updatedAt = now();
          emit('job_retry', { jobId: job.jobId, retryCount: job.retryCount, reason: payload.error || 'navigation' });
        }
        return sendJson(res, 200, { ok: true, requeued: job.status === 'pending' });
      }
      if (payload.status === 'success') {
        job.status = 'done';
        job.result = { imageId: payload.imageId || null, resultStatus: payload.resultStatus || null, reason: payload.reason || null, diag: payload.diag || null };
        job.updatedAt = now();
        emit('job_completed', { jobId: job.jobId, imageId: payload.imageId || null, resultStatus: payload.resultStatus || null, reason: payload.reason || null, diag: payload.diag || null });
      } else {
        job.status = 'failed';
        job.error = payload.error || 'unknown';
        job.result = { diag: payload.diag || null, sbError: payload.sbError || null };
        job.updatedAt = now();
        emit('job_failed', { jobId: job.jobId, error: job.error, diag: payload.diag || null, sbError: payload.sbError || null });
      }
      // 画像一時ファイルを掃除。
      try { if (job.localImage?.file) fs.unlinkSync(job.localImage.file); } catch (_e) {}
      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  return sendJson(res, 404, { error: 'not found' });
}

function start() {
  if (server) return { ok: true, already: true };
  server = http.createServer(handle);
  server.on('error', (e) => {
    emit('bridge_error', { error: String(e?.message ?? e) });
    // EADDRINUSE: 既に別インスタンスが立っている可能性。
  });
  try {
    server.listen(PORT, HOST, () => {
      emit('bridge_started', { url: `http://${HOST}:${PORT}` });
    });
  } catch (e) {
    emit('bridge_error', { error: String(e?.message ?? e) });
  }
  return { ok: true };
}

function stop() {
  try { if (server) server.close(); } catch (_e) {}
  server = null;
}

module.exports = { start, stop, createJob, getJob, listJobs, pendingCount, setEventHandler, openChromeWithUrl, PORT, HOST };
