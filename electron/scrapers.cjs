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
 * JST 文字列 "YYYY/MM/DD HH:mm" や "YYYY-MM-DD HH:mm" を ISO 8601 (UTC) に変換。
 * 日付だけの場合は 00:00 として扱う。
 */
function parseJstDateTime(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  // "2025/05/23 14:30" / "2025-05-23 14:30" / "2025/05/23"
  const m = s.match(
    /^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  if (!m) return null;
  const [, y, mm, dd, hh, mi] = m;
  const Y = Number(y);
  const M = Number(mm) - 1;
  const D = Number(dd);
  const H = hh ? Number(hh) : 0;
  const Mi = mi ? Number(mi) : 0;
  // JST -> UTC: UTC = JST - 9h
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
 * 予約一覧をスクレイピングして bookings 行を返す。
 * 予約はテーブル or リスト形式のいずれか想定。
 */
async function scrapeBookings(page) {
  await page.goto(RESERVE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // ページ内検索: 「予約番号」「予約日時」を含むテーブルがあれば認識
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  const raw = await page.evaluate(() => {
    function txt(el) {
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }
    function attr(el, name) {
      return el ? el.getAttribute(name) : null;
    }
    // テーブル候補: thead/th に「予約日時」「お客様」「メニュー」を含む table
    const tables = Array.from(document.querySelectorAll('table'));
    let target = null;
    for (const t of tables) {
      const ths = Array.from(t.querySelectorAll('th, thead td')).map((e) => (e.textContent || '').trim());
      const flat = ths.join(' ');
      if (/予約|お客様|メニュー|来店|スタッフ/.test(flat)) {
        target = t;
        break;
      }
    }
    if (!target) return { items: [], html: document.title };

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

    const rows = Array.from(target.querySelectorAll('tbody tr'));
    const items = rows
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        if (tds.length === 0) return null;
        // 予約詳細リンクから external_id を取得
        const link =
          tr.querySelector('a[href*="reserveDetail"], a[href*="reservation"]') ||
          tr.querySelector('a[href]');
        return {
          datetime_raw: idx.datetime >= 0 ? txt(tds[idx.datetime]) : txt(tds[0]),
          customer_raw: idx.customer >= 0 ? txt(tds[idx.customer]) : '',
          menu_raw: idx.menu >= 0 ? txt(tds[idx.menu]) : '',
          staff_raw: idx.staff >= 0 ? txt(tds[idx.staff]) : '',
          amount_raw: idx.amount >= 0 ? txt(tds[idx.amount]) : '',
          duration_raw: idx.duration >= 0 ? txt(tds[idx.duration]) : '',
          status_raw: idx.status >= 0 ? txt(tds[idx.status]) : '',
          route_raw: idx.route >= 0 ? txt(tds[idx.route]) : '',
          coupon_raw: idx.coupon >= 0 ? txt(tds[idx.coupon]) : '',
          payment_raw: idx.payment >= 0 ? txt(tds[idx.payment]) : '',
          link_href: attr(link, 'href'),
          row_text: txt(tr),
        };
      })
      .filter(Boolean);
    return { items };
  });

  const rows = [];
  let skipped = 0;
  for (const it of raw.items) {
    const scheduled_at = parseJstDateTime(it.datetime_raw);
    if (!scheduled_at) {
      skipped++;
      continue;
    }
    const external_id =
      extractIdFromUrl(it.link_href, 'reservationId', 'reserveId', 'rsvId') ||
      // フォールバック: 日時 + 顧客名 (店舗内ユニークになる前提)
      `${it.datetime_raw}|${it.customer_raw}`.replace(/\s+/g, '_');

    // ステータスは日本語ラベル → enum 文字列
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
      staff_external_id: null,
      reservation_route: cleanText(it.route_raw) || null,
      payment_method_label: cleanText(it.payment_raw) || null,
      coupon_name: cleanText(it.coupon_raw) || null,
      notes: null,
    });
  }
  return { rows, debug: { itemsFound: raw.items.length, parsed: rows.length, skipped } };
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
    // スタッフカードは div/li 単位で並んでいる想定。
    // 名前を含むテキスト要素 + 写真 + 編集リンクを持つブロックを抽出。
    const candidates = Array.from(
      document.querySelectorAll(
        '[class*="staff" i], [data-staff-id], li.staffItem, .staff-list-item, table tr',
      ),
    );
    const items = [];
    for (const node of candidates) {
      const nameEl =
        node.querySelector('[class*="name" i]') ||
        node.querySelector('h2, h3, .ttl, .staff-name');
      const name = txt(nameEl) || (txt(node).split('\n')[0] ?? '').trim();
      if (!name || name.length > 40) continue;
      const photo = node.querySelector('img');
      const link =
        node.querySelector('a[href*="staffDetail"], a[href*="staff"]') || node.querySelector('a[href]');
      const positionEl = node.querySelector('[class*="position" i], [class*="role" i]');
      const catchEl = node.querySelector('[class*="catch" i], [class*="message" i]');
      const feeText = (txt(node).match(/指名料\s*([¥\d,]+)/) || [])[1];
      items.push({
        external_id:
          attr(node, 'data-staff-id') ||
          attr(node, 'id') ||
          (attr(link, 'href') || '').match(/(?:staffId|stylistId)=([\w-]+)/)?.[1] ||
          name, // 最終フォールバック: 名前を ID にする
        name,
        position: txt(positionEl),
        catch_phrase: txt(catchEl),
        photo_url: attr(photo, 'src') || attr(photo, 'data-src') || null,
        designation_fee_raw: feeText || null,
      });
    }
    // 重複除去 (external_id + name で一意化)
    const seen = new Set();
    const unique = [];
    for (const i of items) {
      const k = `${i.external_id}|${i.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(i);
    }
    return { items: unique };
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
      is_published: true,
    });
  }
  return {
    rows,
    debug: { itemsFound: raw.items.length, parsed: rows.length, skipped: raw.items.length - rows.length },
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

async function scrapeBlogs(page) {
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
  return {
    rows,
    debug: { itemsFound: raw.items.length, parsed: rows.length, skipped: raw.items.length - rows.length },
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

module.exports = {
  scrapeBookings,
  scrapeStaff,
  scrapeBlogs,
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
