const { chromium } = require('playwright');
const { createHash } = require('node:crypto');

const APP_VERSION = '0.1.0';

const URLS = {
  bookings: 'https://salonboard.com/KLP/reserve/reserveList/init',
  schedule: 'https://salonboard.com/KLP/schedule/salonSchedule/',
  staff: 'https://salonboard.com/CNK/draft/staffList',
  blogs: 'https://salonboard.com/KLP/blog/blogList/',
};

async function runSalonboardSync(input) {
  const apiUrl = normalizeApiUrl(required(input?.apiUrl, 'apiUrl'));
  const accessToken = required(input?.accessToken, 'accessToken');
  const shopId = required(input?.shopId, 'shopId');
  const targets = normalizeTargets(input?.targets);
  const logs = [];
  const syncedAt = new Date().toISOString();
  const results = {};

  log(logs, `sync started shop=${shopId}`);

  const credentials = await fetchCredentials(apiUrl, accessToken, shopId);
  let browser = null;

  try {
    browser = await launchChromium(input?.showBrowser === true, logs);
    const context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    const page = await context.newPage();

    const loginUrl = credentials.base_url || 'https://salonboard.com/login/';
    const loginResult = await loginSalonboard(page, loginUrl, credentials);
    if (loginResult.status !== 'ok') {
      const reason = loginResult.reason || loginResult.status;
      throw new Error(`SalonBoard login failed: ${reason}`);
    }
    log(logs, 'SalonBoard login ok');

    let staffRows = null;
    if (targets.staff || targets.shifts) {
      try {
        staffRows = await scrapeStaff(page);
        log(logs, `staff scraped count=${staffRows.length}`);
        if (targets.staff) {
          const ingest = await postIngest(apiUrl, accessToken, 'staff-ingest', {
            shop_id: shopId,
            synced_at: syncedAt,
            app_version: APP_VERSION,
            staff: staffRows,
          });
          results.staff = summarizeTarget(staffRows.length, ingest);
        }
      } catch (e) {
        results.staff = errorTarget(e);
        if (targets.staff) log(logs, `staff failed: ${messageOf(e)}`);
      }
    }

    if (targets.bookings) {
      try {
        const bookings = await scrapeBookings(page);
        log(logs, `bookings scraped count=${bookings.length}`);
        const ingest = await postIngest(apiUrl, accessToken, 'ingest', {
          shop_id: shopId,
          synced_at: syncedAt,
          app_version: APP_VERSION,
          bookings,
        });
        results.bookings = summarizeTarget(bookings.length, ingest);
      } catch (e) {
        results.bookings = errorTarget(e);
        log(logs, `bookings failed: ${messageOf(e)}`);
      }
    }

    if (targets.shifts) {
      try {
        const shifts = await scrapeShifts(page, staffRows || []);
        log(logs, `shifts scraped count=${shifts.length}`);
        const ingest = await postIngest(apiUrl, accessToken, 'shift-ingest', {
          shop_id: shopId,
          synced_at: syncedAt,
          app_version: APP_VERSION,
          shifts,
        });
        results.shifts = summarizeTarget(shifts.length, ingest);
      } catch (e) {
        results.shifts = errorTarget(e);
        log(logs, `shifts failed: ${messageOf(e)}`);
      }
    }

    if (targets.blogs) {
      try {
        const blogs = await scrapeBlogs(page);
        log(logs, `blogs scraped count=${blogs.length}`);
        const ingest = await postIngest(apiUrl, accessToken, 'blog-ingest', {
          shop_id: shopId,
          synced_at: syncedAt,
          app_version: APP_VERSION,
          blogs,
        });
        results.blogs = summarizeTarget(blogs.length, ingest);
      } catch (e) {
        results.blogs = errorTarget(e);
        log(logs, `blogs failed: ${messageOf(e)}`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  const ok = Object.values(results).every((r) => !r?.error);
  log(logs, `sync finished ok=${ok}`);

  return {
    ok,
    shopId,
    syncedAt,
    results,
    logs,
  };
}

async function fetchCredentials(apiUrl, accessToken, shopId) {
  const url = `${apiUrl}/api/salonboard/credentials?shop_id=${encodeURIComponent(shopId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-store',
    },
  });
  const json = await safeJson(res);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `credentials failed: ${res.status}`);
  }
  if (!json?.credentials?.login_id || !json?.credentials?.password) {
    throw new Error('SalonBoard credentials are empty');
  }
  return json.credentials;
}

async function launchChromium(showBrowser, logs) {
  const headless = showBrowser ? false : true;
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    log(logs, `bundled Chromium launch failed: ${messageOf(e)}`);
    for (const channel of ['chrome', 'msedge']) {
      try {
        const browser = await chromium.launch({ channel, headless });
        log(logs, `fallback browser launched channel=${channel}`);
        return browser;
      } catch {
        // try next channel
      }
    }
    throw new Error(
      `${messageOf(e)}。Playwright Chromium が未インストールの場合は npm install 後に npx playwright install chromium を実行してください。`,
    );
  }
}

async function postIngest(apiUrl, accessToken, endpoint, payload) {
  const res = await fetch(`${apiUrl}/api/salonboard/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await safeJson(res);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `${endpoint} failed: ${res.status}`);
  }
  return json;
}

async function loginSalonboard(page, loginUrl, credentials) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page);

  if (await hasCaptcha(page)) {
    return { status: 'captcha', reason: 'captcha detected' };
  }

  const idInput = page
    .locator(
      [
        'input[name="userId"]',
        'input[name="user_id"]',
        'input[name="loginId"]',
        'input[name="login_id"]',
        'input[id*="user"]',
        'input[id*="login"]',
        'input[type="text"]',
      ].join(', '),
    )
    .first();
  const pwInput = page
    .locator(
      [
        'input[name="password"]',
        'input[name="pass"]',
        'input[id*="password"]',
        'input[id*="pass"]',
        'input[type="password"]',
      ].join(', '),
    )
    .first();

  try {
    await idInput.fill(credentials.login_id, { timeout: 12_000 });
    await pwInput.fill(credentials.password, { timeout: 12_000 });
  } catch (e) {
    return { status: 'failed', reason: `login inputs not found: ${messageOf(e)}` };
  }

  const submit = page
    .locator(
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("ログイン")',
        'input[value*="ログイン"]',
        'a:has-text("ログイン")',
      ].join(', '),
    )
    .first();

  try {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {}),
      submit.click({ timeout: 12_000 }),
    ]);
    await settle(page);
  } catch (e) {
    return { status: 'failed', reason: `login submit failed: ${messageOf(e)}` };
  }

  if (await hasCaptcha(page)) {
    return { status: 'captcha', reason: 'captcha detected after submit' };
  }

  const stillHasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
  if (stillHasPassword > 0 || /login/i.test(page.url())) {
    const body = await bodyText(page);
    return {
      status: 'failed',
      reason: summarizeText(body) || 'still on login page',
    };
  }
  return { status: 'ok' };
}

