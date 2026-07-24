// =====================================================================
// 予約同期くん: SalonBoard スクレイパー本体
//
// 4 つの URL に対応:
//   - 予約一覧:    https://salonboard.com/KLP/reserve/reserveList/init
//   - スタッフ:    https://salonboard.com/CNK/draft/staffList
//   - ブログ一覧:  https://salonboard.com/KLP/blog/blogList/
//   - 予約管理:    https://salonboard.com/KLP/schedule/salonSchedule/  (Phase 5 で着手)
//
// 設計方針:
//   * SalonBoard の HTML 構造は店舗ごとのテンプレートで微妙に変わる可能性が高い。
//     セレクタは「複数候補をフォールバック」「テキストヒューリスティック」で書き、
//     1 つ壊れても他のセルから情報が拾えるようにする。
//   * 各スクレイパーは page.evaluate でブラウザ内で DOM を走査して JSON を返す
//     (Playwright 経由で値を直接取りに行くより圧倒的に高速)。
//   * 日付の正規化は Node 側で行う (タイムゾーン: Asia/Tokyo)。
//
// 各関数の戻り値:
//   { rows: array, debug: { itemsFound, parsed, skipped } }
//   - rows は salonboard_bulk_upsert_* RPC にそのまま送れる形に整形済み
// =====================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ----------------- 共通ユーティリティ -----------------

/**
 * 同期が「検出0」など想定外のときに、実際にどの画面にいたかを保存する debug capture。
 * 保存先: ~/.kireidot/salonboard-debug/{channel}/{YYYYMMDDThhmmss}_{label}/
 *   - meta.json    … URL / title / 表示テキスト抜粋 / 入力要素サマリ
 *   - page.html    … HTML スナップショット (パスワード等はマスク)
 *   - screenshot.png
 * 個人情報保護: input/textarea の value は保存しない。HTML 中の password はマスク。
 * 既定 ON。SALONBOARD_DEBUG_CAPTURE=0/false/no で無効。
 */
const SCRAPE_DEBUG_CAPTURE = !/^(0|false|no)$/i.test(
  process.env.SALONBOARD_DEBUG_CAPTURE ?? '1',
);
function scrapeDebugStamp() {
  const d = new Date(Date.now() + 9 * 3600_000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}
function scrubScrapeSecrets(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (s && String(s).length >= 3) {
      const esc = String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(esc, 'g'), '***REDACTED***');
    }
  }
  out = out.replace(
    /(<input[^>]*type=["']?password["']?[^>]*value=["'])[^"']*(["'])/gi,
    '$1***REDACTED***$2',
  );
  return out;
}
// 直近に撮ったエラー画面のスクショ(Buffer)。失敗が起きた「まさにその画面」
// (ポップアップ/画像認証/エラーダイアログ等) を、後段の Slack 通知でそのまま
// 送れるように保持する。postCallback が再スクショする頃には画面遷移して
// しまっていることがあるため、失敗地点 (captureScrapeDebug 呼び出し時) の
// バッファを優先採用する。ジョブ開始時に resetLastErrorShot() でクリアする。
let _lastErrorShot = null; // { buffer, url, label, channel, at }
// 失敗地点で撮影中のスクショ Promise。postCallback 側が await して
// 「撮り終わってから」Slack に送れるようにする (撮影完了前に browser.close される競合回避)。
let _lastErrorShotPromise = null;
// ★per-page ショット (2026-07-11 並行レース根治): 店舗レーン並行(max2)で _lastErrorShot が
//   別ジョブに上書きされ、キャンセル通知に別予約のスクショが載る事故があった。page 単位で
//   保持し、getLastErrorShotForPage(page) で「そのジョブ自身の page で撮ったショット」だけ返す。
const _pageShots = new WeakMap(); // page -> { buffer, promise, at }

/** 失敗地点で撮った最新スクショを返す (無ければ null)。撮影中なら待つ。 */
async function getLastErrorShot() {
  try { if (_lastErrorShotPromise) await _lastErrorShotPromise; } catch (_e) { /* noop */ }
  return _lastErrorShot;
}
/** ★per-page: 指定 page で撮った失敗ショットのみ返す (並行安全)。撮影中なら待つ。 */
async function getLastErrorShotForPage(page) {
  if (!page) return null;
  const ent = _pageShots.get(page);
  if (!ent) return null;
  // 撮影が in-flight なら完了を待つ。ent は captureErrorShot で先に登録した「同じ
  // オブジェクト」で、_captureErrorShotToMemory が buffer をこの場で埋める(差し替えない)
  // ため、await 後に ent.buffer を読めば撮り終わった画像が取れる。
  try { if (ent.promise) await ent.promise; } catch (_e) { /* noop */ }
  return ent.buffer ? { buffer: ent.buffer, at: ent.at } : null;
}
/** ジョブ開始時に呼んで古いスクショを捨てる (前ジョブの画面を誤送信しない)。 */
function resetLastErrorShot() {
  _lastErrorShot = null;
  _lastErrorShotPromise = null;
}

/**
 * 失敗地点で「今の画面」をメモリにスクショする (best-effort, 非ブロッキング)。
 * fail() ヘルパ等から page を渡して呼ぶ。返り値は撮影 Promise (await 任意)。
 */
function captureErrorShot(page, label) {
  const pr = _captureErrorShotToMemory(page, 'push', label || 'fail');
  _lastErrorShotPromise = pr;
  // ★per-page: 撮影完了前に report() が来ても待てるよう、この page の entry を promise 付きで
  //   即登録する。buffer は _captureErrorShotToMemory が撮り終えたら「この同じ entry」に埋める
  //   (差し替えない)ので、getLastErrorShotForPage が await 後に buffer を読める。
  try {
    if (page) {
      const ent = _pageShots.get(page);
      if (ent) { ent.promise = pr; ent.at = Date.now(); }
      else _pageShots.set(page, { buffer: null, promise: pr, at: Date.now() });
    }
  } catch (_e) { /* noop */ }
  return pr;
}

// SCRAPE_DEBUG_CAPTURE が false でも、エラー画面のスクショ(メモリ保持)だけは
// 撮りたい。ローカルへのファイル保存とは独立に、常に最新ショットを更新する。
async function _captureErrorShotToMemory(page, channel, label) {
  try {
    if (!page || page.isClosed?.()) return;
    const shot = await Promise.race([
      page.screenshot({ fullPage: false, timeout: 6_000 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 7_000)),
    ]);
    if (shot && Buffer.isBuffer(shot)) {
      let url = '';
      try { url = page.url(); } catch (_e) { /* noop */ }
      _lastErrorShot = { buffer: shot, url, label, channel, at: Date.now() };
      // ★per-page にも保持 (並行安全)。captureErrorShot が先に登録した entry があれば
      //   「その同じオブジェクト」に buffer を埋める(getLastErrorShotForPage が await 中の
      //   参照と一致させるため差し替えない)。無ければ新規登録。
      try {
        const ent = _pageShots.get(page);
        if (ent) { ent.buffer = shot; ent.at = Date.now(); }
        else _pageShots.set(page, { buffer: shot, promise: null, at: Date.now() });
      } catch (_e) { /* noop */ }
    }
  } catch (_e) { /* スクショ失敗は致命ではない */ }
}

async function captureScrapeDebug(page, channel, label, opts = {}) {
  // 失敗地点のスクショは「まさにその画面」を Slack に出すために常にメモリ保持する
  // (ローカル保存フラグ SCRAPE_DEBUG_CAPTURE とは独立)。
  await _captureErrorShotToMemory(page, channel, label);
  if (!SCRAPE_DEBUG_CAPTURE) return null;
  try {
    const dir = path.join(
      os.homedir(), '.kireidot', 'salonboard-debug', channel,
      `${scrapeDebugStamp()}_${String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`,
    );
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secrets = opts.secrets ?? [];
    const url = page.url();
    let title = '';
    try { title = await page.title(); } catch (_e) { /* noop */ }
    let inputs = [];
    let textExcerpt = '';
    try {
      const snap = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('input, select, textarea, table'));
        const inputSummary = els.slice(0, 80).map((e) => ({
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute('type') || undefined,
          name: e.getAttribute('name') || undefined,
          id: e.id || undefined,
        }));
        const tableInfo = Array.from(document.querySelectorAll('table')).map((t) => ({
          id: t.id || t.className || '?',
          rows: t.querySelectorAll('tr').length,
        }));
        return { inputSummary, tableInfo, body: (document.body?.innerText ?? '').slice(0, 3000) };
      });
      inputs = snap.inputSummary;
      textExcerpt = scrubScrapeSecrets(snap.body, secrets);
      var tableInfo = snap.tableInfo;
    } catch (_e) { /* noop */ }
    const meta = {
      captured_at_jst: scrapeDebugStamp(), channel, label, url, title,
      input_count: inputs.length, inputs,
      tables: typeof tableInfo !== 'undefined' ? tableInfo : [],
      diagnostics: opts.diagnostics ?? null,
      text_excerpt: textExcerpt,
    };
    // meta.json は最優先で書く (page.content()/screenshot がローディング中に
    // ハングしても診断情報が必ず残るように、これらより先に書く)。
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    // page.content() はローディング中に固まることがあるので Promise.race でタイムアウト。
    try {
      const html = await Promise.race([
        page.content(),
        new Promise((resolve) => setTimeout(() => resolve(null), 6_000)),
      ]);
      if (html) fs.writeFileSync(path.join(dir, 'page.html'), scrubScrapeSecrets(html, secrets), { mode: 0o600 });
    } catch (_e) { /* noop */ }
    try {
      await Promise.race([
        page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: false, timeout: 6_000 }),
        new Promise((resolve) => setTimeout(resolve, 7_000)),
      ]);
      try { fs.chmodSync(path.join(dir, 'screenshot.png'), 0o600); } catch (_e) { /* noop */ }
    } catch (_e) { /* noop */ }
    return dir;
  } catch (_e) {
    return null;
  }
}

/**
 * JST 文字列を ISO 8601 (UTC) に変換。複数のフォーマットを許容:
 *   - "2025/05/23 14:30" / "2025-05-23 14:30" / "2025年5月23日 14:30"
 *   - "5/23(金) 14:30"   ← 年なし (SalonBoard の予約一覧でよく出る)
 *   - "05/23 14:30"
 *   - "5月23日 14:30"
 *
 * 年が欠落している場合は「今日に最も近い年」を採用する。
 * (今年・来年・去年を試して、今日との差が一番小さいものを選ぶ)
 */
function parseJstDateTime(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // multiline (br 由来) も 1 行扱いに
  const s = raw.replace(/\s+/g, ' ').trim();

  // 1) 年あり: "YYYY/MM/DD HH:MM" 等
  let m = s.match(
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[^\d]{0,5}(\d{1,2}):(\d{2}))?/,
  );
  let Y, M, D, H, Mi;
  if (m) {
    Y = Number(m[1]);
    M = Number(m[2]) - 1;
    D = Number(m[3]);
    H = m[4] ? Number(m[4]) : 0;
    Mi = m[5] ? Number(m[5]) : 0;
  } else {
    // 2) 年なし: "5/25(月) 19:00" "M月D日 HH:MM" など。
    //    時刻部分は「分」「時間」のような誤マッチを避けるため (?!分) を入れる。
    m = s.match(
      /(\d{1,2})[\/月](\d{1,2})日?(?:[^\d]{0,10}?)((\d{1,2}):(\d{2}))?(?!分)/,
    );
    if (!m) return null;
    M = Number(m[1]) - 1;
    D = Number(m[2]);
    H = m[4] ? Number(m[4]) : 0;
    Mi = m[5] ? Number(m[5]) : 0;
    // 時刻が拾えてない場合は、文字列内の独立した HH:MM を探す
    if (!m[3]) {
      const tm = s.match(/(?<!\d)(\d{1,2}):(\d{2})(?!分)/);
      if (tm) {
        H = Number(tm[1]);
        Mi = Number(tm[2]);
      }
    }
    // 年は「今日に最も近い」候補を採用
    const today = new Date();
    const candidates = [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1];
    let best = today.getFullYear();
    let bestDiff = Infinity;
    for (const y of candidates) {
      const utc = Date.UTC(y, M, D, H - 9, Mi);
      if (Number.isNaN(utc)) continue;
      const diff = Math.abs(utc - today.getTime());
      if (diff < bestDiff) {
        bestDiff = diff;
        best = y;
      }
    }
    Y = best;
  }

  const utc = Date.UTC(Y, M, D, H - 9, Mi);
  if (Number.isNaN(utc)) return null;
  return new Date(utc).toISOString();
}

/** "YYYY/MM/DD" → "YYYY-MM-DD" (date 型用) */
function parseJstDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/** 金額表示「¥12,300」「12300円」などから整数を取り出す */
function parseYen(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.replace(/,/g, '').match(/(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/** 「60分」「90 min」から分を取る */
function parseMinutes(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)\s*分/);
  if (m) return parseInt(m[1], 10);
  const h = raw.match(/(\d+)\s*時間/);
  if (h) return parseInt(h[1], 10) * 60;
  return null;
}

/** SalonBoard 顧客コード "YG12345678" 等を抜き出す */
function extractCustomerCode(text) {
  if (!text) return null;
  const m = String(text).match(/([A-Z]{1,4}\d{4,})/);
  return m ? m[1] : null;
}

/**
 * URL の querystring から id を取る。
 * 例: "/KLP/reserve/reserveDetail?reservationId=ABC123" → "ABC123"
 */
function extractIdFromUrl(url, ...candidates) {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://salonboard.com');
    for (const k of candidates) {
      const v = u.searchParams.get(k);
      if (v) return v;
    }
    // フォールバック: 末尾の数字列
    const m = u.pathname.match(/(\d{4,})/);
    return m ? m[1] : null;
  } catch (_e) {
    return null;
  }
}

// ----------------- 予約一覧 (reserveList) -----------------

const RESERVE_LIST_URL = 'https://salonboard.com/KLP/reserve/reserveList/init';

/**
 * 「昨日」から「N ヶ月後の月末」までの日付範囲を返す。
 * 例) 今日が 2026-06-02 で months=3 なら from=2026-06-01, to=2026-08-31
 */
function defaultBookingDateRange(months = 3) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 1);
  from.setHours(0, 0, 0, 0);
  // N ヶ月後 (= 今月 + months) の月末
  const to = new Date(today.getFullYear(), today.getMonth() + months + 1, 0);
  to.setHours(23, 59, 59, 999);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from, to, fromStr: fmt(from), toStr: fmt(to) };
}

/**
 * SalonBoard 予約一覧の検索フォームに日付範囲を入力して「検索する」を押す。
 *
 * 初期画面 (reserveList/init) は **検索を実行しないと結果が出ない**ため、
 * このステップを必ず通る必要がある。
 *
 *  - 「来店日 開始」「来店日 終了」の input は name 規約が一定でないので
 *    画面内の「日付っぽい」入力欄を上から最大 2 つ拾って先頭=from / 次=to とする
 *  - 「検索する」ボタンは <a> タグの onclick 実装。テキスト一致で探す
 *  - ステータスは全種チェック (済み・キャンセル等も含めて拾うため)
 */
async function applyBookingDateFilter(page, { fromStr, toStr }, { diag } = {}) {
  const slashFrom = fromStr.replace(/-/g, '/');
  const slashTo = toStr.replace(/-/g, '/');
  const yyyymmddFrom = fromStr.replace(/-/g, '');
  const yyyymmddTo = toStr.replace(/-/g, '');
  const [fy, fm, fd] = fromStr.split('-');
  const [ty, tm, td] = toStr.split('-');
  const report = (s) => {
    if (diag) diag.push(s);
  };

  // 現在のフォームから rsv*/disp* の値を読む (途中経過の可視化用)
  const snapshot = async (label) => {
    try {
      const snap = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const interesting = inputs
          .filter((i) =>
            /rsvDate|dispDate|searchDate|fromDate|toDate|fromYmd|toYmd/i.test(
              (i.name || '') + (i.id || ''),
            ),
          )
          .map(
            (i) =>
              `${i.name || i.id}(${i.type})=${i.value || ''}`,
          );
        return interesting;
      });
      report(`[${label}] ${snap.join(' | ')}`);
    } catch (e) {
      report(`[${label}] snapshot err: ${e.message}`);
    }
  };

  try {
    await snapshot('before');
    // SalonBoard の日付欄は readonly で表示用 (dispDateFrom/dispDateTo)。
    // 検索送信時に使われる本物のフィールドは hidden input (例:
    // searchFromDate, searchToDate, fromYear, fromMonth, fromDay) であることが多い。
    // 両方を上書きする + フォームの input 名を診断ログに残す。
    const setResult = await page.evaluate(
      ({ from, to, yyyymmddF, yyyymmddT, fy, fm, fd, ty, tm, td }) => {
        function setVal(el, v) {
          if (!el) return false;
          el.removeAttribute('readonly');
          el.removeAttribute('disabled');
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        }

        // 1) 表示用の日付欄 (dispDate*) — UI 表示のために
        const dispInputs = Array.from(document.querySelectorAll('input[type="text"]'))
          .filter((el) => /disp.*date|date.*disp/i.test((el.name || '') + (el.id || '')));
        if (dispInputs[0]) setVal(dispInputs[0], from);
        if (dispInputs[1]) setVal(dispInputs[1], to);

        // 2) 全フォームの全 input/select を抽出 (診断ログ用)
        const allFormInputs = [];
        for (const f of Array.from(document.forms)) {
          for (const el of Array.from(f.elements)) {
            if (!el.name) continue;
            if (el.type === 'submit' || el.type === 'button') continue;
            allFormInputs.push({
              form: f.name || f.id || f.action,
              name: el.name,
              type: el.type,
              value: el.value,
            });
          }
        }

        // 3) 名前に from/to/start/end + date/day/month/year を含む input を全部書き換える
        //
        // 重要: hidden で送信される値はほぼ確実に YYYYMMDD 形式。
        //        例) rsvDateFrom=20260525 / rsvDateTo=20260525
        //        ここでは hidden / text どちらでも YYYYMMDD を入れる。
        function isFrom(n) {
          return /(rsvDate|searchDate|reserveDate|reserveFromDate|searchFromDate|fromYmd|fromDate|startDate).*(?!to)/i.test(n)
            && /from|start|begin/i.test(n);
        }
        function isTo(n) {
          return /(rsvDate|searchDate|reserveDate|reserveToDate|searchToDate|toYmd|toDate|endDate)/i.test(n)
            && /to|end|finish/i.test(n);
        }
        const filled = { from: [], to: [], parts: [] };
        for (const f of Array.from(document.forms)) {
          for (const el of Array.from(f.elements)) {
            if (!el.name) continue;
            const n = el.name + ' ' + (el.id || '');
            // 表示用 disp は既に処理済み
            if (/disp.*date|date.*disp/i.test(n)) continue;

            // year/month/day の個別 select はまず判定
            if (/(from|start).*year|fromYear/i.test(n) && el.tagName !== 'A') {
              setVal(el, fy);
              filled.parts.push(`${el.name}=${fy}`);
              continue;
            }
            if (/(from|start).*month|fromMonth/i.test(n)) {
              setVal(el, fm.replace(/^0/, ''));
              filled.parts.push(`${el.name}=${fm}`);
              continue;
            }
            if (/(from|start).*day|fromDay/i.test(n)) {
              setVal(el, fd.replace(/^0/, ''));
              filled.parts.push(`${el.name}=${fd}`);
              continue;
            }
            if (/(to|end).*year|toYear/i.test(n)) {
              setVal(el, ty);
              filled.parts.push(`${el.name}=${ty}`);
              continue;
            }
            if (/(to|end).*month|toMonth/i.test(n)) {
              setVal(el, tm.replace(/^0/, ''));
              filled.parts.push(`${el.name}=${tm}`);
              continue;
            }
            if (/(to|end).*day|toDay/i.test(n)) {
              setVal(el, td.replace(/^0/, ''));
              filled.parts.push(`${el.name}=${td}`);
              continue;
            }

            // 日付テキスト/hidden: from と to を判別
            // rsvDateFrom / rsvDateTo / reserveFromDate / etc.
            if (isFrom(n)) {
              // hidden は YYYYMMDD, text は YYYY/MM/DD
              const v = el.type === 'hidden' ? yyyymmddF : from;
              setVal(el, v);
              filled.from.push(`${el.name}=${v}`);
            } else if (isTo(n)) {
              const v = el.type === 'hidden' ? yyyymmddT : to;
              setVal(el, v);
              filled.to.push(`${el.name}=${v}`);
            }
          }
        }
        return {
          dispCount: dispInputs.length,
          allInputs: allFormInputs,
          filledFrom: filled.from,
          filledTo: filled.to,
          filledParts: filled.parts,
        };
      },
      {
        from: slashFrom,
        to: slashTo,
        yyyymmddF: yyyymmddFrom,
        yyyymmddT: yyyymmddTo,
        fy, fm, fd, ty, tm, td,
      },
    );
    report(`disp inputs: ${setResult.dispCount}`);
    report(
      `filled from: [${setResult.filledFrom.join(',')}] to: [${setResult.filledTo.join(',')}] parts: [${setResult.filledParts.join(',')}]`,
    );
    // 全 form の input 名を 1 回だけ短く出す (重要なヒント)
    const dateNames = setResult.allInputs
      .filter((i) => /date|day|month|year|ymd/i.test(i.name))
      .map((i) => `${i.name}(${i.type})=${(i.value || '').slice(0, 12)}`);
    if (dateNames.length > 0) {
      report(`date-ish inputs: ${dateNames.join(' | ').slice(0, 500)}`);
    }
    await snapshot('after-write');

    // 2) ステータスを全選択 (キャンセル含めて全部拾う)
    const statusBoxes = await page.locator('input[type="checkbox"][name*="status" i], input[type="checkbox"][name*="Status" i]').all();
    for (const cb of statusBoxes) {
      try {
        const checked = await cb.isChecked();
        if (!checked) await cb.check({ timeout: 1000 });
      } catch (_e) {
        /* ignore */
      }
    }
    report(`status checkboxes: ${statusBoxes.length}`);

    // 検索を押す直前にもう一度 rsv* を強制上書き + click(blur) で focusout を発火
    // SB 側の onchange ハンドラが disp の change を見て rsv を上書きするため、
    // disp に正しい値を書いた後 blur を発火して SB の同期を起こす方式と、
    // それでもダメな場合の hidden 直書きを併用する。
    await page.evaluate(
      ({ yyyymmddF, yyyymmddT, slashF, slashT }) => {
        function setVal(el, v) {
          if (!el) return;
          el.removeAttribute('readonly');
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        const inputs = Array.from(document.querySelectorAll('input'));
        // まず disp に書いて SB の onchange に正しい値を伝える
        for (const el of inputs) {
          const n = (el.name || '') + ' ' + (el.id || '');
          if (/dispDateFrom/i.test(n)) setVal(el, slashF);
          else if (/dispDateTo/i.test(n)) setVal(el, slashT);
        }
        // SB が rsv を同期するのに任せた後、念のため hidden も直接上書き
        for (const el of inputs) {
          const n = (el.name || '') + ' ' + (el.id || '');
          if (el.type !== 'hidden') continue;
          if (/rsvDateFrom|searchFromDate|reserveFromDate|fromDate$|fromYmd/i.test(n)) {
            setVal(el, yyyymmddF);
          } else if (/rsvDateTo|searchToDate|reserveToDate|toDate$|toYmd/i.test(n)) {
            setVal(el, yyyymmddT);
          }
        }
      },
      {
        yyyymmddF: yyyymmddFrom,
        yyyymmddT: yyyymmddTo,
        slashF: slashFrom,
        slashT: slashTo,
      },
    );
    await snapshot('right-before-submit');

    // 全 hidden 値を 1 回だけダンプ (大量だが原因究明には必要)
    try {
      const allHidden = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="hidden"], input[type="text"]'))
          .filter((i) => i.name)
          .map((i) => `${i.name}=${(i.value || '').slice(0, 30)}`)
          .join(' | ');
      });
      report(`all-inputs: ${allHidden.slice(0, 1200)}`);
    } catch (_e) {
      /* ignore */
    }

    // 「検索する」ボタンの onclick の中身を確認 (関数名 dologin の予約版があるか)
    try {
      const submitInfo = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a, button')).find((e) =>
          /検索する/.test(e.textContent || ''),
        );
        if (!a) return null;
        return {
          tag: a.tagName,
          text: (a.textContent || '').trim(),
          onclick: a.getAttribute('onclick') || '',
          href: a.getAttribute('href') || '',
          cls: a.className,
        };
      });
      if (submitInfo) {
        report(
          `submit btn: <${submitInfo.tag}> "${submitInfo.text}" class="${submitInfo.cls}" onclick="${(submitInfo.onclick || '').slice(0, 200)}"`,
        );
      } else {
        report('submit btn: NOT FOUND');
      }
    } catch (_e) {
      /* ignore */
    }

    // 3) 「検索する」ボタンをクリック
    const submitCandidates = [
      'a:has-text("検索する")',
      'a.common-CNCcommon__primaryBtn:has-text("検索")',
      'a[onclick*="searchReserve" i]',
      'a[onclick*="search" i]:not([onclick*="reset" i])',
      'a:has-text("検索"):not(:has-text("クリア"))',
      'button:has-text("検索")',
    ];
    for (const sel of submitCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
          loc.click({ timeout: 5000 }),
        ]);
        // waitForLoadState はクリック時点のページが読み込み済みだと「即解決」する。
        // その場合、後続の抽出が検索前の旧 DOM (結果テーブル無し) を読んで
        // 検出0 になる (間欠的な「予約 0/0件」の正体)。
        // 結果ページ URL (/reserveList/search) と結果テーブルの出現を明示的に待つ。
        await page
          .waitForURL(/\/reserveList\/(search|changePage)/, { timeout: 20_000 })
          .catch(() => {});
        const resultVisible = await page
          .waitForSelector('#resultList, table.reserveSearchResultTable', { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (!resultVisible) report('result table not visible after submit (該当0件 or 結果ページ未到達)');
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
        report(`clicked submit: ${sel}`);
        await snapshot('after-submit');
        // 検索後の結果テーブル行数も簡易ログ
        try {
          const rowsCount = await page.evaluate(() => {
            const ts = Array.from(document.querySelectorAll('table'));
            const counts = ts
              .map((t) => t.querySelectorAll('tbody tr, tr').length)
              .filter((n) => n > 0);
            return counts.join(',');
          });
          report(`tables row counts after submit: ${rowsCount}`);
        } catch (_e) {
          /* ignore */
        }
        return true;
      } catch (e) {
        report(`submit err (${sel}): ${e.message}`);
      }
    }
    report('no submit button matched');
    return false;
  } catch (e) {
    report(`fatal: ${e.message}`);
    return false;
  }
}

/**
 * 予約一覧をスクレイピングして bookings 行を返す。
 *  - 日付範囲: 昨日〜N ヶ月後の月末 (デフォルト 3 ヶ月)
 *  - ページネーション: 「次へ」リンクがある限り辿る (最大 30 ページ)
 */
/** YYYY-MM-DD 文字列の範囲を YYYYMMDD の配列 (JST) にする。最大 maxDays 日。 */
function hairDateList(fromStr, toStr, maxDays) {
  const out = [];
  const from = new Date(`${fromStr}T00:00:00+09:00`);
  const to = new Date(`${toStr}T00:00:00+09:00`);
  let cur = from;
  let guard = 0;
  while (cur.getTime() <= to.getTime() && guard < (maxDays || 120)) {
    const jst = new Date(cur.getTime() + 9 * 3600_000);
    const ymd = `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}`;
    out.push(ymd);
    cur = new Date(cur.getTime() + 24 * 3600_000);
    guard++;
  }
  return out;
}

/**
 * 美容室(hair)の予約を「スケジュール画面」から取得する。
 *
 * 予約一覧(/CLS/hair/reservations/init/)は React SPA で検索操作が複雑なため、
 * 旧式で予約明細が全て入る スケジュール画面
 *   /CLP/bt/schedule/salonSchedule/?date=YYYYMMDD
 * を日付ごとに開いて予約ブロック(div.panel_reserve)を集める方式にする。
 *
 * 確定 DOM (salonboard_code/美容室/スケジュール_salonSchedule.html):
 *   div.panel_reserve[id^="reserve_item_"]
 *     p.reserveItemCustomer            顧客名 (末尾「様」除去)
 *     span.panel_reserve_id            予約番号 (B.../YG...)
 *     span.panel_reserve_stylistId     スタイリストID (T... / 0000000000=フリー)
 *     span.panel_reserve_date          来店日 YYYYMMDD
 *     span.panel_reserve_start         開始 HHMM
 *     span.panel_reserve_registeredFlg 来店処理フラグ
 *   div.mod_btn_22[id^="stylist_"] .name  スタイリスト名
 *
 * 例外は投げない (ブラウザを閉じない)。
 */
async function scrapeHairBookings(page, opts = {}) {
  const range = opts.range || defaultBookingDateRange(3);
  const diag = opts.diag || [];
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const dates = hairDateList(range.fromStr, range.toStr, 100);
  diag.push(`hair schedule: ${dates.length}日分を巡回 (${range.fromStr}〜${range.toStr})`);

  const allRows = [];
  const seen = new Set();
  let capturedOnce = false;
  let MAX_DAYS = dates.length;
  // ★#1 fetch堅牢化: スケジュール枠を確実に描画できた日(coveredDates)と、
  //   リトライしても未描画で取りこぼした可能性のある日(incompleteDates)を分けて記録する。
  //   将来の cancel検出は「完全取得できた日」だけを対象にできる(誤削除防止)。
  const coveredDates = [];
  const incompleteDates = [];
  // SB「残り受付可能数」(surplus行) を表示用に取得。KDの受付可能数UIがSB実数を鏡写しにする。
  const allAcceptance = [];

  // グループアカウント(ADER等)はサロン選択後 /CLP/bt/top/ に居る。スケジュールへ直接 goto すると
  // SB が無効セッション扱い(「有効期限切れ/再度ログイン」エラー画面)にするため(実機 2026-06-28)、
  // UI の「本日のスケジュール」リンクをクリックして遷移し、セッション文脈を確立する。
  // 確立後は日付の ?date= goto が通る。単一店(既にスケジュール文脈)では no-op に近い。
  //
  // ★失効の自己回復(2026-07-04 郡山): 同一SBアカウントの他セッション操作等で、ジョブ冒頭の
  //   ログイン確認は通るのにここで「有効期限切れ」を踏むことがある(キャプチャで確定)。
  //   その場合は opts.relogin (worker 提供: logout→fresh login) → サロン再選択で
  //   1回だけやり直す(失効時限定なので doLogin 乱発にはならない)。
  const isExpiredPage = () =>
    page.evaluate(() =>
      /有効期限|再度ログイン|操作されなかった/.test(((document.body && document.body.innerText) || '').replace(/\s+/g, '')),
    ).catch(() => false);
  for (let warmTry = 1; warmTry <= 2; warmTry++) {
    try {
      // 失効ページに居るなら warmup(リンク探し)は無駄 → 即 relogin 分岐へ。
      if (!(await isExpiredPage())) {
        await captureScrapeDebug(page, 'bookings', 'hair_top_before_sched', {
          diagnostics: { url: page.url(), warmTry },
        }).catch(() => null);
        const schedLink = page
          .locator('a[href*="/CLP/bt/schedule/salonSchedule"]')
          .first();
        // ★サロン選択直後は POST リダイレクトの余韻で locator が空振りする(実行コンテキスト
        //   破棄→catch→0)ことがある(実DOMにはリンクが存在するのに not found と誤判定していた)。
        //   attached を最大10秒待ってからクリックする。
        await schedLink.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
        if ((await schedLink.count().catch(() => 0)) > 0) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}),
            schedLink.click({ timeout: 10_000 }).catch(() => {}),
          ]);
          await page.waitForTimeout(1500);
          diag.push(`hair: schedule warmup click -> ${page.url()}`);
          console.log(`[scrape] hair schedule warmup -> ${page.url()}`);
        } else {
          // リンクが本当に無い場合も、日付付き goto (セッションを壊す) には直行せず、
          // まず日付なしのスケジュールURLへ遷移して文脈を確立する。
          diag.push(`hair: schedule link not found (url=${page.url()}) -> bare goto`);
          console.log(`[scrape] hair schedule link not found (url=${page.url()}) -> bare goto`);
          await page.goto(new URL('/CLP/bt/schedule/salonSchedule/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
    } catch (_e) {
      /* best-effort: 下の失効判定/日付ループへ */
    }
    if (!(await isExpiredPage())) break; // 文脈確立できた
    if (warmTry === 1 && typeof opts.relogin === 'function') {
      diag.push('hair: session expired at warmup -> relogin');
      console.log('[scrape] hair warmup expired -> relogin');
      const ok = await opts.relogin().catch(() => false);
      if (ok) {
        // ログインし直したのでサロンを選び直してから再 warmup。
        await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
        continue;
      }
    }
    break; // relogin 不可/失敗 → 従来どおり日付ループへ(1日目の失効判定で loggedOut 扱いになる)
  }

  for (let i = 0; i < MAX_DAYS; i++) {
    // ★preemption: 予約書込が来たら fetch を即中断してレーンを譲る(3分SLA)。取得済み分は捨てる。
    if (opts.abortSignal && opts.abortSignal.aborted) throw new Error('aborted: preempted by booking write');
    const ymd = dates[i];
    let schedUrl;
    try {
      const u = new URL('/CLP/bt/schedule/salonSchedule/', baseUrl);
      u.searchParams.set('date', ymd);
      schedUrl = u.toString();
    } catch (_e) {
      schedUrl = `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${ymd}`;
    }
    // ★#1 fetch堅牢化: 描画レース対策。従来は goto→3.5秒待ち→即抽出で、プロキシ/Akamai で
    //   描画が遅れた日は「スケジュール枠が出る前に 0 件抽出」して黙って取りこぼしていた
    //   (実在予約すら欠落 → KDに古い予約が残る主因)。ここでは「スケジュール枠(コンテナ)が
    //   出現したか」を明示的に判定し、未出現ならリロードして最大2回まで再試行する。
    //   コンテナはサーバーレンダリングで初期HTMLに入るため、happy path は即解決=通常日は遅くならない。
    let rendered = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(schedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (_e) {
        diag.push(`hair: ${ymd} goto失敗 (try ${attempt})`);
        await page.waitForTimeout(700).catch(() => {});
        continue;
      }
      // 空の日でもスケジュール枠自体は出る。枠の出現＝「その日を確実に描画できた」証拠。
      // networkidle は常時稼働トラッキングで待ちすぎるため使わない。
      const hasContainer = await page
        .waitForSelector('#scheduleItemArea, #stylistScheduleArea', {
          timeout: attempt === 1 ? 5_000 : 8_000,
        })
        .then(() => true)
        .catch(() => false);
      if (hasContainer) {
        rendered = true;
        break;
      }
      diag.push(`hair: ${ymd} スケジュール枠未描画 (try ${attempt}) -> reload`);
      await page.waitForTimeout(600).catch(() => {});
    }

    // 1日目だけ capture (DOM確認用) + セッション切れ判定。
    if (!capturedOnce) {
      capturedOnce = true;
      const expired = await page.evaluate(() => {
        const body = (document.body?.innerText || '').replace(/\s+/g, '');
        return {
          hasPw: !!document.querySelector('input[type="password"]'),
          expired: /有効期限が切れ|再度ログイン|操作されなかった/.test(body) || /KPCL\d{3}V\d{2}/.test(body),
          hasSchedule: !!document.getElementById('scheduleItemArea') || !!document.getElementById('stylistScheduleArea'),
        };
      }).catch(() => ({ hasPw: false, expired: false, hasSchedule: false }));
      if (expired.hasPw || expired.expired || /\/(?:CNC|KLP)\/groupTop/i.test(page.url())) {
        const cap = await captureScrapeDebug(page, 'bookings', 'logged_out_or_group_top', {
          diagnostics: { url: page.url(), expired },
        }).catch(() => null);
        return {
          rows: [],
          debug: {
            itemsFound: 0, loggedOut: true,
            landedOn: /\/(?:CNC|KLP)\/groupTop/i.test(page.url()) ? 'group_top' : (expired.hasPw ? 'login' : 'session_expired'),
            genre: 'hair',
            diag: [...diag, `スケジュール到達不可 (capture=${cap || '?'})`],
          },
        };
      }
      await captureScrapeDebug(page, 'bookings', 'hair_schedule', {
        diagnostics: { url: page.url(), date: ymd, hasSchedule: expired.hasSchedule },
      }).catch(() => null);
    }

    // ★#1: 描画確認できた日だけを covered に記録。未描画の日は取りこぼし扱いにして
    //   件数抽出しない(0件で「その日は予約なし」と誤認しない)。
    if (!rendered) {
      incompleteDates.push(ymd);
      if (i < MAX_DAYS - 1) {
        const r0 = (Math.random() + Math.random()) / 2;
        await page.waitForTimeout(Math.round(300 + r0 * 700)).catch(() => {});
      }
      continue;
    }
    coveredDates.push(ymd);

    // 予約ブロックを抽出。
    const dayItems = await page.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
      // スタイリストID → 名前 のマップ
      const nameById = {};
      for (const head of Array.from(document.querySelectorAll('div.mod_btn_22[id^="stylist_"]'))) {
        const id = (head.id || '').replace(/^stylist_/, '');
        const name = txt(head.querySelector('.name'));
        if (id && name && !nameById[id]) nameById[id] = name;
      }
      const out = [];
      for (const rv of Array.from(document.querySelectorAll('div.panel_reserve[id^="reserve_item_"]'))) {
        const get = (cls) => txt(rv.querySelector(`.${cls}`));
        const id = get('panel_reserve_id');
        if (!id) continue;
        const stylistId = get('panel_reserve_stylistId');
        // 所要(粗): 予約ブロックを内包する <td colspan=N> の N。SBスケジュールは
        // 30分/枠なので所要分 ≈ colspan*30 の目安。正確な値は後段で予約変更
        // フォームから補正する (enrichDurationsFromDetail)。colspan が取れない/1未満なら null。
        let colspanMin = null;
        const td = rv.closest('td');
        if (td) {
          const cs = parseInt(td.getAttribute('colspan') || '', 10);
          if (Number.isFinite(cs) && cs >= 1) colspanMin = cs * 30;
        }
        out.push({
          external_id: id,
          customer: (rv.querySelector('.reserveItemCustomer')?.textContent || '').replace(/\s*様\s*$/, '').trim(),
          stylist_id: stylistId,
          stylist_name: nameById[stylistId] || null,
          date: get('panel_reserve_date'),
          start: get('panel_reserve_start'),
          registered: get('panel_reserve_registeredFlg'),
          colspan_min: colspanMin,
        });
      }
      return out;
    }).catch(() => []);

    let added = 0;
    for (const it of dayItems) {
      if (!it.external_id || seen.has(it.external_id)) continue;
      seen.add(it.external_id);
      // scheduled_at を JST ISO に組み立てる (date=YYYYMMDD, start=HHMM)。
      let scheduledAt = null;
      if (/^\d{8}$/.test(it.date || '') && /^\d{3,4}$/.test(it.start || '')) {
        const d = it.date;
        const hhmm = it.start.padStart(4, '0');
        scheduledAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+09:00`;
      }
      allRows.push({
        external_id: it.external_id,
        scheduled_at: scheduledAt,
        // 粗い所要 (colspan*30)。後段の enrichDurationsFromDetail で
        // SBの正確な値に上書きされる。取れなければ null のまま。
        duration_min: Number(it.colspan_min) > 0 ? it.colspan_min : null,
        customer_name: cleanText(it.customer) || null,
        customer_code: null,
        customer_phone: null,
        customer_email: null,
        customer_birthday: null,
        menu_name: null,
        amount: null,
        status: it.registered === '1' ? 'completed' : null,
        staff_name: cleanText(it.stylist_name) || null,
        staff_external_id: it.stylist_id && it.stylist_id !== '0000000000' ? it.stylist_id : null,
      });
      added++;
    }
    if (added > 0) diag.push(`hair ${ymd}: ${added}件`);

    // SB「残り受付可能数」(店舗全体×時間枠) を取得。#limitSchedule の td#surplus_HHMM の値と
    // 合計予約数 #tm_reserve_HHMM。集計欄が視覚的に隠れていても DOM(thead)には在るので抽出可。
    const dayAccept = await page.evaluate(() => {
      const num = (s) => { const n = parseInt(String(s == null ? '' : s).trim(), 10); return Number.isFinite(n) ? n : null; };
      const out = [];
      for (const td of Array.from(document.querySelectorAll('tr#limitSchedule td[id^="surplus_"]'))) {
        const hhmm = (td.id || '').replace('surplus_', '');
        if (!/^\d{4}$/.test(hhmm)) continue;
        out.push({
          hhmm,
          remaining: num((td.querySelector('p') || {}).textContent),
          reserved: num((document.getElementById('tm_reserve_' + hhmm) || {}).textContent),
        });
      }
      return out;
    }).catch(() => []);
    for (const a of dayAccept) {
      const sm = parseInt(a.hhmm.slice(0, 2), 10) * 60 + parseInt(a.hhmm.slice(2, 4), 10);
      if (!Number.isFinite(sm)) continue;
      allAcceptance.push({
        date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        slot_min: sm,
        sb_remaining: a.remaining,
        sb_reserved: a.reserved,
      });
    }
    if (dayAccept.length > 0) diag.push(`hair ${ymd}: 受付可能数 ${dayAccept.length}枠`);

    // 日付めくりの間隔を一定にしない (人手の操作に近づける/BAN回避)。
    // ユーザー要望でテンポを上げる: 0.3〜1.2秒(中央 約0.7秒)。三角分布気味で
    // 値が揃いすぎないようにする。最終日(これ以上めくらない)は待たない。
    if (i < MAX_DAYS - 1) {
      const r = (Math.random() + Math.random()) / 2; // 0..1, 0.5中心
      const waitMs = Math.round(300 + r * 900); // 300〜1200ms
      await page.waitForTimeout(waitMs).catch(() => {});
    }
  }

  // 所要の確定: 美容室スケジュールの colspan は 30分刻みの粗い目安なので
  // (75分が60/90に化ける)、予約変更フォームから SB の正確な所要を読み直す。
  // Akamai 対策で maxOpen 件まで・人手風待機つき。取りこぼしは次回 sync に回す。
  let durationFixedDetail = 0;
  try {
    // ★#3 ADERスループット: 所要補正は「近日予約を優先(soonest-first)」で開き、
    //   件数(maxOpen)と時間(budgetMs)で打ち切る。所要は一度確定すれば変わらないので、
    //   毎回全件(~120)の detail を開いていた分がADER 1店 fetch を~25分に膨らませ、
    //   グループ直列(4店)で鯖江が枯渇する主因だった。手前を確実に取れば実害は無い。
    // ★予約書込3分SLA最優先化(2026-07-17): 所要補正(detail 1件ずつ開く)は fetch を数分伸ばし、
    //   同一アカウントのlaneを長く塞いで push_booking を遅延させる主因。予算を大幅短縮して
    //   fetch を短時間で終わらせ、レーンを早く空ける(所要は best-effort、取りこぼしは次回)。
    durationFixedDetail = await enrichDurationsFromDetail(page, allRows, baseUrl, {
      onlyNull: false,
      maxOpen: Number(process.env.SB_ENRICH_MAX_OPEN ?? 20),
      budgetMs: Number(process.env.SB_ENRICH_BUDGET_MS ?? 25_000),
      abortSignal: opts.abortSignal,
    });
    diag.push(`duration補正(detail): ${durationFixedDetail} 件`);
  } catch (e) {
    diag.push(`duration補正(detail) 失敗: ${e?.message ?? e}`);
  }

  diag.push(`hair: covered ${coveredDates.length}日 / incomplete ${incompleteDates.length}日`);

  return {
    rows: allRows,
    // SB「残り受付可能数」スナップショット (表示用)。covered日のみ含む。
    acceptance: allAcceptance,
    debug: {
      itemsFound: allRows.length,
      genre: 'hair',
      source: 'salonSchedule',
      durationFixedDetail,
      range: `${range.fromStr} 〜 ${range.toStr}`,
      // ★#1: 完全取得できた日数/取りこぼした日数。incomplete>0 は要注意(再取得推奨)。
      coveredDays: coveredDates.length,
      incompleteDays: incompleteDates.length,
      incompleteDates: incompleteDates.slice(0, 30),
      acceptanceSlots: allAcceptance.length,
      diag,
    },
  };
}

/** (旧) 美容室の予約一覧SPAをcaptureするだけの実装。スケジュール方式に置換済み。未使用。 */
async function _scrapeHairBookingsLegacy(page, opts = {}) {
  const range = opts.range || defaultBookingDateRange(3);
  const diag = opts.diag || [];
  const slashFrom = range.fromStr.replace(/-/g, '/');
  const slashTo = range.toStr.replace(/-/g, '/');
  const ymdFrom = range.fromStr.replace(/-/g, '');
  const ymdTo = range.toStr.replace(/-/g, '');

  // 1) 来店日の範囲を入力する。hair フォームは日付欄の name/id が不明なため、
  //    「日付らしい input を上から2つ (from/to)」に値を入れる防御的実装。
  //    hidden の yyyymmdd 系と表示用 text の両方に対応する。
  await page.evaluate(
    ({ slashFrom, slashTo, ymdFrom, ymdTo }) => {
      function setVal(el, v) {
        if (!el) return false;
        try {
          el.removeAttribute('readonly');
          el.removeAttribute('disabled');
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        } catch (_e) {
          return false;
        }
      }
      // 日付っぽい input を name/id/value から推定
      const inputs = Array.from(document.querySelectorAll('input'));
      const dateLike = inputs.filter((i) => {
        const key = ((i.name || '') + (i.id || '')).toLowerCase();
        return /date|ymd|rsv.*date|visit|raiten|来店/.test(key) || /^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(i.value || '') || /^\d{8}$/.test(i.value || '');
      });
      // hidden(yyyymmdd) と text(yyyy/mm/dd) を可能な範囲で両方埋める
      const hiddens = dateLike.filter((i) => i.type === 'hidden' || /^\d{8}$/.test(i.value || ''));
      const texts = dateLike.filter((i) => i.type !== 'hidden');
      if (hiddens[0]) setVal(hiddens[0], ymdFrom);
      if (hiddens[1]) setVal(hiddens[1], ymdTo);
      if (texts[0]) setVal(texts[0], slashFrom);
      if (texts[1]) setVal(texts[1], slashTo);
    },
    { slashFrom, slashTo, ymdFrom, ymdTo },
  ).catch(() => {});

  // 2) 検索前の画面 (検索フォーム) を capture しておく。検索クリックで万一クラッシュ
  //    しても、フォームの DOM だけは確実に残す。
  const capForm = await captureScrapeDebug(page, 'bookings', 'hair_form', {
    diagnostics: { url: page.url(), range: `${slashFrom} 〜 ${slashTo}` },
  }).catch(() => null);
  if (capForm) diag.push(`hair form capture: ${capForm}`);

  // 3) 「検索する」を押す。クリックでフルナビゲーションが起きるため、評価中の
  //    "Execution context destroyed" を避けるよう click 後に確実に待つ。
  try {
    const searchBtn = page
      .locator('a:has-text("検索する"), button:has-text("検索する"), input[type="submit"][value*="検索"], a.mod_btn_76:has-text("検索")')
      .first();
    if ((await searchBtn.count().catch(() => 0)) > 0) {
      await searchBtn.click({ timeout: 8_000 }).catch(() => {});
      // ナビゲーション完了をゆるく待つ (load → networkidle、いずれもタイムアウト無視)。
      await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      await page.waitForTimeout(800);
      diag.push('hair: 検索する クリック');
    } else {
      diag.push('hair: 検索ボタン未検出');
    }
  } catch (e) {
    diag.push(`hair: 検索クリックでエラー: ${e?.message ?? e}`);
  }

  // 4) 結果ページを capture (明細 DOM 確定用)。これがあれば明細セレクタを実装できる。
  const capDir = await captureScrapeDebug(page, 'bookings', 'hair_result', {
    diagnostics: { url: page.url(), range: `${slashFrom} 〜 ${slashTo}` },
  }).catch(() => null);
  if (capDir) diag.push(`hair result capture: ${capDir}`);

  // 5) 取れる範囲で明細抽出 (汎用: 行に来店日時/顧客名/予約番号 B... があるテーブルを探す)。
  const items = await page.evaluate(() => {
    const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = 0;
    for (const t of tables) {
      const body = txt(t);
      // 予約番号 (B########) や 来店日らしさでスコアリング
      const score =
        (/(B\d{6,})/.test(body) ? 5 : 0) +
        (t.querySelectorAll('tr').length > 2 ? 2 : 0) +
        (/来店|予約|お客様|スタイリスト/.test(body) ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (!best || bestScore < 5) return { rows: [], reason: `no_result_table(best=${bestScore})` };
    const out = [];
    for (const tr of Array.from(best.querySelectorAll('tr'))) {
      const rowText = txt(tr);
      const idm = rowText.match(/B\d{6,}/);
      if (!idm) continue; // 予約番号を持つ行だけ
      const link = tr.querySelector('a[href*="reservation"], a[href*="detail" i]');
      out.push({
        external_id: idm[0],
        row_text: rowText,
        link_href: link ? link.getAttribute('href') : null,
      });
    }
    return { rows: out, reason: out.length ? 'ok' : 'no_rows_with_id' };
  }).catch((e) => ({ rows: [], reason: `eval_error:${e?.message ?? e}` }));

  diag.push(`hair extract: ${items.reason} (${items.rows.length}行)`);

  // 現状は external_id (予約番号) と行テキストのみ。日時/顧客などの正規化は
  // hair_result capture の DOM 確定後に実装する。最低限 external_id があれば
  // sendBookings は通る (詳細項目は後続で埋める)。
  const rows = items.rows
    .filter((r) => r.external_id)
    .map((r) => ({
      external_id: r.external_id,
      scheduled_at: null,
      duration_min: null,
      customer_name: null,
      customer_code: null,
      customer_phone: null,
      customer_email: null,
      customer_birthday: null,
      menu_name: null,
      amount: null,
      status: null,
      staff_name: null,
    }));

  return {
    rows,
    debug: {
      itemsFound: rows.length,
      genre: 'hair',
      range: `${range.fromStr} 〜 ${range.toStr}`,
      diag,
    },
  };
}

async function scrapeBookings(page, opts = {}) {
  const months = Number.isFinite(opts.months) ? opts.months : 3;
  // opts.range ({fromStr,toStr}) 指定時はそれを優先 (reserveId回収の対象日1日スクレイプ等)。
  // 従来は無視して常に defaultBookingDateRange だったため、未来日(例 8/28)の登録直後の
  // 回収が「直近3ヶ月」を嘗めて対象日に届かず reserveId を取りこぼしていた。
  const range = (opts.range && opts.range.fromStr && opts.range.toStr)
    ? opts.range
    : defaultBookingDateRange(months);
  const diag = [];

  // グループアカウント(1ログイン複数サロン)はログイン直後 /CNC/groupTop/ (サロン一覧)に
  // 居る。対象サロンを選んで店舗文脈(/CLP/bt/)に入ってから取得する。未選択のまま
  // /CLP/bt/schedule/ を開くと session_expired になる(実機 2026-06-28: ADER鯖江=グループ hair)。
  // 単一店舗(salonId/shopName無し、または groupTop 非該当)では ensureSalonSelected が no-op。
  if (opts.salonId || opts.shopName) {
    // グループアカウントはログイン後 warmup(/KLP/top/)に飛ぶとサロン未選択のため
    // session_expired になる(実機 2026-06-28: ADER鯖江)。warmup 後はページが groupTop で
    // ないので ensureSalonSelected が no-op になってしまう。明示的に /CNC/groupTop/ へ行き、
    // 対象サロンを選んで /CLP/bt/ 文脈を確立してから取得する。単一店(salonId無し)は到達しない。
    try {
      await page.goto(
        new URL('/CNC/groupTop/', opts.baseUrl || 'https://salonboard.com/').toString(),
        { waitUntil: 'domcontentloaded', timeout: 25_000 },
      );
    } catch (_e) {
      /* groupTop 到達失敗時も ensureSalonSelected が現状を判定して理由を返す */
    }
    const sel = await ensureSalonSelected(page, {
      salonId: opts.salonId,
      shopName: opts.shopName,
    }).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
    diag.push(`salon-select: ${JSON.stringify(sel)}`);
    console.log(`[scrape] salon-select ${JSON.stringify(sel)}`);
  }

  // 美容室(hair)はスケジュール画面 (/CLP/bt/schedule/salonSchedule/) から取得する。
  // エステ用の予約一覧フロー(reserveList navigation/検索/抽出)は通さない。
  if (opts.genre === 'hair') {
    try {
      return await scrapeHairBookings(page, {
        range, diag, baseUrl: opts.baseUrl,
        // 失効時の自己回復(relogin)後にサロンを選び直すため salonId/shopName も渡す。
        salonId: opts.salonId, shopName: opts.shopName, relogin: opts.relogin,
        abortSignal: opts.abortSignal,
      });
    } catch (e) {
      // ★preemption の abort は握りつぶさず伝播させる(worker が requeue する)。
      if (opts.abortSignal && opts.abortSignal.aborted) throw e;
      if (/aborted: preempted/.test(String(e?.message ?? e))) throw e;
      const capDir = await captureScrapeDebug(page, 'bookings', 'hair_scrape_error', {
        diagnostics: { url: page.url(), error: e?.message ?? String(e) },
      }).catch(() => null);
      diag.push(`hair scrape error: ${e?.message ?? e} (capture=${capDir || '?'})`);
      return { rows: [], debug: { itemsFound: 0, genre: 'hair', diag } };
    }
  }

  // ===== ここから下はエステ等(非hair)の従来フロー。変更しないこと =====
  // (美容室(hair)は関数冒頭で scrapeHairBookings に分岐済み)
  // reserveList/init はクラウド(プロキシ経由)だと、住宅IPの一時的なドロップで
  // ERR_TUNNEL_CONNECTION_FAILED、または Level3 IP だと Akamai tarpit(無応答)に
  // なることがある。トンネル切れ/タイムアウトは一過性のことが多いので最大5回張り直す
  // (1〜2回目は domcontentloaded、3回目以降は応答ヘッダ受信で足る commit に緩める)。
  // 全滅したら throw(ジョブはさらに上位でリトライされる)。
  {
    let _ok = false;
    let _lastErr = '';
    for (let _try = 1; _try <= 5 && !_ok; _try++) {
      const _t0 = Date.now();
      try {
        await page.goto(RESERVE_LIST_URL, {
          waitUntil: _try >= 3 ? 'commit' : 'domcontentloaded',
          timeout: 30_000,
        });
        _ok = true;
        console.log(`[scrape] reserveList ok try ${_try} ${Date.now() - _t0}ms url=${page.url()}`);
      } catch (e) {
        _lastErr = String((e && e.message) || e).split('\n')[0];
        console.log(`[scrape] reserveList try ${_try} FAIL ${Date.now() - _t0}ms: ${_lastErr.slice(0, 90)}`);
        await page.waitForTimeout(3000);
      }
    }
    if (!_ok) throw new Error(`reserveList unreachable after 5 tries: ${_lastErr}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // 予約一覧に到達できているかの即時診断 (検出0 の原因切り分け用)。
  // landing が login / 空ページ / interstitial だと search 以前に分かる。
  try {
    const landing = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      inputs: document.querySelectorAll('input').length,
      tables: document.querySelectorAll('table').length,
      hasPw: !!document.querySelector('input[type="password"]'),
      hasResultList: !!document.getElementById('resultList'),
      bodyHead: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }));
    diag.unshift(
      `landing: url=${landing.url} title="${landing.title}" inputs=${landing.inputs} tables=${landing.tables} ` +
      `pw=${landing.hasPw} resultList=${landing.hasResultList} body="${landing.bodyHead}"`,
    );
    // ログイン画面に飛ばされている / 予約一覧の検索欄(resultList)が無い → 早期 capture
    if (landing.hasPw || landing.inputs === 0) {
      const capDir = await captureScrapeDebug(page, 'bookings', 'landing_not_reservelist', {
        secrets: [opts.loginId, opts.password].filter(Boolean),
        diagnostics: landing,
      });
      if (capDir) diag.unshift(`landing capture: ${capDir}`);
    }
  } catch (_e) {
    /* 診断失敗は本処理を止めない */
  }

  // (美容室(hair)は関数冒頭で scrapeHairBookings に分岐済み)

  // 検索フォームに日付範囲を入れて検索を実行 (これが無いと結果が出ない)
  const searched = await applyBookingDateFilter(page, range, { diag });
  diag.unshift(`searched: ${searched}`);

  // 表示件数のセレクトボックスがあれば最大値にする (1 ページで全件取得)
  try {
    const pageSizeChanged = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const results = [];
      for (const sel of selects) {
        const labelText =
          (sel.previousElementSibling?.textContent || '') +
          (sel.parentElement?.textContent || '');
        const name = sel.name || sel.id || '';
        // ラベル/name のどちらかが件数系なら対象
        if (
          /件数|表示件数|表示数|表示件/.test(labelText) ||
          /list.*count|page.*size|disp.*count|count|limit/i.test(name)
        ) {
          // 最大の数値オプションを選ぶ
          const opts = Array.from(sel.options);
          const numericOpts = opts
            .map((o) => ({ o, v: Number(o.value) || Number(o.text.replace(/\D/g, '')) }))
            .filter((x) => Number.isFinite(x.v) && x.v > 0);
          if (numericOpts.length === 0) continue;
          numericOpts.sort((a, b) => b.v - a.v);
          sel.value = numericOpts[0].o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ name, value: numericOpts[0].o.value });
        }
      }
      return results;
    });
    if (pageSizeChanged && pageSizeChanged.length > 0) {
      diag.push(
        `page sizes -> ${pageSizeChanged.map((p) => `${p.name}=${p.value}`).join(', ')}`,
      );
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      // 件数を変えたら再検索が必要なフォームもあるので、もう一度「検索する」を押す
      const reSearch = page
        .locator('a:has-text("検索する"), a.common-CNCcommon__primaryBtn:has-text("検索")')
        .first();
      if ((await reSearch.count()) > 0) {
        try {
          await Promise.all([
            page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
            reSearch.click({ timeout: 3000 }),
          ]);
          await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
          diag.push('re-searched after page size change');
        } catch (_e) {
          /* ignore */
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }

  // ページネーション: 各ページの items を集める。1000 件 / 30件ページなら 34 ページ、
  // 安全マージンで 60 ページまで辿る。
  const allItems = [];
  const MAX_PAGES = 60;
  const visitedPageHashes = new Set();
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    // ★preemption: 予約書込が来たら fetch を即中断してレーンを譲る(3分SLA)。
    if (opts.abortSignal && opts.abortSignal.aborted) throw new Error('aborted: preempted by booking write');
    const items = await extractBookingItemsFromCurrentPage(page);
    allItems.push(...items);
    diag.push(`page ${pageNum}: ${items.length} rows`);
    // 1 ページ目が 0 件のときは、原因切り分け用に DOM 診断を出す。
    if (pageNum === 1 && items.length === 0 && lastBookingExtractDiag) {
      const d = lastBookingExtractDiag;
      diag.push(`extract diag: ${d.reason ?? '?'}`);
      if (d.tableDiag?.length) diag.push(`tables: ${d.tableDiag.join(' ')}`);
      if (d.reserveAreaHtml) diag.push(`reserveArea html: ${d.reserveAreaHtml.replace(/\s+/g, ' ').slice(0, 600)}`);
    }

    // 同じページに留まり続けるのを避けるため、簡易ハッシュで判定
    const sig = items
      .slice(0, 3)
      .map((it) => it.row_text?.slice(0, 60) || '')
      .join('|');
    if (visitedPageHashes.has(sig)) {
      diag.push(`page ${pageNum}: loop detected, stop`);
      break;
    }
    visitedPageHashes.add(sig);

    // ページ送り: まず「次へ」リンクの href (changePage?pn=N) を読んで直接 GET する。
    // クリック方式は waitForLoadState の即解決レースや href="#" の番号リンクが
    // 効かないケースがあり、同一ページを重複取得→ループ誤検知で打ち切られていた。
    let advanced = false;
    const onKnownResultPage = /\/reserveList\/(search|changePage)/.test(page.url());
    try {
      const nextHref = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="changePage"]'));
        const next = links.find((a) => /次へ/.test((a.textContent || '').trim()));
        return next ? next.getAttribute('href') : null;
      });
      if (nextHref) {
        const nextUrl = new URL(nextHref, page.url()).toString();
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page
          .waitForSelector('#resultList, table.reserveSearchResultTable', { timeout: 10_000 })
          .catch(() => {});
        advanced = true;
        diag.push(`page ${pageNum}: goto ${nextHref}`);
      } else if (onKnownResultPage) {
        // 既知の結果ページで「次へ」が無い = 最終ページ。クリック式フォールバックに
        // 落とすと「次の月」(カレンダーの月送り) や月番号リンク (1〜12, href="#") を
        // 誤クリックして同一結果を重複取得→ループ誤検知になるため、ここで終了する。
        diag.push(`page ${pageNum}: no 次へ link, last page`);
        break;
      }
    } catch (e) {
      diag.push(`page ${pageNum}: next goto failed (${e?.message ?? e})`);
    }

    // フォールバック: 「次へ」 / ">" / 「次のページ番号」をクリックで辿る
    const nextSelectors = [
      'a:has-text("次へ"):not(.disabled)',
      'a:has-text("次"):not(:has-text("次回"))',
      'a[onclick*="next" i]',
      'a[rel="next"]',
      'li.pagerNext a',
      'a.pagerNext',
      // ページ番号リンクで「次の番号」を探す → 後段の JS で
    ];
    for (const sel of nextSelectors) {
      if (advanced) break;
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
          loc.click({ timeout: 3000 }),
        ]);
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
        advanced = true;
        break;
      } catch (_e) {
        /* try next */
      }
    }

    if (!advanced) {
      // 数字のページ番号リンクで「現在ページ + 1」を JS で探す
      const jumped = await page.evaluate((next) => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          const t = (a.textContent || '').trim();
          if (t === String(next)) {
            a.click();
            return true;
          }
        }
        return false;
      }, pageNum + 1);
      if (jumped) {
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
        advanced = true;
        diag.push(`page ${pageNum}: jumped to ${pageNum + 1} via number link`);
      }
    }
    if (!advanced) break;
  }

  // 検出0 (検索フォーム未検出 or 結果0) のときは、実際にどの画面にいたかを capture。
  // ログイン後に予約一覧へ到達できていない (interstitial / 複数タブ警告 / 再ログイン)
  // ケースを目視で特定するため。capture 先を diag に残す。
  if (!searched || allItems.length === 0) {
    const capDir = await captureScrapeDebug(page, 'bookings', 'no_results', {
      secrets: [opts.loginId, opts.password].filter(Boolean),
      diagnostics: { searched, itemsFound: allItems.length, url: page.url() },
    });
    if (capDir) diag.push(`debug capture: ${capDir}`);
  }

  // パース
  const rows = [];
  let skipped = 0;
  const sampleSkipped = [];
  for (const it of allItems) {
    const scheduled_at = parseJstDateTime(it.datetime_raw);
    if (!scheduled_at) {
      skipped++;
      if (sampleSkipped.length < 3) sampleSkipped.push(it.datetime_raw || '(空)');
      continue;
    }
    const external_id =
      extractIdFromUrl(it.link_href, 'reservationId', 'reserveId', 'rsvId') ||
      `${it.datetime_raw}|${it.customer_raw}`.replace(/\s+/g, '_');
    const status = mapBookingStatus(it.status_raw);
    rows.push({
      external_id,
      scheduled_at,
      duration_min: parseMinutes(it.duration_raw),
      customer_name: cleanText(it.customer_raw),
      customer_code: extractCustomerCode(it.customer_raw) || extractCustomerCode(it.row_text),
      customer_phone: null,
      customer_email: null,
      customer_birthday: null,
      menu_name: cleanText(it.menu_raw),
      amount: parseYen(it.amount_raw),
      status,
      staff_name: cleanText(it.staff_raw),
      staff_external_id: it.staff_external_id ?? null,
      equipment_external_id: it.equipment_external_id ?? null,
      equipment_name: cleanText(it.equipment_name) || null,
      reservation_route: cleanText(it.route_raw) || null,
      payment_method_label: cleanText(it.payment_raw) || null,
      coupon_name: cleanText(it.coupon_raw) || null,
      notes: null,
    });
  }
  // 終了時刻(所要時間)の補正:
  // 予約一覧には終了時刻が無く duration が取れない。スケジュール画面の
  // scheduleTimeZoneSetting [開始,終了] から、各日・各スタッフ列の予約ブロックを
  // 取得し、(同日+同開始時刻+同スタッフ) が一意なものだけ duration_min を補正する。
  let durationFixed = 0;
  try {
    durationFixed = await enrichDurationsFromSchedule(page, rows, opts.baseUrl);
    diag.push(`duration補正(schedule): ${durationFixed} 件`);
  } catch (e) {
    diag.push(`duration補正(schedule) 失敗: ${e?.message ?? e}`);
  }

  // スケジュール補正でも所要が取れなかった行 (重複で一意に決まらない等) は、
  // 予約変更フォームから「SBが保持する正確な所要」を 1 件ずつ読んで確定させる。
  // これをしないと duration_min=null のまま DB に渡り、60分で上書きされる。
  let durationFixedDetail = 0;
  try {
    durationFixedDetail = await enrichDurationsFromDetail(page, rows, opts.baseUrl, {
      maxOpen: Number(process.env.SB_ENRICH_MAX_OPEN ?? 20),
      budgetMs: Number(process.env.SB_ENRICH_BUDGET_MS ?? 25_000),
      abortSignal: opts.abortSignal,
    });
    diag.push(`duration補正(detail): ${durationFixedDetail} 件`);
  } catch (e) {
    diag.push(`duration補正(detail) 失敗: ${e?.message ?? e}`);
  }
  const stillNull = rows.filter(
    (r) => r.status !== 'cancelled' && !(Number(r.duration_min) > 0),
  ).length;
  if (stillNull > 0) diag.push(`duration未確定(残): ${stillNull} 件`);

  // ★SB上の実際の設備(ベッド)を予約詳細の「設備」行から取得する (2026-07-11 向井さん指摘)。
  //   HotPepper 予約はメールに席情報が無く、一覧にも設備列が無いため、KD側が自動割当していた。
  //   → 予約詳細ページ(予約情報テーブルの「設備」行=「ベッド１ 14:30〜15:45」)から読む。
  //   全件は重いので「未来 & 設備未取得」を近い順に最大 cap 件だけ。数回のfetchで backfill。
  let equipFixed = 0;
  try {
    equipFixed = await enrichEquipmentFromDetail(page, rows, opts.baseUrl, {
      cap: 25, genre: opts.genre, salonId: opts.salonId, shopName: opts.shopName,
    });
    diag.push(`設備取得(detail): ${equipFixed} 件`);
  } catch (e) {
    diag.push(`設備取得(detail) 失敗: ${e?.message ?? e}`);
  }

  return {
    rows,
    debug: {
      itemsFound: allItems.length,
      parsed: rows.length,
      skipped,
      sampleSkipped,
      durationFixed,
      durationFixedDetail,
      equipFixed,
      durationStillNull: stillNull,
      range: `${range.fromStr} 〜 ${range.toStr}`,
      diag,
    },
  };
}

/**
 * スケジュール画面から各予約の [開始,終了] を取得し、rows の duration_min を補正する。
 * マッチングキー: 日付(YYYYMMDD) + 開始HHMM + スタッフ(external_id or 表示名)。
 * 同キーのスケジュールブロックが一意なものだけ補正 (誤補正を避ける)。
 * @returns 補正した件数
 */
async function enrichDurationsFromSchedule(page, rows, baseUrl) {
  const base = baseUrl || 'https://salonboard.com/';
  if (!rows || rows.length === 0) return 0;

  // rows から対象日付 (JST) を集める
  const datesNeeded = new Set();
  for (const r of rows) {
    const jst = new Date(Date.parse(r.scheduled_at) + 9 * 3600_000);
    const ymd = `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}`;
    datesNeeded.add(ymd);
  }
  // 暴走防止 (最大 40 日分)
  const dates = Array.from(datesNeeded).slice(0, 40);

  // 日付 -> [{ staffExt, staffName, customer, startHHMM, endMin, startMin }]
  const byDate = new Map();
  for (const ymd of dates) {
    try {
      const u = new URL('/KLP/schedule/salonSchedule/', base);
      u.searchParams.set('date', ymd);
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      const blocks = await page.evaluate(() => {
        const out = [];
        // スタッフ列ヘッダの external_id 順
        const heads = Array.from(document.querySelectorAll('.scheduleMainHead[id^="STAFF_"]'))
          .map((el) => {
            const m = (el.id || '').match(/^STAFF_([A-Z0-9]+)_/i);
            return {
              ext: m ? m[1].toUpperCase() : null,
              name: (el.querySelector('.scheduleLink')?.getAttribute('title') || el.textContent || '').trim(),
            };
          });
        // スタッフ側テーブルの各 line (= スタッフ列順)
        const staffTable = document.querySelector('.jscScheduleMainTableStaff');
        if (!staffTable) return out;
        const lines = Array.from(staffTable.querySelectorAll('.scheduleMainTableLine'));
        lines.forEach((line, i) => {
          const head = heads[i] || { ext: null, name: null };
          const resvs = Array.from(line.querySelectorAll('.scheduleReservation'));
          for (const rv of resvs) {
            const tzEl = rv.querySelector('.scheduleTimeZoneSetting');
            const nameEl = rv.querySelector('.scheduleReserveName');
            const tz = tzEl ? (tzEl.textContent || '') : '';
            const m = tz.match(/"(\d{1,2}):(\d{2})"\s*,\s*"(\d{1,2}):(\d{2})"/);
            if (!m) continue;
            out.push({
              staffExt: head.ext,
              staffName: (head.name || '').replace(/\s*様$/, '').trim(),
              customer: (nameEl?.getAttribute('title') || nameEl?.textContent || '').replace(/\s*様$/, '').trim(),
              startMin: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
              endMin: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
              startHHMM: `${m[1].padStart(2, '0')}:${m[2]}`,
            });
          }
        });
        return out;
      });
      byDate.set(ymd, blocks);
    } catch (_e) {
      // この日付は補正できないだけ。続行。
    }
  }

  // rows を補正
  let fixed = 0;
  for (const r of rows) {
    const jst = new Date(Date.parse(r.scheduled_at) + 9 * 3600_000);
    const ymd = `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}`;
    const startMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    const blocks = byDate.get(ymd);
    if (!blocks || blocks.length === 0) continue;

    const rowStaffExt = (r.staff_external_id || '').toUpperCase();
    const rowStaffName = (r.staff_name || '').replace(/\s*様$/, '').replace(/^\(.*?\)/, '').trim();

    // 同開始時刻のブロックに絞る
    let cands = blocks.filter((b) => b.startMin === startMin);
    // スタッフで絞る (external_id 優先、無ければ表示名で部分一致)
    if (rowStaffExt) {
      const byExt = cands.filter((b) => b.staffExt === rowStaffExt);
      if (byExt.length) cands = byExt;
    } else if (rowStaffName) {
      const byName = cands.filter((b) => b.staffName && (b.staffName === rowStaffName || b.staffName.includes(rowStaffName) || rowStaffName.includes(b.staffName)));
      if (byName.length) cands = byName;
    }
    // さらに顧客名で絞れるなら絞る (一意性を上げる)
    const rowCust = (r.customer_name || '').replace(/\s*様$/, '').trim();
    if (cands.length > 1 && rowCust) {
      const byCust = cands.filter((b) => b.customer && (b.customer === rowCust || b.customer.includes(rowCust) || rowCust.includes(b.customer)));
      if (byCust.length) cands = byCust;
    }

    // 一意に決まったものだけ補正
    if (cands.length === 1) {
      const dur = cands[0].endMin - cands[0].startMin;
      if (dur > 0 && dur <= 24 * 60) {
        r.duration_min = dur;
        fixed++;
      }
    }
  }
  return fixed;
}

/**
 * 予約詳細(変更フォーム)から「正確な所要時間」を読む。
 *
 * 背景: 予約一覧には終了時刻/所要が無く、スケジュール画面からの補正
 * (enrichDurationsFromSchedule) も「同日+同開始+同スタッフが一意」のときしか
 * 効かない (重複したら null のまま)。null のまま DB に渡すと
 * salonboard_bulk_upsert_bookings が 60 分で上書きし、75分等の予約が
 * 1時間に潰れる。
 *
 * SB の変更フォーム (/KLP/reserve/ext/extReserveChange/?reserveId=...,
 * ネット予約は net/reserveChange) は、登録フォームと同じ
 *   <select id="jsiRsvTermHour">  … value は「分換算」(60=1時間, 120=2時間)
 *   <select id="jsiRsvTermMinute"> … 端数の分 (00/15/30/45 等)
 * が「SBが保持している正確な値」で selected された状態で開く。
 * これを読めば 75分(termHour=60 + termMinute=15)も確実に取れる。
 *
 * Akamai Bot Manager 対策のため:
 *   - duration_min が未確定 (null) の行だけ開く (全件は開かない)。
 *   - 1件ごとに人手風のランダム待機 (0.4〜1.1秒) を挟む。
 *   - 上限件数 (maxOpen) を超えたら打ち切る (取りこぼしは次回 sync に回す)。
 *   - external_id が reserveId 形式 (英大文字+数字) の行のみ対象。
 *
 * @param {import('playwright').Page} page
 * @param {Array} rows scrapeBookings/scrapeHairBookings が組んだ行 (破壊的に補正)
 * @param {string} baseUrl
 * @param {{ maxOpen?: number, onlyNull?: boolean }} [options]
 * @returns {Promise<number>} 補正した件数
 */
async function enrichDurationsFromDetail(page, rows, baseUrl, options = {}) {
  const base = baseUrl || 'https://salonboard.com/';
  if (!rows || rows.length === 0) return 0;
  const onlyNull = options.onlyNull !== false; // 既定: null の行だけ
  const maxOpen = Number.isFinite(options.maxOpen) ? options.maxOpen : 120;
  // ★#3: 経過時間で打ち切る上限 (ms)。0/未指定なら時間制限なし(従来動作)。
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : 0;
  const startTs = Date.now();

  // 対象: duration_min が未確定 (null/0/NaN) で、reserveId 形式の external_id を持つ行。
  // status が cancelled の行は所要が要らない (画面表示にも使わない) ので除外。
  const isReserveId = (s) => typeof s === 'string' && /^[A-Z]{1,4}\d{4,}$/.test(s.trim());
  const targets = rows.filter((r) => {
    if (r.status === 'cancelled') return false;
    if (!isReserveId(r.external_id)) return false;
    if (!onlyNull) return true;
    const d = Number(r.duration_min);
    return !Number.isFinite(d) || d <= 0;
  });
  if (targets.length === 0) return 0;

  // ★#3: 近日予約を優先して所要を確定させる。件数/時間で打ち切られても
  //   カレンダー上で重要な手前の予約は確実に正確な所要になる。遠い先の予約は
  //   粗い colspan のまま残り、日が近づいた次回以降の fetch で確定される。
  targets.sort((a, b) =>
    String(a.scheduled_at || '9').localeCompare(String(b.scheduled_at || '9')),
  );

  let fixed = 0;
  let opened = 0;
  for (const r of targets) {
    if (opened >= maxOpen) break;
    if (budgetMs > 0 && Date.now() - startTs > budgetMs) break;
    // ★preemption: 予約書込が来たら所要補正を即打切る(所要は best-effort、次回に回す)。
    if (options.abortSignal && options.abortSignal.aborted) break;
    opened++;
    const reserveId = r.external_id.trim();
    // ext (電話/外部) → net (ネット予約) の順で変更フォームを開く。
    const candidates = [
      `/KLP/reserve/ext/extReserveChange/?reserveId=${reserveId}`,
      `/KLP/reserve/net/reserveChange/?reserveId=${reserveId}`,
    ];
    let dur = null;
    for (const path of candidates) {
      try {
        await page.goto(new URL(path, base).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 25_000,
        });
      } catch (_e) {
        continue;
      }
      // 所要 select が出るまで待つ (networkidle は待たない: 高速化)。
      await page
        .waitForSelector('select#jsiRsvTermHour, select#jsiRsvHour', { timeout: 8_000 })
        .catch(() => {});
      dur = await page
        .evaluate(() => {
          const sel = (id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const v = el.value;
            if (v == null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          // termHour の value は「分換算」(60=1時間)。termMinute は端数分。
          const th = sel('jsiRsvTermHour');
          const tm = sel('jsiRsvTermMinute');
          if (th == null && tm == null) return null;
          return (th || 0) + (tm || 0);
        })
        .catch(() => null);
      if (dur != null && dur > 0) break; // 取れたら 2 候補目は開かない
    }
    if (dur != null && dur > 0 && dur <= 24 * 60) {
      r.duration_min = dur;
      fixed++;
    }
    // 人手風の待機 (BAN/Akamai 回避)。最後の行は待たない。
    if (opened < targets.length && opened < maxOpen) {
      const jitter = (Math.random() + Math.random()) / 2; // 0..1 中央0.5
      await page.waitForTimeout(Math.round(400 + jitter * 700)).catch(() => {});
    }
  }
  return fixed;
}

/**
 * 現在表示されているページから予約行を抽出する。
 * scrapeBookings の旧 page.evaluate と同じロジック。
 */
// extractBookingItemsFromCurrentPage が直近で 0 件だったときの診断情報。
// (テーブルが見つからない/行が拾えない原因切り分け用)
let lastBookingExtractDiag = null;

async function extractBookingItemsFromCurrentPage(page) {
  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    /** セルの中身を改行区切りで取り出す (br を \n に置換、複数空白を 1 つに)。 */
    function multilineTxt(el) {
      if (!el) return '';
      const html = el.innerHTML
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li)>/gi, '\n');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      return (tmp.textContent || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n');
    }
    /**
     * 「予約結果テーブル」を 1 つ選ぶ。
     * 検索フォームのレイアウト table を誤って選ばないよう、
     *   - thead/th に「予約番号 / 来店 / 顧客 / お客様」のうち 2 つ以上含む
     *   - tbody tr が 1 行以上ある
     * の両方を満たすテーブルを優先する。
     */
    const tables = Array.from(document.querySelectorAll('table'));
    function score(t) {
      const heads = Array.from(t.querySelectorAll('th, thead td'))
        .map((e) => (e.textContent || '').trim())
        .join(' ');
      let s = 0;
      if (/予約番号|予約No|予約Ｎｏ/.test(heads)) s += 3;
      if (/来店日|来店時間|来店日時|予約日時/.test(heads)) s += 3;
      if (/お客様|顧客|お名前/.test(heads)) s += 2;
      if (/メニュー/.test(heads)) s += 1;
      if (/スタッフ|担当/.test(heads)) s += 1;
      if (/ステータス|状態/.test(heads)) s += 1;
      const bodyRows = t.querySelectorAll('tbody tr, tr').length;
      if (bodyRows < 2) s -= 3;
      // 検索フォームの table を弾く: input / select を含んでいたら大幅減点
      const inputs = t.querySelectorAll('input, select, textarea').length;
      if (inputs > 5) s -= 10;
      return s;
    }
    let target = null;
    let bestScore = 0;
    // 最優先: SalonBoard 予約一覧の固定 ID / クラスを直接狙う。
    // 結果テーブルは <table class="reserveSearchResultTable" id="resultList"> で、
    // 予約行は <tbody id="reserveListArea"> 内。ヘッダー文言のスコアリングに頼ると
    // <br> やレイアウト変更で取りこぼすため、まず ID/クラスで確実に掴む。
    const fixedTarget =
      document.querySelector('#resultList') ||
      document.querySelector('table.reserveSearchResultTable') ||
      (document.querySelector('#reserveListArea')?.closest('table')) ||
      null;
    if (fixedTarget) {
      target = fixedTarget;
      bestScore = 99;
    } else {
      for (const t of tables) {
        const sc = score(t);
        if (sc > bestScore) {
          bestScore = sc;
          target = t;
        }
      }
    }
    if (!target || bestScore < 4) {
      // 結果テーブル無し = 「該当する予約はありません」状態。
      // 診断用に、ページ内テーブルの概況とメインエリアの HTML 断片を返す
      // (0件継続時に実 DOM 構造を確認して原因切り分けするため)。
      const tableDiag = tables.slice(0, 8).map((t) => {
        const cls = (t.className || '').slice(0, 40);
        const id = t.id || '';
        const trs = t.querySelectorAll('tr').length;
        const inputs = t.querySelectorAll('input,select').length;
        return `[id=${id} cls="${cls}" tr=${trs} in=${inputs}]`;
      });
      const reserveAreaHtml =
        (document.querySelector('#reserveListArea')?.outerHTML ||
          document.querySelector('#resultList')?.outerHTML ||
          document.querySelector('[class*="reserveSearch" i]')?.outerHTML ||
          '').slice(0, 800);
      return {
        items: [],
        reason: `no_result_table (best=${bestScore})`,
        tableDiag,
        reserveAreaHtml,
      };
    }

    // 列順を th から推定 (なければ DOM 順)
    const headers = Array.from(target.querySelectorAll('th, thead td')).map((e) =>
      (e.textContent || '').trim(),
    );
    function findCol(...patterns) {
      for (let i = 0; i < headers.length; i++) {
        for (const p of patterns) {
          if (headers[i].includes(p)) return i;
        }
      }
      return -1;
    }
    const idx = {
      datetime: findCol('予約日時', '日時', '来店日'),
      customer: findCol('お客様', '顧客', 'お名前'),
      menu: findCol('メニュー'),
      staff: findCol('スタッフ', '担当'),
      amount: findCol('金額', '料金'),
      duration: findCol('時間', '所要'),
      status: findCol('ステータス', '状態'),
      route: findCol('予約経路', '経路'),
      coupon: findCol('クーポン'),
      payment: findCol('支払'),
      equip: findCol('設備', 'ベッド', '席'),
    };

    // ヘッダーに「日時」列が見つからない場合、データ行を全部走査して
    // 「日付らしい文字列」を含む列番号を多数決で推定する。
    function looksLikeDate(s) {
      return /\d{1,4}[\/年\-月]\d{1,2}[月\/\-]?\d{0,2}/.test(s) || /\d{1,2}:\d{2}/.test(s);
    }
    let datetimeCol = idx.datetime;
    if (datetimeCol < 0) {
      const sample = Array.from(target.querySelectorAll('tbody tr, tr')).slice(0, 8);
      const colHits = {};
      for (const tr of sample) {
        const tds = Array.from(tr.querySelectorAll('td'));
        tds.forEach((td, i) => {
          if (looksLikeDate(txt(td))) {
            colHits[i] = (colHits[i] ?? 0) + 1;
          }
        });
      }
      let best = -1;
      let bestCount = 0;
      for (const [k, v] of Object.entries(colHits)) {
        if (v > bestCount) {
          bestCount = v;
          best = Number(k);
        }
      }
      if (best >= 0) datetimeCol = best;
    }

    const rows = Array.from(target.querySelectorAll('tbody tr, tr'));
    const items = rows
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length === 0) return null;
        // 予約詳細リンクから external_id を取得する。
        // SalonBoard は予約種別でリンクの形が違う:
        //   - ネット予約(BF/BE): /KLP/reserve/net/reserveDetail/?reserveId=BF...
        //   - 電話/外部予約(YG): /KLP/reserve/ext/extReserveDetail/?reserveId=YG...  ← 大文字Rを含む
        // CSS の [href*="reserveDetail"] は **大文字小文字を区別する**ため
        // extReserveDetail(大文字R) にマッチせず、先頭の salonSchedule リンクを
        // 誤って拾って external_id がフォールバックになっていた。
        // → reserveId= を持つリンクを最優先で全 a から探す (チャート/スケジュール除外)。
        const anchors = Array.from(tr.querySelectorAll('a[href]'));
        const link =
          anchors.find((a) => /reserveId=/i.test(a.getAttribute('href') || '')) ||
          anchors.find((a) => /reserveDetail|reservation/i.test(a.getAttribute('href') || '')) ||
          anchors.find((a) => !/salonSchedule|\/charts\//i.test(a.getAttribute('href') || '')) ||
          anchors[0] ||
          null;
        // セルごとに multiline 文字列 (改行区切り) を取り出す
        const cells = tds.map(multilineTxt);
        const rowText = cells.join('\n');

        // 日時カラム: 列指定があればそこ、無ければ全セルから日付パターンを含むものを採用
        let datetimeRaw = datetimeCol >= 0 ? cells[datetimeCol] : '';
        if (!datetimeRaw || !looksLikeDate(datetimeRaw)) {
          for (const c of cells) {
            if (looksLikeDate(c)) {
              datetimeRaw = c;
              break;
            }
          }
        }

        // 顧客名: 「ゲスト」「(名前)」を含む or 顧客コードを含む列を探す。
        // 列インデックスが分かっていればそれを使い、ダメなら行全体から推定。
        let customerRaw = idx.customer >= 0 ? cells[idx.customer] : '';
        if (!customerRaw) {
          for (const c of cells) {
            if (/(ゲスト|YG\d+|お名前|様)/.test(c) && !looksLikeDate(c)) {
              customerRaw = c;
              break;
            }
          }
        }

        // スタッフセル内のリンクから W001xxx 等の外部 ID を拾う
        let staffExtId = null;
        if (idx.staff >= 0 && tds[idx.staff]) {
          const staffLinks = Array.from(
            tds[idx.staff].querySelectorAll('a[href]'),
          );
          for (const sl of staffLinks) {
            const href = sl.getAttribute('href') || '';
            const m =
              href.match(/(?:staffId|stylistId)=([WNwn]\d{4,})/) ||
              href.match(/([WNwn]\d{6,})/);
            if (m) {
              staffExtId = (m[1] || '').toUpperCase();
              break;
            }
          }
        }
        // 行全体からも保険でサーチ
        if (!staffExtId) {
          const m = rowText.match(/(?:staffId|stylistId)=([WNwn]\d{4,})/);
          if (m) staffExtId = m[1].toUpperCase();
        }

        // 設備(ベッド/席): 一覧に設備列がある店舗のみ拾える(無い店舗が大半)。
        //   セル内リンクの EQ... を最優先、無ければ表示名を拾う。
        let equipExtId = null;
        let equipName = '';
        if (idx.equip >= 0 && tds[idx.equip]) {
          equipName = cells[idx.equip] || '';
          const eqLinks = Array.from(tds[idx.equip].querySelectorAll('a[href]'));
          for (const el of eqLinks) {
            const m = (el.getAttribute('href') || '').match(/(EQ\d{6,})/i);
            if (m) { equipExtId = m[1].toUpperCase(); break; }
          }
          if (!equipExtId) {
            const m = (tds[idx.equip].innerHTML || '').match(/(EQ\d{6,})/i);
            if (m) equipExtId = m[1].toUpperCase();
          }
        }

        return {
          datetime_raw: datetimeRaw,
          customer_raw: customerRaw,
          menu_raw: idx.menu >= 0 ? cells[idx.menu] : '',
          staff_raw: idx.staff >= 0 ? cells[idx.staff] : '',
          staff_external_id: staffExtId,
          amount_raw: idx.amount >= 0 ? cells[idx.amount] : '',
          duration_raw: idx.duration >= 0 ? cells[idx.duration] : '',
          status_raw: idx.status >= 0 ? cells[idx.status] : '',
          route_raw: idx.route >= 0 ? cells[idx.route] : '',
          coupon_raw: idx.coupon >= 0 ? cells[idx.coupon] : '',
          payment_raw: idx.payment >= 0 ? cells[idx.payment] : '',
          equipment_external_id: equipExtId,
          equipment_name: equipName,
          link_href: attr(link, 'href'),
          row_text: rowText,
          headers_debug: headers,
        };
      })
      .filter(Boolean);
    return { items };
  });
  // 0 件時の診断情報をモジュール変数に保持 (呼び出し元がログ出力に使う)。
  // 既存の戻り値 (配列) は変えないので後方互換。
  lastBookingExtractDiag =
    (raw.items ?? []).length === 0
      ? {
          reason: raw.reason ?? null,
          tableDiag: raw.tableDiag ?? null,
          reserveAreaHtml: raw.reserveAreaHtml ?? null,
        }
      : null;
  return raw.items ?? [];
}

function mapBookingStatus(raw) {
  if (!raw) return 'confirmed';
  const s = String(raw);
  if (/キャン|取消/.test(s)) return 'cancelled';
  if (/完了|来店済|済/.test(s)) return 'completed';
  if (/不在|無断|ノーショー/.test(s)) return 'no_show';
  if (/仮|保留|未確定/.test(s)) return 'pending';
  return 'confirmed';
}

function cleanText(s) {
  if (!s) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

// ----------------- メニュー一覧 (menuEdit) -----------------

const MENU_EDIT_URL = 'https://salonboard.com/CNK/draft/menuEdit';

/**
 * SalonBoard のメニュー編集画面からメニュー一覧を取得する。
 * 実 DOM (menu.html) より、各メニューは
 *   <textarea name="frmMenuEditMenuDetailList[N].menuName">メニュー名</textarea>
 *   <input    name="frmMenuEditMenuDetailList[N].price" value="...">
 *   <input    name="frmMenuEditMenuDetailList[N].menuId" value="...">
 *   <input    name="frmMenuEditMenuDetailList[N].menuCategoryName" value="...">
 *   <input    name="frmMenuEditMenuDetailList[N].sejyutsuAimTime" value="...">  (施術時間/分)
 * の連番フィールドで構成される。属性順に依存しないよう DOM の .value を読む。
 */
async function scrapeMenus(page, opts = {}) {
  // ジャンル別分岐: 美容室(hair)はメニューではなく「スタイル一覧」を取得する。
  // 他ジャンル(esthetic/nail/eyelash/other)は従来のメニュー編集画面 (/CNK/draft/menuEdit)。
  if (opts.genre === 'hair') {
    return scrapeStyles(page, opts);
  }
  await page.goto(MENU_EDIT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  const raw = await page.evaluate(() => {
    // name="frmMenuEditMenuDetailList[N].field" の N とフィールドを引く
    const re = /^frmMenuEditMenuDetailList\[(\d+)\]\.(.+)$/;
    const byIndex = {};
    const els = document.querySelectorAll(
      'input[name^="frmMenuEditMenuDetailList"], textarea[name^="frmMenuEditMenuDetailList"], select[name^="frmMenuEditMenuDetailList"]',
    );
    for (const el of els) {
      const m = (el.name || '').match(re);
      if (!m) continue;
      const idx = m[1];
      const field = m[2];
      let val = '';
      if (el.tagName.toLowerCase() === 'textarea') val = el.value ?? el.textContent ?? '';
      else val = el.value ?? '';
      byIndex[idx] = byIndex[idx] || {};
      // 同名が複数あるとき (radio 等) は最初の非空を優先
      if (byIndex[idx][field] == null || byIndex[idx][field] === '') {
        byIndex[idx][field] = (val || '').trim();
      }
    }
    const items = [];
    for (const idx of Object.keys(byIndex)) {
      const f = byIndex[idx];
      const name = (f.menuName || '').trim();
      if (!name) continue; // 空欄プレースホルダは捨てる
      items.push({
        external_id: (f.menuId || '').trim() || `idx_${idx}`,
        name,
        category: (f.menuCategoryName || f.genreName || '').trim() || null,
        price: (f.price || '').replace(/[^\d]/g, '') || null,
        duration_min: (f.sejyutsuAimTime || '').replace(/[^\d]/g, '') || null,
      });
    }
    return { items, total: Object.keys(byIndex).length };
  });

  const rows = (raw.items ?? []).map((it) => ({
    external_id: it.external_id,
    name: it.name,
    category: it.category,
    price: it.price ? Number(it.price) : null,
    duration_min: it.duration_min ? Number(it.duration_min) : null,
    is_active: true,
  }));
  return { rows, debug: { itemsFound: rows.length, fieldsTotal: raw.total } };
}

// ----------------- クーポン一覧 (couponList) -----------------
//
// ホットペッパー(SalonBoard)ではメニューとクーポンは別概念。
// クーポンは /CNK/draft/couponList の一覧テーブルから取得する。
// 各行は <tr> 内に hidden input name="frmCouponListDto[N].couponId" を持ち、
// 同じ <tr> 内の td.td_value_store_c が以下の列順で並ぶ:
//   [0] 順番(No. の input)  [1] クーポン写真(img[name=couponPhoto])
//   [2] 種別(新規/再来/全員) [3] クーポン名  [4] 有効期限(「YYYY/MM/DD まで」/「なし」)
//   [5] チェック  [6] 詳細  [7] 非掲載/削除
const COUPON_LIST_URL = 'https://salonboard.com/CNK/draft/couponList';

async function scrapeCoupons(page, opts = {}) {
  // 掲載管理はジャンルで URL 接頭辞が違う(hair=/CNB/、他=/CNK/)。genre を受けないと
  // hair 店でも /CNK/ を見て 0 件になる(ADER 開発店で判明 2026-07-12)。
  const couponListUrl = draftUrl(opts.genre, 'couponList', opts.baseUrl);
  await page.goto(couponListUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  // 一覧テーブルが描画されるまで少し待つ (couponId hidden が現れるか、最大8秒)
  await page
    .waitForSelector('input[name^="frmCouponListDto"]', { timeout: 8_000 })
    .catch(() => {});

  const raw = await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const items = [];
    // couponId の hidden input を起点に、その属する行 (tr) を特定する
    const idInputs = document.querySelectorAll('input[name^="frmCouponListDto"][name$=".couponId"]');
    for (const inp of idInputs) {
      const externalId = (inp.value || '').trim();
      if (!externalId) continue;
      const tr = inp.closest('tr');
      if (!tr) continue;
      // まず td.td_value_store_c を使い、無ければ行内の全 td にフォールバック。
      let tds = Array.from(tr.querySelectorAll('td.td_value_store_c'));
      if (tds.length < 4) tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 4) continue;
      const photo = tr.querySelector('img[name="couponPhoto"], img.couponImgSize');
      // 写真セル以降に「種別・クーポン名・有効期限」が並ぶ。
      // 写真を含む td のインデックスを基準に相対参照し、列ズレに強くする。
      let photoIdx = -1;
      for (let i = 0; i < tds.length; i++) {
        if (tds[i].querySelector('img[name="couponPhoto"], img.couponImgSize')) { photoIdx = i; break; }
      }
      let category, name, expires;
      if (photoIdx >= 0) {
        category = text(tds[photoIdx + 1]) || null;     // 種別
        name = text(tds[photoIdx + 2]);                  // クーポン名
        expires = text(tds[photoIdx + 3]) || null;       // 有効期限
      } else {
        // 写真が無いレイアウト: 固定インデックス (No, 写真, 種別, 名前, 期限)
        category = text(tds[2]) || null;
        name = text(tds[3]);
        expires = text(tds[4]) || null;
      }
      if (!name) continue;
      items.push({
        external_id: externalId,
        name,
        category,
        expires_label: expires,
        photo_url: photo ? (photo.getAttribute('src') || '').replace(/&amp;/g, '&') : null,
      });
    }
    return {
      items,
      total: idInputs.length,
      url: location.href,
      title: document.title,
      // 診断: 一覧の手掛かりになる要素数
      trCount: document.querySelectorAll('tr').length,
      couponImgCount: document.querySelectorAll('img.couponImgSize, img[name="couponPhoto"]').length,
    };
  });

  const baseItems = raw.items ?? [];

  // ---- 各クーポンの編集ページ (couponEdit) から詳細 (金額/所要時間/内容/条件) を取得 ----
  // 一覧には金額・所要時間・内容が無く、編集ページにのみ存在するため 1 件ずつ開く。
  // 一覧ページ内の #couponEditForm に couponId をセットして submit すると編集ページへ遷移する
  // (CSRF / userId / couponSortDate は既にフォームに入っている)。
  const details = {};
  let detailOk = 0;
  let detailFail = 0;
  for (const it of baseItems) {
    try {
      // 一覧ページに居ることを保証 (前回ループで編集ページに遷移しているため毎回戻る)
      if (!page.url().includes('/draft/couponList')) {
        await page.goto(couponListUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      }
      // couponEditForm に couponId をセットして submit
      const submitted = await page.evaluate((couponId) => {
        const form = document.querySelector('#couponEditForm');
        if (!form) return false;
        let idInput = form.querySelector('input[name="couponId"]');
        if (!idInput) {
          idInput = document.createElement('input');
          idInput.type = 'hidden';
          idInput.name = 'couponId';
          form.appendChild(idInput);
        }
        idInput.value = couponId;
        form.submit();
        return true;
      }, it.external_id);
      if (!submitted) { detailFail++; continue; }

      // 編集ページのクーポン名フィールドが現れるまで待つ
      await page
        .waitForSelector('input[name="frmCouponEditCnkDto.couponName"]', { timeout: 15_000 })
        .catch(() => {});

      const d = await page.evaluate(() => {
        const val = (sel) => {
          const el = document.querySelector(sel);
          return el ? (el.value ?? '').trim() : '';
        };
        const selectedText = (sel) => {
          const el = document.querySelector(sel);
          if (!el || el.selectedIndex < 0) return '';
          return (el.options[el.selectedIndex]?.textContent ?? '').trim();
        };
        const onlyDigits = (s) => (s || '').replace(/[^\d]/g, '');
        const price = onlyDigits(val('input[name="frmCouponEditCnkDto.price"]'));
        const duration = onlyDigits(val('input[name="frmCouponEditCnkDto.sejyutsuAimTime"]'));
        const content = val('textarea[name="frmCouponEditCnkDto.contentExplanation"]');
        // 提示条件 select は name が確実でないため ID ベースでフォールバック
        const condition =
          selectedText('select[name="frmCouponEditCnkDto.selectedCouponConditionCd"]') ||
          selectedText('#TagTD_NM_COUPON_CONDITION_CD_01 select') ||
          selectedText('[id^="TagTD_NM_COUPON_CONDITION_CD"] select');
        const useCondition = val('input[name="frmCouponEditCnkDto.useCondition"]');
        return {
          ok: !!document.querySelector('input[name="frmCouponEditCnkDto.couponName"]'),
          price: price || null,
          duration_min: duration || null,
          content: content || null,
          condition_label: condition || null,
          use_condition: useCondition || null,
        };
      });
      if (d?.ok) {
        details[it.external_id] = d;
        detailOk++;
      } else {
        detailFail++;
      }
    } catch (_e) {
      detailFail++;
    }
  }

  const rows = baseItems.map((it) => {
    const d = details[it.external_id] || {};
    return {
      external_id: it.external_id,
      name: it.name,
      category: it.category,
      expires_label: it.expires_label,
      photo_url: it.photo_url,
      price: d.price != null ? Number(d.price) : null,
      duration_min: d.duration_min != null ? Number(d.duration_min) : null,
      content: d.content ?? null,
      condition_label: d.condition_label ?? null,
      use_condition: d.use_condition ?? null,
      is_active: true,
    };
  });
  return {
    rows,
    debug: {
      itemsFound: rows.length,
      fieldsTotal: raw.total,
      detailOk,
      detailFail,
      url: raw.url,
      title: raw.title,
      trCount: raw.trCount,
      couponImgCount: raw.couponImgCount,
    },
  };
}

// ----------------- 予約書き込み (push_booking) -----------------
//
// 実登録フォーム (booking_create.html / form#extReserveRegist) に対応。
// URL 直開き可: /KLP/reserve/ext/extReserveRegist/?staffId=&date=&rsvHour=&rsvMinute=
// 確認画面を挟まない 1 ページ構成。enablePush=true のときのみ「登録する」を押す。
//
// payload (PushBookingPayload 相当):
//   booking_id, scheduled_at(ISO+09:00), duration_min,
//   salonboard_staff_external_id, staff_name,
//   salonboard_menu_name / menu_name / coupon_name (どれかメニュー名),
//   customer_name, customer_phone, notes, kireidot_ref
//
// 戻り値:
//   { status:'ok', externalId, detailUrl, confirmed }
//   { status:'confirm_only', confirmed }                 // enablePush=false
//   { status:'failed', reason, errorCode, manualRequired }

function parseJstPartsForPush(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const jst = new Date(t + 9 * 3600_000);
  return {
    yyyymmdd: `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}`,
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    hhmm: `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`,
  };
}

// 予約系URL(スケジュール/登録/詳細/変更)の genre 別コンテキストルート。
//   美容室(hair): /CLP/bt 配下。スケジュールが /CLP/bt/schedule/salonSchedule/ で確定しており、
//                 予約登録/詳細/変更も同一コンテキストルート(/CLP/bt/reserve/...)配下と推定する。
//   エステ等     : /KLP 配下 (従来の実績経路)。
// ※ 郡山(ADER=グループhair)の予約登録が /KLP/ 固定のため「SALON BOARD : エラー」着地していた。
//   Admin から genre(shops.genre) が job に載って worker まで届く(claim route)ので、それで出し分ける。
function reservePathRoot(genre) {
  return genre === 'hair' ? '/CLP/bt' : '/KLP';
}

// グループアカウント(ADER等)は 1 ログインで複数サロンを持つため、予約書き込み前に
// /CNC/groupTop/ で対象サロンを選び、店舗文脈(hairなら /CLP/bt/)を確立する。
// 未選択のまま schedule/reserve に入ると「SALON BOARD : エラー」/セッション切れになる。
// 単一店(salonId 無し)は no-op。best-effort(失敗しても後続の goto を試す)。
async function ensureReserveSalonContext(page, baseUrl, opts) {
  if (!opts || !opts.salonId) return;
  try {
    await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await ensureSalonSelected(page, {
      salonId: opts.salonId,
      shopName: opts.shopName,
      genre: opts.genre,
      baseUrl,
    }).catch(() => {});
  } catch (_e) { /* best-effort */ }
}

/**
 * 登録/挿入した予約の SalonBoard 予約ID(reserveId) を予約一覧(reserveList)から特定する。
 * 完了画面から reserveId を拾えなかったときのフォールバック。
 * 予約一覧の各行は detail リンクに reserveId= を持つので、日付フィルタ→
 * (同開始時刻 + 同スタッフ external_id) [+ 顧客名] で一意に決まる行の reserveId を返す。
 *
 * 引数 target: { yyyymmdd, hhmm, staffExt, customerName }
 * 戻り値: reserveId(string) | null
 */
/**
 * reserveId を「予約一覧スクレイプ(scrapeBookings)」で特定する確実版。
 * findReserveIdForBooking(日付フィルタUI依存・cancelled 混在で曖昧化)が null の時の
 * フォールバック兼・確実経路。scrapeBookings は全件読むので reserveId(external_id) を
 * 取りこぼさず、status=cancelled を除外して confirmed を一意に選べる。
 * target: { yyyymmdd, hhmm, staffExt?, staffName?, customerName? }
 * 戻り値: reserveId(string) | null
 */
async function findReserveIdViaScrape(page, target, opts = {}) {
  return Promise.race([
    _findReserveIdViaScrapeImpl(page, target, opts),
    new Promise((resolve) => setTimeout(() => resolve(null), 90_000)),
  ]).catch(() => null);
}
async function _findReserveIdViaScrapeImpl(page, target, opts = {}) {
  try {
    // ★対象日を含む範囲でスクレイプする。既定(3日)だと未来日の予約(例: 2ヶ月先の登録直後)を
    //   取りこぼし reserveId 回収に失敗する(郡山 8/21 実例)。target.yyyymmdd があればその日1日に絞る。
    const ymd = target && target.yyyymmdd;
    const dstr = ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null;
    const { rows } = await scrapeBookings(page, {
      baseUrl: opts.baseUrl,
      genre: opts.genre || 'esthetic',
      ...(dstr ? { range: { fromStr: dstr, toStr: dstr } } : {}),
    });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // ISO(UTC) → JST の yyyymmdd / HH:MM
    const toJst = (iso) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return { ymd: null, hhmm: null };
      const j = new Date(d.getTime() + 9 * 3600 * 1000);
      const ymd = `${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, '0')}${String(j.getUTCDate()).padStart(2, '0')}`;
      const hhmm = `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`;
      return { ymd, hhmm };
    };
    const norm = (s) => (s || '').replace(/\s*様$/, '').replace(/\s+/g, '');
    const getId = (b) => ((b.external_id || b.customer_code || '') + '').trim() || null;
    const wantStaff = (target.staffExt || '').toUpperCase();
    const wantStaffName = norm(target.staffName);
    const wantCust = norm(target.customerName);
    let cands = rows.filter((b) => {
      if (!b.scheduled_at) return false;
      const { ymd, hhmm } = toJst(b.scheduled_at);
      if (target.yyyymmdd && ymd !== target.yyyymmdd) return false;
      if (target.hhmm && hhmm !== target.hhmm) return false;
      if (wantStaff && b.staff_external_id && String(b.staff_external_id).toUpperCase() !== wantStaff) return false;
      if (!b.staff_external_id && wantStaffName && b.staff_name && norm(b.staff_name) !== wantStaffName) return false;
      return true;
    });
    // cancelled を除外 (confirmed のみ)。再予約で同枠に cancelled+confirmed が並んでも一意化。
    const active = cands.filter((b) => b.status !== 'cancelled');
    if (active.length) cands = active;
    if (cands.length === 1) return getId(cands[0]);
    if (cands.length > 1 && wantCust) {
      const byCust = cands.filter((b) => norm(b.customer_name).includes(wantCust) || wantCust.includes(norm(b.customer_name)));
      if (byCust.length === 1) return getId(byCust[0]);
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// 間欠的に一覧検索が詰まる(Ginza等の大量予約一覧)と push ジョブ全体が 240s ハング→reaped する。
// 全体を 35s で打ち切り(タイムアウト時は null=見つからず扱い)、ジョブ全体のハングを根絶する。
async function findReserveIdForBooking(page, target, opts = {}) {
  return Promise.race([
    _findReserveIdForBookingImpl(page, target, opts),
    new Promise((resolve) => setTimeout(() => resolve(null), 90_000)),
  ]).catch(() => null);
}
async function _findReserveIdForBookingImpl(page, target, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  try {
    await page.goto(RESERVE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    // 対象日に絞って検索 (その日だけ)
    const y = target.yyyymmdd;
    const fromStr = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
    await applyBookingDateFilter(page, { fromStr, toStr: fromStr }, {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

    const items = await extractBookingItemsFromCurrentPage(page);
    const wantStaff = (target.staffExt || '').toUpperCase();
    const wantCust = (target.customerName || '').replace(/\s*様$/, '').trim();
    const cands = [];
    for (const it of items) {
      const reserveId = extractIdFromUrl(it.link_href, 'reservationId', 'reserveId', 'rsvId');
      if (!reserveId) continue;
      // ★キャンセル/取消済みの行は候補にしない (2026-07-11 銀座 五十嵐様の偽already_exists:
      //   同時刻・同スタッフのキャンセル済み予約(YG81411574)に誤マッチして登録がスキップされ続けた)。
      if (/キャンセル|取消/.test(it.status_raw || '')) continue;
      // 開始時刻 (datetime_raw に HH:MM が含まれる)
      const tm = (it.datetime_raw || '').match(/(\d{1,2}):(\d{2})/);
      const hhmm = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;
      if (target.hhmm && hhmm !== target.hhmm) continue;
      // スタッフ external_id (行から拾えた場合)
      if (wantStaff && it.staff_external_id && it.staff_external_id.toUpperCase() !== wantStaff) continue;
      cands.push({ reserveId, customer: (it.customer_raw || '').replace(/\s*様$/, '').trim() });
    }
    console.log(`[recover] cands=${cands.length} target=${target.hhmm} cust=${(target.customerName||'').slice(0,8)}`);
    // ★単独候補でも、双方の顧客名が分かる場合は名前照合する (同時刻・同スタッフの
    //   別客予約への誤マッチ防止)。行側の顧客名が空のときのみ従来どおり時刻+スタッフで採用。
    if (cands.length === 1) {
      const c = cands[0];
      if (wantCust && c.customer && !(c.customer.includes(wantCust) || wantCust.includes(c.customer))) {
        console.log(`[recover] 単独候補が顧客名不一致のため不採用 (row=${c.customer.slice(0, 8)})`);
        return null;
      }
      return c.reserveId;
    }
    // 複数候補なら顧客名で一意化
    if (cands.length > 1 && wantCust) {
      const byCust = cands.filter((c) => c.customer && (c.customer.includes(wantCust) || wantCust.includes(c.customer)));
      if (byCust.length === 1) return byCust[0].reserveId;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// reserveId を直接キーに SalonBoard の予約詳細ページを開き、その予約が
// 「現在も有効に存在するか」を判定する。一覧の名前照合 (findReserveIdForBooking)
// と違い、顧客名が空の予約でも確実に存在確認できる (= 二重登録防止プリフライトの本命)。
//
// 戻り値:
//   'active'    … 詳細ページが開けてキャンセルボタン(#fnc_cancel)あり = 有効な予約が存在
//   'cancelled' … 詳細は開けたがステータスがキャンセル/取消 = SB上は無効 (再登録してよい)
//   'not_found' … 詳細ページを開けない = SB上に存在しない (再登録してよい)
//   'unknown'   … 判定に失敗 (reCAPTCHA 等)。安全側で扱う (呼び出し側で登録を見送る判断に使える)
async function checkReserveStatusById(page, reserveId, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  if (!reserveId) return 'not_found';
  try {
    // 電話/外部予約(YG...) と ネット予約(BF/BE...) で詳細 URL が異なるので両方試す。
    const detailCandidates = [
      `/KLP/reserve/ext/extReserveDetail/?reserveId=${reserveId}`,
      `/KLP/reserve/net/reserveDetail/?reserveId=${reserveId}`,
    ];
    let onDetail = false;
    for (const path of detailCandidates) {
      await page
        .goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 })
        .catch(() => {});
      // reCAPTCHA が出たら判定不能。
      if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
        return 'unknown';
      }
      // 詳細ページなら #fnc_cancel(キャンセルにする) か、ステータス表記が出る。
      await page.waitForSelector('#fnc_cancel', { timeout: 8_000 }).catch(() => {});
      const hasCancelBtn = (await page.locator('#fnc_cancel').count().catch(() => 0)) > 0;
      const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
      const looksCancelled = /ステータス[\s\S]{0,30}(キャンセル|取消)/.test(bodyText);
      if (hasCancelBtn) { onDetail = true; return looksCancelled ? 'cancelled' : 'active'; }
      if (looksCancelled) { onDetail = true; return 'cancelled'; }
      // この URL では詳細に到達できなかった → 次の候補へ。
    }
    return onDetail ? 'active' : 'not_found';
  } catch (_e) {
    return 'unknown';
  }
}

// 予約詳細ページ(予約情報テーブルの「設備」行)から、その予約に割り当てられた設備名
// (例「ベッド１」)を読む。HotPepper 予約はメール/一覧に席情報が無いため、これが
// 「SBが実際に確保している席」を知る確実な経路 (2026-07-11 向井さん指摘・実DOM確認済)。
// 戻り値: 設備名 (時刻を除いた先頭) / 未割当・取得不可は null。
async function readReservationEquipmentName(page, reserveId, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  if (!reserveId) return null;
  // ネット予約(BF/BE)は net、電話/外部(YG)は ext を優先。
  const detailCandidates = /^(BF|BE)/i.test(reserveId)
    ? [`/KLP/reserve/net/reserveDetail/?reserveId=${reserveId}`, `/KLP/reserve/ext/extReserveDetail/?reserveId=${reserveId}`]
    : [`/KLP/reserve/ext/extReserveDetail/?reserveId=${reserveId}`, `/KLP/reserve/net/reserveDetail/?reserveId=${reserveId}`];
  for (const path of detailCandidates) {
    try {
      await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (_e) { continue; }
    if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) return null;
    const res = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/[\s　]/g, '');
      const cells = Array.from(document.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length; i++) {
        if (norm(cells[i].textContent) === '設備') {
          const row = cells[i].closest('tr');
          const sibs = row ? Array.from(row.querySelectorAll('td, th')) : [];
          const rawVal = sibs.length ? (sibs[sibs.length - 1].textContent || '') : (cells[i + 1]?.textContent || '');
          // "ベッド１ 14:30 〜 15:45" → 時刻以降を落として設備名だけ。
          const name = String(rawVal).replace(/[\s　]*\d{1,2}:\d{2}[\s\S]*$/, '').replace(/[\s　]+/g, '').trim();
          return { found: true, name: name || null };
        }
      }
      const hasInfo = /予約情報|予約番号/.test(document.body?.innerText || '');
      return { found: false, hasInfo };
    }).catch(() => ({ found: false }));
    if (res.found) return res.name;
    if (res.hasInfo) return null; // 詳細は開けたが設備行なし = 未割当
  }
  return null;
}

// rows のうち「未来 & 設備未取得 & reserveId形式」を近い順に最大 cap 件、予約詳細から
// 設備名を読んで row.equipment_name に入れる。全件は重い/Akamai負荷のため上限を掛け、
// 数回の fetch で backfill する。過去予約の席は同期不要(将来の競合検出に効くのは未来分)。
async function enrichEquipmentFromDetail(page, rows, baseUrl, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : 25;
  const genre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const base = baseUrl || 'https://salonboard.com/';
  const now = Date.now();
  const targets = (rows || [])
    .filter((r) =>
      !r.equipment_name &&
      r.status !== 'cancelled' &&
      /^(YG|BF|BE)\d+/i.test(String(r.external_id || '')) &&
      Number.isFinite(Date.parse(r.scheduled_at)) &&
      Date.parse(r.scheduled_at) >= now - 86_400_000)
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
    .slice(0, cap);
  if (targets.length === 0) return 0;
  // ★2026-07-02以降、SB は素の reserveDetail 直リンクを汎用エラー(KPCL009V01)で弾く
  //   (キャンセルと同事象・task#15)。一覧/スケジュールを一度開いて文脈(トークン/Cookie)を
  //   作ってから詳細を開くと通る。これをしないと HotPepper(BF)予約の設備がほぼ全件0件になる。
  const establishCtx = async () => {
    try {
      await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
      const ctxUrl = genre === 'hair'
        ? new URL('/CLP/bt/schedule/salonSchedule/', base).toString()
        : new URL('/KLP/reserve/reserveList/init', base).toString();
      await page.goto(ctxUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(600);
    } catch (_e) { /* best-effort */ }
  };
  await establishCtx();
  let read = 0;
  for (const r of targets) {
    let name = await readReservationEquipmentName(page, r.external_id, { baseUrl: base }).catch(() => null);
    if (!name) {
      // 文脈切れ/直リンク遮断で弾かれた可能性 → 文脈を作り直して1回だけ再試行。
      await establishCtx();
      name = await readReservationEquipmentName(page, r.external_id, { baseUrl: base }).catch(() => null);
    }
    if (name) { r.equipment_name = name; read++; }
  }
  if (read) console.log(`[scrape] 設備を予約詳細から取得 ${read}/${targets.length}件`);
  return read;
}

// =====================================================================
// 予定登録 (KIREIDOT のブロック予約=休憩/業務 → SalonBoard の「予定」)
//   予約(extReserveRegist)ではなく予定(scheduleRegist)として登録する。
//   予定は設備(ベッド)を埋めず、HOT PEPPER の予約受付だけ停止する枠。
//   実DOM: フォーム #jsiScheduleRegist (action=/KLP/set/scheduleRegist/)
//     - スタッフ:   select[name=staffId] (value=external_id)
//     - 日付(hidden): input[name=date] (#jsiSchDate, value=YYYYMMDD)
//     - 開始時/分:  #jsiRsvHour / #jsiRsvMinute
//     - 終了時/分:  #jsiSchEndHour / #jsiSchEndMinute
//     - タイトル:   input[name=schTitle] (最大30)
//     - メモ:       input[name=schMemo]  (最大100)
//     - 登録:       a#regist
// =====================================================================
// スケジュール画面 (salonSchedule) の対象スタッフ列から「開始・終了・タイトル」が一致する
// 予定ブロックを探す (page.evaluate 用)。予定は reserveId を持たず一覧からも読めないため、
// 登録前の冪等チェックと登録後の実在確認の両方でこの関数を使う。
// 戻り値 blocks には対象スタッフ列の全予定を入れ、失敗診断 (何が実在するか) に使う。
function findScheduleBlockInPage({ staffExt, startTotal, endTotal, title }) {
  const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const heads = Array.from(document.querySelectorAll('.scheduleMainHead[id^="STAFF_"]')).map((el) => {
    const m = (el.id || '').match(/^STAFF_([A-Z0-9]+)_/i);
    return m ? m[1].toUpperCase() : null;
  });
  const staffTable = document.querySelector('.jscScheduleMainTableStaff');
  if (!staffTable) return { ok: false, reason: 'no_staff_table', blocks: [] };
  const ext = String(staffExt || '').toUpperCase();
  const staffIndex = heads.indexOf(ext);
  if (staffIndex < 0) return { ok: false, reason: 'staff_not_found', blocks: [] };
  const line = staffTable.querySelectorAll('.scheduleMainTableLine')[staffIndex];
  if (!line) return { ok: false, reason: 'staff_line_not_found', blocks: [] };
  const blocks = [];
  let found = false;
  for (const el of Array.from(line.querySelectorAll('.jscScheduleToDo'))) {
    if (el.classList.contains('isDayOff')) continue;
    const tz = el.querySelector('.scheduleTimeZoneSetting')?.textContent || '';
    const m = tz.match(/"(\d{1,2}):(\d{2})"\s*,\s*"(\d{1,2}):(\d{2})"/);
    if (!m) continue;
    const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    const actualTitle = norm(el.querySelector('.todoTitle')?.textContent);
    blocks.push({ start, end, title: actualTitle });
    // SalonBoard は同じタイトルの連続・隣接予定を1つの表示ブロックへ結合する。
    // そのため登録した区間が既存の「予定あり」に包含された場合も実在している。
    // 完全一致だけを要求すると、例: 11:00-19:30 の結合ブロック内へ追加した
    // 12:30-13:30 を未登録と誤判定するため、同タイトルの包含も成功にする。
    if (start <= startTotal && end >= endTotal && actualTitle === norm(title)) found = true;
  }
  return found ? { ok: true, reason: null, blocks } : { ok: false, reason: 'exact_schedule_not_found', blocks };
}

async function pushScheduleViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  if (!p.scheduled_at) return fail('予定の日時(scheduled_at)がありません', 'UNKNOWN_ERROR', true);
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  if (!p.salonboard_staff_external_id) {
    return fail('SalonBoard スタッフ external_id が未指定です(予定はスタッフ単位)', 'STAFF_MAPPING_NOT_FOUND', true);
  }

  // 終了時刻 = 開始 + 所要(分)。所要が無ければ60分。
  const durMin = (p.duration_min != null && Number.isFinite(Number(p.duration_min))) ? Number(p.duration_min) : 60;
  const startTotal = when.hour * 60 + when.minute;
  const endTotal = startTotal + durMin;
  const endHour = Math.floor(endTotal / 60);
  const endMin = endTotal % 60;
  const startHH = String(when.hour).padStart(2, '0');
  const startMM = String(when.minute).padStart(2, '0');
  const endHH = String(endHour).padStart(2, '0');
  const endMM = String(endMin).padStart(2, '0');

  // タイトル = 理由(休憩/業務等)。メモにも理由を残す。
  const title = (String(p.block_reason || '').trim() || '予定').slice(0, 30);
  const memo = (String(p.block_reason || '').trim()).slice(0, 100);

  // 対象日 (YYYYMMDD) と 表示用文字列 (YYYY年M月D日（曜）)。
  // フォームは date クエリ無しで開く=既定「今日」なので、対象日が違えば
  // hidden(name="date") と表示 dummy を書き換える。
  const ymd = when.yyyymmdd; // 例 20260611
  const dispDate = (() => {
    const y = Number(ymd.slice(0, 4)), mo = Number(ymd.slice(4, 6)), d = Number(ymd.slice(6, 8));
    const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
    return `${y}年${mo}月${d}日（${wd}）`;
  })();

  // ★予定登録画面は単独URL(/KLP/set/scheduleRegist/)に直接遷移できない
  //   (「情報が一部失われています」エラーになる)。予約登録と同じ手順で
  //   予約登録フォーム(extReserveRegist)を開き、そこの「予定を登録する」ボタン
  //   (a#fnc_schedule)を押して予定画面へ遷移する必要がある。

  // (1) スケジュール画面で rlastupdate を取得 (予約登録と同じ。これが無いと
  //     登録フォームが "情報が一部失われています" になる)。
  let rlastupdate = '';
  try {
    const schedUrl = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    schedUrl.searchParams.set('date', when.yyyymmdd);
    schedUrl.searchParams.set('_kd_token', String(Date.now()));
    await page.goto(schedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('#rlastupdate', { timeout: 12_000 }).catch(() => {});
    rlastupdate = (await page.locator('#rlastupdate').first().textContent().catch(() => ''))?.trim() || '';
  } catch (e) {
    return fail(`予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }

  // 再試行時の二重登録防止。前回の登録が成功したのに完了画面/実在確認だけ失敗した
  // ケースでは、ここで既存予定を検出して冪等成功にする。
  const existing = await page.evaluate(findScheduleBlockInPage, {
    staffExt: p.salonboard_staff_external_id,
    startTotal,
    endTotal,
    title,
  }).catch(() => null);
  if (existing?.ok) {
    return {
      status: 'ok',
      externalId: null,
      alreadyExists: true,
      confirmed: { title, confirmed_scheduled_at: p.scheduled_at },
    };
  }

  // (2) 予約登録フォームを開く (予約と同じ URL + パラメータ)。
  // SalonBoard はスケジュールを表示した瞬間の rlastupdate を楽観ロックとして使う。
  // 別タブ/別利用者/SalonBoard側処理で更新されると KPCL017V01 のエラー画面へ遷移し、
  // 本来の #fnc_schedule が存在しなくなる。ここで単に「ボタン無し」として落とさず、
  // 最新スケジュールへ戻って rlastupdate を取り直し、同じCloud処理内で再試行する。
  let staleFormError = '';
  let formOpened = false;
  for (let formAttempt = 1; formAttempt <= 3; formAttempt += 1) {
    if (formAttempt > 1) {
      try {
        const refreshUrl = new URL('/KLP/schedule/salonSchedule/', baseUrl);
        refreshUrl.searchParams.set('date', when.yyyymmdd);
        refreshUrl.searchParams.set('_kd_token', `${Date.now()}_${formAttempt}`);
        await page.goto(refreshUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForSelector('#rlastupdate', { timeout: 12_000 }).catch(() => {});
        rlastupdate = (await page.locator('#rlastupdate').first().textContent().catch(() => ''))?.trim() || '';
        await page.waitForTimeout(250 + formAttempt * 150);
      } catch (e) {
        return fail(`最新の予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
      }
    }

    const u = new URL('/KLP/reserve/ext/extReserveRegist/', baseUrl);
    u.searchParams.set('staffId', p.salonboard_staff_external_id);
    u.searchParams.set('date', when.yyyymmdd);
    u.searchParams.set('rsvHour', startHH);
    u.searchParams.set('rsvMinute', startMM);
    if (rlastupdate) u.searchParams.set('rlastupdate', rlastupdate);
    try {
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForSelector('form#extReserveRegist, #fnc_schedule, #regist', { timeout: 15_000 }).catch(() => {});
    } catch (e) {
      return fail(`予約登録フォームを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
    }

    const formPageState = await page.evaluate(() => {
      const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
      return {
        ready: !!document.querySelector('form#extReserveRegist, #fnc_schedule, #regist'),
        stale: /KPCL017V01|他のユーザによって変更されているため/.test(text),
        text: text.slice(0, 500),
      };
    }).catch(() => ({ ready: false, stale: false, text: '' }));
    if (formPageState.ready) {
      formOpened = true;
      break;
    }
    if (formPageState.stale) {
      staleFormError = formPageState.text;
      continue;
    }
    break;
  }
  if (!formOpened && staleFormError) {
    const cap = await captureScrapeDebug(page, 'schedule', `stale_form_${ymd}_${p.salonboard_staff_external_id}`, {
      diagnostics: { staleFormError, rlastupdate },
    });
    return fail(
      `SalonBoardの更新競合(KPCL017V01)が3回続きました${cap ? ` (capture=${cap})` : ''}`,
      'CONFIRMATION_MISMATCH',
      false,
    );
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA on register form', 'RECAPTCHA_REQUIRED', true);
  }

  // (3) 「予定を登録する」ボタンを押して予定登録画面へ遷移。
  // SalonBoard の店舗契約/画面版によって a#fnc_schedule ではなく
  // button/input、または「予定を追加する」表記になるため、文言でも救済する。
  const schedBtn = page.locator([
    'a#fnc_schedule',
    'button#fnc_schedule',
    'input#fnc_schedule',
    'a:has-text("予定を登録する")',
    'button:has-text("予定を登録する")',
    'input[type="button"][value*="予定"][value*="登録"]',
    'input[type="submit"][value*="予定"][value*="登録"]',
    'a:has-text("予定を追加する")',
    'button:has-text("予定を追加する")',
    'input[type="button"][value*="予定"][value*="追加"]',
  ].join(', ')).first();
  if ((await schedBtn.count().catch(() => 0)) === 0) {
    const diagnostics = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      heading: Array.from(document.querySelectorAll('h1,h2,h3,.mod_heading')).map((el) => el.textContent?.trim()).filter(Boolean).slice(0, 12),
      forms: Array.from(document.forms).map((form) => ({ id: form.id, name: form.name, action: form.action })).slice(0, 12),
      controls: Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'))
        .map((el) => ({
          tag: el.tagName,
          id: el.id,
          name: el.getAttribute('name'),
          value: el.getAttribute('value'),
          text: el.textContent?.replace(/\s+/g, ' ').trim(),
          href: el.getAttribute('href'),
        }))
        .filter((x) => x.id || x.name || x.value || x.text)
        .slice(0, 80),
      bodyText: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 1200) || '',
    })).catch(() => null);
    const cap = await captureScrapeDebug(page, 'schedule', `no_schedule_button_${ymd}_${p.salonboard_staff_external_id}`, {
      diagnostics,
    });
    const currentUrl = page.url();
    return fail(
      `「予定を登録する」ボタンが見つかりません (url=${currentUrl}${cap ? `, capture=${cap}` : ''})`,
      'CONFIRMATION_MISMATCH',
      true,
    );
  }
  try {
    await Promise.all([
      page.waitForSelector('#jsiScheduleRegist, input[name="schTitle"], #jsiSchEndHour', { timeout: 15_000 }).catch(() => {}),
      schedBtn.click({ timeout: 12_000 }),
    ]);
  } catch (_e) { /* 続行して下で formReady を検証 */ }
  // 遷移待ち (クリックでページ遷移する場合に備える)。
  await page.waitForSelector('#jsiScheduleRegist, input[name="schTitle"], #jsiSchEndHour', { timeout: 12_000 }).catch(() => {});

  const formReady = (await page.locator('#jsiScheduleRegist, input[name="schTitle"], #jsiSchEndHour').first().count().catch(() => 0)) > 0;
  if (!formReady) {
    return fail(`予定登録フォームに到達できませんでした (url=${page.url()})`, 'CONFIRMATION_MISMATCH', true);
  }

  // 入力: スタッフ / 開始 / 終了 / タイトル / メモ。全てJSでセット+change発火。
  const staffExt = p.salonboard_staff_external_id;
  await page.evaluate(
    ({ ext, hh, mm, eh, em, title, memo, ymd, dispDate }) => {
      const setSel = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        if (!Array.from(el.options).some((o) => o.value === val)) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setInput = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // 対象日 (hidden name="date" と表示 dummy)。既定が今日なので対象日に上書き。
      setInput('input[name="date"]', ymd);
      setInput('#jsiSchDateDummy, input[name="schDateDummy"]', dispDate);
      setSel('select[name="staffId"]', ext);
      setSel('#jsiRsvHour', hh);
      setSel('#jsiRsvMinute', mm);
      setSel('#jsiSchEndHour', eh);
      setSel('#jsiSchEndMinute', em);
      setInput('input[name="schTitle"]', title);
      setInput('input[name="schMemo"]', memo);
    },
    { ext: staffExt, hh: startHH, mm: startMM, eh: endHH, em: endMM, title, memo, ymd, dispDate },
  ).catch(() => {});

  // ★入力の読み戻し検証: setSel は該当 option が無いと黙って何もしないため、
  //   そのまま登録すると「既定スタッフ/既定日/既定時刻への誤登録」になる
  //   (同時刻でスタッフによって成否が分かれた 2026-07-22 の失敗パターン)。
  //   実フォーム値が意図と一致することを確認してから登録する。
  const formState = await page.evaluate(() => ({
    date: document.querySelector('input[name="date"]')?.value || '',
    staffId: document.querySelector('select[name="staffId"]')?.value || '',
    staffOptions: Array.from(document.querySelector('select[name="staffId"]')?.options || [])
      .map((o) => o.value).filter(Boolean).slice(0, 40),
    hh: document.querySelector('#jsiRsvHour')?.value || '',
    mm: document.querySelector('#jsiRsvMinute')?.value || '',
    eh: document.querySelector('#jsiSchEndHour')?.value || '',
    em: document.querySelector('#jsiSchEndMinute')?.value || '',
    title: document.querySelector('input[name="schTitle"]')?.value || '',
  })).catch(() => null);
  const timeMismatch = formState && (
    Number(formState.hh) !== when.hour || Number(formState.mm) !== when.minute
    || Number(formState.eh) !== endHour || Number(formState.em) !== endMin
  );
  if (!formState || formState.staffId !== staffExt || formState.date !== ymd || timeMismatch) {
    const cap = await captureScrapeDebug(page, 'schedule', `form_mismatch_${ymd}_${staffExt}`, {
      diagnostics: { expected: { staffExt, ymd, startHH, startMM, endHH, endMM, title }, formState },
    });
    const why = !formState ? 'フォーム値を読めません'
      : formState.staffId !== staffExt ? `スタッフ不一致 (form=${formState.staffId || '(空)'} 期待=${staffExt}。選択肢に無い場合はSB側の掲載/在籍状態を確認)`
      : formState.date !== ymd ? `対象日不一致 (form=${formState.date || '(空)'} 期待=${ymd})`
      : `時刻不一致 (form=${formState.hh}:${formState.mm}-${formState.eh}:${formState.em} 期待=${startHH}:${startMM}-${endHH}:${String(endMin).padStart(2, '0')})`;
    return fail(`予定登録フォームの値が意図と一致しないため登録を中止しました (${why}${cap ? `, capture=${cap}` : ''})`, 'CONFIRMATION_MISMATCH', true);
  }

  if (!enablePush) {
    return { status: 'confirm_only', confirmed: { confirmed_scheduled_at: p.scheduled_at, title } };
  }

  // 「登録する」(a#regist)。ネイティブ confirm が出れば accept。
  const registerBtn = page.locator('a#regist').first();
  if ((await registerBtn.count().catch(() => 0)) === 0) {
    return fail('予定の登録ボタンが見つかりません', 'UNKNOWN_ERROR', true);
  }
  let dialogAccepted = false;
  const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) {} };
  page.on('dialog', onDialog);
  const beforeUrl = page.url();
  try {
    await registerBtn.scrollIntoViewIfNeeded().catch(() => {});
    await registerBtn.click({ timeout: 15_000 });
    // 店舗/画面状態によっては native confirm ではなくHTMLダイアログで
    // 「はい」を要求される。これを押さないと scheduleRegist に残ったまま未登録になる。
    await page.waitForTimeout(500);
    const htmlConfirm = page.locator([
      '.mod_dialog a.accept:visible',
      '.mod_popup_02 a.accept:visible',
      '#dragDialog a.accept:visible',
      '#dragDialog a.mod_btn_116:visible',
      '#dragDialog a.mod_btn_118:visible',
      '#confirmOK:visible',
      '#dialogOK:visible',
      '.jscDialogOk:visible',
      '.mod_dialog a:has-text("登録する"):visible',
      '.mod_popup_02 a:has-text("登録する"):visible',
      'a:has-text("はい"):visible',
      'button:has-text("はい"):visible',
    ].join(', ')).first();
    if ((await htmlConfirm.count().catch(() => 0)) > 0) {
      await htmlConfirm.click({ timeout: 10_000 });
    }
    // 完了サイン (フォーム離脱 / 完了文言 / エラー領域) を最大15秒ポーリング。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      if (!/scheduleRegist/i.test(page.url())) break;
      const done = await page.locator('text=/登録しました|完了しました|受け付けました/').first().count().catch(() => 0);
      if (done > 0) break;
      const err = await page.locator('.mod_box_warning, #warningMessageArea, .error, .errorMessage').first().count().catch(() => 0);
      if (err > 0) break;
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const errText = await page.locator('.mod_box_warning, #warningMessageArea, .error, .errorMessage').first().innerText().catch(() => '');
  if (errText && /エラー|失敗|できません|重複|登録できません/.test(errText)) {
    return fail(`予定登録時にエラー: ${errText.slice(0, 80)}`, 'UNKNOWN_ERROR', true);
  }
  const afterUrl = page.url();
  const stillOnForm = /scheduleRegist/i.test(afterUrl);
  const doneText = await page.locator('text=/登録しました|完了しました|受け付けました/').count().catch(() => 0);
  const looksDone = !stillOnForm || doneText > 0 || afterUrl !== beforeUrl;
  let completionWarning = '';
  if (!looksDone) {
    const visibleMessage = await page.locator(
      '.mod_box_warning:visible, #warningMessageArea:visible, .error:visible, .errorMessage:visible, #dragDialog:visible, .mod_dialog:visible',
    ).allInnerTexts().catch(() => []);
    const detail = visibleMessage.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ').slice(0, 300);
    const capA = await captureScrapeDebug(page, 'schedule', `no_complete_${ymd}_${staffExt}`, {
      diagnostics: { dialogAccepted, afterUrl, formState, detail },
    });
    // 完了サインが出ない画面差分があるため、この時点では失敗にしない。
    // 下のスケジュール実在確認を真実源にし、実在すれば成功として扱う。
    completionWarning = `完了サインなし(dialog=${dialogAccepted}, url=${afterUrl}${detail ? `, message=${detail}` : ''}${capA ? `, capture=${capA}` : ''})`;
  }

  // 完了画面の一般文言だけでは成功としない。実際のスケジュールへ戻り、
  // 対象スタッフ列に「開始・終了・タイトル」が一致する予定が存在することを確認する。
  // 以前は画面内の「スケジュール」という見出しだけでも成功になり、未登録を synced と
  // 誤判定するケースがあった。
  try {
    const verifyUrl = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    verifyUrl.searchParams.set('date', ymd);
    await page.goto(verifyUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('.jscScheduleMainTableStaff', { state: 'attached', timeout: 15_000 });
  } catch (e) {
    return fail(`予定登録後のスケジュール確認画面を開けません: ${e?.message ?? e}`, 'CONFIRMATION_MISMATCH', true);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('予定登録後の確認時にreCAPTCHAが表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  const verified = await page.evaluate(
    findScheduleBlockInPage,
    { staffExt, startTotal, endTotal, title },
  ).catch((e) => ({ ok: false, reason: `verify_exception:${e?.message ?? e}` }));
  if (!verified?.ok) {
    const blocks = Array.isArray(verified?.blocks)
      ? verified.blocks.slice(0, 8).map((b) => `${b.start}-${b.end}:${b.title}`).join(',')
      : '';
    return fail(`予定登録後の実在確認に失敗しました (${verified?.reason ?? 'unknown'}${blocks ? `, observed=${blocks}` : ''}${completionWarning ? `, ${completionWarning}` : ''})`, 'CONFIRMATION_MISMATCH', false);
  }
  return { status: 'ok', externalId: null, confirmed: { title, confirmed_scheduled_at: p.scheduled_at } };
}

// =====================================================================
// 予定削除 (KIREIDOT のブロック予約のキャンセル/削除 → SalonBoard の「予定」削除)
//   予定は reserveId を持たないため、スケジュール画面の予定ブロック
//   (.jscScheduleToDo) を「スタッフ列 + 開始時刻 (+タイトル)」で特定し、
//   クリック → ポップアップ「予定変更」→ 予定変更画面 (form#scheduleChange,
//   action=/KLP/set/scheduleChange/) の「削除する」(a#delete) で削除する。
//   実DOM (確認済み 2026-06-12):
//     グリッド:   <div class="scheduleToDo jscScheduleToDo staffTask">
//                   <span class="todoTitle">日常業務</span>
//                   <p class="scheduleTimeZoneSetting">["13:15", "14:00"]</p>
//                 ※シフト由来の休日ブロックは .isDayOff → 絶対に削除対象にしない
//     ポップアップ: .mod_popup_02.sch.js_yotei 内「予定変更」(a.mod_btn_10)
//     変更画面:   #jsiSchDate / #jsiStartTimeHour / #jsiStartTimeMinute /
//                 select[name=staffId] / 削除ボタン a#delete「削除する」
// =====================================================================
async function deleteScheduleViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enableDelete = opts.enableDelete !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  if (!p.scheduled_at) {
    return fail('予定の日時(scheduled_at)が無く、削除対象の予定を特定できません', 'UNKNOWN_ERROR', true);
  }
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  const startMin = when.hour * 60 + when.minute;
  const title = String(p.block_reason || '').trim().slice(0, 30) || null;
  let staffExt = String(p.salonboard_staff_external_id || '').toUpperCase() || null;
  const staffName = String(p.staff_name || '').normalize('NFKC').replace(/\s+/g, '').trim() || null;

  // スケジュール画面上で対象の予定ブロックを探す共通ロジック。
  // mark=true なら見つかった要素に data-kireidot-del 属性を付ける。
  const findTodo = (mark) => page.evaluate(
    ({ staffExt, staffName, startMin, title, mark }) => {
      const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
      const headEls = Array.from(document.querySelectorAll('.scheduleMainHead[id^="STAFF_"]'));
      const heads = headEls.map((el) => {
        const m = (el.id || '').match(/^STAFF_([A-Z0-9]+)_/i);
        return m ? m[1].toUpperCase() : null;
      });
      const staffTable = document.querySelector('.jscScheduleMainTableStaff');
      if (!staffTable) return { error: 'no_staff_table' };
      let selectedStaffExt = staffExt;
      let selectedIndex = staffExt ? heads.indexOf(staffExt) : -1;
      // KD側のexternal_idが古い/列に出ない場合でも、表示名が一意なら対象列を
      // 安全に復元する。曖昧な同名スタッフは選ばず従来どおり停止する。
      if (selectedIndex < 0 && staffName) {
        const nameMatches = headEls
          .map((el, i) => ({ i, name: norm(el.textContent) }))
          .filter((x) => x.name && (x.name === norm(staffName) || x.name.includes(norm(staffName))));
        if (nameMatches.length === 1) {
          selectedIndex = nameMatches[0].i;
          selectedStaffExt = heads[selectedIndex] || null;
        }
      }
      const staffColFound = !staffExt || selectedIndex >= 0;
      const lines = Array.from(staffTable.querySelectorAll('.scheduleMainTableLine'));
      const items = [];
      lines.forEach((line, i) => {
        if (staffExt && i !== selectedIndex) return;
        for (const el of Array.from(line.querySelectorAll('.jscScheduleToDo'))) {
          if (el.classList.contains('isDayOff')) continue; // シフトの休日は対象外
          const tz = el.querySelector('.scheduleTimeZoneSetting')?.textContent || '';
          const m = tz.match(/"(\d{1,2}):(\d{2})"\s*,\s*"(\d{1,2}):(\d{2})"/);
          if (!m) continue;
          items.push({
            el,
            start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
            end: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
            title: (el.querySelector('.todoTitle')?.textContent || '').trim(),
          });
        }
      });
      // 開始時刻一致 → 複数ならタイトルで絞る
      let cands = items.filter((it) => it.start === startMin);
      if (cands.length > 1 && title) {
        const byTitle = cands.filter((it) => it.title === title);
        if (byTitle.length) cands = byTitle;
      }
      // 開始一致が無ければ「タイトル一致 + 時間帯が開始時刻を含む」で救済
      if (cands.length === 0 && title) {
        cands = items.filter((it) => it.title === title && it.start <= startMin && startMin < it.end);
      }
      if (cands.length === 1) {
        if (mark) cands[0].el.setAttribute('data-kireidot-del', '1');
        return { ok: true, matched: 1, staffColFound, staffExt: selectedStaffExt, title: cands[0].title, start: cands[0].start, end: cands[0].end };
      }
      return { ok: false, matched: cands.length, staffColFound, staffExt: selectedStaffExt, total: items.length };
    },
    { staffExt, staffName, startMin, title, mark: !!mark },
  );

  // (1) スケジュール画面を開く
  try {
    const u = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    u.searchParams.set('date', when.yyyymmdd);
    u.searchParams.set('_kd', String(Date.now()));
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('.jscScheduleMainTableStaff', { state: 'attached', timeout: 15_000 });
  } catch (e) {
    return fail(`予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // (2) 対象の予定ブロックを特定してマーク
  const found = await findTodo(true).catch(() => null);
  if (!found || found.error === 'no_staff_table') {
    return fail('スケジュール画面のスタッフ表を取得できませんでした', 'UNKNOWN_ERROR', true);
  }
  if (staffExt && !found.staffColFound) {
    return fail(`スケジュール画面に対象スタッフ列 (${staffExt}) が見つかりません`, 'STAFF_MAPPING_NOT_FOUND', true);
  }
  if (!found.ok) {
    if (found.matched >= 2) {
      return fail(`同時刻に複数の予定があり一意に特定できません (候補=${found.matched}件)。SalonBoard で手動削除してください。`, 'UNKNOWN_ERROR', true);
    }
    // 該当の予定が無い = 既に削除済み (冪等成功)
    return { status: 'ok', externalId: null, alreadyAbsent: true };
  }
  if (found.staffExt) staffExt = found.staffExt;

  // (3) 予定ブロックをクリック → ポップアップの「予定変更」をクリック
  const target = page.locator('.jscScheduleToDo[data-kireidot-del="1"]').first();
  try {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    // 同じセルの予約アイコンが予定ブロック上へ重なるSalonBoardレイアウトがある。
    // 対象はスタッフ・開始時刻・タイトルで一意に絞り込み済みなので、座標上の
    // overlayに左右されないDOMクリックを許可する。
    await target.evaluate((el) => el.click());
  } catch (e) {
    return fail(`予定ブロックをクリックできませんでした: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }
  const changeBtn = page.locator('.mod_popup_02.js_yotei a:has-text("予定変更")').first();
  await changeBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if ((await changeBtn.count().catch(() => 0)) === 0) {
    return fail('予定ポップアップの「予定変更」ボタンが見つかりません', 'CONFIRMATION_MISMATCH', true);
  }
  try {
    await Promise.all([
      page.waitForSelector('form#scheduleChange, a#delete', { state: 'attached', timeout: 15_000 }).catch(() => {}),
      // ポップアップ背面の予約overlayがpointer eventを保持する画面差分でも、
      // 一意に特定した「予定変更」リンクを確実に開く。
      changeBtn.evaluate((el) => el.click()),
    ]);
  } catch (_e) { /* 下で到達検証 */ }
  await page.waitForSelector('form#scheduleChange', { state: 'attached', timeout: 10_000 }).catch(() => {});
  if ((await page.locator('form#scheduleChange').count().catch(() => 0)) === 0) {
    return fail(`予定変更画面に到達できませんでした (url=${page.url()})`, 'CONFIRMATION_MISMATCH', true);
  }

  // (4) 誤削除防止: 変更画面の日付・開始時刻・スタッフが対象と一致するか検証
  const formCheck = await page.evaluate(
    ({ ymd, hh, mm, staffExt }) => {
      const v = (sel) => document.querySelector(sel)?.value ?? null;
      const date = v('#jsiSchDate') || v('input[name="schDate"]');
      const sh = v('#jsiStartTimeHour') || v('select[name="schStartHour"]');
      const sm = v('#jsiStartTimeMinute') || v('select[name="schStartMinute"]');
      const st = v('select[name="staffId"]');
      return {
        dateOk: !date || date === ymd,
        startOk: (!sh || parseInt(sh, 10) === parseInt(hh, 10)) && (!sm || sm === mm),
        staffOk: !staffExt || !st || st.toUpperCase() === staffExt,
        date, sh, sm, st,
      };
    },
    { ymd: when.yyyymmdd, hh: String(when.hour), mm: String(when.minute).padStart(2, '0'), staffExt },
  ).catch(() => null);
  if (!formCheck || !formCheck.dateOk || !formCheck.startOk || !formCheck.staffOk) {
    return fail(
      `予定変更画面の内容が対象と一致しません (date=${formCheck?.date}, start=${formCheck?.sh}:${formCheck?.sm}, staff=${formCheck?.st})。誤削除を避けるため中止しました。`,
      'CONFIRMATION_MISMATCH', true,
    );
  }

  if (!enableDelete) {
    return { status: 'confirm_only' };
  }

  // (5) 「削除する」(a#delete) をクリック。ネイティブ confirm / HTMLダイアログ両対応。
  const delBtn = page.locator('a#delete').first();
  if ((await delBtn.count().catch(() => 0)) === 0) {
    return fail('「削除する」ボタン(a#delete)が見つかりません', 'UNKNOWN_ERROR', true);
  }
  let nativeDialogAccepted = false;
  let htmlDialogAccepted = false;
  let submitResponse = null;
  const onDialog = async (d) => {
    nativeDialogAccepted = true;
    try { await d.accept(); } catch (_e) { /* noop */ }
  };
  page.on('dialog', onDialog);
  try {
    // 削除POST/Ajaxをクリック前から監視する。以前はクリック例外を握りつぶし、
    // 非表示の .accept を first() で掴んでもそのまま検証へ進んでいたため、実際には
    // 未送信なのに「予定が残っている」とだけ報告していた。
    const responsePromise = page.waitForResponse((res) => {
      const req = res.request();
      return req.method() !== 'GET' && /schedule|yotei|todo/i.test(res.url());
    }, { timeout: 18_000 }).catch(() => null);

    await delBtn.click({ timeout: 12_000 });

    // ページ内HTMLダイアログの可視ボタンだけを選ぶ。SalonBoardの画面差分に備えて
    // class=accept、文言「はい」「OK」「削除する」のいずれも許容する。
    const yesButtons = page.locator([
      'a.accept:visible',
      'button.accept:visible',
      '.buttons a.accept:visible',
      '.buttons button.accept:visible',
      'a:has-text("はい"):visible',
      'button:has-text("はい"):visible',
      'a:has-text("OK"):visible',
      'button:has-text("OK"):visible',
      'a:not(#delete):has-text("削除する"):visible',
      'button:not(#delete):has-text("削除する"):visible',
      'input[type="button"][value*="はい"]:visible',
      'input[type="submit"][value*="はい"]:visible',
    ].join(', '));
    await yesButtons.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const yesCount = await yesButtons.count().catch(() => 0);
    for (let i = 0; i < yesCount; i += 1) {
      const candidate = yesButtons.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.click({ timeout: 8_000 });
      htmlDialogAccepted = true;
      break;
    }

    // SalonBoardの画面差分でPOST URLが監視条件に一致しなくても、ここで18秒を丸ごと
    // 消費しない。5秒でUI完了確認へ進み、最終的な成功判定は予定の不存在で行う。
    submitResponse = await Promise.race([
      responsePromise,
      page.waitForTimeout(5_000).then(() => null),
    ]);

    // 完了サイン (フォーム離脱 / 完了文言 / エラー領域) を最大10秒ポーリング。
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      if (!/scheduleChange/i.test(page.url())) break;
      const done = await page.locator('text=/削除しました|削除が完了/').first().count().catch(() => 0);
      if (done > 0) break;
      const err = await page.locator('.mod_box_warning, #warningMessageArea, .error, .errorMessage').first().count().catch(() => 0);
      if (err > 0) break;
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const errText = await page.locator('.mod_box_warning, #warningMessageArea, .error, .errorMessage').first().innerText().catch(() => '');
  if (errText && /エラー|失敗|できません/.test(errText)) {
    return fail(`予定削除時にエラー: ${errText.slice(0, 80)}`, 'UNKNOWN_ERROR', true);
  }

  // (6) スケジュール画面に戻って予定が消えたことを検証。
  // SalonBoard側の反映/キャッシュ遅延を考慮し、間隔を空けて最大3回再読込する。
  let lastStill = null;
  let verifyError = null;
  for (const delayMs of [800, 1_800, 3_500]) {
    try {
      await page.waitForTimeout(delayMs);
      const u2 = new URL('/KLP/schedule/salonSchedule/', baseUrl);
      u2.searchParams.set('date', when.yyyymmdd);
      u2.searchParams.set('_kd_verify', String(Date.now()));
      await page.goto(u2.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      // 全予定が消えた直後は表コンテナの高さが0になり :visible 判定を満たさない画面が
      // ある。DOMに接続済みなら findTodo で不存在を確定できる。
      await page.waitForSelector('.jscScheduleMainTableStaff', { state: 'attached', timeout: 12_000 });
      lastStill = await findTodo(false).catch(() => null);
      if (lastStill && !lastStill.ok && (!staffExt || lastStill.staffColFound)) {
        return { status: 'ok', externalId: null };
      }
    } catch (e) {
      verifyError = e;
    }
  }

  const responseStatus = submitResponse ? submitResponse.status() : 'none';
  const diagnostic = {
    nativeDialogAccepted,
    htmlDialogAccepted,
    responseStatus,
    verifyError: verifyError?.message ?? null,
    lastStill,
  };
  const capture = await captureScrapeDebug(page, 'schedule-delete', 'not_confirmed', {
    diagnostics: diagnostic,
  }).catch(() => null);

  if (lastStill && lastStill.ok) {
    return fail(
      `削除操作後もスケジュール上に予定が残っています (nativeDialog=${nativeDialogAccepted}, htmlDialog=${htmlDialogAccepted}, response=${responseStatus}${capture ? `, capture=${capture}` : ''})。自動で再試行します。`,
      'DELETE_NOT_CONFIRMED', false,
    );
  }
  return fail(
    `予定削除後の再確認に失敗しました (response=${responseStatus}, error=${verifyError?.message ?? 'unknown'}${capture ? `, capture=${capture}` : ''})。自動で再試行します。`,
    'DELETE_VERIFY_FAILED', false,
  );
}

// =====================================================================
// 予定変更 (KIREIDOT のブロック予約=休憩/業務の時刻・所要変更)
//
// SalonBoard の「予定」は通常予約の reserve change 画面では変更できない。
// 対象予定をスタッフ+開始時刻(+タイトル)で安全に削除し、KD の現在値で再登録する。
// 削除後に登録が一時失敗しても、次回は delete が alreadyAbsent で成功するため
// 同じ payload の再試行で必ず KD の状態へ収束する。
// =====================================================================
async function changeScheduleViaForm(page, payload, opts = {}) {
  const enableChange = opts.enableChange !== false;
  if (!enableChange) return { status: 'confirm_only' };

  const deleted = await deleteScheduleViaForm(page, payload, {
    baseUrl: opts.baseUrl,
    enableDelete: true,
  });
  if (deleted.status !== 'ok') return deleted;

  return pushScheduleViaForm(page, payload, {
    baseUrl: opts.baseUrl,
    enablePush: true,
  });
}

// =====================================================================
// シフト反映 (KIREIDOT shifts → SalonBoard シフト設定)
//   毎月の受付設定 > シフト設定 (/KLP/set/shiftSetup/?date=YYYYMM) を操作する。
//   実DOM (確認済み 2026-06-12):
//     グリッド: table#shiftSchedule、セル a#W{ext}_{YYYYMMDD}.shiftdate (テキスト=休/パターン名)
//     一括入力: a#batchSetLabel → #batchSetPanel
//       スタッフ: input[name=staffIdList][value=W…]
//       日付:   radio#shiftDateDate + select#shiftDate01..05 (value='01'..'31'、最大5日)
//       出勤:   radio#workdayBatch + select#shiftIdBatch (勤務パターン S…)
//               パターンの時間帯は選択時に div#shiftTextBatch に表示される
//       休日:   radio#holidayBatch
//       実行:   a#batchSet (エラーは #popupErrorMessageBatch)
//     確定:   スタッフ行の a#update1_{ext}_{YYYYMM} (「設定」) → /KLP/ajax/updateShiftSchedules/
//             完了メッセージは #completeMsgArea
//   方針:
//     - KIREIDOTのシフトは任意時刻、SBは勤務パターン選択式 → パターンの時間帯を
//       読み取り、完全一致が無ければ最も近いパターンを選ぶ (warningに記録)。
//     - 「shiftsに行が無い日 = 休み」: payload.entries は全日 work/off で埋まって来る。
//     - 差分のみ反映: セルの現在値 (休/パターン名) と一致する日はスキップ。
//     - 過去日はスキップ (SB側で編集不可/不要)。
//     - enablePush=false なら計画だけ立てて何も書かない (confirm_only)。
// =====================================================================
// SalonBoard の勤務パターン一覧 (シフト設定の一括入力パネル select#shiftIdBatch +
// 選択時の #shiftTextBatch の時間帯表示) を取得する。
// Admin のシフトパターン紐付けUIのデータソース。毎時同期の shifts チャンネルと
// push_shifts 実行時に DB (salonboard_shift_patterns) へ upsert される。
async function scrapeShiftPatterns(page, baseUrl, opts = {}) {
  const base = baseUrl || 'https://salonboard.com/';
  // 勤務パターンは「勤務パターン登録」画面 (/KLP/set/workPatternSetup/) の
  // 登録済み一覧テーブルから取得する。これはシフト設定(毎月の受付設定)の完了に
  // 依存しないので、未設定の月でも取得できる。
  //   実DOM (確認済み 2026-06-12):
  //     登録済みテーブル: #openTimeArea table の各行 (tr)
  //       td[0]=シフト名称, td[1]=短縮名, td[2]=設定時間(span 開始 / span 終了),
  //       削除チェックボックス input[name=deleteShiftIds][value=S…] (=external_id)
  const diag = { tried: [] };
  // グループアカウントはログイン後 /CNC/groupTop/ に居る。この選択をせず設定URLへ
  // 直接遷移すると、別ジャンルの staffSetup や「サロンが選択されていません」へ着地する。
  // fetch_bookings と同様、対象Hコードを選択して店舗文脈を確立してから取得する。
  const ensureTargetSalon = async () => {
    const selectTarget = () => ensureSalonSelected(page, {
      salonId: opts.salonId,
      shopName: opts.shopName,
      genre: opts.genre,
      baseUrl: base,
    }).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
    let selected = await selectTarget();
    // ログイン直後でもグループ選択POSTのセッションが失効する個体がある。
    // 同一ジョブ内でfresh loginし、対象Hコードの選択から一度だけやり直す。
    if (
      !selected.ok
      && /有効期限|expired|ログインしなお|ログインへ/i.test(selected.reason || '')
      && typeof opts.relogin === 'function'
    ) {
      const relogged = await opts.relogin().catch(() => false);
      diag.tried.push({ relogin: relogged, reason: selected.reason });
      if (relogged) selected = await selectTarget();
    }
    diag.tried.push({ salonSelect: selected, url: page.url().replace('https://salonboard.com', '') });
    if (!selected.ok) {
      const capture = await captureScrapeDebug(page, 'shift-patterns', 'group_salon_selection_failed', {
        diagnostics: { salonId: opts.salonId, shopName: opts.shopName, selected, tried: diag.tried },
      }).catch(() => null);
      const err = new Error(
        `グループ店舗のサロン選択に失敗しました (${selected.reason || 'unknown'}${capture ? `, capture=${capture}` : ''})`,
      );
      err.code = 'GROUP_SALON_SELECTION_FAILED';
      err.diag = diag;
      throw err;
    }
    return !!selected.selected;
  };
  if (opts.salonId || opts.shopName) await ensureTargetSalon();

  // 直接URLが groupTop に戻した場合は、対象サロンを選択して同じURLをもう一度開く。
  const gotoInSalonContext = async (path) => {
    await page.goto(new URL(path, base).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (/\/(?:CNC|KLP)\/groupTop/i.test(page.url()) && (opts.salonId || opts.shopName)) {
      const selected = await ensureTargetSalon();
      if (selected) {
        await page.goto(new URL(path, base).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      }
    }
  };
  const isReached = async () =>
    (await page.locator('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]').count().catch(() => 0)) > 0;

  // (1) 直接 goto を複数プレフィックスで試す。
  // hair は月次シフトと同じく /CLP/bt/set 配下にある。
  for (const path of ['/CLP/bt/set/workPatternSetup/', '/KLP/set/workPatternSetup/', '/CNK/set/workPatternSetup/', '/CNB/set/workPatternSetup/']) {
    try {
      await gotoInSalonContext(path);
    } catch (e) {
      diag.tried.push({ path, err: String(e?.message ?? e).slice(0, 60) });
      continue;
    }
    diag.tried.push({ path, url: page.url().replace('https://salonboard.com', '') });
    if (await isReached()) break;
  }

  // (2) 直接で開けない場合: スタッフ設定ページ経由で「勤務パターン登録」リンクを辿る。
  //   勤務パターン登録は「スタッフ設定」配下の画面で、直接URLだと
  //   「情報が一部失われています」で弾かれることがある。
  if (!(await isReached())) {
    for (const staffPath of ['/CLP/bt/set/staffSetup/', '/CNK/set/staffSetup/', '/KLP/set/staffSetup/', '/CNB/set/staffSetup/']) {
      try {
        await gotoInSalonContext(staffPath);
      } catch (_e) { continue; }
      if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) break;
      // 「勤務パターン登録」へのリンク (テキスト or href) を探してクリック
      const link = page
        .locator('a:has-text("勤務パターン"), a[href*="workPatternSetup"]')
        .first();
      if ((await link.count().catch(() => 0)) > 0) {
        await Promise.all([
          page.waitForSelector('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]', { timeout: 15_000 }).catch(() => {}),
          link.click({ timeout: 10_000 }).catch(() => {}),
        ]);
        diag.tried.push({ via: staffPath, url: page.url().replace('https://salonboard.com', '') });
        if (await isReached()) break;
      }
    }
  }

  diag.url = page.url().replace('https://salonboard.com', '');

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    const err = new Error('reCAPTCHA が表示されました');
    err.code = 'RECAPTCHA_REQUIRED';
    throw err;
  }

  // フォーム到達確認 (勤務パターン登録画面)
  const reached = await isReached();
  diag.reached = reached;
  if (!reached) {
    const err = new Error(
      `勤務パターン登録画面を開けませんでした (最終URL=${diag.url})。SalonBoardの「スタッフ設定 > 勤務パターン登録」に手動でアクセスできるか、予約同期くんがログインできているか確認してください。`,
    );
    err.code = 'SHIFT_PATTERNS_UNREACHABLE';
    err.diag = diag;
    throw err;
  }

  // 登録済みパターン行 (削除チェックボックスを持つ) が描画されるまで少し待つ。
  // SBのHTMLは tbody が不正 (<tbody...> が壊れている) なため、closest('tr') が
  // 効かないことがある。チェックボックスから祖先方向に最も近い <tr> を手繰る方式にする。
  await page.waitForSelector('#openTimeArea input[name="deleteShiftIds"], input[name="deleteShiftIds"]', { timeout: 8_000 }).catch(() => {});
  const rows = await page.evaluate(() => {
    const out = [];
    const boxes = Array.from(document.querySelectorAll('input[name="deleteShiftIds"]'));
    const closestRow = (el) => {
      let n = el;
      while (n && n.tagName !== 'TR') n = n.parentElement;
      return n;
    };
    for (const box of boxes) {
      const id = (box.getAttribute('value') || '').trim();
      if (!id) continue;
      const tr = closestRow(box);
      let name = '', shortName = '', timeText = '';
      if (tr) {
        const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD');
        name = (tds[0]?.textContent || '').trim();
        shortName = (tds[1]?.textContent || '').trim();
        const spans = Array.from(tds[2]?.querySelectorAll('span') || []).map((s) => (s.textContent || '').trim());
        timeText = spans.join(' ') || (tds[2]?.textContent || '').trim();
      }
      out.push({ id, name, shortName, timeText });
    }
    return out;
  }).catch(() => []);
  diag.count = rows.length;
  diag.boxCount = await page.locator('input[name="deleteShiftIds"]').count().catch(() => -1);

  const parseRange = (text) => {
    const m = /(\d{1,2})[:時](\d{2})[\s\S]*?(\d{1,2})[:時](\d{2})/.exec(String(text || ''));
    if (!m) return null;
    return {
      start: `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`,
      end: `${String(parseInt(m[3], 10)).padStart(2, '0')}:${m[4]}`,
    };
  };

  const patterns = rows.map((r) => {
    const tr = parseRange(r.timeText);
    return {
      external_id: r.id,
      name: r.name || r.shortName || r.id,
      short_name: r.shortName || '',
      start_time: tr?.start ?? '',
      end_time: tr?.end ?? '',
    };
  });

  // external_id を持つ有効なパターンだけ残す
  const valid = patterns.filter((p) => p.external_id);
  if (valid.length === 0) {
    // boxCount>0 なのに valid=0 = 抽出ロジックの不整合 (画面構造が変わった等)。
    // boxCount=0 = 本当にパターン未登録。区別して案内する。
    const noneRegistered = (diag.boxCount ?? 0) <= 0;
    const err = new Error(
      noneRegistered
        ? `SalonBoardに勤務パターンが1つも登録されていません (url=${diag.url})。SalonBoardの「スタッフ設定 > 勤務パターン登録」でパターン（早番・遅番など）を登録してください。`
        : `勤務パターンの読み取りに失敗しました (画面上には${diag.boxCount}件あるのに抽出できませんでした, url=${diag.url})。`,
    );
    err.code = noneRegistered ? 'SHIFT_PATTERNS_NONE' : 'SHIFT_PATTERNS_PARSE';
    err.diag = diag;
    throw err;
  }

  return { patterns: valid, sourceMonth: null, diag };
}

async function pushShiftsViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const readOnly = p.read_only === true;
  // authoritative=true は KIREIDOT を唯一の正として月全体を収束させるジョブ。
  // この場合、KDで休日/欠損の日はSBも休日へ戻すため、大量休化ガードを適用しない。
  const authoritative = p.authoritative === true;
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const month = String(p.month || '');
  if (!/^\d{6}$/.test(month)) return fail(`push_shifts: month が不正です (${p.month})`, 'UNKNOWN_ERROR', true);
  const entries = Array.isArray(p.entries) ? p.entries : [];
  if (entries.length === 0) {
    return fail('push_shifts: 反映対象スタッフがありません (SalonBoardスタッフ紐付けを確認してください)', 'STAFF_MAPPING_NOT_FOUND', true);
  }

  const toMin = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const parseTimeRange = (text) => {
    const m = /(\d{1,2})[:時](\d{2})\s*[〜~～\-－ー]\s*(\d{1,2})[:時](\d{2})/.exec(String(text || ''));
    if (!m) return null;
    return {
      start: `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`,
      end: `${String(parseInt(m[3], 10)).padStart(2, '0')}:${m[4]}`,
    };
  };
  // 今日 (JST) より前の日はスキップ
  const todayJst = (() => {
    const d = new Date(Date.now() + 9 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  })();

  // ★ジャンル別: シフト設定(毎月の受付設定)のパス接頭辞が異なる。美容室(hair)は /CLP/bt/set 配下、
  //   エステ系は /KLP/set。従来 /KLP 固定だったため ADER/マグ等 hair 店が全滅していた。
  //   加えて hair のグループ店(ADER等)はサロン未選択だと空になるため、groupTop→サロン選択で
  //   店舗文脈を確立してから開く(scrapeHairBookings / pushStaffProfileViaForm と同様)。
  const shiftGenre = opts.genre === 'hair' || p.genre === 'hair' ? 'hair' : 'esthetic';
  const monthlyPrefix = shiftGenre === 'hair' ? '/CLP/bt/set/' : '/KLP/set/';

  // ★hair文脈確立(受付可能数同期 pushAcceptanceViaSchedule と同方式):
  //   ログイン直後(グループ店=/CNC/groupTop、単店=salon top)から ensureSalonSelected
  //   (salonId優先・無ければ shopName一致=fetchと同経路)で対象サロンへ。groupTop は強制 goto
  //   しない(非グループ単店は groupTop で SESSION_EXPIRED)。失効時のみ relogin→groupTop→再選択。
  const selectSalon = async (viaGroupTop) => {
    if (shiftGenre !== 'hair') return;
    if (viaGroupTop) {
      await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }
    await ensureSalonSelected(page, {
      salonId: opts.salonId,
      shopName: opts.shopName,
      genre: shiftGenre,
      baseUrl,
    }).catch(() => {});
  };
  // 「毎月の受付設定」へ。現在文脈のナビリンクをクリック優先(hairは直gotoで失効しやすい)→失敗時 bare-goto。
  const navigateToMonthly = async () => {
    const link = page.locator(`a[href*="${monthlyPrefix}monthlySetup"], a:has-text("毎月の受付設定")`).first();
    if ((await link.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
        link.click({ timeout: 8_000 }).catch(() => {}),
      ]);
    }
    if (!/monthlySetup/.test(page.url())) {
      await page.goto(new URL(monthlyPrefix + 'monthlySetup/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }
  };
  const monthlyState = () => page.evaluate(() => {
    const body = (document.body && document.body.innerText) || '';
    return {
      onMonthly: /シフト設定/.test(body) && /受付設定/.test(body),
      expired: /有効期限|再度ログイン|操作されなかった|指定されたURLは存在しません/.test(body) || !!document.querySelector('input[type="password"]'),
    };
  }).catch(() => ({ onMonthly: false, expired: false }));
  // 「シフト設定」対象月ボタンを複数戦略で探しクリック(esthe/hair 両対応)。
  const tryShiftBtn = async () => {
    const shiftBtn = page.locator(
      `a[href*="hiftSetup"][href*="${month}"], a[onclick*="hiftSetup"][onclick*="${month}"], `
      + `a[href*="shiftSetup/?date=${month}"], a[onclick*="${month}"][onclick*="hift"]`,
    ).first();
    if ((await shiftBtn.count().catch(() => 0)) === 0) return false;
    await Promise.all([
      page.waitForSelector('#shiftSchedule a.shiftdate', { timeout: 12_000 }).catch(() => {}),
      shiftBtn.click({ timeout: 10_000 }).catch(() => {}),
    ]);
    return (await page.locator('#shiftSchedule a.shiftdate').count().catch(() => 0)) > 0;
  };
  const openSetup = async () => {
    // esthetic: 従来の直 shiftSetup?date が最速(月が設定済みなら即到達)。まず試す。
    if (shiftGenre !== 'hair') {
      const u = new URL('/KLP/set/shiftSetup/', baseUrl);
      u.searchParams.set('date', month);
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForSelector('#shiftSchedule a.shiftdate', { timeout: 8_000 }).catch(() => {});
      if ((await page.locator('#shiftSchedule a.shiftdate').count().catch(() => 0)) > 0) return true;
    }
    // 文脈確立→毎月の受付設定→(失効なら relogin+groupTop再選択で1回リトライ)→シフト設定ボタン
    await selectSalon(false);
    await navigateToMonthly();
    let st = await monthlyState();
    if ((st.expired || !st.onMonthly) && typeof opts.relogin === 'function') {
      const ok = await opts.relogin().catch(() => false);
      if (ok) { await selectSalon(true); await navigateToMonthly(); st = await monthlyState(); }
    }
    if (st.onMonthly && await tryShiftBtn()) return true;
    // 到達できたが対象ボタンを掴めない/到達できない → 実DOMダンプ(シフト設定ボタンパターン確定用)
    const snap = await page.evaluate(() => ({
      url: location.pathname,
      onMonthly: /シフト設定/.test((document.body && document.body.innerText) || ''),
      btns: Array.from(document.querySelectorAll('a, input[type="button"], input[type="submit"], button'))
        .filter((e) => /設定|hift|Setup/i.test(((e.textContent || '') + (e.getAttribute('href') || '') + (e.getAttribute('onclick') || '') + (e.value || ''))))
        .slice(0, 16)
        .map((e) => ({ t: ((e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 10)), href: (e.getAttribute('href') || '').slice(0, 64), oc: (e.getAttribute('onclick') || '').slice(0, 64) })),
    })).catch(() => null);
    console.log('[SHIFTDBG monthly ' + shiftGenre + '] ' + JSON.stringify(snap).slice(0, 1400));
    return false;
  };
  try {
    if (!(await openSetup())) {
      // 診断ダンプ: 到達URLとシフト系要素の有無(hair実機の実体をログで確認して次を打つ)
      const diag = await page.evaluate(() => ({
        url: location.pathname + location.search,
        hasShiftSchedule: !!document.querySelector('#shiftSchedule'),
        shiftdateCount: document.querySelectorAll('#shiftSchedule a.shiftdate').length,
        monthlyLinks: Array.from(document.querySelectorAll('a[href*="shiftSetup"]')).slice(0, 6).map((a) => a.getAttribute('href')),
        bodyHead: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 160),
      })).catch(() => null);
      console.log('[SHIFTDBG open-fail ' + shiftGenre + '] ' + JSON.stringify(diag).slice(0, 700));
      return fail(`シフト設定画面 (shiftSetup ${month}, genre=${shiftGenre}) を開けませんでした。「毎月の受付設定」でこの月が設定済みか確認してください。${diag ? ' url=' + diag.url : ''}`, 'UNKNOWN_ERROR', true);
    }
  } catch (e) {
    return fail(`シフト設定画面を開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // (2) 現在のセル値を読む: { 'W..._YYYYMMDD': '休'|パターン名 }
  const readCells = () => page.evaluate(() => {
    const out = {};
    for (const a of document.querySelectorAll('#shiftSchedule a.shiftdate')) {
      const m = (a.id || '').match(/^([A-Z0-9]+)_(\d{8})$/i);
      if (!m) continue;
      out[`${m[1].toUpperCase()}_${m[2]}`] = (a.textContent || '').trim();
    }
    return out;
  });
  let cells;
  try {
    cells = await readCells();
  } catch (e) {
    return fail(`シフト表の読み取りに失敗: ${e?.message ?? e}`, 'UNKNOWN_ERROR', true);
  }

  // シフト表のセルには勤務パターンの「短縮名」だけが表示される
  // (例: 登録名=土日祝早 / 短縮名=休早)。一括入力 select から取れるのは
  // 登録名だけなので、勤務パターン登録画面から external_id→短縮名を取得して
  // 後段で結合する。取得後は月次シフト画面へ戻す。
  let registeredPatternById = new Map();
  try {
    const registered = await scrapeShiftPatterns(page, baseUrl, {
      ...opts,
      genre: shiftGenre,
    });
    registeredPatternById = new Map(
      (registered?.patterns || []).map((pat) => [String(pat.external_id), pat]),
    );
    if (!(await openSetup())) {
      return fail('勤務パターン短縮名の取得後にシフト設定画面へ戻れませんでした', 'UNKNOWN_ERROR', true);
    }
  } catch (e) {
    // 店舗種別や権限により勤務パターン登録画面へ到達できない場合も、従来の
    // 正式名照合と後述の一般的な略称変換で継続する。
    console.warn(`[SHIFT] short-name catalog unavailable: ${e?.message ?? e}`);
    await openSetup().catch(() => false);
  }

  // (3) 一括入力パネルを開いて勤務パターン一覧 (id/name/時間帯) を取得
  //   ★hair(/CLP/bt/schedule/shiftSetup)は DOM は同じ(#batchSetPanel/#batchSetLabel/#shiftIdBatch)だが、
  //   パネルが Playwright の isVisible 判定に乗らないことがある。パネルの可視性ではなく
  //   中身の select#shiftIdBatch が読めるか(=存在)で ready 判定する(esthetic/hair 共通)。
  const ensureBatchPanel = async () => {
    const hasSelect = async () => (await page.locator('#shiftIdBatch').count().catch(() => 0)) > 0;
    if (await hasSelect()) {
      // 時間帯表示(#shiftTextBatch)のためパネルは開けたら開く(開けなくても続行可)。
      if (!(await page.locator('#batchSetPanel').isVisible().catch(() => false))) {
        await page.locator('#batchSetLabel').click({ timeout: 6_000 }).catch(() => {});
        await page.locator('#batchSetPanel').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
      }
      return true;
    }
    await page.locator('#batchSetLabel').click({ timeout: 8_000 }).catch(() => {});
    await page.locator('#batchSetPanel').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    return await hasSelect();
  };
  if (!(await ensureBatchPanel())) {
    // ★hairのシフト設定UIは esthetic と id が違う可能性。実DOMを一括ダンプして次で正確に対応する。
    const dump = await page.evaluate(() => {
      const pick = (e) => ({ tag: e.tagName.toLowerCase(), id: e.id || '', cls: (typeof e.className === 'string' ? e.className : '').split(/\s+/).slice(0, 2).join('.'), t: ((e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 14)) });
      return {
        url: location.pathname + location.search,
        ids: Array.from(document.querySelectorAll('[id]')).map((e) => e.id).filter((x) => /atch|hift|anel|yotei|update|work|pattern|Set/i.test(x)).slice(0, 30),
        selects: Array.from(document.querySelectorAll('select')).slice(0, 8).map((e) => ({ id: e.id, name: e.name, opts: e.options.length })),
        labelBtns: Array.from(document.querySelectorAll('a, button, label, input[type="button"]')).filter((e) => /一括|入力|パターン|設定|出勤|休/.test((e.textContent || e.value || ''))).slice(0, 16).map(pick),
        shiftTable: !!document.querySelector('#shiftSchedule'),
        firstRowIds: Array.from(document.querySelectorAll('#shiftSchedule a.shiftdate')).slice(0, 3).map((a) => a.id),
      };
    }).catch(() => null);
    console.log('[SHIFTDBG setUI ' + shiftGenre + '] ' + JSON.stringify(dump).slice(0, 1600));
    return fail('一括入力パネル (#batchSetPanel) を開けませんでした', 'UNKNOWN_ERROR', true);
  }
  // 一括入力パネルの select#shiftIdBatch から勤務パターン(id/name/時間帯)を読む。
  //   時間帯は各optionを選択→#shiftTextBatch表示をパースして得る。
  //   ★不足パターンをSBに新規登録した後に再取得するため関数化(B: KD時刻直書き)。
  const readBatchPatterns = async () => {
    const list = await page.evaluate(() => {
      const sel = document.querySelector('#shiftIdBatch');
      if (!sel) return null;
      return Array.from(sel.options).filter((o) => o.value).map((o) => ({ id: o.value, name: (o.textContent || '').trim() }));
    }).catch(() => null);
    if (!list) return null;
    for (const pat of list) {
      const registered = registeredPatternById.get(String(pat.id));
      pat.shortName = String(registered?.short_name || '').trim();
      await page.evaluate((id) => {
        const sel = document.querySelector('#shiftIdBatch');
        if (!sel) return;
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, pat.id).catch(() => {});
      await page.waitForTimeout(250);
      const txt = await page.locator('#shiftTextBatch').innerText().catch(() => '');
      const tr = parseTimeRange(txt);
      if (tr) { pat.start = tr.start; pat.end = tr.end; }
    }
    return list;
  };
  let patterns = await readBatchPatterns();
  if (!patterns || patterns.length === 0) {
    return fail('勤務パターン一覧 (select#shiftIdBatch) を取得できませんでした', 'UNKNOWN_ERROR', true);
  }
  const timeKey = (s, e) => `${s}-${e}`;
  const normalizePatternLabel = (value) => String(value || '').replace(/[\s　]+/g, '').trim();
  let shortNameCounts = new Map();
  const rebuildShortNameCounts = () => {
    shortNameCounts = new Map();
    for (const pat of patterns) {
      const short = normalizePatternLabel(pat.shortName || pat.short_name);
      if (short) shortNameCounts.set(short, (shortNameCounts.get(short) || 0) + 1);
    }
  };
  const hasUniqueShortName = (pat) => {
    const short = normalizePatternLabel(pat?.shortName || pat?.short_name);
    return !short || shortNameCounts.get(short) === 1;
  };
  rebuildShortNameCounts();
  let timedPatterns = patterns.filter((x) => x.start && x.end);
  let patternById = new Map(patterns.map((x) => [String(x.id), x]));
  // 同じ短縮名が複数時間帯に使われているパターンは、月次表の表示だけでは
  // どの時間帯か判別不能。誤って「一致」とみなさず、一意な短縮名の新規パターンへ移行する。
  let patternByTime = new Map(
    timedPatterns.filter(hasUniqueShortName).map((x) => [timeKey(x.start, x.end), x]),
  );

  const warnings = [];
  // サマリ/戻り値用の集計 (要登録件数・自動登録成功件数)。
  let neededPatternCount = 0;
  let registeredCount = 0;

  // ── ★B(根治): KD時刻を直接SBへ。exact(開始・終了が完全一致)するSB勤務パターンが
  //    無いKD時刻は、その場でSBに新規登録(KD→SB一方向)し、以後 exact で割り当てる。
  //    これで fetch_shift_patterns / matched_preset_id 依存と、近似(予定方式/covers:false)
  //    を撤廃し、常に KDの正しい時刻を SB へ書けるようにする。作成は enablePush 時のみ。
  const ensureKdPatterns = async () => {
    const needed = new Map(); // 'HH:MM-HH:MM' -> {start,end}
    for (const entry of entries) {
      for (const day of entry.days || []) {
        if (!day || day.kind !== 'work') continue;
        const date = String(day.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayJst) continue;
        if (!/^\d{1,2}:\d{2}$/.test(String(day.start || '')) || !/^\d{1,2}:\d{2}$/.test(String(day.end || ''))) continue;
        const k = timeKey(day.start, day.end);
        if (!patternByTime.has(k)) needed.set(k, { start: day.start, end: day.end });
      }
    }
    console.log('[SHIFT-B] enablePush=' + enablePush + ' entries=' + entries.length
      + ' live=' + JSON.stringify(timedPatterns.map((p) => `${p.start}-${p.end}`))
      + ' needed=' + JSON.stringify(Array.from(needed.keys())));
    neededPatternCount = needed.size;
    if (needed.size === 0) return;
    if (!enablePush) {
      for (const { start, end } of needed.values()) warnings.push(`要SB勤務パターン新規登録: ${start}-${end} (KD時刻・確認のみ)`);
      return;
    }
    // ★SB「短縮名」は半角英数記号あわせて2文字以内。8桁コードは弾かれる(実機確認)。
    //   一意な2文字コードを割当てる(セル表示用)。名称(maxlength40)は可読な KD HH:MM-HH:MM。
    const usedShortNames = new Set(
      patterns.map((pat) => normalizePatternLabel(pat.shortName || pat.short_name)).filter(Boolean),
    );
    let shortSeq = 1;
    const nextUniqueShortName = () => {
      while (shortSeq < 36 * 36) {
        const candidate = shortSeq.toString(36).toUpperCase().padStart(2, '0').slice(-2);
        shortSeq++;
        if (!usedShortNames.has(candidate)) {
          usedShortNames.add(candidate);
          return candidate;
        }
      }
      throw new Error('勤務パターン短縮名の空きがありません');
    };
    const toCreate = Array.from(needed.values()).map(({ start, end }) => ({
      // SalonBoard のシフト名称は実機上10文字まで。従来の
      // `KD 11:00-16:30` は `KD 11:00-1` に切られ、11:00開始の別パターン
      // (例 11:00-19:30) と名称重複して登録できなかった。
      // HHMMを連結した固定10文字なら、開始・終了の組み合わせごとに一意になる。
      name: `KD${start.replace(':', '')}${end.replace(':', '')}`,
      short_name: nextUniqueShortName(),
      start, end,
    }));
    const cr = await pushWorkPatternViaForm(page, { patterns: toCreate }, { ...opts, enablePush: true, baseUrl }).catch((e) => ({ status: 'failed', error: String(e), results: [] }));
    const createFailures = [];
    for (const r of (cr?.results || [])) {
      if (r.status === 'ok') registeredCount++;
      else if (r.status === 'failed') {
        const msg = `${r.name} (${r.reason || ''})`;
        createFailures.push(msg);
        warnings.push(`勤務パターン新規登録に失敗: ${msg}`);
      }
    }
    if (cr?.status === 'failed' && createFailures.length === 0) {
      createFailures.push(String(cr?.reason || cr?.error || '原因不明'));
    }
    if (createFailures.length > 0) {
      const err = new Error(`勤務パターンを登録できませんでした: ${createFailures.join(' | ')}`);
      err.code = 'SHIFT_PATTERN_CREATE_FAILED';
      throw err;
    }
    if (registeredCount > 0) {
      warnings.push(`SBに無かった勤務パターン ${registeredCount}件を自動登録しました: ${toCreate.map((p) => p.name).join(', ')}`);
    }
    // 作成後: シフト設定画面へ戻り、パターン一覧とセルを再取得。
    if (!(await openSetup())) {
      warnings.push('不足勤務パターン登録後にシフト設定画面へ戻れませんでした(今回は既存パターンのみで反映)');
      return;
    }
    await ensureBatchPanel();
    const re = await readBatchPatterns();
    if (re && re.length) {
      patterns = re;
      timedPatterns = patterns.filter((x) => x.start && x.end);
      patternById = new Map(patterns.map((x) => [String(x.id), x]));
      rebuildShortNameCounts();
      patternByTime = new Map(
        timedPatterns.filter(hasUniqueShortName).map((x) => [timeKey(x.start, x.end), x]),
      );
    }
    cells = await readCells().catch(() => cells);
  };
  try {
    await ensureKdPatterns();
  } catch (e) {
    return fail(
      `${e?.message || '勤務パターンの自動登録に失敗しました'}。予定方式へ切り替えず停止しました。`,
      e?.code || 'SHIFT_PATTERN_CREATE_FAILED',
      true,
    );
  }
  // DB保存用 (worker-process が salonboard_bulk_upsert_shift_patterns へ upsert する)
  const patternsOut = patterns.map((x) => ({
    external_id: x.id,
    name: x.name,
    start_time: x.start ?? '',
    end_time: x.end ?? '',
  }));
  const cellMatchesPattern = (text, pat) => {
    const normalize = normalizePatternLabel;
    const t = normalize(text);
    if (!t || t === '休') return false;
    const names = [
      pat?.name,
      ...(hasUniqueShortName(pat) ? [pat?.shortName, pat?.short_name] : []),
    ]
      .map(normalize)
      .filter(Boolean);
    if (names.some((name) => t === name || name.startsWith(t) || t.startsWith(name))) {
      return true;
    }
    // 短縮名カタログを取得できない店舗向けの安全な既知変換。
    // SB標準運用の「土日祝早→休早」「平日遅→平遅」等を補完する。
    return names.some((name) => {
      const abbreviated = name
        .replace(/土日祝|土日|祝日/g, '休')
        .replace(/平日/g, '平');
      return abbreviated === t;
    });
  };

  // SB→KD実シフト取得。書込み計画へ進まず、現在セルを勤務パターンの
  // 時刻へ解決して返す。空欄は「未設定」であり休みとはみなさない。
  if (readOnly) {
    const entryByExt = new Map(entries.map((entry) => [
      String(entry.staff_external_id || '').toUpperCase(),
      entry,
    ]));
    const shifts = [];
    for (const [key, rawText] of Object.entries(cells)) {
      const m = /^([^_]+)_(\d{4})(\d{2})(\d{2})$/.exec(key);
      if (!m) continue;
      const ext = m[1].toUpperCase();
      const entry = entryByExt.get(ext);
      if (!entry) continue;
      const text = String(rawText || '').trim();
      if (!text) continue;
      const date = `${m[2]}-${m[3]}-${m[4]}`;
      if (text === '休') {
        shifts.push({
          staff_external_id: ext,
          staff_name: entry.staff_name ?? ext,
          shift_date: date,
          start_time: null,
          end_time: null,
          is_off: true,
          note: '休',
        });
        continue;
      }
      const pat = patterns.find((candidate) => cellMatchesPattern(text, candidate));
      if (!pat?.start || !pat?.end) {
        warnings.push(`${entry.staff_name ?? ext} ${date}: 勤務パターン「${text}」の時刻を解決できずスキップ`);
        continue;
      }
      shifts.push({
        staff_external_id: ext,
        staff_name: entry.staff_name ?? ext,
        shift_date: date,
        start_time: pat.start,
        end_time: pat.end,
        is_off: false,
        note: text,
      });
    }
    return {
      status: 'ok',
      summary: `SBシフト ${shifts.length}件取得`,
      shifts,
      warnings,
      patterns: patternsOut,
    };
  }
  // 予定方式のベースパターン選択。
  //   ① シフト時間帯を「包含する」パターンがあれば最小スパンのもの (covers:true)。
  //   ② 包含が無い場合は「シフト時間帯に最も近い」パターンを選ぶ (covers:false)。
  //      近さ = |開始のズレ| + |終了のズレ| が最小。これで KIREIDOT のシフトに
  //      時間帯が一番合うパターンが選ばれる。
  //
  // ⚠️ 旧実装は「包含が無ければ最大スパンのパターン」を機械的に選んでいたため、
  //    例: 12:30-21:30(平日遅+30分) のシフトに対し、スパンがほぼ同じ別系統の
  //    パターン (休日早番 10:00-18:30 等) が選ばれ、SalonBoard に全く違う
  //    「休日の早番」が書き込まれる事故が起きていた。時間帯の近さで選ぶよう修正。
  const chooseBasePattern = (start, end) => {
    const s = toMin(start); const e = toMin(end);
    if (s == null || e == null || timedPatterns.length === 0) return null;
    const covering = timedPatterns.filter((x) => toMin(x.start) != null && toMin(x.end) != null && toMin(x.start) <= s && toMin(x.end) >= e);
    if (covering.length > 0) {
      covering.sort((a, b) => (toMin(a.end) - toMin(a.start)) - (toMin(b.end) - toMin(b.start)));
      return { pattern: covering[0], covers: true };
    }
    // 包含が無い → 時間帯が最も近いパターン (開始のズレ+終了のズレが最小)。
    // 同点なら、シフトをよりカバーする (重なりが大きい) ものを優先。
    const scored = timedPatterns
      .map((x) => {
        const ps = toMin(x.start); const pe = toMin(x.end);
        if (ps == null || pe == null) return null;
        const dist = Math.abs(ps - s) + Math.abs(pe - e);
        const overlap = Math.max(0, Math.min(pe, e) - Math.max(ps, s));
        return { pattern: x, dist, overlap };
      })
      .filter(Boolean)
      .sort((a, b) => (a.dist - b.dist) || (b.overlap - a.overlap));
    if (scored.length === 0) return null;
    return { pattern: scored[0].pattern, covers: false };
  };

  // (4) 差分計画を立てる。
  //   - day.sb_pattern_id (KIREIDOTシフトパターン紐付けで解決済みのSBパターン) が
  //     あればそのパターンで一括入力 (パターンの自動代用はしない)。
  //   - 紐付けが無い時間帯は「予定方式」: 出勤+ベースパターン+予定(時間外ブロック)
  //     を日別モーダル (予定を追加する) で設定する。
  const plans = []; // 一括入力: {staffExt, kind:'off'|'work', patternId|null, patternName, days:['01',...], dates}
  const customPlans = []; // 予定方式: {staffExt, staffName, date, ymd, start, end, base}
  let skipped = 0; let totalChanges = 0;
  // ユーザー報告用: 予定方式(work)で反映した日のうち「SBパターンに無かった
  // (=シフト時刻を包含するパターンが無く近似ベースで入れた)」箇所の明細。
  const outOfPatternDetails = []; // {staffName, date, start, end, baseName, baseStart, baseEnd}
  const knownExts = new Set(Object.keys(cells).map((k) => k.split('_')[0]));
  const staffChanged = new Set();
  for (const entry of entries) {
    const ext = String(entry.staff_external_id || '').toUpperCase();
    if (!ext) continue;
    if (!knownExts.has(ext)) {
      warnings.push(`${entry.staff_name ?? ext}: シフト設定画面にスタッフ列がありません (スキップ)`);
      continue;
    }
    const groups = new Map(); // key → plan
    let entryChanged = false;
    for (const day of entry.days || []) {
      const date = String(day.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayJst) continue;
      const ymd = date.replace(/-/g, '');
      const cur = cells[`${ext}_${ymd}`];
      if (cur === undefined) continue; // セルが無い日 (月外)

      if (day.kind === 'work') {
        // ★B: KD時刻に exact 一致するSBパターンを最優先(ensureKdPatterns で作成済のはず)。
        //    次点で従来の紐付け sb_pattern_id。どちらも無い時のみ従来の近似フォールバックへ。
        const exact = (day.start && day.end) ? patternByTime.get(timeKey(day.start, day.end)) : null;
        const mapped = exact || (day.sb_pattern_id ? patternById.get(String(day.sb_pattern_id)) : null);
        if (mapped) {
          // 紐付け済み/時刻一致パターンで一括入力
          if (cellMatchesPattern(cur, mapped)) { skipped++; continue; }
          const key = `work:${mapped.id}`;
          let plan = groups.get(key);
          if (!plan) {
            plan = { staffExt: ext, staffName: entry.staff_name ?? ext, kind: 'work', patternId: mapped.id, patternName: mapped.name, days: [], dates: [] };
            groups.set(key, plan);
          }
          plan.days.push(ymd.slice(6, 8));
          plan.dates.push(date);
          totalChanges++; entryChanged = true;
        } else {
          // 紐付け無し → 予定方式
          if (day.sb_pattern_id) {
            warnings.push(`${entry.staff_name ?? ext} ${date}: 紐付けパターン(${day.sb_pattern_id})がSalonBoardに見つからないため予定方式で反映`);
          }
          const base = chooseBasePattern(day.start, day.end);
          if (!base) {
            warnings.push(`${entry.staff_name ?? ext} ${date}: 勤務パターンの時間帯を取得できず反映できません (${day.start}〜${day.end})`);
            continue;
          }
          if (!base.covers) {
            // ★Shift Parity: シフト時刻を「包含する」SB勤務パターンが無い日に、最も近い
            //   別時間帯パターンを近似で書き込むと、SBに全く違うシフト時刻が入り
            //   (実例: KD 12:30-21:00 のシフトに SB 10:00-11:00 が入る)、その時間帯の
            //   予約が「受付可能数超過」で失敗する。→ 近似反映はやめ、未反映として
            //   「要・勤務パターン登録」を報告する(誤った時刻でSBを汚さない)。
            warnings.push(`${entry.staff_name ?? ext} ${date}: ${day.start}〜${day.end} を包含するSB勤務パターンが無いため未反映(SBに該当時間帯を含む勤務パターンの登録が必要)`);
            outOfPatternDetails.push({
              staffName: entry.staff_name ?? ext,
              date,
              start: day.start, end: day.end,
              baseName: base.pattern.name,
              baseStart: base.pattern.start, baseEnd: base.pattern.end,
              applied: false,
            });
            skipped++;
            continue;
          }
          customPlans.push({
            staffExt: ext,
            staffName: entry.staff_name ?? ext,
            date, ymd,
            start: day.start, end: day.end,
            base: base.pattern,
          });
          totalChanges++; entryChanged = true;
        }
      } else {
        if (cur === '休') { skipped++; continue; } // 既に休
        const key = 'off';
        let plan = groups.get(key);
        if (!plan) {
          plan = { staffExt: ext, staffName: entry.staff_name ?? ext, kind: 'off', patternId: null, patternName: null, days: [], dates: [] };
          groups.set(key, plan);
        }
        plan.days.push(ymd.slice(6, 8));
        plan.dates.push(date);
        totalChanges++; entryChanged = true;
      }
    }
    if (entryChanged) staffChanged.add(ext);
    plans.push(...groups.values());
  }

  // ★Shift Parity安全ガード(表参道「シフトが消えた」誤解の再発防止):
  //   off-plan(=SBで出勤中の日を「休」にする=実シフトを消す操作)が異常に多い時は、
  //   KDのシフトが不完全なまま push して SB を大量に休化する事故の恐れがある
  //   (掛け持ちスタッフの店舗按分ズレ・KD未入力 等)。閾値超過なら休化(clearing)は
  //   保留し、出勤の追加/更新だけ反映して警告する(=SBの実シフトを消さない)。
  const offClearDays = plans.reduce((n, pl) => n + (pl.kind === 'off' ? pl.days.length : 0), 0);
  const MAX_CLEAR = Number(process.env.SB_SHIFT_MAX_CLEAR ?? 12);
  if (!authoritative && offClearDays > MAX_CLEAR) {
    const detail = plans
      .filter((pl) => pl.kind === 'off' && pl.days.length)
      .map((pl) => `${pl.staffName}:${pl.days.length}日`)
      .join(', ');
    warnings.push(
      `安全ガード: SBの出勤${offClearDays}日分を休化しようとしたため保留(閾値${MAX_CLEAR}日)。`
      + `KDのシフトが不完全でSB実シフトを消す恐れ→休化は反映せず、出勤の追加のみ反映。要KD確認 [${detail}]`,
    );
    for (let i = plans.length - 1; i >= 0; i--) {
      if (plans[i].kind === 'off') { totalChanges -= plans[i].days.length; plans.splice(i, 1); }
    }
  }

  console.log('[SHIFT-B] plan totalChanges=' + totalChanges + ' skipped=' + skipped
    + ' plans=' + plans.length + ' custom=' + customPlans.length
    + ' authoritative=' + authoritative
    + ' cellsSample=' + JSON.stringify(Object.entries(cells).slice(0, 6))
    + ' warn=' + JSON.stringify(warnings.slice(0, 10)));
  if (totalChanges === 0) {
    return { status: 'ok', summary: `変更なし (全${entries.length}名のシフトはSalonBoardと一致)`, changed: 0, warnings, patterns: patternsOut };
  }
  if (!enablePush) {
    return {
      status: 'confirm_only',
      summary: `反映予定 ${totalChanges}件 (パターン一括${totalChanges - customPlans.length}/予定方式${customPlans.length}, スタッフ${staffChanged.size}名, スキップ${skipped}件${neededPatternCount > 0 ? `, 要パターン登録${neededPatternCount}件` : ''})`,
      changed: totalChanges,
      warnings,
      patterns: patternsOut,
    };
  }

  // (5) 一括入力で反映 (5日ずつ)
  const applyChunk = async (plan, chunkDays, firstYmd, expectText) => {
    if (!(await ensureBatchPanel())) throw new Error('一括入力パネルを開けません');
    // スタッフ選択 (対象のみON)。★hair(/CLP/bt)は checkbox 名が stylistIdList、
    //   esthetic は staffIdList。両対応にする(hairで staffIdList だけだと0件=誰も選択されず
    //   一括入力が空振り→セルが変わらない、を実機ADERで確認)。
    const boxes = page.locator('input[name="staffIdList"], input[name="stylistIdList"]');
    const n = await boxes.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = boxes.nth(i);
      const v = ((await b.getAttribute('value').catch(() => '')) || '').toUpperCase();
      await b.setChecked(v === plan.staffExt, { timeout: 5_000 }).catch(() => {});
    }
    // 日付モード + 日付セット
    await page.locator('#shiftDateDate').check({ timeout: 5_000 }).catch(() => {});
    for (let i = 1; i <= 5; i++) {
      await page.selectOption(`#shiftDate0${i}`, chunkDays[i - 1] ?? '').catch(() => {});
    }
    // 出勤/休日
    if (plan.kind === 'work') {
      await page.locator('#workdayBatch').check({ timeout: 5_000 }).catch(() => {});
      await page.selectOption('#shiftIdBatch', plan.patternId).catch(() => {});
    } else {
      await page.locator('#holidayBatch').check({ timeout: 5_000 }).catch(() => {});
    }
    // 「一括入力」クリック → 確認ダイアログ (ネイティブ confirm / ページ内ポップアップ
    // の「OK」「はい」) を承認する。ハンドラ無しだと Playwright が confirm を自動
    // キャンセルしてしまい、何も反映されない。
    const onDialog = async (d) => { try { await d.accept(); } catch (_e) { /* noop */ } };
    page.on('dialog', onDialog);
    try {
      await page.locator('#batchSet').click({ timeout: 10_000 });
      // ページ内HTML確認ダイアログの OK/はい を待ってクリック
      const okBtn = page.locator('a.accept:visible, .buttons a.accept:visible, a:visible:has-text("OK"), button:visible:has-text("OK"), a:visible:has-text("はい")').first();
      await okBtn.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
      if ((await okBtn.count().catch(() => 0)) > 0 && (await okBtn.isVisible().catch(() => false))) {
        await okBtn.click({ timeout: 5_000 }).catch(() => {});
      }
      // 反映待ち: 先頭セルのテキストが期待値になるまでポーリング (最大10秒)
      const cellSel = `#${plan.staffExt}_${firstYmd}`;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        const errVisible = await page.locator('#popupErrorMessageBatch:visible').count().catch(() => 0);
        if (errVisible > 0) {
          const errText = (await page.locator('#popupErrorMessageBatch').innerText().catch(() => '')).trim();
          if (errText) throw new Error(`一括入力エラー: ${errText.slice(0, 100)}`);
        }
        const t = ((await page.locator(cellSel).textContent().catch(() => '')) || '').trim();
        if (plan.kind === 'off' ? t === '休' : t && t !== '休') return;
      }
      // ★一括入力が反映されなかった(hair): batch panel の実DOMをダンプしてセレクタを確定する。
      const dbg = await page.evaluate((sExt) => {
        const cbNames = [...new Set(Array.from(document.querySelectorAll('input[type="checkbox"]')).map((e) => e.name).filter(Boolean))];
        const staffCb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((e) => (e.value || '').toUpperCase() === sExt);
        return {
          staffIdList_n: document.querySelectorAll('input[name="staffIdList"]').length,
          cbNames: cbNames.slice(0, 10),
          radios: [...new Set(Array.from(document.querySelectorAll('input[type="radio"]')).map((e) => e.id || e.name).filter(Boolean))].slice(0, 14),
          holidayBatch: !!document.getElementById('holidayBatch'),
          workdayBatch: !!document.getElementById('workdayBatch'),
          batchSet: !!document.getElementById('batchSet'),
          targetCbName: staffCb ? (staffCb.name || '(noname)') : '(NOT FOUND)',
        };
      }, plan.staffExt).catch(() => null);
      console.log('[SHIFTDBG batch ' + plan.staffExt + '] ' + JSON.stringify(dbg).slice(0, 700));
      // タイムアウトでも致命とせず続行 (最後の検証で拾う)
    } finally {
      page.off('dialog', onDialog);
    }
  };

  try {
    for (const plan of plans) {
      for (let i = 0; i < plan.days.length; i += 5) {
        const chunk = plan.days.slice(i, i + 5);
        const firstYmd = `${month}${chunk[0]}`;
        await applyChunk(plan, chunk, firstYmd);
      }
    }
  } catch (e) {
    return fail(`シフトの一括入力に失敗: ${e?.message ?? e}`, 'UNKNOWN_ERROR', true);
  }

  // パネルを閉じる (セルクリック/「設定」ボタンが隠れないように)
  await page.locator('#batchSetClose').click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);

  // (5b) 予定方式: 紐付けパターンに無い時間帯は、日別モーダルで
  //   出勤 + ベースパターン + 予定(時間外ブロック=受付停止) を設定する。
  //   実DOM: セル a#W{ext}_{YYYYMMDD} クリック → モーダル (form#ajaxForm,
  //   /KLP/ajax/changeShiftSchedule)。#yoteiDate / #staffIdHidden で対象検証可。
  //   出勤 radio#workday + select#shiftId、予定行は #yoteiArea .tblSetInfoBasic
  //   (.jscSchStartHours 等 + input[name=titles])、追加は #yoteiAdd の
  //   「予定を追加する」、行削除は a.mod_btn_delete_04、確定は a#yoteiSet。
  const applyCustomDay = async (cp) => {
    const cellSel = `#${cp.staffExt}_${cp.ymd}`;
    const cell = page.locator(cellSel).first();
    if ((await cell.count().catch(() => 0)) === 0) throw new Error(`セル ${cellSel} が見つかりません`);
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    await cell.click({ timeout: 10_000 });
    await page.waitForSelector('#yoteiSet', { timeout: 8_000 });
    // 誤操作防止: モーダルの対象 (日付/スタッフ) を検証
    const meta = await page.evaluate(() => ({
      date: (document.querySelector('#yoteiDate')?.textContent || '').trim(),
      staff: (document.querySelector('#staffIdHidden')?.textContent || '').trim().toUpperCase(),
    })).catch(() => null);
    if (!meta || (meta.date && meta.date !== cp.ymd) || (meta.staff && meta.staff !== cp.staffExt)) {
      await page.locator('#cancel:visible').click({ timeout: 3_000 }).catch(() => {});
      throw new Error(`モーダルの対象が一致しません (date=${meta?.date}, staff=${meta?.staff})`);
    }
    // 出勤 + ベースパターン
    await page.locator('#workday').check({ timeout: 5_000 }).catch(() => {});
    await page.evaluate((id) => {
      const s = document.querySelector('#shiftId');
      if (!s) return;
      s.value = id;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, cp.base.id).catch(() => {});
    await page.waitForTimeout(250);
    // 既存の予定行を全削除 (再実行時の重複防止)
    for (let i = 0; i < 12; i++) {
      const del = page.locator('#yoteiArea a.mod_btn_delete_04:visible').first();
      if ((await del.count().catch(() => 0)) === 0) break;
      await del.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    // 時間外ブロック (ベースパターンの勤務時間のうち、シフト外の前後) を予定に
    const blocks = [];
    if (toMin(cp.start) > toMin(cp.base.start)) blocks.push({ s: cp.base.start, e: cp.start });
    if (toMin(cp.end) < toMin(cp.base.end)) blocks.push({ s: cp.end, e: cp.base.end });
    for (const b of blocks) {
      await page.locator('#yoteiAdd a.mod_btn_add_06:visible').first().click({ timeout: 8_000 });
      await page.waitForTimeout(250);
      const adjusted = await page.evaluate(({ b, title }) => {
        const rows = Array.from(document.querySelectorAll('#yoteiArea .tblSetInfoBasic'));
        const row = rows[rows.length - 1];
        if (!row) return { ok: false };
        let adjusted = false;
        const setSel = (sel, val) => {
          const el = row.querySelector(sel);
          if (!el) return;
          const opts = Array.from(el.options).map((o) => o.value);
          let v = val;
          if (!opts.includes(v)) {
            // 最も近い選択肢に丸める (選択肢に無い分は adjusted として警告)
            let best = opts[0]; let bd = Infinity;
            for (const o of opts) {
              const d = Math.abs(parseInt(o, 10) - parseInt(val, 10));
              if (Number.isFinite(d) && d < bd) { bd = d; best = o; }
            }
            v = best; adjusted = true;
          }
          el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const [sh, sm] = b.s.split(':');
        const [eh, em] = b.e.split(':');
        setSel('.jscSchStartHours', String(parseInt(sh, 10)));
        setSel('.jscSchStartMinutes', sm);
        setSel('.jscSchEndHours', String(parseInt(eh, 10)));
        setSel('.jscSchEndMinutes', em);
        const t = row.querySelector('input[name="titles"]');
        if (t) {
          t.value = title;
          t.dispatchEvent(new Event('input', { bubbles: true }));
          t.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, adjusted };
      }, { b, title: '時間外' }).catch(() => ({ ok: false }));
      if (!adjusted.ok) throw new Error('予定行の入力に失敗しました');
      if (adjusted.adjusted) {
        warnings.push(`${cp.staffName} ${cp.date}: 予定 ${b.s}〜${b.e} を選択肢に合わせて丸めました`);
      }
    }
    // 確定 → モーダルが閉じる or エラーを待つ
    await page.locator('#yoteiSet').click({ timeout: 8_000 });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      const errVisible = await page.locator('#popupErrorMessage:visible').count().catch(() => 0);
      if (errVisible > 0) {
        const errText = (await page.locator('#popupErrorMessage').innerText().catch(() => '')).trim();
        if (errText) throw new Error(`予定設定エラー: ${errText.slice(0, 100)}`);
      }
      const stillOpen = await page.locator('#yoteiSet:visible').count().catch(() => 0);
      if (stillOpen === 0) return;
    }
    // タイムアウトでも続行 (最後の検証で拾う)。開いたままなら閉じる。
    await page.locator('#cancel:visible').click({ timeout: 3_000 }).catch(() => {});
  };
  try {
    for (const cp of customPlans) {
      await applyCustomDay(cp);
    }
  } catch (e) {
    return fail(`シフトの予定方式入力に失敗: ${e?.message ?? e}`, 'UNKNOWN_ERROR', true);
  }

  // (6) 変更したスタッフごとに「設定」ボタンで確定
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    for (const ext of staffChanged) {
      const btn = page.locator(`#update1_${ext}_${month}`).first();
      if ((await btn.count().catch(() => 0)) === 0) {
        return fail(`スタッフ ${ext} の「設定」ボタンが見つかりません`, 'UNKNOWN_ERROR', true);
      }
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 10_000 }).catch(() => {});
      // ページ内HTML確認ダイアログ (OK/はい) が出る場合は承認 (ネイティブ confirm は onDialog が処理)
      const okBtn = page.locator('a.accept:visible, .buttons a.accept:visible, a:visible:has-text("OK"), button:visible:has-text("OK"), a:visible:has-text("はい")').first();
      await okBtn.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
      if ((await okBtn.count().catch(() => 0)) > 0 && (await okBtn.isVisible().catch(() => false))) {
        await okBtn.click({ timeout: 5_000 }).catch(() => {});
      }
      // 完了メッセージ or エラーを最大15秒待つ
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        const done = await page.locator('#completeMsgArea:visible').count().catch(() => 0);
        if (done > 0) break;
        const err = await page.locator('.mod_box_warning:visible, .errorMessage:visible').count().catch(() => 0);
        if (err > 0) break;
      }
      const errText = (await page.locator('.mod_box_warning:visible, .errorMessage:visible').first().innerText().catch(() => '')).trim();
      if (errText && /エラー|失敗|できません/.test(errText)) {
        return fail(`シフト確定 (設定ボタン) でエラー: ${errText.slice(0, 100)}`, 'UNKNOWN_ERROR', true);
      }
    }
  } finally {
    page.off('dialog', onDialog);
  }

  // (7) 最終検証: ページを開き直して、変更対象の日が期待値になっているか確認。
  //
  // ⚠️ 検証は「一括入力(plans=休/紐付け済みパターン)」のみ厳密にチェックする。
  //   予定方式(customPlans)の日は、SalonBoard のセル表示が「出勤+予定」の合成表示に
  //   なり、ベースパターン名とは一致しない(時刻表記や予定マーク付き等)。実際に
  //   書き込みは成功しているのにセル文字列が想定と異なるため、ここを mismatch に
  //   数えると「予定方式が多い店舗は毎回 全件不一致で failed」になる(本機能の構造的
  //   誤判定。書き込み自体は正しく行われている)。よって予定方式日は検証対象から外し、
  //   反映予定だった件数を warning に残すだけにする。
  let mismatches = 0;
  let batchChecked = 0;
  const mismatchSamples = []; // 診断: {key, expected, kind, actual}
  let afterCellCount = 0;
  try {
    if (await openSetup()) {
      const after = await readCells();
      afterCellCount = Object.keys(after || {}).length;
      for (const plan of plans) {
        for (const ymdDay of plan.days) {
          batchChecked++;
          const key = `${plan.staffExt}_${month}${ymdDay}`;
          const t = (after[key] || '').trim();
          // ★SalonBoard のシフト表セルは勤務パターンの「略称」を表示する
          //   (実測: 平日早→"平早", 平日遅→"平遅", 土日祝早→"休早", 土日祝遅→"休遅")。
          //   一括入力 select の正式名(平日早/土日祝遅)とは文字列一致しないため、
          //   正式名で照合すると書込は正しいのに全件不一致になる(2026-07-05 銀座で発覚)。
          //   略称は SB 側の設定依存で正式名から導出不能(土日祝→休)なので、
          //   検証は「勤務日=非空かつ全休(=休 単独)でない」「休日=休 単独」で行う。
          //   これで未反映(空セル)や 勤務⇄休 の取り違えは検出しつつ、略称誤判定を無くす。
          const ok = plan.kind === 'off' ? (t === '休') : (t !== '' && t !== '休');
          if (!ok) {
            mismatches++;
            if (mismatchSamples.length < 20) {
              mismatchSamples.push({ key, kind: plan.kind, expected: plan.kind === 'off' ? '休' : (plan.patternName || ''), actual: t, present: Object.prototype.hasOwnProperty.call(after, key) });
            }
          }
        }
      }
    }
  } catch (_e) { /* 検証用の再読込失敗は黙認 (確定エラーは上で検出済み) */ }
  if (customPlans.length > 0) {
    warnings.push(`予定方式で反映した ${customPlans.length}件は、SalonBoardのセル表示が出勤+予定の合成表示になるため自動検証の対象外です(書き込みは実施済み)。`);
  }
  // 一括入力(休/紐付けパターン)で不一致があれば失敗。予定方式の件数は分母に含めない。
  if (mismatches > 0) {
    // ★診断: 期待値 vs 実セル値 + グリッド画面を必ず残す。
    //   present=false → セル自体が読めていない(readCells/月/スタッフ列ズレ)。
    //   present=true & actual='' → 書込が乗っていない(Akamai書込ホールド疑い)。
    //   present=true & actual=別パターン名/休 → ラベル不一致(SB表示変更 or パターン取り違え)。
    let cap = '?';
    try {
      cap = await captureScrapeDebug(page, 'shifts', 'verify_mismatch', {
        diagnostics: {
          month, mismatches, batchChecked, afterCellCount,
          sampleMismatches: mismatchSamples,
          plansSummary: plans.map((p) => ({ staffExt: p.staffExt, kind: p.kind, patternName: p.patternName, nDays: p.days.length })),
        },
      });
    } catch (_e) { /* capture失敗は無視 */ }
    return fail(`シフト反映後の検証で ${mismatches}/${batchChecked} 件(一括入力分)が期待値と一致しません。SalonBoardのシフト設定を確認してください。 (cells=${afterCellCount}, sample=${JSON.stringify(mismatchSamples.slice(0, 4))}, capture=${cap})`, 'UNKNOWN_ERROR', true);
  }

  // ユーザー要望の報告: ①対象が何日 ②うちパターンに無かった箇所が何個
  // ③最終的にどの時間になったか。
  const outCount = outOfPatternDetails.length;
  let summary =
    `シフト反映 ${totalChanges}件 (パターン一括${totalChanges - customPlans.length}/予定方式${customPlans.length}, スタッフ${staffChanged.size}名, スキップ${skipped}件${registeredCount > 0 ? `, パターン自動登録${registeredCount}件` : ''}${nativeDialogAccepted ? ', confirm承認' : ''})`;
  if (outCount > 0) {
    const lines = outOfPatternDetails
      .map((d) => `${d.staffName} ${d.date}: 希望 ${d.start}〜${d.end} → 「${d.baseName}」(${d.baseStart}〜${d.baseEnd})に合わせて設定`)
      .join('\n');
    summary +=
      `\n対象 ${totalChanges}件中、SalonBoardのパターンに無かった箇所 ${outCount}件:\n${lines}`;
  }

  return {
    status: 'ok',
    summary,
    changed: totalChanges,
    registeredPatternCount: registeredCount,
    outOfPatternCount: outCount,
    outOfPatternDetails,
    warnings,
    patterns: patternsOut,
  };
}

// 電話番号を SalonBoard が受け付ける国内形式(0始まり・数字のみ)へ正規化する。
// KIREIDOT 側は +81 国際形式(例 +81-70-1455-1257)で保存されることがあり、単純に
// 数字だけ残すと「817014551257」(12桁・0始まりでない)のまま送られ、SalonBoard の
// validation(「※ハイフンなしで入力してください」)に弾かれる(2026-07-22 YG97547036)。
function normalizeJpPhoneDigits(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length <= 11) return digits;
  // 01081/0081 = 国際プレフィックス経由、81 = 国番号のみ。国内 0 始まりへ戻す。
  for (const prefix of ['01081', '0081', '81']) {
    if (!digits.startsWith(prefix)) continue;
    let rest = digits.slice(prefix.length);
    if (!rest.startsWith('0')) rest = `0${rest}`;
    if (rest.length === 10 || rest.length === 11) return rest;
  }
  return digits;
}

async function pushBookingViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const staleTokenRetry = Number(opts.staleTokenRetry || 0);
  const fail = async (reason, errorCode, manualRequired) => {
    // 失敗した「まさにその画面」を撮って result に載せる(per-job=店舗レーン並行でも混線しない)。
    // Slack 通知に添付するため base64 で返す。best-effort(撮影失敗しても登録失敗の返却は継続)。
    let errorCaptureB64 = null;
    try {
      const shot = await Promise.race([
        page.screenshot({ fullPage: false, timeout: 6_000 }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 7_000)),
      ]);
      if (shot && Buffer.isBuffer(shot)) errorCaptureB64 = shot.toString('base64');
    } catch (_e) { /* best-effort */ }
    return { status: 'failed', reason, errorCode, manualRequired, errorCaptureB64 };
  };

  if (!p.booking_id || !p.scheduled_at) {
    return fail('payload missing booking_id or scheduled_at', 'UNKNOWN_ERROR', true);
  }
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  // ★過去時刻の予約: SalonBoard は当日(JST)内なら開始時刻を過ぎていても
  //   警告確認(「予約時間を過ぎていますがよろしいですか？」等)付きで登録/変更を
  //   受け付ける。警告は acceptWarningModal / ネイティブ confirm ハンドラが自動で
  //   OK するため、ここでは「JST で前日以前」の予約だけを弾く。
  //   (2026-07-22 変更: 従来の1時間グレースだと当日内の事後入力・修正が
  //    BOOKING_TIME_PAST で止まっていた。日跨ぎ直後の edge のため1時間グレースも併存。)
  //   scheduled_at は JST ISO(+09:00) の絶対時刻なので、Date で now と直接比較できる(TZ非依存)。
  const PAST_GRACE_MS = 60 * 60 * 1000; // 日跨ぎ直後(前日23時台など)の許容
  const startMs = new Date(p.scheduled_at).getTime();
  const jstDayOf = (ms) => Math.floor((ms + 9 * 60 * 60 * 1000) / 86_400_000);
  if (
    Number.isFinite(startMs)
    && jstDayOf(startMs) < jstDayOf(Date.now())
    && startMs < Date.now() - PAST_GRACE_MS
  ) {
    return fail(
      `予約の開始時刻(${p.scheduled_at})が前日以前のため SalonBoard に登録できません。過去日の予約は SalonBoard へ直接ご登録ください。`,
      'BOOKING_TIME_PAST',
      true,
    );
  }
  if (!p.salonboard_staff_external_id) {
    return fail('SalonBoard スタッフ external_id が未指定です', 'STAFF_MAPPING_NOT_FOUND', true);
  }
  // メニューは任意。SalonBoard 予約フォームの netCouponId は未選択(-)でも登録可能。
  // 指定があれば選び、無ければスキップする (まずメニュー無しで予約を通す方針)。
  const menuTarget = p.salonboard_menu_name || p.menu_name || p.coupon_name || null;
  const kireidotRef = p.kireidot_ref || `KIREIDOT予約ID: ${p.booking_id}`;

  // ★genre 別の予約経路。美容室(hair)=/CLP/bt 配下 / エステ等=/KLP 配下。
  //   従来は /KLP/ 固定で、ヘアのグループ店(郡山)が「SALON BOARD : エラー」に着地していた。
  const genre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const ROOT = reservePathRoot(genre);
  const detailUrlFor = (rid) => `${new URL(baseUrl).origin}${ROOT}/reserve/ext/extReserveDetail/?reserveId=${rid}`;

  const startHH = String(when.hour).padStart(2, '0');
  const startMM = String(when.minute).padStart(2, '0');

  // --- 二重登録防止プリフライト (§6.4) ---
  // payload.preflight_required (孤児再enqueue / 手動「SB連携」リトライ / sweep 再enqueue
  // 時に Admin が付与) の場合のみ、登録フォームを開く前に既存予約を確認する。
  // 既に同予約が存在すれば登録せず「既登録」として成功を返す (= 二重登録を防ぐ)。
  // 通常の新規 push では走らないので速度に影響しない。
  if (p.preflight_required) {
    const okExisting = (reserveId) => ({
      status: 'ok',
      externalId: reserveId,
      detailUrl: detailUrlFor(reserveId),
      confirmed: {
        confirmed_customer_name: p.customer_name ?? null,
        confirmed_staff_name: p.staff_name ?? null,
        confirmed_menu_name: menuTarget,
        confirmed_scheduled_at: p.scheduled_at,
      },
      alreadyExists: true,
    });

    // ① reserveId (external_booking_id) を持っているなら、それで予約詳細を直接開いて
    //    存在確認する。一覧の名前照合と違い顧客名が空でも確実に判定できる (本命)。
    const knownReserveId = p.external_booking_id || null;
    if (knownReserveId) {
      const st = await checkReserveStatusById(page, knownReserveId, { baseUrl }).catch(() => 'unknown');
      if (st === 'active') {
        // 既に有効な予約が SB に存在 → 登録せず reserveId を回収して成功。
        return okExisting(knownReserveId);
      }
      if (st === 'unknown') {
        // 判定できなかった (reCAPTCHA / ページ不安定など)。ここで登録に進むと
        // 既存予約があった場合に二重登録になるため、安全側で人手対応に倒す。
        return fail(
          `既存予約 (reserveId=${knownReserveId}) の存在確認ができませんでした。二重登録防止のため自動登録を見送りました。SalonBoard をご確認ください。`,
          'UNKNOWN_ERROR',
          true,
        );
      }
      // st === 'cancelled' / 'not_found' → SB 上に有効な予約は無い。下の②へ進み、
      // 念のため一覧照合もしてから (無ければ) 新規登録する。
    }

    // ② reserveId が無い / reserveId では見つからなかった場合は、日時+スタッフ+顧客名で
    //    一覧照合する (従来ロジック)。顧客名が空だと特定できないことがある点に注意。
    // 顧客名が空だと一覧の名前照合ができず全件スキャンで詰まる (240s ハングの一因)。
    // 顧客名がある時だけ照合し、無ければ照合をスキップして新規登録へ進む。
    if (p.customer_name && String(p.customer_name).trim()) {
      const existing = await findReserveIdForBooking(page, {
        yyyymmdd: when.yyyymmdd,
        hhmm: when.hhmm,
        staffExt: p.salonboard_staff_external_id,
        customerName: p.customer_name,
      }, { baseUrl }).catch(() => null);
      if (existing) {
        // ★一覧マッチだけで already_exists と断定しない (2026-07-11): 一覧はキャンセル行や
        //   同時刻別客と紛れやすい。詳細ページで「現在も有効な予約か」を最終確認し、
        //   active のときだけ既登録として成功を返す。cancelled/not_found は新規登録へ進む。
        const st = await checkReserveStatusById(page, existing, { baseUrl }).catch(() => 'unknown');
        console.log(`[preflight] 一覧マッチ ${existing} の状態=${st}`);
        if (st === 'active') {
          return okExisting(existing);
        }
        if (st === 'unknown') {
          return fail(
            `既存候補 (reserveId=${existing}) の存在確認ができませんでした。二重登録防止のため自動登録を見送りました。SalonBoard をご確認ください。`,
            'UNKNOWN_ERROR',
            true,
          );
        }
        // cancelled / not_found → 有効な既存予約は無い → 下の新規登録フローへ。
      }
    }
  }

  // --- グループ店舗(hair含む)のサロン選択 ---
  // 郡山(ADER=グループhair)等は先に /CNC/groupTop/ で対象サロンを選び、店舗文脈を
  // 確立してからスケジュール/登録に入る。未選択のままだと「SALON BOARD : エラー」着地。
  await ensureReserveSalonContext(page, baseUrl, opts);

  // --- 重要 ---
  // 登録フォームは rlastupdate (スケジュール画面に埋め込まれたタイムスタンプ) を
  // 付けないと "情報が一部失われています (KPCL017V01)" エラーになる。
  // よって (1) 対象日のスケジュール画面を開き #rlastupdate を取得 →
  //         (2) それを付けて登録フォームを開く。
  // ジャンル別: hair=/CLP/bt/schedule/, エステ=/KLP/schedule/。
  //
  // ★失効の自己回復(2026-07-04 郡山): ジョブ冒頭のログイン確認は通るのに、ここで
  //   「有効期限切れ」を踏むことがある(同一アカウントの他セッション操作等)。その場合は
  //   opts.relogin (worker 提供: logout→fresh login) → サロン再選択で1回だけやり直す。
  let rlastupdate = '';
  const pageExpired = () =>
    page.evaluate(() =>
      /有効期限|再度ログイン|操作されなかった/.test(((document.body && document.body.innerText) || '').replace(/\s+/g, '')),
    ).catch(() => false);
  for (let schedTry = 1; schedTry <= 2; schedTry++) {
    try {
      if (genre === 'hair') {
        // ★美容室(グループ)のセッション維持(実機 郡山で確定):
        //   サロン選択後 /CLP/bt/top/ に居る。日付付き schedule へ直接 goto すると
        //   「有効期限が切れました」= 無効セッション扱いになる。/CLP/bt/top/ の
        //   「本日のスケジュール」リンク(<a href="/CLP/bt/schedule/salonSchedule/">)を
        //   クリックして遷移し(文脈確立)、その画面の #rlastupdate を読む。
        //   rlastupdate は日付非依存の現在時刻トークンなので、対象予約日(未来日)の
        //   登録URLにもそのまま載せてよい。
        const schedLink = page
          .locator('a[href*="/CLP/bt/schedule/salonSchedule"]')
          .first();
        await schedLink.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
        if ((await schedLink.count().catch(() => 0)) > 0) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {}),
            schedLink.click({ timeout: 10_000 }).catch(() => {}),
          ]);
        } else {
          // リンクが無い(単一店 hair 等)ときのみ従来 goto。
          await page.goto(new URL(`${ROOT}/schedule/salonSchedule/`, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        }
      } else {
        // エステ等: 従来どおり日付付き goto で #rlastupdate を取得。
        const schedUrl = new URL(`${ROOT}/schedule/salonSchedule/`, baseUrl);
        schedUrl.searchParams.set('date', when.yyyymmdd);
        // rlastupdate は画面更新の楽観ロック値。Chrome HTTP cache から古いHTMLを
        // 再利用すると、取得直後でも KPCL017V01 になるため毎回固有URLで取得する。
        schedUrl.searchParams.set('_kd_token', String(Date.now()));
        await page.goto(schedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
      }
      // #rlastupdate が出現したら即取得 (networkidle は待たない)。
      await page.waitForSelector('#rlastupdate', { timeout: 12_000 }).catch(() => {});
      rlastupdate = (await page
        .locator('#rlastupdate')
        .first()
        .textContent()
        .catch(() => ''))?.trim() || '';
    } catch (e) {
      if (schedTry === 2 || typeof opts.relogin !== 'function') {
        return fail(`予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
      }
    }
    if (rlastupdate) break; // 取得成功
    // 取れなかった: 失効なら relogin→サロン再選択で1回だけやり直す。
    const expired = await pageExpired();
    console.log(`[pushstep] ${(p.booking_id||'').slice(0,8)} sched try${schedTry} rlastupdate=なし expired=${expired}`);
    if (schedTry === 1 && expired && typeof opts.relogin === 'function') {
      const ok = await opts.relogin().catch(() => false);
      if (ok) {
        await ensureReserveSalonContext(page, baseUrl, opts);
        continue;
      }
    }
    // 診断キャプチャを残してループ終了 (rlastupdate 無しでも下の登録フォーム開きで最終判定)。
    await captureScrapeDebug(page, 'bookings', 'sched_no_rlastupdate', {
      diagnostics: { url: page.url(), title: await page.title().catch(() => ''), genre, schedTry },
    }).catch(() => null);
    break;
  }

  // 登録フォームを URL で開く。ジャンル別ルート + ジャンル別パラメータ。
  //   美容室(hair): /CLP/bt/reserve/ext/extReserveRegist/?date=YYYYMMDD&time=HHMM&stylistId=T...&rlastupdate=...
  //   エステ等     : /KLP/reserve/ext/extReserveRegist/?staffId=..&date=..&rsvHour=..&rsvMinute=..&rlastupdate=..
  const u = new URL(`${ROOT}/reserve/ext/extReserveRegist/`, baseUrl);
  if (genre === 'hair') {
    u.searchParams.set('date', when.yyyymmdd);
    u.searchParams.set('time', `${startHH}${startMM}`);
    u.searchParams.set('stylistId', p.salonboard_staff_external_id);
    if (rlastupdate) u.searchParams.set('rlastupdate', rlastupdate);
  } else {
    u.searchParams.set('staffId', p.salonboard_staff_external_id);
    u.searchParams.set('date', when.yyyymmdd);
    u.searchParams.set('rsvHour', startHH);
    u.searchParams.set('rsvMinute', startMM);
    if (rlastupdate) u.searchParams.set('rlastupdate', rlastupdate);
  }
  try {
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    // ★高速化(要望対応): networkidle(SalonBoardは常時通信で40秒近く待つことがある)を
    //   待たず、入力に必要なフォーム要素が出た時点で即進む。広告/計測の通信完了は待たない。
    await page.waitForSelector(
      'form#extReserveRegist, #regist, textarea#rsvEtc, select#jsiRsvHour',
      { timeout: 15_000 },
    ).catch(() => {});
  } catch (e) {
    const message = String(e?.message ?? e);
    // SalonBoard側の遷移が同時更新で中断された場合は、古いrlastupdateを握ったまま
    // 続行せず、スケジュールから最新トークンを取り直して登録工程を再実行する。
    if (/ERR_ABORTED|frame (?:was )?detached|Target page, context or browser has been closed/i.test(message)
      && staleTokenRetry < 2) {
      await page.waitForTimeout(500 + staleTokenRetry * 500).catch(() => {});
      return pushBookingViaForm(page, payload, {
        ...opts,
        staleTokenRetry: staleTokenRetry + 1,
      });
    }
    return fail(`予約登録フォームを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA on register form', 'RECAPTCHA_REQUIRED', true);
  }
  const formReady =
    (await page.locator('form#extReserveRegist, #regist, textarea#rsvEtc').first().count().catch(() => 0)) > 0;
  if (!formReady) {
    // 実際にどの画面に居るかを診断に含める (原因切り分け用)。
    const diag = await page.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')).map((f) => f.id || f.getAttribute('name') || f.action || '?').slice(0, 5);
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
      return { url: location.href, title: document.title, forms, body };
    }).catch(() => ({ url: page.url(), title: '?', forms: [], body: '?' }));
    // SalonBoardのrlastupdateはスケジュール変更のたびに失効する。同じ店舗で受付操作や
    // 別ジョブが直前に走ると、取得から登録フォーム遷移までの数秒でもKPCL017V01
    // (「他のユーザによって変更」)になる。手動対応へ落とさず、最新トークン取得を含む
    // 登録工程を最初から最大2回やり直す。先頭の既存予約チェックも再実行するため、
    // 直前の試行が実は登録済みだった場合でも二重登録しない。
    const staleToken = /他のユーザによって変更|最新情報を確認|KPCL017V01/i.test(
      `${diag.body || ''} ${diag.url || ''}`,
    );
    if (staleToken && staleTokenRetry < 2) {
      console.log(
        `[pushstep] ${(p.booking_id || '').slice(0, 8)} stale rlastupdate → 全工程再試行 ${staleTokenRetry + 1}/2`,
      );
      await page.waitForTimeout(500 + staleTokenRetry * 500);
      return pushBookingViaForm(page, payload, {
        ...opts,
        staleTokenRetry: staleTokenRetry + 1,
      });
    }
    return fail(
      `予約登録フォームに到達できませんでした (rlastupdate=${rlastupdate || 'なし'})。url=${diag.url} title="${diag.title}" forms=[${(diag.forms || []).join(',')}] body="${diag.body}"`,
      'CONFIRMATION_MISMATCH',
      true,
    );
  }

  console.log(`[pushstep] ${(p.booking_id||'').slice(0,8)} form-ready -> fill staff/time (genre=${genre})`);
  const staffExt = p.salonboard_staff_external_id;
  // 所要(分)。null のときだけ 60 にフォールバック。
  const durMin = (p.duration_min != null && Number.isFinite(Number(p.duration_min)))
    ? Number(p.duration_min)
    : 60;

  if (genre === 'hair') {
    // ★美容室フォーム(実DOM 郡山 BPCL007V01 で確定):
    //   スタイリスト = select[name="stylistId"] (value=T...)
    //   開始時間     = select#rsvTime (name="time", value=HHMM 例 "1100")
    //   施術時間     = select#rsvTermId (name="rsvTerm", value=分 例 "150"→2:30)
    //   ※設備欄(#equipArea)は無い。URLで stylistId/time は既に選択済みだが、rsvTerm は
    //     既定30分のままなので必ず設定する(SB上で30分で登録されるバグの原因だった)。
    const hhmm = `${startHH}${startMM}`;
    await page.evaluate(({ ext, hhmm, dur }) => {
      const setSel = (sel, val) => {
        if (!sel || !Array.from(sel.options).some((o) => o.value === val)) return false;
        sel.value = val;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      setSel(document.querySelector('select[name="stylistId"]'), ext);
      setSel(document.getElementById('rsvTime') || document.querySelector('select[name="time"]'), hhmm);
      const term = document.getElementById('rsvTermId') || document.querySelector('select[name="rsvTerm"]');
      if (term) {
        const want = String(dur);
        if (!setSel(term, want)) {
          // 完全一致 option が無ければ dur 以上で最小(所要が足りない登録を防ぐ)。
          const cand = Array.from(term.options).map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n >= dur).sort((a, b) => a - b)[0];
          if (cand != null) setSel(term, String(cand));
        }
      }
    }, { ext: staffExt, hhmm, dur: durMin }).catch(() => {});
    await page.waitForTimeout(300);
  } else {
    // ===== エステ等(非hair): 従来の salonStaffList/jsiRsvHour/jsiRsvTermHour =====
    // スタッフ指定 (表示 select#salonStaffList + hidden staffId + staffIdList を揃える)。
    const staffSel = page.locator('select#salonStaffList').first();
    if ((await staffSel.count().catch(() => 0)) > 0) {
      await staffSel.selectOption({ value: staffExt }, { timeout: 3_000 }).catch(async () => {
        if (p.staff_name) await staffSel.selectOption({ label: p.staff_name }, { timeout: 3_000 }).catch(() => {});
      });
    }
    await page.evaluate((ext) => {
      const setVal = (el, v) => {
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(document.getElementById('staffId'), ext);
      document.querySelectorAll('input[name="staffId"]').forEach((el) => setVal(el, ext));
      for (const name of ['salonStaffList', 'staffIdList']) {
        const sel = document.querySelector(`select[name="${name}"]`);
        if (sel && Array.from(sel.options).some((o) => o.value === ext)) setVal(sel, ext);
      }
    }, staffExt).catch(() => {});
    // 開始 時/分 + 所要 (jsiRsvTermHour/Minute は分換算: "60"=1時間)。
    const termHourVal = String(Math.floor(durMin / 60) * 60);
    const termMinVal = String(durMin % 60).padStart(2, '0');
    // ★SalonBoard は time/term の change で終了時間を自動再計算する。全 select を JS で直接
    //   セット+change 発火して確実に反映(30分→1時間になる症状の対策)。
    await page.evaluate(
      ({ hh, mm, th, tm }) => {
        const setSel = (id, val) => {
          const el = document.getElementById(id);
          if (!el || !Array.from(el.options).some((o) => o.value === val)) return false;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        setSel('jsiRsvHour', hh);
        setSel('jsiRsvMinute', mm);
        setSel('jsiRsvTermHour', th);
        setSel('jsiRsvTermMinute', tm);
      },
      { hh: String(when.hour), mm: startMM, th: termHourVal, tm: termMinVal },
    ).catch(() => {});
    await page.waitForTimeout(300);
    const termOk = await page.evaluate(({ th, tm }) => {
      const h = document.getElementById('jsiRsvTermHour');
      const m = document.getElementById('jsiRsvTermMinute');
      return !!h && !!m && h.value === th && m.value === tm;
    }, { th: termHourVal, tm: termMinVal }).catch(() => false);
    if (!termOk) {
      await page.locator('select#jsiRsvTermHour').first().selectOption({ value: termHourVal }, { timeout: 2_000 }).catch(() => {});
      await page.locator('select#jsiRsvTermMinute').first().selectOption({ value: termMinVal }, { timeout: 2_000 }).catch(() => {});
    }
  }

  // メニュー = ネット予約クーポン (任意)。menuTarget があれば label 完全一致 →
  // 部分一致で選ぶ。見つからなくても予約自体は続行する (メニュー無しで登録)。
  if (menuTarget) {
    const menuSel = page.locator("select[name='netCouponId']").first();
    if ((await menuSel.count().catch(() => 0)) > 0) {
      let menuFilled = false;
      await menuSel.selectOption({ label: menuTarget }, { timeout: 3_000 }).then(() => { menuFilled = true; }).catch(() => {});
      if (!menuFilled) {
        const val = await menuSel.evaluate((el, target) => {
          const opt = Array.from(el.options).find((o) => (o.textContent || '').includes(target));
          return opt ? opt.value : null;
        }, menuTarget).catch(() => null);
        if (val) await menuSel.selectOption({ value: val }, { timeout: 3_000 }).catch(() => {});
      }
      // 見つからなくてもエラーにせず続行 (メニュー無し予約)
    }
  }

  // 顧客名。SalonBoard は氏名(漢字)に () や数字・記号を許可しないため、使える文字
  // (ひらがな/カタカナ/漢字/英字/中黒・スペース) 以外を除去する。カナは必須なので
  // カタカナ以外を除去し、空なら汎用カナで埋める。
  {
    // 氏名(漢字)用: 日本語(かな/カナ/漢字/長音)+英字+中黒・スペースのみ残す。
    // () 〔〕【】 数字 記号 絵文字 等は除去。
    const cleanName = (s) =>
      String(s || '')
        .replace(/[（）()「」『』【】〔〕\[\]{}<>＜＞]/g, ' ') // 各種カッコ → 空白
        .replace(/[^぀-ゟ゠-ヿ一-鿿々ーA-Za-zＡ-Ｚａ-ｚ・\s]/g, '') // 許可文字以外を除去
        .replace(/\s+/g, ' ')
        .trim();
    // カナ用: 全角カタカナ + 長音 + 中黒のみ。半角カナは全角化しない (簡易) → 除去。
    const cleanKana = (s) =>
      String(s || '')
        .replace(/[^゠-ヿー・\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    // 英字(ローマ字)→全角カタカナ 簡易変換。SBの氏名欄は英字を拒否する(2026-06-30 Makiさん事例:
    // 英字"Maki"で doComplete「まだ登録されていません」が一貫発生)ため、英字を含む氏名
    // (インフルエンサーのハンドル名等)はカナ化して登録可能にする。
    const romaToKata = (roma) => {
      const m = {kya:'キャ',kyu:'キュ',kyo:'キョ',gya:'ギャ',gyu:'ギュ',gyo:'ギョ',sha:'シャ',shu:'シュ',sho:'ショ',sya:'シャ',syu:'シュ',syo:'ショ',jya:'ジャ',jyu:'ジュ',jyo:'ジョ',cha:'チャ',chu:'チュ',cho:'チョ',cya:'チャ',cyu:'チュ',cyo:'チョ',nya:'ニャ',nyu:'ニュ',nyo:'ニョ',hya:'ヒャ',hyu:'ヒュ',hyo:'ヒョ',bya:'ビャ',byu:'ビュ',byo:'ビョ',pya:'ピャ',pyu:'ピュ',pyo:'ピョ',mya:'ミャ',myu:'ミュ',myo:'ミョ',rya:'リャ',ryu:'リュ',ryo:'リョ',fa:'ファ',fi:'フィ',fe:'フェ',fo:'フォ',shi:'シ',chi:'チ',tsu:'ツ',ja:'ジャ',ju:'ジュ',jo:'ジョ',
        ka:'カ',ki:'キ',ku:'ク',ke:'ケ',ko:'コ',ga:'ガ',gi:'ギ',gu:'グ',ge:'ゲ',go:'ゴ',sa:'サ',si:'シ',su:'ス',se:'セ',so:'ソ',za:'ザ',zi:'ジ',ji:'ジ',zu:'ズ',ze:'ゼ',zo:'ゾ',ta:'タ',ti:'チ',tu:'ツ',te:'テ',to:'ト',da:'ダ',di:'ヂ',du:'ヅ',de:'デ',do:'ド',na:'ナ',ni:'ニ',nu:'ヌ',ne:'ネ',no:'ノ',ha:'ハ',hi:'ヒ',fu:'フ',hu:'フ',he:'ヘ',ho:'ホ',ba:'バ',bi:'ビ',bu:'ブ',be:'ベ',bo:'ボ',pa:'パ',pi:'ピ',pu:'プ',pe:'ペ',po:'ポ',ma:'マ',mi:'ミ',mu:'ム',me:'メ',mo:'モ',ya:'ヤ',yu:'ユ',yo:'ヨ',ra:'ラ',ri:'リ',ru:'ル',re:'レ',ro:'ロ',wa:'ワ',wo:'ヲ',
        a:'ア',i:'イ',u:'ウ',e:'エ',o:'オ',n:'ン'};
      const r = String(roma).toLowerCase().replace(/[^a-z]/g, '');
      let out = ''; let i = 0;
      while (i < r.length) {
        let hit = false;
        for (const L of [3, 2, 1]) { const sub = r.substr(i, L); if (m[sub]) { out += m[sub]; i += L; hit = true; break; } }
        if (!hit) { if (r[i] === r[i + 1] && /[bcdfghjklmpqrstvwxyz]/.test(r[i])) { out += 'ッ'; i++; } else { i++; } }
      }
      return out;
    };
    const hiraToKata = (s) => String(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
    // 英字を含む氏名 → 英字部=ローマ字カナ化 / ひらがな=カナ化 / 漢字・カナ・長音=維持。英字無しは素通し。
    const toSafeName = (s) => {
      const str = String(s || '').replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      if (!/[A-Za-z]/.test(str)) return s;
      let out = ''; let i = 0;
      while (i < str.length) {
        const ch = str[i];
        if (/[A-Za-z]/.test(ch)) { let j = i; while (j < str.length && /[A-Za-z]/.test(str[j])) j++; out += romaToKata(str.slice(i, j)); i = j; }
        else { out += hiraToKata(ch); i++; }
      }
      return out || s;
    };

    // 末尾の敬称(さん/様/ちゃん/くん等)を除去。SBは表示時に「様」を付けるため、氏名に
    // 敬称が残ると「マキサン 様 様」のように二重になる(2026-06-30 Makiさん事例)。
    const stripHonorific = (s) =>
      String(s || '')
        .replace(/[\s　]*(さん|サン|ｻﾝ|様|さま|サマ|ちゃん|チャン|君|くん|クン)[\s　]*$/u, '')
        .trim();
    const rawName = stripHonorific((p.customer_name && String(p.customer_name).trim()) || 'ゲスト') || 'ゲスト';
    const cleaned = cleanName(rawName) || 'ゲスト';
    const parts = cleaned.split(/[\s　]+/).filter(Boolean);
    const sei = toSafeName(parts[0] || cleaned || 'ゲスト');
    const mei = toSafeName(parts.slice(1).join('') || '様');
    // カナ: SB-safe 化済の氏名からカナを抽出。無ければ汎用カナ。
    const seiKana = cleanKana(sei) || 'ヨヤク';
    const meiKana = cleanKana(mei) || 'キャクサマ';

    await page.locator('input#nmSei').first().fill(sei, { timeout: 6_000 }).catch(() => {});
    await page.locator('input#nmMei').first().fill(mei, { timeout: 6_000 }).catch(() => {});
    // カナ (必須)
    await page.locator('input#nmSeiKana').first().fill(seiKana, { timeout: 6_000 }).catch(() => {});
    await page.locator('input#nmMeiKana').first().fill(meiKana, { timeout: 6_000 }).catch(() => {});
  }
  if (p.customer_phone) {
    // 電話はハイフン無し数字のみ + 国内0始まり (SB の注意書きに従う。+81形式は 0 始まりへ変換)
    const tel = normalizeJpPhoneDigits(p.customer_phone);
    if (tel) await page.locator('input#tel').first().fill(tel, { timeout: 6_000 }).catch(() => {});
  }
  // 備考 (KIREIDOT予約ID を必ず入れる)
  {
    const notesText =
      p.notes && String(p.notes).includes(kireidotRef)
        ? p.notes
        : `${p.notes ? p.notes + '\n' : ''}${kireidotRef}`;
    await page.locator('textarea#rsvEtc').first().fill(notesText, { timeout: 6_000 }).catch(() => {});
  }

  // 設備(ベッド/席)を割り当てる。
  //   優先順位:
  //     1) payload の salonboard_equipment_external_id (EQ...) に一致する option
  //        = KIREIDOT で紐付けた設備を優先順位ベースで解決した結果
  //     2) payload の salonboard_equipment_name に一致する option (名前一致)
  //     3) 空いている「ベッド/ベット/席」を1台だけ選ぶ
  //   予約登録フォームに設備セクション (#equipArea / select[name="equipIdList"]) があれば、
  //   設備行が無ければ「追加する」(#equipAdd) を押してから選ぶ。
  //   セクションが存在しないフォーム構成でも壊れないよう全工程を try で保護し、
  //   設備欄がある店舗では設備必須。空きが無い・複数行を解除できない場合は登録しない。
  const wantedEquipExtId = (p.salonboard_equipment_external_id || '').trim() || null; // EQ...
  const wantedEquipName = (p.salonboard_equipment_name || '').trim() || null;
  let equipResult = 'なし'; // 'EQ指定' / 'name一致' / 'ベッド設定' / '既存維持' / 'option無し' / 'なし' / 'エラー'
  try {
    // 新規予約フォーム(booking_create)の #equipArea は既定で設備行が無く、
    // 「追加する」(#equipAdd) を押すと equipIdList セレクトを持つ行が生成される。
    const equipSelector = 'select[name="equipIdList"], #equipArea select.equipIdList';
    const hasEquipArea =
      (await page.locator('#equipArea, #equipAdd').first().count().catch(() => 0)) > 0;
    if (hasEquipArea) {
      // 設備行が無ければ「追加する」を押して 1 行作る
      const rowCount = await page.locator(equipSelector).count().catch(() => 0);
      if (rowCount === 0) {
        const addBtn = page.locator('#equipAdd, a[id="equipAdd"]').first();
        if ((await addBtn.count().catch(() => 0)) > 0) {
          await addBtn.click().catch(() => {});
          await page.waitForSelector(equipSelector, { timeout: 5_000 }).catch(() => {});
        }
      }
      // 各設備行セレクトについて、payload の指定設備(EQ/名前)→ベッドの順で選ぶ。
      //   payload で設備が指定されている場合は、既に何か選ばれていても
      //   「正しい設備」へ上書きする (KIREIDOT の割り当てを SB に反映するため)。
      //   payload 指定が無い場合のみ、空行に「ベッド」を入れる従来動作。
      const equipSelects = page.locator(equipSelector);
      const n = await equipSelects.count().catch(() => 0);
      if (n === 0) {
        return await fail('設備必須店舗ですが、予約フォームに設備選択行を作成できませんでした。', 'EQUIPMENT_FULL', true);
      }
      // 予約には設備を1台だけ割り当てる。複数行が残ると同じ予約が複数ベッドを
      // 占有するため、2行目以降は空へ戻す。解除不能なら安全のため送信しない。
      for (let i = 1; i < n; i++) {
        const extra = equipSelects.nth(i);
        const emptyValue = await extra.evaluate((el) => {
          const option = Array.from(el.options).find((o) => !o.value);
          return option ? option.value : null;
        }).catch(() => null);
        if (emptyValue === null) {
          return await fail('複数の設備行があり、余分な設備割当を解除できないため登録を停止しました。', 'EQUIPMENT_FULL', true);
        }
        await extra.selectOption({ value: emptyValue }, { timeout: 3_000 });
        await extra.evaluate((el) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      let setBy = null; // 'EQ' / 'name' / 'bed'
      let setCount = 0;
      let keptCount = 0;
      let noOption = false;
      for (let i = 0; i < 1; i++) {
        const sel = equipSelects.nth(i);
        // option を value(EQ...) と表示名で評価し、希望に最も合う value を選ぶ。
        const pick = await sel.evaluate(
          (el, args) => {
            const { wantId, wantName } = args;
            const opts = Array.from(el.options);
            const norm = (s) => (s || '').replace(/[○×\s]/g, '');
            // option text 先頭の ×(満/その枠で使用不可) が付いた設備は、KIREIDOT が割り当てた
            // ものでも選ばない。競合枠で強制選択すると「設備不足」で doComplete/500 になる
            // (2026-06-30 実機: 佐久田/近田の予約が×ベッド固定割当で弾かれていた)。×なら
            // null を返し、下の ○(空き) フォールバックに任せる。
            const isUnavailable = (o) => /×/.test(o.textContent || '');
            // 1) EQ完全一致 (×は除外)
            if (wantId) {
              const o = opts.find((o) => o.value === wantId && !isUnavailable(o));
              if (o) return { value: o.value, by: 'EQ' };
            }
            // 2) 設備名一致 (×は除外)
            if (wantName) {
              const o = opts.find((o) => norm(o.textContent) === norm(wantName) && !isUnavailable(o));
              if (o) return { value: o.value, by: 'name' };
            }
            return null;
          },
          { wantId: wantedEquipExtId, wantName: wantedEquipName },
        ).catch(() => null);

        if (pick && pick.value) {
          await sel.selectOption({ value: pick.value }, { timeout: 3_000 }).catch(() => {});
          await sel.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
          setBy = pick.by;
          setCount++;
          continue;
        }

        // payload 指定が無い場合: 空き(○)のベッド/席を選ぶ。
        // ⚠️ 追加した設備行は既定で埋まっているベッド(例 ベッド1)が選択済みのことがあり、
        //    それを維持すると「設備の受付可能数を超えて」で登録不可になる (2026-06-25 実機で判明)。
        //    option text は「○ベッド1」「×ベッド1」のように先頭に空き記号(○=空き/×=満)が付くので、
        //    必ず ○ のベッド/席へ上書きする。
        const bedVal = await sel.evaluate((el) => {
          const opts = Array.from(el.options).filter((o) => o.value);
          const isBed = (o) => /ベッド|ベット|席/.test(o.textContent || '');
          // 1) ○(空き)のベッド/席を優先
          let opt = opts.find((o) => isBed(o) && /○/.test(o.textContent || ''));
          // 2) ×(満)でないベッド/席
          if (!opt) opt = opts.find((o) => isBed(o) && !/×/.test(o.textContent || ''));
          // 3) ベッド/席の名前でなくても ○(空き) の設備があれば選ぶ
          if (!opt) opt = opts.find((o) => /○/.test(o.textContent || ''));
          // ×(使用中)しか残っていなければ選ばない。×のまま送信すると doComplete
          // 「まだ登録されていません」の原因不明な失敗になる (2026-07-05 ゆな実例:
          // 全ベッド×の枠で旧実装が「とにかくベッド」で×ベッド1を選んで送信していた)。
          // null を返し、直後の送信前ガードで EQUIPMENT_FULL として確定させる。
          return opt ? opt.value : null;
        }).catch(() => null);
        if (bedVal) {
          await sel.selectOption({ value: bedVal }, { timeout: 3_000 }).catch(() => {});
          await sel.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
          setBy = setBy || 'bed';
          setCount++;
        } else {
          noOption = true;
        }
      }
      equipResult =
        setCount > 0
          ? (setBy === 'EQ' ? `EQ指定(${setCount}行)` : setBy === 'name' ? `name一致(${setCount}行)` : `ベッド設定(${setCount}行)`)
          : noOption ? 'option無し' : keptCount > 0 ? '既存維持' : '行なし';

      // 送信前ガード: いずれかの設備行で ×(使用中) が選択されたまま (全設備×で差し替え先が
      // 無い / SBの既定選択が×のまま) なら、送信しても doComplete「まだ登録されていません」
      // の原因不明な失敗になるだけ (2026-07-05 ゆな実例)。送信せず EQUIPMENT_FULL として
      // 確定させる。fail() のスクショに×の設備プルダウンが写るので満床が一目で分かる。
      const unavailableSelected = await page.evaluate((selCss) => {
        return Array.from(document.querySelectorAll(selCss))
          .map((el) => el.options[el.selectedIndex])
          .filter((o) => o && o.value && /×/.test(o.textContent || ''))
          .map((o) => (o.textContent || '').trim());
      }, equipSelector).catch(() => []);
      if (unavailableSelected.length > 0) {
        return await fail(
          `設備がこの時間帯すべて使用中 (${unavailableSelected.join(' / ')}) のため SalonBoard 側に空きがありません。SB のスケジュールで設備/時間を調整のうえ手動登録してください。`,
          'EQUIPMENT_FULL',
          true,
        );
      }
    }
  } catch (_e) {
    return await fail(`必須設備の割当処理に失敗しました: ${_e?.message ?? _e}`, 'EQUIPMENT_FULL', true);
  }

  // ※ 旧実装はここで body 全文を /空いて|重複/ 等で検索していたが、フォームの
  //    説明文 (例「空いている時間を選択」) に誤反応して、実際は空いていても
  //    SLOT_NOT_AVAILABLE になっていた。空き枠/重複の本当のエラーは「登録する」
  //    送信後にエラー領域に出るので、ここでの事前チェックは廃止する。

  console.log(`[pushstep] ${(p.booking_id||'').slice(0,8)} fields filled (equip=${equipResult}) -> before submit`);
  const confirmed = {
    confirmed_customer_name: p.customer_name ?? null,
    confirmed_staff_name: p.staff_name ?? null,
    confirmed_menu_name: menuTarget,
    confirmed_scheduled_at: p.scheduled_at,
    equip_assigned: equipResult,
  };

  // 診断 (SALONBOARD_PUSH_DIAG=1): 送信前にフォームの検証状態を吐く (登録はしない)。
  // 「doComplete に達するのに予約が作られない=errorInput でクライアント検証が NG」の
  // 原因フィールド特定用。
  if (process.env.SALONBOARD_PUSH_DIAG === '1') {
    const d = await page.evaluate(() => {
      const root = document.querySelector('#extReserveRegist') || document;
      const els = Array.from(root.querySelectorAll('input,select,textarea'));
      const fields = els.map((el) => {
        const errCont = el.closest('.error,.errorArea,[class*="error" i],.mod_form_error') ? 1 : 0;
        const errCls = /error|invalid/i.test(el.className) ? 1 : 0;
        return {
          n: el.name || el.id || el.tagName,
          v: (el.value || '').slice(0, 24),
          req: el.required || el.getAttribute('aria-required') === 'true' ? 1 : 0,
          err: errCont || errCls,
        };
      });
      const msgs = Array.from(
        document.querySelectorAll('.error,.errorMessage,[class*="error" i],.mod_box_warning,.mod_form_error'),
      )
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 12);
      const q = (s) => (document.querySelector(s) || {}).value;
      return {
        errorInput: typeof window.errorInput !== 'undefined' ? window.errorInput : 'undef',
        registOnclick: (document.querySelector('#regist') || {}).getAttribute
          ? document.querySelector('#regist').getAttribute('onclick')
          : null,
        totalFields: fields.length,
        errFields: fields.filter((f) => f.err).map((f) => f.n),
        emptyReq: fields.filter((f) => f.req && !f.v).map((f) => f.n),
        msgs,
        key: {
          staffId: q('#staffId'),
          nmSei: q('#nmSei'),
          nmSeiKana: q('#nmSeiKana'),
          menu: q('#jsiNetCouponId') || q('[name=netCouponId]'),
          rsvHour: q('#jsiRsvHour'),
          termHour: q('#jsiRsvTermHour'),
          equip: q('[name=equipIdList]'),
        },
      };
    }).catch((e) => ({ err: String(e) }));
    console.log('[push][diag] FORM STATE:', JSON.stringify(d).slice(0, 1900));
  }

  if (!enablePush) {
    return { status: 'confirm_only', confirmed };
  }

  // 「登録する」を押す
  const registerBtn = page.locator('a#regist').first();
  if ((await registerBtn.count().catch(() => 0)) === 0) {
    return fail('登録ボタン (登録する) が見つかりません', 'UNKNOWN_ERROR', true);
  }

  // 「登録する」を押すと「予約を登録します。よろしいですか？」という
  // ネイティブ confirm() ダイアログが出る。Playwright は既定でこれを dismiss して
  // しまう (= キャンセル扱い→登録されない) ため、accept (OK) するハンドラを
  // クリック前に登録しておく。1 回限り (登録完了後の別ダイアログは無視させない)。
  let dialogAccepted = false;
  const onDialog = async (d) => {
    dialogAccepted = true;
    try { await d.accept(); } catch (_e) { /* noop */ }
  };
  page.on('dialog', onDialog);

  // ★HTML警告モーダルの自動OK (2026-07-20 ユーザ指示):
  //   スタッフの受付可能数超過/予定重複があると、SalonBoard は「警告」モーダル
  //   (<a class="... accept">OK</a> / <a class="... deny">キャンセル</a>) を出して
  //   登録を止める。運用上「被っていても登録してよい」ため、登録フロー中に
  //   このモーダルが出たら一律で OK (a.accept) を押して続行する。
  //   (キャンセル/変更フローは既存実装が .accept を押している。ここは登録フロー用)
  let warningModalAccepted = false;
  const acceptWarningModal = async () => {
    try {
      const ok = page.locator('.buttons a.accept:visible, a.accept:visible').first();
      if ((await ok.count().catch(() => 0)) > 0) {
        await ok.click({ timeout: 3_000 }).catch(() => {});
        warningModalAccepted = true;
        console.log(`[pushstep] ${(p.booking_id || '').slice(0, 8)} 警告モーダルを自動OK (受付可能数超過/予定重複でも登録続行)`);
        return true;
      }
    } catch (_e) { /* noop */ }
    return false;
  };

  // クラウド対策 (SALONBOARD_FORCE_REGIST=1): 登録ボタンの decoy onclick
  // "errorInput=true;return false" は、クリック時に errorInput=true をセットして
  // SalonBoard の実 submit ハンドラを阻害する。クラウドでは(フォームが valid でも)
  // 検証成功時にこの decoy が除去されず残るため、doComplete に達しても予約が作られない
  // (2026-06-25 実機診断: errorInput=undef・全フィールド valid なのに登録されない)。
  // PC は本フラグ未設定で従来通り。
  if (process.env.SALONBOARD_FORCE_REGIST === '1') {
    await page.evaluate(() => {
      try {
        const b = document.querySelector('#regist');
        if (b) b.removeAttribute('onclick');
        // eslint-disable-next-line no-undef
        window.errorInput = false;
      } catch (_e) { /* noop */ }
    }).catch(() => {});
  }

  const beforeUrl = page.url();
  let finalConfirmClicked = false;
  // Phase3-lite (2026-06-30): 書込submit前の人間化。Akamai は _abck センサーで
  // mouse/timing テレメトリを採点し、機械的な即クリックを bot とみなして高リスクな
  // 登録POSTを間欠的に 500/challenge する(銀座書込500の一因)。submit直前に少量の
  // マウス移動+hover+ランダム間(人間の確認時間)を挟みセンサースコアを上げ書込500を抑える。
  const humanizeBeforeSubmit = async (targetBtn) => {
    const btn = targetBtn || registerBtn;
    const jit = (a, b) => a + Math.floor(Math.random() * (b - a));
    try {
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      // ★Layer2a 人間化強化 (2026-07-08): _abck センサーは移動の軌跡・速度分散・イベント間隔・
      //   スクロールを総合採点する。単調な即クリックを避け、「フォームを読んで最終確認する人間」の
      //   挙動(可変速の複数マウス移動 + 上下スクロール + ボタンへの2段接近 + 長めの確認間)を再現し、
      //   書込POST時のセンサースコアを上げて Akamai の 500/challenge を抑える。
      const moves = jit(3, 6);
      for (let i = 0; i < moves; i++) {
        await page.mouse.move(jit(80, vp.width - 80), jit(120, vp.height - 120), { steps: jit(8, 22) });
        await page.waitForTimeout(jit(90, 420));
        if (i === 1) { await page.mouse.wheel(0, jit(120, 360)).catch(() => {}); await page.waitForTimeout(jit(200, 600)); }
        if (i === 3) { await page.mouse.wheel(0, jit(-260, -80)).catch(() => {}); await page.waitForTimeout(jit(150, 500)); }
      }
      // 登録ボタンへ「近づく→乗る」の2段。人間はボタン付近で一度止まる。
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await page.mouse.move(jit(120, vp.width - 120), jit(120, vp.height - 120), { steps: jit(10, 20) });
      await page.waitForTimeout(jit(200, 600));
      await btn.hover().catch(() => {});
      await page.waitForTimeout(jit(900, 2200)); // 人間の "最終確認" 時間(長め)
    } catch (_e) { /* 人間化は best-effort */ }
  };
  try {
    await humanizeBeforeSubmit();
    await registerBtn.click({ timeout: 15_000 }).catch(() => {});
    // 1回目送信後を最大15秒ポーリング: doComplete(2段階確認ページ) / 一覧遷移(=容量余裕で即完了) /
    // 完了文言・詳細リンク のいずれかが出たら抜ける。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      await acceptWarningModal(); // 警告モーダル(受付可能数超過/予定重複)が出たら一律OKで続行
      if (/doComplete/i.test(page.url())) break;          // 2段階確認ページに到達
      if (!/extReserveRegist/i.test(page.url())) break;   // 一覧/詳細へ遷移 = 即完了
      const done = await page
        .locator("a[href*='extReserveDetail'][href*='reserveId='], text=/完了しました|受け付けました|登録しました/")
        .first().count().catch(() => 0);
      if (done > 0) break;
    }
    // ★2段階確認: doComplete は「！！この予約はまだ登録されていません！！ …問題なければ『登録』を
    //   押してください」という最終確認ページ (容量警告等で出る)。最終「登録」(a#regist) をもう一度
    //   押して確定する。容量に余裕のある予約は1段階で完了するためこのループは即抜ける
    //   (2026-06-25 実機で doComplete=確認ページと判明。worker は従来ここで止まり未登録だった)。
    for (let step = 0; step < 2; step++) {
      // ★doComplete の確認文言は描画/AJAX完了が遅れることがあり、即時1回判定だと
      //   needsFinal=false で素通り→final未クリックのまま後段チェックが
      //   「まだ登録されていません」を検知して SB_REGISTER_INCOMPLETE 空振りになる
      //   (2026-07-18 心斎橋 実機: finalClicked=false かつ final-btn ダンプ無し=ここで素通り)。
      //   doComplete URL に居る間は最大6秒ポーリングして判定する。
      let needsFinal = false;
      const ndl = Date.now() + 6_000;
      while (Date.now() < ndl) {
        await acceptWarningModal(); // 警告モーダルが残っていれば OK で閉じて進める
        needsFinal = await page.evaluate(() => {
          const t = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
          return /まだ登録されていません|問題なければ.{0,6}登録/.test(t);
        }).catch(() => false);
        if (needsFinal) break;
        if (!/doComplete/i.test(page.url())) break; // 完了遷移済み = 確認不要
        await page.waitForTimeout(400);
      }
      if (!needsFinal) break;
      // ★最終「登録」は a#regist 以外の変種がある(2026-07-18 心斎橋: doComplete到達・
      //   「まだ登録されていません」表示なのに a#regist 不在で final未クリック→
      //   SB_REGISTER_INCOMPLETE を無限リトライ)。候補を広めに順に試し、
      //   全滅時は実DOMの登録系要素をログして次の失敗で確実に特定できるようにする。
      const finalBtnSelectors = [
        'a#regist',
        '#regist:visible',
        'input[type="submit"][value*="登録"]:visible, input[type="button"][value*="登録"]:visible, button:has-text("登録する"):visible',
        'a.mod_btn_entry_08:visible, a:has-text("登録する"):visible',
      ];
      let finalBtn = null;
      for (const sel of finalBtnSelectors) {
        const cand = page.locator(sel).first();
        if ((await cand.count().catch(() => 0)) > 0) { finalBtn = cand; break; }
      }
      if (!finalBtn) {
        const dump = await page.evaluate(() => Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
          .filter((e) => /登録|regist|確定|complete/i.test(`${e.textContent || ''} ${e.value || ''} ${e.id || ''} ${e.className || ''}`))
          .slice(0, 12)
          .map((e) => `${e.tagName.toLowerCase()}#${e.id || '-'}.${String(e.className || '').split(/\s+/)[0] || '-'}[${(e.textContent || e.value || '').replace(/\s+/g, '').slice(0, 12)}]${e.offsetParent === null ? ':hidden' : ''}`)
          .join(' | ')).catch(() => 'dump-fail');
        console.log(`[pushstep] ${(p.booking_id || '').slice(0, 8)} doComplete final-btn NOT FOUND: ${dump}`);
        break;
      }
      // ★doComplete の最終「登録」POST も Akamai に採点される。従来ここが機械的な即クリック
      //   だったため、書込500「混み合っている」/「まだ登録されていません」の一因になっていた
      //   (Slack: doComplete を確定できませんでした)。押す前に人間化してセンサースコアを上げる。
      await humanizeBeforeSubmit(finalBtn);
      await finalBtn.click({ timeout: 10_000 }).catch(() => {});
      finalConfirmClicked = true;
      const dl2 = Date.now() + 12_000;
      while (Date.now() < dl2) {
        await page.waitForTimeout(400);
        // 最終「登録」押下後に警告モーダル(受付可能数超過/予定重複)が出るケース。
        // ユーザ運用上「被っていても登録してよい」ため一律 OK で確定する。
        await acceptWarningModal();
        const stillConfirm = await page
          .evaluate(() => /まだ登録されていません/.test(((document.body && document.body.innerText) || '')))
          .catch(() => false);
        if (!stillConfirm) break;
      }
    }
  } finally {
    page.off('dialog', onDialog);
  }

  console.log(`[pushstep] ${(p.booking_id||'').slice(0,8)} submit loop done, url=${page.url()} dialog=${dialogAccepted} finalClicked=${finalConfirmClicked} warnOK=${warningModalAccepted}`);
  // 送信後に SalonBoard の 500/エラーページに着地 = サーバ/Akamai が POST を拒否(一時ブロックの可能性)。
  // 予約は作られていないので manual ではなく「リトライ可能(manualRequired=false)」で返し、
  // バックオフ後に再試行させる(叩き続けてIPフラグを悪化させない)。
  const landedUrl = page.url();
  if (/\/www\/ErrorDocument\/|\/ErrorDocument\/50\d|\/50\d\.html|\/error\b/i.test(landedUrl)) {
    return fail(
      `送信後に SalonBoard のエラーページに着地 (${landedUrl.slice(0, 80)})。一時ブロックの可能性のためバックオフ再試行。`,
      'SB_SERVER_ERROR',
      false,
    );
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('登録後に reCAPTCHA が表示され成否判定不能', 'RECAPTCHA_REQUIRED', true);
  }

  // 送信後のエラー領域だけを見る (body 全文ではなく、エラー専用の要素に限定)。
  // 空き枠不足/重複はここに出る。説明文への誤反応を避ける。
  const errText = await page
    .locator('.mod_box_warning, #warningMessageArea, .error, .errorMessage, [class*="error" i]')
    .first()
    .innerText()
    .catch(() => '');
  if (errText && /空いて|空き|満員|埋ま|重複|登録できません|予約できません|エラー/.test(errText)) {
    if (/空いて|空き|満員|埋ま/.test(errText)) {
      return fail(`SalonBoard側で対象時間が空いていません (${errText.slice(0, 60)})`, 'SLOT_NOT_AVAILABLE', false);
    }
    return fail(`登録時にエラー: ${errText.slice(0, 80)}`, 'UNKNOWN_ERROR', true);
  }

  // SalonBoard の最終確認警告は jQuery UI のモーダルとして表示され、上の
  // エラー専用 selector に入らない店舗がある。ここを見落とすと、明確な
  // 「スタッフ受付可能数超過 / スタッフ予定あり」まで Akamai の一時障害
  // (SB_REGISTER_INCOMPLETE) と誤分類して同じ予約を繰り返し送信してしまう。
  // body 全文を使うのは、この SalonBoard 固有の明確な拒否文言だけに限定する。
  const submitPageText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const capacityExceeded = /スタッフの受付可能数を超えて/.test(submitPageText);
  const scheduleConflict = /入力された振り分け日時にスタッフの予定が入っています/.test(submitPageText);
  if (capacityExceeded || scheduleConflict) {
    // ★エラーメッセージをスクショと一致させる(2026-07-17 ユーザ指摘): 「受付可能数超過」か
    //   「予定重複」かを判別し、可能なら受付可能数の実値も読んで、曖昧な"または"を出さない。
    let capVal = null;
    try {
      capVal = await page.evaluate(() => {
        const m = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').match(/受付可能数[:：\s]*([0-9]+)/);
        return m ? m[1] : null;
      });
    } catch (_e) { /* noop */ }
    // このページ(=受付可能数/予定重複の警告画面)のスクショを撮り、通知の文言と画像を一致させる。
    // ★2026-07-20 以降、この警告は自動OK (acceptWarningModal) で乗り越えて登録を確定する運用。
    //   ここに到達するのは「OKを押しても(または OK ボタンが出ないまま)確定できなかった」場合のみ。
    captureErrorShot(page, capacityExceeded ? 'capacity_exceeded' : 'schedule_conflict');
    const okNote = warningModalAccepted
      ? '警告モーダルの自動OKは押しましたが、登録を確定できませんでした。'
      : '警告モーダルのOKボタンが検出できず、登録を確定できませんでした。';
    const reason = capacityExceeded
      ? `SalonBoard側で担当スタッフの受付可能数超過${capVal != null ? `(受付可能数=${capVal})` : ''}の警告が出ています。${okNote}SalonBoard で直接ご確認ください。`
      : `SalonBoard側で同時刻に担当スタッフの予定(既存予約/ブロック)が入っている警告が出ています。${okNote}SalonBoard で直接ご確認ください。`;
    return fail(reason, 'SLOT_NOT_AVAILABLE', true);
  }

  // 完了画面から reserveId / detail_url
  const afterUrl = page.url();
  // 診断 (SALONBOARD_PUSH_DIAG=1): doComplete 等「送信後ページ」の中身を吐く。
  // 「doComplete に達するのに予約が作られない」原因 (検証エラー文言 vs Akamai 書込拒否) の確定用。
  if (process.env.SALONBOARD_PUSH_DIAG === '1') {
    try {
      const dc = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        body: (document.body && document.body.innerText ? document.body.innerText : '')
          .replace(/\s+/g, ' ')
          .slice(0, 900),
        errs: Array.from(
          document.querySelectorAll('.error,.errorMessage,[class*="error" i],.mod_box_warning,.mod_form_error'),
        )
          .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 12),
        hasForm: !!document.querySelector('#extReserveRegist'),
        detailLink: !!document.querySelector("a[href*='extReserveDetail'][href*='reserveId=']"),
        // doComplete の最終「登録」ボタン候補 (id/text/onclick/表示) を列挙。
        regBtns: Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]'))
          .filter((e) => /登録|確定/.test((e.textContent || e.value || '')) && !/予定/.test(e.textContent || ''))
          .map((e) => ({
            tag: e.tagName,
            id: e.id || '',
            txt: ((e.textContent || e.value || '')).replace(/\s+/g, ' ').trim().slice(0, 16),
            onclick: (e.getAttribute && e.getAttribute('onclick') || '').slice(0, 50),
            vis: !!(e.offsetParent !== null),
          }))
          .slice(0, 8),
      }));
      console.log('[push][diag] POST-SUBMIT PAGE:', JSON.stringify(dc).slice(0, 1900));
    } catch (_e) { /* noop */ }
  }
  let externalId = null;
  let detailUrl = null;
  const detailLink = await page
    .locator("a[href*='extReserveDetail'][href*='reserveId=']")
    .first()
    .getAttribute('href')
    .catch(() => null);
  if (detailLink) {
    detailUrl = detailLink.startsWith('http') ? detailLink : new URL(detailLink, baseUrl).toString();
    const m = detailLink.match(/reserveId=([A-Za-z0-9]+)/);
    if (m) externalId = m[1];
  }
  const doneText = await page.locator('text=/完了しました|受け付けました|登録しました|予約を登録しました/').count().catch(() => 0);
  // ⚠️ doComplete は「成功」ではなく2段階確認ページ。上で最終「登録」を押した後、
  //    まだ確認ページ (「まだ登録されていません」) に居れば未登録 (容量超過で弾かれた等)。
  const stillConfirmPage = await page
    .evaluate(() => /まだ登録されていません/.test(((document.body && document.body.innerText) || '')))
    .catch(() => false);
  // 素の登録フォーム上 (doComplete/確認ページでない) = 送信されていない。
  const stillOnForm = !/doComplete/i.test(afterUrl) && /extReserveRegist/i.test(afterUrl);

  if (!dialogAccepted && stillOnForm) {
    return fail(
      '登録確認ダイアログ (「予約を登録します。よろしいですか？」) を確定できませんでした。',
      'UNKNOWN_ERROR',
      true,
    );
  }
  if (stillConfirmPage) {
    // ★doComplete「まだ登録されていません」= 最終確定が通らなかった。設備満床は送信前ガード
    //   (EQUIPMENT_FULL)で先に弾いているので、ここに来る大半は Akamai の一時的な書込ブロック
    //   (500系)や瞬間的なサーバ競合。実測(2026-07 銀座/郡山)で再投入すると通る(65ac3ea8実証)。
    //   よって恒久拒否(manual)ではなく一過性(retryable)として返し、preflight 付き自動リトライで
    //   良い窓口を引くまで粘る(既に登録済みなら preflight が検出して二重登録しない)。
    //   ※ push_booking のリトライは Admin/jobs が preflight_required を維持するので冪等。
    return fail(
      '登録の最終確認 (doComplete「まだ登録されていません」) を確定できませんでした。SalonBoard の一時的な書込ブロックの可能性のため、preflight 付きで自動再試行します。',
      'SB_REGISTER_INCOMPLETE',
      false,
    );
  }
  // 完了サイン: 詳細リンク / 完了文言 / 2段階目を押して確認ページを抜けた / 一覧等へ遷移。
  const looksDone = !!detailLink || doneText > 0 || finalConfirmClicked || (!stillOnForm && afterUrl !== beforeUrl);
  if (!looksDone) {
    // 完了サインが出なかった。ただし確認ダイアログは受理済み (= 送信はされた) なので、
    // 実際には登録できている可能性が高い。ここで予約一覧を再照合し、対象予約が
    // 見つかれば「登録成功」として扱う。これにより:
    //   (1) 実際は登録済みなのに manual_required に倒れていた誤fail (≒最多失敗) を成功に転換
    //   (2) 成功扱い → 再試行されない → 二重登録を防止
    // (失敗パスでのみ実行するので正常時の速度には影響しない)
    if (dialogAccepted) {
      const target = {
        yyyymmdd: when.yyyymmdd,
        hhmm: when.hhmm,
        staffExt: p.salonboard_staff_external_id,
        staffName: p.staff_name,
        customerName: p.customer_name,
      };
      // ★美容室(hair)は findReserveIdForBooking(エステ用 /KLP/reserve/reserveList/init)へ遷移すると
      //   セッションが「有効期限切れ」になり、後続の hair スクレイプも道連れで失敗する。
      //   hair は最初から genre 対応の scrape で回収する(スケジュール経由・セッション維持)。
      let recovered = genre === 'hair'
        ? await findReserveIdViaScrape(page, target, { baseUrl, genre: 'hair' }).catch(() => null)
        : await findReserveIdForBooking(page, target, { baseUrl }).catch(() => null);
      if (!recovered && genre !== 'hair') recovered = await findReserveIdViaScrape(page, target, { baseUrl, genre: opts.genre }).catch(() => null);
      if (recovered) {
        return {
          status: 'ok',
          externalId: recovered,
          detailUrl: detailUrlFor(recovered),
          confirmed,
          recovered: true,
        };
      }
    }
    return fail(
      `登録ボタンは押しましたが完了を確認できませんでした (dialog=${dialogAccepted}, url=${afterUrl})。SalonBoard で登録状況を確認してください。`,
      'UNKNOWN_ERROR',
      true,
    );
  }

  // 完了画面から reserveId を拾えなかった場合のフォールバック:
  // 予約一覧(reserveList)を対象日で検索し、同開始時刻+同スタッフ(+顧客名)で
  // 一意に決まる行の reserveId を取得する (synced なのに external_booking_id=null を防ぐ)。
  if (!externalId) {
    const target = {
      yyyymmdd: when.yyyymmdd,
      hhmm: when.hhmm,
      staffExt: p.salonboard_staff_external_id,
      staffName: p.staff_name,
      customerName: p.customer_name,
    };
    // ★美容室(hair)はエステ用 reserveList(findReserveIdForBooking=/KLP/...)へ遷移すると
    //   セッションを壊すため使わない。対象日1日をスケジュールスクレイプで回収する
    //   (向井優一 実例: エステ一覧に入って cands=0 + セッション破壊 → 回収失敗していた)。
    let found = genre === 'hair'
      ? await findReserveIdViaScrape(page, target, { baseUrl, genre: 'hair' }).catch(() => null)
      : await findReserveIdForBooking(page, target, { baseUrl }).catch(() => null);
    if (!found && genre !== 'hair') found = await findReserveIdViaScrape(page, target, { baseUrl, genre: opts.genre }).catch(() => null);
    if (found) {
      externalId = found;
      detailUrl = detailUrl || detailUrlFor(found);
    }
  }

  // 登録完了サインが出ている場合は reserveId を回収できなくても成功扱いにする。
  // 再試行による二重登録を避け、IDは後続のメール取込/一括取込で補完する。
  if (!externalId) {
    return {
      status: 'ok',
      externalId: null,
      detailUrl: null,
      confirmed,
      idUnverified: true,
      warning: '登録完了を確認済み。SalonBoard予約IDは後続取込で補完します。',
    };
  }

  return { status: 'ok', externalId, detailUrl, confirmed };
}

// =====================================================================
// スケジュールのポップアップ経由でキャンセルする(2026-07-12 実機DOM確認)。
//   予約詳細への"素の直リンク"は 2026-07-02〜 SB が遮断するため(#fnc_cancelに到達不能)、
//   スケジュール画面で予約ブロックをクリック→ポップアップ(.mod_popup_02)の
//   <a class="btn_schedule_cancel">キャンセル</a> を押す動線を使う(in-context click)。
//   誤キャンセル防止のため、ポップアップ内テキストで対象予約を検証してからのみ操作する:
//     KIREIDOT予約ID(booking_id) 一致 > reserveId 一致 > 顧客名(姓)+開始時刻 一致。
//   キャンセル料ダイアログは「請求しない」(#jsiNotCollectCancelFee)を選ぶ。
// 戻り値: { ok, confirmOnly?, looksCancelled?, already?, reason? }
// =====================================================================
async function cancelViaSchedulePopup(page, p, opts = {}) {
  const genre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const root = genre === 'hair' ? '/CLP/bt' : '/KLP';
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  // dry_run(payload)なら検証のみ(実キャンセルしない)。誤爆防止の実機検証に使う。
  const enableCancel = opts.enableCancel !== false && !(p && p.dry_run);
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return { ok: false, reason: 'invalid scheduled_at' };
  const ymd = when.yyyymmdd;
  const hhmm = `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  const custName = String(p.customer_name || '').trim();
  const family = (custName.split(/[\s　]+/)[0] || custName).trim();
  const bookingId = String(p.booking_id || '').trim();
  const reserveId = String(p.external_booking_id || '').trim();
  if (!custName && !bookingId) return { ok: false, reason: 'no customer_name/booking_id to match' };

  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  const schedUrl = new URL(`${root}/schedule/salonSchedule/?date=${ymd}`, baseUrl).toString();
  await page.goto(schedUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(800);

  const blocks = page.locator(`text=${family}`);
  const n = Math.min(await blocks.count().catch(() => 0), 10);
  if (n === 0) return { ok: false, reason: `schedule: 顧客名(${family})の予約ブロック無し` };

  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.mod_popup_02 .jscDialogCloseBtn:visible, .mod_popup_02 a:has-text("閉じる"):visible').first().click({ timeout: 1_000 }).catch(() => {});
    await blocks.nth(i).click({ timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const popup = page.locator('.mod_popup_02:visible').first();
    if ((await popup.count().catch(() => 0)) === 0) continue;
    const popupText = (await popup.innerText().catch(() => '')) || '';
    const idMatch = !!bookingId && popupText.includes(bookingId);
    const ridMatch = !!reserveId && popupText.includes(reserveId);
    const nameMatch = !!family && popupText.includes(family);
    const timeMatch = popupText.includes(hhmm);
    if (!(idMatch || ridMatch || (nameMatch && timeMatch))) continue;

    await captureScrapeDebug(page, 'cancel', `sched_match_${reserveId || bookingId || i}`, {
      diagnostics: { idMatch, ridMatch, nameMatch, timeMatch, enableCancel, hhmm, family },
    });
    const cancelBtn = popup.locator('a.btn_schedule_cancel:visible').first();
    if ((await cancelBtn.count().catch(() => 0)) === 0) {
      if (/キャンセル済|取消済|ステータス[\s\S]{0,20}(キャンセル|取消)/.test(popupText)) return { ok: true, already: true };
      return { ok: false, reason: 'popup にキャンセルボタン無し(検証済ブロック)' };
    }
    if (!enableCancel) return { ok: true, confirmOnly: true };

    let dialogAccepted = false;
    const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
    page.on('dialog', onDialog);
    try {
      await cancelBtn.click({ timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(1_200);
      // キャンセル料ダイアログ → 「請求しない」。
      const noFee = page.locator('a#jsiNotCollectCancelFee:visible').first();
      if ((await noFee.count().catch(() => 0)) > 0) {
        await noFee.click({ timeout: 6_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }
      // 最終確認(はい/キャンセルする/確定)があれば押す。
      const yes = page.locator('.mod_popup_02 a.accept:visible, a.jscExecuteButton:visible, a:has-text("キャンセルする"):visible, a.accept:visible').first();
      if ((await yes.count().catch(() => 0)) > 0) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
          yes.click({ timeout: 8_000 }).catch(() => {}),
        ]);
        await page.waitForTimeout(1_200);
      }
    } finally {
      page.off('dialog', onDialog);
    }
    await captureScrapeDebug(page, 'cancel', `sched_after_${reserveId || bookingId || i}`, { diagnostics: { dialogAccepted } });
    await page.waitForTimeout(700);
    const after = (await page.locator('body').innerText().catch(() => '')) || '';
    const looksCancelled = /キャンセルしました|取消しました|キャンセルが完了|キャンセル完了/.test(after) || dialogAccepted;
    return { ok: true, looksCancelled };
  }
  return { ok: false, reason: `schedule: 検証に通る予約ブロック無し(顧客=${family}/${hhmm})` };
}

// =====================================================================
// 予約キャンセル (KIREIDOT → SalonBoard)
// reserveId(external_booking_id) をキーに SalonBoard 上の予約をキャンセルする。
//
// 動線 (提供DOMより): スケジュール画面 salonSchedule で予約をクリック →
//   ポップアップ (.mod_popup_02) 内の <a class="btn_schedule_cancel">キャンセル</a>
//   → キャンセル確認 → 確定。
// reserveId から対象予約を特定できないと誤キャンセルの恐れがあるため、
//   ・対象日の salonSchedule を開く
//   ・reserveId を含むリンク/要素を探してクリック (ポップアップを開く)
//   ・btn_schedule_cancel → 確認(confirm/送信) を実行
//   ・各ステップで debug capture を残し、最後にステータスを検証する。
//
// payload: { booking_id, external_booking_id(reserveId), scheduled_at,
//            salonboard_staff_external_id?, staff_name? }
// opts: { baseUrl, enableCancel }   enableCancel=false なら確定せず確認のみ。
//
// 戻り値: { status:'ok' } | { status:'confirm_only' }
//         | { status:'failed', reason, errorCode, manualRequired }
// =====================================================================
async function cancelBookingViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const p = payload || {};
  // dry_run(payload)なら確定せず確認のみ(実機の誤爆防止テスト用)。
  const enableCancel = opts.enableCancel !== false && !(p && p.dry_run);
  const fail = (reason, errorCode, manualRequired) => {
    captureErrorShot(page, `cancel_fail_${errorCode || 'err'}`);
    return { status: 'failed', reason, errorCode, manualRequired };
  };

  // ★方針(2026-07-12 向井さん指摘で判明): 予約詳細は reserveId で一意に開けるため誤爆せず、
  //   キャンセルボタンの ID がネット予約(HotPepper/BF)と電話予約(YG/ext)で違うだけだった:
  //     電話/ext : <a id="fnc_cancel">キャンセルにする</a>
  //     ネット/net: <a id="jsiCancelFeeConfirmButton">キャンセルにする</a>
  //   → 詳細ページ方式を主とし、両IDを許容 + キャンセル料ダイアログ(#jsiNotCollectCancelFee)を処理。
  //   スケジュールのポップアップ経由(cancelViaSchedulePopup)は、reserveId 特定不可時の最終手段に回す。
  let reserveId = (p.external_booking_id || '').trim();

  // reserveId が無い場合 (KIREIDOT で作成→push したが reserveId 未回収の予約等) は、
  // 予約一覧を「予約日 + スタッフ + 顧客名」で検索して reserveId を特定する。
  // これにより「KIREIDOT 軸でキャンセルしても SalonBoard に reserveId が無くて消せない」
  // ケースを救済する。
  if (!reserveId && p.scheduled_at) {
    try {
      // グループ店舗対策: 予約一覧に入る前にサロン選択を確認。
      await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
      const when = parseJstPartsForPush(p.scheduled_at);
      if (when) {
        const target = {
          yyyymmdd: when.yyyymmdd,
          hhmm: `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`,
          staffExt: p.salonboard_staff_external_id || null,
          staffName: p.staff_name || null,
          customerName: p.customer_name || null,
        };
        // 一覧フィルタ版 → ダメなら全件スクレイプ版 (cancelled 除外で確実)。
        let found = await findReserveIdForBooking(page, target, { baseUrl }).catch(() => null);
        if (!found) found = await findReserveIdViaScrape(page, target, { baseUrl, genre: opts.genre }).catch(() => null);
        if (found) {
          reserveId = found;
          // 呼び出し側(worker)が bookings.external_booking_id に焼き直せるよう返す。
          p._recoveredReserveId = found;
        }
      }
    } catch (_e) { /* フォールバック失敗は下の最終チェックで扱う */ }
  }

  if (!reserveId) {
    // DB enqueue 時に「外部IDなし + 過去の push_booking 成功なし」を確認済みなら、
    // SalonBoard に登録されたことがない予約の取消である。検索でも見つからないため、
    // 何も消すものがない冪等成功として収束させる。単に ID が欠損しただけの予約は
    // この明示フラグを持たないので、従来どおり手動確認に止める。
    if (p.assume_absent_if_never_synced === true) {
      return {
        status: 'ok',
        externalId: null,
        alreadyAbsent: true,
        summary: 'cancel_booking: SalonBoard未登録の予約のため取消済みとして確定',
      };
    }
    // reserveId が無いと SalonBoard 上の予約を一意に特定できない。
    // (一覧検索でも見つからない = SalonBoard 上に該当予約が無い可能性が高い)
    return fail('external_booking_id (SalonBoard 予約ID) が無く、予約一覧でも該当予約を特定できませんでした。SalonBoard 上に既に無いか、予約日時/担当が一致しません。', 'RESERVE_NOT_FOUND', true);
  }
  // 1) reserveId で予約詳細ページを直接開く。
  //    実DOM (確認済み):
  //      詳細  : /KLP/reserve/ext/extReserveDetail/?reserveId=YG...
  //              (ネット予約は net/reserveDetail)
  //      キャンセル開始ボタン : <a id="fnc_cancel">キャンセルにする</a>
  //      → ページ内 HTML ダイアログ (confirm() ではない):
  //          「予約をキャンセルにします。よろしいですか？」
  //          <a class="...accept">はい</a> / <a class="...deny">いいえ</a>
  // ジャンル別ルート (登録/変更と同じ: hair=/CLP/bt 配下、エステ=/KLP 配下)。
  const cGenre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const cROOT = reservePathRoot(cGenre);
  // グループ店舗は先にサロン選択で店舗文脈を確立 (未選択だとエラーページ着地)。
  await ensureReserveSalonContext(page, baseUrl, opts);
  const detailCandidates = [
    `${cROOT}/reserve/ext/extReserveDetail/?reserveId=${reserveId}`,
    `${cROOT}/reserve/net/reserveDetail/?reserveId=${reserveId}`,
  ];
  const tryOpenDetail = async () => {
    for (const path of detailCandidates) {
      await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      // ★高速化: networkidleを待たず、キャンセルボタンが出たら即進む。
      await page.waitForSelector('#fnc_cancel, #jsiCancelFeeConfirmButton', { timeout: 10_000 }).catch(() => {});
      if ((await page.locator('#fnc_cancel, #jsiCancelFeeConfirmButton').count().catch(() => 0)) > 0) return true;
      // 冪等: 既にキャンセル済みの詳細ページ(ボタン無し)は有効。エラーページのみ次候補へ。
      const t = (await page.title().catch(() => '')) || '';
      if (!/エラー/.test(t)) {
        const body = (await page.locator('body').innerText().catch(() => '')) || '';
        if (/ステータス[\s\S]{0,30}(キャンセル|取消)/.test(body)) return true;
      }
    }
    return false;
  };
  let onDetail = await tryOpenDetail();
  if (!onDetail) {
    // 失効ページなら relogin (worker提供) で同一ジョブ内復旧を1回試す。
    const expired = await page.evaluate(() =>
      /有効期限|再度ログイン|操作されなかった/.test(((document.body && document.body.innerText) || '').replace(/\s+/g, '')),
    ).catch(() => false);
    if (expired && typeof opts.relogin === 'function') {
      const ok = await opts.relogin().catch(() => false);
      if (ok) {
        await ensureReserveSalonContext(page, baseUrl, opts);
        onDetail = await tryOpenDetail();
      }
    }
  }
  if (!onDetail) {
    // 2026-07-02 夕方から、SB が ext/extReserveDetail への「素の直リンク」を
    // 汎用エラーページ (KPCL009V01) で弾くようになった (電話予約YGのキャンセル7連敗)。
    // 一覧/スケジュールを一度開いてコンテキスト (トークン/Cookie) を作ってから再試行すると
    // 通る (一覧検索を経由した 07-03 23:50 のキャンセルは成功している)。
    // hair はエステ用 reserveList がセッションを壊すため、スケジュール(リンククリック相当の
    // 日付なしURL) で文脈を作る。
    try {
      await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
      const ctxUrl = cGenre === 'hair'
        ? new URL('/CLP/bt/schedule/salonSchedule/', baseUrl).toString()
        : new URL('/KLP/reserve/reserveList/init', baseUrl).toString();
      await page.goto(ctxUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      onDetail = await tryOpenDetail();
    } catch (_e) { /* フォールバック失敗は従来どおり下の判定で fail */ }
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  const cap1 = await captureScrapeDebug(page, 'cancel', `detail_${reserveId}`, {
    diagnostics: { reserveId, onDetail, url: page.url() },
  });

  // 既にキャンセル済みなら成功扱い (冪等)
  const detailText = (await page.locator('body').innerText().catch(() => '')) || '';
  // キャンセルボタンは 電話/ext=#fnc_cancel、ネット/net=#jsiCancelFeeConfirmButton の2系統。
  const CANCEL_BTN = '#fnc_cancel, #jsiCancelFeeConfirmButton';
  if (/ステータス[\s\S]{0,30}(キャンセル|取消)/.test(detailText) && (await page.locator(CANCEL_BTN).count().catch(() => 0)) === 0) {
    return { status: 'ok', externalId: reserveId, recoveredReserveId: p._recoveredReserveId || null };
  }

  const cancelBtn = page.locator(CANCEL_BTN).first();
  if ((await cancelBtn.count().catch(() => 0)) === 0) {
    return fail(`キャンセルボタン(${CANCEL_BTN})が見つかりませんでした (reserveId=${reserveId}${cap1 ? `, capture=${cap1}` : ''})`, 'UNKNOWN_ERROR', true);
  }

  if (!enableCancel) {
    return { status: 'confirm_only' };
  }

  // 2) 「キャンセルにする」をクリック。ネット予約はキャンセル料ダイアログ
  //    (#jsiNotCollectCancelFee=請求しない / #jsiCollectCancelFee=請求する)が出る → 請求しない。
  //    電話予約は HTML ダイアログの「はい」(.accept)。両方に対応。ネイティブ confirm も accept。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmClicked = false;
  try {
    await cancelBtn.click({ timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    // 3a) キャンセル料ダイアログ(出る場合)→「請求しない」。ネット予約は既定で
    //     collectCancelFee=false のまま reserveCancel(キャンセルメール記入)へ遷移する。
    const noFee = page.locator('a#jsiNotCollectCancelFee:visible').first();
    if ((await noFee.count().catch(() => 0)) > 0) {
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}), noFee.click({ timeout: 10_000 }).catch(() => {})]);
      confirmClicked = true;
      await page.waitForTimeout(1_400);
    }
    // 3b) ネット予約(HotPepper): reserveCancel(キャンセルメール記入)の「送信メールを確認する」
    //     (#sendMailConfirm)でメール送信=キャンセル確定。ネイティブ confirm は onDialog で accept。
    const sendMail = page.locator('a#sendMailConfirm, #sendMailConfirm').first();
    if ((await sendMail.count().catch(() => 0)) > 0) {
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {}), sendMail.click({ timeout: 10_000 }).catch(() => {})]);
      confirmClicked = true;
      await page.waitForTimeout(1_800);
      // 送信確認の最終ボタン(モーダルの「送信する」/「はい」)があれば押す。
      const finalSend = page.locator('a.accept:visible, a:visible:has-text("送信する"), a:visible:has-text("はい"), input[type="submit"][value*="送信"]:visible, a.jscExecuteButton:visible').first();
      if ((await finalSend.count().catch(() => 0)) > 0) {
        await Promise.all([page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {}), finalSend.click({ timeout: 10_000 }).catch(() => {})]);
        await page.waitForTimeout(1_500);
      }
    }
    // 3c) 電話/ext予約 or 追加確認: HTML ダイアログの「はい」(.accept)。
    const yesBtn = page.locator('a.accept:visible, .buttons a.accept:visible').first();
    if ((await yesBtn.count().catch(() => 0)) > 0) {
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}), yesBtn.click({ timeout: 10_000 }).catch(() => {})]);
      confirmClicked = true;
      await page.waitForTimeout(1500);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'cancel', `after_${reserveId}`, {
    diagnostics: { reserveId, confirmClicked, nativeDialogAccepted, url: page.url() },
  });

  // 4) 検証: 完了表示 or ステータスがキャンセルになったか
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksCancelled =
    /キャンセルしました|キャンセルが完了|キャンセルを受け付け|取り消しました|キャンセル済|キャンセルになりました|キャンセルメール/.test(bodyText) ||
    /ステータス[\s\S]{0,30}(キャンセル|取消)/.test(bodyText) ||
    /\/reserveCancel\//.test(page.url());
  const looksError = /エラー|失敗|できませんでした/.test(bodyText) && !looksCancelled;

  if (looksError) {
    return fail(`キャンセル時にエラー表示 (${(bodyText.match(/.{0,40}(エラー|失敗|できませんでした).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksCancelled && !confirmClicked && !nativeDialogAccepted) {
    return fail(`キャンセルの完了を確認できませんでした (confirmClicked=${confirmClicked}${cap1 ? `, detail=${cap1}` : ''}${cap2 ? `, after=${cap2}` : ''})。SalonBoard で状態を確認してください。`, 'UNKNOWN_ERROR', true);
  }
  // 一覧検索で reserveId を特定した場合は呼び出し側に返す (bookings に焼き直す用)。
  return { status: 'ok', externalId: reserveId, recoveredReserveId: p._recoveredReserveId || null };
}

// =====================================================================
// 予約変更 (KIREIDOT → SalonBoard)
// reserveId(external_booking_id) をキーに SalonBoard 上の予約の
// 時間・所要(・担当) を変更する。
//
// 動線 (詳細ページの「変更する」リンク先):
//   /KLP/reserve/ext/extReserveChange/?reserveId=YG...  (ネットは net)
//   登録フォームと同じ構成 (#jsiRsvHour/#jsiRsvMinute/#jsiRsvTermHour/
//   #jsiRsvTermMinute, select#salonStaffList + hidden #staffId) が
//   既存値で埋まった状態で開く想定。値を更新して「登録する(a#regist)」または
//   確定ボタン → (HTMLダイアログなら a.accept / ネイティブ confirm なら accept)。
//
// payload: { booking_id, external_booking_id(reserveId), scheduled_at,
//            duration_min, salonboard_staff_external_id?, staff_name? }
// opts: { baseUrl, enableChange }   enableChange=false なら確定せず確認のみ。
//
// 戻り値: { status:'ok' } | { status:'confirm_only' }
//         | { status:'failed', reason, errorCode, manualRequired }
// =====================================================================
async function changeBookingViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enableChange = opts.enableChange !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => {
    captureErrorShot(page, `change_fail_${errorCode || 'err'}`);
    return { status: 'failed', reason, errorCode, manualRequired };
  };
  const reserveId = (p.external_booking_id || '').trim();

  if (!reserveId) return fail('external_booking_id (SalonBoard 予約ID) が無いため変更対象を特定できません', 'BOOKING_ID_NOT_FOUND', true);
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  const startMM = String(when.minute).padStart(2, '0');

  // ジャンル別ルート (登録と同じ: hair=/CLP/bt 配下、エステ=/KLP 配下)。
  const genre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const ROOT = reservePathRoot(genre);

  // グループ店舗(郡山等)はサロン選択で店舗文脈を確立してから変更フォームへ。
  await ensureReserveSalonContext(page, baseUrl, opts);

  // 1) 変更画面を開く (ext → net)。失効ページに着地したら relogin→サロン再選択で1回やり直す。
  // BF/BE はネット予約、YG 等は電話/外部予約。誤った側のURLでも詳細画面へ
  // リダイレクトされることがあり、そこにある a#change を変更フォームと誤認すると
  // 確定ボタンの無い画面で停止する。ID種別に応じた正しいURLを先に試す。
  const isNetReserve = /^(BF|BE)/i.test(reserveId);
  const extChangePath = `${ROOT}/reserve/ext/extReserveChange/?reserveId=${reserveId}`;
  const netChangePath = `${ROOT}/reserve/net/reserveChange/?reserveId=${reserveId}`;
  const extDetailPath = `${ROOT}/reserve/ext/extReserveDetail/?reserveId=${reserveId}`;
  const netDetailPath = `${ROOT}/reserve/net/reserveDetail/?reserveId=${reserveId}`;
  const candidates = isNetReserve
    ? [netChangePath, netDetailPath, extChangePath, extDetailPath]
    : [extChangePath, extDetailPath, netChangePath, netDetailPath];
  // SalonBoard は予約詳細/変更URLへの素の直リンクを KPCL009V01 で拒否することがある。
  // 先に一覧（hair はスケジュール）を開いて操作文脈/KMAGICを確立してから遷移する。
  // キャンセル処理と同じ動線に揃え、未知のクエリ(_kd等)も付加しない。
  const establishChangeContext = async () => {
    await ensureSalonSelected(page, {
      salonId: opts.salonId,
      shopName: opts.shopName,
    }).catch(() => {});
    const ctxUrl = genre === 'hair'
      ? new URL('/CLP/bt/schedule/salonSchedule/', baseUrl).toString()
      : new URL('/KLP/reserve/reserveList/init', baseUrl).toString();
    await page.goto(ctxUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    }).catch(() => {});
    await page.waitForTimeout(600);
  };
  // 詳細画面にも存在する #rlastupdate / a#change / a#regist は到達判定に使わない。
  // 実際に編集できる時刻・所要フィールドがある場合だけ変更フォームとみなす。
  const formSel = [
    'select#jsiRsvHour:visible',
    'select#jsiRsvMinute:visible',
    'select#rsvTime:visible',
    'select[name="time"]:visible',
    'select#rsvTermId:visible',
    'select[name="rsvTerm"]:visible',
  ].join(', ');
  let targetWasCancelled = false;
  // SalonBoard は URL を直接開いても、予約種別や画面状態によっては変更フォームではなく
  // 予約詳細へ着地する。その場合は画面最下部の青い「変更する」を押してから編集フォームへ
  // 進む必要がある（実画面 2026-07-23: BF36648303）。hidden の時刻 select をフォームと
  // 誤認しないよう、上の formSel は可視要素だけを対象にする。
  const openChangeFormFromDetail = async () => {
    if ((await page.locator(formSel).count().catch(() => 0)) > 0) return true;
    const cancelledDetail = await page.evaluate(() => {
      const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
      return /この予約はキャンセルされました|ステータス(?:サロン)?キャンセル|ステータス取消/.test(body);
    }).catch(() => false);
    if (cancelledDetail) {
      targetWasCancelled = true;
      return false;
    }
    const changeCta = page.locator([
      'a#change:visible',
      'a#fnc_change:visible',
      'a[href*="ReserveChange"]:visible',
      'a[href*="reserveChange"]:visible',
      'a:has-text("変更する"):visible',
      'a:has-text("予約を変更"):visible',
      'button:has-text("変更する"):visible',
      'input[type="submit"][value*="変更"]:visible',
      'input[type="button"][value*="変更"]:visible',
      'input[type="image"][alt*="変更"]:visible',
    ].join(', ')).last();
    if ((await changeCta.count().catch(() => 0)) === 0) return false;
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {}),
      changeCta.click({ timeout: 10_000 }).catch(() => {}),
    ]);
    await page.waitForSelector(formSel, { timeout: 12_000 }).catch(() => {});
    return (await page.locator(formSel).count().catch(() => 0)) > 0;
  };
  // エステ系は予約一覧で対象日を検索し、実際の予約行リンクをクリックする経路を最優先する。
  // これによりKMAGIC等の画面文脈を保ったまま詳細へ進め、直リンクのKPCL009V01を回避する。
  const openChangeFormViaReserveList = async () => {
    if (genre === 'hair') return false;
    const day = `${when.yyyymmdd.slice(0, 4)}-${when.yyyymmdd.slice(4, 6)}-${when.yyyymmdd.slice(6, 8)}`;
    const diag = [];

    // SalonBoard の予約番号は href だけでなく onclick / hidden input / 行テキストに
    // 入る画面がある。対象予約を含む要素から「実際に押せる詳細リンク」を特定して
    // 一時属性を付け、Playwright から通常クリックする。直URLへ遷移すると
    // KPCL009V01 になるため page.goto は使わない。
    const markReserveLink = async () => page.evaluate((wantId) => {
      document.querySelectorAll('[data-kireidot-reserve-target]')
        .forEach((el) => el.removeAttribute('data-kireidot-reserve-target'));
      const norm = (s) => String(s || '').replace(/\s+/g, '');
      const hasId = (el) => {
        if (!el) return false;
        const attrs = Array.from(el.attributes || [])
          .map((a) => `${a.name}=${a.value}`)
          .join(' ');
        return norm(attrs).includes(wantId) || norm(el.textContent).includes(wantId);
      };
      const clickables = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], input[type="image"]'));
      let target = clickables.find(hasId) || null;
      if (!target) {
        const carrier = Array.from(document.querySelectorAll('tr, li, div, input, span, td'))
          .find(hasId);
        const row = carrier?.closest?.('tr, li, [class*="reserve" i]') || carrier?.parentElement;
        if (row) {
          target = Array.from(row.querySelectorAll('a, button, input[type="button"], input[type="submit"], input[type="image"]'))
            .find((el) => /詳細|予約|変更/.test(el.textContent || el.value || el.alt || ''))
            || row.querySelector('a[href], a[onclick], button, input[type="button"], input[type="submit"], input[type="image"]');
        }
      }
      if (!target) {
        return {
          found: false,
          url: location.href,
          idOccurrences: (document.documentElement.innerHTML.match(new RegExp(wantId, 'g')) || []).length,
          resultRows: document.querySelectorAll('#reserveListArea tr, #resultList tbody tr').length,
        };
      }
      target.setAttribute('data-kireidot-reserve-target', '1');
      return {
        found: true,
        tag: target.tagName,
        href: target.getAttribute('href') || '',
        onclick: (target.getAttribute('onclick') || '').slice(0, 240),
        text: (target.textContent || target.value || target.alt || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        resultRows: document.querySelectorAll('#reserveListArea tr, #resultList tbody tr').length,
      };
    }, reserveId).catch(() => ({ found: false, evaluateFailed: true }));

    const searchAndOpen = async (range, label) => {
      diag.push(`${label}: ${range.fromStr}..${range.toStr}`);
      const searched = await applyBookingDateFilter(page, range, { diag }).catch(() => false);
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      for (let pageNo = 1; pageNo <= 20; pageNo++) {
        const marked = await markReserveLink();
        diag.push(`${label}[${pageNo}]: searched=${searched} marked=${JSON.stringify(marked)}`);
        if (marked?.found) {
          const reserveLink = page.locator('[data-kireidot-reserve-target="1"]:visible').first();
          if ((await reserveLink.count().catch(() => 0)) > 0) {
            await Promise.all([
              page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {}),
              reserveLink.click({ timeout: 10_000 }).catch(() => {}),
            ]);
            return openChangeFormFromDetail();
          }
        }
        const next = page.locator([
          '.paging .next a[href]:visible',
          'a[rel="next"]:visible',
          '#resultList + * a:has-text("次へ"):visible',
          'a:has-text("次へ"):visible',
        ].join(', ')).first();
        if ((await next.count().catch(() => 0)) === 0) break;
        const beforeUrl = page.url();
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {}),
          next.click({ timeout: 8_000 }).catch(() => {}),
        ]);
        await page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 8_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      }
      return false;
    };

    if (await searchAndOpen({ fromStr: day, toStr: day }, 'target-day')) return true;
    if (targetWasCancelled) return false;

    // 変更後の日付とSalonBoard上の現在日付が異なる更新では、KDの scheduled_at
    // だけに絞ると元予約を一覧から見つけられない。昨日〜3か月後の範囲でもう一度
    // 予約番号を探す。検索フォームを初期化してから行い、古い検索状態を持ち越さない。
    await page.goto(new URL('/KLP/reserve/reserveList/init', baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    }).catch(() => {});
    const broadRange = defaultBookingDateRange(3);
    if (await searchAndOpen(broadRange, 'broad-range')) return true;
    if (targetWasCancelled) return false;

    await captureScrapeDebug(page, 'change', `list_miss_${reserveId}`, {
      diagnostics: { reserveId, day, diag, url: page.url() },
    });
    return false;
  };
  let onForm = false;
  let loginRecoveryFailed = false;
  for (let openTry = 1; openTry <= 3 && !onForm; openTry++) {
    await establishChangeContext();
    onForm = await openChangeFormViaReserveList();
    if (onForm) break;
    if (targetWasCancelled) break;
    for (const path of candidates) {
      const candidateUrl = new URL(path, baseUrl);
      await page.goto(candidateUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      // ★高速化: networkidleを待たず、変更フォーム要素が出たら即進む。
      await page.waitForSelector(formSel, { timeout: 12_000 }).catch(() => {});
      onForm = (await page.locator(formSel).count().catch(() => 0)) > 0;
      if (!onForm) onForm = await openChangeFormFromDetail();
      if (onForm) break;
    }
    if (onForm) break;
    const pageState = await page.evaluate(() => {
      const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
      return {
        expired: /有効期限|再度ログイン|操作されなかった/.test(body),
        transient: /システムエラー|エラーが発生しました|再度操作しなおしてください|サロンが選択されていません/.test(body),
        // 深い予約画面への遷移時だけセッションが失効すると、SalonBoard は
        // /CNC/login/doLogin/ の画像認証画面へ戻す。従来はこれを単なる
        // 「変更フォームなし」と誤分類して manual_required にしていた。
        // ログイン画面はセッション失効として扱い、同一ジョブ内の再ログイン、
        // 失敗時は新しいCloudコンテキスト/出口でのジョブ再試行へ戻す。
        needsLogin:
          /\/CNC\/login\/|\/login\//i.test(location.pathname)
          || !!document.querySelector(
            'input[name="userId"], input[name="loginId"], input[name="password"], input[type="password"], input[name="captchaLogin"]',
          )
          || /画像認証|イラストを完成|パーツをドラッグ/.test(body),
      };
    }).catch(() => ({ expired: false, transient: false, needsLogin: false }));
    // セッション失効だけでなく、SBが一時エラー/サロン未選択へ戻した場合も
    // fresh login→店舗文脈再確立からやり直す。
    if (
      openTry < 3
      && (pageState.expired || pageState.transient || pageState.needsLogin)
      && typeof opts.relogin === 'function'
    ) {
      const ok = await opts.relogin().catch(() => false);
      if (ok) { await ensureReserveSalonContext(page, baseUrl, opts); continue; }
      if (pageState.needsLogin) loginRecoveryFailed = true;
    }
    break;
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  if (targetWasCancelled) {
    return fail(
      `[TARGET_CANCELLED] SalonBoard側の予約 ${reserveId} は既にキャンセル済みです。` +
      'KIREIDOT側が有効予約のため、重複確認後に新規予約として再登録します。',
      'BOOKING_ID_NOT_FOUND',
      false,
    );
  }
  const cap1 = await captureScrapeDebug(page, 'change', `form_${reserveId}`, { diagnostics: { reserveId, onForm, genre, url: page.url() } });
  if (!onForm) {
    if (
      loginRecoveryFailed
      || /\/CNC\/login\/|\/login\//i.test(page.url())
    ) {
      return fail(
        `[SESSION_EXPIRED] 予約変更中にSalonBoardログイン画面へ戻りました ` +
        `(reserveId=${reserveId}${cap1 ? `, capture=${cap1}` : ''})。` +
        '新しいCloudブラウザと出口で全工程を再試行します。',
        'SESSION_EXPIRED',
        false,
      );
    }
    // ★原因を切り分けて報告する: SalonBoard 側で「変更できない予約」の場合、
    //   確定ボタンが hidden/disabled な状態で置かれている。これを検出して、
    //   リトライしても無駄な手動対応案件であることを明示する。
    const state = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
      return {
        hasChangeAnchor: !!q('a#change') || !!q('a#change_disable'),
        changeVisible: vis(q('a#change')),
        disabledVisible: vis(q('a#change_disable')),
        // SB が変更不可理由を文言で出すケース
        notice: /変更できません|変更いただけません|キャンセル済|取消済|来店済|過去の予約/.test(body),
        url: location.href,
      };
    }).catch(() => null);

    if (state && (state.hasChangeAnchor || state.notice) && !state.changeVisible) {
      return fail(
        `この予約は SalonBoard 上で変更できない状態です (reserveId=${reserveId}` +
        `${state.disabledVisible ? ', 確定ボタンが無効表示' : ', 確定ボタンが非表示'}` +
        `${state.notice ? ', 画面に変更不可の案内あり' : ''}` +
        `${cap1 ? `, capture=${cap1}` : ''})。SalonBoard で直接ご確認ください。`,
        'MANUAL_REQUIRED',
        true, // 手動対応が必要 (リトライしても状況は変わらない)
      );
    }
    return fail(`予約変更フォームに到達できませんでした (reserveId=${reserveId}${cap1 ? `, capture=${cap1}` : ''})`, 'UNKNOWN_ERROR', true);
  }

  // 2) 担当 (指定があれば更新)。
  //    エステ: select#salonStaffList + hidden #staffId / 美容室: select[name="stylistId"]。
  //    要素の存在チェック付きで両方試す (存在しない方は no-op)。
  const staffExt = (p.salonboard_staff_external_id || '').trim();
  if (staffExt) {
    await page.locator('select#salonStaffList').first().selectOption({ value: staffExt }).catch(() => {});
    await page.evaluate((ext) => {
      const setVal = (el) => { if (el) { el.value = ext; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      setVal(document.getElementById('staffId'));
      document.querySelectorAll('input[name="staffId"]').forEach(setVal);
      for (const name of ['salonStaffList', 'staffIdList', 'stylistId']) {
        const sel = document.querySelector(`select[name="${name}"]`);
        if (sel && Array.from(sel.options).some((o) => o.value === ext)) { sel.value = ext; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, staffExt).catch(() => {});
  }

  // 3) 時間・所要を更新。エステ(jsiRsvHour/Minute + jsiRsvTermHour/Minute) と
  //    美容室(rsvTime=HHMM + rsvTerm=分) の両フィールドを存在チェック付きでセットする。
  const dMin = (p.duration_min != null && Number.isFinite(Number(p.duration_min)))
    ? Number(p.duration_min)
    : 60;
  const thVal = String(Math.floor(dMin / 60) * 60);
  const tmVal = String(dMin % 60).padStart(2, '0');
  const hhmm = `${String(when.hour).padStart(2, '0')}${startMM}`;
  {
    await page.evaluate(
      ({ hh, mm, th, tm, hhmm, dur }) => {
        const setSel = (el, val) => {
          if (!el) return false;
          if (!Array.from(el.options).some((o) => o.value === val)) return false;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const byId = (id) => document.getElementById(id);
        // エステ
        setSel(byId('jsiRsvHour'), hh);
        setSel(byId('jsiRsvMinute'), mm);
        setSel(byId('jsiRsvTermHour'), th);
        setSel(byId('jsiRsvTermMinute'), tm);
        // 美容室
        setSel(byId('rsvTime') || document.querySelector('select[name="time"]'), hhmm);
        const term = byId('rsvTermId') || document.querySelector('select[name="rsvTerm"]');
        if (term && !setSel(term, String(dur))) {
          const cand = Array.from(term.options).map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n >= dur).sort((a, b) => a - b)[0];
          if (cand != null) setSel(term, String(cand));
        }
      },
      { hh: String(when.hour), mm: startMM, th: thVal, tm: tmVal, hhmm, dur: dMin },
    ).catch(() => {});
    await page.waitForTimeout(300);
    const ok = await page.evaluate(({ th, tm, hhmm, dur }) => {
      const h = document.getElementById('jsiRsvTermHour');
      const m = document.getElementById('jsiRsvTermMinute');
      if (h && m) return h.value === th && m.value === tm;
      const t = document.getElementById('rsvTermId') || document.querySelector('select[name="rsvTerm"]');
      const rt = document.getElementById('rsvTime') || document.querySelector('select[name="time"]');
      if (t) return Number(t.value) >= Number(dur) && (!rt || rt.value === hhmm);
      return false;
    }, { th: thVal, tm: tmVal, hhmm, dur: dMin }).catch(() => false);
    if (!ok) {
      await page.locator('select#jsiRsvTermHour').first().selectOption({ value: thVal }).catch(() => {});
      await page.locator('select#jsiRsvTermMinute').first().selectOption({ value: tmVal }).catch(() => {});
      await page.locator('select#rsvTermId, select[name="rsvTerm"]').first().selectOption({ value: String(dMin) }).catch(() => {});
    }
  }

  if (!enableChange) {
    return { status: 'confirm_only' };
  }

  // 3.25) 既存予約の顧客名・カナ必須欄を補完する。
  // SalonBoard は変更対象が日時だけでもフォーム全体を再検証するため、メール取込等で
  // 氏名カナが空の既存予約は「氏名 (カナ セイ)を入力してください」で保存できない。
  // KIREIDOT 側の顧客カナを優先し、無い場合だけ表示名から安全なカナを作る。
  // 既に値がある欄は上書きせず、SalonBoard 上の顧客情報を不用意に変更しない。
  const requiredNameRepair = await page.evaluate((customer) => {
    const hiraToKata = (s) => String(s || '').replace(/[ぁ-ゖ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) + 0x60));
    const cleanName = (s) => String(s || '')
      .replace(/[^ぁ-ゖァ-ヿ一-龯々〆ヵヶA-Za-z0-9ー・\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const cleanKana = (s) => hiraToKata(s)
      .replace(/[^ァ-ヿー・\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const textOf = (id) => cleanName(document.getElementById(id)?.textContent || '');
    const kanaOf = (id) => cleanKana(document.getElementById(id)?.textContent || '');
    const orgLastName = textOf('orgNmSei');
    const orgFirstName = textOf('orgNmMei');
    const orgLastKana = kanaOf('orgNmSeiKana');
    const orgFirstKana = kanaOf('orgNmMeiKana');
    const rawFull = cleanName(customer.name || '')
      || cleanName(`${orgLastName} ${orgFirstName}`)
      || 'ゲスト';
    const parts = rawFull.split(/[\s　]+/).filter(Boolean);
    const lastName = cleanName(customer.lastName || orgLastName || parts[0] || rawFull) || 'ゲスト';
    const firstName = cleanName(customer.firstName || orgFirstName || parts.slice(1).join('') || '様') || '様';
    const lastKana = cleanKana(
      customer.lastNameKana || customer.nameKana || orgLastKana
        || customer.lastName || parts[0] || rawFull,
    ) || 'ヨヤク';
    const firstKana = cleanKana(
      customer.firstNameKana || orgFirstKana || customer.firstName || parts.slice(1).join(''),
    ) || 'キャクサマ';
    const fillRequired = (selector, value, isInvalid = (current) => !current) => {
      let changed = 0;
      // SalonBoardの変更画面には、同じname/idを持つhidden側フォームと表示中フォームが
      // 共存する版がある。querySelector()で先頭1件だけ埋めると、実際にsubmitされる側が
      // 空のまま残るため、該当する必須欄をすべて補完する。
      document.querySelectorAll(selector).forEach((el) => {
        const current = String(el.value || '').replace(/\s+/g, '').trim();
        const isSalonBoardPlaceholder = el.classList.contains('mod_color_999999');
        if (!isSalonBoardPlaceholder && !isInvalid(current)) return;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.defaultValue = value;
        // SalonBoard の placeholder 実装は value だけを書き換えても、
        // mod_color_999999 または jQuery data("empty") が残っていると、
        // 確定ボタンへフォーカスが移る際の blur で「シ/メイ」「氏/名」へ戻す。
        // 実入力として扱わせるため、値・class・jQuery内部フラグをセットで解除する。
        el.classList.remove('mod_color_999999');
        el.removeAttribute('data-empty');
        try {
          if (window.jQuery) window.jQuery(el).removeData('empty');
        } catch (_e) { /* noop */ }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        changed += 1;
      });
      return changed;
    };
    // SalonBoardが外部予約へ自動設定する「シ / メイ」は見た目上は非空でも、
    // 変更保存時のサーバ検証では未入力扱いになる実例がある。空欄だけでなく
    // これらの仮値も、有効なKIREIDOT側カナ（無ければ安全な既定値）へ置換する。
    const invalidLastKana = (value) => !value || /^(?:シ|セイ|姓|[-ー])$/.test(value);
    const invalidFirstKana = (value) => !value || /^(?:メイ|名|[-ー])$/.test(value);
    const invalidLastName = (value) => !value || /^(?:氏|姓|[-ー])$/.test(value);
    const invalidFirstName = (value) => !value || /^(?:名|[-ー])$/.test(value);
    const changed =
      fillRequired('input#nmSei, input[name="nmSei"]', lastName, invalidLastName) +
      fillRequired('input#nmMei, input[name="nmMei"]', firstName, invalidFirstName) +
      fillRequired('input#nmSeiKana, input[name="nmSeiKana"], input[id*="SeiKana" i], input[name*="SeiKana" i], input[id*="Kana" i][id*="Sei" i], input[name*="Kana" i][name*="Sei" i]', lastKana, invalidLastKana) +
      fillRequired('input#nmMeiKana, input[name="nmMeiKana"], input[id*="MeiKana" i], input[name*="MeiKana" i], input[id*="Kana" i][id*="Mei" i], input[name*="Kana" i][name*="Mei" i]', firstKana, invalidFirstKana);
    const fields = Array.from(document.querySelectorAll(
      'input#nmSei, input[name="nmSei"], input#nmMei, input[name="nmMei"], ' +
      'input[id*="Kana" i][id*="Sei" i], input[name*="Kana" i][name*="Sei" i], ' +
      'input[id*="Kana" i][id*="Mei" i], input[name*="Kana" i][name*="Mei" i]',
    )).map((el) => ({
      field: el.name || el.id || '(unnamed)',
      blank: !String(el.value || '').trim(),
      type: el.type || 'text',
      disabled: !!el.disabled,
      placeholderStyle: el.classList.contains('mod_color_999999'),
    }));
    return { changed, fields };
  }, {
    name: p.customer_name || null,
    lastName: p.customer_last_name || null,
    firstName: p.customer_first_name || null,
    nameKana: p.customer_name_kana || null,
    lastNameKana: p.customer_last_name_kana || null,
    firstNameKana: p.customer_first_name_kana || null,
  }).catch(() => ({ changed: 0, fields: [] }));

  // 3.5) 既存顧客情報に残った電話番号/郵便番号を SB が受け付ける形へ正規化する。
  // SalonBoard は変更対象でない既存フィールドも再検証し、電話だけでなく郵便番号等でも
  // 「※ハイフンなしで入力してください」を返す。ハイフン除去に加え、電話系フィールドは
  // +81 国際形式の残骸(例 817014551257 = 12桁・0始まりでない)も国内 0 始まりへ変換する
  // (ハイフンが無くてもこの validation 文言で弾かれる。2026-07-22 YG97547036)。
  // 値そのものはログへ出さず、補正した field 名だけを後段の診断情報へ残す。
  const normalizedHyphenFields = await page.evaluate(() => {
    const changed = [];
    const contactHint = /(tel|phone|mobile|zip|post|postal|郵便|電話)/i;
    const telHint = /(tel|phone|mobile|電話)/i;
    const dateHint = /(date|time|year|month|day|日時|年月日)/i;
    // normalizeJpPhoneDigits と同ロジック (page.evaluate 内は Node 側関数を参照できない)
    const toDomestic = (digits) => {
      if (!digits || (digits.startsWith('0') && digits.length <= 11)) return digits;
      for (const prefix of ['01081', '0081', '81']) {
        if (!digits.startsWith(prefix)) continue;
        let rest = digits.slice(prefix.length);
        if (!rest.startsWith('0')) rest = `0${rest}`;
        if (rest.length === 10 || rest.length === 11) return rest;
      }
      return digits;
    };
    document.querySelectorAll('input').forEach((el) => {
      const value = String(el.value || '');
      const digits = value.replace(/[^\d]/g, '');
      const key = `${el.id || ''} ${el.name || ''} ${el.getAttribute('aria-label') || ''}`;
      const type = String(el.type || 'text').toLowerCase();
      if (!value || digits.length < 7 || digits.length > 15) return;
      if (type === 'date' || type === 'datetime-local' || dateHint.test(key)) return;
      if (!contactHint.test(key) && type !== 'tel') return;
      const isTel = telHint.test(key) || type === 'tel';
      const next = isTel ? toDomestic(digits) : digits;
      if (next === value) return; // 既に正規形 (書き戻し不要)
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      changed.push({ field: el.name || el.id || '(unnamed)', digitCount: next.length });
    });
    return changed;
  }).catch(() => []);

  // 4) 確定: 実DOMでは画面下部の <a id="change" class="mod_btn_50">確定する</a> が
  //    最終確定ボタン (id="change_disable" は無効時の別要素なので除外)。
  const submitBtn = page
    .locator([
      'a#change:visible',
      'a#regist:visible',
      'a.mod_btn_50:has-text("確定する"):visible',
      'a:has-text("登録する"):visible',
      'button:has-text("確定する"):visible',
      'button:has-text("登録する"):visible',
      'input[type="submit"][value*="確定"]:visible',
      'input[type="submit"][value*="登録"]:visible',
      'input[type="button"][value*="確定"]:visible',
      'input[type="submit"][value*="変更"]:visible',
      'input[type="button"][value*="変更"]:visible',
      'button:has-text("変更する"):visible',
      'a:has-text("変更する"):visible',
    ].join(', '))
    .first();
  if ((await submitBtn.count().catch(() => 0)) === 0) {
    // ★診断強化: 確定ボタンが見つからない原因を特定できるよう、ページ上の
    //   操作要素 (a/button/input) を id/class/テキスト/可視つきで列挙する。
    //   これによりセレクタ修正に必要な実DOM情報がエラー文と capture に残る。
    const btns = await page.evaluate(() => {
      const pick = (el) => {
        const r = el.getBoundingClientRect();
        const visible = !!(r.width || r.height) && getComputedStyle(el).visibility !== 'hidden'
          && getComputedStyle(el).display !== 'none';
        const txt = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `${el.tagName.toLowerCase()}${id}${cls}${visible ? '' : '(hidden)'}「${txt}」`;
      };
      return Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'))
        .map(pick).slice(0, 30).join(' / ');
    }).catch(() => '(取得失敗)');
    const cap = await captureScrapeDebug(page, 'change', `no_submit_${reserveId}`, { diagnostics: { reserveId, url: page.url(), buttons: btns } });
    return fail(
      `変更の確定ボタンが見つかりませんでした (reserveId=${reserveId}${cap ? `, capture=${cap}` : ''})。画面上のボタン: ${btns.slice(0, 400)}`,
      'UNKNOWN_ERROR',
      true,
    );
  }

  // SalonBoard のスクリプトが入力後に placeholder class/value を復元する版がある。
  // 確定クリックの直前にも、画面内の元顧客情報を使って必須4欄を実入力状態へ戻す。
  const preSubmitNameRepair = await page.evaluate(() => {
    const mappings = [
      { input: 'nmSeiKana', org: 'orgNmSeiKana', placeholders: /^(?:シ|セイ|姓|[-ー])$/ },
      { input: 'nmMeiKana', org: 'orgNmMeiKana', placeholders: /^(?:メイ|名|[-ー])$/ },
      { input: 'nmSei', org: 'orgNmSei', placeholders: /^(?:氏|姓|[-ー])$/ },
      { input: 'nmMei', org: 'orgNmMei', placeholders: /^(?:名|[-ー])$/ },
    ];
    const fallback = {
      nmSeiKana: 'ヨヤク',
      nmMeiKana: 'キャクサマ',
      nmSei: 'ゲスト',
      nmMei: '様',
    };
    const repaired = [];
    const state = [];
    for (const mapping of mappings) {
      const el = document.getElementById(mapping.input);
      if (!el) continue;
      const before = String(el.value || '').replace(/\s+/g, '').trim();
      const placeholderStyle = el.classList.contains('mod_color_999999');
      if (placeholderStyle || !before || mapping.placeholders.test(before)) {
        const orgValue = String(document.getElementById(mapping.org)?.textContent || '').trim();
        const next = orgValue && !mapping.placeholders.test(orgValue)
          ? orgValue
          : fallback[mapping.input];
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(el, next);
        else el.value = next;
        el.defaultValue = next;
        el.classList.remove('mod_color_999999');
        el.removeAttribute('data-empty');
        try {
          if (window.jQuery) window.jQuery(el).removeData('empty');
        } catch (_e) { /* noop */ }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        repaired.push(mapping.input);
      }
      // 値/class が既に正常でも、WebKit向けに jQuery.data("empty") だけが
      // 残る場合がある。次の blur で値を空扱いに戻されないよう常に解除する。
      el.removeAttribute('data-empty');
      try {
        if (window.jQuery) window.jQuery(el).removeData('empty');
      } catch (_e) { /* noop */ }
      state.push({
        field: mapping.input,
        blank: !String(el.value || '').trim(),
        placeholderStyle: el.classList.contains('mod_color_999999'),
        placeholderValue: mapping.placeholders.test(
          String(el.value || '').replace(/\s+/g, '').trim(),
        ),
      });
    }
    return { repaired, state };
  }).catch(() => ({ repaired: [], state: [] }));

  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmClicked = false;
  let primaryClicked = false;
  let primaryClickError = '';
  let directFormSubmitted = false;
  try {
    // KLP の #change は click 後50ms待ってから doSubmit() を呼ぶ。この待機中に
    // 顧客欄の blur handler が placeholder を復元し、正しいカナが空として送られる。
    // 変更フォームと公式 formSubmit helper が揃う場合は、同じ doComplete へ直接送信する。
    // DOM更新とsubmitを同一JSターンで行うため、blurによる巻き戻しが介在しない。
    const directSubmitResult = await page.evaluate(() => {
      const form = document.getElementById('extReserveChange');
      const jq = window.jQuery;
      if (!form || !jq?.shuhari || typeof jq.shuhari.formSubmit !== 'function') {
        return { submitted: false, reason: 'helper_or_form_missing' };
      }
      const mappings = [
        ['nmSeiKana', 'orgNmSeiKana', 'ヨヤク'],
        ['nmMeiKana', 'orgNmMeiKana', 'キャクサマ'],
        ['nmSei', 'orgNmSei', 'ゲスト'],
        ['nmMei', 'orgNmMei', '様'],
      ];
      for (const [inputId, orgId, fallback] of mappings) {
        const el = document.getElementById(inputId);
        if (!el) continue;
        const orgValue = String(document.getElementById(orgId)?.textContent || '').trim();
        const current = String(el.value || '').trim();
        const placeholder = el.classList.contains('mod_color_999999');
        if (placeholder || !current) el.value = orgValue || fallback;
        el.classList.remove('mod_color_999999');
        el.removeAttribute('data-empty');
        try { jq(el).removeData('empty'); } catch (_e) { /* noop */ }
      }
      jq('#extCouponArea select[disabled="disabled"]').removeAttr('disabled');
      jq('#extCouponArea select').each(function normalizeUndefinedCoupon() {
        if (jq(this).val() === undefined) jq(this).val('');
      });
      jq.shuhari.formSubmit('extReserveChange', 'doComplete');
      return { submitted: true };
    }).catch((e) => ({
      submitted: false,
      reason: e?.message || String(e),
    }));
    directFormSubmitted = directSubmitResult.submitted === true;
    primaryClicked = directFormSubmitted;

    if (!directFormSubmitted) {
      await submitBtn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      try {
        await submitBtn.click({ timeout: 12_000 });
        primaryClicked = true;
      } catch (e1) {
        primaryClickError = e1?.message || String(e1);
        try {
          await submitBtn.click({ timeout: 8_000, force: true });
          primaryClicked = true;
        } catch (e2) {
          primaryClickError = `${primaryClickError} / force=${e2?.message || String(e2)}`;
          try {
            await submitBtn.evaluate((el) => el.click());
            primaryClicked = true;
          } catch (e3) {
            primaryClickError = `${primaryClickError} / dom=${e3?.message || String(e3)}`;
          }
        }
      }
    }
    if (!primaryClicked) {
      const cap = await captureScrapeDebug(page, 'change', `submit_click_failed_${reserveId}`, {
        diagnostics: { reserveId, primaryClickError, url: page.url() },
      });
      return fail(`変更ボタンを押せませんでした (${primaryClickError.slice(0, 300)}${cap ? `, capture=${cap}` : ''})`, 'UNKNOWN_ERROR', false);
    }
    await page.waitForTimeout(2500);
    // 「確定する」後に確認画面/ダイアログが出る場合があるので、最終確定ボタンを押す。
    //   ① HTMLダイアログ「はい」(a.accept) ② 確認画面の「登録する」(a#regist) / 「確定する」(a#change)
    // 時間超過警告(「予約時間を過ぎていますがよろしいですか？」)→確認画面 のように
    // 確認が多段で出ることがあるため、完了表示が出るまで最大3回まで押し進める。
    for (let round = 0; round < 3; round++) {
      const bodyNow = (await page.locator('body').innerText().catch(() => '')) || '';
      if (/変更しました|変更が完了|更新しました|受け付けました|登録しました/.test(bodyNow)) break;
      // 設備数超過等の警告画面で OK をクリックすると、SalonBoard は再び50ms待って
      // doSubmit()する。その間に顧客placeholderが戻るため、警告受諾後の2回目も
      // 値補正とformSubmitを同一JSターンで実行する。
      const warningResubmitted = await page.evaluate(() => {
        const warn = document.getElementById('warnArea');
        if (!warn || getComputedStyle(warn).display === 'none') return false;
        const jq = window.jQuery;
        const form = document.getElementById('extReserveChange');
        if (!form || !jq?.shuhari || typeof jq.shuhari.formSubmit !== 'function') return false;
        const mappings = [
          ['nmSeiKana', 'orgNmSeiKana', 'ヨヤク'],
          ['nmMeiKana', 'orgNmMeiKana', 'キャクサマ'],
          ['nmSei', 'orgNmSei', 'ゲスト'],
          ['nmMei', 'orgNmMei', '様'],
        ];
        for (const [inputId, orgId, fallback] of mappings) {
          const el = document.getElementById(inputId);
          if (!el) continue;
          const orgValue = String(document.getElementById(orgId)?.textContent || '').trim();
          const current = String(el.value || '').trim();
          if (el.classList.contains('mod_color_999999') || !current) {
            el.value = orgValue || fallback;
          }
          el.classList.remove('mod_color_999999');
          el.removeAttribute('data-empty');
          try { jq(el).removeData('empty'); } catch (_e) { /* noop */ }
        }
        warn.style.display = 'none';
        jq('#extCouponArea select[disabled="disabled"]').removeAttr('disabled');
        jq.shuhari.formSubmit('extReserveChange', 'doComplete');
        return true;
      }).catch(() => false);
      if (warningResubmitted) {
        confirmClicked = true;
        await page.waitForTimeout(2500);
        continue;
      }
      const finalBtn = page
        .locator('a.accept:visible, .buttons a.accept, a#regist:visible, a:has-text("登録する"):visible, a#change:visible')
        .first();
      await finalBtn.waitFor({ state: 'visible', timeout: round === 0 ? 6_000 : 2_500 }).catch(() => {});
      if ((await finalBtn.count().catch(() => 0)) === 0) {
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
        break;
      }
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      confirmClicked = true;
      await page.waitForTimeout(1500);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  let cap2 = await captureScrapeDebug(page, 'change', `after_${reserveId}`, {
    diagnostics: {
      reserveId,
      primaryClicked,
      primaryClickError,
      confirmClicked,
      nativeDialogAccepted,
      directFormSubmitted,
      requiredNameRepair,
      preSubmitNameRepair,
      normalizedHyphenFields,
      url: page.url(),
    },
  });

  // 5) 検証
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /変更しました|変更が完了|更新しました|受け付けました|登録しました/.test(bodyText);
  const bodyHead = bodyText.slice(0, 1400);
  const looksError = /エラー|失敗|できませんでした|入力してください|空いて|満員|埋ま/.test(bodyHead) && !looksDone;
  const warningStillOpen = await page.locator('#warnArea:visible').count().catch(() => 0);
  if (!looksDone && warningStillOpen > 0) {
    const warningCap = await captureScrapeDebug(page, 'change', `warning_not_confirmed_${reserveId}`, {
      diagnostics: {
        reserveId,
        directFormSubmitted,
        confirmClicked,
        url: page.url(),
      },
    });
    return fail(
      `SalonBoardの警告確認を完了できませんでした${warningCap ? ` (capture=${warningCap})` : ''}`,
      'UNKNOWN_ERROR',
      false,
    );
  }
  if (looksError) {
    // 通知画像が画面上部だけにならないよう、実際のvalidation文言へスクロールして撮り直す。
    const errorLocator = page.getByText(/ハイフンなし|エラー|失敗|できませんでした|入力してください|空いて|満員|埋ま/).last();
    await errorLocator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    const hyphenFields = await page.evaluate(() => Array.from(document.querySelectorAll('input'))
      .filter((el) => {
        const key = `${el.id || ''} ${el.name || ''} ${el.getAttribute('aria-label') || ''}`;
        return /(tel|phone|mobile|zip|post|postal|郵便|電話)/i.test(key)
          && /[-‐‑‒–—―−]/.test(String(el.value || ''));
      })
      .map((el) => ({
        field: el.name || el.id || '(unnamed)',
        type: el.type || 'text',
        digitCount: String(el.value || '').replace(/[^\d]/g, '').length,
      })).slice(0, 20)).catch(() => []);
    const requiredNameState = await page.evaluate(() => Array.from(document.querySelectorAll(
      'input#nmSei, input[name="nmSei"], input#nmMei, input[name="nmMei"], ' +
      'input[id*="Kana" i][id*="Sei" i], input[name*="Kana" i][name*="Sei" i], ' +
      'input[id*="Kana" i][id*="Mei" i], input[name*="Kana" i][name*="Mei" i]',
    )).map((el) => ({
      field: el.name || el.id || '(unnamed)',
      blank: !String(el.value || '').trim(),
      type: el.type || 'text',
      disabled: !!el.disabled,
    }))).catch(() => []);
    const validationCap = await captureScrapeDebug(page, 'change', `validation_error_${reserveId}`, {
      diagnostics: {
        reserveId,
        requiredNameRepair,
        preSubmitNameRepair,
        directFormSubmitted,
        requiredNameState,
        normalizedHyphenFields,
        remainingHyphenFields: hyphenFields,
        url: page.url(),
      },
    });
    if (validationCap) cap2 = validationCap;
    const fieldHint = hyphenFields.length
      ? `, ハイフン残存field=${hyphenFields.map((x) => `${x.field}(${x.digitCount}桁)`).join(',')}`
      : '';
    return fail(`変更時にエラー表示 (${(bodyHead.match(/.{0,40}(エラー|失敗|できませんでした|入力してください|空いて|満員|埋ま).{0,40}/)?.[0] || '').trim()}${fieldHint}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !confirmClicked && !nativeDialogAccepted) {
    // SalonBoard は保存後も完了文言を出さず詳細画面へ戻る場合がある。曖昧成功にせず、
    // 一度 about:blank へ離れてサーバから変更フォームを再取得し、時刻・所要が保存済みか照合する。
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5_000 }).catch(() => {});
    let persisted = false;
    let persistedState = null;
    for (const path of candidates) {
      await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForSelector(formSel, { timeout: 6_000 }).catch(() => {});
      if ((await page.locator(formSel).count().catch(() => 0)) === 0) {
        await openChangeFormFromDetail();
      }
      if ((await page.locator(formSel).count().catch(() => 0)) === 0) continue;
      persistedState = await page.evaluate(({ wantHour, wantMinute, wantHhmm, wantDuration }) => {
        const val = (sel) => document.querySelector(sel)?.value || '';
        const estHour = val('#jsiRsvHour');
        const estMinute = val('#jsiRsvMinute');
        const estTermHour = Number(val('#jsiRsvTermHour') || 0);
        const estTermMinute = Number(val('#jsiRsvTermMinute') || 0);
        const hairTime = val('#rsvTime, select[name="time"]');
        const hairTerm = Number(val('#rsvTermId, select[name="rsvTerm"]') || 0);
        const estheticOk = !!estHour && Number(estHour) === Number(wantHour)
          && Number(estMinute) === Number(wantMinute)
          && estTermHour + estTermMinute === Number(wantDuration);
        const hairOk = !!hairTime && hairTime.replace(':', '') === wantHhmm
          && hairTerm >= Number(wantDuration);
        return { estheticOk, hairOk, estHour, estMinute, estTermHour, estTermMinute, hairTime, hairTerm };
      }, {
        wantHour: String(when.hour),
        wantMinute: startMM,
        wantHhmm: hhmm,
        wantDuration: dMin,
      }).catch(() => null);
      persisted = !!(persistedState?.estheticOk || persistedState?.hairOk);
      break;
    }
    if (!persisted) {
      const verifyCap = await captureScrapeDebug(page, 'change', `verify_failed_${reserveId}`, {
        diagnostics: { reserveId, persistedState, primaryClicked, primaryClickError, url: page.url() },
      });
      return fail(`変更の保存を再読込で確認できませんでした (primaryClicked=${primaryClicked}, state=${JSON.stringify(persistedState)}${verifyCap ? `, capture=${verifyCap}` : ''})`, 'UNKNOWN_ERROR', false);
    }
  }
  return { status: 'ok' };
}

// ----------------- スタッフ一覧 (staffList) -----------------

const STAFF_LIST_URL = 'https://salonboard.com/CNK/draft/staffList';
// 設備設定 (ベッド/席などの物理リソース)。設定系は美容室/エステ共通で /CNK/set/ 配下。
const EQUIP_LIST_URL = 'https://salonboard.com/CNK/set/equipList/';

// ===================== 美容室 (hair) 専用 =====================
// 美容室はエステ(/CNK/...)と URL/DOM が異なり、/CNB/... 配下を使う。
//   スタイリスト一覧: /CNB/draft/stylistList/
//   スタイル一覧:     /CNB/draft/styleList/
const STYLIST_LIST_URL = 'https://salonboard.com/CNB/draft/stylistList/';
const STYLE_LIST_URL = 'https://salonboard.com/CNB/draft/styleList/';

// 掲載管理(draft)のパス接頭辞はジャンルで異なる:
//   エステ/ネイル/まつげ = /CNK/draft/... 、美容室(hair) = /CNB/draft/...
//   (実機URL 2026-07-12 ユーザ提供: 美容室は salon/menu/kodawari/special/coupon すべて /CNB/draft/)
//   これを付けずに /CNK/ 固定で hair店を fetch すると全て 0件になる(ADER 開発店/郡山で判明)。
function draftPrefix(genre) {
  return genre === 'hair' ? 'CNB' : 'CNK';
}
function draftUrl(genre, page, baseUrl) {
  return new URL(`/${draftPrefix(genre)}/draft/${page}`, baseUrl || 'https://salonboard.com/').toString();
}

/**
 * 美容室「スタイリスト掲載情報一覧」(/CNB/draft/stylistList/) を取得する。
 * エステの scrapeStaff の hair 版。出力 row 形は sendStaff 互換 (external_id/name/...)。
 *
 * 確認済み DOM (salonboard_code/美容室/スタイリスト_stylistList.html):
 *   - 一意 ID: input[name="frmStylistListStylistDtoList[N].stylistId"] value="T000917663"
 *   - 各スタイリストは table.table_list_store の連続行。名前/職種は td.td_value_store_c。
 */
async function scrapeStylists(page, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  // グループ店舗(1ログイン複数サロン)は、サロン未選択のまま /CNB/draft/stylistList/ へ
  // 直接遷移すると「ユーザエラー」ページに着地する(掲載スタイリスト一覧は跳ね返らず
  // エラーになるため ensureSalonSelected も選択に入れず0件になる。ADER 郡山で判明)。
  // salonId があれば先に groupTop でサロンを選んでから一覧へ入る。
  if (opts.salonId) {
    await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  }
  await page.goto(STYLIST_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  // まだ groupTop に跳ね返された場合はサロンを選び直して入り直す。
  const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
  if (sel.selected) {
    await page.goto(STYLIST_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  }

  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    // stylistId の hidden input を起点に巡回 (SalonBoard 正規データ)。
    const idInputs = Array.from(
      document.querySelectorAll(
        'input[name^="frmStylistListStylistDtoList["][name$=".stylistId"]'
      )
    ).filter((el) => (el.value || '').trim());

    const items = [];
    const seen = new Set();
    for (const input of idInputs) {
      const ext = (input.value || '').trim();
      if (!ext || seen.has(ext)) continue;
      seen.add(ext);
      // この input が属する行ブロック (近傍の td 群) から名前・職種を拾う。
      // 1スタイリスト = 主行 + 付随行。最寄りの tr から td.td_value_store_c を集める。
      const tr = input.closest('tr');
      let name = '';
      let position = '';
      let photoUrl = null;
      if (tr) {
        const cells = Array.from(tr.querySelectorAll('td.td_value_store_c'))
          .map((c) => txt(c))
          // 先頭の td は「順番」列 (No. + input) で、これを氏名と誤取得していた。
          // No. / No.N / 空/- を除外し、実データ列だけ残す。
          .filter((t) => t && t !== '-' && !/^No\.?\s*\d*$/.test(t));
        // 除外後は 氏名 → 職種/ランク/指名料 → 施術歴 → チェック の順。
        if (cells.length) name = cells[0];
        if (cells.length > 1) position = cells[1];
        const img = tr.querySelector('img[name="stylistPhoto"], img');
        photoUrl = img ? img.getAttribute('src') : null;
      }
      items.push({ external_id: ext, name, position, photo_url: photoUrl });
    }
    return { items, total: idInputs.length };
  });

  const rows = (raw.items ?? [])
    .filter((it) => it.external_id)
    .map((it) => ({
      external_id: String(it.external_id),
      name: cleanText(it.name) ?? it.name ?? '',
      position: cleanText(it.position),
      catch_phrase: null,
      bio: null,
      photo_url: it.photo_url ? absoluteUrl(it.photo_url) : null,
      is_published: true,
    }))
    .filter((r) => r.name); // 名前が取れた行のみ (sendStaff の必須条件)

  return {
    rows,
    debug: { parsed: rows.length, staffIdInputs: raw.total, genre: 'hair', source: 'stylistList' },
  };
}

/**
 * 美容室「スタイル一覧」(/CNB/draft/styleList/) を取得する。
 * エステの scrapeMenus の hair 版。出力 row 形は sendMenus 互換 (external_id/name/...)。
 *
 * 確認済み DOM (salonboard_code/美容室/スタイル_styleList.html):
 *   - 一意 ID: input[name="frmStyleListStyleInfoDtoList[N].styleId"] value="L203183513"
 *   - スタイル名: td.td_value_store_c[colspan="3"] (主行)
 *   - 紐付けクーポン: input[name="...couponId"] value="CP..."
 *   - ページング: a.pgLink / a.pgNext / a.pgLast (?pn=N)
 */
async function scrapeStyles(page, opts = {}) {
  const MAX_PAGES = 30;
  // フォトギャラリー画面で「SalonBoard スタイル一覧」を表示するための取得上限。
  // 多すぎると画面/取込負荷が大きいので最大 100 件で打ち切る (ユーザー要望)。
  const MAX_STYLES = 100;
  const allItems = [];
  const seen = new Set();
  let pageUrl = STYLE_LIST_URL;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

    // 1ページ目: グループ店舗で groupTop に跳ね返された場合はサロンを選び直して入り直す。
    if (pageNum === 1) {
      const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
      if (sel.selected) {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      }
    }

    const pageData = await page.evaluate(() => {
      function txt(el) {
        return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }
      const re = /^frmStyleListStyleInfoDtoList\[(\d+)\]\.(.+)$/;
      const byIndex = {};
      const els = document.querySelectorAll(
        'input[name^="frmStyleListStyleInfoDtoList"], select[name^="frmStyleListStyleInfoDtoList"]'
      );
      for (const el of els) {
        const m = (el.getAttribute('name') || '').match(re);
        if (!m) continue;
        const idx = m[1];
        const field = m[2];
        (byIndex[idx] = byIndex[idx] || {})[field] = el.value;
      }
      // スタイル名は styleId hidden input の属する行ブロックから拾う。
      const items = [];
      for (const idx of Object.keys(byIndex)) {
        const f = byIndex[idx];
        const styleId = (f.styleId || '').trim();
        if (!styleId) continue;
        const input = document.querySelector(
          `input[name="frmStyleListStyleInfoDtoList[${idx}].styleId"]`
        );
        let name = '';
        let length = '';
        let stylist = '';
        let imageUrl = '';
        const tr = input ? input.closest('tr') : null;
        if (tr) {
          // 主行: スタイル名は colspan=3 の td。
          const titleTd = tr.querySelector('td.td_value_store_c[colspan="3"]');
          name = txt(titleTd);
          // サムネイル画像: 行ブロック内の img[name="stylePhoto"]。
          // (主行に無い場合があるので、後続の兄弟行も含めて探す)
          let photoImg = tr.querySelector('img[name="stylePhoto"], img[src*="IMGDB_HD"]');
          // 付随行(長さ/担当)を兄弟 tr から拾う (最大4行ブロック)。
          let sib = tr.nextElementSibling;
          const extra = [];
          for (let i = 0; i < 3 && sib; i++) {
            if (!photoImg) {
              photoImg = sib.querySelector('img[name="stylePhoto"], img[src*="IMGDB_HD"]');
            }
            const cells = Array.from(sib.querySelectorAll('td.td_value_store_c'))
              .map((c) => txt(c))
              .filter((t) => t && t !== '-');
            extra.push(...cells);
            sib = sib.nextElementSibling;
          }
          if (extra.length) length = extra[0] || '';
          if (extra.length > 1) stylist = extra[1] || '';
          if (photoImg) imageUrl = photoImg.getAttribute('src') || '';
        }
        items.push({
          external_id: styleId,
          name,
          length,
          stylist,
          image_url: imageUrl,
          coupon_external_id: (f.couponId || '').trim() || null,
        });
      }
      // ページング情報
      const nextEl = document.querySelector('a.pgNext');
      const nextHref = nextEl ? nextEl.getAttribute('href') : null;
      return { items, nextHref, total: Object.keys(byIndex).length };
    });

    for (const it of pageData.items ?? []) {
      if (it.external_id && !seen.has(it.external_id)) {
        seen.add(it.external_id);
        allItems.push(it);
      }
    }

    // 取得上限 (100件) に達したら以降のページは見ない。
    if (allItems.length >= MAX_STYLES) break;

    // 次ページへ。pgNext が無ければ終了。
    if (!pageData.nextHref) break;
    try {
      pageUrl = new URL(pageData.nextHref, 'https://salonboard.com').toString();
    } catch (_e) {
      break;
    }
  }

  // サムネイル画像URLを正規化する。styleList の img は w=60&h=80 の小さいサムネ。
  // フォトギャラリー表示用に大きめ (w=360&h=480) に差し替え、絶対URL化する。
  // 画像ID (B...) も IMGDB_HD/.../B........./ から抽出する。
  const normalizeStyleImage = (raw) => {
    if (!raw) return { url: null, imageExternalId: null };
    let url = String(raw).replace(/&amp;/g, '&').trim();
    try { url = new URL(url, 'https://imgbp.salonboard.com').toString(); } catch (_e) { /* keep raw */ }
    // サイズ指定を大きくする (w/h を置換、無ければそのまま)。
    url = url.replace(/([?&])w=\d+/i, '$1w=360').replace(/([?&])h=\d+/i, '$1h=480');
    const m = url.match(/\/(B\d{6,})\//) || url.match(/\/(B\d{6,})\.[a-z]+/i);
    return { url, imageExternalId: m ? m[1] : null };
  };

  const rows = allItems
    .filter((it) => it.external_id && it.name)
    .slice(0, MAX_STYLES)
    .map((it) => {
      const img = normalizeStyleImage(it.image_url);
      return {
        external_id: String(it.external_id),
        name: cleanText(it.name) ?? it.name,
        price: null,
        duration_min: null,
        // スタイルは「長さ/担当/紐付けクーポン」を raw に残す (将来 menus 取込で活用)。
        length: cleanText(it.length) || null,
        stylist_name: cleanText(it.stylist) || null,
        coupon_external_id: it.coupon_external_id || null,
        // フォトギャラリー表示用の画像。
        image_url: img.url,
        image_external_id: img.imageExternalId,
      };
    });

  return { rows, debug: { itemsFound: rows.length, genre: 'hair', source: 'styleList', max: MAX_STYLES } };
}

// =====================================================================
// エステ等「フォトギャラリー」(/CNK/draft/photoGalleryEdit) を取得する。
// 編集フォーム(form#photoGalleryEditForm)の「画像が入っている枠」を読み取り、
// 画像URL/タイトル/キャプション/ジャンル/掲載状態を抽出する。最大100件。
// 実DOM: salonboard_code/エステサロン/フォトギャラリー_photoGalleryEdit.html
// =====================================================================
async function scrapePhotoGallery(page, opts = {}) {
  const MAX_ITEMS = 100;
  let url;
  try { url = draftUrl(opts.genre, 'photoGalleryEdit', opts.baseUrl); } catch (_e) { url = PHOTO_GALLERY_EDIT_URL; }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  // グループ店舗で groupTop に跳ね返された場合はサロンを選び直して入り直す。
  const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
  if (sel.selected) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  }

  const pageData = await page.evaluate(() => {
    function txt(el) { return el ? (el.textContent || '').trim() : ''; }
    const re = /^frmPhotoGalleryInfoDtoList\[(\d+)\]\.photogalleryPhoto$/;
    const hidden = Array.from(document.querySelectorAll('input.jscPhotogalleryPhotoId, input[name$=".photogalleryPhoto"]'));
    const items = [];
    for (const el of hidden) {
      const m = (el.getAttribute('name') || '').match(re);
      if (!m) continue;
      const idx = m[1];
      const photoId = String(el.value || '').trim();
      if (!photoId) continue; // 空き枠はスキップ
      const q = (suffix) => document.querySelector(`[name="frmPhotoGalleryInfoDtoList[${idx}].${suffix}"]`);
      const titleEl = q('photogalleryTitle');
      const capEl = q('photogalleryCaption');
      const genreEl = q('photogalleryGenreCd');
      const storeIdEl = q('storePhotogalleryId');
      const presentEl = document.querySelector(`input[name="frmPhotoGalleryInfoDtoList[${idx}].photogalleryPresentFlg"]:checked`);
      // 画像 img: 同じ枠の jscPhotogalleryPhotoImg。
      let imgUrl = '';
      const imgEl = document.querySelector(`img[name="frmPhotoGalleryInfoDtoList[${idx}].photogalleryPhoto_IMG"]`)
        || (el.closest('table') ? el.closest('table').querySelector('img.jscPhotogalleryPhotoImg') : null);
      if (imgEl) imgUrl = imgEl.getAttribute('src') || '';
      items.push({
        external_id: photoId,
        image_external_id: photoId,
        store_photogallery_id: storeIdEl ? String(storeIdEl.value || '').trim() : '',
        title: titleEl ? (titleEl.value || '') : '',
        caption: capEl ? (capEl.value || '') : '',
        genre_code: genreEl ? (genreEl.value || '') : '',
        is_published: presentEl ? presentEl.value === '1' : true,
        image_url: imgUrl,
      });
    }
    return { items };
  });

  const normalizeImage = (raw) => {
    if (!raw) return { url: null, id: null };
    let u = String(raw).replace(/&amp;/g, '&').trim();
    if (u.includes('noneimage')) return { url: null, id: null }; // プレースホルダ
    try { u = new URL(u, 'https://imgbp.salonboard.com').toString(); } catch (_e) { /* keep */ }
    u = u.replace(/([?&])w=\d+/i, '$1w=360').replace(/([?&])h=\d+/i, '$1h=480');
    const m = u.match(/\/(C\d{6,})\//) || u.match(/\/(C\d{6,})\.[a-z]+/i);
    return { url: u, id: m ? m[1] : null };
  };

  const rows = (pageData.items ?? [])
    .filter((it) => it.external_id)
    .slice(0, MAX_ITEMS)
    .map((it) => {
      const img = normalizeImage(it.image_url);
      return {
        external_id: String(it.external_id),
        title: cleanText(it.title) || null,
        caption: cleanText(it.caption) || null,
        image_url: img.url,
        image_external_id: img.id || it.image_external_id || null,
        genre_code: it.genre_code || null,
        is_published: it.is_published !== false,
      };
    });

  return { rows, debug: { itemsFound: rows.length, genre: 'esthetic', source: 'photoGalleryEdit', max: MAX_ITEMS } };
}

/**
 * SalonBoard 設備設定 (/CNK/set/equipList/) から設備一覧を取得する。
 * 出力 row 形は sendEquipment / salonboard_bulk_upsert_equipment 互換:
 *   { external_id: 'EQ...', name, max_rsv_num, priority, sort_no }
 *
 * DOM 仕様 (確認済み):
 *   各設備は <table id="TagTR_EQUIPMENT_TBL_N"> 内に 1 行。登録済みは
 *   style="display:block"、空枠は display:none。一意 ID は hidden input:
 *     <input type="hidden" name="frmEquipListDtoList[N].equipmentId" value="EQ...">
 *   設備名/受付可能数/振り分け順/並び順も同じ配列名で露出:
 *     frmEquipListDtoList[N].equipmentName (text)
 *     frmEquipListDtoList[N].maxRsvNum     (select, selectedの値)
 *     frmEquipListDtoList[N].priority      (text)
 *     frmEquipListDtoList[N].sortNo        (text) ※1件目は固定で省略されることがある
 *   equipmentId が空の行 (display:none の追加枠) は捨てる。
 */
async function scrapeEquipment(page, opts = {}) {
  // 美容室(hair)の SalonBoard には設備設定 (/CNK/set/equipList/) が存在しない
  // (スタイリストベース)。エステ用URLへ飛ぶとエラーになるためスキップする。
  if (opts.genre === 'hair') {
    return {
      rows: [],
      debug: { skipped: 'hair_genre_no_equipment', itemsFound: 0, parsed: 0 },
    };
  }
  await page.goto(EQUIP_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  const raw = await page.evaluate(() => {
    function val(el) {
      return el && typeof el.value === 'string' ? el.value.trim() : '';
    }
    function indexFromName(name) {
      const m = String(name || '').match(/\[(\d+)\]\.equipmentId$/);
      return m ? Number(m[1]) : -1;
    }
    // 全 equipmentId 入力を起点に巡回 (= N の全配列)
    const idInputs = Array.from(
      document.querySelectorAll(
        'input[name^="frmEquipListDtoList["][name$=".equipmentId"]'
      )
    );
    const items = [];
    for (const idInput of idInputs) {
      const ext = val(idInput);
      if (!ext) continue; // 空枠 (display:none の追加用) は捨てる
      const idx = indexFromName(idInput.getAttribute('name'));
      if (idx < 0) continue;
      const base = `frmEquipListDtoList[${idx}].`;
      const nameEl = document.querySelector(`input[name="${base}equipmentName"]`);
      const maxEl = document.querySelector(`select[name="${base}maxRsvNum"]`);
      const prioEl = document.querySelector(`input[name="${base}priority"]`);
      const sortEl = document.querySelector(`input[name="${base}sortNo"]`);
      items.push({
        external_id: ext,
        name: val(nameEl),
        max_rsv_num: maxEl ? maxEl.value : '',
        priority: val(prioEl),
        sort_no: val(sortEl),
      });
    }
    return { items, idInputsCount: idInputs.length };
  });

  const rows = (raw.items || [])
    .filter((it) => it.external_id && it.name)
    .map((it) => ({
      external_id: it.external_id,
      name: it.name,
      max_rsv_num: it.max_rsv_num !== '' ? Number(it.max_rsv_num) : null,
      priority: it.priority !== '' ? Number(it.priority) : null,
      sort_no: it.sort_no !== '' ? Number(it.sort_no) : null,
    }));

  return {
    rows,
    debug: { itemsFound: (raw.items || []).length, parsed: rows.length, idInputs: raw.idInputsCount },
  };
}

/**
 * サロン情報(基本設定)を取得する。/KLP/set/salonSetup/ (基本設定) から
 * 営業時間/定休日(曜日別ウィジェットの表示テキスト)・キャンセルポリシー・STORE_ID を拾う。
 * 1 shop = 1 row。external_id = STORE_ID(SalonBoard 店舗ID, 例 H000811410)。
 * 店舗名/住所/アクセス等のプロフィールは掲載管理(別モジュール)にあるため、ここでは
 * 基本設定で取得できる「営業時間/定休日/キャンセルポリシー」を対象とする。
 * 戻り値: { rows: [{ external_id, business_hours, holidays, cancel_policy(jsonb), raw }], debug }
 */
async function scrapeSalonInfo(page, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  await page
    .goto(new URL('/KLP/set/salonSetup/', baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  const data = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const val = (name) => {
      const e = document.querySelector(`[name="${name}"]`);
      if (!e) return null;
      if (e.tagName === 'SELECT') {
        const o = e.options[e.selectedIndex];
        return o ? norm(o.textContent) : (e.value || null);
      }
      return e.value != null ? e.value : null;
    };
    // STORE_ID
    let storeId = val('STORE_ID');
    if (!storeId) {
      const m = document.body.innerHTML.match(/storeId=([A-Z0-9]+)/);
      if (m) storeId = m[1];
    }
    // 営業時間設定セクション: 見出しを含む最寄りの section/table/dl の表示テキストを丸ごと拾う。
    let hoursText = null;
    let holidayText = null;
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,th,dt,legend'));
    const head = heads.find((e) => /営業時間設定|営業時間.{0,3}定休日/.test(e.textContent || ''));
    if (head) {
      let box = head;
      for (let i = 0; i < 6 && box && box.parentElement; i++) {
        box = box.parentElement;
        if (/section|table|dl|fieldset/i.test(box.tagName) || (box.className && /set|business|hour|area|box/i.test(box.className))) break;
      }
      let t = norm(box && box.innerText);
      // グローバルナビ等の接頭辞を落とし、「営業時間設定」セクションから開始する。
      if (t) {
        const idx = t.indexOf('営業時間設定');
        if (idx > 0) t = t.slice(idx);
        // 末尾の注意書き以降(キャンセルポリシー等)は落とす
        const cut = t.indexOf('注意：');
        if (cut > 40) t = t.slice(0, cut);
        hoursText = t.slice(0, 1200);
      }
    }
    // 定休日らしき行
    const dh = heads.find((e) => /定休日/.test(e.textContent || ''));
    if (dh && dh.parentElement) {
      let h = norm(dh.parentElement.innerText);
      const idx = h.indexOf('営業時間設定');
      if (idx > 0) h = h.slice(idx);
      holidayText = h.slice(0, 300);
    }
    // キャンセルポリシー(構造化)
    const cancel = {
      use_kbn: val('cancelPolicyUseKbn'),
      note: val('cancelPolicyNote'),
      p1_price: val('cancelPolicy01FeePrice'),
      p1_rate: val('cancelPolicy01FeeRate'),
      p2_price: val('cancelPolicy02FeePrice'),
      p2_rate: val('cancelPolicy02FeeRate'),
    };
    // 即時予約受付・指名なし受付等の基本設定フラグも参考に拾う
    const flags = {
      free_rsv_stop: val('freeRsvStopFlg'),
      web_to_before: val('webToBeforeTime'),
      base_time_today: val('baseTimeOfWebToTodayTime'),
    };
    return { storeId, hoursText, holidayText, cancel, flags, title: document.title };
  }).catch(() => null);
  if (!data || !data.storeId) {
    return { rows: [], debug: { storeId: data && data.storeId, reason: 'no_store_id' } };
  }

  // ★掲載プロフィール (2026-07-11): 掲載管理→サロン(/CNK/draft/salonEdit)から
  //   キャッチ/PR文(コピー)/道案内アクセス/サロンからの一言 を追加取得する。
  //   基本設定(salonSetup)には無い「掲載情報」で、HPB サロンページの主要テキスト。
  //   実DOM(discover_listing 実機確認): salonEditForm の frmCnkSalonEditTopDto.salonTopCatch /
  //   .salonTopCopy、frmCnkSalonEditSalonCommentDto.messageStylistName / .messagePost。
  let profile = null;
  try {
    await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
    await page
      .goto(draftUrl(opts.genre, 'salonEdit', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    profile = await page
      .evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const v = (n) => {
          const e = document.querySelector(`[name="${n}"]`);
          return e ? norm(e.value) : null;
        };
        // 道案内・アクセス: ① name ヒント ② ラベル「道案内/アクセス」を持つ行の隣接値、で拾う。
        //   ※ salonEdit には "9.5/40" 等の掲載枠スコア表示があり誤検出しやすい。
        //     住所/道案内らしい「日本語を含む・スコア形式でない・十分長い」値のみ採用する。
        const looksLikeAccess = (s) =>
          !!s &&
          s.length >= 8 &&
          /[぀-ヿ一-鿿ぁ-ん]/.test(s) && // かな/漢字を含む
          !/^[\d.\/\s]+$/.test(s) && // "9.5/40" 等の数値スコアを除外
          !/^\d+(\.\d+)?\s*\/\s*\d+$/.test(s);
        let access = null;
        for (const el of Array.from(document.querySelectorAll('textarea, input[type="text"]'))) {
          const key = el.name || el.id || '';
          const val = norm(el.value);
          if (/access|direction|root|guide|douan/i.test(key) && looksLikeAccess(val)) {
            access = val.slice(0, 600);
            break;
          }
        }
        if (!access) {
          const labels = Array.from(document.querySelectorAll('th, td, dt, label, p'));
          for (const lb of labels) {
            const t = norm(lb.textContent);
            if (!/道案内|アクセス/.test(t) || t.length > 20) continue;
            const row = lb.closest('tr, dl, .mod_form, .formArea') || lb.parentElement;
            if (!row) continue;
            const field = row.querySelector('textarea, input[type="text"]');
            if (field && looksLikeAccess(norm(field.value))) { access = norm(field.value).slice(0, 600); break; }
            for (const c of Array.from(row.querySelectorAll('td, dd'))) {
              const cv = norm(c.textContent);
              if (cv !== t && looksLikeAccess(cv) && !/道案内|アクセス/.test(cv)) { access = cv.slice(0, 600); break; }
            }
            if (access) break;
          }
        }
        return {
          catch_copy: v('frmCnkSalonEditTopDto.salonTopCatch') || v('salonTopCatch'),
          pr_copy: v('frmCnkSalonEditTopDto.salonTopCopy') || v('salonTopCopy'),
          message_name: v('frmCnkSalonEditSalonCommentDto.messageStylistName'),
          message_body: v('frmCnkSalonEditSalonCommentDto.messagePost'),
          access,
        };
      })
      .catch(() => null);
  } catch (_e) {
    /* 掲載プロフィールは best-effort。基本設定だけでも返す。 */
  }

  const rows = [
    {
      external_id: String(data.storeId),
      business_hours: data.hoursText || null,
      holidays: data.holidayText || null,
      cancel_policy: data.cancel || null,
      flags: data.flags || null,
      // 掲載プロフィール(salonEdit 由来)。
      catch_copy: profile?.catch_copy || null,
      pr_copy: profile?.pr_copy || null,
      access: profile?.access || null,
      owner_message: profile?.message_body || null,
      owner_name: profile?.message_name || null,
      raw: { title: data.title, profile },
    },
  ];
  return { rows, debug: { storeId: data.storeId, hasHours: !!data.hoursText, hasProfile: !!(profile && (profile.catch_copy || profile.pr_copy)) } };
}

// =====================================================================
// サロン掲載プロフィール反映 (push_salon): KireidotAdmin で編集した
//   キャッチ / PR文(コピー) / サロンからの一言(氏名・メッセージ) を
//   /CNK/draft/salonEdit に書き込み、登録(doRegister)する。
//   実DOM(discover_listing 確認): salonEditForm(action /CNK/draft/salonEdit/doRegister)/
//   frmCnkSalonEditTopDto.salonTopCatch / .salonTopCopy /
//   frmCnkSalonEditSalonCommentDto.messageStylistName / .messagePost。
//   opts: { baseUrl, enablePush, salonId, shopName }
//   payload: { catch_copy?, pr_copy?, owner_name?, owner_message? }
//   戻り値: {status:'ok'} | {status:'confirm_only'} | {status:'failed', reason, errorCode, manualRequired}
// =====================================================================
async function pushSalonProfileViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => {
    captureErrorShot(page, `salon_fail_${errorCode || 'err'}`);
    return { status: 'failed', reason, errorCode, manualRequired };
  };

  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  await page
    .goto(draftUrl(opts.genre, 'salonEdit', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // フォーム到達確認。
  if ((await page.locator('form#salonEditForm, [name="frmCnkSalonEditTopDto.salonTopCatch"]').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'salon', 'no_form', { diagnostics: { url: page.url() } });
    return fail(`サロン掲載情報編集フォームを開けませんでした (最終URL=${page.url()}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 既存値を保ちつつ、payload に値がある項目だけ上書きする(空で他項目を消さない)。
  const filled = await page.evaluate((vals) => {
    const setVal = (name, v) => {
      if (v == null || v === '') return false;
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return false;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const done = [];
    if (setVal('frmCnkSalonEditTopDto.salonTopCatch', vals.catch_copy) || setVal('salonTopCatch', vals.catch_copy)) done.push('catch');
    if (setVal('frmCnkSalonEditTopDto.salonTopCopy', vals.pr_copy) || setVal('salonTopCopy', vals.pr_copy)) done.push('copy');
    if (setVal('frmCnkSalonEditSalonCommentDto.messageStylistName', vals.owner_name)) done.push('name');
    if (setVal('frmCnkSalonEditSalonCommentDto.messagePost', vals.owner_message)) done.push('message');
    return done;
  }, {
    catch_copy: p.catch_copy ?? null,
    pr_copy: p.pr_copy ?? null,
    owner_name: p.owner_name ?? null,
    owner_message: p.owner_message ?? null,
  }).catch(() => []);

  if (!filled.length) {
    return fail('反映対象の項目(キャッチ/PR/一言)が payload にありません', 'NO_FIELDS', true);
  }

  await captureScrapeDebug(page, 'salon', 'before_submit', { diagnostics: { filled, enablePush, url: page.url() } });

  if (!enablePush) {
    return { status: 'confirm_only', confirmed: { filled } };
  }

  // 登録: salonEdit は doRegister へ submit。登録ボタン(a[onclick*=doRegister] / img.jscButtonRegister /
  //   「登録」テキスト / input submit)を横断で押し、確認パネル/ダイアログにも対応。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let clickedRegister = false;
  try {
    const regBtn = page.locator(
      'a[onclick*="doRegister"], img.jscButtonRegister, a#regist, ' +
      'input[type="submit"][value*="登録"], a:has-text("登録する"), a:has-text("登録")'
    ).first();
    if ((await regBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'salon', 'no_register', { diagnostics: { url: page.url() } });
      return fail(`サロン掲載情報の「登録」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await regBtn.click({ timeout: 10_000 }).catch(() => {});
    clickedRegister = true;
    await page.waitForTimeout(1200);
    // 確認画面/パネルの最終確定。
    const finalBtn = page.locator(
      '#termsPanel a:visible:has-text("登録"), a[onclick*="doRegister"]:visible, a:visible:has-text("登録する"), input[type="submit"][value*="登録"]:visible'
    ).first();
    if ((await finalBtn.count().catch(() => 0)) > 0 && (await finalBtn.isVisible().catch(() => false))) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1200);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'salon', 'after', { diagnostics: { clickedRegister, nativeDialogAccepted, filled, url: page.url() } });
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /登録しました|保存しました|完了|反映しました|受け付け|更新しました/.test(bodyText);
  const looksError = /エラー|失敗|入力してください|必須|文字以下|選択してください/.test(bodyText) && !looksDone;
  if (looksError) {
    return fail(`サロン掲載情報の登録でエラー (${(bodyText.match(/.{0,40}(エラー|失敗|入力してください|必須|文字以下|選択してください).{0,30}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !clickedRegister && !nativeDialogAccepted) {
    return fail(`サロン掲載情報の登録完了を確認できませんでした (capture=${cap2 || '?'})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }
  return { status: 'ok', summary: `サロン掲載プロフィール反映 (${filled.join('/')})` };
}

// =====================================================================
// こだわり掲載情報 反映 (push_kodawari): 既存のこだわりページ(external_id=KDW<pageId>)の
//   タイトル/説明/キャッチ/コピーを kodawariEdit に書き込み登録する。
//   一覧の kodawariPageEditForm に pageId を入れて submit → 編集画面 → 入力 → doRegister。
//   payload: { external_id:'KDW<pageId>', title?, explanation?, catch_copy?, body_copy? }
// =====================================================================
async function pushKodawariViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => {
    captureErrorShot(page, `kodawari_fail_${errorCode || 'err'}`);
    return { status: 'failed', reason, errorCode, manualRequired };
  };
  // 実DOM(2026-07-12): pageId は 'KP00000000355195' 形式(英字接頭+数字)。数字のみではない。
  const pageId = String(p.external_id || '').replace(/^KDW/i, '').trim();
  if (!/^[A-Za-z]{0,4}\d{6,}$/.test(pageId)) {
    return fail(`こだわりの pageId (external_id) が不正です: ${p.external_id}`, 'BAD_PAYLOAD', true);
  }
  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  await page.goto(draftUrl(opts.genre, 'kodawariList', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  // 編集ページを開く: 行の編集リンク onclick=kodawariListEdit(event,'<pageId>') を実クリックし、
  //   SB側のネイティブハンドラに委ねる。フォーム手動 submit は onsubmit ハンドラ(modified 等の
  //   セットアップ)を飛ばすため編集画面が開かないことがある(実機 2026-07-12)。
  let opened = false;
  const editLink = page.locator(`a[onclick*="kodawariListEdit"][onclick*="${pageId}"]`).first();
  if ((await editLink.count().catch(() => 0)) > 0) {
    await editLink.click({ timeout: 10_000 }).catch(() => {});
    opened = true;
  }
  if (!opened) {
    // fallback: サイトのJS関数を直接呼ぶ → それも無ければフォーム submit。
    opened = await page.evaluate((pid) => {
      try {
        if (typeof window.kodawariListEdit === 'function') {
          window.kodawariListEdit({ preventDefault() {}, stopPropagation() {} }, pid);
          return true;
        }
      } catch (_e) { /* fallthrough */ }
      const f = document.querySelector('form#kodawariPageEditForm, form[action*="kodawariEdit"]');
      if (!f) return false;
      const inp = f.querySelector('[name="kodawariPageId"], [name*="kodawariPageId"]');
      if (inp) inp.value = pid;
      f.submit();
      return true;
    }, pageId).catch(() => false);
  }
  if (opened) await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  if ((await page.locator('[name="frmKodawariEditBaseInfoDto.kodawariTitle"], form#kodawariEditForm').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'kodawari', 'no_edit_form', { diagnostics: { pageId, url: page.url() } });
    return fail(`こだわり編集フォームを開けませんでした (pageId=${pageId}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  const filled = await page.evaluate((vals) => {
    const setVal = (name, v) => {
      if (v == null || v === '') return false;
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return false;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const done = [];
    if (setVal('frmKodawariEditBaseInfoDto.kodawariTitle', vals.title)) done.push('title');
    if (setVal('frmKodawariEditBaseInfoDto.kodawariExplanation', vals.explanation)) done.push('explanation');
    // 詳細1件目のキャッチ/コピー。
    const c0 = document.querySelector('[name*="kodawariDetailCatch"]');
    if (c0 && vals.catch_copy) { c0.value = String(vals.catch_copy); c0.dispatchEvent(new Event('input', { bubbles: true })); done.push('catch'); }
    const p0 = document.querySelector('[name*="kodawariDetailCopy"]');
    if (p0 && vals.body_copy) { p0.value = String(vals.body_copy); p0.dispatchEvent(new Event('input', { bubbles: true })); done.push('copy'); }
    return done;
  }, { title: p.title ?? null, explanation: p.explanation ?? null, catch_copy: p.catch_copy ?? null, body_copy: p.body_copy ?? null }).catch(() => []);
  if (!filled.length) return fail('反映対象(タイトル/説明/キャッチ/コピー)が payload にありません', 'NO_FIELDS', true);
  await captureScrapeDebug(page, 'kodawari', 'before_submit', { diagnostics: { pageId, filled, enablePush, url: page.url() } });
  if (!enablePush) return { status: 'confirm_only', confirmed: { filled } };
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let clicked = false;
  try {
    const regBtn = page.locator('a[onclick*="doRegister"], img.jscButtonRegister, input[type="submit"][value*="登録"], a:has-text("登録する"), a:has-text("登録")').first();
    if ((await regBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'kodawari', 'no_register', { diagnostics: { url: page.url() } });
      return fail(`こだわりの「登録」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await regBtn.click({ timeout: 10_000 }).catch(() => {});
    clicked = true;
    await page.waitForTimeout(1200);
    const finalBtn = page.locator('#termsPanel a:visible:has-text("登録"), a[onclick*="doRegister"]:visible, a:visible:has-text("登録する")').first();
    if ((await finalBtn.count().catch(() => 0)) > 0 && (await finalBtn.isVisible().catch(() => false))) {
      await Promise.all([page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}), finalBtn.click({ timeout: 10_000 }).catch(() => {})]);
      await page.waitForTimeout(1200);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    }
  } finally {
    page.off('dialog', onDialog);
  }
  const cap2 = await captureScrapeDebug(page, 'kodawari', 'after', { diagnostics: { clicked, nativeDialogAccepted, url: page.url() } });
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /登録しました|保存しました|完了|反映しました|更新しました|kodawariList/.test(bodyText) || /kodawariList/.test(page.url());
  const looksError = /エラー|失敗|入力してください|必須|文字以下/.test(bodyText) && !looksDone;
  if (looksError) return fail(`こだわり登録でエラー (${(bodyText.match(/.{0,40}(エラー|失敗|入力してください|必須|文字以下).{0,20}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  if (!looksDone && !clicked && !nativeDialogAccepted) return fail(`こだわり登録の完了を確認できませんでした (capture=${cap2 || '?'})`, 'UNKNOWN_ERROR', true);
  return { status: 'ok', externalId: `KDW${pageId}`, summary: `こだわり反映 (${filled.join('/')})` };
}

// =====================================================================
// 特集掲載情報 反映 (push_feature): 特集(external_id=SPC<specialId>)の掲載ON/OFF を
//   specialList の掲載チェック(doPresent)で切り替える。特集は HPB キュレーションのため
//   新規作成はできず、参加中特集の掲載状態トグルのみ。payload: { external_id, is_published? }
// =====================================================================
async function pushFeatureViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => {
    captureErrorShot(page, `feature_fail_${errorCode || 'err'}`);
    return { status: 'failed', reason, errorCode, manualRequired };
  };
  // 実DOM(2026-07-12): specialId は 'SL00000000137710' 形式(英字接頭+数字)。
  const specialId = String(p.external_id || '').replace(/^SPC/i, '').trim();
  if (!/^[A-Za-z]{0,4}\d{6,}$/.test(specialId)) {
    return fail(`特集の specialId (external_id) が不正です: ${p.external_id}`, 'BAD_PAYLOAD', true);
  }
  const wantPublished = p.is_published !== false;
  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  await page.goto(draftUrl(opts.genre, 'specialList', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  if ((await page.locator('form#specialListPresentForm, [name="specialId"]').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'feature', 'no_form', { diagnostics: { url: page.url() } });
    return fail(`特集一覧(specialList)を開けませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  // 対象特集の現在の掲載状態(presentFlg)と lastUpDate/specialSortDate を sort フォームから読む。
  //   doPresent はトグルなので、状態を変える時だけ submit する(冪等・安全)。
  const cur = await page.evaluate((sid) => {
    let idx = -1;
    for (const el of Array.from(document.querySelectorAll('input[name*="frmSpDtlDtoList"]'))) {
      const m = (el.name || '').match(/frmSpDtlDtoList\[(\d+)\]\.specialId$/);
      if (m && el.value === sid) { idx = Number(m[1]); break; }
    }
    if (idx < 0) return { found: false };
    const get = (suffix) => {
      const e = document.querySelector(`[name="frmSpDtlDtoList[${idx}].${suffix}"]`);
      return e ? e.value : '';
    };
    const sd = document.querySelector('form#specialListPresentForm [name="specialSortDate"], [name="specialSortDate"]');
    return { found: true, idx, presentFlg: get('presentFlg'), lastUpDate: get('lastUpDate'), specialSortDate: sd ? sd.value : '' };
  }, specialId).catch(() => ({ found: false }));
  if (!cur.found) {
    const cap = await captureScrapeDebug(page, 'feature', 'not_in_list', { diagnostics: { specialId, url: page.url() } });
    return fail(`特集 ${specialId} が一覧に見つかりません(参加中の特集ではない可能性)`, 'BAD_PAYLOAD', true);
  }
  const currentlyPublished = String(cur.presentFlg) === '1';
  await captureScrapeDebug(page, 'feature', 'before_submit', { diagnostics: { specialId, wantPublished, currentlyPublished, enablePush, url: page.url() } });
  // 既に目的の状態 → 何もしない(現在の掲載を壊さない)。
  if (currentlyPublished === wantPublished) {
    return { status: 'ok', externalId: `SPC${specialId}`, summary: `特集は既に掲載${wantPublished ? 'ON' : 'OFF'}(変更なし)` };
  }
  if (!enablePush) return { status: 'confirm_only', confirmed: { specialId, wantPublished, currentlyPublished } };
  // 掲載トグル: specialListPresentForm に specialId + lastUpDate + specialSortDate を入れて submit(doPresent)。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let submitted = false;
  try {
    submitted = await page.evaluate((v) => {
      const f = document.querySelector('form#specialListPresentForm, form[action*="specialList/doPresent"]');
      if (!f) return false;
      const set = (n, val) => { const e = f.querySelector(`[name="${n}"]`); if (e && val != null && val !== '') e.value = val; };
      set('specialId', v.sid);
      set('lastUpDate', v.lastUpDate);
      set('specialSortDate', v.specialSortDate);
      f.submit();
      return true;
    }, { sid: specialId, lastUpDate: cur.lastUpDate, specialSortDate: cur.specialSortDate }).catch(() => false);
    if (submitted) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } finally {
    page.off('dialog', onDialog);
  }
  if (!submitted) {
    const cap = await captureScrapeDebug(page, 'feature', 'no_present_form', { diagnostics: { url: page.url() } });
    return fail(`特集の掲載切替フォームが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  const cap2 = await captureScrapeDebug(page, 'feature', 'after', { diagnostics: { specialId, url: page.url() } });
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/エラー|失敗/.test(bodyText) && !/しました|完了/.test(bodyText)) {
    return fail(`特集掲載切替でエラー (capture=${cap2 || '?'})`, 'UNKNOWN_ERROR', true);
  }
  return { status: 'ok', externalId: `SPC${specialId}`, summary: `特集掲載切替 (${currentlyPublished ? 'ON' : 'OFF'}→${wantPublished ? 'ON' : 'OFF'})` };
}

// =====================================================================
// こだわり掲載情報 (掲載管理→こだわり) の取得。
//   一覧 /CNK/draft/kodawariList のテーブル(順番/PickUp/タイトル・ページタイプ/掲載)を読み、
//   各ページの詳細(タイトル/説明/キャッチ/コピー)は編集 /CNK/draft/kodawariEdit で補完する。
//   HPB サロンページの「こだわり」タブに流し込む READ 専用。
//   (DOM は 2026-07-11 discover_listing で実機確認: kodawariEditForm /
//    frmKodawariEditBaseInfoDto.kodawariTitle / .kodawariExplanation /
//    frmKodawariEditDetailInfoDtoList[i].kodawariDetailCatch / .kodawariDetailCopy)
// =====================================================================
async function scrapeKodawari(page, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  // グループ店舗(1ログイン複数サロン)は先にサロンを選ぶ。
  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  await page
    .goto(draftUrl(opts.genre, 'kodawariList', baseUrl), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // 一覧から各こだわりページの pageId / タイトル / 掲載状態 / 並び順を拾う。
  // ★実DOM(2026-07-11): データ行は th 無しの table に「上へ N 下へ | <タイトル>」形式で並ぶ。
  //   タイトルは並び替えコントロールの次セル。掲載状態は行内 "OK"(=掲載中) で判定。
  const list = await page
    .evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      // ★実DOM(2026-07-12): pageId は隠し sort フォーム frmKodawariListDtoList[i].kodawariPageId
      //   に順番に入る('KP00000000355195' 形式=英字接頭+数字。数字のみではない)。
      const pageIds = [];
      for (const el of Array.from(document.querySelectorAll('input[name*="frmKodawariListDtoList"]'))) {
        const m = (el.name || '').match(/frmKodawariListDtoList\[(\d+)\]\.kodawariPageId$/);
        if (m && el.value) pageIds[Number(m[1])] = el.value;
      }
      const out = [];
      const trs = Array.from(document.querySelectorAll('tr'));
      let n = 0;
      let sort = 0;
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => norm(c.textContent));
        const sortIdx = cells.findIndex((c) => /上へ[\s\S]*下へ/.test(c));
        if (sortIdx < 0) continue; // 並び替えコントロールを持つ行 = データ行のみ対象
        const m = cells[sortIdx].match(/(\d+)/);
        sort = m ? Number(m[1]) : sort + 1;
        // タイトル: 並び替えセルの直後の非空セル。
        let title = '';
        for (let i = sortIdx + 1; i < cells.length; i++) {
          if (cells[i] && !/^(OK|掲載|非掲載|削除|詳細)$/.test(cells[i])) { title = cells[i]; break; }
        }
        if (!title) continue;
        const rowText = norm(tr.textContent);
        // pageId: sort フォーム由来(行順 index 対応) を第一候補、行内 onclick
        //   kodawariListEdit(event, 'KP...') を fallback にする。
        let pageId = pageIds[n] || null;
        if (!pageId) {
          const mm = (tr.innerHTML || '').match(/kodawari(?:List)?(?:Page)?Edit\(\s*event\s*,\s*['"]([A-Za-z0-9]+)['"]/);
          if (mm) pageId = mm[1];
        }
        out.push({
          pageId,
          title: title.slice(0, 200),
          sortNo: sort,
          isPublished: /OK|掲載中/.test(rowText) || !/非掲載にする|掲載する/.test(rowText),
        });
        n++;
      }
      return out;
    })
    .catch(() => []);

  const rows = [];
  // 各ページの詳細(説明/キャッチ/コピー)を編集ページから補完 (最大10ページ)。
  for (const item of list.slice(0, 10)) {
    let detail = { title: item.title, explanation: '', catch: '', copy: '', pageType: '' };
    if (item.pageId) {
      try {
        // kodawariEdit は POST 遷移(kodawariPageEditForm に pageId を入れて submit)。
        //   一覧に戻り該当フォームを submit して編集ページを開く(GET は空になりがち)。
        await page.goto(draftUrl(opts.genre, 'kodawariList', baseUrl), {
          waitUntil: 'domcontentloaded', timeout: 20_000,
        }).catch(() => {});
        await page.waitForTimeout(300);
        // 編集リンクを実クリックしてネイティブハンドラで編集画面を開く(手動 submit は onsubmit を飛ばす)。
        let opened = false;
        const el = page.locator(`a[onclick*="kodawariListEdit"][onclick*="${item.pageId}"]`).first();
        if ((await el.count().catch(() => 0)) > 0) {
          await el.click({ timeout: 8_000 }).catch(() => {});
          opened = true;
        }
        if (!opened) {
          opened = await page.evaluate((pid) => {
            try {
              if (typeof window.kodawariListEdit === 'function') {
                window.kodawariListEdit({ preventDefault() {}, stopPropagation() {} }, pid);
                return true;
              }
            } catch (_e) { /* fallthrough */ }
            const f = document.querySelector('form#kodawariPageEditForm, form[action*="kodawariEdit"]');
            if (!f) return false;
            const inp = f.querySelector('[name="kodawariPageId"], [name*="kodawariPageId"]');
            if (inp) inp.value = pid;
            f.submit();
            return true;
          }, item.pageId).catch(() => false);
        }
        if (opened) await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(700);
        detail = await page.evaluate(() => {
          const v = (n) => { const e = document.querySelector(`[name="${n}"]`); return e ? (e.value || '') : ''; };
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const catches = Array.from(document.querySelectorAll('[name*="kodawariDetailCatch"]')).map((e) => norm(e.value)).filter(Boolean);
          const copies = Array.from(document.querySelectorAll('[name*="kodawariDetailCopy"]')).map((e) => norm(e.value)).filter(Boolean);
          return {
            title: norm(v('frmKodawariEditBaseInfoDto.kodawariTitle')),
            explanation: norm(v('frmKodawariEditBaseInfoDto.kodawariExplanation')),
            catch: catches.join(' / ').slice(0, 500),
            copy: copies.join(' / ').slice(0, 1000),
            pageType: '',
          };
        }).catch(() => detail);
      } catch (_e) { /* 詳細取得は best-effort */ }
    }
    rows.push({
      external_id: item.pageId ? `KDW${item.pageId}` : `KDW_${rows.length + 1}`,
      title: (detail.title || item.title || '').slice(0, 200),
      page_type: detail.pageType || null,
      explanation: detail.explanation || null,
      catch_copy: detail.catch || null,
      body_copy: detail.copy || null,
      is_published: item.isPublished !== false,
      sort_no: item.sortNo,
    });
  }
  return { rows, debug: { found: list.length, source: 'kodawariList' } };
}

// =====================================================================
// 特集掲載情報 (掲載管理→特集) の取得。
//   一覧 /CNK/draft/specialList のテーブル(順番/特集/クーポン/掲載チェック)を読む。
//   隠し sort フォーム frmSpDtlDtoList[i] から specialId/sortNo/presentFlg も併用する。
//   HPB サロンページの「特集」表示用 READ 専用。
//   (DOM は 2026-07-11 discover_listing で実機確認)
// =====================================================================
async function scrapeFeature(page, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  await page
    .goto(draftUrl(opts.genre, 'specialList', baseUrl), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  const rows = await page
    .evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      // specialId / presentFlg は隠し sort フォーム frmSpDtlDtoList[i] から順に拾う。
      const specialIds = [];
      const presentFlgs = [];
      for (const el of Array.from(document.querySelectorAll('input[name*="frmSpDtlDtoList"]'))) {
        const mi = (el.name || '').match(/frmSpDtlDtoList\[(\d+)\]\.specialId$/);
        if (mi && el.value) specialIds[Number(mi[1])] = el.value;
        const mp = (el.name || '').match(/frmSpDtlDtoList\[(\d+)\]\.presentFlg$/);
        if (mp) presentFlgs[Number(mp[1])] = el.value;
      }
      // ★実DOM(2026-07-11): データ行は th 無しの table に
      //   「上へ N 下へ | <特集名> | <クーポン> | … | (登録日) | OK」形式。
      const out = [];
      const trs = Array.from(document.querySelectorAll('tr'));
      let n = 0;
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => norm(c.textContent));
        const sortIdx = cells.findIndex((c) => /上へ[\s\S]*下へ/.test(c));
        if (sortIdx < 0) continue;
        const m = cells[sortIdx].match(/(\d+)/);
        const sort = m ? Number(m[1]) : n + 1;
        // 特集名: 並び替えセルの直後の非空セル。
        let title = '';
        for (let i = sortIdx + 1; i < cells.length; i++) {
          if (cells[i] && !/^(OK|掲載|非掲載|削除|詳細)$/.test(cells[i])) { title = cells[i]; break; }
        }
        if (!title) continue;
        const rowText = norm(tr.textContent);
        const sid = specialIds[n];
        // 掲載状態は presentFlg('1'=掲載中) を第一候補、無ければ行テキストで判定。
        const flg = presentFlgs[n];
        const is_published = flg != null && flg !== '' ? String(flg) === '1' : /OK|掲載中/.test(rowText);
        out.push({
          external_id: sid ? `SPC${sid}` : `SPC_${sort}`,
          title: title.slice(0, 200),
          is_published,
          sort_no: sort,
        });
        n++;
      }
      return out;
    })
    .catch(() => []);
  return { rows, debug: { found: rows.length, source: 'specialList' } };
}

async function scrapeStaff(page, opts = {}) {
  // ジャンル別分岐: 美容室(hair)はスタッフではなく「スタイリスト一覧」を取得する。
  // 他ジャンル(esthetic/nail/eyelash/other)は従来のスタッフ一覧 (/CNK/draft/staffList)。
  if (opts.genre === 'hair') {
    return scrapeStylists(page, opts);
  }
  await page.goto(STAFF_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // ----------------------------------------------------------------
  // SalonBoard 「スタッフ掲載情報一覧」の DOM 仕様 (確認済み):
  //
  // 1 つの <tbody> に全スタッフが並ぶ。1 スタッフ = 連続 2 つの <tr>:
  //
  //   <tr> 1行目: 順番 / PickUp / 写真 / 氏名 / 職種 / 施術歴 / チェック /
  //              詳細 / 非掲載・削除
  //   <tr> 2行目: キャッチコピー (colspan="4")
  //
  // 各スタッフの一意 ID は hidden input でフォーム配列として露出:
  //   <input type="hidden"
  //          name="frmStaffListStafferDtoList[N].staffId"
  //          value="W001161524">
  //   <input type="hidden"
  //          name="frmStaffListStafferDtoList[N].presentFlg"
  //          value="1">       <!-- 1=掲載中 / 0=非掲載 -->
  //   <input type="text"
  //          name="frmStaffListStafferDtoList[N].sortNo"
  //          value="1">       <!-- 順番 -->
  //
  // 旧実装 (方式 A/B/C/D) は DOM を「賢く解釈」しようとして失敗していたが、
  // 上記 input 配列の name 属性が SalonBoard 自身が用意した正規データなので、
  // これを起点に巡回するのが最も堅牢。
  // ----------------------------------------------------------------
  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    /** "W001161524" 形式のスタッフ外部 ID を文字列から抽出 */
    function extractStaffId(s) {
      if (!s) return null;
      const m = String(s).match(/[WNwn]\d{6,}/);
      return m ? m[0].toUpperCase() : null;
    }

    // hidden input の name から index を取り出す
    function indexFromName(name) {
      const m = String(name || '').match(/\[(\d+)\]\.staffId$/);
      return m ? Number(m[1]) : -1;
    }

    // 全 staffId 入力を取得 (= N の全配列)
    const staffIdInputs = Array.from(
      document.querySelectorAll(
        'input[name^="frmStaffListStafferDtoList["][name$=".staffId"]'
      )
    );

    // 結果と統計
    const items = [];
    const seenIds = new Set();
    const seenNames = new Set();
    let nameCollisionCount = 0; // 同名スタッフが居た場合の検知用 (debug)
    let withoutPhotoRow = 0;     // 写真行が見つからなかったケース

    for (const input of staffIdInputs) {
      const index = indexFromName(attr(input, 'name'));
      if (index < 0) continue;
      const extId = extractStaffId(attr(input, 'value')) || null;

      // 1 行目 (写真行) は input の祖先 <tr>
      const photoTr = input.closest('tr');
      if (!photoTr) {
        withoutPhotoRow++;
        continue;
      }
      // 2 行目 (キャッチコピー行) は写真行の直後の <tr>
      const catchTr =
        photoTr.nextElementSibling && photoTr.nextElementSibling.tagName === 'TR'
          ? photoTr.nextElementSibling
          : null;

      // ---- 写真 ----
      // SalonBoard は img name="staffPhoto" を付ける
      let photoEl = photoTr.querySelector('img[name="staffPhoto"]');
      if (!photoEl) photoEl = photoTr.querySelector('img');
      const photoUrl =
        attr(photoEl, 'src') || attr(photoEl, 'data-src') || null;

      // ---- 氏名 / 職種 / 施術歴 ----
      // 写真行の <td> を順に: 順番 / PickUp / 写真 / 氏名 / 職種 / 施術歴 ...
      // 写真 td は img を含むので、それを基準に「次の 2 つ」が 氏名 / 職種
      const tds = Array.from(photoTr.querySelectorAll('td'));
      let nameTd = null;
      let positionTd = null;
      const photoTdIdx = tds.findIndex((td) => td.querySelector('img'));
      if (photoTdIdx >= 0) {
        nameTd = tds[photoTdIdx + 1] ?? null;
        positionTd = tds[photoTdIdx + 2] ?? null;
      } else {
        // fallback: img が見つからなくても、input 直後の input/td 構造から推測
        nameTd = tds[3] ?? null;
        positionTd = tds[4] ?? null;
      }
      const name = txt(nameTd);
      const positionFull = txt(positionTd); // 例: "店長【指名料1000円】"

      // ---- キャッチコピー ----
      let catchPhrase = '';
      if (catchTr) {
        // キャッチ行は colspan="4" の td を持つ。それを優先で拾う
        const catchTd = catchTr.querySelector('td[colspan="4"]') ||
                        catchTr.querySelector('td');
        catchPhrase = txt(catchTd);
      }

      // ---- 指名料 / 職種 を分離 ----
      // "店長【指名料1000円】" → position="店長", designation_fee_raw="1000"
      let position = positionFull;
      let designationFeeRaw = null;
      const feeMatch = positionFull.match(/【\s*指名料\s*([\d,]+)\s*円?\s*】/);
      if (feeMatch) {
        designationFeeRaw = feeMatch[1];
        position = positionFull.replace(feeMatch[0], '').trim();
      } else {
        const feeMatch2 = positionFull.match(/指名料\s*([¥\\d,]+)/);
        if (feeMatch2) designationFeeRaw = feeMatch2[1];
      }

      // ---- 掲載状態 ----
      // 同インデックスの presentFlg input から取得
      const presentInput = document.querySelector(
        `input[name="frmStaffListStafferDtoList[${index}].presentFlg"]`
      );
      const presentValue = presentInput ? attr(presentInput, 'value') : null;
      // 1 = 掲載中, 0 = 非掲載。値が無ければ true 扱い (掲載中の方が多いため)
      const isPublished =
        presentValue === '0' ? false : true;

      // ---- 順番 (sortNo) ----
      const sortInput = document.querySelector(
        `input[name="frmStaffListStafferDtoList[${index}].sortNo"]`
      );
      const sortNo = sortInput ? Number(attr(sortInput, 'value')) : null;

      // ---- external_id の追加 source: onclick の関数引数 ----
      // 一部の行は onclick="staffEdit('W001161524')" 等を持つ
      let extIdFromOnclick = null;
      for (const a of photoTr.querySelectorAll('a[onclick]')) {
        const oc = attr(a, 'onclick') || '';
        const id = extractStaffId(oc);
        if (id) {
          extIdFromOnclick = id;
          break;
        }
      }

      const finalExtId = extId || extIdFromOnclick;

      // ---- 採用判定 ----
      // 名前が無いなら skip (ヘッダ行など)
      if (!name) continue;
      // de-dup
      if (finalExtId) {
        if (seenIds.has(finalExtId)) continue;
        seenIds.add(finalExtId);
      } else {
        if (seenNames.has(name)) {
          nameCollisionCount++;
          continue;
        }
        seenNames.add(name);
      }

      items.push({
        external_id:
          finalExtId ||
          // SalonBoard の hidden input が落ちている場合 (実際にはほぼ無い) に備えて
          // index ベースの代替キーを使う。次回 N が変わっても name でフォールバック
          // できるよう name キーも含める。
          `idx:${index}:name:${name.slice(0, 32)}`,
        name,
        position,
        catch_phrase: catchPhrase,
        photo_url: photoUrl,
        designation_fee_raw: designationFeeRaw,
        is_published: isPublished,
        sort_no: sortNo,
      });
    }

    return {
      items,
      staffIdInputs: staffIdInputs.length,
      nameCollisionCount,
      withoutPhotoRow,
    };
  });

  const rows = [];
  for (const it of raw.items) {
    rows.push({
      external_id: String(it.external_id),
      name: cleanText(it.name) ?? it.name,
      position: cleanText(it.position),
      designation_fee: parseYen(it.designation_fee_raw),
      catch_phrase: cleanText(it.catch_phrase),
      bio: null,
      photo_url: it.photo_url ? absoluteUrl(it.photo_url) : null,
      is_published: it.is_published !== false,
    });
  }
  return {
    rows,
    debug: {
      itemsFound: raw.items.length,
      parsed: rows.length,
      skipped: 0,
      // 後方互換のため旧フィールド名も残す (Admin/UI 側で参照されていなければ無視可能)
      totalLinks: 0,
      totalRows: 0,
      methodCContainers: 0,
      methodDImgTrs: 0,
      methodDExtracted: 0,
      methodDSamples: [],
      // 新しい診断情報
      staffIdInputs: raw.staffIdInputs,
      nameCollisionCount: raw.nameCollisionCount,
      withoutPhotoRow: raw.withoutPhotoRow,
    },
  };
}
function absoluteUrl(src) {
  if (!src) return null;
  if (/^https?:/i.test(src)) return src;
  try {
    return new URL(src, 'https://salonboard.com').toString();
  } catch (_e) {
    return src;
  }
}

// ----------------- ブログ一覧 (blogList) -----------------

const BLOG_LIST_URL = 'https://salonboard.com/KLP/blog/blogList/';
const BLOG_FORM_URL = 'https://salonboard.com/KLP/blog/blog/';

// =====================================================================
// ブログを SalonBoard に投稿する (KIREIDOT → SalonBoard)。
// 実 DOM (確認済み):
//   URL     : /KLP/blog/blog/  (title="SALON BOARD : ブログ編集 入力")
//   タイトル: input#blogTitle (name=title)
//   本文    : textarea#blogContents1 (段落1。複数段落 blogContents1..5)
//   投稿者  : select#staffId   カテゴリ: select#blogCategoryCd
//   画像    : a#upload.jscImageUploaderModalTrigger でモーダルを開き、
//             モーダル内 input[type=file] にセット → imagePath1..4 に格納
//             (uploadBlogCoverImage で payload.cover_image_url を添付)
//   確認へ  : <a id="confirm" class="mod_btn_confirm_03">
//             → 確認画面で最終「登録する」(a#regist 等 / a.accept ダイアログ)
//
// payload: { content_post_id, title, body_html, cover_image_url?, tags?, author_external_id? }
// opts: { baseUrl, enablePost }  enablePost=false なら確認まで(投稿確定しない)。
// 戻り値: { status:'ok', externalId? } | { status:'confirm_only' } | { status:'failed', ... }
// =====================================================================
// =====================================================================
// ブログのカバー画像を SalonBoard にアップロードする。
//
// SalonBoard ブログ編集フォームの画像アップロードは以下の構造 (実DOM):
//   トリガー : <a id="upload" class="jscImageUploaderModalTrigger">画像アップロード</a>
//   結果格納 : <input type="hidden" name="imagePath1..4" id="imagePath1..4">
//             (アップロード成功で imagePath1 などに画像パスが入る)
//   ファイル : モーダル内の <input type="file"> (name は sendFile 等)
//
// モーダル内部の DOM は固定でないため、複数のセレクタ候補でフォールバックし、
// 完了は「imagePath* に値が入る」か「サムネイルが増える」かで判定する。
// 各段でキャプチャを残し、失敗時に次回修正できるようにする。
//
// 戻り値: true=添付できた / false=添付できなかった (本文投稿は継続させる)
// =====================================================================
async function uploadBlogCoverImage(page, coverUrl) {
  // 1) 画像を公開URLからダウンロードして一時ファイルに保存
  let tmpFile = null;
  try {
    const resp = await page.context().request.get(coverUrl, { timeout: 20_000 });
    if (!resp.ok()) {
      await captureScrapeDebug(page, 'blog', 'image_download_failed', {
        diagnostics: { coverUrl, status: resp.status() },
      }).catch(() => {});
      return false;
    }
    const buf = await resp.body();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    let ext = 'jpg';
    if (ct.includes('png')) ext = 'png';
    else if (ct.includes('gif')) ext = 'gif';
    else if (ct.includes('webp')) ext = 'webp';
    else {
      const um = coverUrl.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i);
      if (um) ext = um[1].toLowerCase().replace('jpeg', 'jpg');
    }
    tmpFile = path.join(os.tmpdir(), `sb_blog_cover_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpFile, buf);
  } catch (e) {
    await captureScrapeDebug(page, 'blog', 'image_download_error', {
      diagnostics: { coverUrl, error: e?.message ?? String(e) },
    }).catch(() => {});
    return false;
  }

  const cleanup = () => { try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (_e) { /* noop */ } };

  // アップロード前の imagePath* の値を記録 (完了判定の基準)
  const beforePaths = await page.evaluate(() => {
    const out = {};
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById('imagePath' + i);
      out[i] = el ? (el.value || '') : '';
    }
    return out;
  }).catch(() => ({ 1: '', 2: '', 3: '', 4: '' }));

  try {
    // 2) 「画像アップロード」モーダルを開く。クリックで file chooser が直接開く実装も
    //    あり得るので fileChooser イベントを先に待ち受けておく。
    const trigger = page
      .locator('a#upload.jscImageUploaderModalTrigger, a#upload, a.jscImageUploaderModalTrigger, a:has-text("画像アップロード")')
      .first();
    if ((await trigger.count().catch(() => 0)) === 0) {
      await captureScrapeDebug(page, 'blog', 'image_no_trigger', { diagnostics: { url: page.url() } }).catch(() => {});
      cleanup();
      return false;
    }

    // クリックで file chooser が直接開くケースに備える
    let chooserFile = false;
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 4_000 }).then(async (chooser) => {
      await chooser.setFiles(tmpFile).catch(() => {});
      chooserFile = true;
    }).catch(() => { /* モーダル方式ならここには来ない */ });

    await trigger.click({ timeout: 8_000 }).catch(() => {});
    await Promise.race([chooserPromise, page.waitForTimeout(2_500)]);

    // 3) file chooser で入れられなかった場合はモーダル内の input[type=file] に直接セット。
    if (!chooserFile) {
      // モーダルが描画されるのを少し待つ
      await page.waitForTimeout(800);
      const fileInput = page
        .locator('input[type="file"][name="sendFile"], input[type="file"]#sendFile, .jscImageUploaderModal input[type="file"], .modal input[type="file"], input[type="file"]')
        .first();
      if ((await fileInput.count().catch(() => 0)) === 0) {
        await captureScrapeDebug(page, 'blog', 'image_no_file_input', { diagnostics: { url: page.url() } }).catch(() => {});
        cleanup();
        return false;
      }
      await fileInput.setInputFiles(tmpFile, { timeout: 8_000 }).catch(() => {});
      // ファイルを選ぶとモーダル内にプレビューが出る。描画を少し待つ。
      await page.waitForTimeout(1_200);

      // 4) モーダル内の「登録する」を押してアップロードを確定する。
      //    実DOM (確認済み, スクショ): 画像アップロードモーダル下部に「閉じる」「登録する」が並ぶ。
      //    ファイル選択でプレビューが出た後、「登録する」で imagePath* が確定する。
      //    ブログ本体にも「登録する」があるため、モーダルコンテナ内 or 最前面の visible な
      //    「登録する」に限定して誤爆を防ぐ。コンテナ class は不定なので候補を広く持つ。
      const modalContainers = [
        '.jscImageUploaderModal',
        '.imageUploaderModal',
        '.modaal-content',
        '.mod_modal',
        '.modal',
        '[role="dialog"]',
        '.ui-dialog',
        '.remodal',
      ];
      const regSelectors = [];
      for (const c of modalContainers) {
        regSelectors.push(`${c} a:has-text("登録する")`);
        regSelectors.push(`${c} button:has-text("登録する")`);
        regSelectors.push(`${c} input[type="button"][value*="登録"]`);
        regSelectors.push(`${c} input[type="submit"][value*="登録"]`);
      }
      regSelectors.push('a.jscImageUploadExec');
      // 最後の保険: 画面に見えている「登録する」(モーダルが最前面なので通常これが掴める)
      regSelectors.push('a:visible:has-text("登録する")');
      regSelectors.push('button:visible:has-text("登録する")');

      let clickedRegister = false;
      for (const sel of regSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click({ timeout: 8_000 }).catch(() => {});
          clickedRegister = true;
          break;
        }
      }
      if (!clickedRegister) {
        // 「登録する」が掴めない場合のフォールバック (旧来の「アップロード」系)
        const uploadBtn = page
          .locator('.jscImageUploaderModal a:has-text("アップロード"), .modal a:has-text("アップロード"), .jscImageUploaderModal a.mod_btn_upload_01, .modal a.accept, .modal input[type="submit"]')
          .first();
        if ((await uploadBtn.count().catch(() => 0)) > 0) {
          await uploadBtn.click({ timeout: 8_000 }).catch(() => {});
        } else {
          await captureScrapeDebug(page, 'blog', 'image_no_register_btn', { diagnostics: { url: page.url() } }).catch(() => {});
        }
      }
    }

    // 5) 完了判定: imagePath* のいずれかに新しい値が入るのを最大40秒待つ。
    //    SalonBoard の画像アップロードは「登録する」押下後に最大~30秒のローディングが
    //    あり(2026-06-30 実機スクショ確認)、従来の15秒では完了前にタイムアウトして
    //    imagePath が空のまま unconfirmed になっていた。
    const done = await page.waitForFunction((before) => {
      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('imagePath' + i);
        const v = el ? (el.value || '') : '';
        if (v && v !== before[i]) return true;
      }
      return false;
    }, beforePaths, { timeout: 40_000 }).then(() => true).catch(() => false);

    if (!done) {
      await captureScrapeDebug(page, 'blog', 'image_upload_unconfirmed', {
        diagnostics: { url: page.url(), chooserFile },
      }).catch(() => {});
      cleanup();
      return false;
    }

    // モーダルを閉じる (OK/完了/閉じるボタンがあれば)。無ければそのまま。
    const closeBtn = page
      .locator('.jscImageUploaderModal a:has-text("OK"), .jscImageUploaderModal a:has-text("完了"), .jscImageUploaderModal a:has-text("挿入"), .modal a:has-text("OK"), .modal a:has-text("挿入"), .modal a.accept, .modal a.close, a.jsImageModalClose')
      .first();
    if ((await closeBtn.count().catch(() => 0)) > 0) {
      await closeBtn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(600);
    }

    cleanup();
    return true;
  } catch (e) {
    await captureScrapeDebug(page, 'blog', 'image_upload_exception', {
      diagnostics: { url: page.url(), error: e?.message ?? String(e) },
    }).catch(() => {});
    cleanup();
    return false;
  }
}

/**
 * ブログ投稿フォームの「クーポン選択」モーダルで、紐付け済みクーポンを選択する。
 *
 * SalonBoard のクーポンモーダル DOM (2026-06 取得):
 *   - トリガー: a:has-text("クーポン選択") (.jsc_SB_modal_coupon_wrapper 内)
 *   - 一覧:     ul.jscCouponListArea > li > label.db
 *               各 li に <input type="hidden" value="CP00000012857772"> でクーポンを識別、
 *               同 li 内のクーポン名は p.jsc_SB_modal_coupon_text / p.couponText
 *   - 確定:     a.jsc_SB_modal_setting_btn ("設定する")
 *
 * @param {{externalId: string|null, couponName: string|null}} target
 * @returns {Promise<{ok: boolean, reason?: string, matchedExternalId?: string}>}
 */
async function selectBlogCoupon(page, target) {
  const wantExt = (target.externalId || '').trim().toUpperCase();
  const wantName = (target.couponName || '').replace(/\s+/g, '').trim();

  // 1) モーダルを開く
  //    ブログ: a:has-text("クーポン選択") / スタイル(styleEdit): a.jsc_SB_modal_single_coupon
  //    (img[alt="クーポン選択"] のボタンでテキストを持たない)
  const trigger = page
    .locator('.jsc_SB_modal_coupon_wrapper a:has-text("クーポン選択"), a[modal-url*="coupon" i]:has-text("クーポン選択"), a:has-text("クーポン選択"), a.jsc_SB_modal_single_coupon, .jsc_SB_modal_coupon_wrapper a.jsc_SB_modal_triger')
    .first();
  if ((await trigger.count().catch(() => 0)) === 0) {
    return { ok: false, reason: 'coupon_trigger_not_found' };
  }
  await trigger.click({ timeout: 6_000 }).catch(() => {});
  // モーダル(クーポン一覧)が描画されるまで待つ
  const listArea = page.locator('ul.jscCouponListArea, ul.couponListArea').first();
  await listArea.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if ((await listArea.count().catch(() => 0)) === 0) {
    return { ok: false, reason: 'coupon_list_not_visible' };
  }

  // 2) 対象クーポンの li を特定して、その中のチェック(label/checkbox)をクリック
  const picked = await page.evaluate(
    ({ wantExt, wantName }) => {
      const norm = (s) => (s || '').replace(/\s+/g, '').trim();
      const lis = Array.from(document.querySelectorAll('ul.jscCouponListArea > li, ul.couponListArea > li'));
      let matchedExternalId = null;
      for (const li of lis) {
        const hidden = li.querySelector('input[type="hidden"][value^="CP"]');
        const ext = (hidden?.getAttribute('value') || '').toUpperCase();
        const nameEl = li.querySelector('.jsc_SB_modal_coupon_text, .couponText, .couponMenuName');
        const name = norm(nameEl?.textContent || '');
        const hitByExt = wantExt && ext === wantExt;
        const hitByName = !wantExt && wantName && name && (name === wantName || name.includes(wantName) || wantName.includes(name));
        if (hitByExt || hitByName) {
          // li 内のチェック可能要素を探してチェックする
          let toggled = false;
          const cb = li.querySelector('input[type="checkbox"], input[type="radio"]');
          if (cb) {
            if (!cb.checked) {
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
              cb.dispatchEvent(new Event('click', { bubbles: true }));
            }
            toggled = true;
          }
          if (!toggled) {
            // チェックボックスが無い実装では、チェック対象のテーブル/ラベルをクリック
            const clickable =
              li.querySelector('.jsc_SB_modal_table_check') ||
              li.querySelector('label.db') ||
              li;
            clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            toggled = true;
          }
          matchedExternalId = ext || null;
          return { found: true, matchedExternalId };
        }
      }
      return { found: false, matchedExternalId: null };
    },
    { wantExt, wantName },
  );

  if (!picked || !picked.found) {
    // モーダルを閉じてから戻る (開いたまま投稿フローを汚さない)
    await page.locator('.jsc_SB_modal_close_btn').first().click({ timeout: 3_000 }).catch(() => {});
    return { ok: false, reason: wantExt ? `coupon_not_in_list(${wantExt})` : 'coupon_not_in_list_by_name' };
  }

  // 3) 「設定する」で確定
  const setBtn = page.locator('.jsc_SB_modal_setting_btn, a:has-text("設定する")').first();
  if ((await setBtn.count().catch(() => 0)) === 0) {
    return { ok: false, reason: 'coupon_setting_btn_not_found', matchedExternalId: picked.matchedExternalId };
  }
  await setBtn.click({ timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { ok: true, matchedExternalId: picked.matchedExternalId };
}

async function postBlogViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePost = opts.enablePost !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  // SalonBoard のブログは絵文字(🌿✨ 等)を「本文に利用不可文字が含まれています」として
  // 拒否し、確認画面で入力フォームに差し戻す(2026-06-30 実機: BIOPHYTO ブログが🌿✨多用で
  // confirmed=false・最終ボタン出ず)。投稿可能にするため絵文字・異体字セレクタ・ZWJ・国旗を
  // 除去する。★☆等のJIS記号は Extended_Pictographic ではないため温存される。
  // SB(Shift-JIS基盤)は JIS X 0208 外の文字を「本文に利用不可文字が含まれています」と
  // して拒否する(2026-06-30 実機で 🌿✨🏻⃣♡ が弾かれた)。絵文字本体・肌色modifier・
  // 結合囲みkeycap・各種記号を広く除去。★☆♪ は JIS X 0208 標準なので温存。
  const keepJis = (ch) => ('★☆♪'.includes(ch) ? ch : '');
  const stripBlogUnsupported = (s) =>
    String(s == null ? '' : s)
      .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')            // 絵文字本体+肌色modifier(🌿🏻)
      .replace(/[\u{2600}-\u{27BF}]/gu, keepJis)         // 記号・装飾(✨♡♫☀ 等。★☆♪のみ温存)
      .replace(/[\u{2B00}-\u{2BFF}]/gu, '')              // ⭐⬛ 等
      .replace(/[\u{2300}-\u{23FF}]/gu, '')              // ⌚⏰ 等
      .replace(/[\u{20D0}-\u{20FF}]/gu, '')              // 結合囲み記号(⃣ keycap)
      .replace(/[\u{FE00}-\u{FE0F}\u{200D}]/gu, '')      // 異体字セレクタ・ZWJ
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')            // 国旗(地域指示子)
      .replace(/\p{Extended_Pictographic}/gu, keepJis)   // 取りこぼし保険
      .replace(/[ \t　]{2,}/g, ' ')
      .replace(/[ \t　]+(\r?\n)/g, '$1');

  let title = stripBlogUnsupported((p.title && String(p.title).trim()) || '').trim();
  if (!title) return fail('ブログのタイトルが空です', 'UNKNOWN_ERROR', true);
  // SalonBoard のブログタイトルは全角25文字以内。超過分は切り詰めて投稿可能にする
  // (2026-06-30: AI生成タイトルが25字超で「タイトルは全角25文字以内」エラー多発)。
  if (title.length > 25) title = title.slice(0, 25).trim();
  // 本文: HTML タグを除いたプレーン化 (SalonBoard の textarea はプレーンテキスト想定)。
  const bodyPlain = stripBlogUnsupported(
    String(p.body_html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  ).trim();

  let formUrl;
  try { formUrl = new URL('/KLP/blog/blog/', baseUrl).toString(); } catch (_e) { formUrl = BLOG_FORM_URL; }
  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  // フォームに到達しているか
  if ((await page.locator('input#blogTitle, textarea#blogContents1').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'blog', `no_form`, { diagnostics: { url: page.url(), title: await page.title().catch(() => '') } });
    return fail(`ブログ投稿フォームに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 入力: タイトル / 本文 / 投稿者 / カテゴリ (投稿者・カテゴリ・本文は SalonBoard 必須)
  await page.locator('input#blogTitle').first().fill(title, { timeout: 8_000 }).catch(() => {});

  // 本文 (必須)。SalonBoard の本文は nicEdit リッチエディタで、送信用 textarea は
  // class="display_none" の hidden。隠し textarea に fill しても反映されないため、
  // contenteditable(.nicEdit-main) に入力し、hidden textarea(#blogContents/#blogContents1)
  // にも値を流し込んで input/change を発火させる。
  {
    const bodyText = (bodyPlain || title);
    const editor = page.locator('.nicEdit-main[contenteditable="true"]').first();
    if ((await editor.count().catch(() => 0)) > 0) {
      // 1) contenteditable に実際にフォーカスして type 入力。
      //    nicEdit は keyup/内部 instance.content を更新し、確認時に textarea へ saveContent する。
      await editor.click({ timeout: 6_000 }).catch(() => {});
      // 既存内容(<br>等)をクリア
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await editor.type(bodyText, { delay: 5 }).catch(async () => {
        // type が効かない場合は innerHTML 直書き + イベント発火にフォールバック
        await editor.evaluate((el, text) => {
          el.innerHTML = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
        }, bodyText).catch(() => {});
      });
      await editor.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }).catch(() => {});
    }
    // 2) nicEditors があれば saveContent() を呼んで全インスタンス→textarea を同期。
    //    さらに送信用 hidden textarea にも値を直書き (二重の保険)。
    await page.evaluate((text) => {
      const html = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
      try {
        if (typeof window !== 'undefined' && window.nicEditors && typeof window.nicEditors.findEditor === 'function') {
          // findEditor(textareaId) → instance.saveContent()
          for (const id of ['blogContents', 'blogContents1']) {
            const inst = window.nicEditors.findEditor(id);
            if (inst) {
              if (typeof inst.setContent === 'function') inst.setContent(html);
              if (typeof inst.saveContent === 'function') inst.saveContent();
            }
          }
        }
      } catch (_e) { /* noop */ }
      for (const id of ['blogContents', 'blogContents1']) {
        const ta = document.getElementById(id);
        if (ta && !String(ta.value || '').trim()) {
          ta.value = html;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, bodyText).catch(() => {});
  }

  // 投稿者 (select#staffId, 必須)。指定があればそれ、無ければ最初の有効スタッフを選ぶ。
  {
    const staffSel = page.locator('select#staffId').first();
    if ((await staffSel.count().catch(() => 0)) > 0) {
      let picked = false;
      if (p.author_external_id) {
        picked = await staffSel.selectOption({ value: String(p.author_external_id) }).then(() => true).catch(() => false);
      }
      if (!picked) {
        // 先頭の value 非空 option を選ぶ
        const val = await staffSel.evaluate((el) => {
          const opt = Array.from(el.options).find((o) => o.value && o.value.trim());
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return opt.value; }
          return null;
        }).catch(() => null);
        if (!val) {
          const cap = await captureScrapeDebug(page, 'blog', 'no_author', { diagnostics: { url: page.url() } });
          return fail(`ブログ投稿者(staffId)の選択肢がありません。SalonBoardで投稿者を登録してください (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
        }
      }
    }
  }

  // カテゴリ (select#blogCategoryCd, 必須)。指定が無ければ最初の有効カテゴリを選ぶ。
  {
    const catSel = page.locator('select#blogCategoryCd').first();
    if ((await catSel.count().catch(() => 0)) > 0) {
      const want = (p.category_code && String(p.category_code)) || null;
      let picked = false;
      if (want) picked = await catSel.selectOption({ value: want }).then(() => true).catch(() => false);
      if (!picked) {
        await catSel.evaluate((el) => {
          const opt = Array.from(el.options).find((o) => o.value && o.value.trim());
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }).catch(() => {});
      }
    }
  }

  // カバー画像アップロード (任意)。payload.cover_image_url の公開URLから画像を取得し、
  // SalonBoard のブログ画像アップロード(モーダル経由)で添付する。
  // 画像が無い/失敗しても本文投稿は継続する (画像で投稿全体を止めない)。
  if (p.cover_image_url) {
    try {
      await uploadBlogCoverImage(page, String(p.cover_image_url));
    } catch (e) {
      // 失敗は警告キャプチャのみ残して継続。
      await captureScrapeDebug(page, 'blog', 'image_upload_error', {
        diagnostics: { url: page.url(), error: e?.message ?? String(e), coverUrl: String(p.cover_image_url) },
      }).catch(() => {});
    }
  }

  // クーポン紐付け (任意)。payload.coupon_external_id (CP...) があれば、
  // ブログ投稿フォームの「クーポン選択」モーダルで該当クーポンを選ぶ。
  // external_id 一致を最優先、無ければ coupon_name のテキスト一致で補助。
  // 見つからない/失敗しても警告キャプチャのみでブログ投稿は継続する。
  if (p.coupon_external_id || p.coupon_name) {
    try {
      const sel = await selectBlogCoupon(page, {
        externalId: p.coupon_external_id ? String(p.coupon_external_id) : null,
        couponName: p.coupon_name ? String(p.coupon_name) : null,
      });
      if (!sel.ok) {
        await captureScrapeDebug(page, 'blog', 'coupon_not_selected', {
          diagnostics: { url: page.url(), reason: sel.reason, externalId: p.coupon_external_id ?? null, couponName: p.coupon_name ?? null },
        }).catch(() => {});
      }
    } catch (e) {
      await captureScrapeDebug(page, 'blog', 'coupon_select_error', {
        diagnostics: { url: page.url(), error: e?.message ?? String(e), externalId: p.coupon_external_id ?? null },
      }).catch(() => {});
    }
  }

  if (!enablePost) {
    return { status: 'confirm_only' };
  }

  // 「確認する」→ 確認画面 → 最終「登録する」。ネイティブ confirm / HTMLダイアログ両対応。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmed = false;
  let clickedConfirm = false; // 最初の「確認する」を(フォールバック含め)クリック済みか
  try {
    // 「確認する」ボタンは <a> とは限らない。SalonBoard は input[type=submit]/button の
    //   ことがある(2026-07-11 銀座ブログ: <a>セレクタで no_confirm 誤発報。画面には確認するボタン有り)。
    //   a / input / button を横断で拾い、それでも0件なら「確認する」テキストを持つ最寄りの
    //   クリック可能要素へフォールバックする。
    let confirmBtn = page
      .locator(
        'a#confirm, a.mod_btn_confirm_03, a:has-text("確認する"), ' +
          'input[type="submit"][value*="確認する"], input[type="button"][value*="確認する"], ' +
          'input[value="確認する"], button:has-text("確認する")'
      )
      .first();
    if ((await confirmBtn.count().catch(() => 0)) === 0) {
      // フォールバック: value/テキストに「確認する」を含む送信系要素を総当たり。
      confirmBtn = page
        .locator('input[type="submit"], input[type="button"], button, a')
        .filter({ hasText: /確認する/ })
        .first();
      // input は hasText でヒットしないので value でも探す。
      if ((await confirmBtn.count().catch(() => 0)) === 0) {
        const byVal = await page
          .evaluateHandle(() => {
            const els = Array.from(
              document.querySelectorAll('input[type="submit"],input[type="button"],button,a')
            );
            return els.find((e) => /確認する/.test(e.value || e.textContent || '')) || null;
          })
          .catch(() => null);
        const el = byVal && byVal.asElement ? byVal.asElement() : null;
        if (el) {
          try {
            await el.click({ timeout: 12_000 });
            await page.waitForTimeout(1500);
            clickedConfirm = true; // 下の確認画面フローへ進む
          } catch (_e) { /* fallthrough */ }
        }
      }
    }
    if (!clickedConfirm && (await confirmBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'blog', `no_confirm`, { diagnostics: { url: page.url() } });
      return fail(`ブログの「確認する」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    // フォールバックで既にクリック済みなら再クリックしない。
    if (!clickedConfirm) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        confirmBtn.click({ timeout: 12_000 }).catch(() => {}),
      ]);
    }
    await page.waitForTimeout(1500);
    // 確認画面の最終確定ボタン。
    // SalonBoard ブログ確認画面 (/KLP/blog/blog/confirm) の確定ボタンは
    //   a#reflect  「登録・反映する」 (= 公開してサロンボードに反映)
    //   a#unReflect「登録・未反映にする」(= 下書き)
    // 公開したいので #reflect / 「登録・反映する」を最優先。旧来の登録する/投稿する等も保険で残す。
    const finalBtn = page
      .locator('a#reflect:visible, a:has-text("登録・反映する"):visible, a.accept:visible, .buttons a.accept, a#regist:visible, a:has-text("登録する"):visible, a:has-text("投稿する"):visible, a.mod_btn_submit_01:visible, input[type="submit"][value*="登録"]')
      .first();
    await finalBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if ((await finalBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      confirmed = true;
      await page.waitForTimeout(1500);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'blog', `after`, { diagnostics: { confirmed, nativeDialogAccepted, url: page.url() } });

  // 検証
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /投稿しました|登録しました|公開しました|反映しました|登録が完了|完了|受け付け/.test(bodyText)
    || /\/blog\/blog\/(complete|done)/.test(page.url());
  const looksError = /エラー|失敗|入力してください|必須/.test(bodyText) && !looksDone;
  if (looksError) {
    return fail(`ブログ投稿でエラー (${(bodyText.match(/.{0,40}(エラー|失敗|入力してください|必須).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !confirmed && !nativeDialogAccepted) {
    return fail(`ブログ投稿の完了を確認できませんでした (confirmed=${confirmed}${cap2 ? `, capture=${cap2}` : ''})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }
  // 投稿後のブログ詳細URLから blogId を回収できれば external_id に
  let externalId = null;
  const m = page.url().match(/blogId=([A-Za-z0-9]+)/);
  if (m) externalId = m[1];
  return { status: 'ok', externalId };
}

/**
 * SalonBoard の口コミ(レビュー)に返信を投稿する。
 *
 * 返信入力ページ URL はジャンルで異なる:
 *   - エステ(esthe): /KLP/review/reviewReply/?reviewId=R...
 *   - 美容室(hair):  /CLP/bt/review/reviewReply/R...
 * フォーム要素 (実DOM確認済み):
 *   - 返信者名: input#replyFrom (name=replyFrom, maxlength 40・必須)
 *   - 返信本文: textarea (500文字以下/改行80回以下。カウンタ #id_reply_counter)
 *   - 確認: a#replyConfirm 「確認する」 → 確認画面 → 最終「登録する/反映する」
 *
 * payload: { external_review_id, reply_body, reply_from, genre? }
 * opts: { baseUrl, enablePost }
 * 戻り値: { status:'ok'|'confirm_only'|'failed', externalId?, reason?, errorCode?, manualRequired? }
 */
async function postReviewReplyViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePost = opts.enablePost !== false;
  const p = payload || {};
  const genre = p.genre === 'hair' ? 'hair' : 'esthetic';
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const reviewId = String(p.external_review_id || '').trim();
  if (!reviewId) return fail('口コミの管理番号(reviewId)がありません', 'UNKNOWN_ERROR', true);

  // 本文: プレーン化 + 500文字 / 改行80回に丸める (SB制限)
  let body = String(p.reply_body || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!body) return fail('返信本文が空です', 'UNKNOWN_ERROR', true);
  if (body.length > 500) body = body.slice(0, 500);
  // 改行80回以下に (超過分はスペースに)
  {
    let count = 0;
    body = body.replace(/\n/g, () => (++count <= 80 ? '\n' : ' '));
  }
  const replyFrom = String(p.reply_from || '').trim().slice(0, 40) || 'スタッフ一同';

  // 返信入力ページ URL
  const formUrl =
    genre === 'hair'
      ? new URL(`/CLP/bt/review/reviewReply/${encodeURIComponent(reviewId)}`, baseUrl).toString()
      : new URL(`/KLP/review/reviewReply/?reviewId=${encodeURIComponent(reviewId)}`, baseUrl).toString();

  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // フォーム到達確認 (返信者名 input が手掛かり)
  const fromInput = page.locator('input#replyFrom, input[name="replyFrom"]').first();
  if ((await fromInput.count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'review', 'no_reply_form', { diagnostics: { url: page.url(), title: await page.title().catch(() => '') } });
    return fail(`口コミ返信フォームに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  // 既に返信済み (本文 textarea が無い / 「返信済」表示) の場合は冪等にスキップ
  const replyArea = page
    .locator('textarea[name="replyContents"], textarea#replyContents, textarea[name="reply"], textarea#reply, .mod_title03_02 ~ table textarea, table.mod_table01 textarea')
    .first();
  if ((await replyArea.count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'review', 'no_reply_textarea', { diagnostics: { url: page.url() } });
    return fail(`返信本文の入力欄が見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 入力
  await fromInput.fill(replyFrom, { timeout: 8_000 }).catch(() => {});
  await replyArea.fill(body, { timeout: 8_000 }).catch(() => {});
  // input/change を発火 (カウンタや必須判定のため)
  await replyArea.dispatchEvent('input').catch(() => {});
  await replyArea.dispatchEvent('change').catch(() => {});

  if (!enablePost) {
    return { status: 'confirm_only' };
  }

  // 「確認する」→ 確認画面 → 最終「登録/反映」。ネイティブ confirm 両対応。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmed = false;
  try {
    // 「確認する」は <a> とは限らない(input[type=submit]/button のことがある)。横断で拾う。
    const confirmBtn = page
      .locator(
        'a#replyConfirm, a.mod_btn_confirm_04, a:has-text("確認する"), ' +
          'input[type="submit"][value*="確認する"], input[type="button"][value*="確認する"], ' +
          'input[value="確認する"], button:has-text("確認する")'
      )
      .first();
    if ((await confirmBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'review', 'no_confirm', { diagnostics: { url: page.url() } });
      return fail(`口コミ返信の「確認する」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      confirmBtn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    // バリデーションエラーで確認画面に進めていない場合
    const interimBody = (await page.locator('body').innerText().catch(() => '')) || '';
    if (/入力してください|必須|文字以下|改行/.test(interimBody) && !/確認/.test(interimBody)) {
      const cap = await captureScrapeDebug(page, 'review', 'validation', { diagnostics: { url: page.url() } });
      return fail(`返信内容のバリデーションエラー (${(interimBody.match(/.{0,30}(入力してください|必須|文字以下|改行).{0,20}/)?.[0] || '').trim()}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    // 確認画面の最終確定ボタン
    const finalBtn = page
      .locator('a#regist:visible, a#reflect:visible, a:has-text("登録する"):visible, a:has-text("返信する"):visible, a:has-text("登録・反映する"):visible, a.accept:visible, a.mod_btn_submit_01:visible, input[type="submit"][value*="登録"]')
      .first();
    await finalBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if ((await finalBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      confirmed = true;
      await page.waitForTimeout(1500);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'review', 'after', { diagnostics: { confirmed, nativeDialogAccepted, url: page.url() } });

  // 完了検証
  const after = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /返信しました|登録しました|受け付け|完了|審査中|返信済/.test(after)
    || /\/review\/reviewList/.test(page.url());
  const looksError = /エラー|失敗|入力してください|必須/.test(after) && !looksDone;
  if (looksError) {
    return fail(`口コミ返信でエラー (${(after.match(/.{0,40}(エラー|失敗|入力してください|必須).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !confirmed && !nativeDialogAccepted) {
    return fail(`口コミ返信の完了を確認できませんでした (confirmed=${confirmed}${cap2 ? `, capture=${cap2}` : ''})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }
  // external_id は口コミ管理番号をそのまま使う (返信は1口コミ1件)
  return { status: 'ok', externalId: reviewId };
}

async function scrapeBlogs(page, opts = {}) {
  // 詳細ページから本文を取得する最大件数 (順次アクセスのため負荷に注意)
  const maxDetails = Number.isFinite(opts.maxDetails) ? opts.maxDetails : 60;
  // ブログ一覧もジャンルで異なる: hair=/CLP/bt/blog/blogList/、エステ=/KLP/blog/blogList/。
  const blogListUrl = `https://salonboard.com${reservePathRoot(opts.genre)}/blog/blogList/`;
  await page.goto(blogListUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // ----------------------------------------------------------------
  // SalonBoard ブログ一覧の DOM 仕様 (確認済み):
  //
  //   <table id="blogListArea">
  //     <thead>...</thead>
  //     <tbody>
  //       <!-- 1 ブログ = 連続 2 つの <tr> -->
  //       <tr class="mod_middle">
  //         <td><a href="/KLP/blog/blog/?blogId=A116474081">タイトル</a></td>
  //         <td>カテゴリ</td>
  //         <td rowspan="2"><img></td>            <!-- 画像 (画像が無いと "-") -->
  //         <td rowspan="2">投稿者名<br>(本名)</td>
  //         <td>投稿日 / 更新日</td>
  //         <td rowspan="2">
  //           <a class="mod_btn_detail_01">詳細</a>
  //           <a class="mod_btn_delete_01" href="#A116474081">削除</a>
  //         </td>
  //       </tr>
  //       <tr>
  //         <td colspan="2">クーポン名 or "-"</td>
  //         <td>反映済み / 未反映 (ステータス)</td>
  //       </tr>
  //     </tbody>
  //   </table>
  //
  // 旧実装は単 tr 想定で blogId を fallback で取っていたが、上記の通り href の
  // ?blogId=XXX が確定で取れるので、それを起点に確実に抽出する。
  // ----------------------------------------------------------------
  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    /** "?blogId=A116474081" or "#A116474081" 形式から ID を抽出 */
    function extractBlogId(s) {
      if (!s) return null;
      const m1 = String(s).match(/[?&]blogId=([A-Za-z0-9_-]+)/);
      if (m1) return m1[1];
      const m2 = String(s).match(/#([A-Za-z0-9_-]{6,})/);
      if (m2) return m2[1];
      const m3 = String(s).match(/articleId=([A-Za-z0-9_-]+)/);
      if (m3) return m3[1];
      return null;
    }

    // タイトル行を見つける: blogId href を持つ tr
    const titleAnchors = Array.from(
      document.querySelectorAll('a[href*="blogId="]')
    );
    const seen = new Set();
    const items = [];
    let missingPairTr = 0;

    for (const anchor of titleAnchors) {
      const blogId = extractBlogId(attr(anchor, 'href'));
      if (!blogId) continue;
      if (seen.has(blogId)) continue; // 同一ブログの「詳細」リンクも引っかかるので skip
      seen.add(blogId);

      const titleTr = anchor.closest('tr');
      if (!titleTr) continue;
      const pairTr =
        titleTr.nextElementSibling && titleTr.nextElementSibling.tagName === 'TR'
          ? titleTr.nextElementSibling
          : null;
      if (!pairTr) missingPairTr++;

      const titleTds = Array.from(titleTr.querySelectorAll('td'));
      const pairTds = pairTr ? Array.from(pairTr.querySelectorAll('td')) : [];

      // タイトル (titleAnchor のテキスト = タイトル)
      const title = txt(anchor);

      // カテゴリ: titleTr の 2 番目の td (タイトル td の次)
      // titleAnchor が居る td を起点に「次の td」をカテゴリと判断
      const titleTd = anchor.closest('td');
      const titleTdIdx = titleTds.indexOf(titleTd);
      const category =
        titleTdIdx >= 0 && titleTds[titleTdIdx + 1]
          ? txt(titleTds[titleTdIdx + 1])
          : '';

      // 画像: titleTr 内の img (rowspan="2" で次行に跨る場合あり)
      const img = titleTr.querySelector('img');
      const coverUrl = attr(img, 'src') || attr(img, 'data-src') || null;
      // "-" だけのセルは画像無し
      const coverIsEmpty = !coverUrl;

      // 投稿者 (rowspan="2"): titleTr 内で img を含まない、(本名) を含む可能性のあるセル
      // 確実にとるため、「最も長いテキスト + 投稿日らしい文字列を含まない」セルを採用
      let authorTd = null;
      for (const td of titleTds) {
        if (td === titleTd) continue;
        if (td.querySelector('img')) continue;
        if (td.querySelector('a.mod_btn_detail_01, a.mod_btn_delete_01')) continue;
        const t = txt(td);
        if (!t) continue;
        if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(t)) continue; // 投稿日
        if (/^(ビューティー|ファッション|ヘア|ネイル|アイ|エステ|ボディ|食|その他|-)$/.test(t)) continue; // カテゴリ候補
        if (!authorTd || txt(td).length > txt(authorTd).length) {
          authorTd = td;
        }
      }
      // 投稿者名は "momoka <br>(土井 孝士郎)" のような形式。最初の改行/(の前を取る
      const authorRaw = txt(authorTd);
      const authorName = authorRaw
        .replace(/[\(（].*?[\)）]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // 投稿日: titleTr 内で "YYYY/MM/DD" or "YYYY-MM-DD" にマッチするセル
      let postedAtRaw = null;
      for (const td of titleTds) {
        const t = txt(td);
        const m = t.match(/\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?/);
        if (m) {
          postedAtRaw = m[0];
          break;
        }
      }

      // クーポン名 (pairTr 1番目の td)
      const couponName = pairTds[0] ? txt(pairTds[0]) : '';

      // ステータス (pairTr 内、最後の td が "反映済み" or "未反映")
      let statusText = '';
      for (const td of pairTds) {
        const t = txt(td);
        if (/反映済み|未反映|公開中|下書き/.test(t)) {
          statusText = t;
          break;
        }
      }
      const isPublished = /反映済み|公開中/.test(statusText);

      items.push({
        external_id: blogId,
        title,
        link_href: attr(anchor, 'href'),
        body_excerpt: couponName && couponName !== '-' ? couponName : null,
        cover_image_url: coverIsEmpty ? null : coverUrl,
        category: category && category !== '-' ? category : null,
        author_name: authorName || null,
        date_raw: postedAtRaw,
        view_raw: null, // SalonBoard 一覧には view 数がない
        is_published: isPublished,
      });
    }
    return { items, missingPairTr, titleAnchors: titleAnchors.length };
  });

  const rows = [];
  for (const it of raw.items) {
    rows.push({
      external_id: String(it.external_id),
      title: cleanText(it.title) ?? it.title,
      body_excerpt: it.body_excerpt,
      body_html: null,
      cover_image_url: it.cover_image_url ? absoluteUrl(it.cover_image_url) : null,
      category: it.category,
      author_external_id: null,
      author_name: it.author_name,
      posted_at: parseJstDateTime(it.date_raw) ?? null,
      is_published: it.is_published !== false,
      view_count: it.view_raw ? parseInt(it.view_raw, 10) : null,
      url: it.link_href ? absoluteUrl(it.link_href) : null,
    });
  }

  // 詳細ページを巡回して body_html を埋める。
  //   - 一覧で取れた URL が無い行はスキップ
  //   - 取得失敗は無視 (一覧側のメタデータは保持)
  let detailHit = 0;
  let detailMiss = 0;
  const targets = rows.filter((r) => r.url).slice(0, maxDetails);
  for (const r of targets) {
    try {
      await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      const detail = await page.evaluate(() => {
        function txt(el) {
          return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
        }
        // 本文ブロックの候補を広めに探し、最も大きいものを採用する。
        // SalonBoard 詳細ページのテンプレート差を吸収するため class 名で限定しない。
        const candidates = Array.from(
          document.querySelectorAll(
            '[class*="blogDetail" i], [class*="blogBody" i], [class*="article" i], [class*="entry" i], [class*="body" i], main, #content',
          ),
        );
        let best = null;
        let bestLen = 0;
        for (const el of candidates) {
          const t = txt(el);
          if (t.length > bestLen) {
            bestLen = t.length;
            best = el;
          }
        }
        // 最低限の閾値を満たさなければ body 全体から拾う
        if (!best || bestLen < 80) {
          best = document.body;
        }
        // 本文 HTML を取得 (script/style は除去)
        const clone = best.cloneNode(true);
        for (const tag of ['script', 'style', 'iframe', 'noscript']) {
          for (const n of Array.from(clone.querySelectorAll(tag))) n.remove();
        }
        // 画像の src を絶対 URL に
        for (const img of Array.from(clone.querySelectorAll('img'))) {
          const s = img.getAttribute('src') || img.getAttribute('data-src');
          if (s) {
            try {
              img.setAttribute('src', new URL(s, location.href).toString());
            } catch (_e) {
              /* ignore */
            }
          }
        }
        // 投稿日時の精度を上げる (詳細ページのほうが詳しいことが多い)
        const dateText = (document.body.textContent || '').match(
          /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:[^\d]+(\d{1,2}):(\d{2}))?/,
        );
        return {
          html: clone.innerHTML,
          text: txt(clone),
          dateHint: dateText ? dateText[0] : null,
        };
      });
      if (detail?.html) {
        r.body_html = String(detail.html).slice(0, 200_000);
        if (!r.body_excerpt && detail.text) {
          r.body_excerpt = String(detail.text).slice(0, 280);
        }
        if (!r.posted_at && detail.dateHint) {
          const dt = parseJstDateTime(detail.dateHint);
          if (dt) r.posted_at = dt;
        }
        detailHit++;
      } else {
        detailMiss++;
      }
    } catch (_e) {
      detailMiss++;
    }
  }

  return {
    rows,
    debug: {
      itemsFound: raw.items.length,
      parsed: rows.length,
      skipped: 0,
      detailHit,
      detailMiss,
      detailAttempted: targets.length,
      titleAnchors: raw.titleAnchors,
      missingPairTr: raw.missingPairTr,
    },
  };
}
// ----------------- 顧客詳細スクレイパー (Phase 4) -----------------

/**
 * 予約一覧から「顧客詳細リンク」を持つ行を取り出して、それぞれ詳細ページへ移動して
 * 電話番号/メール/誕生日/フルネームを取得する。
 *
 * 戻り値: [{ customer_code, full_name, phone, email, birthday }]
 *
 * 設計:
 *   - 予約一覧の各行から `a[href*="customerDetail"]` 等を集める
 *   - 重複は customer_code (URL から取れる ID) で除外
 *   - 各詳細ページで <dl>/<table> のラベル「電話/メール/生年月日」を探す
 *   - ページ遷移はスロットリング (1 件 800ms) して BOT 検知を避ける
 *   - 上限 maxCustomers で打ち切り (デフォルト 50)
 */
async function scrapeCustomerDetails(page, options = {}) {
  const maxCustomers = options.maxCustomers ?? 50;
  const throttleMs = options.throttleMs ?? 800;

  // 既に予約一覧ページが開かれている前提だが、念のため遷移
  await page.goto(RESERVE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // 予約一覧から顧客詳細リンク URL を全部集める
  const customerLinks = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll('a[href*="customerDetail"], a[href*="customer/detail"]'),
    );
    return links.map((a) => ({
      href: a.getAttribute('href'),
      label: (a.textContent || '').trim(),
    }));
  });

  // URL から顧客コードを取り出して重複除去
  const seen = new Set();
  const queue = [];
  for (const l of customerLinks) {
    const cid =
      extractIdFromUrl(l.href, 'customerId', 'memberId', 'cstId') || l.href;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    queue.push({ customer_code: cid, href: l.href });
    if (queue.length >= maxCustomers) break;
  }

  const out = [];
  for (const item of queue) {
    try {
      const detail = await page.evaluate(async (href) => {
        // 同期 navigation 用にあえてここでは fetch しない (Cookie が必要)
        const u = new URL(href, window.location.origin);
        return u.toString();
      }, item.href);
      await page.goto(detail, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

      const data = await page.evaluate(() => {
        function txt(el) {
          return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
        }
        // <dl>/<table> の「ラベル: 値」型を全部スキャン
        const all = Array.from(document.querySelectorAll('dt, th'));
        const map = {};
        for (const lab of all) {
          const k = txt(lab);
          if (!k) continue;
          const sib = lab.nextElementSibling;
          const v = txt(sib);
          if (v) map[k] = v;
        }
        const body = (document.body.textContent || '').replace(/\s+/g, ' ');
        return { map, body };
      });

      const find = (...keys) => {
        for (const k of Object.keys(data.map)) {
          for (const want of keys) {
            if (k.includes(want)) return data.map[k];
          }
        }
        return null;
      };
      const phoneRaw =
        find('電話', 'TEL', 'Tel', 'tel') || (data.body.match(/0\d{1,4}-\d{1,4}-\d{3,4}/) || [null])[0];
      const emailRaw =
        find('メール', 'Email', 'E-mail') ||
        (data.body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [null])[0];
      const birthdayRaw = find('生年月日', '誕生日');
      const fullName = find('氏名', 'お名前', '名前');

      out.push({
        customer_code: item.customer_code,
        full_name: cleanText(fullName),
        phone: cleanPhone(phoneRaw),
        email: cleanText(emailRaw),
        birthday: parseJstDate(birthdayRaw),
      });
    } catch (e) {
      // 1 件失敗してもループは続ける
      out.push({
        customer_code: item.customer_code,
        full_name: null,
        phone: null,
        email: null,
        birthday: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // スロットリング
    await new Promise((r) => setTimeout(r, throttleMs));
  }

  return {
    rows: out,
    debug: { itemsFound: customerLinks.length, parsed: out.length, skipped: customerLinks.length - out.length },
  };
}

function cleanPhone(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[^\d\-+()]/g, '').trim();
  return s || null;
}

// ----------------- スタッフスケジュール (salonSchedule) -----------------
//
// URL: https://salonboard.com/KLP/schedule/salonSchedule/
// 画面構造: スタッフ × 日付 のグリッド (週単位 / 月単位を切替) で、
//           各セルに 出勤時間 / 休み / 備考 が入る。
// 戻り値:
//   rows = [{ staff_external_id, staff_name, shift_date, start_time, end_time, is_off, note }]
//
// SalonBoard の HTML はテンプレ差が大きいため、複数の構造パターンを試す。
//   1. tr[data-staff-id] td[data-date] の構造
//   2. テーブル + thead に日付、左カラムにスタッフ名の二次元配列構造
//   3. それでも拾えない場合は本文の正規表現でテキストを切り出す
// =====================================================================

const SCHEDULE_URL = 'https://salonboard.com/KLP/schedule/salonSchedule/';

async function scrapeShifts(page) {
  await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }

    /**
     * 表示中の年月を画面のタイトルから推定する。
     * 「2026年5月」「2026/05」などのフォーマットを許容。
     * 取れなければ今日の年月を返す。
     */
    function pickBaseYearMonth() {
      const candidates = Array.from(
        document.querySelectorAll('h1,h2,h3,.ttl,[class*="title" i],[class*="caption" i]'),
      );
      for (const el of candidates) {
        const t = txt(el);
        const m = t.match(/(\d{4})[\/年\-\.](\d{1,2})/);
        if (m) return { y: Number(m[1]), m: Number(m[2]) };
      }
      const today = new Date();
      return { y: today.getFullYear(), m: today.getMonth() + 1 };
    }
    const base = pickBaseYearMonth();

    /** "10:00-19:00" / "10:00〜19:00" などから [start, end] を取り出す */
    function pickRange(s) {
      const m = s.match(/(\d{1,2}):(\d{2})\s*[〜~\-－ーto]+\s*(\d{1,2}):(\d{2})/);
      if (!m) return null;
      const pad = (x) => String(x).padStart(2, '0');
      return [`${pad(m[1])}:${m[2]}`, `${pad(m[3])}:${m[4]}`];
    }
    function isOffMark(s) {
      return /^(休|休み|−|—|-|×|OFF|休日|有給|希望休)$/u.test(s.replace(/\s/g, ''));
    }
    /** 日付文字列を YYYY-MM-DD に正規化。dayCell の data-date 優先。 */
    function dateFromCell(td, dayHint, monthHint) {
      const d = attr(td, 'data-date') || attr(td, 'data-day');
      if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
      if (d && /^\d{4}\/\d{1,2}\/\d{1,2}/.test(d)) {
        const m = d.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
        return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      }
      // フォールバック: thead から拾った日付ヒント (例: 月の何日目か)
      if (dayHint != null && monthHint != null) {
        return `${base.y}-${String(monthHint).padStart(2, '0')}-${String(dayHint).padStart(2, '0')}`;
      }
      return null;
    }

    // --- パターン1: tr ごとにスタッフ + td に日付セル ---
    const items = [];
    const rows = Array.from(document.querySelectorAll('table tr'));

    // ヘッダー行から日付の日 (1-31) を拾う
    let dayHeaders = []; // [{ col: number, day: number, month: number }]
    const headerRow = rows.find((tr) => tr.querySelector('th'));
    if (headerRow) {
      const ths = Array.from(headerRow.querySelectorAll('th,td'));
      ths.forEach((th, i) => {
        const t = txt(th);
        const m = t.match(/(\d{1,2})/);
        if (m) {
          dayHeaders.push({ col: i, day: Number(m[1]), month: base.m });
        }
      });
    }

    for (const tr of rows) {
      if (tr === headerRow) continue;
      const staffCell = tr.querySelector('th, td');
      if (!staffCell) continue;
      const staffName = txt(staffCell);
      if (!staffName || staffName.length > 30 || /\d{1,2}\/\d{1,2}/.test(staffName)) continue;
      const staffId =
        attr(tr, 'data-staff-id') ||
        attr(staffCell, 'data-staff-id') ||
        (attr(staffCell.querySelector('a[href]'), 'href') || '').match(/W\d{6,}/)?.[0] ||
        staffName;

      const cells = Array.from(tr.querySelectorAll('td'));
      cells.forEach((td, idx) => {
        if (td === staffCell) return;
        const t = txt(td);
        if (!t) return;

        // 日付の決定 (data-date 優先、無ければヘッダーから推定)
        const header = dayHeaders.find((h) => h.col === idx);
        const dateStr = dateFromCell(
          td,
          header ? header.day : null,
          header ? header.month : null,
        );
        if (!dateStr) return;

        const range = pickRange(t);
        const isOff = !range && isOffMark(t);
        if (!range && !isOff) return;
        items.push({
          staff_external_id: String(staffId),
          staff_name: staffName,
          shift_date: dateStr,
          start_time: range ? range[0] : null,
          end_time: range ? range[1] : null,
          is_off: !!isOff,
          note: range ? null : t.slice(0, 80),
        });
      });
    }
    return { items };
  });

  return {
    rows: raw.items,
    debug: { itemsFound: raw.items.length, parsed: raw.items.length, skipped: 0 },
  };
}

// ---------------------------------------------------------------------
// ブログ削除 (SalonBoard 上のブログを削除する)
//
// 入口: payload.external_blog_id (= SalonBoard の blogId, 例 "A116474081")
//   ・ブログ一覧 (/KLP/blog/blogList/) を開く
//   ・該当 blogId の削除リンク <a class="mod_btn_delete_01" href="#blogId"> をクリック
//   ・確認ダイアログ (HTMLダイアログ a.accept / ネイティブ confirm) を受け付ける
//   ・一覧から該当 blogId が消えたこと / 完了文言で成否を判定
//
// 戻り値: { status:'ok' } | { status:'confirm_only' } | { status:'failed', reason, errorCode, manualRequired }
//   enableDelete=false のとき実削除せず confirm_only を返す (安全弁)。
// ---------------------------------------------------------------------
async function deleteBlogViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enableDelete = opts.enableDelete !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const blogId = String(p.external_blog_id || p.salonboard_external_id || '').trim();
  if (!blogId) {
    return fail('削除対象の blogId (external_blog_id) がありません', 'UNKNOWN_ERROR', true);
  }

  let listUrl;
  try { listUrl = new URL('/KLP/blog/blogList/', baseUrl).toString(); } catch (_e) { listUrl = BLOG_LIST_URL; }
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // 一覧に該当 blogId が存在するか確認 (タイトルリンク or 削除リンク)
  const presentBefore = await page.evaluate((id) => {
    const hit = (sel) => Array.from(document.querySelectorAll(sel)).some((a) => (a.getAttribute('href') || '').includes(id));
    return hit('a[href*="blogId="]') || hit('a.mod_btn_delete_01');
  }, blogId).catch(() => false);

  if (!presentBefore) {
    // 既に SalonBoard 上に無い = 冪等に成功扱い (KIREIDOT 側だけ消したケース等)
    return { status: 'ok', alreadyAbsent: true };
  }

  if (!enableDelete) {
    return { status: 'confirm_only' };
  }

  // 削除リンクを特定: href に blogId を含む a.mod_btn_delete_01 を優先。
  // 無ければ blogId 行の中の削除ボタンを辿る。
  let deleteLink = page.locator(`a.mod_btn_delete_01[href*="${blogId}"]`).first();
  if ((await deleteLink.count().catch(() => 0)) === 0) {
    // フォールバック: タイトル行(tr)→ 同ブログの削除ボタン
    const viaRow = await page.evaluate((id) => {
      const titleA = Array.from(document.querySelectorAll('a[href*="blogId="]'))
        .find((a) => (a.getAttribute('href') || '').includes(id));
      if (!titleA) return false;
      const tr = titleA.closest('tr');
      const del = tr && tr.querySelector('a.mod_btn_delete_01');
      if (del) { del.setAttribute('data-kireidot-del', '1'); return true; }
      return false;
    }, blogId).catch(() => false);
    if (viaRow) deleteLink = page.locator('a.mod_btn_delete_01[data-kireidot-del="1"]').first();
  }

  if ((await deleteLink.count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'blog', `no_delete_${blogId}`, { diagnostics: { blogId, url: page.url() } });
    return fail(`ブログ削除ボタンが見つかりませんでした (blogId=${blogId}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // ネイティブ confirm が出るケースに備えて accept ハンドラを張る
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmClicked = false;
  try {
    await deleteLink.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
    // HTMLダイアログ「はい/OK/削除する」(.accept) をクリック
    const yesBtn = page
      .locator('a.accept:visible, .buttons a.accept, a:has-text("削除する"):visible, a:has-text("はい"):visible')
      .first();
    await yesBtn.waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
    if ((await yesBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        yesBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      confirmClicked = true;
    }
    await page.waitForTimeout(1200);
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'blog', `deleted_${blogId}`, {
    diagnostics: { blogId, confirmClicked, nativeDialogAccepted, url: page.url() },
  });

  // 検証1: 完了文言
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /削除しました|削除が完了|削除を受け付け|削除済/.test(bodyText);
  const looksError = /エラー|失敗/.test(bodyText) && !looksDone;

  // 検証2: 一覧を再読込し、該当 blogId が消えたか
  let stillPresent = true;
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    stillPresent = await page.evaluate((id) => {
      const hit = (sel) => Array.from(document.querySelectorAll(sel)).some((a) => (a.getAttribute('href') || '').includes(id));
      return hit('a[href*="blogId="]') || hit('a.mod_btn_delete_01');
    }, blogId).catch(() => true);
  } catch (_e) { /* noop */ }

  if (!stillPresent || looksDone) {
    return { status: 'ok', externalId: blogId };
  }
  if (looksError) {
    return fail(`ブログ削除でエラー (${(bodyText.match(/.{0,30}(エラー|失敗).{0,30}/)?.[0] || '').trim()}, capture=${cap2 || '?'})`, 'UNKNOWN_ERROR', true);
  }
  if (!confirmClicked && !nativeDialogAccepted) {
    return fail(`ブログ削除の確認ダイアログを操作できませんでした (blogId=${blogId}, capture=${cap2 || '?'})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }
  return fail(`ブログ削除の完了を確認できませんでした (blogId=${blogId}, capture=${cap2 || '?'})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
}

// =====================================================================
// グループ店舗(1ログイン複数サロン)対応:
// 現在 /(CNC|KLP)/groupTop/ (サロン選択画面) に居る場合、対象サロンを選んで店舗文脈に入る。
// worker-process.cjs の ensureStoreSelected と同等の処理を scrapers 内でも使えるようにする。
// スタイル/フォトギャラリーは page.goto で /CNB ・/CNK の編集画面に直接遷移するため、
// 遷移後に groupTop へ跳ね返されることがある。各 goto 後にこれを呼んで復帰させる。
//
// opts: { salonId?, shopName? }
// 戻り値: { ok, selected, reason? }
//   - groupTop に居ない (単一店舗 or 既に店舗文脈) → { ok:true, selected:false }
//   - サロンを選べた → { ok:true, selected:true }
//   - 選べない → { ok:false, reason }
// =====================================================================
async function ensureSalonSelected(page, opts = {}) {
  const salonId = (opts.salonId || '').trim().toUpperCase();
  const shopName = (opts.shopName || '').trim();

  let onGroupTop = /\/(?:CNC|KLP)\/groupTop/i.test(page.url());
  if (!onGroupTop) {
    onGroupTop = await page
      .locator('#biyouStoreInfoArea, #kireiStoreInfoArea, table.mod_table19 a[id^="H"]')
      .first()
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  }
  if (!onGroupTop) {
    return { ok: true, selected: false };
  }

  // ★店舗リンク(a[id^="H"])は groupTop で AJAX 遅延ロードされることがある。出現を待たずに
  //   読むと空判定になり group_top_no_stores を誤発報する(郡山ADERの0件の主因: 実機で
  //   同一店が数回0件→1回成功と intermittent だった)。出現待ち→空なら1回だけ読み直す。
  const readStores = () =>
    page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, '').trim();
      const out = [];
      for (const a of Array.from(document.querySelectorAll('a[id^="H"]'))) {
        const id = (a.getAttribute('id') || '').trim();
        if (!/^H\d{6,}$/i.test(id)) continue;
        out.push({ id: id.toUpperCase(), name: norm(a.textContent) });
      }
      return out;
    });
  await page
    .waitForSelector('a[id^="H"]', { timeout: 8_000 })
    .catch(() => {});
  let stores = await readStores();
  if (!stores.length) {
    // groupTop を読み直して再取得(AJAX遅延/瞬断/セッション温め直し)。
    await page
      .goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => {});
    await page
      .waitForSelector('a[id^="H"]', { timeout: 8_000 })
      .catch(() => {});
    await page.waitForTimeout(800);
    stores = await readStores();
  }
  if (!stores.length) return { ok: false, selected: false, reason: 'group_top_no_stores' };

  // 特定失敗時にエラーへ含める候補一覧 (H-code=サロン名)。これを見て
  // salonboard_credentials.salonboard_salon_id を設定すれば次回から確実に選択できる。
  const candidates = stores
    .slice(0, 8)
    .map((s) => `${s.id}=${(s.name || '').slice(0, 30)}`)
    .join(' / ');

  let target = null;
  if (salonId) {
    target = stores.find((s) => s.id === salonId) || null;
    if (!target) {
      return { ok: false, selected: false, reason: `salon_id_not_in_group(${salonId}) (候補: ${candidates})` };
    }
  } else if (shopName) {
    const want = shopName.replace(/\s+/g, '');
    target =
      stores.find((s) => s.name && (s.name === want || s.name.includes(want) || want.includes(s.name))) || null;
    if (!target) {
      return { ok: false, selected: false, reason: `group_top_name_unmatched (候補: ${candidates})` };
    }
  } else {
    // salon_id も店舗名も無く、グループが1店舗だけならそれを選ぶ。複数なら特定不能。
    if (stores.length === 1) target = stores[0];
    else return { ok: false, selected: false, reason: `group_top_no_target (候補: ${candidates})` };
  }

  // サロンのリンクは <a href="javascript:void(0);" id="H..."> で、クリックで
  // JS(フォームPOST/AJAX)経由で店舗文脈に入る。クリック → 遷移待ち。
  // 遷移が起きないケースに備え、URL 変化 or groupTop 離脱のいずれかを待つ。
  const beforeUrl = page.url();
  let clickError = null;
  for (let clickAttempt = 1; clickAttempt <= 2; clickAttempt++) {
    try {
      const link = page.locator(`a[id="${target.id}"]`).first();
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(clickAttempt === 1 ? 300 : 800);
      await link.click({ timeout: 8_000, force: clickAttempt > 1 });
    } catch (e2) {
      clickError = e2;
    }
    // 遷移 or URL変化を待つ (javascript:void リンクなので load イベントに頼らない)。
    await page.waitForFunction(
      (prev) => location.href !== prev || !/\/(?:CNC|KLP)\/groupTop/i.test(location.href),
      beforeUrl,
      { timeout: 8_000 },
    ).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    if (!/\/(?:CNC|KLP)\/groupTop/i.test(page.url())) break;
    if (clickAttempt === 1) {
      // AJAXのイベント登録が間に合わない個体があるため、同じgroupTopを再読込して再試行。
      await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await page.waitForSelector(`a[id="${target.id}"]`, { timeout: 8_000 }).catch(() => {});
    }
  }

  if (/\/(?:CNC|KLP)\/groupTop/i.test(page.url())) {
    return {
      ok: false,
      selected: false,
      reason: `still_on_group_top${clickError ? `: ${clickError?.message ?? clickError}` : ''}`,
      salonId: target.id,
    };
  }
  // サロン選択は POST→セッション確定→リダイレクトのため、直後の goto で戻されないよう少し待つ。
  await page.waitForTimeout(1200);

  // 美容室グループ（ADER等）は選択後に /CLP/bt/top/ へ入って初めて店舗文脈が確立する。
  // groupTop を離れただけではユーザエラー/システムエラーへ着地する場合があるため、hair
  // 呼び出しでは管理TOPを明示的に開いて肯定確認する。
  if (opts.genre === 'hair') {
    const hairTop = new URL('/CLP/bt/top/', opts.baseUrl || 'https://salonboard.com/').toString();
    if (!/\/CLP\/bt\/top\/?$/i.test(page.url())) {
      await page.goto(hairTop, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }
    const context = await page.evaluate(() => {
      const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
      return {
        hasMgmt: /予約管理|掲載管理/.test(body),
        hasPassword: !!document.querySelector('input[type="password"]'),
        errored: /システムエラー|サロンが選択されていません|サロン一覧からサロンを選択/.test(body),
        title: document.title || '',
        excerpt: body.slice(0, 160),
      };
    }).catch(() => ({ hasMgmt: false, hasPassword: true, errored: true, title: '', excerpt: '' }));
    if (!/\/CLP\/bt\/top\/?$/i.test(page.url()) || !context.hasMgmt || context.hasPassword || context.errored) {
      // グループ選択POSTが一見成功しても、セッション反映前の遷移競合で
      // 「サロンが選択されていません」へ着地する個体がある。対象Hコードを
      // groupTopからもう一度選び直し、管理TOPの肯定確認まで全工程を再実行する。
      if (!opts._hairContextRetry) {
        const groupTop = new URL('/CNC/groupTop/', opts.baseUrl || 'https://salonboard.com/').toString();
        await page.goto(groupTop, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        await page.waitForSelector('a[id^="H"]', { timeout: 8_000 }).catch(() => {});
        const retried = await ensureSalonSelected(page, {
          ...opts,
          _hairContextRetry: true,
        }).catch((e) => ({ ok: false, selected: false, reason: e?.message ?? String(e) }));
        if (retried.ok && retried.selected) return retried;
      }
      return {
        ok: false,
        selected: false,
        reason: `hair_context_not_established(url=${page.url()},title=${context.title},hasMgmt=${context.hasMgmt},errored=${context.errored},excerpt=${context.excerpt})`,
        salonId: target.id,
      };
    }
  }
  return { ok: true, selected: true, salonId: target.id, contextUrl: page.url() };
}

// =====================================================================
// フォトギャラリー投稿 (push_photo_gallery)
//
// 投稿先は payload.kind で分岐:
//   - "photo_gallery" (エステ等) … /CNK/draft/photoGalleryEdit の空き枠に
//        画像 + タイトル + キャプション + ジャンル + 掲載 を入れて一括登録(doRegister)。
//   - "style" (美容室)          … /CNB/draft/styleEdit/ の「スタイル新規追加」に
//        FRONT画像 + 必須項目(スタイリスト/コメント/スタイル名/カテゴリ/長さ/メニュー内容)
//        を入れて登録(doRegister)。実DOM: salonboard_code/美容室/スタイル登録_styleEdit.html。
//
// payload: {
//   gallery_id, kind, genre,
//   image_url,            // 先頭画像(カバー)の公開URL ← これを1枚アップロードする
//   images: string[],     // 全画像URL (将来複数枠対応用)
//   title?, caption?, author_external_id?,
//   tags?: string[],      // ハッシュタグ (美容室 styleEdit のハッシュタグ欄, 各≤20字, 最大5)
//   style?: {             // スタイル掲載情報 (美容室のみ。photo_galleries.salonboard_style 由来)
//     style_name?,        //   スタイル名 ≤30 (空なら title/caption 補完)
//     stylist_comment?,   //   スタイリストコメント ≤120
//     category_cd?,       //   SG01=レディース(既定) / SG02=メンズ
//     length_cd?,         //   長さ (レディース HL01-05/07/08, メンズ HL06/09-13)
//     menu_cds?: string[],//   メニュー内容チェック (MC01-MC04)
//     menu_text?,         //   メニュー内容テキスト ≤50 (必須項目, 空なら styleName)
//     coupon_external_id?,//   クーポン(CP...) 紐付け (任意)
//     coupon_name?,       //   クーポン名 (external_id が一覧に無い時の補助一致)
//   }
// }
// opts: { baseUrl, enablePost }  enablePost=false なら確認まで(登録確定しない)。
// 戻り値: { status:'ok', externalId? } | { status:'confirm_only' } | { status:'failed', reason, errorCode, manualRequired }
// =====================================================================

const PHOTO_GALLERY_EDIT_URL = 'https://salonboard.com/CNK/draft/photoGalleryEdit';

/**
 * 公開URLの画像を一時ファイルにダウンロードする。
 * 戻り値: { file, cleanup } | null
 */
async function downloadImageToTmp(page, url, tag, opts = {}) {
  try {
    // ★ソース画像は KIREIDOT(Supabase storage)ホスト = SalonBoard ではない。SB用の Decodo
    //   ISPプロキシを経由すると Supabase 側が 503 で弾く(2026-07-04 郡山 実測)。よって
    //   まず node の直接 fetch(プロキシ非経由=EC2の素の回線)で取得し、失敗時のみ
    //   page.context().request(プロキシ経由)へフォールバックする。
    let buf = null;
    let ct = '';
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); ct = (r.headers.get('content-type') || '').toLowerCase(); }
      else { await captureScrapeDebug(page, tag, 'image_download_failed', { diagnostics: { url, status: r.status, via: 'direct' } }).catch(() => {}); }
    } catch (e2) {
      await captureScrapeDebug(page, tag, 'image_download_error', { diagnostics: { url, error: e2?.message ?? String(e2), via: 'direct' } }).catch(() => {});
    }
    if (!buf) {
      const resp = await page.context().request.get(url, { timeout: 20_000 });
      if (!resp.ok()) {
        await captureScrapeDebug(page, tag, 'image_download_failed', {
          diagnostics: { url, status: resp.status(), via: 'proxy' },
        }).catch(() => {});
        return null;
      }
      buf = await resp.body();
      ct = (resp.headers()['content-type'] || '').toLowerCase();
    }
    let ext = 'jpg';
    if (ct.includes('png')) ext = 'png';
    else if (ct.includes('gif')) ext = 'gif';
    else if (ct.includes('webp')) ext = 'webp';
    else {
      const um = String(url).split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i);
      if (um) ext = um[1].toLowerCase().replace('jpeg', 'jpg');
    }
    let outBuf = buf;
    let outExt = ext;
    // SalonBoard のスタイル/フォトギャラリー画像は小さすぎると
    // 「通信に失敗しました」でアップロードが拒否される。
    // opts.minShortSide 指定時、短辺がそれ未満なら Chromium canvas で拡大する。
    const minShort = Number(opts.minShortSide) || 0;
    if (minShort > 0) {
      try {
        const dataUrl = `data:${ct || 'image/jpeg'};base64,${buf.toString('base64')}`;
        const resized = await page.evaluate(async ({ src, minShort }) => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return null;
          const short = Math.min(w, h);
          if (short >= minShort) return null; // 拡大不要
          const scale = minShort / short;
          const cw = Math.round(w * scale), ch = Math.round(h * scale);
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, cw, ch);
          return canvas.toDataURL('image/jpeg', 0.92);
        }, { src: dataUrl, minShort }).catch(() => null);
        if (resized && /^data:image\/jpeg;base64,/.test(resized)) {
          outBuf = Buffer.from(resized.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
          outExt = 'jpg';
        }
      } catch (_e) { /* 拡大失敗時は元画像のまま続行 */ }
    }
    const file = path.join(os.tmpdir(), `sb_${tag}_${Date.now()}.${outExt}`);
    fs.writeFileSync(file, outBuf);
    return { file, cleanup: () => { try { fs.unlinkSync(file); } catch (_e) { /* noop */ } } };
  } catch (e) {
    await captureScrapeDebug(page, tag, 'image_download_error', {
      diagnostics: { url, error: e?.message ?? String(e) },
    }).catch(() => {});
    return null;
  }
}

async function postPhotoGalleryViaForm(page, payload, opts = {}) {
  const p = payload || {};
  const kind = p.kind === 'style' ? 'style' : 'photo_gallery';
  if (kind === 'style') {
    return postHairStyleViaForm(page, payload, opts);
  }
  return postEstheticPhotoGalleryViaForm(page, payload, opts);
}

// ---- エステ等: /CNK/draft/photoGalleryEdit ----
async function postEstheticPhotoGalleryViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePost = opts.enablePost !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const imageUrl = (p.image_url && String(p.image_url)) ||
    (Array.isArray(p.images) && p.images.length ? String(p.images[0]) : '');
  if (!imageUrl) return fail('フォトギャラリーの画像URLが空です', 'UNKNOWN_ERROR', true);

  const title = (p.title && String(p.title).trim()) || '';
  const caption = (p.caption && String(p.caption).trim()) || '';

  let formUrl;
  try { formUrl = draftUrl(opts.genre, 'photoGalleryEdit', baseUrl); } catch (_e) { formUrl = PHOTO_GALLERY_EDIT_URL; }
  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});

  // グループ店舗(1ログイン複数サロン)で groupTop に跳ね返された場合はサロンを選び直してから入り直す。
  {
    const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
    if (!sel.ok) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'store_select', { diagnostics: { url: page.url(), reason: sel.reason } });
      return fail(`グループ店舗のサロン選択に失敗しました (${sel.reason}, capture=${cap || '?'})。店舗のSalonBoard設定でサロンID(H...)を登録してください。`, 'STORE_SELECT_REQUIRED', true);
    }
    if (sel.selected) {
      await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    }
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  if ((await page.locator('form#photoGalleryEditForm').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'photo_gallery', 'no_form', { diagnostics: { url: page.url(), title: await page.title().catch(() => '') } });
    return fail(`フォトギャラリー編集フォームに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 1) 空き枠の index を特定 (jscPhotogalleryPhotoId の value が空の最小 index)。
  //    無ければ「入力欄を追加する」(jscAddRow) を押して dn 枠を増やしてから再探索。
  const findEmpty = async () => page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input.jscPhotogalleryPhotoId'));
    for (const el of els) {
      const m = (el.getAttribute('name') || '').match(/^frmPhotoGalleryInfoDtoList\[(\d+)\]\.photogalleryPhoto$/);
      if (!m) continue;
      if (!String(el.value || '').trim()) return Number(m[1]);
    }
    return -1;
  });
  let idx = await findEmpty();
  if (idx < 0) {
    // 入力欄を追加して空き枠を作る
    const addBtn = page.locator('a.jscAddRow').first();
    if ((await addBtn.count().catch(() => 0)) > 0) {
      await addBtn.click({ timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(800);
      idx = await findEmpty();
    }
  }
  if (idx < 0) {
    const cap = await captureScrapeDebug(page, 'photo_gallery', 'no_empty_slot', { diagnostics: { url: page.url() } });
    return fail(`フォトギャラリーの空き枠が見つかりませんでした (上限に達している可能性。capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  const nameOf = (field) => `frmPhotoGalleryInfoDtoList[${idx}].${field}`;
  // 該当枠の table を特定 (画像ID hidden の closest table)。
  const rowTable = page.locator(`input[name="${nameOf('photogalleryPhoto')}"]`).first()
    .locator('xpath=ancestor::table[contains(@class,"jscTableBody")][1]');

  // dn(display:none) の枠だと操作できないので外す + 画面内へスクロール。
  await rowTable.evaluate((el) => { el.classList.remove('dn'); el.scrollIntoView({ block: 'center' }); }).catch(() => {});

  // 2) 画像をダウンロード → 枠のアップロードUIで添付。
  const dl = await downloadImageToTmp(page, imageUrl, 'photo_gallery');
  if (!dl) {
    return fail('フォトギャラリー画像のダウンロードに失敗しました', 'UNKNOWN_ERROR', true);
  }
  const uploaded = await uploadPhotoGallerySlotImage(page, idx, rowTable, dl.file);
  dl.cleanup();
  if (!uploaded.ok) {
    const diagStr = Array.isArray(uploaded.diag) && uploaded.diag.length ? JSON.stringify(uploaded.diag) : '(no diag)';
    const cap = await captureScrapeDebug(page, 'photo_gallery', 'image_upload_unconfirmed', { diagnostics: { url: page.url(), idx, reason: uploaded.reason, diag: uploaded.diag || [] } });
    return fail(`フォトギャラリー画像のアップロードを確認できませんでした (${uploaded.reason || ''}) diag=${diagStr} (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 3) タイトル(任意 30字) / キャプション(任意 60字) を入力。
  if (title) {
    await page.locator(`input[name="${nameOf('photogalleryTitle')}"]`).first()
      .fill(title.slice(0, 30), { timeout: 6_000 }).catch(() => {});
  }
  if (caption) {
    await page.locator(`textarea[name="${nameOf('photogalleryCaption')}"]`).first()
      .fill(caption.slice(0, 60), { timeout: 6_000 }).catch(() => {});
  }

  // 4) ジャンル: defaultGenreCd があればそれ、無ければ最初の非空 option を選ぶ。
  {
    const genreSel = page.locator(`select[name="${nameOf('photogalleryGenreCd')}"]`).first();
    if ((await genreSel.count().catch(() => 0)) > 0) {
      const def = await page.locator(`input[name="${nameOf('defaultGenreCd')}"]`).first()
        .inputValue().catch(() => '');
      let picked = false;
      if (def && def.trim()) {
        picked = await genreSel.selectOption({ value: def.trim() }).then(() => true).catch(() => false);
      }
      if (!picked) {
        await genreSel.evaluate((el) => {
          const opt = Array.from(el.options).find((o) => o.value && o.value.trim());
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }).catch(() => {});
      }
    }
  }

  // 5) 掲載 radio = 1 (常に掲載)。
  await page.locator(`input[name="${nameOf('photogalleryPresentFlg')}"][value="1"]`).first()
    .check({ timeout: 4_000 }).catch(() => {});

  if (!enablePost) {
    return { status: 'confirm_only' };
  }

  // 6) 「登録」(img.jscButtonRegister) を押して doRegister。
  //    ネイティブ confirm が出る実装にも備える。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let clickedRegister = false;
  try {
    const regBtn = page.locator('img.jscButtonRegister, .jscButtonRegister').first();
    if ((await regBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'no_register', { diagnostics: { url: page.url() } });
      return fail(`フォトギャラリーの「登録」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      regBtn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    clickedRegister = true;
    await page.waitForTimeout(1500);
    // 確認画面に「登録する」等が出る場合は最終確定を押す (出なければ no-op)。
    const finalBtn = page.locator('a:has-text("登録する"):visible, a.accept:visible, input[type="submit"][value*="登録"]:visible, img.jscButtonRegister:visible').first();
    if ((await finalBtn.count().catch(() => 0)) > 0 && (await finalBtn.isVisible().catch(() => false))) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1200);
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'photo_gallery', 'after', { diagnostics: { clickedRegister, nativeDialogAccepted, idx, url: page.url() } });

  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /登録しました|保存しました|完了|反映しました|受け付け/.test(bodyText)
    || /photoGalleryEdit\/(complete|done)/.test(page.url());
  const looksError = /エラー|失敗|入力してください|必須|上限/.test(bodyText) && !looksDone;
  if (looksError) {
    return fail(`フォトギャラリー登録でエラー (${(bodyText.match(/.{0,40}(エラー|失敗|入力してください|必須|上限).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !clickedRegister && !nativeDialogAccepted) {
    return fail(`フォトギャラリー登録の完了を確認できませんでした (capture=${cap2 || '?'})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }

  // external_id: 割り当てられた画像ID(C...) を回収できれば返す。
  let externalId = uploaded.imageId || null;
  return { status: 'ok', externalId };
}

/**
 * photoGalleryEdit の指定枠(idx)に画像を1枚アップロードする。
 * 枠の「アップロード」UI (mod_btn_upload / jscUploadImg) をクリックし、
 * file chooser かモーダル内 input[type=file] に setInputFiles。
 * 完了は jscPhotogalleryPhotoId(value=画像ID C...) が入るかで判定する。
 * 戻り値: { ok, imageId?, reason? }
 */
async function uploadPhotoGallerySlotImage(page, idx, rowTable, file) {
  const idHidden = page.locator(`input[name="frmPhotoGalleryInfoDtoList[${idx}].photogalleryPhoto"]`).first();
  const before = await idHidden.inputValue().catch(() => '');

  // 診断ログ (失敗時に何が起きたかを surface する)。
  const diag = [];
  const onResp = async (resp) => { try { if (/\/imgreg\//i.test(resp.url())) diag.push({ url: resp.url().replace(/^https?:\/\/[^/]+/, ''), status: resp.status() }); } catch (_e) {} };
  const onReqFail = (req) => { try { if (/\/imgreg\//i.test(req.url())) diag.push({ url: req.url().replace(/^https?:\/\/[^/]+/, ''), failed: req.failure()?.errorText || 'fail' }); } catch (_e) {} };
  page.on('response', onResp); page.on('requestfailed', onReqFail);
  const detach = () => { try { page.off('response', onResp); page.off('requestfailed', onReqFail); } catch (_e) {} };

  // クリックで file chooser が直接開くケースに備える
  let chooserDone = false;
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 4_000 }).then(async (chooser) => {
    await chooser.setFiles(file).catch(() => {});
    chooserDone = true;
  }).catch(() => { /* モーダル方式 */ });

  // アップロードトリガー (枠内のアップロードボタン → 無ければ画像エリア)。
  // 当該枠の <a class="db jscUploadImg"><img class="mod_btn_upload">。click ハンドラ(委譲)で
  // img_upload_modal_view(...) が呼ばれモーダル(#imgUploadForm)がAJAXで開く。
  let trigger = rowTable.locator('a.jscUploadImg, img.mod_btn_upload, .jscUploadImg').first();
  if ((await trigger.count().catch(() => 0)) === 0) {
    // rowTable 内に無ければページ全体から idx に紐づくトリガーを探す保険。
    trigger = page.locator('a.jscUploadImg, img.mod_btn_upload').first();
  }
  if ((await trigger.count().catch(() => 0)) === 0) {
    detach();
    return { ok: false, reason: 'no_upload_trigger', diag };
  }
  diag.push({ trigger: 'found' });
  // dn/非表示でもクリックを発火させる。jQuery 委譲ハンドラが拾えるよう、当該枠の
  // mod_btn_upload(アップロードボタン) と jscUploadImg(画像) の両方に
  // 本物の MouseEvent を dispatch する (force click だけだと handler が走らないことがある)。
  await trigger.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
  const clickResult = await page.evaluate((i) => {
    const fire = (el) => { if (!el) return false; ['mousedown', 'mouseup', 'click'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))); return true; };
    // idx に対応する枠 (photogalleryPhoto[i]) の table を起点に upload ボタンを探す。
    const hid = document.querySelector(`input[name="frmPhotoGalleryInfoDtoList[${i}].photogalleryPhoto"]`);
    const table = hid ? hid.closest('table.jscTableBody') : null;
    const scope = table || document;
    const btn = scope.querySelector('img.mod_btn_upload');
    const img = scope.querySelector('a.jscUploadImg, img.jscPhotogalleryPhotoImg');
    let fired = false;
    if (btn) fired = fire(btn) || fired;
    if (img) fired = fire(img) || fired;
    return { fired, hasTable: !!table };
  }, idx).catch(() => ({ fired: false }));
  diag.push({ clickDispatch: clickResult });
  // playwright のクリックも併用 (どちらかが効けばよい)。
  await trigger.click({ timeout: 5_000, force: true }).catch(() => {});
  await Promise.race([chooserPromise, page.waitForTimeout(2_500)]);

  // ============================================================
  // 送信方式: 既定はブラウザXHR(本来のアップロード)。Akamai はブラウザを信頼するため
  // ステルス実Chrome下ではこれが通る。worker直接POSTは env SALONBOARD_DIRECT_POST=1 の時のみ
  // (Playwright request は Akamai に弾かれやすいので切り分け用)。
  // ============================================================
  const PREFER_DIRECT_POST = /^(1|true|yes)$/i.test(process.env.SALONBOARD_DIRECT_POST ?? '');
  if (!chooserDone && PREFER_DIRECT_POST) {
    const modalOpened = await page.waitForFunction(() => {
      const f = document.querySelector('#imgUploadForm');
      const t = f && f.querySelector('input[name="targetActionId"]');
      // モーダル本体やファイル input が現れたかも含めて検知。
      const anyModal = document.querySelector('#imageUploaderModalBody #imgUploadForm, input.jscImageUploaderModalInput, .jscImageUploaderModalDropArea');
      return !!(t && (t.value || '').trim()) || !!anyModal;
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
    diag.push({ modalOpened });
    const params = await page.evaluate(() => {
      const f = document.querySelector('#imgUploadForm');
      if (!f) return null;
      const g = (name) => { const el = f.querySelector(`input[name="${name}"]`); return el ? (el.value || '') : ''; };
      const ctx = (typeof window !== 'undefined' && window.CONTEXT_URL_STR) || '/CNK';
      const ustr = (typeof window !== 'undefined' && window.URL_STR) || 'imgUpload/';
      const wFlg = g('wFlg');
      const url = ctx + '/imgreg/' + ustr + 'doUpload' + (wFlg === 'true' ? '?wFlg=true' : '');
      return {
        url, setImgId: g('setImgId'), dataKey: g('dataKey'), targetActionId: g('targetActionId'),
        token: g('org.apache.struts.taglib.html.TOKEN'), storeId: g('STORE_ID'),
        modified: g('modified'), pubManageId: g('pubManageId'), hasForm: true,
      };
    }).catch(() => null);

    diag.push({ direct_post_params: params ? { hasForm: params.hasForm, targetActionId: params.targetActionId ? 'set' : 'EMPTY', token: params.token ? 'set' : 'EMPTY' } : 'params=null(modal未表示)' });

    if (params && params.targetActionId) {
      try {
        const buf = fs.readFileSync(file);
        const name = path.basename(file);
        const ext = (name.split('.').pop() || 'jpg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const absUrl = new URL(params.url, page.url()).toString();
        const pageUrl = page.url();
        // Akamai 対策: ブラウザ風ヘッダ + タイムアウト/中断時リトライ(最大3回)。
        const reqHeaders = { 'referer': pageUrl, 'origin': new URL(pageUrl).origin, 'x-requested-with': 'XMLHttpRequest', 'accept': 'text/html, */*; q=0.01' };
        const buildMultipart = () => ({
          formFile: { name, mimeType: mime, buffer: buf },
          setImgId: params.setImgId, dataKey: params.dataKey, targetActionId: params.targetActionId,
          'org.apache.struts.taglib.html.TOKEN': params.token, STORE_ID: params.storeId,
          modified: params.modified, pubManageId: params.pubManageId,
        });
        let resp = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            resp = await page.context().request.post(absUrl, { timeout: 25_000, headers: reqHeaders, multipart: buildMultipart() });
            break;
          } catch (e) { diag.push({ direct_post_retry: attempt, error: e?.message?.split('\n')[0] ?? String(e) }); await page.waitForTimeout(1200).catch(() => {}); }
        }
        if (!resp) { detach(); return { ok: false, reason: 'direct_post_blocked', diag }; }
        const html = await resp.text().catch(() => '');
        const applied = await page.evaluate((resHtml) => {
          try {
            const tmp = document.createElement('div'); tmp.innerHTML = resHtml;
            const get = (id) => { const e = tmp.querySelector('#' + id); return e ? (e.value !== undefined ? e.value : e.textContent) : ''; };
            if (String(get('userErrorFlg')) !== '0') return { ok: false };
            const imageId = get('imageId'); const elementName = get('elementName'); const imageFilePath = get('imageFilePath');
            if (typeof window.setUploadImage === 'function') { try { window.setUploadImage(imageId, elementName, imageFilePath); } catch (_e) {} }
            if (typeof window.modalClose === 'function') { try { window.modalClose(); } catch (_e) {} }
            try { const b = document.getElementById('imageUploaderModalBody'); if (b) b.innerHTML = ''; } catch (_e) {}
            return { ok: true, imageId };
          } catch (_e) { return { ok: false }; }
        }, html).catch(() => ({ ok: false }));

        if (applied && applied.ok) {
          const ok = await page.waitForFunction(({ i, prev }) => {
            const el = document.querySelector(`input[name="frmPhotoGalleryInfoDtoList[${i}].photogalleryPhoto"]`);
            const v = el ? (el.value || '') : '';
            return !!v && v !== prev;
          }, { i: idx, prev: before }, { timeout: 8_000 }).then(() => true).catch(() => false);
          if (ok) {
            detach();
            const imageId = await idHidden.inputValue().catch(() => '');
            return { ok: true, imageId: (imageId || '').trim() || null, via: 'direct_post', diag };
          }
        }
        diag.push({ direct_post_result: { status: resp.status(), bodyHead: (html || '').slice(0, 200) } });
      } catch (e) { diag.push({ direct_post_error: e?.message ?? String(e) }); }
    }
  }

  // file chooser で入らなかったらモーダル/直 input にセット (直接POSTが使えない時のフォールバック)。
  if (!chooserDone) {
    // ★モーダル(#imgUploadForm)は click 後に AJAX で開くため即座には現れない。
    //   旧実装は 700ms 固定待ちで、AJAX 完了前に no_file_input で諦めていた(郡山 hair で多発)。
    //   → file input を最大8秒ポーリング。現れなければトリガーを一度だけ再クリックして再度待つ
    //   (click 取りこぼし / ログイン後モーダルが一瞬被さって初回クリックを奪ったケースの保険)。
    const fileSel =
      'input.jscImageUploaderModalInput, #imgUploadForm input[type="file"], .modal input[type="file"], input[type="file"]:visible, input[type="file"]';
    let fileInput = page.locator(fileSel).first();
    let appeared = await fileInput
      .waitFor({ state: 'attached', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      diag.push({ modal_reclick: true });
      await trigger.click({ timeout: 4_000, force: true }).catch(() => {});
      fileInput = page.locator(fileSel).first();
      appeared = await fileInput
        .waitFor({ state: 'attached', timeout: 6_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (appeared) {
      await fileInput.setInputFiles(file, { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      // モーダルの「登録する」(input.jscImageUploaderModalSubmitButton)。
      const okBtn = page.locator('input.jscImageUploaderModalSubmitButton, a:visible:has-text("登録する"), button:visible:has-text("登録する"), input[type="submit"][value*="登録"]:visible').first();
      if ((await okBtn.count().catch(() => 0)) > 0 && (await okBtn.isVisible().catch(() => false))) {
        await okBtn.click({ timeout: 8_000 }).catch(() => {});
      }
    } else {
      detach();
      return { ok: false, reason: 'no_file_input', diag };
    }
  }

  // 完了判定: 当該枠の photogalleryPhoto hidden に新しい画像ID(C...) が入る。
  const done = await page.waitForFunction(({ i, prev }) => {
    const el = document.querySelector(`input[name="frmPhotoGalleryInfoDtoList[${i}].photogalleryPhoto"]`);
    const v = el ? (el.value || '') : '';
    return !!v && v !== prev;
  }, { i: idx, prev: before }, { timeout: 15_000 }).then(() => true).catch(() => false);
  detach();

  if (!done) return { ok: false, reason: 'imageId_not_set', diag };
  const imageId = await idHidden.inputValue().catch(() => '');
  return { ok: true, imageId: (imageId || '').trim() || null, diag };
}

// ---- 美容室: /CNB スタイル掲載情報編集/登録 (styleEdit) ----
// 実DOM: salonboard_code/美容室/スタイル登録_styleEdit.html
// スタイル一覧 → 「スタイル新規追加」(addStyle) で /CNB/draft/styleEdit/ を開き、
// FRONT 画像 + 必須項目(スタイリスト/コメント/スタイル名/カテゴリ/長さ/メニュー内容) を入れて登録。
async function postHairStyleViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePost = opts.enablePost !== false;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const imageUrl = (p.image_url && String(p.image_url)) ||
    (Array.isArray(p.images) && p.images.length ? String(p.images[0]) : '');
  if (!imageUrl) return fail('スタイルの画像URLが空です', 'UNKNOWN_ERROR', true);
  const title = (p.title && String(p.title).trim()) || '';
  const caption = (p.caption && String(p.caption).trim()) || '';
  // スタイル掲載情報 (Admin/AI入力, payload.style)。
  //   { style_name, stylist_comment, category_cd(SG01/SG02), length_cd(HL...),
  //     menu_cds([MC01..MC04]), menu_text, coupon_external_id, coupon_name }
  // 未指定の項目は従来どおりデフォルト補完する (必須未入力はサーバエラーになるため)。
  const style = p.style && typeof p.style === 'object' ? p.style : {};
  // スタイル名(必須, ≤30) / コメント(必須, ≤120)。指定 > title/caption 相互補完 > 既定文。
  const styleName = (String(style.style_name || '').trim() || title || caption || 'スタイル').slice(0, 30);
  const comment = (String(style.stylist_comment || '').trim() || caption || title || 'よろしくお願いいたします。').slice(0, 120);

  // 1) スタイル一覧 → 「スタイル新規追加」で styleEdit を開く。
  try {
    const listUrl = new URL('/CNB/draft/styleList/', baseUrl).toString();
    // グループ店舗はサロン未選択のまま /CNB/draft/styleList/ へ直接遷移すると
    // 「ユーザエラー」に着地する(groupTop に跳ね返らないため後追いの
    // ensureSalonSelected が効かず、スタイル登録フォームに到達できず失敗する。
    // ADER 郡山で判明)。salonId があれば先に groupTop でサロンを選んでから入る。
    if (opts.salonId) {
      await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
    }
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    // まだ groupTop に跳ね返された場合はサロンを選び直す。
    const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
    if (!sel.ok) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_store_select', { diagnostics: { url: page.url(), reason: sel.reason } });
      return fail(`グループ店舗のサロン選択に失敗しました (${sel.reason}, capture=${cap || '?'})。店舗のSalonBoard設定でサロンID(H...)を登録してください。`, 'STORE_SELECT_REQUIRED', true);
    }
    if (sel.selected) {
      // サロン選択後にスタイル一覧へ入り直す。
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    }
  } catch (_e) { /* noop */ }

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // 「スタイル新規追加」ボタン (addStyle)。
  const addBtn = page.locator('a[onclick*="addStyle"], a:has(img[alt="スタイル新規追加"])').first();
  if ((await addBtn.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      addBtn.click({ timeout: 10_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(800);
  } else {
    // ボタンが無ければ styleEdit に直接遷移を試みる。
    try {
      await page.goto(new URL('/CNB/draft/styleEdit/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    } catch (_e) { /* noop */ }
  }

  // styleEdit フォームに到達したか。
  if ((await page.locator('form#styleEditForm, input#styleNameTxt, input[name="frmStyleEditStyleDto.styleName"]').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_no_form', { diagnostics: { url: page.url(), title: await page.title().catch(() => '') } });
    return fail(`スタイル登録フォームに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 2) FRONT 画像をアップロード。
  //    ※手動では同じ画像が一瞬でアップロードできるため、画像サイズは原因ではない。
  //    canvas 拡大は page.evaluate(base64) が重く遅延要因になりうるので行わない
  //    (原画像をそのまま使う = 手動と同条件)。
  const dl = await downloadImageToTmp(page, imageUrl, 'photo_gallery');
  if (!dl) return fail('スタイル画像のダウンロードに失敗しました', 'UNKNOWN_ERROR', true);
  const uploaded = await uploadHairStyleFrontImage(page, dl.file);
  dl.cleanup();
  if (!uploaded.ok) {
    // 画像アップロードの /imgreg/ 通信ログ(URL/status/本文先頭)を捉えていれば要約して残す。
    const imgregSummary = Array.isArray(uploaded.imgreg) && uploaded.imgreg.length
      ? uploaded.imgreg.map((r) => {
          if (r.direct_post_params) return `directParams:${JSON.stringify(r.direct_post_params)}`;
          if (r.via === 'direct_post') return `directPOST ${(r.url || '').replace(/^https?:\/\/[^/]+/, '')} → ${r.failed ? 'FAIL:' + r.failed : 'HTTP ' + r.status}`;
          return `${(r.url || '').replace(/^https?:\/\/[^/]+/, '')} → ${r.failed ? 'FAIL:' + r.failed : 'HTTP ' + r.status}`;
        }).join(' | ')
      : '(no imgreg log)';
    const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_image_unconfirmed', { diagnostics: { url: page.url(), reason: uploaded.reason, imgreg: uploaded.imgreg || [] } });
    if (uploaded.reason === 'sb_upload_comm_failed') {
      // ★doUpload 無応答(サーバがPOSTをホールド)= Akamai の一時的bot対策ホールドの可能性が高い。
      //   画像・パラメータは正常でも、そのIP/セッションの信頼スコアが低い瞬間だと握られる(間欠的)。
      //   「恒久的な拒否(manual)」ではなく「一時的失敗(retryable)」として返し、
      //   Admin の指数バックオフ(2→4→8分…)で調子の良いセッション窓口を引くまで自動再試行させる。
      return fail(`SalonBoard がスタイル画像のアップロードを保留しました(サーバ無応答=一時的bot対策ホールドの可能性)。バックオフ後に自動再試行します。imgreg=[${imgregSummary}] (capture=${cap || '?'})`, 'SB_UPLOAD_HELD', false);
    }
    if (uploaded.reason === 'modal_register_not_found') {
      return fail(`画像アップロードモーダルの「登録する」を特定できませんでした (capture=${cap || '?'})。モーダルDOMの共有が必要です。`, 'UNKNOWN_ERROR', true);
    }
    // imageId_not_set / direct_post_200_no_imageid = doUpload が 302(セッション失効リダイレクト)や
    // userError で imageId を返さなかったケース。多くは「直前の長い held POST でセッションが死んだ」
    // 一時要因(実測: doUpload が 302 を返し imageId 無し)。恒久拒否ではないので retryable にし、
    // バックオフ後に生きたセッションで引き直させる。
    if (uploaded.reason === 'imageId_not_set' || uploaded.reason === 'direct_post_200_no_imageid') {
      return fail(`スタイル画像のアップロードで imageId を取得できませんでした(セッション失効/リダイレクトの可能性)。バックオフ後に自動再試行します。imgreg=[${imgregSummary}] (capture=${cap || '?'})`, 'SB_UPLOAD_HELD', false);
    }
    return fail(`スタイル画像のアップロードを確認できませんでした (${uploaded.reason || ''}) imgreg=[${imgregSummary}] (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // 3) スタイリスト名 (必須): 選択されたスタッフ(author_external_id=T...)で投稿する。
  //    フォトギャラリー(美容室)では必ずスタイリストを選ばせる方針のため、
  //    author_external_id が無い/SalonBoard の選択肢に無い場合は投稿しない(誤った
  //    スタイリストでの投稿を防ぐ)。スタイリストコメントはこの担当者の枠に入る。
  {
    const sel = page.locator('select[name="frmStyleEditStylistCommentDto.stylistId"], select#stylistCheckCd').first();
    if ((await sel.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_no_stylist_select', { diagnostics: { url: page.url() } });
      return fail(`スタイリスト選択欄が見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    const wantT = p.author_external_id ? String(p.author_external_id).trim() : '';
    if (!wantT) {
      return fail('スタイリストが選択されていません。フォトギャラリー投稿時にスタッフ(スタイリスト)を選択してください。', 'STYLIST_REQUIRED', true);
    }
    // 当該 option が存在するか確認してから選択。
    const hasOpt = await sel.evaluate((el, v) => Array.from(el.options).some((o) => o.value === v), wantT).catch(() => false);
    if (!hasOpt) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_stylist_not_in_list', { diagnostics: { url: page.url(), want: wantT } });
      return fail(`選択したスタッフがSalonBoardのスタイリスト一覧に見つかりません (T=${wantT}, capture=${cap || '?'})。スタッフ同期でスタイリストを紐付けてください。`, 'STYLIST_NOT_FOUND', true);
    }
    const picked = await sel.selectOption({ value: wantT }).then(() => true).catch(() => false);
    if (!picked) {
      return fail(`スタイリストの選択に失敗しました (T=${wantT})`, 'UNKNOWN_ERROR', true);
    }
  }

  // 4) コメント / スタイル名 (必須)。
  await page.locator('textarea[name="frmStyleEditStylistCommentDto.stylistComment"], textarea#stylistCommentTxt').first()
    .fill(comment, { timeout: 6_000 }).catch(() => {});
  await page.locator('input[name="frmStyleEditStyleDto.styleName"], input#styleNameTxt').first()
    .fill(styleName, { timeout: 6_000 }).catch(() => {});

  // 5) カテゴリ (payload.style.category_cd: SG01=レディース / SG02=メンズ, 既定 SG01)
  //    → カテゴリに応じた長さ select (ladies/mensHairLengthCd) を選択。
  const categoryCd = String(style.category_cd || '').trim() === 'SG02' ? 'SG02' : 'SG01';
  await page.locator(`input[name="frmStyleEditStyleDto.styleCategoryCd"][value="${categoryCd}"]`).first()
    .check({ timeout: 4_000 }).catch(() => {});
  await page.waitForTimeout(300); // レディース/メンズの長さ欄の表示切替を待つ
  {
    const lenName = categoryCd === 'SG02' ? 'mensHairLengthCd' : 'ladiesHairLengthCd';
    const lenSel = page.locator(`select[name="frmStyleEditStyleDto.${lenName}"], select#${lenName}`).first();
    if ((await lenSel.count().catch(() => 0)) > 0) {
      const wantLen = String(style.length_cd || '').trim();
      let picked = false;
      if (wantLen) {
        picked = await lenSel.selectOption({ value: wantLen }).then(() => true).catch(() => false);
      }
      if (!picked) {
        const cur = await lenSel.inputValue().catch(() => '');
        if (!cur || !cur.trim()) {
          // 既定で「ミディアム」(レディース=HL03 / メンズ=HL12)、無ければ先頭の非空。
          const def = categoryCd === 'SG02' ? 'HL12' : 'HL03';
          const ok = await lenSel.selectOption({ value: def }).then(() => true).catch(() => false);
          if (!ok) {
            await lenSel.evaluate((el) => {
              const opt = Array.from(el.options).find((o) => o.value && o.value.trim());
              if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }).catch(() => {});
          }
        }
      }
    }
  }

  // 6) メニュー内容 (必須): payload.style.menu_cds の指定があればチェックし、
  //    最終的に1つも無ければ先頭(パーマ=MC01)を入れて必須を満たす。
  //    ※ メニュー内容コードは MC01=パーマ / MC02=ストパー・縮毛 / MC03=エクステ / MC04=ブリーチ。
  {
    const wantMenus = (Array.isArray(style.menu_cds) ? style.menu_cds : [])
      .map((c) => String(c).trim()).filter(Boolean);
    for (const cd of wantMenus) {
      await page.locator(`input[name="frmStyleEditStyleDto.menuContentsCdList"][value="${cd}"]`).first()
        .check({ timeout: 3_000 }).catch(() => {});
    }
    const anyChecked = await page.locator('input[name="frmStyleEditStyleDto.menuContentsCdList"]:checked').count().catch(() => 0);
    if (!anyChecked) {
      await page.locator('input[name="frmStyleEditStyleDto.menuContentsCdList"]').first().check({ timeout: 4_000 }).catch(() => {});
    }
    const detail = page.locator('textarea[name="frmStyleEditStyleDto.menuContents"], textarea#menuDetailTxt').first();
    if ((await detail.count().catch(() => 0)) > 0) {
      const wantMenuText = String(style.menu_text || '').trim().slice(0, 50);
      if (wantMenuText) {
        await detail.fill(wantMenuText, { timeout: 4_000 }).catch(() => {});
      } else {
        const cur = await detail.inputValue().catch(() => '');
        if (!cur || !cur.trim()) {
          await detail.fill(styleName.slice(0, 50), { timeout: 4_000 }).catch(() => {});
        }
      }
    }
  }

  // 6.5) ハッシュタグ (任意, payload.tags)。#hashTagTxt に入れて「ハッシュタグを追加」。
  //      失敗してもスタイル登録は継続する (非必須)。
  try {
    const tags = (Array.isArray(p.tags) ? p.tags : [])
      .map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
    const tagInput = page.locator('#hashTagTxt, input.jsc_style_edit-editCommon__tag--input').first();
    const addBtn = page.locator('.jsc_style_edit-editCommon__tag--addBtn').first();
    if (tags.length && (await tagInput.count().catch(() => 0)) > 0 && (await addBtn.count().catch(() => 0)) > 0) {
      for (const t of tags) {
        await tagInput.fill(t.slice(0, 20), { timeout: 3_000 }).catch(() => {});
        await tagInput.dispatchEvent('input').catch(() => {});
        await page.waitForTimeout(150);
        await addBtn.click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout(250);
      }
      // 追加できたタグ数を診断ログ用に確認 (失敗しても続行)。
      const added = await page.locator('ul.jsc_style_edit-editCommon__tagList li').count().catch(() => 0);
      if (added === 0) {
        await captureScrapeDebug(page, 'photo_gallery', 'hair_hashtag_not_added', {
          diagnostics: { url: page.url(), tags },
        }).catch(() => {});
      }
    }
  } catch (_e) { /* noop */ }

  // 6.6) クーポン紐付け (任意, payload.style.coupon_external_id / coupon_name)。
  //      ブログと同じ共有モーダル(jsc_SB_modal)なので selectBlogCoupon を流用する。
  //      見つからない/失敗しても警告キャプチャのみでスタイル登録は継続する。
  if (style.coupon_external_id || style.coupon_name) {
    try {
      const selC = await selectBlogCoupon(page, {
        externalId: style.coupon_external_id ? String(style.coupon_external_id) : null,
        couponName: style.coupon_name ? String(style.coupon_name) : null,
      });
      if (!selC.ok) {
        await captureScrapeDebug(page, 'photo_gallery', 'hair_coupon_not_selected', {
          diagnostics: { url: page.url(), reason: selC.reason, externalId: style.coupon_external_id ?? null },
        }).catch(() => {});
      }
    } catch (e) {
      await captureScrapeDebug(page, 'photo_gallery', 'hair_coupon_select_error', {
        diagnostics: { url: page.url(), error: e?.message ?? String(e), externalId: style.coupon_external_id ?? null },
      }).catch(() => {});
    }
  }

  if (!enablePost) {
    return { status: 'confirm_only' };
  }

  // 7) 登録: <a onclick="doRegister(event)"> をクリック。確認パネル/ダイアログにも対応。
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let clickedRegister = false;
  try {
    const regBtn = page.locator('a[onclick*="doRegister"]').first();
    if ((await regBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_no_register', { diagnostics: { url: page.url() } });
      return fail(`スタイルの「登録」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await regBtn.click({ timeout: 10_000 }).catch(() => {});
    clickedRegister = true;
    await page.waitForTimeout(1200);
    // 確認パネル(#termsPanel)や確認画面の最終確定 (登録する/doRegister/送信) を押す。
    const finalBtn = page.locator(
      '#termsPanel a:visible:has-text("登録"), #termsPanel input[type="submit"]:visible, a[onclick*="doRegister"]:visible, a:visible:has-text("登録する"), input[type="submit"][value*="登録"]:visible'
    ).first();
    if ((await finalBtn.count().catch(() => 0)) > 0 && (await finalBtn.isVisible().catch(() => false))) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1200);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'photo_gallery', 'hair_after', { diagnostics: { clickedRegister, nativeDialogAccepted, url: page.url() } });

  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /登録しました|保存しました|完了|反映しました|受け付け|追加しました/.test(bodyText)
    || /styleList/.test(page.url());
  const looksError = /エラー|失敗|入力してください|必須|選択してください/.test(bodyText) && !looksDone;
  if (looksError) {
    return fail(`スタイル登録でエラー (${(bodyText.match(/.{0,40}(エラー|失敗|入力してください|必須|選択してください).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !clickedRegister && !nativeDialogAccepted) {
    return fail(`スタイル登録の完了を確認できませんでした (capture=${cap2 || '?'})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
  }

  // external_id: FRONT 画像ID(B...) を回収。
  return { status: 'ok', externalId: uploaded.imageId || null };
}

/**
 * 画像を最大1280pxへ「縮小のみ」JPEG再圧縮した Buffer を返す。
 * ★SBページ内 canvas は CSP(blob:読込)で silent 失敗するため、CSPの無い about:blank の
 *   一時ページで実行する(2026-07-04 郡山で確定)。失敗時は null(呼び出し側で原画像)。
 */
async function downscaleJpegViaBlank(page, file, maxDim = 1280, quality = 0.8) {
  try {
    const buf = fs.readFileSync(file);
    const tmp = await page.context().newPage();
    try {
      await tmp.goto('about:blank', { timeout: 10_000 }).catch(() => {});
      const out = await tmp.evaluate(async ({ b64, mime, maxDim, quality }) => {
        const toBytes = (bin) => { const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
        try {
          const srcBlob = new Blob([toBytes(atob(b64))], { type: mime });
          const url = URL.createObjectURL(srcBlob);
          const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
          const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          const scale = Math.min(1, maxDim / Math.max(w || 1, h || 1));
          const cw = Math.max(1, Math.round((w || 1) * scale)), ch = Math.max(1, Math.round((h || 1) * scale));
          const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          const outBlob = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', quality));
          if (!outBlob || !outBlob.size) return null;
          const bytes = new Uint8Array(await outBlob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { b64: btoa(bin), size: bytes.length, w: cw, h: ch };
        } catch (_e) { return null; }
      }, { b64: buf.toString('base64'), mime: 'image/jpeg', maxDim, quality });
      if (out && out.b64) {
        return { buf: Buffer.from(out.b64, 'base64'), mime: 'image/jpeg', name: path.basename(file).replace(/\.[^.]+$/, '') + '.jpg', w: out.w, h: out.h, srcBytes: buf.length };
      }
    } finally { await tmp.close().catch(() => {}); }
  } catch (_e) { /* fallthrough */ }
  return null;
}

/**
 * styleEdit の FRONT 枠に画像を1枚アップロードする。
 * 未設定の FRONT 画像(img#FRONT_IMG_ID_IMG.img_new_no_photo)をクリック→
 * CN_CMN_imageUploaderModal で画像をアップロード。
 * 完了は FRONT_IMG_ID hidden / #FRONT_IMG_ID_ID に画像ID(B...)が入るかで判定する。
 * 戻り値: { ok, imageId?, reason? }
 */
// ★_abck スコアを上げる「人間らしいマウス徘徊」(2026-07-11 画像アップロードERR_ABORTED/通信失敗対策)。
// CNB スタイル画像の doUpload は Akamai に中断(ERR_ABORTED=「通信に失敗しました」)されやすい。
// トリガー操作前に呼んでセンサースコアを上げ、アップロードPOSTが弾かれる確率を下げる。
// best-effort・例外を投げない。
async function humanizeMouseWander(page) {
  const jit = (a, b) => a + Math.floor(Math.random() * (b - a));
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    const moves = jit(3, 6);
    for (let i = 0; i < moves; i++) {
      await page.mouse.move(jit(80, vp.width - 80), jit(120, vp.height - 120), { steps: jit(8, 22) });
      await page.waitForTimeout(jit(90, 380));
      if (i === 1) { await page.mouse.wheel(0, jit(120, 340)).catch(() => {}); await page.waitForTimeout(jit(180, 520)); }
      if (i === 3) { await page.mouse.wheel(0, jit(-240, -80)).catch(() => {}); await page.waitForTimeout(jit(140, 460)); }
    }
  } catch (_e) { /* best-effort */ }
}

async function uploadHairStyleFrontImage(page, file) {
  const idHidden = page.locator('input#FRONT_IMG_ID, input[name="FRONT_IMG_ID"]').first();
  const before = await idHidden.inputValue().catch(() => '');
  // ★(A) 2026-07-11: 直接POST(Playwright request=ブラウザTLS指紋/Akamaiセンサーを持たない)を
  //   先に撃つと ERR_ABORTED され、同一セッションが challenge 状態に落ちて、後続の「信頼された
  //   ブラウザXHR」まで「通信に失敗しました」で中断される疑いが濃厚(郡山 実測: 直接POST abort →
  //   ブラウザXHRも comm error)。→ 既定では直接POSTを主経路にせず、**ブラウザXHRを主経路**にする
  //   (waitImgeFile補償 + trusted setInputFiles + doUpload timeoutパッチ + 人間化 は実装済)。
  //   直接POSTは comm error 時の最終フォールバックとしてのみ残す(下方 hasCommError ブロック)。
  //   env SALONBOARD_DIRECT_POST=1 で従来どおり直接POSTを主経路に戻せる(切り分け用)。
  const PREFER_DIRECT_POST_PRIMARY = /^(1|true|yes)$/i.test(process.env.SALONBOARD_DIRECT_POST ?? '');

  // /imgreg/ (モーダル表示 & doUpload) のリクエスト/レスポンスを記録して、
  // 失敗時に「なぜ通信に失敗したか」を実データで確認できるようにする。
  const imgregLog = [];
  const _t0 = Date.now();
  // XHRホールド時の直接POSTフォールバック用に、送信バイト(縮小後)を関数スコープで保持。
  const _sendMeta = { b64: null, mime: null, name: null };
  const onResp = async (resp) => {
    try {
      const url = resp.url();
      if (!/\/imgreg\//i.test(url)) return;
      let bodyHead = '';
      try { bodyHead = (await resp.text()).slice(0, 600); } catch (_e) { bodyHead = '(body unread)'; }
      imgregLog.push({ url, status: resp.status(), bodyHead, tMs: Date.now() - _t0 });
    } catch (_e) { /* noop */ }
  };
  const onReqFail = (req) => {
    try { if (/\/imgreg\//i.test(req.url())) imgregLog.push({ url: req.url(), failed: req.failure()?.errorText || 'request failed', tMs: Date.now() - _t0 }); } catch (_e) {}
  };
  // ★決定打診断: doUpload の POST 開始時に「実際に送られる body のバイト数」を記録する。
  //   postBytes が multipart 相応(縮小後 ~100KB+境界)なら本当の通信ホールド、
  //   ~1KB 程度なら formFile=空 (waitImgeFile 未セット) が真因と確定できる。
  const onReq = (req) => {
    try {
      if (!/doUpload/i.test(req.url())) return;
      const b = req.postDataBuffer && req.postDataBuffer();
      imgregLog.push({ reqStart: req.url().replace(/^https?:\/\/[^/]+/, ''), postBytes: b ? b.length : null, tMs: Date.now() - _t0 });
    } catch (_e) { /* noop */ }
  };
  page.on('response', onResp);
  page.on('requestfailed', onReqFail);
  page.on('request', onReq);

  let chooserDone = false;
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 4_000 }).then(async (chooser) => {
    await chooser.setFiles(file).catch(() => {});
    chooserDone = true;
  }).catch(() => { /* モーダル方式 */ });

  // FRONT 画像エリアをクリックしてアップロードUIを開く。
  const trigger = page.locator('img#FRONT_IMG_ID_IMG, #FRONT_IMG_ID_IMG').first();
  if ((await trigger.count().catch(() => 0)) === 0) {
    return { ok: false, reason: 'no_front_image_area' };
  }
  // ★エステで実証済みの方式に統一: jQuery 委譲ハンドラ(img_upload_modal_view)で
  //   モーダルが開くため、普通の click だけだとハンドラが走らずモーダルが開かない。
  //   FRONT 画像へ本物の MouseEvent(mousedown/mouseup/click)を dispatch して確実に発火させる。
  // ★アップロードPOST(doUpload)前に人間化して _abck スコアを上げる(ERR_ABORTED/通信失敗対策)。
  await humanizeMouseWander(page);
  await trigger.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
  // ★ERR_ABORTED 根治: モーダルは JS委譲ハンドラ(img_upload_modal_view)が AJAX GET で開く。
  //   従来は evaluate の MouseEvent dispatch と playwright click を「両方」撃っていたため
  //   モーダル用 GET が2回走り(token A / token B の2応答を実測)、後着の応答が upload 中に
  //   モーダルDOMを差し替えて in-flight の doUpload XHR を net::ERR_ABORTED で中断していた。
  //   → まず dispatch を1回だけ撃ってモーダルが開くのを待つ。開かなければ playwright click を
  //     フォールバックで1回だけ撃つ(=モーダルGETは常に1回)。
  await page.evaluate(() => {
    const el = document.querySelector('img#FRONT_IMG_ID_IMG, #FRONT_IMG_ID_IMG');
    if (el) ['mousedown', 'mouseup', 'click'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }).catch(() => {});
  const modalOpened = await page.waitForFunction(() => {
    return !!document.querySelector('#imgUploadForm, #imageUploaderModalBody #imgUploadForm, input.jscImageUploaderModalInput, .jscImageUploaderModalDropArea');
  }, null, { timeout: 3_500 }).then(() => true).catch(() => false);
  if (!modalOpened && !chooserDone) {
    await trigger.click({ timeout: 5_000, force: true }).catch(() => {});
    await Promise.race([chooserPromise, page.waitForTimeout(2_000)]);
  } else {
    await Promise.race([chooserPromise, page.waitForTimeout(400)]);
  }

  // ============================================================
  // 画像アップロードの送信方式:
  //  (A) ブラウザXHR (本来の file_upload(): 「登録する」クリックでページが doUpload) — 既定。
  //      Akamai はブラウザコンテキストの通信を信頼するので、ステルス実Chrome下では
  //      これが一番通る。以前の ERR_ABORTED は当方の二重送信/モーダル閉じが原因で、
  //      Akamai ではなかった。
  //  (B) worker 直接POST (page.context().request.post) — env SALONBOARD_DIRECT_POST=1 のときのみ。
  //      Playwright の request はブラウザのTLS指紋/Akamaiセンサーを持たないため、
  //      Akamai に弾かれて HTTP undefined/タイムアウト(direct_post_blocked)になりやすい。
  //      切り分け用に残すだけ。既定では使わない。
  // ============================================================
  // ★2026-07-04 方針転換: 美容室(CNB)の doUpload は「登録する」クリックのブラウザXHRだと
  //   window.waitImgeFile が空のまま送られてサーバが終わらない multipart を待ちハングする
  //   (実測 102KB でも 180s 無応答→abort。銀座=エステCNKはXHRで通る)。StylePost 等の
  //   外部ツールと同様、**worker から doUpload へ直接POST(multipartを自前で確定構築)**を
  //   主経路にする。imgUpload GET は 200 で通っている=同一Cookieの直接POSTは通る見込み。
  //   直接POSTが「ネットワークで撃てない(all_retries_failed)」ときだけブラウザXHRへ退避。
  let directPostBlocked = false;
  if (!chooserDone && PREFER_DIRECT_POST_PRIMARY) {
    // モーダルHTML(#imgUploadForm)が読み込まれるのを待つ (AJAXで遅れて入るため十分待つ)。
    await page.waitForFunction(() => {
      const f = document.querySelector('#imgUploadForm');
      const t = f && f.querySelector('input[name="targetActionId"]');
      return !!(t && (t.value || '').trim());
    }, null, { timeout: 15_000 }).catch(() => {});
    // 必要パラメータを #imgUploadForm から取得 + doUpload の絶対URLを組み立てる。
    // ★注意: '#form input:hidden[name=..]' は jQuery専用セレクタで querySelector では
    //   SyntaxError になり evaluate 全体が reject→params=null になっていた(v0.2.123)。
    //   有効なCSS('input[name=..]')で取得する。
    const params = await page.evaluate(() => {
      const g = (name) => {
        const f = document.querySelector('#imgUploadForm');
        if (!f) return '';
        const el = f.querySelector(`input[name="${name}"]`);
        return el ? (el.value || '') : '';
      };
      // CONTEXT_URL_STR / URL_STR はグローバルに入っている(img_upload_modal_view が設定)。
      const ctx = (typeof window !== 'undefined' && window.CONTEXT_URL_STR) || '/CNB';
      const ustr = (typeof window !== 'undefined' && window.URL_STR) || 'imgUpload/';
      const wFlg = g('wFlg');
      const url = ctx + '/imgreg/' + ustr + 'doUpload' + (wFlg === 'true' ? '?wFlg=true' : '');
      return {
        url,
        setImgId: g('setImgId'),
        dataKey: g('dataKey'),
        targetActionId: g('targetActionId'),
        token: g('org.apache.struts.taglib.html.TOKEN'),
        storeId: g('STORE_ID'),
        modified: g('modified'),
        pubManageId: g('pubManageId'),
        hasForm: !!document.querySelector('#imgUploadForm'),
        ctxStr: (typeof window !== 'undefined' && window.CONTEXT_URL_STR) || null,
        urlStr: (typeof window !== 'undefined' && window.URL_STR) || null,
      };
    }).catch(() => null);

    // 診断: 直接POSTのパラメータが取れたか必ず記録する。
    imgregLog.push({ direct_post_params: params ? { hasForm: params.hasForm, targetActionId: params.targetActionId ? 'set' : 'EMPTY', token: params.token ? 'set' : 'EMPTY', setImgId: params.setImgId ? 'set' : 'EMPTY', ctxStr: params.ctxStr, urlStr: params.urlStr, url: params.url } : 'params=null' });

    if (params && params.hasForm && params.targetActionId) {
      try {
        // ★縮小(約100KB)して送る。原寸2.2MBだと遅い回線でタイムアウトしやすい。
        const small = await downscaleJpegViaBlank(page, file).catch(() => null);
        const buf = small ? small.buf : fs.readFileSync(file);
        const name = small ? small.name : path.basename(file);
        const mime = small ? small.mime : ((name.split('.').pop() || 'jpg').toLowerCase() === 'png' ? 'image/png' : 'image/jpeg');
        imgregLog.push({ direct_post_primary: true, sendBytes: buf.length, downscaled: !!small, w: small && small.w, h: small && small.h, srcBytes: small && small.srcBytes });
        const absUrl = new URL(params.url, page.url()).toString();
        const pageUrl = page.url();
        // ブラウザの $.ajax に近いヘッダ(referer/origin/x-requested-with)を付け、
        // タイムアウト/中断時は短い間隔で最大3回リトライする。
        const buildMultipart = () => ({
          formFile: { name, mimeType: mime, buffer: buf },
          setImgId: params.setImgId,
          dataKey: params.dataKey,
          targetActionId: params.targetActionId,
          'org.apache.struts.taglib.html.TOKEN': params.token,
          STORE_ID: params.storeId,
          modified: params.modified,
          pubManageId: params.pubManageId,
        });
        const reqHeaders = {
          'referer': pageUrl,
          'origin': new URL(pageUrl).origin,
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'text/html, */*; q=0.01',
        };
        let resp = null;
        let lastErr = '';
        // ★2026-07-04 fail-fast化: 直接POST(Node request)はブラウザと異なるTLS指紋のため
        //   Akamai が「一時ホールド(無応答)」しやすい。ホールドされたら長く待つほどセッション/IPの
        //   フラグを深め、後続のブラウザXHRまで巻き込む。よって「速い1回のプローブ」に留める:
        //   通れば即完了(良好セッションなら数秒)、ホールドなら20秒で見切ってブラウザXHRへ退避。
        //   旧: 3回×60s=最大180秒の無駄打ち → 新: 1回×20s。
        const DIRECT_POST_PROBE_TIMEOUT_MS = 20_000;
        for (let attempt = 1; attempt <= 1; attempt++) {
          const _ts = Date.now();
          try {
            resp = await page.context().request.post(absUrl, {
              timeout: DIRECT_POST_PROBE_TIMEOUT_MS,
              headers: reqHeaders,
              multipart: buildMultipart(),
            });
            imgregLog.push({ direct_post_ok: attempt, status: resp.status(), tookMs: Date.now() - _ts });
            break; // 応答が返れば(2xx/4xx/5xx問わず)ループ終了
          } catch (e) {
            lastErr = e?.message?.split('\n')[0] ?? String(e);
            imgregLog.push({ direct_post_retry: attempt, error: lastErr, tookMs: Date.now() - _ts });
          }
        }
        if (!resp) {
          // 直接POSTがホールド/中断された → 即ブラウザXHRへ退避(粘らない)。
          imgregLog.push({ direct_post: 'probe_failed_fast', lastErr });
          directPostBlocked = true;
        } else {
        const html = await resp.text().catch(() => '');
        // レスポンスHTMLから画像ID等を取り出して親フォーム(FRONT_IMG_ID)へ反映する。
        const applied = await page.evaluate((resHtml) => {
          try {
            const tmp = document.createElement('div');
            tmp.innerHTML = resHtml;
            const get = (id) => { const e = tmp.querySelector('#' + id); return e ? (e.value !== undefined ? e.value : e.textContent) : ''; };
            // 取れたフィールドを全部返す(診断用)。
            const fields = {
              userErrorFlg: get('userErrorFlg'), imageId: get('imageId'), elementName: get('elementName'),
              meetStandardFlg: get('meetStandardFlg'), imageFilePath: get('imageFilePath'),
              lengthSizeOrg: get('lengthSizeOrg'), sideSizeOrg: get('sideSizeOrg'), resolutionOrg: get('resolutionOrg'),
            };
            const imageId = fields.imageId;
            const elementName = fields.elementName || 'FRONT_IMG_ID';
            if (typeof window.setUploadImage === 'function') {
              try {
                if (window.ACTION_FORM_NAME === 'styleEditForm') {
                  window.setUploadImage(imageId, elementName, fields.meetStandardFlg, fields.lengthSizeOrg, fields.sideSizeOrg, fields.resolutionOrg, fields.imageFilePath);
                } else {
                  window.setUploadImage(imageId, elementName, fields.imageFilePath);
                }
              } catch (_e) { /* 直書きにフォールバック */ }
            }
            // ★保険(本命): imageId があれば FRONT_IMG_ID hidden / span / プレビュー img を直接セット。
            //   setUploadImage の有無に依存せず確実に反映する。
            if (imageId) {
              const h = document.getElementById('FRONT_IMG_ID'); if (h) h.value = imageId;
              const span = document.getElementById('FRONT_IMG_ID_ID'); if (span) span.textContent = imageId;
              if (fields.imageFilePath) { const img = document.getElementById('FRONT_IMG_ID_IMG'); if (img) img.src = fields.imageFilePath; }
            }
            if (typeof window.modalClose === 'function') { try { window.modalClose(); } catch (_e) {} }
            try { const b = document.getElementById('imageUploaderModalBody'); if (b) b.innerHTML = ''; } catch (_e) {}
            return { ok: !!imageId, imageId, fields };
          } catch (e) { return { ok: false, error: String(e) }; }
        }, html).catch(() => ({ ok: false }));

        // 直接POSTが HTTP 200 を返している＝サーバ側のアップロードは成功している。
        // applied で imageId を反映できたら、それで確定(ブラウザXHRは絶対に走らせない)。
        if (resp.status() === 200 && applied && applied.imageId) {
          page.off('response', onResp); page.off('requestfailed', onReqFail);
          // hidden 反映を確認(直書き済みなので即 true のはず)。
          await page.waitForFunction((prev) => {
            const h = document.getElementById('FRONT_IMG_ID');
            return !!(h && h.value && h.value !== prev);
          }, before, { timeout: 4_000 }).catch(() => {});
          let imageId = (await idHidden.inputValue().catch(() => '')) || applied.imageId || '';
          return { ok: true, imageId: (imageId || '').trim() || null, via: 'direct_post' };
        }
        // HTTP 200 だが imageId が取れない → レスポンス構造を診断ログに出す。
        imgregLog.push({ via: 'direct_post', status: resp.status(), applied: applied?.fields || applied, bodyHead: (html || '').replace(/\s+/g, ' ').slice(0, 400) });
        if (resp.status() === 200) {
          // 200 なのに反映できない → 二重送信せずここで失敗を返す(userError等)。
          page.off('response', onResp); page.off('requestfailed', onReqFail);
          return { ok: false, reason: 'direct_post_200_no_imageid', imgreg: imgregLog };
        }
        // 非200(4xx/5xx) → ブラウザXHRへ退避。
        directPostBlocked = true;
        } // end else (resp あり)
      } catch (e) {
        imgregLog.push({ url: params && params.url, failed: `direct_post_error: ${e?.message ?? e}` });
        directPostBlocked = true;
      }
    } else {
      // フォーム params が取れない → ブラウザXHRへ。
      directPostBlocked = true;
    }
    // 直接POSTが撃てなかった時のみ、下のブラウザXHR方式にフォールバックする。
    // (directPostBlocked=false のまま imageId 取得済みは上で return 済み)
  }
  if (chooserDone) directPostBlocked = false;

  // 実DOM (CN_CMN_imageUploaderModal, #imageUploaderModalBody 内):
  //   ドロップ領域: .jscImageUploaderModalDropArea (ここに drop / クリックで file 選択)
  //   サムネ:       img.jscImageUploaderModalThumbnail (src がセットされたらプレビュー完了)
  //   登録ボタン:   input[type="button"].jscImageUploaderModalSubmitButton (value="登録する")
  //                 ← <a> でも submit でもなく **input[type=button]**。これが押せておらず失敗していた。
  //   閉じる:       a.jscImageUploaderModalCloseButton
  //   エラー表示:   #uploadError (通信失敗時にメッセージ)
  if (!chooserDone) {
    // ★CN_CMN_imageUploaderModal.js の実挙動 (実JSを解析して確定):
    //   - ファイル input は **input.jscImageUploaderModalInput** (.jscImageUploaderModalDropArea 内)。
    //     その 'change' で prepareFileInfo() が走り、グローバル waitImgeFile に File を保持する。
    //   - 「登録する」(jscImageUploaderModalSubmitButton) クリックで file_upload():
    //     FormData に append('formFile', waitImgeFile) して /imgreg/.../doUpload へ POST (timeout 35s)。
    //   → つまり **正しい input(.jscImageUploaderModalInput)に setInputFiles して change を
    //      発火させれば waitImgeFile に File が入り、手動と同じく一瞬でアップロードされる**。
    //      以前は generic な input[type=file] に入れて change が prepareFileInfo を呼ばず、
    //      waitImgeFile が空のまま formFile=空で送られ、サーバが35sでタイムアウト
    //      →「通信に失敗しました」になっていた。
    // モーダルHTMLはクリック時にAJAX(/imgreg/imgUpload/)で読み込まれ、その後 change
    // ハンドラ(prepareFileInfo→addWaitImgeFile)が attach される。input が現れるまで待つ。
    await page.locator('input.jscImageUploaderModalInput, #imageUploaderModalBody input[type="file"]').first()
      .waitFor({ state: 'attached', timeout: 12_000 }).catch(() => {});
    const modalInput = page.locator('input.jscImageUploaderModalInput, #imageUploaderModalBody input[type="file"], .jscImageUploaderModalDropArea input[type="file"]').first();
    if ((await modalInput.count().catch(() => 0)) === 0) {
      return { ok: false, reason: 'no_file_input' };
    }
    // ★ERR_ABORTED 対策: Playwright の setInputFiles はディスク上の一時ファイル
    //   ハンドルに紐づく File を作る。jQuery が FormData にこの File を append して
    //   POST すると、実Chromeでも doUpload が net::ERR_ABORTED (35sタイムアウト)で
    //   止まることがある(ハンドル/ストリーミングの相性)。
    //   → 画像バイトを **base64 でページに渡し、メモリ上の Blob/File** を作って
    //     input.files と window.waitImgeFile にセットし、change を発火する。
    //     こうすると multipart 本体がメモリから確実に送られ、アップロードが通る。
    let usedInMemory = false;
    let sentBytes = null;
    try {
      const buf = fs.readFileSync(file);
      const name = path.basename(file);
      const ext = (name.split('.').pop() || 'jpg').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      // (直接POSTフォールバックでも使うため関数スコープへ)
      _sendMeta.b64 = buf.toString('base64'); _sendMeta.mime = mime; _sendMeta.name = name;

      // ★縮小は SB ページ内ではなく **CSP の無い about:blank 一時ページ** で行う。
      //   SB ページ内 canvas は CSP(blob:/data: 制限)で Image 読込が silently 失敗し、
      //   原寸(2.2MB)のまま送って doUpload が時間切れ ERR_ABORTED になっていた
      //   (2026-07-04 郡山 imgreg 診断 srcBytes=2229884 で確定)。
      let sendB64 = buf.toString('base64');
      let sendMime = mime;
      let sendName = name;
      try {
        const tmp = await page.context().newPage();
        try {
          await tmp.goto('about:blank', { timeout: 10_000 }).catch(() => {});
          const out = await tmp.evaluate(async ({ b64, mime }) => {
            const toBytes = (bin) => { const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
            try {
              const srcBlob = new Blob([toBytes(atob(b64))], { type: mime });
              const url = URL.createObjectURL(srcBlob);
              const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
              const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
              const scale = Math.min(1, 1280 / Math.max(w || 1, h || 1));
              const cw = Math.max(1, Math.round((w || 1) * scale)), ch = Math.max(1, Math.round((h || 1) * scale));
              const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
              canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
              URL.revokeObjectURL(url);
              const outBlob = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.8));
              if (!outBlob || !outBlob.size) return null;
              const ab = await outBlob.arrayBuffer();
              const bytes = new Uint8Array(ab);
              let bin = '';
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              return { b64: btoa(bin), size: bytes.length, w: cw, h: ch };
            } catch (_e) { return null; }
          }, { b64: sendB64, mime });
          if (out && out.b64) {
            sendB64 = out.b64;
            sendMime = 'image/jpeg';
            sendName = name.replace(/\.[^.]+$/, '') + '.jpg';
            sentBytes = out.size;
            imgregLog.push({ downscaled: true, outBytes: out.size, w: out.w, h: out.h, srcBytes: buf.length });
          } else {
            imgregLog.push({ downscaled: false, srcBytes: buf.length });
          }
        } finally {
          await tmp.close().catch(() => {});
        }
      } catch (_e) { imgregLog.push({ downscaled: false, err: String(_e).slice(0, 60), srcBytes: buf.length }); }

      // ★縮小済みJPEGを一時ファイルに書き、Playwright ネイティブの setInputFiles で投入する。
      //   JS注入(File+DataTransfer+dispatchEvent)は isTrusted=false のため Akamai センサーの
      //   評価が下がり、doUpload XHR が無期限ホールドされていた疑い(102KBでも180秒無応答)。
      //   setInputFiles は CDP 経由の trusted な入力で、手動のファイル選択と同条件になる。
      const smallPath = `${file}.small.jpg`;
      try {
        _sendMeta.b64 = sendB64; _sendMeta.mime = sendMime; _sendMeta.name = sendName;
        fs.writeFileSync(smallPath, Buffer.from(sendB64, 'base64'));
        await modalInput.setInputFiles(smallPath, { timeout: 8_000 });
        usedInMemory = true; // (= 縮小ファイル投入成功。変数名は互換のため維持)
      } catch (_e) { usedInMemory = false; }
      // 後始末は best-effort (数百KBの tmp。失敗しても害なし)。
      setTimeout(() => { try { fs.unlinkSync(smallPath); } catch (_e2) { /* noop */ } }, 300_000);
    } catch (_e) { /* fallthrough */ }

    if (!usedInMemory) {
      // 縮小/書出しに失敗したら原画像で従来の setInputFiles。
      await modalInput.setInputFiles(file, { timeout: 8_000 }).catch(() => {});
    }
    imgregLog.push({ inMemory: usedInMemory, sentBytes });
  }

  const isDone = () => page.evaluate((prev) => {
    const h = document.getElementById('FRONT_IMG_ID');
    const hv = h ? (h.value || '') : '';
    const s = document.getElementById('FRONT_IMG_ID_ID');
    const sv = s ? (s.textContent || '').trim() : '';
    return (!!hv && hv !== prev) || /^B\d{4,}$/.test(sv);
  }, before).catch(() => false);
  const hasCommError = () => page.evaluate(() => {
    const ue = document.getElementById('uploadError');
    const ueShown = ue && !ue.classList.contains('dn') && (ue.textContent || '').trim();
    const t = (document.body?.innerText || '');
    return !!ueShown || /通信に失敗しました|アップロードに失敗|形式が正しくありません/.test(t);
  }).catch(() => false);

  // プレビュー(サムネ img の src がセット = waitImgeFile も保持済み)を最大12秒待つ。
  // (waitImgeFile は prepareFileInfo 内で addWaitImgeFile されている)
  await page.waitForFunction(() => {
    const t = document.querySelector('#imageUploaderModalBody img.jscImageUploaderModalThumbnail, img.jscImageUploaderModalThumbnail');
    return !!(t && (t.getAttribute('src') || '').trim());
  }, null, { timeout: 12_000 }).catch(() => {});

  // ★ERR_ABORTED の真因(2026-07-04 郡山で imgreg ログにより確定):
  //   SB の file_upload() は $.ajax(timeout:35000) で doUpload へ POST し、35秒を超えると
  //   jQuery が XHR を abort する(= ブラウザ側では net::ERR_ABORTED、画面は「通信に失敗しました」)。
  //   プロキシ(ISP)経由の遅いアップロードや Akamai の一時ホールドで 35 秒を超えるため、
  //   doUpload の $.ajax だけ timeout を 180 秒へ引き上げるパッチを当ててからクリックする。
  await page.evaluate(() => {
    try {
      const jq = window.jQuery || window.$;
      if (jq && jq.ajax && !jq.__kdDoUploadPatched) {
        const orig = jq.ajax;
        jq.ajax = function (a, b) {
          try {
            const opts = (typeof a === 'object' && a) ? a : (b || {});
            if (opts && typeof opts.url === 'string' && /doUpload/.test(opts.url)) opts.timeout = 45000;
          } catch (_e) { /* noop */ }
          return orig.apply(this, arguments);
        };
        jq.__kdDoUploadPatched = true;
      }
    } catch (_e) { /* noop */ }
  }).catch(() => {});

  // ★v0.2.116 確実策の復元 + 決定打診断:
  //   SB の file_upload() は FormData.append('formFile', window.waitImgeFile) で送る。
  //   waitImgeFile は input の change → prepareFileInfo で入るが、uploadMode フラグ等の
  //   条件で入らないことがある。**空のまま送ると formFile=空 POST → サーバ無応答 →
  //   クライアント timeout abort(ERR_ABORTED)** — 今回の症状と同一の既知パターン。
  //   クリック前に waitImgeFile を検証し、空なら input.files[0] から補償する。
  {
    const pre = await page.evaluate(() => {
      const inp = document.querySelector('input.jscImageUploaderModalInput, #imageUploaderModalBody input[type="file"], .jscImageUploaderModalDropArea input[type="file"]');
      const th = document.querySelector('img.jscImageUploaderModalThumbnail');
      const w = window.waitImgeFile;
      return {
        inputFiles: inp && inp.files ? inp.files.length : -1,
        thumbSet: !!(th && (th.getAttribute('src') || '').trim()),
        waitType: typeof w,
        waitSize: (w && typeof w === 'object' && typeof w.size === 'number') ? w.size : null,
        uploadMode: (typeof window.uploadMode !== 'undefined') ? String(window.uploadMode) : 'undef',
        hasUploadFn: typeof window.file_upload === 'function',
      };
    }).catch(() => null);
    imgregLog.push({ pre });
    if (!pre || !pre.waitSize) {
      const fixed = await page.evaluate(() => {
        try {
          const inp = document.querySelector('input.jscImageUploaderModalInput, #imageUploaderModalBody input[type="file"], .jscImageUploaderModalDropArea input[type="file"]');
          const f = inp && inp.files && inp.files[0];
          if (!f) return { ok: false, reason: 'no_input_file' };
          if (typeof window.addWaitImgeFile === 'function') window.addWaitImgeFile(f);
          window.waitImgeFile = window.waitImgeFile && typeof window.waitImgeFile === 'object' && window.waitImgeFile.size ? window.waitImgeFile : f;
          const w = window.waitImgeFile;
          return { ok: true, size: (w && w.size) || null };
        } catch (e) { return { ok: false, reason: String(e).slice(0, 60) }; }
      }).catch(() => ({ ok: false, reason: 'eval_failed' }));
      imgregLog.push({ waitImgeFileCompensated: fixed });
    }
  }

  // ★人間化 (Phase3-lite と同等): Akamai は _abck センサーでマウス軌跡等を評価し、
  //   兆候が無いセッションの XHR POST をホールドする。予約登録では submit 前の人間化で
  //   書込500が解消済み。画像アップロードの doUpload も同じ対策を適用する。
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    const jit = (lo, hi) => lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    await page.mouse.move(jit(120, vp.width - 120), jit(120, vp.height - 120), { steps: jit(6, 14) });
    await page.waitForTimeout(jit(300, 800));
    await page.mouse.move(jit(120, vp.width - 120), jit(120, vp.height - 120), { steps: jit(6, 14) });
    await page.waitForTimeout(jit(300, 700));
    await page.mouse.wheel(0, jit(-80, 80)).catch(() => {});
    await page.waitForTimeout(jit(400, 900));
  } catch (_e) { /* 人間化は best-effort */ }

  // 「登録する」(jscImageUploaderModalSubmitButton) を **1回だけ** クリック。
  // 手動と同じ操作。直接 file_upload() 呼びや連打はしない(doUpload が ERR_ABORTED に
  // なる原因になりうる)。
  const submitBtn = page.locator('input.jscImageUploaderModalSubmitButton, #imageUploaderModalBody input[type="button"][value="登録する"], .imageUploaderModalSubmitButton').first();
  if ((await submitBtn.count().catch(() => 0)) > 0) {
    await submitBtn.click({ timeout: 8_000 }).catch(() => {});
  } else {
    await captureScrapeDebug(page, 'photo_gallery', 'hair_image_modal_no_register', { diagnostics: { url: page.url() } }).catch(() => {});
    return { ok: false, reason: 'modal_register_not_found' };
  }

  // 押下後、完了(FRONT_IMG_ID 反映) か エラー(通信に失敗しました) のどちらかを待つ。
  // ★fail-fast: doUpload の $.ajax timeout を 45 秒にしたため、待ち上限も 55 秒に短縮。
  //   45秒以内に応答が無い=Akamai の一時ホールド。長く粘らず切って retryable で再試行に回す。
  await page.waitForFunction((prev) => {
    const h = document.getElementById('FRONT_IMG_ID');
    const hv = h ? (h.value || '') : '';
    const s = document.getElementById('FRONT_IMG_ID_ID');
    const sv = s ? (s.textContent || '').trim() : '';
    const done = (!!hv && hv !== prev) || /^B\d{4,}$/.test(sv);
    const ue = document.getElementById('uploadError');
    const ueShown = ue && !ue.classList.contains('dn') && (ue.textContent || '').trim();
    const err = !!ueShown || /通信に失敗しました|アップロードに失敗|形式が正しくありません/.test(document.body?.innerText || '');
    return done || err;
  }, before, { timeout: 55_000 }).catch(() => {});

  const detach = () => { try { page.off('response', onResp); page.off('requestfailed', onReqFail); page.off('request', onReq); } catch (_e) {} };

  if (await hasCommError()) {
    // ★最終フォールバック(2026-07-04 郡山): ブラウザXHRの doUpload が Akamai に
    //   無期限ホールドされる(102KB/180秒でも無応答)ケースで、同一Cookie(成熟_abck含む)の
    //   まま Playwright request.post で直接POSTする。銀座(エステ/CNK)ではブラウザXHRが
    //   通るため既定経路はそのまま、失敗時のみ発動。
    try {
      const params = await page.evaluate(() => {
        const f = document.querySelector('#imgUploadForm');
        if (!f) return null;
        const g = (n) => { const el = f.querySelector(`input[name="${n}"]`); return el ? (el.value || '') : ''; };
        const ctx = (typeof window !== 'undefined' && window.CONTEXT_URL_STR) || '/CNB';
        const ustr = (typeof window !== 'undefined' && window.URL_STR) || 'imgUpload/';
        const wFlg = g('wFlg');
        return {
          url: ctx + '/imgreg/' + ustr + 'doUpload' + (wFlg === 'true' ? '?wFlg=true' : ''),
          setImgId: g('setImgId'), dataKey: g('dataKey'), targetActionId: g('targetActionId'),
          token: g('org.apache.struts.taglib.html.TOKEN'), storeId: g('STORE_ID'),
          modified: g('modified'), pubManageId: g('pubManageId'),
        };
      }).catch(() => null);
      if (params && params.targetActionId && _sendMeta.b64) {
        const absUrl = new URL(params.url, page.url()).toString();
        const pageUrl = page.url();
        const resp = await page.context().request.post(absUrl, {
          timeout: 20_000,
          headers: {
            referer: pageUrl,
            origin: new URL(pageUrl).origin,
            'x-requested-with': 'XMLHttpRequest',
            accept: 'text/html, */*; q=0.01',
          },
          multipart: {
            formFile: { name: _sendMeta.name, mimeType: _sendMeta.mime, buffer: Buffer.from(_sendMeta.b64, 'base64') },
            setImgId: params.setImgId, dataKey: params.dataKey, targetActionId: params.targetActionId,
            'org.apache.struts.taglib.html.TOKEN': params.token, STORE_ID: params.storeId,
            modified: params.modified, pubManageId: params.pubManageId,
          },
        });
        const html = await resp.text().catch(() => '');
        imgregLog.push({ directPostFallback: true, status: resp.status(), tMs: Date.now() - _t0, bodyHead: (html || '').replace(/\s+/g, ' ').slice(0, 160) });
        if (resp.status() === 200) {
          const applied = await page.evaluate((resHtml) => {
            try {
              const tmp = document.createElement('div');
              tmp.innerHTML = resHtml;
              const get = (id) => { const e = tmp.querySelector('#' + id); return e ? (e.value !== undefined ? e.value : e.textContent) : ''; };
              if (String(get('userErrorFlg') || '0') !== '0') return { ok: false, userError: true };
              const imageId = get('imageId');
              if (!imageId) return { ok: false };
              // FRONT_IMG_ID hidden / span / プレビュー img を直接反映 (setUploadImage 非依存の保険)。
              const h = document.getElementById('FRONT_IMG_ID'); if (h) h.value = imageId;
              const span = document.getElementById('FRONT_IMG_ID_ID'); if (span) span.textContent = imageId;
              const fp = get('imageFilePath'); if (fp) { const img = document.getElementById('FRONT_IMG_ID_IMG'); if (img) img.src = fp; }
              if (typeof window.modalClose === 'function') { try { window.modalClose(); } catch (_e) {} }
              try { const b = document.getElementById('imageUploaderModalBody'); if (b) b.innerHTML = ''; } catch (_e) {}
              return { ok: true, imageId };
            } catch (_e) { return { ok: false }; }
          }, html).catch(() => ({ ok: false }));
          if (applied && applied.ok && applied.imageId) {
            detach();
            return { ok: true, imageId: applied.imageId, via: 'direct_post_fallback' };
          }
        }
      } else {
        imgregLog.push({ directPostFallback: false, reason: params ? 'no_send_bytes' : 'no_form_params' });
      }
    } catch (e) {
      imgregLog.push({ directPostFallbackError: String(e?.message ?? e).slice(0, 120), tMs: Date.now() - _t0 });
    }
    await captureScrapeDebug(page, 'photo_gallery', 'hair_image_modal_dom', { diagnostics: { url: page.url(), commError: true, imgreg: imgregLog } }).catch(() => {});
    detach();
    return { ok: false, reason: 'sb_upload_comm_failed', imgreg: imgregLog };
  }
  if (!(await isDone())) {
    await captureScrapeDebug(page, 'photo_gallery', 'hair_image_modal_dom', { diagnostics: { url: page.url(), commError: false, imgreg: imgregLog } }).catch(() => {});
    detach();
    return { ok: false, reason: 'imageId_not_set', imgreg: imgregLog };
  }
  detach();
  // 画像ID は hidden 優先、無ければ span から。
  let imageId = (await idHidden.inputValue().catch(() => '')) || '';
  if (!imageId) {
    imageId = (await page.locator('#FRONT_IMG_ID_ID').first().textContent().catch(() => '') || '').trim();
  }
  return { ok: true, imageId: imageId.trim() || null };
}

/**
 * 口コミ(レビュー)一覧を取得する。
 *
 * SalonBoard の口コミ一覧 URL はジャンルで異なる:
 *   - 美容室(hair):   https://salonboard.com/CLP/bt/review/reviewList/
 *   - エステ(esthe):  https://salonboard.com/KLP/review/reviewList/
 * いずれも `table.mod_table03` に 8 列 (ピックアップ/管理番号/投稿日時/来店日/
 * 予約者名/担当/本文/返信状況) で並ぶ。本文は一覧では末尾省略(…)される。
 *
 * 返信状況は `<a class="mod_btn_mihenshin">未返信</a>` / `mod_btn_henshinzumi`(返信済)、
 * 審査状況テキスト(審査OK(掲載中) 等)が同じセルに入る。返信リンク href から reviewId を拾う。
 *
 * ページング: `<p class="page">1/75ページ</p>` と `.next a[href]`。
 * 負荷を抑えるため既定で最大 maxPages ページまで巡回する。
 *
 * @returns { rows, debug }
 */
// 口コミの詳細ページ(返信入力/詳細画面)を開いて、口コミ本文の全文 + 投稿済み返信本文を取得する。
// 一覧では本文が省略される & 返信本文は出ないため、全文/返信が必要な場合のみ呼ぶ。
// 返り値: { body_full, reply_body, reply_from_posted } (取れなかった項目は null)。
async function scrapeReviewDetail(page, reviewId, genre, baseUrl) {
  const base = baseUrl || 'https://salonboard.com/';
  const url =
    genre === 'hair'
      ? new URL(`/CLP/bt/review/reviewReply/${encodeURIComponent(reviewId)}`, base).toString()
      : new URL(`/KLP/review/reviewReply/?reviewId=${encodeURIComponent(reviewId)}`, base).toString();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('table.mod_table01, table.mod_table03, textarea, .mod_box', { timeout: 8_000 }).catch(() => {});
  } catch (_e) {
    return { body_full: null, reply_body: null, reply_from_posted: null };
  }
  return await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // <br>/<p>/<div> を改行に変換してテキスト化
    const htmlToText = (el) => {
      if (!el) return '';
      const html = (el.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      return norm(tmp.textContent || '');
    };

    // 口コミ本文: ラベル「口コミ」「ご投稿内容」等を含む行の値セル、無ければ最長の本文ブロック
    let bodyFull = '';
    let replyBody = '';
    let replyFrom = '';

    const rows = Array.from(document.querySelectorAll('tr'));
    for (const tr of rows) {
      const th = tr.querySelector('th, .mod_th, td.head');
      const label = norm(th?.textContent || '');
      const valCell = th ? tr.querySelector('td') : null;
      if (!label || !valCell) continue;
      if (/口コミ|ご投稿|投稿内容|コメント|本文/.test(label) && !/返信/.test(label) && !bodyFull) {
        bodyFull = htmlToText(valCell);
      } else if (/返信(内容|本文|コメント)?/.test(label) && !/返信状況|返信日/.test(label)) {
        const t = htmlToText(valCell);
        if (t) replyBody = t;
      } else if (/返信者|お名前|担当(者)?名/.test(label) && !replyFrom) {
        replyFrom = norm(valCell.textContent || '');
      }
    }

    // 既存返信の表示エリア (フォーム以外の確定済み返信) のフォールバック
    if (!replyBody) {
      const repEl = document.querySelector('.replyContents, .mod_reply, [class*="reply"][class*="contents" i]');
      if (repEl) replyBody = htmlToText(repEl);
    }
    // textarea に既存返信が入っているケース (返信済みの再編集画面)
    if (!replyBody) {
      const ta = document.querySelector('textarea[name="replyContents"], textarea#replyContents, textarea[name="reply"]');
      if (ta && ta.value) replyBody = norm(ta.value);
    }
    if (!replyFrom) {
      const fromInput = document.querySelector('input#replyFrom, input[name="replyFrom"]');
      if (fromInput && fromInput.value) replyFrom = norm(fromInput.value);
    }

    return {
      body_full: bodyFull || null,
      reply_body: replyBody || null,
      reply_from_posted: replyFrom || null,
    };
  }).catch(() => ({ body_full: null, reply_body: null, reply_from_posted: null }));
}

async function scrapeReviews(page, opts = {}) {
  const genre = opts.genre === 'hair' ? 'hair' : 'esthetic';
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 5;
  // withDetail=true のとき、各口コミの詳細ページを開いて全文+返信本文も取得する(遅い)。
  const withDetail = opts.withDetail === true;
  const detailLimit = Number.isFinite(opts.detailLimit) ? opts.detailLimit : 60;
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const listUrl =
    genre === 'hair'
      ? 'https://salonboard.com/CLP/bt/review/reviewList/'
      : 'https://salonboard.com/KLP/review/reviewList/';

  const all = [];
  let pageInfo = { current: 1, total: 1 };
  let visited = 0;
  let url = listUrl;

  for (let i = 0; i < maxPages; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    await page.waitForSelector('table.mod_table03', { timeout: 8_000 }).catch(() => {});
    visited++;

    const res = await page.evaluate(() => {
      const clean = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      // セル内の <br> を改行/区切りとして扱い、1行目と残りを分けて返す
      const lines = (el) => {
        if (!el) return [];
        return (el.innerHTML || '')
          .split(/<br\s*\/?>/i)
          .map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      };

      const items = [];
      // 管理番号を持つ行 = ピックアップ用 radio (name="pickUpReview") を起点にする
      const radios = document.querySelectorAll('input[name="pickUpReview"]');
      for (const radio of radios) {
        const externalId = (radio.value || '').trim();
        if (!externalId) continue;
        const tr = radio.closest('tr');
        if (!tr) continue;
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length < 8) continue;
        // 列: 0=pickup 1=管理番号 2=投稿日時 3=来店日 4=予約者名(番号) 5=担当 6=本文 7=返信状況
        const postedLines = lines(tds[2]); // ["2026/06/10","18:24"]
        const visitLines = lines(tds[3]); // ["2026/06/10"]
        const customerLines = lines(tds[4]); // ["宮本 結生","（-）"]
        const replyAnchor = tds[7].querySelector('a');
        const replyClass = replyAnchor ? replyAnchor.className : '';
        const replyHref = replyAnchor ? replyAnchor.getAttribute('href') || '' : '';
        const replyLabel = clean(replyAnchor); // 未返信 / 返信済
        const auditText = clean(tds[7]).replace(replyLabel, '').trim(); // 審査OK(掲載中) / -

        items.push({
          external_id: externalId,
          posted_at_label: postedLines.join(' '),
          visit_date_label: visitLines.join(' '),
          customer_name: customerLines[0] || '',
          customer_number: (customerLines[1] || '').replace(/[（）()]/g, '') || null,
          staff_name: clean(tds[5]) || null,
          body_excerpt: clean(tds[6]) || '',
          reply_status: /henshinzumi/.test(replyClass) ? 'replied' : 'unreplied',
          audit_status: auditText && auditText !== '-' ? auditText : null,
          reply_url: replyHref || null,
        });
      }

      // ページング情報
      let current = 1;
      let total = 1;
      const pageEl = document.querySelector('.paging .page');
      if (pageEl) {
        const m = (pageEl.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          current = Number(m[1]);
          total = Number(m[2]);
        }
      }
      const nextA = document.querySelector('.paging .next a[href]');
      const nextHref = nextA ? nextA.getAttribute('href') : null;

      return { items, current, total, nextHref, url: location.href, title: document.title };
    });

    for (const it of res.items) all.push(it);
    pageInfo = { current: res.current, total: res.total };

    if (!res.nextHref || res.current >= res.total) break;
    url = new URL(res.nextHref, 'https://salonboard.com').href;
  }

  // 管理番号で重複排除 (ページ巡回中の重複保険)
  const seen = new Set();
  const rows = [];
  for (const it of all) {
    if (seen.has(it.external_id)) continue;
    seen.add(it.external_id);
    rows.push(it);
  }

  // 詳細巡回: 全文 + 返信本文を取得する (withDetail=true 時のみ)。
  //   全口コミの詳細ページを開くので時間がかかる → detailLimit 件まで。
  //   返信済み(replied)を優先して巡回する(返信本文が必要なため)。
  let detailFetched = 0;
  if (withDetail && rows.length > 0) {
    const ordered = [...rows].sort((a, b) => {
      // replied を先に、その中で新しい順(配列は既に新しい順)
      const ar = a.reply_status === 'replied' ? 0 : 1;
      const br = b.reply_status === 'replied' ? 0 : 1;
      return ar - br;
    });
    for (const it of ordered) {
      if (detailFetched >= detailLimit) break;
      const d = await scrapeReviewDetail(page, it.external_id, genre, baseUrl);
      if (d.body_full) it.body_full = d.body_full;
      if (d.reply_body) it.reply_body = d.reply_body;
      if (d.reply_from_posted) it.reply_from_posted = d.reply_from_posted;
      detailFetched++;
    }
  }

  return {
    rows,
    debug: {
      itemsFound: rows.length,
      pagesVisited: visited,
      totalPages: pageInfo.total,
      detailFetched,
      genre,
      url: listUrl,
    },
  };
}

/**
 * 設備 (席/ベッド) を SalonBoard に書き込む。/CNK/set/equipList/ のインラインフォームで
 * external_id (equipmentId) 一致行を更新。無ければ「追加」して新規作成。
 * payload: { external_id?, name, max_rsv_num?, sort_no? }
 * opts.enablePush=false → 確認のみ (登録ボタンを押さない)。
 */
async function pushEquipmentViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const extId = String(p.external_id || p.salonboard_equipment_external_id || p.equipment_id || '').trim();
  const name = String(p.name || p.equipment_name || '').trim();
  const maxRsv = p.max_rsv_num ?? p.maxRsvNum ?? null;
  const sortNo = p.sort_no ?? p.sortNo ?? null;
  if (!extId && !name) return fail('設備の external_id も name もありません', 'UNKNOWN_ERROR', true);

  await page.goto(new URL('/CNK/set/equipList/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  if ((await page.locator('form#equipListForm').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'equipment', 'no_form', { diagnostics: { url: page.url() } });
    return fail(`設備編集フォーム (equipListForm) に到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  const applied = await page.evaluate(({ extId, name, maxRsv, sortNo }) => {
    const setVal = (el, v) => {
      if (!el) return false;
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    let idx = -1;
    const hids = document.querySelectorAll('input[type="hidden"][name^="frmEquipListDtoList"][name$=".equipmentId"]');
    if (extId) {
      for (const h of hids) {
        if (h.value === extId) { const m = h.name.match(/\[(\d+)\]/); if (m) idx = parseInt(m[1], 10); break; }
      }
    }
    let created = false;
    if (idx < 0) {
      if (typeof addRowEquipment === 'function') { try { addRowEquipment(); created = true; } catch (_e) { /* noop */ } }
      const names = document.querySelectorAll('input[name^="frmEquipListDtoList"][name$=".equipmentName"]');
      idx = names.length - 1;
    }
    if (idx < 0) return { ok: false, reason: 'row_not_found' };
    const byField = (field) =>
      document.querySelector(`[name="frmEquipListDtoList[${idx}].${field}"]`) ||
      document.getElementById(`frmEquipListDtoList${idx}.${field}`);
    const r = { idx, created };
    if (name) r.name = setVal(byField('equipmentName'), name);
    if (maxRsv != null) {
      const sel = byField('maxRsvNum');
      if (sel) { sel.value = String(maxRsv); sel.dispatchEvent(new Event('change', { bubbles: true })); r.maxRsv = sel.value === String(maxRsv); }
    }
    if (sortNo != null) r.sortNo = setVal(byField('sortNo'), sortNo);
    return { ok: true, ...r };
  }, { extId, name, maxRsv, sortNo });

  if (!applied || !applied.ok) {
    const cap = await captureScrapeDebug(page, 'equipment', 'no_row', { diagnostics: { applied } });
    return fail(`設備行を特定/作成できませんでした (${applied?.reason || ''}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  // dirty state を確実に立てるため locator.fill で実入力し直す (JS の value 代入だけでは
  // SalonBoard が変更を検知せず submit に含めないことがある)。
  if (name && applied.idx != null && applied.idx >= 0) {
    const nameSel = `[name="frmEquipListDtoList[${applied.idx}].equipmentName"]`;
    await page.fill(nameSel, '', { timeout: 6000 }).catch(() => {});
    await page.fill(nameSel, name, { timeout: 6000 }).catch(() => {});
    await page.locator(nameSel).first().dispatchEvent('change').catch(() => {});
  }

  if (!enablePush) return { status: 'confirm_only', confirmed: applied };

  const beforeUrl = page.url();
  const dialogMsgs = [];
  const onDialog = async (d) => { dialogMsgs.push(String(d.message() || '').slice(0, 120)); try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    const btn = page.locator('a#registBtn').first();
    if ((await btn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'equipment', 'no_regist', { diagnostics: { url: page.url() } });
      return fail(`設備の登録ボタン (#registBtn) が見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      btn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(2500);
    // 送信直後の実ページを捕捉 (確認HTMLページの有無を判定)
    const afterClickUrl = page.url();
    const afterBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 400);
    // 確認HTMLページ (本文に「確認/設定してよろしい/以下の内容」) で最終ボタンが残っていれば押下
    let finalClicked = false;
    const finalBtn = page.locator('a:has-text("設定する"):visible, a:has-text("登録する"):visible, a:has-text("この内容で"):visible, a.accept:visible, input[type="submit"][value*="設定"], input[type="submit"][value*="登録"]').first();
    if (/確認|設定してよろしい|以下の内容|この内容で/.test(afterBody) && (await finalBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      finalClicked = true;
      await page.waitForTimeout(2000);
    }
    const postFinalUrl = page.url();
    const postFinalBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 250);
    const dumpCap = await captureScrapeDebug(page, 'equipment', 'post_submit', { diagnostics: { afterClickUrl, afterBody, finalClicked, postFinalUrl, postFinalBody } });
    // 送信後に一覧へ戻し、対象設備名が新値で保存されているか再確認
    await page.goto(new URL('/CNK/set/equipList/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
    const reRead = await page.evaluate((wantName) => {
      const el = Array.from(document.querySelectorAll('input[name^="frmEquipListDtoList"][name$=".equipmentName"]')).find((x) => (x.value || '') === wantName);
      const all = Array.from(document.querySelectorAll('input[name^="frmEquipListDtoList"][name$=".equipmentName"]')).map((x) => x.value);
      return { persisted: !!el, names: all };
    }, name).catch(() => ({ persisted: false, names: [] }));
    page.off('dialog', onDialog);
    const diag = { dialogMsgs, beforeUrl, afterClickUrl, afterBody, finalClicked, postFinalUrl, postFinalBody, dumpCap, reRead };
    if (name && !reRead.persisted) {
      const cap = await captureScrapeDebug(page, 'equipment', 'not_persisted', { diagnostics: diag });
      return { status: 'failed', reason: `設備名が保存されませんでした (dialog=${JSON.stringify(dialogMsgs)}, names=${JSON.stringify(reRead.names)}, capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true, diag };
    }
    return { status: 'ok', externalId: extId || null, confirmed: { ...applied, diag } };
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * スタッフの掲載/並び順/PickUp を SalonBoard に書き込む。/CNK/draft/staffList のインライン。
 * external_id (staffId) 一致行を更新 → 「変更内容を登録する」。
 * payload: { external_id, is_published?|present_flg?, sort_no?, pickup? }
 * 注: 氏名/職種/キャッチコピー等の詳細編集は staffEdit ページが別途必要 (本実装は一覧の掲載/順序)。
 */
async function pushStaffViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const extId = String(p.external_id || p.salonboard_staff_external_id || p.staff_id || '').trim();
  if (!extId) return fail('スタッフの external_id (staffId) がありません', 'UNKNOWN_ERROR', true);
  const presentFlg = p.present_flg ?? (p.is_published == null ? null : (p.is_published ? 1 : 0));
  // KD の sort_order は未設定時 0。SalonBoard の表示順は 1 以上なので、0 を送ると
  // 「変更内容を登録する」を押しても保存されず、再読込時に current="" となる。
  const sortNoRaw = p.sort_no ?? p.sortNo ?? null;
  const sortNoNum = sortNoRaw == null || sortNoRaw === '' ? null : Number(sortNoRaw);
  const sortNo = Number.isFinite(sortNoNum) && sortNoNum > 0 ? Math.trunc(sortNoNum) : null;
  const pickup = p.pickup ?? p.pickup_flg ?? null;

  const genre = opts.genre === 'hair' || p.genre === 'hair' ? 'hair' : 'esthetic';
  const listPath = genre === 'hair' ? '/CNB/draft/stylistList/' : '/CNK/draft/staffList';
  const dtoPrefix = genre === 'hair' ? 'frmStylistListStylistDtoList' : 'frmStaffListStafferDtoList';
  const idField = genre === 'hair' ? 'stylistId' : 'staffId';
  const sortFormId = genre === 'hair' ? 'stylistSortForm' : 'staffSortForm';

  // グループ店舗では SalonBoard が画面遷移中に店舗文脈を失うことがあるため、
  // 「サロン選択→一覧」の組を最大2回やり直し、実際の一覧フォーム到達で成功判定する。
  const openList = async () => {
    for (let n = 0; n < 2; n += 1) {
      if (opts.salonId) {
        await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        const selected = await ensureSalonSelected(page, {
          salonId: opts.salonId,
          shopName: opts.shopName,
          genre,
          baseUrl,
        }).catch((e) => ({ ok: false, reason: e?.message || String(e) }));
        if (!selected?.ok) {
          if (n === 1) return { ok: false, reason: selected?.reason || 'unknown' };
          continue;
        }
      }
      await page.goto(new URL(listPath, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      const count = await page.locator(`input[name^="${dtoPrefix}"][name$=".${idField}"]`).count().catch(() => 0);
      if (count > 0) return { ok: true, count };
      await page.waitForTimeout(800);
    }
    return { ok: false, reason: 'staff_list_form_missing' };
  };

  const opened = await openList();
  if (!opened.ok && opened.reason !== 'staff_list_form_missing') {
    return fail(`グループ店舗のサロン選択に失敗 (${opened.reason})`, 'SALON_SELECTION_FAILED', false);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  if (!opened.ok) {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 220);
    const cap = await captureScrapeDebug(page, 'staff', 'no_form', { diagnostics: { url: page.url(), genre, listPath, body } });
    return fail(`スタッフ一覧フォームに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  const applied = await page.evaluate(({ extId, presentFlg, sortNo, pickup, dtoPrefix, idField }) => {
    let idx = -1;
    const hids = document.querySelectorAll(`input[type="hidden"][name^="${dtoPrefix}"][name$=".${idField}"]`);
    for (const h of hids) {
      if (h.value === extId) { const m = h.name.match(/\[(\d+)\]/); if (m) idx = parseInt(m[1], 10); break; }
    }
    if (idx < 0) return { ok: false, reason: 'staff_not_found' };
    const byField = (f) => document.querySelector(`[name="${dtoPrefix}[${idx}].${f}"]`);
    const r = { idx };
    if (sortNo != null) { const el = byField('sortNo'); if (el) { el.value = String(sortNo); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); r.sortNo = true; } }
    if (presentFlg != null) { const el = byField('presentFlg'); if (el) { r.presentFlg = true; r.currentPublished = String(el.value) === '1'; } }
    if (pickup != null) { const cb = byField('pickupFlg'); if (cb) { cb.checked = !!pickup; cb.dispatchEvent(new Event('change', { bubbles: true })); r.pickup = true; } }
    return { ok: true, ...r };
  }, { extId, presentFlg, sortNo, pickup, dtoPrefix, idField });

  if (!applied || !applied.ok) {
    const cap = await captureScrapeDebug(page, 'staff', 'no_row', { diagnostics: { applied } });
    return fail(`スタッフ行を特定できませんでした (${applied?.reason || ''}, capture=${cap || '?'})`, 'STAFF_MAPPING_NOT_FOUND', true);
  }
  // sortNo は locator.fill で実入力 (dirty state を確実に立てる)
  if (sortNo != null && applied.idx != null && applied.idx >= 0) {
    const sel = `[name="${dtoPrefix}[${applied.idx}].sortNo"]`;
    await page.fill(sel, '', { timeout: 6000 }).catch(() => {});
    await page.fill(sel, String(sortNo), { timeout: 6000 }).catch(() => {});
  }
  if (!enablePush) return { status: 'confirm_only', confirmed: applied };

  let dialogAccepted = false;
  const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    // 並び順/PickUp は一覧上部の「変更内容を登録する」に相当する sort form を保存する。
    if (sortNo != null || pickup != null) {
      const hasForm = await page.evaluate((fid) => !!document.getElementById(fid), sortFormId).catch(() => false);
      if (!hasForm) {
        const cap = await captureScrapeDebug(page, 'staff', 'no_form2', { diagnostics: { url: page.url(), sortFormId, genre } });
        return fail(`スタッフ保存フォーム (${sortFormId}) が見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
      }
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        page.evaluate((fid) => { const f = document.getElementById(fid); if (f) f.submit(); }, sortFormId),
      ]);
      await page.waitForTimeout(1800);
      const yes = page.locator('a.accept:visible, a:has-text("はい"):visible, a:has-text("登録する"):visible, a:has-text("設定する"):visible').first();
      if ((await yes.count().catch(() => 0)) > 0) { await yes.click({ timeout: 8_000 }).catch(() => {}); await page.waitForTimeout(1500); }
    }
  } finally {
    page.off('dialog', onDialog);
  }
  const afterBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const errMatch = afterBody.match(/.{0,30}(利用不可文字|入力してください|必須|エラー|不正).{0,30}/);
  // 送信後に一覧を再取得し、sortNo/掲載状態が保存されているか確認する。
  await openList();
  let reRead = await page.evaluate(({ extId, wantSort, dtoPrefix, idField }) => {
    let idx = -1;
    for (const h of document.querySelectorAll(`input[type="hidden"][name^="${dtoPrefix}"][name$=".${idField}"]`)) {
      if (h.value === extId) { const m = (h.name || '').match(/\[(\d+)\]/); if (m) idx = parseInt(m[1], 10); break; }
    }
    if (idx < 0) return { persisted: false, current: null, published: null };
    const el = document.querySelector(`[name="${dtoPrefix}[${idx}].sortNo"]`);
    const pub = document.querySelector(`[name="${dtoPrefix}[${idx}].presentFlg"]`);
    const cur = el ? (el.value || '') : null;
    return { persisted: wantSort == null || cur === String(wantSort), current: cur, published: pub ? String(pub.value) === '1' : null };
  }, { extId, wantSort: sortNo, dtoPrefix, idField }).catch(() => ({ persisted: false, current: null, published: null }));

  // 掲載/非掲載は一覧 sort form ではなく、対象行の専用ボタンで切り替える。
  const wantPublished = presentFlg == null ? null : Number(presentFlg) === 1;
  if (wantPublished != null && reRead.published != null && reRead.published !== wantPublished) {
    const toggle = page.locator(`a[onclick*="${extId}"][onclick*="Present" i], a[onclick*="${extId}"][onclick*="present" i]`).first();
    if ((await toggle.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'staff', 'no_present_toggle', { diagnostics: { extId, genre, wantPublished, reRead } });
      return fail(`スタッフ掲載状態の変更ボタンが見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    const toggleDialogs = [];
    const acceptToggle = async (d) => { toggleDialogs.push(String(d.message() || '')); try { await d.accept(); } catch (_e) { /* noop */ } };
    page.on('dialog', acceptToggle);
    try {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {}),
        toggle.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1500);
    } finally {
      page.off('dialog', acceptToggle);
    }
    await openList();
    reRead = await page.evaluate(({ extId, dtoPrefix, idField, wantSort }) => {
      const ids = Array.from(document.querySelectorAll(`input[type="hidden"][name^="${dtoPrefix}"][name$=".${idField}"]`));
      const h = ids.find((x) => x.value === extId);
      const m = h && (h.name || '').match(/\[(\d+)\]/);
      if (!m) return { persisted: false, current: null, published: null };
      const idx = Number(m[1]);
      const s = document.querySelector(`[name="${dtoPrefix}[${idx}].sortNo"]`);
      const pub = document.querySelector(`[name="${dtoPrefix}[${idx}].presentFlg"]`);
      return { persisted: wantSort == null || (s && s.value === String(wantSort)), current: s ? s.value : null, published: pub ? String(pub.value) === '1' : null };
    }, { extId, dtoPrefix, idField, wantSort: sortNo }).catch(() => ({ persisted: false, current: null, published: null }));
  }
  const diag = { dialogAccepted, err: errMatch ? errMatch[0].trim() : null, reRead };
  if (sortNo != null && !reRead.persisted) {
    const cap = await captureScrapeDebug(page, 'staff', 'not_persisted', { diagnostics: diag });
    return { status: 'failed', reason: `スタッフの並び順が保存されませんでした (err=${diag.err}, current=${reRead.current}, capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true, diag };
  }
  if (wantPublished != null && reRead.published != null && reRead.published !== wantPublished) {
    const cap = await captureScrapeDebug(page, 'staff', 'publish_not_persisted', { diagnostics: { ...diag, wantPublished } });
    return { status: 'failed', reason: `スタッフ掲載状態が保存されませんでした (current=${reRead.published}, capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: false, diag };
  }
  return { status: 'ok', externalId: extId, confirmed: { ...applied, diag } };
}

/**
 * メニューを SalonBoard に書き込む。/CNK/draft/menuEdit のインライン。
 * menuId 一致行 (無ければ menuName 一致) を更新 → 「登録」(a.jsc_menuEdit_btn_reg)。
 * payload: { external_id?(menuId), name, price?, duration_min?, sort_no? }
 */
async function pushMenuViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const extId = String(p.external_id || p.menu_id || '').trim();
  const name = String(p.name || p.menu_name || '').trim();
  if (!extId && !name) return fail('メニューの external_id も name もありません', 'UNKNOWN_ERROR', true);
  const price = p.price ?? null;
  const dur = p.duration_min ?? p.sejyutsu_aim_time ?? null;
  const sortNo = p.sort_no ?? p.sortNo ?? null;

  await page.goto(new URL('/CNK/draft/menuEdit', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  if ((await page.locator('form#menuEditForm').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'menu', 'no_form', { diagnostics: { url: page.url() } });
    return fail(`メニュー編集フォーム (menuEditForm) に到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  const applied = await page.evaluate(({ extId, name, price, dur, sortNo }) => {
    const setVal = (el, v) => { if (!el) return false; el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const idxOf = (el) => { const m = (el.name || '').match(/\[(\d+)\]/); return m ? parseInt(m[1], 10) : -1; };
    let idx = -1;
    if (extId) {
      for (const h of document.querySelectorAll('input[name^="frmMenuEditMenuDetailList"][name$=".menuId"]')) {
        if (h.value === extId) { idx = idxOf(h); break; }
      }
    }
    if (idx < 0 && name) {
      for (const el of document.querySelectorAll('[name^="frmMenuEditMenuDetailList"][name$=".menuName"]')) {
        if ((el.value || '').trim() === name) { idx = idxOf(el); break; }
      }
    }
    if (idx < 0) return { ok: false, reason: 'menu_not_found' };
    const byField = (f) => document.querySelector(`[name="frmMenuEditMenuDetailList[${idx}].${f}"]`);
    const r = { idx };
    if (name) r.name = setVal(byField('menuName'), name);
    if (price != null) r.price = setVal(byField('price'), price);
    if (dur != null) r.dur = setVal(byField('sejyutsuAimTime'), dur);
    if (sortNo != null) r.sortNo = setVal(byField('sortNo'), sortNo);
    return { ok: true, ...r };
  }, { extId, name, price, dur, sortNo });

  if (!applied || !applied.ok) {
    const cap = await captureScrapeDebug(page, 'menu', 'no_row', { diagnostics: { applied } });
    return fail(`メニュー行を特定できませんでした (${applied?.reason || ''}, capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  // dirty state を確実に立てるため text 系は locator.fill で実入力し直す。
  if (applied.idx != null && applied.idx >= 0) {
    const base = `[name="frmMenuEditMenuDetailList[${applied.idx}].`;
    if (name) { await page.fill(`${base}menuName"]`, '', { timeout: 6000 }).catch(() => {}); await page.fill(`${base}menuName"]`, name, { timeout: 6000 }).catch(() => {}); }
    if (price != null) { await page.fill(`${base}price"]`, String(price), { timeout: 6000 }).catch(() => {}); }
  }
  if (!enablePush) return { status: 'confirm_only', confirmed: applied };

  let dialogAccepted = false;
  const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    const btn = page.locator('a.jsc_menuEdit_btn_reg, a#registBtn, a:has-text("登録する")').first();
    if ((await btn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'menu', 'no_regist', { diagnostics: { url: page.url() } });
      return fail(`メニューの登録ボタンが見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      btn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    const yes = page.locator('a.accept:visible, a:has-text("はい"):visible, a:has-text("登録する"):visible').first();
    if ((await yes.count().catch(() => 0)) > 0) { await yes.click({ timeout: 8_000 }).catch(() => {}); await page.waitForTimeout(1200); }
  } finally {
    page.off('dialog', onDialog);
  }
  const afterBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const errMatch = afterBody.match(/.{0,30}(利用不可文字|入力してください|必須|エラー|不正).{0,30}/);
  // 送信後に menuEdit を再取得し、menuId 行の名前が新値で保存されているか確認
  await page.goto(new URL('/CNK/draft/menuEdit', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  const reRead = await page.evaluate(({ extId, wantName }) => {
    let idx = -1;
    for (const h of document.querySelectorAll('input[name^="frmMenuEditMenuDetailList"][name$=".menuId"]')) {
      if (h.value === extId) { const m = (h.name || '').match(/\[(\d+)\]/); if (m) idx = parseInt(m[1], 10); break; }
    }
    if (idx < 0) return { persisted: false, current: null };
    const el = document.querySelector(`[name="frmMenuEditMenuDetailList[${idx}].menuName"]`);
    const cur = el ? (el.value || '') : null;
    return { persisted: cur === wantName, current: cur };
  }, { extId, wantName: name }).catch(() => ({ persisted: false, current: null }));
  const diag = { dialogAccepted, err: errMatch ? errMatch[0].trim() : null, reRead };
  if (name && !reRead.persisted) {
    const cap = await captureScrapeDebug(page, 'menu', 'not_persisted', { diagnostics: diag });
    return { status: 'failed', reason: `メニュー名が保存されませんでした (err=${diag.err}, current=${reRead.current}, capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true, diag };
  }
  return { status: 'ok', externalId: extId || null, confirmed: { ...applied, diag } };
}

/**
 * クーポンを SalonBoard に書き込む。/CNK/draft/couponList → #couponEditForm に couponId を
 * セットして submit → couponEdit (frmCouponEditCnkDto.*) を更新 → 登録。
 * payload: { external_id(couponId), name?, price?, duration_min?, content? }
 */
async function pushCouponViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const extId = String(p.external_id || p.coupon_id || '').trim();
  if (!extId) return fail('クーポンの external_id (couponId) がありません', 'UNKNOWN_ERROR', true);
  const name = String(p.name || p.coupon_name || '').trim();
  const price = p.price ?? null;
  const dur = p.duration_min ?? p.sejyutsu_aim_time ?? null;
  const content = p.content ?? p.content_explanation ?? null;

  await page.goto(draftUrl(opts.genre, 'couponList', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  // couponEditForm に couponId をセットして submit (read scraper と同手順)
  const submitted = await page.evaluate((couponId) => {
    const form = document.querySelector('#couponEditForm');
    if (!form) return false;
    let idInput = form.querySelector('input[name="couponId"]');
    if (!idInput) { idInput = document.createElement('input'); idInput.type = 'hidden'; idInput.name = 'couponId'; form.appendChild(idInput); }
    idInput.value = couponId;
    form.submit();
    return true;
  }, extId).catch(() => false);
  if (!submitted) {
    const cap = await captureScrapeDebug(page, 'coupon', 'no_list_form', { diagnostics: { url: page.url() } });
    return fail(`クーポン一覧の couponEditForm が見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }
  await page.waitForSelector('input[name="frmCouponEditCnkDto.couponName"]', { timeout: 15_000 }).catch(() => {});
  if ((await page.locator('input[name="frmCouponEditCnkDto.couponName"]').count().catch(() => 0)) === 0) {
    const cap = await captureScrapeDebug(page, 'coupon', 'no_edit_form', { diagnostics: { url: page.url() } });
    return fail(`クーポン編集ページに到達できませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
  }

  const applied = await page.evaluate(({ name, price, dur, content }) => {
    const setVal = (sel, v) => { const el = document.querySelector(sel); if (!el) return false; el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const r = {};
    if (name) r.name = setVal('input[name="frmCouponEditCnkDto.couponName"]', name);
    if (price != null) r.price = setVal('input[name="frmCouponEditCnkDto.price"]', price);
    if (dur != null) r.dur = setVal('input[name="frmCouponEditCnkDto.sejyutsuAimTime"]', dur);
    if (content != null) r.content = setVal('textarea[name="frmCouponEditCnkDto.contentExplanation"]', content);
    return { ok: true, ...r };
  }, { name, price, dur, content });

  // dirty state: couponName を locator.fill で実入力し直す
  if (name) {
    await page.fill('input[name="frmCouponEditCnkDto.couponName"]', '', { timeout: 6000 }).catch(() => {});
    await page.fill('input[name="frmCouponEditCnkDto.couponName"]', name, { timeout: 6000 }).catch(() => {});
  }

  if (!enablePush) return { status: 'confirm_only', confirmed: applied };

  let dialogAccepted = false;
  const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    const btn = page.locator('a#registBtn, a.jsc_couponEdit_btn_reg, a[onclick*="regist" i]:visible, a[onclick*="doRegist" i]:visible, a[onclick*="submit" i]:visible, img[alt*="登録"], input[type="image"][alt*="登録"], input[type="submit"][value*="登録"], input[type="button"][value*="登録"], a:has-text("確認する"):visible, a:has-text("登録する"):visible').first();
    if ((await btn.count().catch(() => 0)) === 0) {
      const btns = await page.evaluate(() => Array.from(document.querySelectorAll('a,input,img,button')).filter((e) => /登.?録|設定|確認|reflect/.test((e.textContent || '') + (e.getAttribute('alt') || '') + (e.getAttribute('value') || '') + (e.getAttribute('onclick') || ''))).slice(0, 12).map((e) => ({ tag: e.tagName, t: (e.textContent || '').trim().slice(0, 12), alt: e.getAttribute('alt'), oc: (e.getAttribute('onclick') || '').slice(0, 50), id: e.id, cls: (e.className || '').slice(0, 30) }))).catch(() => []);
      const cap = await captureScrapeDebug(page, 'coupon', 'no_regist', { diagnostics: { url: page.url(), btns } });
      return { status: 'failed', reason: `クーポンの登録ボタンが見つかりません (capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true, btns };
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      btn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    const yes = page.locator('a.accept:visible, a:has-text("はい"):visible, a#regist:visible, a:has-text("登録する"):visible, a:has-text("登録・反映"):visible').first();
    if ((await yes.count().catch(() => 0)) > 0) { await yes.click({ timeout: 8_000 }).catch(() => {}); await page.waitForTimeout(1200); }
  } finally {
    page.off('dialog', onDialog);
  }
  const afterBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const errMatch = afterBody.match(/.{0,30}(利用不可文字|入力してください|必須|エラー|不正).{0,30}/);
  // 送信後に couponEdit を再取得し couponName が保存されているか確認 (couponList→couponEditForm submit)
  await page.goto(draftUrl(opts.genre, 'couponList', baseUrl), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
  await page.evaluate((couponId) => {
    const form = document.querySelector('#couponEditForm');
    if (!form) return;
    let i = form.querySelector('input[name="couponId"]');
    if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = 'couponId'; form.appendChild(i); }
    i.value = couponId; form.submit();
  }, extId).catch(() => {});
  await page.waitForSelector('input[name="frmCouponEditCnkDto.couponName"]', { timeout: 15_000 }).catch(() => {});
  const reRead = await page.evaluate((wantName) => {
    const el = document.querySelector('input[name="frmCouponEditCnkDto.couponName"]');
    const cur = el ? (el.value || '') : null;
    return { persisted: cur === wantName, current: cur };
  }, name).catch(() => ({ persisted: false, current: null }));
  const diag = { dialogAccepted, err: errMatch ? errMatch[0].trim() : null, reRead };
  if (name && !reRead.persisted) {
    const cap = await captureScrapeDebug(page, 'coupon', 'not_persisted', { diagnostics: diag });
    return { status: 'failed', reason: `クーポン名が保存されませんでした (err=${diag.err}, current=${reRead.current}, capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true, diag };
  }
  return { status: 'ok', externalId: extId, confirmed: { ...applied, diag } };
}

/**
 * 勤務パターン（早番/遅番など）を SalonBoard に登録する。
 * 画面: /KLP/set/workPatternSetup/「勤務パターン登録」。登録フォーム行(select を含む tr)に
 * シフト名称/短縮名/設定時間(開始H:M〜終了H:M)/備考 を入力し「追加する」。登録済み一覧
 * (input[name=deleteShiftIds] を持つ行) に同名があればスキップ(重複防止)。
 * payload: { patterns: [{ name, short_name, start:"HH:MM", end:"HH:MM", note? }] } または単一 {name,...}
 */
async function pushWorkPatternViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const patterns = Array.isArray(p.patterns) ? p.patterns : (p.name ? [p] : []);
  if (patterns.length === 0) return fail('勤務パターンが指定されていません (patterns)', 'UNKNOWN_ERROR', true);

  // 勤務パターン登録画面へ到達する。
  // SalonBoard は monthlySetup で確立した業態/店舗コンテキストと
  // returnPathStorage=04 を要求することがある。異なる業態のURLを総当たりすると、
  // KLP(エステ)のジョブが最後のCNB(美容)画面に残り、正しい認証状態でも
  // SHIFT_PATTERNS_UNREACHABLE になるため、現在の業態の正規導線だけを使う。
  const genre = opts.genre === 'hair' || p.genre === 'hair' ? 'hair' : 'esthetic';
  const setupPrefix = genre === 'hair' ? '/CLP/bt/set/' : '/KLP/set/';
  const monthlyPath = `${setupPrefix}monthlySetup/`;
  const workPatternPath = `${setupPrefix}workPatternSetup/?returnPathStorage=04`;
  const isReached = async () => {
    if ((await page.locator('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]').count().catch(() => 0)) > 0) {
      return true;
    }
    // 入力行だけで判定する場合も、monthlySetup等の別画面にあるselectを
    // 勤務パターンフォームと誤認しないようURLを併用する。
    return /\/workPatternSetup\//.test(page.url())
      && (await page.locator('tr:has(select)').count().catch(() => 0)) > 0;
  };
  const openFromMonthlySetup = async () => {
    // hairのグループアカウントでは、monthlySetupを開く前に対象サロンを選択する。
    if (genre === 'hair' && (opts.salonId || opts.shopName)) {
      const selected = await ensureSalonSelected(page, {
        salonId: opts.salonId,
        shopName: opts.shopName,
        genre,
        baseUrl,
      }).catch(() => ({ ok: false }));
      if (!selected?.ok) return false;
    }

    await page.goto(new URL(monthlyPath, baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    }).catch(() => {});

    // 正規導線: 毎月の受付設定 -> 勤務パターン登録。
    const link = page.locator(
      `a[href*="${setupPrefix}workPatternSetup"], a[href*="workPatternSetup"]:has-text("勤務パターン"), a:has-text("勤務パターン登録")`,
    ).first();
    if ((await link.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
        link.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForSelector('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]', {
        timeout: 10_000,
      }).catch(() => {});
      if (await isReached()) return true;
    }

    // リンクのDOMが店舗ごとに異なる場合のみ、monthlySetupで文脈を確立した後に
    // returnPathStorage=04付きの同一業態URLを開く。
    await page.goto(new URL(workPatternPath, baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    }).catch(() => {});
    await page.waitForSelector('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]', {
      timeout: 10_000,
    }).catch(() => {});
    return isReached();
  };

  let reached = await openFromMonthlySetup();
  if (!reached && typeof opts.relogin === 'function') {
    const relogged = await opts.relogin().catch(() => false);
    if (relogged) reached = await openFromMonthlySetup();
  }
  if (!reached) {
    const capture = await captureScrapeDebug(page, 'shift-patterns', 'work_pattern_unreachable', {
      diagnostics: {
        genre,
        monthlyPath,
        workPatternPath,
        finalUrl: page.url().replace('https://salonboard.com', ''),
      },
    }).catch(() => null);
    return fail(
      `勤務パターン登録画面に到達できませんでした (genre=${genre}, url=${page.url().replace('https://salonboard.com', '')}${capture ? `, capture=${capture}` : ''})`,
      'SHIFT_PATTERNS_UNREACHABLE',
      true,
    );
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);

  // 登録済み判定: 名称一致 OR 設定時間(開始AND終了)一致。Admin プリセット名(例 平日早番)と
  // SB 既存名(例 平日早)が異なっても、時間一致なら同一パターンとみなし重複登録を防ぐ。
  const tableHas = (wantName, wantStart, wantEnd) => page.evaluate(({ n, s, e }) => {
    for (const b of document.querySelectorAll('input[name="deleteShiftIds"]')) {
      let tr = b; while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      if (!tr) continue;
      const t = (tr.innerText || '');
      if (n && t.includes(n)) return true;
      if (s && e && t.includes(s) && t.includes(e)) return true;
    }
    return false;
  }, { n: wantName, s: wantStart, e: wantEnd }).catch(() => false);

  // 呼び出し側が保持する勤務パターン一覧は、SBの短縮名を取得できない店舗がある。
  // 最終的な一意性は、登録直前にこの画面の実テーブルを正として再確認する。
  const readUsedShortNames = () => page.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll('input[name="deleteShiftIds"]')) {
      let tr = box;
      while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      if (!tr) continue;
      const cells = Array.from(tr.querySelectorAll('td'));
      // 登録済み一覧は [シフト名称, 短縮名, 設定時間, 備考, 削除]。
      const short = (cells[1]?.textContent || '').replace(/[\s　]+/g, '').trim();
      if (short) out.push(short);
    }
    return out;
  }).catch(() => []);
  const allocateShortName = (used) => {
    // SBの短縮名は半角英数記号あわせて2文字以内。01..ZZから未使用を選ぶ。
    for (let seq = 1; seq < 36 * 36; seq++) {
      const candidate = seq.toString(36).toUpperCase().padStart(2, '0').slice(-2);
      if (!used.has(candidate)) return candidate;
    }
    return null;
  };

  const results = [];
  for (const pat of patterns) {
    const name = String(pat.name || '').trim();
    let shortName = String(pat.short_name || pat.shortName || '').trim();
    const start = String(pat.start || pat.start_time || '').trim();
    const end = String(pat.end || pat.end_time || '').trim();
    if (!name || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      results.push({ name, status: 'skipped', reason: 'name/start/end(HH:MM) 不足' });
      continue;
    }
    if (await tableHas(name, start, end)) { results.push({ name, status: 'exists' }); continue; }
    const usedShortNames = new Set(await readUsedShortNames());
    const requestedShortName = shortName;
    // 空・3文字以上・既存との重複は、登録画面上で未使用の2文字へ差し替える。
    if (!shortName || shortName.length > 2 || usedShortNames.has(shortName)) {
      shortName = allocateShortName(usedShortNames);
      if (!shortName) {
        results.push({ name, status: 'failed', reason: '勤務パターン短縮名の空きがありません' });
        continue;
      }
      console.log(`[SHIFT-B] short name reassigned ${requestedShortName || '(empty)'} -> ${shortName} for ${name}`);
    }
    const [sh, sm] = start.split(':');
    const [eh, em] = end.split(':');

    const filled = await page.evaluate(({ name, shortName, sh, sm, eh, em, note }) => {
      // select を含む tr = 登録入力行 (登録済み一覧行は select を持たない)
      let row = null;
      for (const tr of document.querySelectorAll('tr')) { if (tr.querySelector('select')) { row = tr; break; } }
      if (!row) return { ok: false, reason: 'no_input_row' };
      const texts = Array.from(row.querySelectorAll('input[type="text"], input:not([type]):not([type="checkbox"])'));
      const selects = Array.from(row.querySelectorAll('select'));
      const setText = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      const setSel = (el, v) => {
        if (!el) return false;
        const cands = [v, String(Number(v)), String(v).padStart(2, '0')];
        const o = Array.from(el.options).find((o) => cands.includes(o.value) || cands.includes((o.textContent || '').trim()));
        if (!o) return false;
        el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true;
      };
      const r = { texts: texts.length, selects: selects.length };
      r.name = setText(texts[0], name);                       // シフト名称
      if (shortName) r.short = setText(texts[1], shortName);   // 短縮名
      if (note && texts[2]) r.note = setText(texts[2], note);  // 備考
      r.sh = setSel(selects[0], sh); r.sm = setSel(selects[1], sm); // 開始 H:M
      r.eh = setSel(selects[2], eh); r.em = setSel(selects[3], em); // 終了 H:M
      return { ok: true, ...r };
    }, { name, shortName, sh, sm, eh, em, note: String(pat.note || '') });

    if (!filled || !filled.ok) { results.push({ name, status: 'failed', reason: filled?.reason || 'fill_failed', filled }); continue; }
    // シフト名称を locator.fill で確実に dirty 化
    const nameLoc = page.locator('tr:has(select) input[type="text"], tr:has(select) input:not([type])').first();
    await nameLoc.fill('', { timeout: 5000 }).catch(() => {});
    await nameLoc.fill(name, { timeout: 5000 }).catch(() => {});

    if (!enablePush) { results.push({ name, status: 'confirm_only', confirmed: filled }); continue; }

    let dialogAccepted = false;
    const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
    page.on('dialog', onDialog);
    try {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
        page.locator('a:has-text("追加する"):visible, input[type="submit"][value*="追加"], input[type="button"][value*="追加"], input[type="image"][alt*="追加"], button:has-text("追加"), a[onclick*="add" i]:visible').first().click({ timeout: 12_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1500);
      const yes = page.locator('a.accept:visible, a:has-text("はい"):visible, a:has-text("登録する"):visible, a:has-text("追加する"):visible').first();
      if ((await yes.count().catch(() => 0)) > 0) { await yes.click({ timeout: 8_000 }).catch(() => {}); await page.waitForTimeout(1200); }
    } finally {
      page.off('dialog', onDialog);
    }
    const persisted = await tableHas(name);
    if (!persisted) {
      const cap = await captureScrapeDebug(page, 'workpattern', 'not_persisted', { diagnostics: { name, dialogAccepted, filled } });
      results.push({ name, status: 'failed', reason: `勤務パターンが登録一覧に反映されませんでした (capture=${cap || '?'})`, errorCode: 'UNKNOWN_ERROR', manualRequired: true });
    } else {
      results.push({
        name,
        status: 'ok',
        short_name: shortName,
        ...(requestedShortName !== shortName ? { short_name_reassigned_from: requestedShortName || null } : {}),
      });
    }
  }

  const anyFail = results.some((r) => r.status === 'failed');
  const anyOk = results.some((r) => r.status === 'ok' || r.status === 'exists' || r.status === 'confirm_only');
  return { status: anyFail ? 'failed' : (anyOk ? 'ok' : 'failed'), results };
}

/**
 * スタッフの全プロフィールを SalonBoard に書き込む。
 * 画面: /CNK/draft/staffList の該当行 詳細(onclick=staffEdit('Wxxx')) → /CNK/draft/staffEdit。
 * 「掲載済みを別スタッフとして上書き登録しない」ため、必ず既存行の編集経路で入る。
 * 名前/フリガナ/性別/キャッチ/自己紹介/職種/指名 をラベルベースで入力 →「登録」→ reRead。
 * payload: { external_id, name?, furigana?, gender?('male'|'female'|'男性'|'女性'),
 *            catch_copy?, bio?, role?, nomination?('可能'|'不可') }
 */
async function pushStaffProfileViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });

  const extId = String(p.external_id || p.salonboard_staff_external_id || p.staff_id || '').trim();
  if (!extId) return fail('スタッフの external_id (staffId) がありません', 'UNKNOWN_ERROR', true);
  const name = p.name != null ? String(p.name).trim() : null;
  const furigana = p.furigana ?? p.kana ?? null;
  const genderRaw = (p.gender ?? '').toString().toLowerCase();
  const gender = genderRaw === 'male' || genderRaw === 'm' || genderRaw === '男性' || genderRaw === '男' ? '男性'
    : (genderRaw === 'female' || genderRaw === 'f' || genderRaw === '女性' || genderRaw === '女' ? '女性' : null);
  const catchCopy = p.catch_copy ?? p.catch ?? null;
  const bio = p.bio ?? p.self_intro ?? p.introduction ?? null;
  const role = p.role ?? p.job_type ?? p.position ?? null;
  const nomination = p.nomination ?? p.shimei ?? null; // '可能' | '不可'

  // ★掲載管理はジャンルで URL 接頭辞が違う。美容室(hair)=スタイリスト掲載=/CNB/draft/stylistList、
  //   エステ/ネイル/まつげ=/CNK/draft/staffList。hair店で /CNK 固定だと該当スタッフが居らず
  //   staffEdit に到達できず全 hair店が no_edit_page で失敗していた(2026-07-16 26件/24h)。
  const genre = opts.genre === 'hair' || p.genre === 'hair' ? 'hair' : 'esthetic';
  const listUrl = genre === 'hair' ? '/CNB/draft/stylistList/' : '/CNK/draft/staffList';
  const listIdSelector = genre === 'hair'
    ? 'input[name^="frmStylistListStylistDtoList"][name$=".stylistId"]'
    : 'input[name^="frmStaffListStafferDtoList"][name$=".staffId"]';

  // staffList/stylistList → 該当行の編集画面へ。グループ店舗ではサロン選択が
  // 直後の掲載管理遷移で失われることがあるため、一覧の実DOMが出るまで選択から1回やり直す。
  const openProfileList = async () => {
    let selectionReason = null;
    for (let n = 0; n < 2; n += 1) {
      if (opts.salonId) {
        await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        const selected = await ensureSalonSelected(page, {
          salonId: opts.salonId,
          shopName: opts.shopName,
          genre,
          baseUrl,
        }).catch((e) => ({ ok: false, reason: e?.message || String(e) }));
        if (!selected?.ok) { selectionReason = selected?.reason || 'unknown'; continue; }
      }
      await page.goto(new URL(listUrl, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {});
      if ((await page.locator(listIdSelector).count().catch(() => 0)) > 0) return { ok: true };
      await page.waitForTimeout(800);
    }
    return { ok: false, reason: selectionReason || 'staff_list_form_missing' };
  };
  const listOpened = await openProfileList();
  if (!listOpened.ok) {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 220);
    const cap = await captureScrapeDebug(page, 'staffprofile', 'no_list', { diagnostics: { url: page.url(), genre, listUrl, reason: listOpened.reason, body } });
    return fail(`スタッフ一覧フォームに到達できませんでした (${listOpened.reason}, capture=${cap || '?'})`, listOpened.reason === 'staff_list_form_missing' ? 'UNKNOWN_ERROR' : 'SALON_SELECTION_FAILED', false);
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);

  // ★probe: genre別に一覧の編集導線と {id,名前} を掴む。
  //   hair=掲載T-code(frmStylistListStylistDtoList.stylistId), esthetic=staffEdit('Wxxx') onclick。
  if (p.probe === true) {
    const ld = await page.evaluate((g) => {
      if (g === 'hair') {
        const ids = Array.from(document.querySelectorAll('input[name^="frmStylistListStylistDtoList["][name$=".stylistId"]')).filter((el) => (el.value || '').trim());
        const list = ids.slice(0, 30).map((inp) => {
          const tr = inp.closest('tr');
          const cells = tr ? Array.from(tr.querySelectorAll('td.td_value_store_c')).map((c) => (c.textContent || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t !== '-' && !/^No\.?\s*\d*$/.test(t)) : [];
          return { id: inp.value.trim(), name: cells[0] || '' };
        });
        return { mode: 'hair', count: ids.length, list };
      }
      // esthetic: staffEdit('Wxxx') を含む onclick を持つ要素を集める
      const eds = Array.from(document.querySelectorAll('[onclick]')).filter((e) => /staffEdit|staffId|W0\d/.test(e.getAttribute('onclick') || ''));
      const list = eds.slice(0, 30).map((e) => {
        const oc = e.getAttribute('onclick') || '';
        const m = oc.match(/'([A-Za-z]?\d{6,})'/) || oc.match(/(W0\d{6,})/);
        const tr = e.closest('tr');
        const nm = tr ? (Array.from(tr.querySelectorAll('td')).map((c) => (c.textContent || '').trim()).filter((t) => t && t.length < 30 && !/^\d+$/.test(t))[0] || '') : (e.textContent || '').trim().slice(0, 16);
        return { id: m ? m[1] : '?', tag: e.tagName.toLowerCase(), oc: oc.slice(0, 50), name: nm };
      });
      // 一覧が空なら、テーブル行 + 全リンクのサンプルも返す
      const anyRows = document.querySelectorAll('table tr').length;
      return { mode: 'esthetic', count: eds.length, anyRows, list };
    }, genre).catch((e) => String((e && e.message) || e));
    console.log('[STAFFDBG list ' + genre + ' url=' + page.url().replace('https://salonboard.com', '') + '] ' + JSON.stringify(ld).slice(0, 2200));
  }

  // ★編集リンクは staffEdit('Wxxx')/stylistEdit(...) を明示指定する。
  //   1行に showErrorPopup/staffEdit/staffUnpresent/staffDelete の4アンカーが全てextIdを含むため、
  //   単純な a[onclick*=extId] だと先頭の showErrorPopup を掴んで編集画面に行けなかった(no_edit_page 真因)。
  const navLink = page.locator(
    `a[onclick*="staffEdit"][onclick*="'${extId}'"], a[onclick*="stylistEdit"][onclick*="'${extId}'"]`,
  ).first();
  if ((await navLink.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
      navLink.click({ timeout: 10_000 }).catch(() => {}),
    ]);
  } else {
    await page.evaluate((id) => {
      // hair の stylistEdit は (event, id) シグネチャ。1引数で呼ぶと id が undefined になり
      // システムエラーへ遷移するため、一覧のPOSTフォームを直接使う。
      try {
        const f = document.getElementById('stylistEditForm');
        const i = f && f.querySelector('input[name="stylistId"]');
        if (f && i) { i.value = id; f.submit(); return; }
      } catch (_e) { /* noop */ }
      try { if (typeof staffEdit === 'function') staffEdit(id); } catch (_e) { /* noop */ }
    }, extId).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  }
  await page.waitForTimeout(800);
  // 編集画面 到達確認 (名前 or フリガナ ラベルの入力欄 / URL)
  const editFieldCount = await page.locator(
    'tr:has(th:has-text("名前")) input, tr:has(th:has-text("フリガナ")) input, '
    + 'tr:has(td:has-text("名前")) input, tr:has(td:has-text("フリガナ")) input',
  ).count().catch(() => 0);
  const editBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const onEdit = editFieldCount > 0 && !/システムエラー|サロンが選択されていません/.test(editBody);
  if (!onEdit) {
    const cap = await captureScrapeDebug(page, 'staffprofile', 'no_edit_page', { diagnostics: { url: page.url(), extId, genre, listUrl } });
    // ★一覧のロード遅延/同時実行負荷で staffEdit リンクを掴めないことが多い(中目黒で
    //   no_edit_page→再試行で成功を実証)。retryable にして自動再試行に任せる
    //   (max_attempts で有界。真にSB未登録のスタッフは試行を使い切って manual に落ちる)。
    return fail(`スタッフ編集画面(staffEdit/stylistEdit ${genre})に到達できませんでした (url=${page.url().replace('https://salonboard.com', '')}, capture=${cap || '?'})`, 'STAFF_MAPPING_NOT_FOUND', false);
  }
  // ★hair の stylistEdit はフォーム項目のラベルが staffEdit と違う可能性があるため、初回に th ラベルと
  //   入力欄の対応を1行だけダンプして実体を確認する(genre-aware化の検証用)。
  if (p.probe === true) {
    const fld = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr')).filter((tr) => tr.querySelector('th') && tr.querySelector('input,textarea,select'));
      return rows.map((tr) => {
        const th = (tr.querySelector('th') || {}).textContent || '';
        const inp = tr.querySelector('input,textarea,select');
        return (th.replace(/\s+/g, '') + '=' + (inp ? (inp.tagName.toLowerCase() + (inp.type ? '[' + inp.type + ']' : '') + (inp.name ? '#' + inp.name : '')) : '?'));
      }).slice(0, 25).join(' | ');
    }).catch((e) => String((e && e.message) || e));
    const btns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a,button,input[type="submit"],input[type="button"],input[type="image"]'))
        .filter((e) => { const t = (e.textContent || '') + (e.getAttribute('value') || '') + (e.getAttribute('alt') || '') + (e.getAttribute('onclick') || ''); return /登録|確定|保存|設定|更新|regist|submit|confirm|save|complete|doRegist|check/i.test(t); })
        .map((e) => (e.tagName.toLowerCase() + (e.type ? '[' + e.type + ']' : '') + ':' + ((e.textContent || e.getAttribute('value') || e.getAttribute('alt') || '').trim().slice(0, 12)) + (e.className ? '.' + e.className.slice(0, 20) : '') + (e.getAttribute('onclick') ? '#oc=' + e.getAttribute('onclick').slice(0, 40) : '')))
        .slice(0, 12).join(' | ');
    }).catch((e) => String((e && e.message) || e));
    console.log('[STAFFDBG ' + genre + '] url=' + page.url().replace('https://salonboard.com', '') + ' fields=' + fld + ' || BTNS=' + btns);
    if (p.probe === true) return { status: 'ok', probe: true, summary: `到達OK(${genre}) ${page.url().replace('https://salonboard.com', '')}`, fields: fld };
  }
  // probe: 到達確認のみ(書込しない)。genre-aware化の安全検証用。
  if (p.probe === true) return { status: 'ok', probe: true, summary: `到達OK(${genre}) ${page.url().replace('https://salonboard.com', '')}` };

  // ラベルベースで各欄を入力 (th ラベルと同じ行の入力欄)
  const fillText = async (label, value) => {
    if (value == null || value === '') return false;
    const loc = page.locator(`tr:has(th:has-text("${label}")) input[type="text"], tr:has(th:has-text("${label}")) input:not([type]), tr:has(th:has-text("${label}")) textarea`).first();
    if ((await loc.count().catch(() => 0)) === 0) return false;
    await loc.fill('', { timeout: 5000 }).catch(() => {});
    await loc.fill(String(value), { timeout: 5000 }).catch(() => {});
    return true;
  };
  // ★名前/フリガナは SB上「姓」+「名」の2欄で両方必須。KD は単一の name/furigana しか持たないため
  //   「姓だけ埋めて名が空」→ SBが「名前(名)を入力してください / フリガナ(名)…」で保存拒否していた
  //   (中目黒 Hinako 実障害・ユーザ提供スクショで確定)。
  //   方針: 姓欄が既に入っている(=SB登録済で名前は既に正しい)なら 名前/フリガナ は一切触らず、
  //   SBの厳格な再バリデーションを誘発せずプロフィール項目(キャッチ/自己紹介/職種/性別/指名)だけ同期する。
  //   姓が空(新規)の時だけ、空白区切りで 姓/名 に分割して両欄を埋める(単一トークンは姓のみ)。
  const fillName = async (label, value) => {
    const inputs = page.locator(`tr:has(th:has-text("${label}")) input[type="text"], tr:has(th:has-text("${label}")) input:not([type])`);
    const n = await inputs.count().catch(() => 0);
    if (n === 0) return false;
    const seiCur = ((await inputs.nth(0).inputValue().catch(() => '')) || '').trim();
    if (seiCur !== '') return 'kept'; // 既存名を保持(上書きせず、名欄が空でも触らない=再バリデーション回避)
    if (value == null || String(value).trim() === '') return false;
    const parts = String(value).trim().split(/[\s　]+/).filter(Boolean);
    await inputs.nth(0).fill(parts[0] || String(value).trim(), { timeout: 5000 }).catch(() => {});
    if (n > 1 && parts.length > 1) await inputs.nth(1).fill(parts.slice(1).join(' '), { timeout: 5000 }).catch(() => {});
    return true;
  };
  const applied = {};
  applied.name = await fillName('名前', name);
  applied.furigana = await fillName('フリガナ', furigana);
  applied.catch = await fillText('キャッチ', catchCopy);
  applied.bio = await fillText('自己紹介', bio);
  applied.role = await fillText('職種', role);
  if (gender) {
    const gloc = page.locator(`tr:has(th:has-text("性別")) input[type="radio"]`);
    const idx = gender === '男性' ? 0 : 1; // 表示順: 男性, 女性
    if ((await gloc.count().catch(() => 0)) > idx) { await gloc.nth(idx).check({ timeout: 4000 }).catch(() => {}); applied.gender = true; }
  }
  if (nomination != null) {
    const sloc = page.locator(`tr:has(th:has-text("指名")) select`).first();
    if ((await sloc.count().catch(() => 0)) > 0) { await sloc.selectOption({ label: String(nomination) }).catch(() => {}); applied.nomination = true; }
  }

  if (!enablePush) return { status: 'confirm_only', confirmed: applied };

  let dialogAccepted = false;
  const onDialog = async (d) => { dialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    // ★登録は <a onclick="moveToRegist('staffForm',...)"> を厳密に狙う。
    //   a.moveBtn.chk 等を union に入れると Playwright は DOM順で先頭を返すため、別の「設定」アンカーを
    //   掴んで /KLP/schedule へ飛ぶ不具合があった(2026-07-17)。まず staffForm の登録を単独で探す。
    let btn = page.locator(`a[onclick*="moveToRegist('staffForm'"], a[onclick*="moveToRegist('stylistForm'"]`).first();
    if ((await btn.count().catch(() => 0)) === 0) {
      // 実画面の青い「登録」は <a><img alt="登録"></a>。画像自体ではなく親aを優先して押す。
      btn = page.locator(
        `a:has(img[alt="登録"]):visible, a:has(input[type="image"][alt="登録"]):visible, `
        + `a[onclick*="regist" i]:visible, a[onclick*="confirm" i]:visible, `
        + `input[type="image"][alt="登録"], input[type="submit"][value="登録"], `
        + `a:has-text("登録する"):visible, a:has-text("登録"):visible, button:has-text("登録")`,
      ).first();
    }
    if ((await btn.count().catch(() => 0)) === 0) {
      const btns = await page.evaluate(() => Array.from(document.querySelectorAll('a,input,img,button'))
        .filter((e) => /登.?録|保存|更新|regist|confirm/i.test((e.textContent || '') + (e.getAttribute('alt') || '') + (e.getAttribute('value') || '') + (e.getAttribute('onclick') || '')))
        .slice(0, 16)
        .map((e) => ({ tag: e.tagName, text: (e.textContent || '').trim().slice(0, 20), alt: e.getAttribute('alt'), id: e.id, cls: String(e.className || '').slice(0, 40), onclick: String(e.getAttribute('onclick') || '').slice(0, 80) }))).catch(() => []);
      const cap = await captureScrapeDebug(page, 'staffprofile', 'no_regist', { diagnostics: { url: page.url(), genre, btns, body: editBody.slice(0, 220) } });
      return fail(`スタッフ編集の登録ボタンが見つかりません (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 3_500 }).catch(() => {}),
      btn.click({ timeout: 12_000, force: true }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    if (p.debug_submit === true) {
      const d = await page.evaluate(() => {
        const bt = Array.from(document.querySelectorAll('a,button,input[type="submit"],input[type="button"],input[type="image"]'))
          .filter((e) => (e.offsetParent !== null))
          .map((e) => (e.tagName.toLowerCase() + ':' + ((e.textContent || e.getAttribute('value') || e.getAttribute('alt') || '').trim().slice(0, 12)) + (e.getAttribute('onclick') ? '#' + e.getAttribute('onclick').slice(0, 40) : ''))).filter((x) => x.length > 3).slice(0, 14);
        const body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
        return { btns: bt.join(' | '), bodyHead: body };
      }).catch((e) => String((e && e.message) || e));
      console.log('[STAFFDBG post-submit] url=' + page.url().replace('https://salonboard.com', '') + ' ' + JSON.stringify(d));
    }
    const yes = page.locator('a.accept:visible, a:has-text("はい"):visible, a:has-text("登録する"):visible, a:has-text("OK"):visible, a[onclick*="doRegist"]:visible, a[onclick*="moveToRegist"]:visible').first();
    if ((await yes.count().catch(() => 0)) > 0) { await yes.click({ timeout: 8_000 }).catch(() => {}); await page.waitForTimeout(1200); }
  } finally {
    page.off('dialog', onDialog);
  }
  const afterBody = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const errMatch = afterBody.match(/.{0,30}(利用不可文字|入力してください|必須項目|エラー|不正な|文字数).{0,30}/);
  // ★SB が「登録が完了しました」を返したら保存成功が確定(doRegister着地)。
  //   reRead ナビゲーションは doRegister 直後だと不安定で current=null 偽陰性になるため、
  //   まず完了メッセージ/URL で成功判定する。(HPB反映は掲載管理の「反映申請」が別途必要=下記注記)
  const registeredOk = /登録が完了|変更が完了|完了しました/.test(afterBody) || /doRegister|doRegist/i.test(page.url());
  if (registeredOk && !errMatch) {
    return { status: 'ok', externalId: extId, summary: `スタッフ情報を更新しました(${genre})`, confirmed: { ...applied, dialogAccepted, registered: true }, note: 'HPB反映は掲載管理の反映申請が別途必要' };
  }
  // reRead: 編集画面を再度開き 名前 が保存されているか
  await openProfileList();
  const re = page.locator(`a[onclick*="staffEdit"][onclick*="'${extId}'"], a[onclick*="stylistEdit"][onclick*="'${extId}'"]`).first();
  if ((await re.count().catch(() => 0)) > 0) {
    await Promise.all([page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}), re.click({ timeout: 10_000 }).catch(() => {})]);
    await page.waitForTimeout(800);
  }
  const reRead = await page.evaluate((wantName) => {
    const loc = document.querySelector('tr input[type="text"]');
    // 名前ラベル行の最初の入力欄
    let cur = null;
    for (const tr of document.querySelectorAll('tr')) {
      const th = tr.querySelector('th');
      if (th && (th.textContent || '').includes('名前')) { const i = tr.querySelector('input[type="text"], input:not([type])'); cur = i ? (i.value || '') : null; break; }
    }
    return { persisted: wantName == null || cur === wantName, current: cur };
  }, name).catch(() => ({ persisted: false, current: null }));
  const diag = { dialogAccepted, err: errMatch ? errMatch[0].trim() : null, reRead, nameApplied: applied.name };
  // 名前は「kept(既存保持)」の場合は上書きしていないので永続化検証しない(false-fail防止)。
  if (name && applied.name === true && !reRead.persisted) {
    const cap = await captureScrapeDebug(page, 'staffprofile', 'not_persisted', { diagnostics: diag });
    // ★バリデーションエラー(利用不可文字/必須未入力等)は決定的なので manual。
    //   それ以外(err=null で完了サイン未検出/reRead で current=null)は Akamai/描画遅延・
    //   同時実行負荷による一過性が大半(単発では成功する: Hinako 実証)。retryable にして
    //   ジョブ単位の自動再試行(max_attempts)で確実に通す。
    const deterministic = !!errMatch;
    return { status: 'failed', reason: `スタッフ名が保存されませんでした (err=${diag.err}, current=${reRead.current}, capture=${cap || '?'})`, errorCode: deterministic ? 'UNKNOWN_ERROR' : 'STAFF_SAVE_UNVERIFIED', manualRequired: deterministic, diag };
  }
  return { status: 'ok', externalId: extId, confirmed: { ...applied, diag } };
}

/**
 * 受付可能数(スケジュールの「残り受付数」)の手動オーバーライドを SalonBoard へ同期する。美容室(hair)専用。
 * payload: { date:'YYYY-MM-DD', slots:[{ slot_min:int(0時からの分), delta:int(±) }], dry_run?:bool }
 * 冪等モデル: 戻す(SB既定へリセット) → 各slotに |delta| 回 +/- クリック → 設定(保存)。再実行で同一結果。
 * 確定DOM(2026-07-13 鯖江H000684640): thead #limitSchedule 内の td#surplus_HHMM(HHMM=0900..2030/30分)。
 *   セル内 a.mod_btn_08=＋(増) / <p>現在値</p> / a.mod_btn_09=−(減)。戻す=a.mod_sch_reset.scheduleReset、
 *   設定=a.mod_sch_update.scheduleUpdate。受付可能数は「店舗全体×時間枠」の1行(スタイリスト別ではない)。
 * 例外は投げない(ブラウザを閉じない)。dry_run では一切クリックしない(selector検証+現在値readのみ)。
 */
async function pushAcceptanceViaSchedule(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  // ★ネイティブ confirm() を承認する。SB の 設定(scheduleUpdate)は
  //   「受付可能数を変更します。よろしいですか？」の window.confirm() を出すが、dialog ハンドラ未登録だと
  //   Playwright が既定で Cancel(dismiss)→保存が中断され値が baseline に戻る(=画面3→保存後1 の真因)。
  //   他の全書込スクレイパと同様 accept() する。dialogMsgs / lastSaveInfo は診断用。
  const dialogMsgs = [];
  let lastSaveInfo = null;
  const onDialog = async (d) => { dialogMsgs.push(String(d.message() || '').slice(0, 120)); try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired, debug: { dialogMsgs, lastSaveInfo } });

  const genre = opts.genre === 'hair' || p.genre === 'hair' ? 'hair' : 'esthetic';
  if (genre !== 'hair') return fail('受付可能数の同期は美容室(hair)のみ対応です', 'GENRE_UNSUPPORTED', false);

  const dateStr = String(p.date || '').trim();
  const md = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!md) return fail(`date が不正です (${dateStr})`, 'UNKNOWN_ERROR', true);
  const ymd = md[1] + md[2] + md[3];
  const hhmm = (mm) => String(Math.floor(mm / 60)).padStart(2, '0') + String(mm % 60).padStart(2, '0');

  const slots = (Array.isArray(p.slots) ? p.slots : [])
    .map((s) => ({ slot_min: Number(s.slot_min), delta: Math.trunc(Number(s.delta)) }))
    .filter((s) => Number.isFinite(s.slot_min) && s.slot_min >= 0 && s.slot_min < 24 * 60 && Number.isFinite(s.delta) && s.delta !== 0);
  const dryRun = p.dry_run === true || !enablePush;

  // --- スケジュール到達 (scrapeHairBookings と同じ堅牢化) ---
  // ★単店(salonIdはあるが非グループ)は /CNC/groupTop/ が無効パスで SESSION_EXPIRED になるため
  //   groupTop を強制しない。まず現在文脈から scheduleリンク→bare goto を試み、失効時のみ relogin→
  //   (group)サロン再選択→再到達を1回だけ行う。
  const navigateToSchedule = async () => {
    try {
      const schedLink = page.locator('a[href*="/CLP/bt/schedule/salonSchedule"]').first();
      await schedLink.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {});
      if ((await schedLink.count().catch(() => 0)) > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {}),
          schedLink.click({ timeout: 6_000 }).catch(() => {}),
        ]);
      } else {
        await page.goto(new URL('/CLP/bt/schedule/salonSchedule/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      }
      const u = new URL('/CLP/bt/schedule/salonSchedule/', baseUrl);
      u.searchParams.set('date', ymd);
      await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await page.waitForSelector('#scheduleItemArea, #limitSchedule', { timeout: 8_000 }).catch(() => {});
    } catch (_e) { /* 到達判定へ */ }
  };
  const checkReached = () => page.evaluate(() => {
    const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
    return {
      hasLimit: !!document.getElementById('limitSchedule'),
      expired: /有効期限|再度ログイン|操作されなかった/.test(body) || !!document.querySelector('input[type="password"]'),
    };
  }).catch(() => ({ hasLimit: false, expired: false }));

  if (opts.salonId) {
    await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
  }
  await navigateToSchedule();
  let reached = await checkReached();
  if ((reached.expired || !reached.hasLimit) && typeof opts.relogin === 'function') {
    const ok = await opts.relogin().catch(() => false);
    if (ok) {
      if (opts.salonId) {
        await page.goto(new URL('/CNC/groupTop/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
        await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName }).catch(() => {});
      }
      await navigateToSchedule();
      reached = await checkReached();
    }
  }
  if (reached.expired) return fail('セッション切れ/ログイン画面に着地しました', 'SESSION_EXPIRED', false);
  // 休業日は SB が受付数行を描画しない → 失敗にせずスキップ(受付枠が無いので調整不要)。
  const isClosed = await page.evaluate(() => /指定した日付は休業日/.test((document.body && document.body.innerText) || '')).catch(() => false);
  if (isClosed && !reached.hasLimit) {
    return { status: 'ok', skipped: true, summary: `受付可能数(${ymd}): 休業日のため受付数行なし・スキップ`, date: dateStr };
  }
  if (!reached.hasLimit) return fail(`残り受付数行(#limitSchedule)が見つかりません (url=${page.url().replace('https://salonboard.com', '')})`, 'ACCEPTANCE_ROW_NOT_FOUND', true);

  // 集計欄が隠れている場合は表示 (best-effort)。
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a,span,div,p')).find(
      (e) => /集計欄を表示/.test((e.textContent || '').trim()) && e.offsetParent !== null,
    );
    if (el) el.click();
  }).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});

  // 対象slotの存在 + 現在値。
  const preview = await page.evaluate((targets) => {
    return targets.map((t) => {
      const cell = document.getElementById('surplus_' + t.hhmm);
      if (!cell) return { hhmm: t.hhmm, delta: t.delta, found: false };
      const cur = parseInt(((cell.querySelector('p') || {}).textContent || '').trim(), 10);
      return {
        hhmm: t.hhmm, delta: t.delta, found: true,
        current: Number.isFinite(cur) ? cur : null,
        hasPlus: !!cell.querySelector('a.mod_btn_08'),
        hasMinus: !!cell.querySelector('a.mod_btn_09'),
      };
    });
  }, slots.map((s) => ({ hhmm: hhmm(s.slot_min), delta: s.delta }))).catch(() => []);

  const bad = preview.filter((x) => !x.found || !x.hasPlus || !x.hasMinus);
  if (slots.length > 0 && bad.length === slots.length) {
    return fail(`対象slotの +/- ボタンが見つかりません (例 surplus_${bad[0] ? bad[0].hhmm : '?'})`, 'ACCEPTANCE_BTN_NOT_FOUND', true);
  }

  const fmtHH = (h) => `${h.slice(0, 2)}:${h.slice(2)}`;
  if (dryRun) {
    const vals = preview.filter((x) => x.found).map((x) => `${fmtHH(x.hhmm)}=${x.current == null ? '?' : x.current}(→${x.delta > 0 ? '+' : ''}${x.delta})`).join(' ');
    return {
      status: 'ok', dryRun: true,
      summary: `受付可能数 dry-run(${ymd}) 現在値: ${vals || slots.length + '枠'} / selector検証OK・設定押さず`,
      date: dateStr, slots: preview,
    };
  }

  // --- 本番: 集計欄表示 → 戻す → 各slot +/-(実クリック) → 設定 → 再読込で保存を検証 ---
  // ★実クリック(locator.click)にする理由: page.evaluate の el.click() は <p> 表示は
  //   更新するが、+/- の jQuery ハンドラ(tm_edit_surplus 更新)や 設定AJAX が完全に発火せず
  //   「設定成功に見えるが SB に保存されない」不具合があった(2026-07-14 郡山 15:30→4 が
  //   保存されず 3 のまま)。ユーザーと同じ実クリックにし、設定後は再読込して保存値を検証する。
  const keys = slots.map((s) => hhmm(s.slot_min));
  // 集計欄を表示(実クリック)。既に「隠す」状態=表示済みなら skip。
  //   evaluate click では AJAX の集計欄ロードが発火しないことがあった → 実クリック(isTrusted)にする。
  const revealTally = async () => {
    const hide = page.locator('text=集計欄を隠す').first();
    if ((await hide.count().catch(() => 0)) > 0 && (await hide.isVisible().catch(() => false))) return;
    const show = page.locator('text=集計欄を表示').first();
    if ((await show.count().catch(() => 0)) > 0) {
      await show.scrollIntoViewIfNeeded().catch(() => {});
      await show.click({ timeout: 5_000, force: true }).catch(() => {});
      await page.locator('text=残り受付可能数').first().waitFor({ state: 'attached', timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
    }
  };
  const readSlots = (ks) => page.evaluate((keys2) => {
    const out = {};
    for (const k of keys2) {
      const cell = document.getElementById('surplus_' + k);
      const cur = parseInt(((cell && cell.querySelector('p') || {}).textContent || '').trim(), 10);
      out[k] = Number.isFinite(cur) ? cur : null;
    }
    return out;
  }, ks).catch(() => ({}));

  // ★「残り受付可能数」ラベル(▼)をタップして +/- 編集モードを展開する。これが reveal の本体。
  //   ユーザ提供手順(2026-07-15)で確定: 集計欄を表示 だけでは +/- は display:none のまま。
  //   残り受付可能数 をタップすると +/- と 戻す/設定 が現れ編集モードに入り、実クリックが SB に登録される。
  let beforeVals = {};
  const surplusVisible = async () => (await page.locator('#surplus_' + keys[0] + ' a.mod_btn_08').isVisible().catch(() => false));
  const expandSurplusEdit = async () => {
    if (keys.length === 0) return false;
    if (await surplusVisible()) return true;
    // ★#limitSchedule の th 内 <a class="mod_btn_47 limitSeats">残り受付数</a> を実クリックすると
    //   隠れていた 戻す/設定(span.mod_separator_01) が現れ、各セルの +/-(mod_btn_08/09) が可視化される。
    const toggle = page.locator('#limitSchedule a.limitSeats, a.mod_btn_47.limitSeats, a.limitSeats').first();
    await toggle.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {}); // 初回はページ描画待ちで空振りしやすい
    for (let i = 0; i < 5; i++) {
      if ((await toggle.count().catch(() => 0)) > 0) {
        await toggle.scrollIntoViewIfNeeded().catch(() => {});
        await toggle.click({ timeout: 4_000, force: true }).catch(() => {});
      } else {
        await revealTally();
      }
      await page.waitForTimeout(700).catch(() => {});
      if (await surplusVisible()) return true;
    }
    return surplusVisible();
  };

  const applyOnce = async () => {
    await revealTally();
    await expandSurplusEdit();
    const resetBtn = page.locator('a.scheduleReset, a.mod_sch_reset').first();
    if ((await resetBtn.count().catch(() => 0)) > 0) {
      await resetBtn.scrollIntoViewIfNeeded().catch(() => {});
      await resetBtn.click({ timeout: 5_000, force: true }).catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
    }
    // 戻す後(=baseline)の値を記録。期待値 = baseline + delta。inPage/persisted がこれと一致しなければ
    // 「+/- が効いていない偽成功」or「未保存」として失敗にする。
    beforeVals = await readSlots(keys);
    // 編集モードで可視化された +/- を実クリック(isTrusted)。SB が変更を登録し 設定が保存POSTを出す。
    for (const s of slots) {
      const key = hhmm(s.slot_min);
      const btnCls = s.delta > 0 ? 'mod_btn_08' : 'mod_btn_09';
      const btnLoc = page.locator('#surplus_' + key + ' a.' + btnCls).first();
      await btnLoc.scrollIntoViewIfNeeded().catch(() => {});
      for (let i = 0; i < Math.abs(s.delta); i++) {
        const ok = await btnLoc.click({ timeout: 3_000 }).then(() => true).catch(() => false);
        if (!ok) await btnLoc.click({ timeout: 2_000, force: true }).catch(() => {});
        await page.waitForTimeout(160).catch(() => {});
      }
    }
    const inPage = await readSlots(keys);
    const saveBtn = page.locator('a.scheduleUpdate, a.mod_sch_update').first();
    if ((await saveBtn.count().catch(() => 0)) > 0) {
      await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
      const [saveResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /salonSchedule|schedule|surplus|receipt|Setting/i.test(r.url()), { timeout: 12_000 }).catch(() => null),
        saveBtn.click({ timeout: 5_000, force: true }).catch(() => {}),
      ]);
      if (saveResp) { try { lastSaveInfo = `${saveResp.status()} ${saveResp.url().replace('https://salonboard.com', '')}`; } catch (_e) { /* noop */ } }
      else lastSaveInfo = 'no-post-captured';
      await page.waitForTimeout(1_200).catch(() => {});
      for (const okSel of ['#confirmOK', '#dialogOK', '#dragDialog a.mod_btn_116', '#dragDialog a.mod_btn_118', 'a.mod_btn_07.scheduleUpdate']) {
        const ok = page.locator(okSel).first();
        if ((await ok.count().catch(() => 0)) > 0 && (await ok.isVisible().catch(() => false))) {
          await ok.click({ timeout: 4_000, force: true }).catch(() => {});
          await page.waitForTimeout(800).catch(() => {});
          break;
        }
      }
      await page.waitForTimeout(1_000).catch(() => {});
    }
    return inPage;
  };

  const reload = async () => {
    const u2 = new URL('/CLP/bt/schedule/salonSchedule/', baseUrl);
    u2.searchParams.set('date', ymd);
    await page.goto(u2.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForSelector('#limitSchedule', { timeout: 8_000 }).catch(() => {});
    await revealTally();
    return readSlots(keys);
  };
  // 期待値(戻す後 + delta)に保存後が達していなければ未達 → 再試行対象。
  const needsRetry = (pe) => slots.some((s) => {
    const k = hhmm(s.slot_min);
    const exp = beforeVals[k] != null ? beforeVals[k] + s.delta : null;
    return exp != null && pe[k] != null && pe[k] !== exp;
  });

  let inPage = await applyOnce();
  let persisted = await reload();
  if (needsRetry(persisted)) {
    // 1回だけ再試行 (一時的な保存失敗/展開失敗の救済)。
    inPage = await applyOnce();
    persisted = await reload();
  }

  const applied = slots.map((s) => {
    const k = hhmm(s.slot_min);
    const before = beforeVals[k] ?? null;
    const expected = before != null ? before + s.delta : null;
    return { hhmm: k, delta: s.delta, before, expected, inPage: inPage[k] ?? null, persisted: persisted[k] ?? null };
  });
  // 失敗: 保存後(persisted)が 期待値(戻す後 + delta)と一致しない。
  //   → 「+/-が効かず偽成功」も「未保存」もここで検出する(persisted==before の場合を含む)。
  const notPersisted = applied.filter((a) => a.expected != null && a.persisted != null && a.persisted !== a.expected);
  const summary = `受付可能数 ${notPersisted.length ? '⚠未保存' : '設定'}(${ymd}): ${applied.map((a) => `${fmtHH(a.hhmm)}→${a.persisted == null ? '?' : a.persisted}(${a.delta > 0 ? '+' : ''}${a.delta})`).join(' ') || '0枠'}`;
  if (notPersisted.length) {
    const b = notPersisted[0];
    return { status: 'failed', reason: `設定がSBに保存されませんでした (例 ${fmtHH(b.hhmm)}: 戻す後${b.before}+(${b.delta})=期待${b.expected}→保存後${b.persisted})`, errorCode: 'ACCEPTANCE_NOT_PERSISTED', manualRequired: true, summary, date: dateStr, applied, debug: { dialogMsgs, lastSaveInfo } };
  }
  return { status: 'ok', summary, date: dateStr, applied, debug: { dialogMsgs, lastSaveInfo } };
}

module.exports = {
  scrapeBookings,
  scrapeStaff,
  scrapeSalonInfo,
  scrapeEquipment,
  scrapeMenus,
  scrapeCoupons,
  scrapeBlogs,
  scrapeReviews,
  scrapeShifts,
  scrapeCustomerDetails,
  pushBookingViaForm,
  pushScheduleViaForm,
  changeScheduleViaForm,
  deleteScheduleViaForm,
  pushShiftsViaForm,
  pushWorkPatternViaForm,
  pushStaffProfileViaForm,
  scrapeShiftPatterns,
  cancelBookingViaForm,
  changeBookingViaForm,
  postBlogViaForm,
  deleteBlogViaForm,
  postReviewReplyViaForm,
  postPhotoGalleryViaForm,
  pushEquipmentViaForm,
  pushStaffViaForm,
  pushMenuViaForm,
  pushCouponViaForm,
  scrapePhotoGallery,
  // エラー画面スクショ (失敗地点のバッファ) を worker-process が Slack 送信に使う
  scrapeKodawari,
  scrapeFeature,
  pushSalonProfileViaForm,
  pushKodawariViaForm,
  pushFeatureViaForm,
  pushAcceptanceViaSchedule,
  getLastErrorShot,
  getLastErrorShotForPage,
  resetLastErrorShot,
  captureScrapeDebug,
  findReserveIdForBooking,
  ensureSalonSelected,
  // テスト用にエクスポート
  _internal: {
    parseJstDateTime,
    parseJstDate,
    parseYen,
    parseMinutes,
    extractCustomerCode,
    mapBookingStatus,
    cleanPhone,
    extractBookingItemsFromCurrentPage,
  },
};
