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
async function captureScrapeDebug(page, channel, label, opts = {}) {
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
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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

  for (let i = 0; i < MAX_DAYS; i++) {
    const ymd = dates[i];
    let schedUrl;
    try {
      const u = new URL('/CLP/bt/schedule/salonSchedule/', baseUrl);
      u.searchParams.set('date', ymd);
      schedUrl = u.toString();
    } catch (_e) {
      schedUrl = `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=${ymd}`;
    }
    try {
      await page.goto(schedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // networkidle は SalonBoard の常時稼働するトラッキング script のため
      // ほぼ毎回 12s 全部待ってしまい、1日めくるのに 5〜10s かかる原因だった。
      // スケジュールはサーバーレンダリング(初期HTMLに #scheduleItemArea / 予約ブロックが
      // 入っている)なので、networkidle は待たず「スケジュール領域 or 予約ブロックの出現」
      // だけを最大 3.5s 待つ。出現したら即抽出に進む。
      await page.waitForSelector(
        '#scheduleItemArea, #stylistScheduleArea, div.panel_reserve[id^="reserve_item_"], div.mod_btn_22[id^="stylist_"]',
        { timeout: 3_500 },
      ).catch(() => {});
    } catch (_e) {
      diag.push(`hair: ${ymd} goto失敗`);
      continue;
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
        out.push({
          external_id: id,
          customer: (rv.querySelector('.reserveItemCustomer')?.textContent || '').replace(/\s*様\s*$/, '').trim(),
          stylist_id: stylistId,
          stylist_name: nameById[stylistId] || null,
          date: get('panel_reserve_date'),
          start: get('panel_reserve_start'),
          registered: get('panel_reserve_registeredFlg'),
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
        duration_min: null, // スケジュールの colspan から将来推定可
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

    // 日付めくりの間隔を一定にしない (人手の操作に近づける/BAN回避)。
    // ユーザー要望でテンポを上げる: 0.3〜1.2秒(中央 約0.7秒)。三角分布気味で
    // 値が揃いすぎないようにする。最終日(これ以上めくらない)は待たない。
    if (i < MAX_DAYS - 1) {
      const r = (Math.random() + Math.random()) / 2; // 0..1, 0.5中心
      const waitMs = Math.round(300 + r * 900); // 300〜1200ms
      await page.waitForTimeout(waitMs).catch(() => {});
    }
  }

  return {
    rows: allRows,
    debug: {
      itemsFound: allRows.length,
      genre: 'hair',
      source: 'salonSchedule',
      range: `${range.fromStr} 〜 ${range.toStr}`,
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
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
  const range = defaultBookingDateRange(months);
  const diag = [];

  // 美容室(hair)はスケジュール画面 (/CLP/bt/schedule/salonSchedule/) から取得する。
  // エステ用の予約一覧フロー(reserveList navigation/検索/抽出)は通さない。
  if (opts.genre === 'hair') {
    try {
      return await scrapeHairBookings(page, { range, diag, baseUrl: opts.baseUrl });
    } catch (e) {
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
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
    diag.push(`duration補正: ${durationFixed} 件`);
  } catch (e) {
    diag.push(`duration補正 失敗: ${e?.message ?? e}`);
  }

  return {
    rows,
    debug: {
      itemsFound: allItems.length,
      parsed: rows.length,
      skipped,
      sampleSkipped,
      durationFixed,
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
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

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

async function scrapeCoupons(page) {
  await page.goto(COUPON_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
      if (!page.url().includes('/CNK/draft/couponList')) {
        await page.goto(COUPON_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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

/**
 * 登録/挿入した予約の SalonBoard 予約ID(reserveId) を予約一覧(reserveList)から特定する。
 * 完了画面から reserveId を拾えなかったときのフォールバック。
 * 予約一覧の各行は detail リンクに reserveId= を持つので、日付フィルタ→
 * (同開始時刻 + 同スタッフ external_id) [+ 顧客名] で一意に決まる行の reserveId を返す。
 *
 * 引数 target: { yyyymmdd, hhmm, staffExt, customerName }
 * 戻り値: reserveId(string) | null
 */
async function findReserveIdForBooking(page, target, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  try {
    await page.goto(RESERVE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    // 対象日に絞って検索 (その日だけ)
    const y = target.yyyymmdd;
    const fromStr = `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
    await applyBookingDateFilter(page, { fromStr, toStr: fromStr }, {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const items = await extractBookingItemsFromCurrentPage(page);
    const wantStaff = (target.staffExt || '').toUpperCase();
    const wantCust = (target.customerName || '').replace(/\s*様$/, '').trim();
    const cands = [];
    for (const it of items) {
      const reserveId = extractIdFromUrl(it.link_href, 'reservationId', 'reserveId', 'rsvId');
      if (!reserveId) continue;
      // 開始時刻 (datetime_raw に HH:MM が含まれる)
      const tm = (it.datetime_raw || '').match(/(\d{1,2}):(\d{2})/);
      const hhmm = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;
      if (target.hhmm && hhmm !== target.hhmm) continue;
      // スタッフ external_id (行から拾えた場合)
      if (wantStaff && it.staff_external_id && it.staff_external_id.toUpperCase() !== wantStaff) continue;
      cands.push({ reserveId, customer: (it.customer_raw || '').replace(/\s*様$/, '').trim() });
    }
    if (cands.length === 1) return cands[0].reserveId;
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
    await page.goto(schedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('#rlastupdate', { timeout: 12_000 }).catch(() => {});
    rlastupdate = (await page.locator('#rlastupdate').first().textContent().catch(() => ''))?.trim() || '';
  } catch (e) {
    return fail(`予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }

  // (2) 予約登録フォームを開く (予約と同じ URL + パラメータ)。
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
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA on register form', 'RECAPTCHA_REQUIRED', true);
  }

  // (3) 「予定を登録する」ボタン(a#fnc_schedule)を押して予定登録画面へ遷移。
  const schedBtn = page.locator('a#fnc_schedule').first();
  if ((await schedBtn.count().catch(() => 0)) === 0) {
    return fail('「予定を登録する」ボタンが見つかりません (予約登録画面に到達できていない可能性)', 'CONFIRMATION_MISMATCH', true);
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
    await registerBtn.click({ timeout: 15_000 }).catch(() => {});
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
  const doneText = await page.locator('text=/登録しました|完了しました|スケジュール/').count().catch(() => 0);
  const looksDone = !stillOnForm || doneText > 0 || afterUrl !== beforeUrl;
  if (!looksDone) {
    return fail(`予定の登録完了を確認できませんでした (dialog=${dialogAccepted}, url=${afterUrl})`, 'UNKNOWN_ERROR', true);
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
  const staffExt = String(p.salonboard_staff_external_id || '').toUpperCase() || null;

  // スケジュール画面上で対象の予定ブロックを探す共通ロジック。
  // mark=true なら見つかった要素に data-kireidot-del 属性を付ける。
  const findTodo = (mark) => page.evaluate(
    ({ staffExt, startMin, title, mark }) => {
      const heads = Array.from(document.querySelectorAll('.scheduleMainHead[id^="STAFF_"]')).map((el) => {
        const m = (el.id || '').match(/^STAFF_([A-Z0-9]+)_/i);
        return m ? m[1].toUpperCase() : null;
      });
      const staffTable = document.querySelector('.jscScheduleMainTableStaff');
      if (!staffTable) return { error: 'no_staff_table' };
      const staffColFound = !staffExt || heads.includes(staffExt);
      const lines = Array.from(staffTable.querySelectorAll('.scheduleMainTableLine'));
      const items = [];
      lines.forEach((line, i) => {
        if (staffExt && heads[i] !== staffExt) return;
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
        return { ok: true, matched: 1, staffColFound, title: cands[0].title, start: cands[0].start, end: cands[0].end };
      }
      return { ok: false, matched: cands.length, staffColFound, total: items.length };
    },
    { staffExt, startMin, title, mark: !!mark },
  );

  // (1) スケジュール画面を開く
  try {
    const u = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    u.searchParams.set('date', when.yyyymmdd);
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('.jscScheduleMainTableStaff', { timeout: 15_000 });
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

  // (3) 予定ブロックをクリック → ポップアップの「予定変更」をクリック
  const target = page.locator('.jscScheduleToDo[data-kireidot-del="1"]').first();
  try {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 10_000 });
  } catch (e) {
    return fail(`予定ブロックをクリックできませんでした: ${e?.message ?? e}`, 'UNKNOWN_ERROR', true);
  }
  const changeBtn = page.locator('.mod_popup_02.js_yotei a:has-text("予定変更")').first();
  await changeBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if ((await changeBtn.count().catch(() => 0)) === 0) {
    return fail('予定ポップアップの「予定変更」ボタンが見つかりません', 'CONFIRMATION_MISMATCH', true);
  }
  try {
    await Promise.all([
      page.waitForSelector('form#scheduleChange, a#delete', { timeout: 15_000 }).catch(() => {}),
      changeBtn.click({ timeout: 10_000 }),
    ]);
  } catch (_e) { /* 下で到達検証 */ }
  await page.waitForSelector('form#scheduleChange', { timeout: 10_000 }).catch(() => {});
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
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  try {
    await delBtn.click({ timeout: 12_000 }).catch(() => {});
    // ページ内HTMLダイアログ (「はい」.accept) が出る場合に備える
    const yesBtn = page.locator('a.accept:visible, .buttons a.accept').first();
    await yesBtn.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => {});
    if ((await yesBtn.count().catch(() => 0)) > 0) {
      await yesBtn.click({ timeout: 8_000 }).catch(() => {});
    }
    // 完了サイン (フォーム離脱 / 完了文言 / エラー領域) を最大15秒ポーリング
    const deadline = Date.now() + 15_000;
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

  // (6) スケジュール画面に戻って予定が消えたことを検証
  try {
    const u2 = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    u2.searchParams.set('date', when.yyyymmdd);
    await page.goto(u2.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('.jscScheduleMainTableStaff', { timeout: 12_000 });
    const still = await findTodo(false).catch(() => null);
    if (still && still.ok) {
      return fail(`削除操作後もスケジュール上に予定が残っています (dialog=${nativeDialogAccepted})。SalonBoard で確認してください。`, 'UNKNOWN_ERROR', true);
    }
  } catch (_e) {
    // 検証用の再読込に失敗しただけなら、(5) の完了サインを信用して成功扱い。
  }

  return { status: 'ok', externalId: null };
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
async function scrapeShiftPatterns(page, baseUrl) {
  const base = baseUrl || 'https://salonboard.com/';
  // 勤務パターンは「勤務パターン登録」画面 (/KLP/set/workPatternSetup/) の
  // 登録済み一覧テーブルから取得する。これはシフト設定(毎月の受付設定)の完了に
  // 依存しないので、未設定の月でも取得できる。
  //   実DOM (確認済み 2026-06-12):
  //     登録済みテーブル: #openTimeArea table の各行 (tr)
  //       td[0]=シフト名称, td[1]=短縮名, td[2]=設定時間(span 開始 / span 終了),
  //       削除チェックボックス input[name=deleteShiftIds][value=S…] (=external_id)
  const diag = { tried: [] };
  const isReached = async () =>
    (await page.locator('#workPatternSetup, #openTimeArea, input[name="deleteShiftIds"]').count().catch(() => 0)) > 0;

  // (1) 直接 goto を複数プレフィックスで試す (店舗ジャンルで KLP/CNK が異なる)。
  for (const path of ['/KLP/set/workPatternSetup/', '/CNK/set/workPatternSetup/', '/CNB/set/workPatternSetup/']) {
    try {
      await page.goto(new URL(path, base).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
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
    for (const staffPath of ['/CNK/set/staffSetup/', '/KLP/set/staffSetup/', '/CNB/set/staffSetup/']) {
      try {
        await page.goto(new URL(staffPath, base).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
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

  // (1) シフト設定ページを開く (直接 goto。失敗時は monthlySetup のリンク経由)
  const openSetup = async () => {
    const u = new URL('/KLP/set/shiftSetup/', baseUrl);
    u.searchParams.set('date', month);
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('#shiftSchedule a.shiftdate', { timeout: 12_000 }).catch(() => {});
    if ((await page.locator('#shiftSchedule a.shiftdate').count().catch(() => 0)) > 0) return true;
    // フォールバック: 毎月の受付設定からリンクをクリック
    await page.goto(new URL('/KLP/set/monthlySetup/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    const link = page.locator(`a[href*="shiftSetup/?date=${month}"]`).first();
    if ((await link.count().catch(() => 0)) === 0) return false;
    await Promise.all([
      page.waitForSelector('#shiftSchedule a.shiftdate', { timeout: 15_000 }).catch(() => {}),
      link.click({ timeout: 10_000 }).catch(() => {}),
    ]);
    return (await page.locator('#shiftSchedule a.shiftdate').count().catch(() => 0)) > 0;
  };
  try {
    if (!(await openSetup())) {
      return fail(`シフト設定画面 (shiftSetup ${month}) を開けませんでした。「毎月の受付設定」でこの月が設定済みか確認してください。`, 'UNKNOWN_ERROR', true);
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

  // (3) 一括入力パネルを開いて勤務パターン一覧 (id/name/時間帯) を取得
  const ensureBatchPanel = async () => {
    const panel = page.locator('#batchSetPanel');
    if (await panel.isVisible().catch(() => false)) return true;
    await page.locator('#batchSetLabel').click({ timeout: 8_000 }).catch(() => {});
    await panel.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    return await panel.isVisible().catch(() => false);
  };
  if (!(await ensureBatchPanel())) {
    return fail('一括入力パネル (#batchSetPanel) を開けませんでした', 'UNKNOWN_ERROR', true);
  }
  let patterns = await page.evaluate(() => {
    const sel = document.querySelector('#shiftIdBatch');
    if (!sel) return null;
    return Array.from(sel.options)
      .filter((o) => o.value)
      .map((o) => ({ id: o.value, name: (o.textContent || '').trim() }));
  }).catch(() => null);
  if (!patterns || patterns.length === 0) {
    return fail('勤務パターン一覧 (select#shiftIdBatch) を取得できませんでした', 'UNKNOWN_ERROR', true);
  }
  for (const pat of patterns) {
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
  const timedPatterns = patterns.filter((x) => x.start && x.end);
  // DB保存用 (worker-process が salonboard_bulk_upsert_shift_patterns へ upsert する)
  const patternsOut = patterns.map((x) => ({
    external_id: x.id,
    name: x.name,
    start_time: x.start ?? '',
    end_time: x.end ?? '',
  }));
  const patternById = new Map(patterns.map((x) => [String(x.id), x]));

  const warnings = [];
  const cellMatchesPattern = (text, pat) => {
    const t = String(text || '').trim();
    if (!t || t === '休') return false;
    const n = String(pat?.name || '').trim();
    return !!n && (t === n || n.startsWith(t) || t.startsWith(n));
  };
  // 予定方式のベースパターン: シフト時間帯を「包含する」最小スパンのパターン。
  // 包含するものが無ければ最大スパン (warning)。
  const chooseBasePattern = (start, end) => {
    const s = toMin(start); const e = toMin(end);
    if (s == null || e == null || timedPatterns.length === 0) return null;
    const covering = timedPatterns.filter((x) => toMin(x.start) <= s && toMin(x.end) >= e);
    if (covering.length > 0) {
      covering.sort((a, b) => (toMin(a.end) - toMin(a.start)) - (toMin(b.end) - toMin(b.start)));
      return { pattern: covering[0], covers: true };
    }
    const sorted = [...timedPatterns].sort((a, b) => (toMin(b.end) - toMin(b.start)) - (toMin(a.end) - toMin(a.start)));
    return { pattern: sorted[0], covers: false };
  };

  // (4) 差分計画を立てる。
  //   - day.sb_pattern_id (KIREIDOTシフトパターン紐付けで解決済みのSBパターン) が
  //     あればそのパターンで一括入力 (パターンの自動代用はしない)。
  //   - 紐付けが無い時間帯は「予定方式」: 出勤+ベースパターン+予定(時間外ブロック)
  //     を日別モーダル (予定を追加する) で設定する。
  const plans = []; // 一括入力: {staffExt, kind:'off'|'work', patternId|null, patternName, days:['01',...], dates}
  const customPlans = []; // 予定方式: {staffExt, staffName, date, ymd, start, end, base}
  let skipped = 0; let totalChanges = 0;
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
        const mapped = day.sb_pattern_id ? patternById.get(String(day.sb_pattern_id)) : null;
        if (mapped) {
          // 紐付け済みパターンで一括入力
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
            warnings.push(`${entry.staff_name ?? ext} ${date}: ${day.start}〜${day.end} を包含するパターンが無いため「${base.pattern.name}」(${base.pattern.start}〜${base.pattern.end})内で予定設定`);
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

  if (totalChanges === 0) {
    return { status: 'ok', summary: `変更なし (全${entries.length}名のシフトはSalonBoardと一致)`, changed: 0, warnings, patterns: patternsOut };
  }
  if (!enablePush) {
    return {
      status: 'confirm_only',
      summary: `反映予定 ${totalChanges}件 (パターン一括${totalChanges - customPlans.length}/予定方式${customPlans.length}, スタッフ${staffChanged.size}名, スキップ${skipped}件)`,
      changed: totalChanges,
      warnings,
      patterns: patternsOut,
    };
  }

  // (5) 一括入力で反映 (5日ずつ)
  const applyChunk = async (plan, chunkDays, firstYmd, expectText) => {
    if (!(await ensureBatchPanel())) throw new Error('一括入力パネルを開けません');
    // スタッフ選択 (対象のみON)
    const boxes = page.locator('input[name="staffIdList"]');
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

  // (7) 最終検証: ページを開き直して、変更対象の日が期待値になっているか確認
  let mismatches = 0;
  try {
    if (await openSetup()) {
      const after = await readCells();
      for (const plan of plans) {
        for (const ymdDay of plan.days) {
          const t = (after[`${plan.staffExt}_${month}${ymdDay}`] || '').trim();
          const ok = plan.kind === 'off' ? t === '休' : cellMatchesPattern(t, { name: plan.patternName });
          if (!ok) mismatches++;
        }
      }
      // 予定方式の日: セルにはベースパターン名が表示される想定
      for (const cp of customPlans) {
        const t = (after[`${cp.staffExt}_${cp.ymd}`] || '').trim();
        if (!cellMatchesPattern(t, { name: cp.base.name })) mismatches++;
      }
    }
  } catch (_e) { /* 検証用の再読込失敗は黙認 (確定エラーは上で検出済み) */ }
  if (mismatches > 0) {
    return fail(`シフト反映後の検証で ${mismatches}/${totalChanges} 件が期待値と一致しません。SalonBoardのシフト設定を確認してください。`, 'UNKNOWN_ERROR', true);
  }

  return {
    status: 'ok',
    summary: `シフト反映 ${totalChanges}件 (パターン一括${totalChanges - customPlans.length}/予定方式${customPlans.length}, スタッフ${staffChanged.size}名, スキップ${skipped}件${nativeDialogAccepted ? ', confirm承認' : ''})`,
    changed: totalChanges,
    warnings,
    patterns: patternsOut,
  };
}

async function pushBookingViaForm(page, payload, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://salonboard.com/';
  const enablePush = !!opts.enablePush;
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({
    status: 'failed',
    reason,
    errorCode,
    manualRequired,
  });

  if (!p.booking_id || !p.scheduled_at) {
    return fail('payload missing booking_id or scheduled_at', 'UNKNOWN_ERROR', true);
  }
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  if (!p.salonboard_staff_external_id) {
    return fail('SalonBoard スタッフ external_id が未指定です', 'STAFF_MAPPING_NOT_FOUND', true);
  }
  // メニューは任意。SalonBoard 予約フォームの netCouponId は未選択(-)でも登録可能。
  // 指定があれば選び、無ければスキップする (まずメニュー無しで予約を通す方針)。
  const menuTarget = p.salonboard_menu_name || p.menu_name || p.coupon_name || null;
  const kireidotRef = p.kireidot_ref || `KIREIDOT予約ID: ${p.booking_id}`;

  const startHH = String(when.hour).padStart(2, '0');
  const startMM = String(when.minute).padStart(2, '0');

  // --- 二重登録防止プリフライト (§6.4) ---
  // payload.preflight_required (孤児再enqueue / 手動リトライ時に Admin が付与) の場合のみ、
  // 登録フォームを開く前に予約一覧を再照合する。既に同予約が存在すれば登録せず
  // 「既登録」として成功を返す (= 再試行による二重登録を防ぐ)。
  // 通常の新規 push では走らないので速度に影響しない。
  if (p.preflight_required) {
    const existing = await findReserveIdForBooking(page, {
      yyyymmdd: when.yyyymmdd,
      hhmm: when.hhmm,
      staffExt: p.salonboard_staff_external_id,
      customerName: p.customer_name,
    }, { baseUrl }).catch(() => null);
    if (existing) {
      return {
        status: 'ok',
        externalId: existing,
        detailUrl: `${baseUrl.replace(/\/$/, '')}/KLP/reserve/ext/extReserveDetail/?reserveId=${existing}`,
        confirmed: {
          confirmed_customer_name: p.customer_name ?? null,
          confirmed_staff_name: p.staff_name ?? null,
          confirmed_menu_name: menuTarget,
          confirmed_scheduled_at: p.scheduled_at,
        },
        alreadyExists: true,
      };
    }
  }

  // --- 重要 ---
  // 登録フォームは rlastupdate (スケジュール画面に埋め込まれたタイムスタンプ) を
  // 付けないと "情報が一部失われています (KPCL017V01)" エラーになる。
  // よって (1) 対象日のスケジュール画面を開き #rlastupdate を取得 →
  //         (2) それを付けて登録フォームを開く。
  let rlastupdate = '';
  try {
    const schedUrl = new URL('/KLP/schedule/salonSchedule/', baseUrl);
    schedUrl.searchParams.set('date', when.yyyymmdd);
    await page.goto(schedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    // ★高速化: networkidle(広告ビーコン等でなかなか来ない)を待たず、必要な
    //   #rlastupdate が出現したら即取得する。
    await page.waitForSelector('#rlastupdate', { timeout: 12_000 }).catch(() => {});
    rlastupdate = (await page
      .locator('#rlastupdate')
      .first()
      .textContent()
      .catch(() => ''))?.trim() || '';
  } catch (e) {
    return fail(`予約スケジュールを開けません: ${e?.message ?? e}`, 'UNKNOWN_ERROR', false);
  }

  // 登録フォームを URL で開く (rlastupdate を付与)
  const u = new URL('/KLP/reserve/ext/extReserveRegist/', baseUrl);
  u.searchParams.set('staffId', p.salonboard_staff_external_id);
  u.searchParams.set('date', when.yyyymmdd);
  u.searchParams.set('rsvHour', startHH);
  u.searchParams.set('rsvMinute', startMM);
  if (rlastupdate) u.searchParams.set('rlastupdate', rlastupdate);
  try {
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    // ★高速化(要望対応): networkidle(SalonBoardは常時通信で40秒近く待つことがある)を
    //   待たず、入力に必要なフォーム要素が出た時点で即進む。広告/計測の通信完了は待たない。
    await page.waitForSelector(
      'form#extReserveRegist, #regist, textarea#rsvEtc, select#jsiRsvHour',
      { timeout: 15_000 },
    ).catch(() => {});
  } catch (e) {
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
    return fail(
      `予約登録フォームに到達できませんでした (rlastupdate=${rlastupdate || 'なし'})。url=${diag.url} title="${diag.title}" forms=[${(diag.forms || []).join(',')}] body="${diag.body}"`,
      'CONFIRMATION_MISMATCH',
      true,
    );
  }

  // スタッフ指定。フォームには
  //   - 表示用セレクト select#salonStaffList (value=external_id)
  //   - 実際に送信される hidden input#staffId (value=external_id)
  //   - staffIdList (担当割当)
  // があり、これらを揃えないと「どのスタッフを選んでも URL/既定のスタッフに入る」
  // という不整合が起きる。external_id で select を選び、change を発火させ、
  // さらに hidden staffId / staffIdList も明示的に同じ値へ更新する。
  const staffExt = p.salonboard_staff_external_id;
  const staffSel = page.locator('select#salonStaffList').first();
  if ((await staffSel.count().catch(() => 0)) > 0) {
    await staffSel.selectOption({ value: staffExt }).catch(async () => {
      if (p.staff_name) await staffSel.selectOption({ label: p.staff_name }).catch(() => {});
    });
  }
  // hidden / 関連 select を JS で強制的に揃える + change を発火 (SB 側ハンドラ対策)。
  await page.evaluate((ext) => {
    const setVal = (el, v) => {
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // hidden staffId
    setVal(document.getElementById('staffId'), ext);
    document.querySelectorAll('input[name="staffId"]').forEach((el) => setVal(el, ext));
    // salonStaffList / staffIdList セレクトも option が一致すれば選ぶ
    for (const name of ['salonStaffList', 'staffIdList']) {
      const sel = document.querySelector(`select[name="${name}"]`);
      if (sel && Array.from(sel.options).some((o) => o.value === ext)) setVal(sel, ext);
    }
  }, staffExt).catch(() => {});
  // 開始 時/分。change を発火して SalonBoard 側の終了時間再計算ハンドラを起こす。
  await page.locator('select#jsiRsvHour').first().selectOption({ value: String(when.hour) }).catch(() => {});
  await page.locator('select#jsiRsvMinute').first().selectOption({ value: startMM }).catch(() => {});
  // 所要 (rsvTermHour の value は分換算: value="60"=1時間, "0"=0時間)。
  // duration_min を厳密に反映する。null のときだけ 60 にフォールバック。
  const durMin = (p.duration_min != null && Number.isFinite(Number(p.duration_min)))
    ? Number(p.duration_min)
    : 60;
  const termHourVal = String(Math.floor(durMin / 60) * 60); // 例: 30→"0", 90→"60"
  const termMinVal = String(durMin % 60).padStart(2, '0');   // 例: 30→"30", 90→"30"
  // ★重要: SalonBoard は開始時刻/所要の各 select で終了時間を自動再計算する。
  //   selectOption だけだと内部状態が更新されず「既定の1時間」のまま登録される
  //   ことがある(30分→1時間になる症状)。time/term の全 select を JS で直接
  //   セットし、それぞれ change を発火して widget に確実に反映させる。
  await page.evaluate(
    ({ hh, mm, th, tm }) => {
      const setSel = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const has = Array.from(el.options).some((o) => o.value === val);
        if (!has) return false;
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
  // 反映確認 → ズレていたら Playwright の selectOption でもう一度。
  await page.waitForTimeout(300);
  const termOk = await page.evaluate(({ th, tm }) => {
    const h = document.getElementById('jsiRsvTermHour');
    const m = document.getElementById('jsiRsvTermMinute');
    return !!h && !!m && h.value === th && m.value === tm;
  }, { th: termHourVal, tm: termMinVal }).catch(() => false);
  if (!termOk) {
    await page.locator('select#jsiRsvTermHour').first().selectOption({ value: termHourVal }).catch(() => {});
    await page.locator('select#jsiRsvTermMinute').first().selectOption({ value: termMinVal }).catch(() => {});
  }

  // メニュー = ネット予約クーポン (任意)。menuTarget があれば label 完全一致 →
  // 部分一致で選ぶ。見つからなくても予約自体は続行する (メニュー無しで登録)。
  if (menuTarget) {
    const menuSel = page.locator("select[name='netCouponId']").first();
    if ((await menuSel.count().catch(() => 0)) > 0) {
      let menuFilled = false;
      await menuSel.selectOption({ label: menuTarget }).then(() => { menuFilled = true; }).catch(() => {});
      if (!menuFilled) {
        const val = await menuSel.evaluate((el, target) => {
          const opt = Array.from(el.options).find((o) => (o.textContent || '').includes(target));
          return opt ? opt.value : null;
        }, menuTarget).catch(() => null);
        if (val) await menuSel.selectOption({ value: val }).catch(() => {});
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

    const rawName = (p.customer_name && String(p.customer_name).trim()) || 'ゲスト';
    const cleaned = cleanName(rawName) || 'ゲスト';
    const parts = cleaned.split(/[\s　]+/).filter(Boolean);
    const sei = parts[0] || cleaned || 'ゲスト';
    const mei = parts.slice(1).join('') || '様';
    // カナ: 元名のカナ部分が取れればそれ、無ければ汎用カナ
    const seiKana = cleanKana(sei) || 'ヨヤク';
    const meiKana = cleanKana(mei) || 'キャクサマ';

    await page.locator('input#nmSei').first().fill(sei, { timeout: 6_000 }).catch(() => {});
    await page.locator('input#nmMei').first().fill(mei, { timeout: 6_000 }).catch(() => {});
    // カナ (必須)
    await page.locator('input#nmSeiKana').first().fill(seiKana, { timeout: 6_000 }).catch(() => {});
    await page.locator('input#nmMeiKana').first().fill(meiKana, { timeout: 6_000 }).catch(() => {});
  }
  if (p.customer_phone) {
    // 電話はハイフン無し数字のみ (SB の注意書きに従う)
    const tel = String(p.customer_phone).replace(/[^\d]/g, '');
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
  //     3) 「ベッド」を含む option (従来のフォールバック)
  //   予約登録フォームに設備セクション (#equipArea / select[name="equipIdList"]) があれば、
  //   設備行が無ければ「追加する」(#equipAdd) を押してから選ぶ。
  //   セクションが存在しないフォーム構成でも壊れないよう全工程を try で保護し、
  //   失敗しても予約登録は続行する (設備は必須でない店舗もあるため)。
  const wantedEquipExtId = (p.salonboard_equipment_external_id || '').trim() || null; // EQ...
  const wantedEquipName = (p.salonboard_equipment_name || '').trim() || null;
  let equipResult = 'なし'; // 'EQ指定' / 'name一致' / 'ベッド設定' / '既存維持' / 'option無し' / 'なし' / 'エラー'
  try {
    // 新規予約フォーム(booking_create)の #equipArea は既定で設備行が無く、
    // 「追加する」(#equipAdd) を押すと equipIdList セレクトを持つ行が生成される。
    const equipSelector = 'select[name="equipIdList"], #equipArea select.equipIdList, #equipArea select';
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
      let setBy = null; // 'EQ' / 'name' / 'bed'
      let setCount = 0;
      let keptCount = 0;
      let noOption = false;
      for (let i = 0; i < n; i++) {
        const sel = equipSelects.nth(i);
        // option を value(EQ...) と表示名で評価し、希望に最も合う value を選ぶ。
        const pick = await sel.evaluate(
          (el, args) => {
            const { wantId, wantName } = args;
            const opts = Array.from(el.options);
            const norm = (s) => (s || '').replace(/[○×\s]/g, '');
            // 1) EQ完全一致
            if (wantId) {
              const o = opts.find((o) => o.value === wantId);
              if (o) return { value: o.value, by: 'EQ' };
            }
            // 2) 設備名一致
            if (wantName) {
              const o = opts.find((o) => norm(o.textContent) === norm(wantName));
              if (o) return { value: o.value, by: 'name' };
            }
            return null;
          },
          { wantId: wantedEquipExtId, wantName: wantedEquipName },
        ).catch(() => null);

        if (pick && pick.value) {
          await sel.selectOption({ value: pick.value }).catch(() => {});
          await sel.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
          setBy = pick.by;
          setCount++;
          continue;
        }

        // payload 指定が解決できない場合: 空行のみ「ベッド」を入れる従来動作
        const needsSet = await sel.evaluate((el) => {
          const cur = el.options[el.selectedIndex];
          const curText = (cur?.textContent || '').replace(/[○×\s]/g, '');
          return !el.value || curText === '';
        }).catch(() => false);
        if (!needsSet) { keptCount++; continue; }
        const bedVal = await sel.evaluate((el) => {
          const opt = Array.from(el.options).find((o) => (o.textContent || '').includes('ベッド'));
          return opt ? opt.value : null;
        }).catch(() => null);
        if (bedVal) {
          await sel.selectOption({ value: bedVal }).catch(() => {});
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
    }
  } catch (_e) {
    equipResult = 'エラー';
  }

  // ※ 旧実装はここで body 全文を /空いて|重複/ 等で検索していたが、フォームの
  //    説明文 (例「空いている時間を選択」) に誤反応して、実際は空いていても
  //    SLOT_NOT_AVAILABLE になっていた。空き枠/重複の本当のエラーは「登録する」
  //    送信後にエラー領域に出るので、ここでの事前チェックは廃止する。

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
  try {
    await registerBtn.click({ timeout: 15_000 }).catch(() => {});
    // 1回目送信後を最大15秒ポーリング: doComplete(2段階確認ページ) / 一覧遷移(=容量余裕で即完了) /
    // 完了文言・詳細リンク のいずれかが出たら抜ける。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
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
      const needsFinal = await page.evaluate(() => {
        const t = ((document.body && document.body.innerText) || '').replace(/\s+/g, '');
        return /まだ登録されていません|問題なければ.{0,6}登録/.test(t);
      }).catch(() => false);
      if (!needsFinal) break;
      const finalBtn = page.locator('a#regist').first();
      if ((await finalBtn.count().catch(() => 0)) === 0) break;
      await finalBtn.click({ timeout: 10_000 }).catch(() => {});
      finalConfirmClicked = true;
      const dl2 = Date.now() + 12_000;
      while (Date.now() < dl2) {
        await page.waitForTimeout(400);
        const stillConfirm = await page
          .evaluate(() => /まだ登録されていません/.test(((document.body && document.body.innerText) || '')))
          .catch(() => false);
        if (!stillConfirm) break;
      }
    }
  } finally {
    page.off('dialog', onDialog);
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
      }));
      console.log('[push][diag] POST-SUBMIT PAGE:', JSON.stringify(dc).slice(0, 1500));
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
    return fail(
      '登録の最終確認 (doComplete「まだ登録されていません」) を確定できませんでした (容量超過/設備不足の可能性)。',
      'UNKNOWN_ERROR',
      true,
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
      const recovered = await findReserveIdForBooking(page, {
        yyyymmdd: when.yyyymmdd,
        hhmm: when.hhmm,
        staffExt: p.salonboard_staff_external_id,
        customerName: p.customer_name,
      }, { baseUrl }).catch(() => null);
      if (recovered) {
        return {
          status: 'ok',
          externalId: recovered,
          detailUrl: `${baseUrl.replace(/\/$/, '')}/KLP/reserve/ext/extReserveDetail/?reserveId=${recovered}`,
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
    const found = await findReserveIdForBooking(page, {
      yyyymmdd: when.yyyymmdd,
      hhmm: when.hhmm,
      staffExt: p.salonboard_staff_external_id,
      customerName: p.customer_name,
    }, { baseUrl }).catch(() => null);
    if (found) {
      externalId = found;
      detailUrl = detailUrl || `${baseUrl.replace(/\/$/, '')}/KLP/reserve/ext/extReserveDetail/?reserveId=${found}`;
    }
  }

  return { status: 'ok', externalId, detailUrl, confirmed };
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
  const enableCancel = opts.enableCancel !== false; // 既定は実行
  const p = payload || {};
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });
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
        const found = await findReserveIdForBooking(page, {
          yyyymmdd: when.yyyymmdd,
          hhmm: `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`,
          staffExt: p.salonboard_staff_external_id || null,
          customerName: p.customer_name || null,
        }, { baseUrl }).catch(() => null);
        if (found) {
          reserveId = found;
          // 呼び出し側(worker)が bookings.external_booking_id に焼き直せるよう返す。
          p._recoveredReserveId = found;
        }
      }
    } catch (_e) { /* フォールバック失敗は下の最終チェックで扱う */ }
  }

  if (!reserveId) {
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
  const detailCandidates = [
    `/KLP/reserve/ext/extReserveDetail/?reserveId=${reserveId}`,
    `/KLP/reserve/net/reserveDetail/?reserveId=${reserveId}`,
  ];
  let onDetail = false;
  for (const path of detailCandidates) {
    await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    // ★高速化: networkidleを待たず、キャンセルボタンが出たら即進む。
    await page.waitForSelector('#fnc_cancel', { timeout: 10_000 }).catch(() => {});
    if ((await page.locator('#fnc_cancel').count().catch(() => 0)) > 0) { onDetail = true; break; }
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  const cap1 = await captureScrapeDebug(page, 'cancel', `detail_${reserveId}`, {
    diagnostics: { reserveId, onDetail, url: page.url() },
  });

  // 既にキャンセル済みなら成功扱い (冪等)
  const detailText = (await page.locator('body').innerText().catch(() => '')) || '';
  if (/ステータス[\s\S]{0,30}(キャンセル|取消)/.test(detailText) && (await page.locator('#fnc_cancel').count().catch(() => 0)) === 0) {
    return { status: 'ok', externalId: reserveId, recoveredReserveId: p._recoveredReserveId || null };
  }

  const cancelBtn = page.locator('#fnc_cancel').first();
  if ((await cancelBtn.count().catch(() => 0)) === 0) {
    return fail(`キャンセルボタン(#fnc_cancel)が見つかりませんでした (reserveId=${reserveId}${cap1 ? `, capture=${cap1}` : ''})`, 'UNKNOWN_ERROR', true);
  }

  if (!enableCancel) {
    return { status: 'confirm_only' };
  }

  // 2) 「キャンセルにする」をクリック → HTML ダイアログを待つ
  // (念のためネイティブ confirm が出るケースにも accept ハンドラを張る)
  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmClicked = false;
  try {
    await cancelBtn.click({ timeout: 12_000 }).catch(() => {});
    // 3) ページ内ダイアログの「はい」(.accept) を待ってクリック
    const yesBtn = page.locator('a.accept:visible, .buttons a.accept').first();
    await yesBtn.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if ((await yesBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
        yesBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
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
    /キャンセルしました|キャンセルが完了|キャンセルを受け付け|取り消しました|キャンセル済/.test(bodyText) ||
    /ステータス[\s\S]{0,30}(キャンセル|取消)/.test(bodyText);
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
  const fail = (reason, errorCode, manualRequired) => ({ status: 'failed', reason, errorCode, manualRequired });
  const reserveId = (p.external_booking_id || '').trim();

  if (!reserveId) return fail('external_booking_id (SalonBoard 予約ID) が無いため変更対象を特定できません', 'STAFF_MAPPING_NOT_FOUND', true);
  const when = parseJstPartsForPush(p.scheduled_at);
  if (!when) return fail(`invalid scheduled_at: ${p.scheduled_at}`, 'UNKNOWN_ERROR', true);
  const startMM = String(when.minute).padStart(2, '0');

  // 1) 変更画面を開く (ext → net)
  const candidates = [
    `/KLP/reserve/ext/extReserveChange/?reserveId=${reserveId}`,
    `/KLP/reserve/net/reserveChange/?reserveId=${reserveId}`,
  ];
  let onForm = false;
  for (const path of candidates) {
    await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    // ★高速化: networkidleを待たず、変更フォーム要素が出たら即進む。
    await page.waitForSelector('select#jsiRsvHour, #rlastupdate, a#change, a#regist', { timeout: 12_000 }).catch(() => {});
    if ((await page.locator('select#jsiRsvHour, #rlastupdate, a#change, a#regist').count().catch(() => 0)) > 0) { onForm = true; break; }
  }
  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }
  const cap1 = await captureScrapeDebug(page, 'change', `form_${reserveId}`, { diagnostics: { reserveId, onForm, url: page.url() } });
  if (!onForm) {
    return fail(`予約変更フォームに到達できませんでした (reserveId=${reserveId}${cap1 ? `, capture=${cap1}` : ''})`, 'UNKNOWN_ERROR', true);
  }

  // 2) 担当 (指定があれば更新。登録フォームと同じ select#salonStaffList + hidden #staffId)
  const staffExt = (p.salonboard_staff_external_id || '').trim();
  if (staffExt) {
    await page.locator('select#salonStaffList').first().selectOption({ value: staffExt }).catch(() => {});
    await page.evaluate((ext) => {
      const setVal = (el) => { if (el) { el.value = ext; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      setVal(document.getElementById('staffId'));
      document.querySelectorAll('input[name="staffId"]').forEach(setVal);
      for (const name of ['salonStaffList', 'staffIdList']) {
        const sel = document.querySelector(`select[name="${name}"]`);
        if (sel && Array.from(sel.options).some((o) => o.value === ext)) { sel.value = ext; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, staffExt).catch(() => {});
  }

  // 3) 時間・所要を更新 (登録フォームと同じセレクタ)。所要は新規登録と同じ堅牢化:
  //    JSで全selectをセット+change発火し、反映を検証してダメなら selectOption で再セット。
  {
    const dMin = (p.duration_min != null && Number.isFinite(Number(p.duration_min)))
      ? Number(p.duration_min)
      : 60;
    const thVal = String(Math.floor(dMin / 60) * 60);
    const tmVal = String(dMin % 60).padStart(2, '0');
    await page.evaluate(
      ({ hh, mm, th, tm }) => {
        const setSel = (id, val) => {
          const el = document.getElementById(id);
          if (!el) return;
          if (!Array.from(el.options).some((o) => o.value === val)) return;
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setSel('jsiRsvHour', hh);
        setSel('jsiRsvMinute', mm);
        setSel('jsiRsvTermHour', th);
        setSel('jsiRsvTermMinute', tm);
      },
      { hh: String(when.hour), mm: startMM, th: thVal, tm: tmVal },
    ).catch(() => {});
    await page.waitForTimeout(300);
    const ok = await page.evaluate(({ th, tm }) => {
      const h = document.getElementById('jsiRsvTermHour');
      const m = document.getElementById('jsiRsvTermMinute');
      return !!h && !!m && h.value === th && m.value === tm;
    }, { th: thVal, tm: tmVal }).catch(() => false);
    if (!ok) {
      await page.locator('select#jsiRsvTermHour').first().selectOption({ value: thVal }).catch(() => {});
      await page.locator('select#jsiRsvTermMinute').first().selectOption({ value: tmVal }).catch(() => {});
    }
  }

  if (!enableChange) {
    return { status: 'confirm_only' };
  }

  // 4) 確定: 実DOMでは画面下部の <a id="change" class="mod_btn_50">確定する</a> が
  //    最終確定ボタン (id="change_disable" は無効時の別要素なので除外)。
  const submitBtn = page
    .locator('a#change:visible, a.mod_btn_50:has-text("確定する"), a#regist, a:has-text("登録する")')
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

  let nativeDialogAccepted = false;
  const onDialog = async (d) => { nativeDialogAccepted = true; try { await d.accept(); } catch (_e) { /* noop */ } };
  page.on('dialog', onDialog);
  let confirmClicked = false;
  try {
    await submitBtn.click({ timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // 「確定する」後に確認画面/ダイアログが出る場合があるので、最終確定ボタンを押す。
    //   ① HTMLダイアログ「はい」(a.accept) ② 確認画面の「登録する」(a#regist) / 「確定する」(a#change)
    const finalBtn = page
      .locator('a.accept:visible, .buttons a.accept, a#regist:visible, a:has-text("登録する"):visible, a#change:visible')
      .first();
    await finalBtn.waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {});
    if ((await finalBtn.count().catch(() => 0)) > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      confirmClicked = true;
      await page.waitForTimeout(1500);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    }
  } finally {
    page.off('dialog', onDialog);
  }

  const cap2 = await captureScrapeDebug(page, 'change', `after_${reserveId}`, {
    diagnostics: { reserveId, confirmClicked, nativeDialogAccepted, url: page.url() },
  });

  // 5) 検証
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const looksDone = /変更しました|変更が完了|更新しました|受け付けました|登録しました/.test(bodyText);
  const looksError = /エラー|失敗|できませんでした|入力してください|空いて|満員|埋ま/.test(bodyText) && !looksDone;
  if (looksError) {
    return fail(`変更時にエラー表示 (${(bodyText.match(/.{0,40}(エラー|失敗|できませんでした|入力してください|空いて|満員|埋ま).{0,40}/)?.[0] || '').trim()}${cap2 ? `, capture=${cap2}` : ''})`, 'UNKNOWN_ERROR', true);
  }
  if (!looksDone && !confirmClicked && !nativeDialogAccepted) {
    return fail(`変更の完了を確認できませんでした (confirmClicked=${confirmClicked}${cap1 ? `, form=${cap1}` : ''}${cap2 ? `, after=${cap2}` : ''})。SalonBoard で状態を確認してください。`, 'UNKNOWN_ERROR', true);
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

/**
 * 美容室「スタイリスト掲載情報一覧」(/CNB/draft/stylistList/) を取得する。
 * エステの scrapeStaff の hair 版。出力 row 形は sendStaff 互換 (external_id/name/...)。
 *
 * 確認済み DOM (salonboard_code/美容室/スタイリスト_stylistList.html):
 *   - 一意 ID: input[name="frmStylistListStylistDtoList[N].stylistId"] value="T000917663"
 *   - 各スタイリストは table.table_list_store の連続行。名前/職種は td.td_value_store_c。
 */
async function scrapeStylists(page, opts = {}) {
  await page.goto(STYLIST_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  // グループ店舗で groupTop に跳ね返された場合はサロンを選び直して入り直す。
  const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
  if (sel.selected) {
    await page.goto(STYLIST_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
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
          .filter((t) => t && t !== '-');
        // 氏名 → 職種/指名料 → 施術歴 の順で並ぶ。最初の非空を氏名とみなす。
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
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    // 1ページ目: グループ店舗で groupTop に跳ね返された場合はサロンを選び直して入り直す。
    if (pageNum === 1) {
      const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
      if (sel.selected) {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
  try { url = new URL('/CNK/draft/photoGalleryEdit', 'https://salonboard.com').toString(); } catch (_e) { url = PHOTO_GALLERY_EDIT_URL; }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // グループ店舗で groupTop に跳ね返された場合はサロンを選び直して入り直す。
  const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
  if (sel.selected) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
  await page.goto(EQUIP_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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

async function scrapeStaff(page, opts = {}) {
  // ジャンル別分岐: 美容室(hair)はスタッフではなく「スタイリスト一覧」を取得する。
  // 他ジャンル(esthetic/nail/eyelash/other)は従来のスタッフ一覧 (/CNK/draft/staffList)。
  if (opts.genre === 'hair') {
    return scrapeStylists(page, opts);
  }
  await page.goto(STAFF_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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

    // 5) 完了判定: imagePath* のいずれかに新しい値が入るのを最大15秒待つ。
    const done = await page.waitForFunction((before) => {
      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('imagePath' + i);
        const v = el ? (el.value || '') : '';
        if (v && v !== before[i]) return true;
      }
      return false;
    }, beforePaths, { timeout: 15_000 }).then(() => true).catch(() => false);

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

  const title = (p.title && String(p.title).trim()) || '';
  if (!title) return fail('ブログのタイトルが空です', 'UNKNOWN_ERROR', true);
  // 本文: HTML タグを除いたプレーン化 (SalonBoard の textarea はプレーンテキスト想定)。
  const bodyPlain = String(p.body_html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let formUrl;
  try { formUrl = new URL('/KLP/blog/blog/', baseUrl).toString(); } catch (_e) { formUrl = BLOG_FORM_URL; }
  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

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
  try {
    const confirmBtn = page.locator('a#confirm, a.mod_btn_confirm_03, a:has-text("確認する")').first();
    if ((await confirmBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'blog', `no_confirm`, { diagnostics: { url: page.url() } });
      return fail(`ブログの「確認する」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
      confirmBtn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
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
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
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
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

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
    const confirmBtn = page.locator('a#replyConfirm, a.mod_btn_confirm_04, a:has-text("確認する")').first();
    if ((await confirmBtn.count().catch(() => 0)) === 0) {
      const cap = await captureScrapeDebug(page, 'review', 'no_confirm', { diagnostics: { url: page.url() } });
      return fail(`口コミ返信の「確認する」ボタンが見つかりませんでした (capture=${cap || '?'})`, 'UNKNOWN_ERROR', true);
    }
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
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
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
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
  await page.goto(BLOG_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

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
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

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
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

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
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
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
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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

  const stores = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, '').trim();
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[id^="H"]'))) {
      const id = (a.getAttribute('id') || '').trim();
      if (!/^H\d{6,}$/i.test(id)) continue;
      out.push({ id: id.toUpperCase(), name: norm(a.textContent) });
    }
    return out;
  });
  if (!stores.length) return { ok: false, selected: false, reason: 'group_top_no_stores' };

  let target = null;
  if (salonId) {
    target = stores.find((s) => s.id === salonId) || null;
    if (!target) return { ok: false, selected: false, reason: `salon_id_not_in_group(${salonId})` };
  } else if (shopName) {
    const want = shopName.replace(/\s+/g, '');
    target =
      stores.find((s) => s.name && (s.name === want || s.name.includes(want) || want.includes(s.name))) || null;
    if (!target) return { ok: false, selected: false, reason: 'group_top_name_unmatched' };
  } else {
    // salon_id も店舗名も無く、グループが1店舗だけならそれを選ぶ。複数なら特定不能。
    if (stores.length === 1) target = stores[0];
    else return { ok: false, selected: false, reason: 'group_top_no_target' };
  }

  // サロンのリンクは <a href="javascript:void(0);" id="H..."> で、クリックで
  // JS(フォームPOST/AJAX)経由で店舗文脈に入る。クリック → 遷移待ち。
  // 遷移が起きないケースに備え、URL 変化 or groupTop 離脱のいずれかを待つ。
  const beforeUrl = page.url();
  try {
    await page.locator(`a[id="${target.id}"]`).first().click({ timeout: 8_000 });
  } catch (e2) {
    return { ok: false, selected: false, reason: `store_click_failed: ${e2?.message ?? e2}`, salonId: target.id };
  }
  // 遷移 or URL変化を最大15秒待つ (javascript:void リンクなので load イベントに頼らない)。
  await page.waitForFunction(
    (prev) => location.href !== prev || !/\/(?:CNC|KLP)\/groupTop/i.test(location.href),
    beforeUrl,
    { timeout: 15_000 },
  ).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

  if (/\/(?:CNC|KLP)\/groupTop/i.test(page.url())) {
    return { ok: false, selected: false, reason: 'still_on_group_top', salonId: target.id };
  }
  // サロン選択は POST→セッション確定→リダイレクトのため、直後の goto で戻されないよう少し待つ。
  await page.waitForTimeout(1200);
  return { ok: true, selected: true, salonId: target.id };
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
    const resp = await page.context().request.get(url, { timeout: 20_000 });
    if (!resp.ok()) {
      await captureScrapeDebug(page, tag, 'image_download_failed', {
        diagnostics: { url, status: resp.status() },
      }).catch(() => {});
      return null;
    }
    const buf = await resp.body();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
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
  try { formUrl = new URL('/CNK/draft/photoGalleryEdit', baseUrl).toString(); } catch (_e) { formUrl = PHOTO_GALLERY_EDIT_URL; }
  await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

  // グループ店舗(1ログイン複数サロン)で groupTop に跳ね返された場合はサロンを選び直してから入り直す。
  {
    const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
    if (!sel.ok) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'store_select', { diagnostics: { url: page.url(), reason: sel.reason } });
      return fail(`グループ店舗のサロン選択に失敗しました (${sel.reason}, capture=${cap || '?'})。店舗のSalonBoard設定でサロンID(H...)を登録してください。`, 'STORE_SELECT_REQUIRED', true);
    }
    if (sel.selected) {
      await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
      regBtn.click({ timeout: 12_000 }).catch(() => {}),
    ]);
    clickedRegister = true;
    await page.waitForTimeout(1500);
    // 確認画面に「登録する」等が出る場合は最終確定を押す (出なければ no-op)。
    const finalBtn = page.locator('a:has-text("登録する"):visible, a.accept:visible, input[type="submit"][value*="登録"]:visible, img.jscButtonRegister:visible').first();
    if ((await finalBtn.count().catch(() => 0)) > 0 && (await finalBtn.isVisible().catch(() => false))) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
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
    await page.waitForTimeout(700);
    const fileInput = page.locator('input.jscImageUploaderModalInput, input[type="file"]:visible, .modal input[type="file"], input[type="file"]').first();
    if ((await fileInput.count().catch(() => 0)) > 0) {
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
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    // グループ店舗(1ログイン複数サロン)で groupTop に跳ね返された場合はサロンを選び直す。
    const sel = await ensureSalonSelected(page, { salonId: opts.salonId, shopName: opts.shopName });
    if (!sel.ok) {
      const cap = await captureScrapeDebug(page, 'photo_gallery', 'hair_store_select', { diagnostics: { url: page.url(), reason: sel.reason } });
      return fail(`グループ店舗のサロン選択に失敗しました (${sel.reason}, capture=${cap || '?'})。店舗のSalonBoard設定でサロンID(H...)を登録してください。`, 'STORE_SELECT_REQUIRED', true);
    }
    if (sel.selected) {
      // サロン選択後にスタイル一覧へ入り直す。
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
  } catch (_e) { /* noop */ }

  if ((await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0)) > 0) {
    return fail('reCAPTCHA が表示されました', 'RECAPTCHA_REQUIRED', true);
  }

  // 「スタイル新規追加」ボタン (addStyle)。
  const addBtn = page.locator('a[onclick*="addStyle"], a:has(img[alt="スタイル新規追加"])').first();
  if ((await addBtn.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}),
      addBtn.click({ timeout: 10_000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(800);
  } else {
    // ボタンが無ければ styleEdit に直接遷移を試みる。
    try {
      await page.goto(new URL('/CNB/draft/styleEdit/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
      return fail(`SalonBoard がスタイル画像のアップロードを拒否しました(通信に失敗しました)。imgreg=[${imgregSummary}] (capture=${cap || '?'})`, 'IMAGE_REJECTED', true);
    }
    if (uploaded.reason === 'modal_register_not_found') {
      return fail(`画像アップロードモーダルの「登録する」を特定できませんでした (capture=${cap || '?'})。モーダルDOMの共有が必要です。`, 'UNKNOWN_ERROR', true);
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
        page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
        finalBtn.click({ timeout: 10_000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1200);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
 * styleEdit の FRONT 枠に画像を1枚アップロードする。
 * 未設定の FRONT 画像(img#FRONT_IMG_ID_IMG.img_new_no_photo)をクリック→
 * CN_CMN_imageUploaderModal で画像をアップロード。
 * 完了は FRONT_IMG_ID hidden / #FRONT_IMG_ID_ID に画像ID(B...)が入るかで判定する。
 * 戻り値: { ok, imageId?, reason? }
 */
async function uploadHairStyleFrontImage(page, file) {
  const idHidden = page.locator('input#FRONT_IMG_ID, input[name="FRONT_IMG_ID"]').first();
  const before = await idHidden.inputValue().catch(() => '');

  // /imgreg/ (モーダル表示 & doUpload) のリクエスト/レスポンスを記録して、
  // 失敗時に「なぜ通信に失敗したか」を実データで確認できるようにする。
  const imgregLog = [];
  const onResp = async (resp) => {
    try {
      const url = resp.url();
      if (!/\/imgreg\//i.test(url)) return;
      let bodyHead = '';
      try { bodyHead = (await resp.text()).slice(0, 600); } catch (_e) { bodyHead = '(body unread)'; }
      imgregLog.push({ url, status: resp.status(), bodyHead });
    } catch (_e) { /* noop */ }
  };
  const onReqFail = (req) => {
    try { if (/\/imgreg\//i.test(req.url())) imgregLog.push({ url: req.url(), failed: req.failure()?.errorText || 'request failed' }); } catch (_e) {}
  };
  page.on('response', onResp);
  page.on('requestfailed', onReqFail);

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
  await trigger.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
  await page.evaluate(() => {
    const el = document.querySelector('img#FRONT_IMG_ID_IMG, #FRONT_IMG_ID_IMG');
    if (el) ['mousedown', 'mouseup', 'click'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }).catch(() => {});
  // playwright のクリックも併用 (どちらかが効けばよい)。
  await trigger.click({ timeout: 5_000, force: true }).catch(() => {});
  await Promise.race([chooserPromise, page.waitForTimeout(2_500)]);

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
  const PREFER_DIRECT_POST = /^(1|true|yes)$/i.test(process.env.SALONBOARD_DIRECT_POST ?? '');
  if (!chooserDone && PREFER_DIRECT_POST) {
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
        const buf = fs.readFileSync(file);
        const name = path.basename(file);
        const ext = (name.split('.').pop() || 'jpg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const absUrl = new URL(params.url, page.url()).toString();
        const pageUrl = page.url();
        // ★Akamai Bot Manager 対策: doUpload は Akamai 配下で、自動化リクエストだと
        //   ホールドされて 60s タイムアウトすることがある(_abck 等のcookieあり)。
        //   ブラウザの $.ajax に近いヘッダ(referer/origin/x-requested-with)を付け、
        //   タイムアウト/中断時は短い間隔で最大3回リトライする(Akamaiは断続的)。
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
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            resp = await page.context().request.post(absUrl, {
              timeout: 25_000,
              headers: reqHeaders,
              multipart: buildMultipart(),
            });
            break; // 応答が返れば(2xx/4xx/5xx問わず)ループ終了
          } catch (e) {
            lastErr = e?.message?.split('\n')[0] ?? String(e);
            imgregLog.push({ direct_post_retry: attempt, error: lastErr });
            await page.waitForTimeout(1200).catch(() => {});
          }
        }
        if (!resp) {
          // 3回ともタイムアウト/中断 → Akamai にブロックされている可能性。
          page.off('response', onResp); page.off('requestfailed', onReqFail);
          imgregLog.push({ direct_post: 'all_retries_failed', lastErr });
          return { ok: false, reason: 'direct_post_blocked', imgreg: imgregLog };
        }
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
        // HTTP 200 だが imageId が取れない → レスポンス構造を診断ログに出す(ブラウザXHRには落とさない)。
        imgregLog.push({ via: 'direct_post', status: resp.status(), applied: applied?.fields || applied, bodyHead: (html || '').replace(/\s+/g, ' ').slice(0, 400) });
        if (resp.status() === 200) {
          // 200 なのに反映できないだけ。ブラウザXHRで二重送信せず、ここで失敗を返す。
          page.off('response', onResp); page.off('requestfailed', onReqFail);
          return { ok: false, reason: 'direct_post_200_no_imageid', imgreg: imgregLog };
        }
      } catch (e) {
        imgregLog.push({ url: params.url, failed: `direct_post_error: ${e?.message ?? e}` });
      }
    }
    // 直接POSTが使えない/失敗 → 下のブラウザXHR方式にフォールバック。
  }

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
    try {
      const buf = fs.readFileSync(file);
      const b64 = buf.toString('base64');
      const name = path.basename(file);
      const ext = (name.split('.').pop() || 'jpg').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      usedInMemory = await page.evaluate(({ b64, name, mime }) => {
        try {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const f = new File([bytes], name, { type: mime });
          const dt = new DataTransfer();
          dt.items.add(f);
          const inp = document.querySelector('input.jscImageUploaderModalInput, #imageUploaderModalBody input[type="file"], .jscImageUploaderModalDropArea input[type="file"]');
          if (inp) {
            inp.files = dt.files;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // 念のため waitImgeFile も同一の in-memory File に。
          if (typeof window.addWaitImgeFile === 'function') window.addWaitImgeFile(f);
          else window.waitImgeFile = f;
          return true;
        } catch (_e) { return false; }
      }, { b64, name, mime }).catch(() => false);
    } catch (_e) { /* fallthrough */ }

    if (!usedInMemory) {
      // in-memory に失敗したら従来の setInputFiles。
      await modalInput.setInputFiles(file, { timeout: 8_000 }).catch(() => {});
    }
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

  // 押下後、完了(FRONT_IMG_ID 反映) か エラー(通信に失敗しました) のどちらかを最大40秒待つ。
  // 連打せず、状態が確定するまで素直に待つ。
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
  }, before, { timeout: 40_000 }).catch(() => {});

  const detach = () => { try { page.off('response', onResp); page.off('requestfailed', onReqFail); } catch (_e) {} };

  if (await hasCommError()) {
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
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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

module.exports = {
  scrapeBookings,
  scrapeStaff,
  scrapeEquipment,
  scrapeMenus,
  scrapeCoupons,
  scrapeBlogs,
  scrapeReviews,
  scrapeShifts,
  scrapeCustomerDetails,
  pushBookingViaForm,
  pushScheduleViaForm,
  deleteScheduleViaForm,
  pushShiftsViaForm,
  scrapeShiftPatterns,
  cancelBookingViaForm,
  changeBookingViaForm,
  postBlogViaForm,
  deleteBlogViaForm,
  postReviewReplyViaForm,
  postPhotoGalleryViaForm,
  scrapePhotoGallery,
  findReserveIdForBooking,
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