async function scrapeBookings(page) {
  await gotoSalonboard(page, URLS.bookings);
  await clickOptional(page, [
    'input[type="submit"][value*="検索"]',
    'button:has-text("検索する")',
    'input[value*="検索する"]',
    'a:has-text("検索する")',
  ]);
  await settle(page);

  const text = await bodyText(page);
  const pageDate = parseFirstDate(text) || todayPartsJst();
  const tables = await extractTables(page);
  const bookings = [];

  for (const table of tables) {
    let headers = [];
    for (const row of table.rows) {
      const cells = row.cells.map((c) => normalizeText(c.text || c.inputs.join(' ')));
      if (isHeaderRow(cells)) {
        headers = cells;
        continue;
      }
      const rowText = normalizeText(row.text || cells.join(' '));
      if (!looksLikeBookingRow(rowText, cells)) continue;

      const scheduledAt = parseDateTime(rowText, pageDate);
      if (!scheduledAt) continue;

      const externalId =
        findExternalId(rowText, row.hrefs) || stableId(`booking:${scheduledAt}:${rowText}`);
      const customerName =
        pickByHeader(cells, headers, /お客様|顧客|氏名|名前|カナ/) ||
        parseLabel(rowText, /お客様名|顧客名|氏名|名前/) ||
        pickNameCandidate(cells);

      bookings.push({
        external_id: externalId,
        scheduled_at: scheduledAt,
        duration_min: parseDuration(rowText),
        customer_name: customerName,
        customer_code: parseCustomerCode(rowText),
        customer_phone: parsePhone(rowText),
        customer_email: parseEmail(rowText),
        menu_name:
          pickByHeader(cells, headers, /メニュー|クーポン|コース/) ||
          parseLabel(rowText, /メニュー|クーポン|コース/),
        amount: parseMoney(rowText),
        status: parseBookingStatus(rowText),
        staff_name:
          pickByHeader(cells, headers, /スタッフ|担当|施術者/) ||
          parseLabel(rowText, /スタッフ|担当|施術者/),
        reservation_route:
          pickByHeader(cells, headers, /予約経路|経路|媒体/) ||
          parseReservationRoute(rowText),
        payment_method_label:
          pickByHeader(cells, headers, /支払|決済|会計/) ||
          parseLabel(rowText, /支払方法|決済|会計/),
        coupon_name:
          pickByHeader(cells, headers, /クーポン/) || parseLabel(rowText, /クーポン/),
        notes: compactNotes(rowText),
      });
    }
  }

  return uniqueBy(bookings, (b) => b.external_id);
}

