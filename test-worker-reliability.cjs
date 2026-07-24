const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { chromium } = require('playwright');
const {
  deleteScheduleViaForm,
  cancelBookingViaForm,
} = require('./electron/scrapers.cjs');

async function testHtmlDeleteConfirmation() {
  // CI/開発Macのどちらでも、worker本番と同じシステムChromeを使う。
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let deleted = false;
  let deletePosts = 0;

  await page.route('http://sb.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/KLP/set/scheduleChange/delete') {
      deletePosts += 1;
      deleted = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    if (url.pathname === '/KLP/schedule/salonSchedule/') {
      const block = deleted ? '' : `
        <div class="jscScheduleToDo">
          <span class="todoTitle">店舗MTG</span>
          <p class="scheduleTimeZoneSetting">["18:00", "19:30"]</p>
        </div>`;
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `
        <div class="scheduleMainHead" id="STAFF_W009_20260728">minori</div>
        <div class="jscScheduleMainTableStaff">
          <div class="scheduleMainTableLine">${block}</div>
        </div>
        <div class="scheduleReservation" style="position:fixed;inset:0;z-index:100">
          <ul class="scheduleReserveIconList"><li>予約overlay</li></ul>
        </div>
        <div class="mod_popup_02 js_yotei" style="display:none">
          <a id="change" href="/KLP/set/scheduleChange/">予定変更</a>
        </div>
        <script>
          document.querySelector('.jscScheduleToDo')?.addEventListener('click', () => {
            document.querySelector('.js_yotei').style.display = 'block';
          });
        </script>` });
      return;
    }
    if (url.pathname === '/KLP/set/scheduleChange/') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `
        <form id="scheduleChange">
          <input id="jsiSchDate" value="20260728">
          <select id="jsiStartTimeHour"><option selected>18</option></select>
          <select id="jsiStartTimeMinute"><option selected>00</option></select>
          <select name="staffId"><option selected>W009</option></select>
          <a id="delete" href="javascript:void(0)">削除する</a>
        </form>
        <div class="buttons" id="old-hidden" style="display:none"><a class="accept">はい</a></div>
        <div class="buttons" id="confirm" style="display:none"><a class="accept">はい</a></div>
        <script>
          document.querySelector('#delete').addEventListener('click', () => {
            document.querySelector('#confirm').style.display = 'block';
          });
          document.querySelector('#confirm .accept').addEventListener('click', async () => {
            await fetch('/KLP/set/scheduleChange/delete', { method: 'POST' });
            location.href = '/KLP/top/';
          });
        </script>` });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>ok</p>' });
  });

  const result = await deleteScheduleViaForm(page, {
    scheduled_at: '2026-07-28T09:00:00.000Z',
    block_reason: '店舗MTG',
    staff_name: 'minori',
    // KD側に古いexternal_idが残っていても、一意な表示名から現在の列を復元する。
    salonboard_staff_external_id: 'W001',
  }, { baseUrl: 'http://sb.test/', enableDelete: true });

  const debug = result.status === 'ok'
    ? result
    : { result, url: page.url(), html: (await page.content()).slice(0, 2500) };
  assert.equal(result.status, 'ok', JSON.stringify(debug));
  assert.equal(deletePosts, 1, 'visible confirmation must submit exactly once');
  assert.equal(deleted, true);
  await browser.close();
}

async function testNeverSyncedCancelIsIdempotent() {
  const result = await cancelBookingViaForm({}, {
    external_booking_id: null,
    scheduled_at: null,
    assume_absent_if_never_synced: true,
  }, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.alreadyAbsent, true);
}

function testGuardTimeoutCallbackIsNotSuppressed() {
  const source = readFileSync(require.resolve('./worker.ts'), 'utf8');
  assert.match(
    source,
    /isGuardTimeoutReport[\s\S]*reportError\.includes\("\[JOB_TIMEOUT\]"\)/,
    'the guard timeout callback must pass through late-callback suppression',
  );
}

