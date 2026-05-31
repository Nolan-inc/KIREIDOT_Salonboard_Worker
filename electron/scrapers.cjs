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
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(dir, 'page.html'), scrubScrapeSecrets(html, secrets), { mode: 0o600 });
    } catch (_e) { /* noop */ }
    try {
      await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true });
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
async function scrapeBookings(page, opts = {}) {
  const months = Number.isFinite(opts.months) ? opts.months : 3;
  const range = defaultBookingDateRange(months);
  const diag = [];

  await page.goto(RESERVE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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

    // 「次へ」 / ">" / 「次のページ番号」を辿る
    const nextSelectors = [
      'a:has-text("次へ"):not(.disabled)',
      'a:has-text("次"):not(:has-text("次回"))',
      'a[onclick*="next" i]',
      'a[rel="next"]',
      'li.pagerNext a',
      'a.pagerNext',
      // ページ番号リンクで「次の番号」を探す → 後段の JS で
    ];
    let advanced = false;
    for (const sel of nextSelectors) {
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
      reservation_route: cleanText(it.route_raw) || null,
      payment_method_label: cleanText(it.payment_raw) || null,
      coupon_name: cleanText(it.coupon_raw) || null,
      notes: null,
    });
  }
  return {
    rows,
    debug: {
      itemsFound: allItems.length,
      parsed: rows.length,
      skipped,
      sampleSkipped,
      range: `${range.fromStr} 〜 ${range.toStr}`,
      diag,
    },
  };
}

/**
 * 現在表示されているページから予約行を抽出する。
 * scrapeBookings の旧 page.evaluate と同じロジック。
 */
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
    for (const t of tables) {
      const sc = score(t);
      if (sc > bestScore) {
        bestScore = sc;
        target = t;
      }
    }
    if (!target || bestScore < 4) {
      // 結果テーブル無し = 「該当する予約はありません」状態
      return { items: [], reason: `no_result_table (best=${bestScore})` };
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
        // 予約詳細リンクから external_id を取得
        const link =
          tr.querySelector('a[href*="reserveDetail"], a[href*="reservation"]') ||
          tr.querySelector('a[href]');
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
          link_href: attr(link, 'href'),
          row_text: rowText,
          headers_debug: headers,
        };
      })
      .filter(Boolean);
    return { items };
  });
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
async function scrapeMenus(page) {
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
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
  // 開始 時/分
  await page.locator('select#jsiRsvHour').first().selectOption({ value: String(when.hour) }).catch(() => {});
  await page.locator('select#jsiRsvMinute').first().selectOption({ value: startMM }).catch(() => {});
  // 所要 (rsvTermHour の value は分換算: 60=1時間)
  const durMin = p.duration_min || 60;
  await page.locator('select#jsiRsvTermHour').first()
    .selectOption({ value: String(Math.floor(durMin / 60) * 60) }).catch(() => {});
  await page.locator('select#jsiRsvTermMinute').first()
    .selectOption({ value: String(durMin % 60).padStart(2, '0') }).catch(() => {});

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

  // ※ 旧実装はここで body 全文を /空いて|重複/ 等で検索していたが、フォームの
  //    説明文 (例「空いている時間を選択」) に誤反応して、実際は空いていても
  //    SLOT_NOT_AVAILABLE になっていた。空き枠/重複の本当のエラーは「登録する」
  //    送信後にエラー領域に出るので、ここでの事前チェックは廃止する。

  const confirmed = {
    confirmed_customer_name: p.customer_name ?? null,
    confirmed_staff_name: p.staff_name ?? null,
    confirmed_menu_name: menuTarget,
    confirmed_scheduled_at: p.scheduled_at,
  };

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

  const beforeUrl = page.url();
  try {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
      registerBtn.click({ timeout: 15_000 }),
    ]).catch(() => {});
    // confirm の OK 押下 → 送信 → 遷移を待つ
    await page.waitForTimeout(2500);
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
  // まだ登録フォーム上に居る = 送信されていない (confirm が押せなかった等)。
  const stillOnForm = /extReserveRegist/i.test(afterUrl);

  if (!dialogAccepted && stillOnForm) {
    return fail(
      '登録確認ダイアログ (「予約を登録します。よろしいですか？」) を確定できませんでした。',
      'UNKNOWN_ERROR',
      true,
    );
  }
  const looksDone = !!detailLink || doneText > 0 || (!stillOnForm && afterUrl !== beforeUrl);
  if (!looksDone) {
    return fail(
      `登録ボタンは押しましたが完了を確認できませんでした (dialog=${dialogAccepted}, url=${afterUrl})。SalonBoard で登録状況を確認してください。`,
      'UNKNOWN_ERROR',
      true,
    );
  }
  return { status: 'ok', externalId, detailUrl, confirmed };
}

// ----------------- スタッフ一覧 (staffList) -----------------

const STAFF_LIST_URL = 'https://salonboard.com/CNK/draft/staffList';

async function scrapeStaff(page) {
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

module.exports = {
  scrapeBookings,
  scrapeStaff,
  scrapeMenus,
  scrapeBlogs,
  scrapeShifts,
  scrapeCustomerDetails,
  pushBookingViaForm,
  // テスト用にエクスポート
  _internal: {
    parseJstDateTime,
    parseJstDate,
    parseYen,
    parseMinutes,
    extractCustomerCode,
    mapBookingStatus,
    cleanPhone,
  },
};
