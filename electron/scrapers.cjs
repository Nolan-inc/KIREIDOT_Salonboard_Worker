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

// ----------------- 共通ユーティリティ -----------------

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

// ----------------- スタッフ一覧 (staffList) -----------------

const STAFF_LIST_URL = 'https://salonboard.com/CNK/draft/staffList';

async function scrapeStaff(page) {
  await page.goto(STAFF_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    /**
     * SalonBoard スタッフ詳細 URL や hidden input から外部 ID を取り出す。
     * 想定:
     *   - ...staffDetail?staffId=W001234... / ...stylistId=W001xxx
     *   - hidden input <input name="staffId" value="W..."> / 行属性 data-staff-id
     *   - 行内テキストに W123456 / N123456 形式が露出していることもある
     * 形式: 「W」または「N」+ 数字 4 桁以上 を要求。
     */
    function extractStaffId(s) {
      if (!s) return null;
      const m1 = String(s).match(/(?:staffId|stylistId|staff_id)=([WNwn]\d{4,})/);
      if (m1) return m1[1].toUpperCase();
      const m2 = String(s).match(/\b([WNwn]\d{6,})\b/);
      if (m2) return m2[1].toUpperCase();
      return null;
    }

    /**
     * v0.2.7+: SalonBoard 「スタッフ掲載情報一覧」画面は table 形式で、
     * 各行に「順番 / PickUp / 写真 / 氏名+職種+キャッチ / 詳細 / 非掲載・削除」が並ぶ。
     * 旧実装は a[href*="staffDetail"] だけを頼っていたが、現画面の「詳細」ボタンが
     * リンクではなく button / form 化されていると一致せず 0 件になる。
     *
     * → 旧方式 (リンク収集) と新方式 (table 行スキャン) の両方で集めて、
     *    どちらかで取れた行を全部出す。external_id が取れない行は drop。
     */
    const items = [];
    const seenIds = new Set();
    const seenNames = new Set();

    // 「除外したい行テキスト」のヒューリスティック
    // ヘッダ行や見出し行、フッタなど。
    const SKIP_NAME_PATTERNS =
      /^(順番|PickUp|スタッフ写真|氏名|職種|キャッチ|詳細|非掲載|削除|表示プラン|名前|職位|順位)$/u;

    function pushItem(it) {
      if (!it.name) return;
      if (SKIP_NAME_PATTERNS.test(it.name)) return;
      if (it.external_id) {
        if (seenIds.has(it.external_id)) return;
        seenIds.add(it.external_id);
      } else {
        // external_id がない行は name で de-dup (異なる店舗の同名スタッフは別物だが
        // ここは 1 店舗のスタッフ一覧なので name 一意でよい)
        if (seenNames.has(it.name)) return;
        seenNames.add(it.name);
      }
      items.push(it);
    }

    // --- 方式 A: リンク経由 (旧実装) ---
    const links = Array.from(
      document.querySelectorAll(
        'a[href*="staffDetail"], a[href*="stylistDetail"], a[href*="staffEdit"], a[href*="stylistEdit"]'
      ),
    );
    for (const link of links) {
      const href = attr(link, 'href') || '';
      const extId = extractStaffId(href);
      if (!extId) continue;

      let card = link;
      for (let i = 0; i < 6; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        const t = txt(card);
        if (t.length > 20) break;
      }
      let name = txt(link);
      if (!name || name.length > 30) {
        const nameEl = card.querySelector(
          '[class*="name" i], h2, h3, .ttl, .staff-name'
        );
        name = txt(nameEl);
      }
      name = name
        .replace(/\s*(?:要確認|サブスク中|新人|指名料.*)$/u, '')
        .replace(/^\s*No\.\s*/i, '')
        .trim();

      const photo = card.querySelector('img');
      const positionEl = card.querySelector(
        '[class*="position" i], [class*="role" i]'
      );
      const catchEl = card.querySelector(
        '[class*="catch" i], [class*="message" i]'
      );
      const feeText = (txt(card).match(/指名料\s*([¥\d,]+)/) || [])[1];

      pushItem({
        external_id: extId,
        name,
        position: txt(positionEl),
        catch_phrase: txt(catchEl),
        photo_url: attr(photo, 'src') || attr(photo, 'data-src') || null,
        designation_fee_raw: feeText || null,
      });
    }

    // --- 方式 B: table 行スキャン (現「スタッフ掲載情報一覧」画面用) ---
    // テーブル列の意味は order/pickup/photo/info(name+position+catch)/detail/hide-delete
    // 1 行に img が必ず 1 つあり、表内最初のテキスト塊 (1〜10 文字程度) が名前。
    const trAll = Array.from(document.querySelectorAll('table tr'));
    for (const tr of trAll) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 3) continue;
      const rowText = txt(tr);
      if (!rowText) continue;
      // ヘッダ行を skip
      if (/順番.*PickUp.*スタッフ写真|氏名.*職種.*キャッチ/.test(rowText)) continue;

      // external_id を行内のリンク / hidden input / 全テキストから探す
      let extId = null;
      for (const a of tr.querySelectorAll('a[href]')) {
        const h = attr(a, 'href') || '';
        const id = extractStaffId(h);
        if (id) {
          extId = id;
          break;
        }
      }
      if (!extId) {
        for (const inp of tr.querySelectorAll(
          'input[type="hidden"], input[name*="staff" i], input[name*="stylist" i]'
        )) {
          const id =
            extractStaffId(attr(inp, 'value') || '') ||
            extractStaffId(attr(inp, 'name') || '');
          if (id) {
            extId = id;
            break;
          }
        }
      }
      if (!extId) {
        // 行属性 / フォーム属性
        const dataAttrs = [
          attr(tr, 'data-staff-id'),
          attr(tr, 'data-staffid'),
          attr(tr, 'id'),
        ]
          .filter(Boolean)
          .join(' ');
        extId = extractStaffId(dataAttrs);
      }
      if (!extId) {
        // 最終手段: 行テキスト全体からマッチ (露出してないことも多いので未取得なら null)
        extId = extractStaffId(rowText);
      }

      // 名前は「氏名/職種/キャッチ」セル (= img を含まないセルで最初のテキスト塊)
      let name = '';
      let position = '';
      let catchPhrase = '';
      for (const td of tds) {
        const t = txt(td);
        if (!t) continue;
        if (/^No\.\s*\d+$/.test(t)) continue;
        if (/^\s*\d+\s*$/.test(t)) continue;
        if (td.querySelector('img')) continue;
        if (
          td.querySelector(
            'button, a.btn, input[type="button"], input[type="submit"]'
          )
        )
          continue;

        // 行内の改行や複数 div を素直に拾う
        const blocks = Array.from(td.querySelectorAll('div, p, span'))
          .map(txt)
          .filter(Boolean);
        const lines = blocks.length
          ? blocks
          : t.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
        if (lines.length > 0) {
          // 1行目 = 名前候補、2行目 = 職種 + 指名料、3行目以降 = キャッチ
          name = lines[0];
          if (lines.length >= 2) position = lines[1];
          if (lines.length >= 3) catchPhrase = lines.slice(2).join(' ');
        } else {
          name = t;
        }
        break;
      }
      name = String(name || '')
        .replace(/\s*(?:要確認|サブスク中|新人|指名料.*)$/u, '')
        .replace(/^\s*No\.\s*/i, '')
        .trim();
      if (!name) continue;
      if (SKIP_NAME_PATTERNS.test(name)) continue;

      const photo = tr.querySelector('img');
      const feeText = (rowText.match(/指名料\s*([¥\d,]+)/) || [])[1];

      pushItem({
        external_id: extId, // null でも OK (この場合 name で de-dup)
        name,
        position: position,
        catch_phrase: catchPhrase,
        photo_url: attr(photo, 'src') || attr(photo, 'data-src') || null,
        designation_fee_raw: feeText || null,
      });
    }

    // --- 方式 C: 「No.X」テキスト起点で行 container を見つけて抽出 ---
    // SalonBoard 「スタッフ掲載情報一覧」は、各スタッフ行が独立した <table> で
    // 構成されているケースがある (方式 B では最初の 1 行しか拾えない場合がある)。
    // 方式 C では DOM 全体を text walk して "No. 1", "No. 2" ... を見つけ、
    // その親要素を「行 container」として img / 名前 / 職種 / キャッチ を抜き出す。
    const allNodes = document.querySelectorAll('*');
    const seenContainers = new Set();
    for (const node of allNodes) {
      // 直接テキストノードに "No. <数字>" が含まれているかチェック (子の合計でない)
      let hasNo = false;
      for (const c of node.childNodes) {
        if (c.nodeType === 3 /* TEXT_NODE */) {
          const t = (c.nodeValue || '').trim();
          if (/^No\.\s*\d+$/.test(t)) {
            hasNo = true;
            break;
          }
        }
      }
      if (!hasNo) continue;

      // 行 container を上方向に探す (img を含む or 同一行を構成するレベル)
      let row = node;
      for (let depth = 0; depth < 8; depth++) {
        if (!row.parentElement) break;
        row = row.parentElement;
        if (row.querySelector('img')) break;
        const rt = txt(row);
        if (rt.length > 30) break;
      }
      if (seenContainers.has(row)) continue;
      seenContainers.add(row);

      const rowText = txt(row);
      if (!rowText) continue;
      // ヘッダ container を除外
      if (/順番.*PickUp.*スタッフ写真|氏名.*職種.*キャッチ/.test(rowText)) continue;

      // external_id を探す (方式 B と同じロジック)
      let extId = null;
      for (const a of row.querySelectorAll('a[href]')) {
        const id = extractStaffId(attr(a, 'href') || '');
        if (id) {
          extId = id;
          break;
        }
      }
      if (!extId) {
        for (const inp of row.querySelectorAll(
          'input[type="hidden"], input[name*="staff" i], input[name*="stylist" i]'
        )) {
          const id =
            extractStaffId(attr(inp, 'value') || '') ||
            extractStaffId(attr(inp, 'name') || '');
          if (id) {
            extId = id;
            break;
          }
        }
      }
      if (!extId) {
        const dataAttrs = [
          attr(row, 'data-staff-id'),
          attr(row, 'data-staffid'),
          attr(row, 'id'),
        ]
          .filter(Boolean)
          .join(' ');
        extId = extractStaffId(dataAttrs);
      }
      if (!extId) extId = extractStaffId(rowText);

      // 名前 / 職種 / キャッチ を抽出
      // 「氏名/職種/キャッチキャッチ」 セル相当の領域 = img を含まずボタンも含まない
      // テキスト要素。row 全体から候補となる td / div を走査する。
      let name = '';
      let position = '';
      let catchPhrase = '';

      const textCandidates = Array.from(
        row.querySelectorAll('td, .info, .staff-info, [class*="info"]')
      ).filter((el) => {
        if (el.querySelector('img')) return false;
        if (
          el.querySelector('button, input[type="button"], input[type="submit"]')
        )
          return false;
        const tt = txt(el);
        if (!tt) return false;
        if (/^No\.\s*\d+$/.test(tt)) return false;
        if (/^\s*\d+\s*$/.test(tt)) return false;
        if (/^(PickUp|詳細|非掲載にする|削除する|要確認)$/.test(tt)) return false;
        return true;
      });

      // 最も「複数行を持つ」候補を選ぶ (氏名/職種/キャッチが入っているはず)
      let best = null;
      let bestLineCount = 0;
      for (const cand of textCandidates) {
        const blocks = Array.from(cand.querySelectorAll('div, p, span'))
          .map(txt)
          .filter(Boolean);
        const lc = blocks.length || (txt(cand).split(/[\n\r]+/).length);
        if (lc > bestLineCount) {
          best = cand;
          bestLineCount = lc;
        }
      }
      if (best) {
        const blocks = Array.from(best.querySelectorAll('div, p, span'))
          .map(txt)
          .filter(Boolean);
        const lines = blocks.length
          ? blocks
          : txt(best).split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
        if (lines.length > 0) {
          name = lines[0];
          if (lines.length >= 2) position = lines[1];
          if (lines.length >= 3) catchPhrase = lines.slice(2).join(' ');
        }
      }

      name = String(name || '')
        .replace(/\s*(?:要確認|サブスク中|新人|指名料.*)$/u, '')
        .replace(/^\s*No\.\s*/i, '')
        .replace(/^\s*\d+\s*[\.\)]?\s*/, '')
        .trim();
      if (!name) continue;
      if (SKIP_NAME_PATTERNS.test(name)) continue;

      const photo = row.querySelector('img');
      const feeText = (rowText.match(/指名料\s*([¥\d,]+)/) || [])[1];

      pushItem({
        external_id: extId,
        name,
        position,
        catch_phrase: catchPhrase,
        photo_url: attr(photo, 'src') || attr(photo, 'data-src') || null,
        designation_fee_raw: feeText || null,
      });
    }

    // --- 方式 D (v0.2.12 改): img を持つ <tr> ごとに直接 name/職種/キャッチを抽出 ---
    // v0.2.11 では「同 tbody を 1 回だけ」処理する制限があり、
    // 全スタッフが 1 つの大きな共通 tbody に並ぶ構造だと 1 件しか抽出できなかった。
    // v0.2.12 では tbody スコープを廃止し、imgTr ごとに同 tr 内 (+ 直前/直後の tr) を見る。
    const imgTrs = Array.from(document.querySelectorAll('tr')).filter(
      (tr) => tr.querySelector('img'),
    );
    let methodDCount = 0;
    // 名前 dump 用 (debug 出力)
    const methodDSamples = [];
    for (let idx = 0; idx < imgTrs.length; idx++) {
      const imgTr = imgTrs[idx];
      // group = imgTr 自身 + 直後 2 行 (氏名/キャッチが別 tr に分かれている構造に対応)
      const group = [imgTr];
      let nextEl = imgTr.nextElementSibling;
      let added = 0;
      while (nextEl && added < 2) {
        if (nextEl.tagName === 'TR' && !nextEl.querySelector('img')) {
          group.push(nextEl);
          added++;
        } else if (nextEl.tagName === 'TR' && nextEl.querySelector('img')) {
          break; // 次のスタッフ写真行に到達したら終了
        }
        nextEl = nextEl.nextElementSibling;
      }
      const groupText = group.map(txt).join(' ');
      if (!groupText) continue;
      // ヘッダ行除外
      if (/順番.*PickUp.*スタッフ写真|氏名.*職種.*キャッチ/.test(groupText)) continue;

      // external_id 探索
      let extId = null;
      for (const tr of group) {
        for (const a of tr.querySelectorAll('a[href]')) {
          const id = extractStaffId(attr(a, 'href') || '');
          if (id) {
            extId = id;
            break;
          }
        }
        if (extId) break;
        for (const inp of tr.querySelectorAll(
          'input[type="hidden"], input[name*="staff" i], input[name*="stylist" i]'
        )) {
          const id =
            extractStaffId(attr(inp, 'value') || '') ||
            extractStaffId(attr(inp, 'name') || '');
          if (id) {
            extId = id;
            break;
          }
        }
        if (extId) break;
      }
      if (!extId) extId = extractStaffId(groupText);

      // 名前/職種/キャッチ抽出:
      // group の中の全 td を走査して、img/ボタンを含まないテキスト td を集める。
      // <br> 区切りで複数行を持っていれば最優先で採用。
      const textTds = [];
      for (const tr of group) {
        for (const td of tr.querySelectorAll('td')) {
          if (td.querySelector('img')) continue;
          if (
            td.querySelector(
              'button, input[type="button"], input[type="submit"], a.btn'
            )
          )
            continue;
          const tt = txt(td);
          if (!tt) continue;
          if (/^No\.?\s*\d*$/.test(tt)) continue;
          if (/^\s*\d+\s*$/.test(tt)) continue;
          if (
            /^(PickUp|詳細|非掲載にする|削除する|要確認|変更内容を登録する)$/.test(tt)
          )
            continue;
          textTds.push(td);
        }
      }

      // 各 textTd を「<br> で分解した lines」のリストに変換し、最大行数のものを採用
      function tdToLines(td) {
        const html = td.innerHTML || '';
        const lines = html
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(div|p|li)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .split('\n')
          .map((s) => s.trim().replace(/\s+/g, ' '))
          .filter(Boolean);
        if (lines.length > 0) return lines;
        const t = txt(td);
        return t ? [t] : [];
      }
      let bestLines = [];
      for (const td of textTds) {
        const lines = tdToLines(td);
        if (lines.length > bestLines.length) bestLines = lines;
      }

      let name = '';
      let position = '';
      let catchPhrase = '';
      if (bestLines.length > 0) {
        name = bestLines[0];
        if (bestLines.length >= 2) position = bestLines[1];
        if (bestLines.length >= 3) catchPhrase = bestLines.slice(2).join(' ');
      } else if (textTds.length > 0) {
        // bestLines が取れなかったケース: 最初の textTd のテキストを name に
        name = txt(textTds[0]);
      }

      name = String(name || '')
        .replace(/\s*(?:要確認|サブスク中|新人|指名料.*)$/u, '')
        .replace(/^\s*No\.\s*/i, '')
        .trim();

      // 診断用に最初の 3 件はサンプルを残す (HTML/構造のヒント)
      if (idx < 3) {
        methodDSamples.push({
          idx,
          groupTrCount: group.length,
          textTdCount: textTds.length,
          name,
          bestLinesCount: bestLines.length,
          bestLinesPreview: bestLines.slice(0, 3),
          extId,
        });
      }

      if (!name) continue;
      if (SKIP_NAME_PATTERNS.test(name)) continue;

      const photo = imgTr.querySelector('img');
      const feeText = (groupText.match(/指名料\s*([¥\d,]+)/) || [])[1];

      methodDCount++;
      pushItem({
        external_id: extId,
        name,
        position,
        catch_phrase: catchPhrase,
        photo_url: attr(photo, 'src') || attr(photo, 'data-src') || null,
        designation_fee_raw: feeText || null,
      });
    }

    return {
      items,
      totalLinks: links.length,
      totalRows: trAll.length,
      methodCContainers: seenContainers.size,
      methodDImgTrs: imgTrs.length,
      methodDExtracted: methodDCount,
      methodDSamples,
    };
  });

  const rows = [];
  for (const it of raw.items) {
    rows.push({
      // external_id が無いスタッフも DB に保存できるよう "name:<name>" 形式の
      // 代替キーを生成 (将来 SB 側から ID が取れるようになったら上書きされる)
      external_id: String(
        it.external_id || `name:${(it.name || '').slice(0, 64)}`
      ),
      name: cleanText(it.name) ?? it.name,
      position: cleanText(it.position),
      designation_fee: parseYen(it.designation_fee_raw),
      catch_phrase: cleanText(it.catch_phrase),
      bio: null,
      photo_url: it.photo_url ? absoluteUrl(it.photo_url) : null,
      is_published: true,
    });
  }
  return {
    rows,
    debug: {
      itemsFound: raw.items.length,
      parsed: rows.length,
      skipped: 0,
      totalLinks: raw.totalLinks,
      totalRows: raw.totalRows,
      methodCContainers: raw.methodCContainers ?? 0,
      methodDImgTrs: raw.methodDImgTrs ?? 0,
      methodDExtracted: raw.methodDExtracted ?? 0,
      methodDSamples: raw.methodDSamples ?? [],
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

  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    // 記事カードは table 行 or .blog-item 系
    const candidates = Array.from(
      document.querySelectorAll(
        'table tbody tr, [class*="blog" i] li, [class*="blogItem" i], article',
      ),
    );
    const items = [];
    for (const node of candidates) {
      const titleEl =
        node.querySelector('a[href*="blogDetail"], a[href*="blog/"]') ||
        node.querySelector('.blog-title, h2, h3, .ttl');
      const title = txt(titleEl);
      if (!title || title.length < 2 || title.length > 200) continue;
      const link =
        node.querySelector('a[href*="blogDetail"], a[href*="blog/"]') || node.querySelector('a[href]');
      const dateText =
        txt(node.querySelector('[class*="date" i], time')) ||
        (txt(node).match(/(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2})/) || [])[1];
      const author = txt(node.querySelector('[class*="author" i], [class*="staff" i]'));
      const cover = node.querySelector('img');
      const category = txt(node.querySelector('[class*="cat" i], [class*="genre" i]'));
      const viewText = txt(node).match(/(\d{1,6})\s*view/i);
      const excerpt = txt(node.querySelector('[class*="excerpt" i], [class*="body" i], p'));
      items.push({
        external_id:
          attr(node, 'data-blog-id') ||
          attr(link, 'data-id') ||
          (attr(link, 'href') || '').match(/(?:blogId|articleId)=([\w-]+)/)?.[1] ||
          (attr(link, 'href') || '').match(/blog\/.*?(\d+)/)?.[1] ||
          title.slice(0, 32),
        title,
        link_href: attr(link, 'href'),
        body_excerpt: excerpt || null,
        cover_image_url: attr(cover, 'src') || attr(cover, 'data-src') || null,
        category: category || null,
        author_name: author || null,
        date_raw: dateText || null,
        view_raw: viewText ? viewText[1] : null,
      });
    }
    // 重複除去
    const seen = new Set();
    const unique = [];
    for (const i of items) {
      if (seen.has(i.external_id)) continue;
      seen.add(i.external_id);
      unique.push(i);
    }
    return { items: unique };
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
      is_published: true,
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
        // 本文 HTML を 200,000 文字でカット (DB 圧縮)
        r.body_html = String(detail.html).slice(0, 200_000);
        // excerpt が空なら本文先頭を抜粋として保存
        if (!r.body_excerpt && detail.text) {
          r.body_excerpt = String(detail.text).slice(0, 280);
        }
        // 投稿日時がまだ取れていなければ詳細ページから補う
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
      skipped: raw.items.length - rows.length,
      detailHit,
      detailMiss,
      detailAttempted: targets.length,
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
  scrapeBlogs,
  scrapeShifts,
  scrapeCustomerDetails,
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