async function scrapeStaff(page) {
  await gotoSalonboard(page, URLS.staff);
  const tables = await extractTables(page);
  const staff = [];

  for (const table of tables) {
    let headers = [];
    for (const row of table.rows) {
      const cells = row.cells.map((c) => normalizeText(c.text || c.inputs.join(' ')));
      if (isHeaderRow(cells)) {
        headers = cells;
        continue;
      }
      const rowText = normalizeText(row.text || cells.join(' '));
      if (!looksLikeStaffRow(rowText, cells)) continue;

      const name =
        pickByHeader(cells, headers, /氏名|名前|スタッフ/) ||
        pickStaffName(cells, rowText);
      if (!name) continue;

      const externalId = findExternalId(rowText, row.hrefs) || stableId(`staff:${name}`);
      const position =
        pickByHeader(cells, headers, /職種|肩書|役職|ポジション/) ||
        pickPosition(cells, name);
      const catchPhrase = pickCatchPhrase(cells, name, position);
      const photoUrl = row.images.find((src) => !/no[_-]?photo|blank/i.test(src)) || null;

      staff.push({
        external_id: externalId,
        name,
        position,
        designation_fee: parseDesignationFee(rowText),
        catch_phrase: catchPhrase,
        bio: catchPhrase,
        photo_url: photoUrl,
        is_published: !/非掲載中|掲載する/.test(rowText) || /非掲載にする/.test(rowText),
      });
    }
  }

  return uniqueBy(staff, (s) => s.external_id);
}

async function scrapeShifts(page, staffRows) {
  await gotoSalonboard(page, URLS.schedule);
  await settle(page);

  const text = await bodyText(page);
  const date = parseFirstDate(text) || todayPartsJst();
  const hours = extractHours(text);
  const startTime = hours.length ? `${pad2(Math.min(...hours))}:00` : '10:00';
  const endTime = hours.length ? `${pad2(Math.max(...hours) + 1)}:00` : '19:00';
  const staffByName = new Map();
  for (const s of staffRows || []) {
    staffByName.set(normalizeName(s.name), s.external_id);
  }

  const names = await scrapeScheduleNames(page, text);
  return names
    .filter((name) => !/ベッド|予約数|受付可能数|合計|設備/.test(name))
    .map((name) => ({
      staff_external_id: staffByName.get(normalizeName(name)) || stableId(`staff:${name}`),
      staff_name: name,
      shift_date: formatDateParts(date),
      start_time: startTime,
      end_time: endTime,
      is_off: false,
      note: 'SalonBoard schedule page inferred',
    }));
}

async function scrapeBlogs(page) {
  await gotoSalonboard(page, URLS.blogs);
  await settle(page);

  const tables = await extractTables(page);
  const blogs = [];

  for (const table of tables) {
    let headers = [];
    for (const row of table.rows) {
      const cells = row.cells.map((c) => normalizeText(c.text || c.inputs.join(' ')));
      if (isHeaderRow(cells)) {
        headers = cells;
        continue;
      }
      const rowText = normalizeText(row.text || cells.join(' '));
      if (!looksLikeBlogRow(rowText, cells)) continue;

      const title =
        pickByHeader(cells, headers, /タイトル|件名/) ||
        pickBlogTitle(cells);
      if (!title) continue;

      blogs.push({
        external_id: findExternalId(rowText, row.hrefs) || stableId(`blog:${title}:${rowText}`),
        title,
        body_excerpt: pickExcerpt(cells, title),
        body_html: null,
        cover_image_url: row.images.find((src) => !/spacer|blank|no[_-]?image/i.test(src)) || null,
        category: pickByHeader(cells, headers, /カテゴリ/) || parseLabel(rowText, /カテゴリ/),
        author_external_id: null,
        author_name:
          pickByHeader(cells, headers, /投稿者|著者|スタッフ|最終更新者/) ||
          parseLabel(rowText, /投稿者|著者|スタッフ|最終更新者/),
        posted_at: parseDateTime(rowText, parseFirstDate(rowText) || todayPartsJst()),
        is_published: !/非公開|下書き|未公開/.test(rowText),
        view_count: parseViewCount(rowText),
        url: row.hrefs.find((href) => /blog/i.test(href)) || null,
      });
    }
  }

  return uniqueBy(blogs, (b) => b.external_id);
}

