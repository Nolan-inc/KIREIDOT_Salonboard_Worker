// =====================================================================
// 予約同期くん: Electron utilityProcess として動くマルチショップ・スクレイパー
//
// 設計:
//   - main.cjs から utilityProcess.fork で起動される
//   - parent (main.cjs) から start/stop/sync メッセージを受け取る
//   - Supabase Auth セッション (access_token / refresh_token) を渡してもらい、
//     super_owner / admin として salonboard_reveal_credentials を呼ぶ
//   - Playwright Chromium で店舗ごとにログイン → 各チャネルをスクレイピング
//   - 結果は salonboard_bulk_upsert_bookings / staff / shifts / blogs RPC で保存
//   - 進捗イベントは postMessage で parent に送る
//
// スクレイピング本体 (4 URL の DOM パース) は Phase 3 で実装する。
// 本ファイルでは「マルチ店舗のループ・ログイン・進捗通知」の枠組みを用意。
// =====================================================================

const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');
const {
  scrapeBookings,
  scrapeStaff,
  scrapeBlogs,
  scrapeCustomerDetails,
} = require('./scrapers.cjs');

let supabase = null;
let running = false;
let abortRequested = false;
let currentBrowser = null;

function emit(type, payload) {
  try {
    process.parentPort?.postMessage({ type, payload });
  } catch (_e) {
    /* parent が居ない場合は無視 */
  }
}

function log(msg, level = 'info') {
  emit('log', { level, msg, at: new Date().toISOString() });
  // 開発時の確認用に stdout にも出しておく
  console.log(`[worker:${level}] ${msg}`);
}

async function initSupabase({ url, anonKey, accessToken, refreshToken }) {
  supabase = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  // 親プロセス (renderer/main) で取得したセッションをそのまま注入する。
  // これで RLS が super_owner / admin として評価される。
  await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
}

/**
 * 同期対象の店舗一覧を取得 (enabled かつ未ブロック)。
 *  - shopIds が指定されている場合はその店舗だけ
 */