function testKnownSalonBoardRecoveryBranchesStayEnabled() {
  const source = readFileSync(require.resolve('./electron/scrapers.cjs'), 'utf8');
  const cloudSource = readFileSync(require.resolve('./worker.ts'), 'utf8');
  assert.match(
    source,
    /start <= startTotal && end >= endTotal && actualTitle === norm\(title\)/,
    'merged schedule blocks must count as confirmed when they contain the requested interval',
  );
  assert.match(
    source,
    /extReserveDetail\/\?reserveId=/,
    'booking changes must fall back through the reservation detail page',
  );
  assert.match(
    source,
    /_kd_token/,
    'rlastupdate must be fetched from a cache-busted schedule page',
  );
  assert.match(
    source,
    /invalidLastKana[\s\S]*\(\?:シ\|セイ\|姓/,
    'SalonBoard surname-kana placeholders must be replaced before booking updates',
  );
  assert.match(
    source,
    /invalidFirstKana[\s\S]*\(\?:メイ\|名/,
    'SalonBoard first-name-kana placeholders must be replaced before booking updates',
  );
  assert.match(
    source,
    /classList\.remove\('mod_color_999999'\)/,
    'SalonBoard placeholder styling must be removed together with placeholder values',
  );
  assert.match(
    source,
    /jQuery\(el\)\.removeData\('empty'\)/,
    'SalonBoard jQuery placeholder state must be cleared before booking updates',
  );
  assert.match(
    source,
    /formSubmit\('extReserveChange', 'doComplete'\)/,
    'KLP booking updates must submit synchronously before placeholder blur restores empty names',
  );
  assert.match(
    source,
    /officialSubmitStarted[\s\S]{0,1600}HTMLFormElement\.prototype\.submit\.call\(form\)/,
    'schedule registration must use a native form POST when SalonBoard jQuery submit is silently blocked',
  );
  assert.match(
    source,
    /preSubmitNameRepair[\s\S]*orgNmSeiKana[\s\S]*orgNmMeiKana/,
    'required customer names must be repaired again immediately before submit',
  );
  assert.match(
    source,
    /warningResubmitted[\s\S]*warnArea[\s\S]*formSubmit\('extReserveChange', 'doComplete'\)/,
    'SalonBoard equipment warnings must resubmit synchronously without restoring name placeholders',
  );
  assert.match(
    source,
    /warning_not_confirmed_/,
    'an unconfirmed SalonBoard warning must not be reported as a successful booking update',
  );
  assert.match(
    source,
    /idUnverified:\s*true[\s\S]{0,240}登録完了を確認済み/,
    'PC scraper must treat a confirmed registration without reserveId as success',
  );
  assert.match(
    cloudSource,
    /idUnverified:\s*true[\s\S]{0,240}登録完了を確認済み/,
    'Cloud worker must treat a confirmed registration without reserveId as success',
  );
  assert.doesNotMatch(
    `${source}\n${cloudSource}`,
    /登録の完了サインは出ましたが\s*reserveId\s*を確認できませんでした/,
    'the legacy false-failure message must not return from either worker implementation',
  );
  assert.match(
    source,
    /needsLogin:[\s\S]{0,800}画像認証/,
    'the booking-change flow must detect SalonBoard login and image-auth pages',
  );
  assert.match(
    source,
    /\[SESSION_EXPIRED\][\s\S]{0,500}新しいCloudブラウザと出口で全工程を再試行/,
    'a booking update redirected to the SalonBoard login/image-auth page must retry in a fresh Cloud context',
  );
  assert.match(
    source,
    /const establishChangeContext[\s\S]{0,700}\/KLP\/reserve\/reserveList\/init/,
    'booking updates must establish SalonBoard list context before opening deep change/detail URLs',
  );
  assert.match(
    source,
    /for \(let openTry[\s\S]{0,300}await establishChangeContext\(\)[\s\S]{0,500}for \(const path of candidates\)/,
    'each booking-change navigation attempt must establish context before direct URL fallbacks',
  );
  assert.doesNotMatch(
    source,
    /candidateUrl\.searchParams\.set\('_kd'/,
    'booking change URLs must not include unknown cache-busting query parameters rejected by SalonBoard',
  );
  assert.match(
    source,
    /openChangeFormViaReserveList[\s\S]{0,6000}reserveLink\.click[\s\S]{0,5000}onForm = await openChangeFormViaReserveList/,
    'esthetic booking updates must open the real reservation-row link before direct URL fallbacks',
  );
  assert.match(
    cloudSource,
    /INFRA_TRANSIENT_ERROR_CODES[\s\S]{0,220}SESSION_EXPIRED/,
    'session expiry during a Cloud write must remain retryable instead of becoming manual_required',
  );
  assert.doesNotMatch(
    cloudSource,
    /\[relogin\] endpoint cooldown \([\s\S]{0,120}-> skip/,
    'deep-page session recovery must not wait for the obsolete endpoint cooldown',
  );
  assert.match(
    cloudSource,
    /const residentialSpan = residential[\s\S]{0,420}rotationSpan = Math\.max\(pool\.length, residentialSpan\)/,
    'Cloud login retries must rotate residential exits as well as ISP exits',
  );
  assert.match(
    cloudSource,
    /residentialProxyFor[\s\S]{0,620}hashShop\(shopId\) \+ rotation/,
    'residential sticky-port selection must incorporate the per-account retry rotation',
  );
  assert.match(
    cloudSource,
    /ISPログイン障害を検知 → 次のstatic ISPでCloudログインを完全再試行/,
    'Cloud write login failures must retry on another static ISP endpoint',
  );
  assert.doesNotMatch(
    cloudSource,
    /shouldRotateLoginEndpoint[\s\S]{0,900}forceResidential\s*=\s*true/,
    'Cloud write login recovery must not switch to residential exits rejected by SalonBoard',
  );
  assert.doesNotMatch(
    cloudSource,
    /shouldRotateLoginEndpoint[\s\S]{0,900}avoidResidential\s*=\s*false/,
    'Cloud write login recovery must keep residential fallback disabled',
  );
  assert.match(
    cloudSource,
    /accountHasRotated[\s\S]{0,420}!accountHasRotated[\s\S]{0,220}shopOverride/,
    'a rotated account login must bypass the failing shop-level static proxy override',
  );
  const pcWorkerSource = readFileSync(require.resolve('./electron/worker-process.cjs'), 'utf8');
  assert.match(
    pcWorkerSource,
    /ensureSalonSelected\(page,[\s\S]{0,240}genre:\s*jobGenre[\s\S]{0,120}baseUrl/,
    'PC photo/style jobs must use the same resilient group-salon selection as Cloud',
  );
  assert.match(
    pcWorkerSource,
    /const HANDLED_JOB_TYPES = new Set\(\['push_photo_gallery'\]\)/,
    'the desktop worker must only execute the PC-specific photo/style write flow',
  );
  assert.match(
    pcWorkerSource,
    /\.eq\('job_type', 'push_photo_gallery'\)[\s\S]{0,120}\.eq\('executor', 'playwright'\)/,
    'the desktop fallback poller must ignore all Cloud-authoritative jobs',
  );
  assert.match(
    pcWorkerSource,
    /PC_EXECUTOR_GUARD[\s\S]{0,260}Cloud workerへ戻します/,
    'an unexpected non-photo desktop claim must be returned to Cloud instead of cancelled',
  );
  assert.doesNotMatch(
    source,
    /remainingHyphenFields[\s\S]{0,1200}\[-‐‑‒–—―ー−\]/,
    'Japanese long-vowel marks must not be reported as contact-field hyphens',
  );
}

(async () => {
  await testHtmlDeleteConfirmation();
  await testNeverSyncedCancelIsIdempotent();
  testGuardTimeoutCallbackIsNotSuppressed();
  testKnownSalonBoardRecoveryBranchesStayEnabled();
  console.log('worker reliability tests: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