async function gotoSalonboard(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page);
  if (/login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0) {
    throw new Error('SalonBoard session expired or navigation returned to login');
  }
}

async function clickOptional(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    try {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
        locator.click({ timeout: 5_000 }),
      ]);
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
}

async function hasCaptcha(page) {
  return (await page.locator('iframe[src*="recaptcha"], textarea[name="g-recaptcha-response"]').count().catch(() => 0)) > 0;
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
}

async function extractTables(page) {
  return page.evaluate(() => {
    const readText = (el) =>
      (el.innerText || el.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return Array.from(document.querySelectorAll('table'))
      .map((table, tableIndex) => {
        const rows = Array.from(table.querySelectorAll('tr'))
          .map((tr, rowIndex) => {
            const cells = Array.from(tr.querySelectorAll('th,td')).map((cell) => ({
              tag: cell.tagName.toLowerCase(),
              text: readText(cell),
              hrefs: Array.from(cell.querySelectorAll('a[href]')).map((a) => a.href),
              images: Array.from(cell.querySelectorAll('img[src]')).map((img) => img.src),
              inputs: Array.from(cell.querySelectorAll('input,button,select'))
                .map((input) => input.value || input.textContent || input.getAttribute('name') || input.id || '')
                .map((v) => String(v).trim())
                .filter(Boolean),
            }));
            return {
              rowIndex,
              text: readText(tr),
              cells,
              hrefs: Array.from(tr.querySelectorAll('a[href]')).map((a) => a.href),
              images: Array.from(tr.querySelectorAll('img[src]')).map((img) => img.src),
            };
          })
          .filter((r) => r.text || r.cells.some((c) => c.text || c.hrefs.length || c.images.length || c.inputs.length));
        return { tableIndex, rows };
      })
      .filter((t) => t.rows.length > 0);
  });
}

async function scrapeScheduleNames(page, pageText) {
  const fromDom = await page.evaluate(() => {
    const candidates = [];
    const selectors = [
      'table tr',
      '[class*="staff"]',
      '[class*="Staff"]',
      '[class*="schedule"]',
      '[id*="staff"]',
      '[id*="schedule"]',
    ];
    const readText = (el) => (el.innerText || el.textContent || '').trim();
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const text = readText(el);
        if (text) candidates.push(text);
      }
    }
    return candidates;
  }).catch(() => []);

  const names = new Set();
  const source = [...fromDom, pageText].join('\n');
  const lines = source
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/受付可能数/.test(line)) {
      const inline = line.replace(/受付可能数\s*[:：]?\s*\d+/g, '').trim();
      if (isScheduleName(inline)) names.add(inline);
      const prev = lines[i - 1];
      if (isScheduleName(prev)) names.add(prev);
    }
    const first = line.split(/\s+/)[0];
    if (isScheduleName(first) && /受付可能数|10:00|11:00|12:00|13:00|14:00|15:00|16:00|17:00|18:00|19:00/.test(line)) {
      names.add(first);
    }
  }
  return Array.from(names);
}

function normalizeTargets(targets) {
  return {
    bookings: targets?.bookings !== false,
    staff: targets?.staff !== false,
    shifts: targets?.shifts !== false,
    blogs: targets?.blogs !== false,
  };
}

function normalizeApiUrl(url) {
  return String(url).replace(/\/+$/, '');
}