async function fetchTargets(shopIds) {
  let q = supabase
    .from('salonboard_credentials_overview')
    .select('organization_id, organization_name, shop_id, shop_name, has_credential, enabled, blocked_until');
  q = q.eq('has_credential', true);
  if (Array.isArray(shopIds) && shopIds.length > 0) {
    q = q.in('shop_id', shopIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(`fetchTargets: ${error.message}`);
  const now = Date.now();
  return (data ?? []).filter((r) => {
    if (!r.enabled) return false;
    if (r.blocked_until && new Date(r.blocked_until).getTime() > now) return false;
    return true;
  });
}

async function revealCredentials(shopId) {
  const { data, error } = await supabase.rpc('salonboard_reveal_credentials', {
    p_shop_id: shopId,
  });
  if (error) throw new Error(`reveal: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) throw new Error('credentials not found');
  return {
    loginId: row.login_id,
    password: row.password,
    baseUrl: row.base_url ?? 'https://salonboard.com/login/',
  };
}

/**
 * 1 店舗ぶんの同期処理 (Phase 2 ではログインまでで return)。
 * Phase 3 で予約一覧/予約管理/スタッフ/ブログのスクレイピングを足す。
 */
async function processShop(target, channels, runId) {
  const { shop_id: shopId, shop_name: shopName, organization_name: orgName } = target;
  emit('shop:start', { shopId, shopName, orgName, channels });
  const counts = { bookings: 0, staff: 0, blogs: 0, customers: 0 };

  let creds;
  try {
    creds = await revealCredentials(shopId);
  } catch (e) {
    emit('shop:end', { shopId, ok: false, error: `credentials: ${e.message}` });
    await recordShopRun(runId, shopId, false, null, `credentials: ${e.message}`, counts);
    return { ok: false };
  }

  const browser = await chromium.launch({ headless: true });
  currentBrowser = browser;
  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    const page = await ctx.newPage();

    emit('shop:progress', { shopId, step: 'login', msg: `${creds.baseUrl} に接続中` });
    const r = await tryLogin(page, creds);
    if (r.status === 'captcha') {
      // 6 時間ブロック
      const blockedUntil = new Date(Date.now() + 6 * 3600_000).toISOString();
      await markCredentialError(shopId, 'captcha_detected', blockedUntil);
      emit('shop:end', { shopId, ok: false, error: 'reCAPTCHA を検知しました (6 時間ブロック)' });
      await recordShopRun(runId, shopId, false, null, 'captcha_detected', counts);
      return { ok: false };
    }
    if (r.status === 'failed') {
      await markCredentialError(shopId, r.reason ?? 'login_failed', null);
      emit('shop:end', { shopId, ok: false, error: r.reason ?? 'ログイン失敗' });
      await recordShopRun(runId, shopId, false, null, r.reason ?? 'login_failed', counts);
      return { ok: false };
    }
    emit('shop:progress', { shopId, step: 'login', msg: 'ログイン成功' });

    // ---- スクレイピング本体 (channels で選択された分だけ) ----
    const channelSet = new Set(channels);
    const summary = [];

    if (channelSet.has('bookings')) {
      try {
        emit('shop:progress', { shopId, step: 'bookings', msg: '予約一覧を取得中…' });
        const { rows, debug } = await scrapeBookings(page);
        const sent = await sendBookings(shopId, rows);
        counts.bookings = sent;
        summary.push(`予約 ${sent}/${rows.length}件 (検出${debug.itemsFound})`);
        emit('shop:progress', { shopId, step: 'bookings', msg: `予約 ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] bookings scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('staff')) {
      try {
        emit('shop:progress', { shopId, step: 'staff', msg: 'スタッフ一覧を取得中…' });
        const { rows } = await scrapeStaff(page);
        const sent = await sendStaff(shopId, rows);
        counts.staff = sent;
        summary.push(`スタッフ ${sent} 件`);
        emit('shop:progress', { shopId, step: 'staff', msg: `スタッフ ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] staff scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('blog')) {
      try {
        emit('shop:progress', { shopId, step: 'blog', msg: 'ブログを取得中…' });
        const { rows } = await scrapeBlogs(page);
        const sent = await sendBlogs(shopId, rows);
        counts.blogs = sent;
        summary.push(`ブログ ${sent} 件`);
        emit('shop:progress', { shopId, step: 'blog', msg: `ブログ ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] blog scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('customers')) {
      try {
        emit('shop:progress', { shopId, step: 'customers', msg: '顧客詳細を取得中…' });
        const { rows } = await scrapeCustomerDetails(page, { maxCustomers: 50 });
        const sent = await sendCustomerDetails(shopId, rows);
        counts.customers = sent;
        summary.push(`顧客 ${sent} 件マージ`);
        emit('shop:progress', { shopId, step: 'customers', msg: `顧客 ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] customer detail scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    // shifts (salonSchedule) は Phase 5 で実装
    // if (channelSet.has('shifts')) { ... }

    await markCredentialSuccess(shopId);
    const summaryStr = summary.length > 0 ? summary.join(' / ') : 'login ok';
    emit('shop:end', { shopId, ok: true, summary: summaryStr });
    await recordShopRun(runId, shopId, true, summaryStr, null, counts);
    return { ok: true };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markCredentialError(shopId, errMsg, null);
    emit('shop:end', { shopId, ok: false, error: errMsg });
    await recordShopRun(runId, shopId, false, null, errMsg, counts);
    return { ok: false };
  } finally {
    await browser.close().catch(() => {});
    currentBrowser = null;
  }
}

/** salonboard_run_record_shop RPC を呼び、店舗単位の結果を Supabase に保存 */
async function recordShopRun(runId, shopId, ok, summary, error, counts) {
  if (!runId) return;
  try {
    await supabase.rpc('salonboard_run_record_shop', {
      p_run_id: runId,
      p_shop_id: shopId,
      p_ok: ok,
      p_summary: summary,
      p_error: error,
      p_bookings_count: counts?.bookings ?? 0,
      p_staff_count: counts?.staff ?? 0,
      p_blogs_count: counts?.blogs ?? 0,
      p_customers_count: counts?.customers ?? 0,
    });
  } catch (_e) {
    /* 履歴記録失敗は致命的でないので無視 */
  }
}

async function tryLogin(page, c) {
  try {
    await page.goto(c.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    return { status: 'failed', reason: `navigation: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: 'captcha' };
  }

  const idInput = page
    .locator('input[name="userId"], input[name="loginId"], input[type="text"]')
    .first();
  const pwInput = page
    .locator('input[name="password"], input[type="password"]')
    .first();

  try {
    await idInput.fill(c.loginId, { timeout: 10_000 });
    await pwInput.fill(c.password, { timeout: 10_000 });
  } catch (e) {
    return {
      status: 'failed',
      reason: `cannot find login inputs: ${e instanceof Error ? e.message : e}`,
    };
  }

  try {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {}),
      page
        .locator('button[type="submit"], input[type="submit"]')
        .first()
        .click({ timeout: 10_000 }),
    ]);
  } catch (e) {
    return { status: 'failed', reason: `submit: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: 'captcha' };
  }

  const stillOnLogin =
    (await pwInput.count()) > 0 || /login/i.test(page.url());
  if (stillOnLogin) {
    return { status: 'failed', reason: 'still on login page' };
  }
  return { status: 'ok' };
}

/**
 * 予約スクレイプ結果を salonboard_bulk_upsert_bookings RPC に流す。
 * 戻り値は実際に送信した行数 (バリデーション NG 行は除外)。
 */
async function sendBookings(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  // external_id / scheduled_at が無い行はサーバー側 RPC で弾かれるのでここでも除外
  const valid = rows.filter((r) => r.external_id && r.scheduled_at);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_bookings', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_bookings: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function sendStaff(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.name);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_staff', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_staff: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

/**
 * 顧客詳細スクレイプ結果を customers_resolve_or_upsert RPC で 1 件ずつマージ。
 * 既存の customers レコード (external_source='salonboard' + external_customer_id=customer_code)
 * があれば update、無ければ insert される (DB 側 RPC のロジック)。
 */
async function sendCustomerDetails(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  let ok = 0;
  for (const r of rows) {
    if (!r.customer_code || !r.full_name) continue;
    try {
      const { error } = await supabase.rpc('customers_resolve_or_upsert', {
        p_shop_id: shopId,
        p_full_name: r.full_name,
        p_phone_raw: r.phone ?? null,
        p_email: r.email ?? null,
        p_birthday: r.birthday ?? null,
        p_customer_code: r.customer_code,
        p_external_source: 'salonboard',
        p_external_customer_id: r.customer_code,
        p_source: 'imported_salonboard',
        p_notes: null,
      });
      if (!error) ok++;
    } catch (_e) {
      /* 1 件の失敗はスキップしてループ継続 */
    }
  }
  return ok;
}

async function sendBlogs(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.title);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_blogs', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_blogs: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function markCredentialSuccess(shopId) {
  try {
    await supabase
      .from('salonboard_credentials')
      .update({
        last_login_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        last_error: null,
        last_error_at: null,
        consecutive_failures: 0,
        blocked_until: null,
      })
      .eq('shop_id', shopId);
  } catch (_e) {
    // RLS 上で更新できない場合は無視 (super_owner なら通る想定)
  }
}

async function markCredentialError(shopId, reason, blockedUntil) {
  try {
    // consecutive_failures はインクリメントしたいので、いったん最新値を取得して +1
    const { data: cur } = await supabase
      .from('salonboard_credentials')
      .select('consecutive_failures')
      .eq('shop_id', shopId)
      .maybeSingle();
    const next = (cur?.consecutive_failures ?? 0) + 1;
    const update = {
      last_error: String(reason).slice(0, 500),
      last_error_at: new Date().toISOString(),
      consecutive_failures: next,
    };
    if (blockedUntil) update.blocked_until = blockedUntil;
    await supabase.from('salonboard_credentials').update(update).eq('shop_id', shopId);
  } catch (_e) {
    /* ignore */
  }
}

async function runSync({ shopIds, channels, source }) {
  if (running) {
    emit('error', { msg: '同期は既に実行中です' });
    return;
  }
  running = true;
  abortRequested = false;
  let runId = null;
  try {
    const targets = await fetchTargets(shopIds);
    // run を Supabase に記録開始
    try {
      const { data, error } = await supabase.rpc('salonboard_run_start', {
        p_channels: channels ?? [],
        p_source: source ?? 'desktop',
      });
      if (!error) runId = data;
    } catch (_e) {
      /* 記録できなくても同期は続行 */
    }
    emit('run:start', { total: targets.length, channels, runId });

    let okCount = 0;
    let ngCount = 0;
    for (const t of targets) {
      if (abortRequested) {
        emit('log', { level: 'warn', msg: 'ユーザー操作により中断' });
        break;
      }
      const r = await processShop(t, channels, runId);
      if (r.ok) okCount++; else ngCount++;
    }

    // run の終了を記録
    if (runId) {
      try {
        await supabase.rpc('salonboard_run_finish', {
          p_run_id: runId,
          p_total: targets.length,
          p_ok: okCount,
          p_ng: ngCount,
          p_aborted: abortRequested,
        });
      } catch (_e) {
        /* ignore */
      }
    }

    emit('run:end', {
      total: targets.length,
      ok: okCount,
      ng: ngCount,
      aborted: abortRequested,
      runId,
    });
  } catch (e) {
    emit('error', { msg: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
    abortRequested = false;
  }
}

// メッセージハンドリング
process.parentPort?.on('message', async (event) => {
  const m = event?.data ?? event;
  if (!m || typeof m !== 'object') return;
  try {
    switch (m.type) {
      case 'init':
        await initSupabase(m.payload);
        emit('ready', { ok: true });
        break;
      case 'sync':
        await runSync(m.payload ?? {});
        break;
      case 'abort':
        abortRequested = true;
        await currentBrowser?.close().catch(() => {});
        break;
      default:
        log(`unknown message type: ${m.type}`, 'warn');
    }
  } catch (e) {
    emit('error', { msg: e instanceof Error ? e.message : String(e) });
  }
});

emit('boot', { pid: process.pid, at: new Date().toISOString() });
