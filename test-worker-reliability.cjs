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
    /preSubmitNameRepair[\s\S]*orgNmSeiKana[\s\S]*orgNmMeiKana/,
    'required customer names must be repaired again immediately before submit',
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