function required(value, name) {
  const v = String(value ?? '').trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function summarizeTarget(scraped, ingest) {
  return {
    scraped,
    received: Number(ingest?.received ?? scraped),
    inserted: Number(ingest?.inserted ?? 0),
    updated: Number(ingest?.updated ?? 0),
    errors: Array.isArray(ingest?.errors) ? ingest.errors : [],
  };
}

function errorTarget(e) {
  return {
    scraped: 0,
    inserted: 0,
    updated: 0,
    error: messageOf(e),
  };
}

function log(logs, message) {
  logs.push(`[${new Date().toISOString()}] ${message}`);
}

function messageOf(e) {
  return e instanceof Error ? e.message : String(e);
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function summarizeText(text) {
  return normalizeText(text).split('\n').slice(0, 3).join(' / ').slice(0, 240);
}

function isHeaderRow(cells) {
  const text = cells.join(' ');
  if (!text) return false;
  return /予約番号|来店日|ステータス|お客様|スタッフ写真|氏名|職種|タイトル|カテゴリ|投稿者|画像\(1枚目\)/.test(text);
}

function looksLikeBookingRow(rowText, cells) {
  if (!rowText || rowText.length < 8) return false;
  if (/ショートカット検索|条件をクリア|検索する|ステータス\s*[:：]/.test(rowText)) return false;
  if (!/\d{1,2}:\d{2}/.test(rowText)) return false;
  return /予約|来店|施術|お客様|顧客|円|￥|スタッフ|クーポン|メニュー/.test(rowText) || cells.length >= 4;
}

function looksLikeStaffRow(rowText, cells) {
  if (!rowText || rowText.length < 2) return false;
  if (/スタッフ一覧|新規追加|変更内容を登録|表示プラン|PickUp|スタッフ写真/.test(rowText)) return false;
  if (/No\.\s*\d+|詳細|非掲載|削除|no photo/i.test(rowText)) return true;
  return cells.some((c) => isHumanName(c));
}

function looksLikeBlogRow(rowText, cells) {
  if (!rowText || rowText.length < 2) return false;
  if (/該当するブログが\s*0|ブログ一覧|新規投稿|投稿者追加|絞込み/.test(rowText)) return false;
  if (/タイトル|カテゴリ|投稿者|ステータス|詳細|削除/.test(rowText) && cells.length <= 4) return false;
  return /公開|非公開|下書き|ブログ|詳細|削除|\d{4}年|\d{4}\/\d{1,2}\/\d{1,2}/.test(rowText) || cells.length >= 3;
}

function pickByHeader(cells, headers, regex) {
  const idx = headers.findIndex((h) => regex.test(h));
  if (idx < 0) return null;
  return cleanCellValue(cells[idx]);
}

function parseLabel(text, labelRegex) {
  const re = new RegExp(`${labelRegex.source}\\s*[:：]?\\s*([^\\n]+)`);
  const m = text.match(re);
  if (!m) return null;
  return cleanCellValue(m[1]);
}

function cleanCellValue(value) {
  const v = normalizeText(value);
  if (!v) return null;
  if (/^(詳細|削除|変更|登録|検索|クリア|要確認|No\.\s*\d+|-|─|no photo)$/i.test(v)) return null;
  return v.slice(0, 500);
}

function findExternalId(text, hrefs) {
  const labeled = text.match(/(?:予約番号|予約ID|顧客ID|スタッフID|ブログID|ID)\s*[:：]?\s*([A-Za-z0-9_-]{3,})/i);
  if (labeled) return labeled[1];
  for (const href of hrefs || []) {
    const decoded = safeDecode(href);
    const m = decoded.match(/[?&](?:reserveId|reservationId|reserveNo|staffId|staffCd|blogId|id)=([^&#]+)/i);
    if (m) return m[1];
    const pathId = decoded.match(/\/([A-Za-z0-9_-]{6,})(?:[/?#]|$)/);
    if (pathId) return pathId[1];
  }
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function stableId(seed) {
  return `local_${createHash('sha1').update(seed).digest('hex').slice(0, 20)}`;
}

function parseFirstDate(text) {
  const ymd = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (ymd) return { year: Number(ymd[1]), month: Number(ymd[2]), day: Number(ymd[3]) };
  const slash = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (slash) return { year: Number(slash[1]), month: Number(slash[2]), day: Number(slash[3]) };
  const md = text.match(/(?:^|\s)(\d{1,2})[/-](\d{1,2})(?:\s|$)/);
  if (md) {
    return { ...todayPartsJst(), month: Number(md[1]), day: Number(md[2]) };
  }
  return null;
}

function parseDateTime(text, fallbackDate) {
  const date = parseFirstDate(text) || fallbackDate;
  const time = text.match(/([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/);
  if (!date || !time) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  return toUtcIsoFromJst(date.year, date.month, date.day, hour, minute);
}

function todayPartsJst() {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function toUtcIsoFromJst(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0)).toISOString();
}

function formatDateParts(date) {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseDuration(text) {
  const m = text.match(/(\d{1,3})\s*分/);
  return m ? Number(m[1]) : null;
}

function parseMoney(text) {
  const m = text.match(/(?:[￥¥]\s*([0-9,]+)|([0-9,]+)\s*円)/);
  const value = m?.[1] ?? m?.[2];
  return value ? Number(value.replace(/,/g, '')) : null;
}

function parseDesignationFee(text) {
  const m = text.match(/(?:指名料|料金|費用)\s*[:：]?\s*[￥¥]?\s*([0-9,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseCustomerCode(text) {
  const m = text.match(/(?:顧客番号|顧客コード|会員番号|会員No\.?|お客様番号)\s*[:：]?\s*([A-Za-z0-9_-]{4,})/);
  return m ? m[1] : null;
}

function parsePhone(text) {
  const m = text.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
  return m ? m[0] : null;
}

function parseEmail(text) {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function parseBookingStatus(text) {
  if (/無断キャンセル|無断キャンセル/.test(text)) return 'no_show';
  if (/キャンセル|取消|お断り/.test(text)) return 'cancelled';
  if (/済み|会計済|来店処理済|施術済|完了/.test(text)) return 'completed';
  if (/仮予約|確定待ち|受付待ち|pending/i.test(text)) return 'pending';
  return 'confirmed';
}

function parseReservationRoute(text) {
  const m = text.match(/(ネット予約|電話予約|店頭予約|HPB|ホットペッパー|サロンボード|自社予約)/);
  return m ? m[1] : null;
}

function parseViewCount(text) {
  const m = text.match(/(?:閲覧|PV|view)\s*[:：]?\s*([0-9,]+)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function extractHours(text) {
  const hours = new Set();
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):00\b/g)) {
    const hour = Number(m[1]);
    if (hour >= 5 && hour <= 23) hours.add(hour);
  }
  return Array.from(hours);
}

function pickNameCandidate(cells) {
  return cells
    .map(cleanCellValue)
    .find((c) => c && isHumanName(c) && !/\d{1,2}:\d{2}|円|予約|メニュー|クーポン/.test(c)) || null;
}

function pickStaffName(cells, rowText) {
  const byCell = cells
    .map(cleanCellValue)
    .find((c) => c && isHumanName(c) && !/スキンケア|アドバイザ|スタイリスト|詳細|削除|掲載/.test(c));
  if (byCell) return byCell;
  const m = rowText.match(/No\.\s*\d+\s+([A-Za-zぁ-んァ-ヶ一-龠ー・\s]{2,30})/);
  return m ? normalizeText(m[1]) : null;
}

function pickPosition(cells, name) {
  return cells
    .map(cleanCellValue)
    .find((c) => c && c !== name && /スタイリスト|アドバイザ|ネイリスト|アイリスト|店長|マネージャ|セラピスト|美容師|施術者/.test(c)) || null;
}

function pickCatchPhrase(cells, name, position) {
  return cells
    .map(cleanCellValue)
    .filter((c) => c && c !== name && c !== position)
    .find((c) => c.length >= 8 && !/詳細|削除|掲載|要確認|No\./.test(c)) || null;
}

function pickBlogTitle(cells) {
  return cells
    .map(cleanCellValue)
    .find((c) => c && c.length >= 2 && !/詳細|削除|公開|非公開|下書き|ステータス|投稿者|画像/.test(c)) || null;
}

function pickExcerpt(cells, title) {
  return cells
    .map(cleanCellValue)
    .filter((c) => c && c !== title)
    .find((c) => c.length >= 20 && !/詳細|削除|公開|非公開|下書き/.test(c)) || null;
}

function compactNotes(text) {
  const lines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/詳細|削除|変更|登録|検索|クリア/.test(line));
  return lines.slice(0, 8).join(' / ').slice(0, 1000) || null;
}

function isHumanName(value) {
  const v = normalizeText(value);
  if (!v || v.length > 40) return false;
  if (/[0-9￥¥:：]/.test(v)) return false;
  if (/予約|検索|詳細|削除|登録|変更|掲載|受付可能数|no photo|PickUp/i.test(v)) return false;
  return /[A-Za-zぁ-んァ-ヶ一-龠]/.test(v);
}

function isScheduleName(value) {
  const v = normalizeText(value);
  if (!isHumanName(v)) return false;
  if (/SALON|BOARD|RECRUIT|ヘルプ|アラート|スケジュール|予約一覧|受付可能数|予約数/.test(v)) return false;
  return v.length <= 30;
}

function normalizeName(value) {
  return normalizeText(value).replace(/\s+/g, '').toLowerCase();
}

function uniqueBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return Array.from(map.values());
}

module.exports = {
  runSalonboardSync,
};
