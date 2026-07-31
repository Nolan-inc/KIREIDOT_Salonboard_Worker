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

function testGuardWaitsForOriginalResultBeforeTimeoutCallback() {
  const source = readFileSync(require.resolve('./worker.ts'), 'utf8');
  assert.match(
    source,
    /const handlerOutcome[\s\S]*Promise\.race\(\[handlerOutcome, timeout\]\)/,
    'the timeout guard must keep the original handler promise so it can be settled safely',
  );
  assert.match(
    source,
    /const settledAfterKill = await Promise\.race\([\s\S]{0,160}handlerOutcome[\s\S]{0,160}graceTimeout[\s\S]{0,500}TIMEOUT_RECOVERED/,
    'after closing Chrome, the guard must wait for and accept the original callback result',
  );
  assert.match(
    source,
    /TIMEOUT_RECOVERED[\s\S]{0,500}_guardTimedOutJobs\.set\(job\.id/,
    'late-callback suppression must only begin after the original handler misses its grace period',
  );
  assert.match(
    source,
    /isGuardTimeoutReport[\s\S]*reportError\.includes\("\[JOB_TIMEOUT\]"\)/,
    'the final guard timeout callback must pass through late-callback suppression',
  );
}

function testKnownSalonBoardRecoveryBranchesStayEnabled() {
  const source = readFileSync(require.resolve('./electron/scrapers.cjs'), 'utf8');
  const cloudSource = readFileSync(require.resolve('./worker.ts'), 'utf8');
  const pcWorkerSource = readFileSync(require.resolve('./electron/worker-process.cjs'), 'utf8');
  const pcFallbackGateMigration = readFileSync(
    require.resolve('./supabase/migrations/20260727171841_gate_pc_fallback_on_compatible_worker.sql'),
    'utf8',
  );
  const photoCloudMigration = readFileSync(
    require.resolve('./supabase/migrations/20260728005416_route_photo_style_jobs_to_cloud.sql'),
    'utf8',
  );
  const bookingStatusMigration = readFileSync(
    require.resolve('./supabase/migrations/20260728124500_enrich_booking_status_and_recover_cloud_writes.sql'),
    'utf8',
  );
  const historicalSyncMigration = readFileSync(
    require.resolve('./supabase/migrations/20260731154951_sync_past_booking_writes_and_staff_mapping.sql'),
    'utf8',
  );
  const cancelHydrationMigration = readFileSync(
    require.resolve('./supabase/migrations/20260731162519_hydrate_cancel_booking_jobs.sql'),
    'utf8',
  );
  assert.match(
    source,
    /start <= startTotal && end >= endTotal && actualTitle === norm\(title\)/,
    'merged schedule blocks must count as confirmed when they contain the requested interval',
  );
  assert.match(
    source,
    /matchedStartMin[\s\S]{0,900}hh:\s*String\(matchedStartHour\)/,
    'schedule deletion must verify the exact block selected from the grid, including containing blocks',
  );
  assert.match(
    source,
    /isDayOff && start <= startTotal && end >= endTotal[\s\S]{0,120}found = true/,
    'a SalonBoard day-off covering the requested block must be idempotent success',
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
    /readStableScheduleToken[\s\S]{0,2200}stableReads >= 3[\s\S]{0,300}Date\.now\(\) - startedAt >= 225[\s\S]{0,800}waitForTimeout\(75\)/,
    'new bookings must settle the Ajax-updated rlastupdate token without a long staff-selector wait',
  );
  assert.match(
    source,
    /readStableRlastupdate[\s\S]{0,1800}stableReads >= 3[\s\S]{0,300}Date\.now\(\) - startedAt >= 225[\s\S]{0,800}waitForTimeout\(75\)/,
    'schedule blocks must settle the Ajax-updated rlastupdate token before opening the registration form',
  );
  assert.match(
    source,
    /readStableRlastupdate[\s\S]{0,900}token\.waitFor\(\{ state: 'attached', timeout: 8_000 \}\)[\s\S]{0,900}'value' in el/,
    'schedule blocks must not age a hidden rlastupdate token while waiting for visibility',
  );
  assert.match(
    source,
    /formAttempt <= 5/,
    'schedule blocks must retry stale form opens inside one Cloud attempt',
  );
  assert.match(
    source,
    /scheduleWriteAttempt < 5/,
    'schedule blocks must retry stale submits inside one Cloud attempt',
  );
  assert.match(
    source,
    /更新競合\(KPCL017V01\)[\s\S]{0,260}'SB_SERVER_ERROR'/,
    'exhausted schedule optimistic-lock conflicts must remain transient',
  );
  assert.match(
    source,
    /partial coverage[\s\S]{0,500}register uncovered/,
    'partially covered schedule blocks must register only the uncovered interval',
  );
  assert.match(
    source,
    /partialCoverageCompleted:\s*true/,
    'split uncovered schedule intervals must report idempotent completion',
  );
  assert.match(
    source,
    /schedule-token=\$\{rlastupdate\}[\s\S]{0,120}ageMs=/,
    'new booking failures must record rlastupdate age for optimistic-lock diagnosis',
  );
  assert.match(
    source,
    /schedTry === 1 && genre !== 'hair'[\s\S]{0,700}`\$\{ROOT\}\/top\/`[\s\S]{0,500}continue/,
    'new booking must restore KLP page context when schedule token is missing after reserve-list preflight',
  );
  assert.match(
    source,
    /if \(!rlastupdate \|\| staleTokenRetry % 2 === 1\)/,
    'new booking must alternate an official schedule token with a current-time fallback across stale retries',
  );
  assert.doesNotMatch(
    source,
    /readStableScheduleToken[\s\S]{0,900}waitForSelector\([\s\S]{0,300}scheduleMainHead/,
    'new bookings must not age rlastupdate while waiting for a shop-specific staff selector',
  );
  assert.match(
    source,
    /readStableScheduleToken[\s\S]{0,1200}getAttribute\('value'\)/,
    'rlastupdate reading must support both text and input value variants',
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
    /予約者連絡先\|連絡先\|電話番号[\s\S]{0,2200}if \(next\)[\s\S]{0,600}tel\.value = next/,
    'booking changes must restore a displayed HotPepper phone when present without requiring an optional phone',
  );
  assert.doesNotMatch(
    source,
    /customer_phone_missing_at_submit/,
    'an empty optional phone must not force ext booking updates back through the placeholder-restoring click path',
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
    /formSubmit\(form\.id \|\| 'extReserveChange', 'doComplete'\)/,
    'KLP booking updates must submit synchronously before placeholder blur restores empty names',
  );
  assert.match(
    source,
    /officialSubmitStarted[\s\S]{0,1600}HTMLFormElement\.prototype\.submit\.call\(form\)/,
    'schedule registration must use a native form POST when SalonBoard jQuery submit is silently blocked',
  );
  assert.match(
    source,
    /clampedAtSalonClose[\s\S]{0,700}endTotal = selectedEndTotal/,
    'schedule blocks extending past SalonBoard closing time must clamp to the representable closing boundary',
  );
  assert.match(
    source,
    /preSubmitNameRepair[\s\S]*orgNmSeiKana[\s\S]*orgNmMeiKana/,
    'required customer names must be repaired again immediately before submit',
  );
  assert.match(
    source,
    /warningResubmitted[\s\S]*warnArea[\s\S]*formSubmit\(form\.id \|\| 'extReserveChange', 'doComplete'\)/,
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
    pcWorkerSource,
    /normalizeConfirmedRegistrationCallback[\s\S]{0,900}id_unverified:\s*true/,
    'the desktop callback boundary must normalize legacy confirmed registrations to success',
  );
  assert.match(
    pcWorkerSource,
    /isConfirmedRegistrationWithoutReserveId\(msg\)\) return/,
    'the desktop worker must suppress legacy false-failure Slack notifications',
  );
  assert.match(
    pcFallbackGateMigration,
    /last_seen_at >= now\(\) - interval '2 minutes'[\s\S]{0,500}>= \(0, 2, 231\)/,
    'PC fallback must require a fresh compatible desktop worker',
  );
  assert.match(
    pcFallbackGateMigration,
    /not v_compatible_pc_online[\s\S]{0,1800}executor = 'playwright_cloud'[\s\S]{0,900}run_at = now\(\) \+ interval '1 minute'/,
    'Cloud failures must remain in Cloud while no compatible PC is online',
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
  assert.match(
    source,
    /if \(staleToken\)[\s\S]{0,700}KPCL017V01[\s\S]{0,300}'SB_SERVER_ERROR'[\s\S]{0,80}false/,
    'exhausted KPCL017V01 optimistic-lock conflicts must remain retryable on the selected executor',
  );
  assert.match(
    source,
    /document\.body\?\.innerText[\s\S]{0,120}slice\(0, 1000\)/,
    'SalonBoard error diagnostics must retain enough text to classify a trailing KPCL017V01 code',
  );
  assert.doesNotMatch(
    source,
    /KPCL017V01[\s\S]{0,120}最新情報からCloudで全工程を再試行/,
    'the shared scraper must not claim a Cloud retry when the selected executor is the shop PC',
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
  const scraperSource = readFileSync(require.resolve('./electron/scrapers.cjs'), 'utf8');
  assert.match(
    scraperSource,
    /const stillOnGroupTop[\s\S]{0,180}stillOnGroupTop && opts\.genre !== 'hair'/,
    'hair group-salon selection must validate the management context even when AJAX leaves the URL on groupTop',
  );
  assert.match(
    scraperSource,
    /const hairSalonOpts = \{ \.\.\.opts, baseUrl, genre: 'hair' \}[\s\S]{0,1800}ensureSalonSelected\(page, hairSalonOpts\)/,
    'hair style posting must always enable the hair management-context validation',
  );
  assert.match(
    scraperSource,
    /async function changeBookingViaForm[\s\S]{0,26000}const wantedEquipExtId[\s\S]{0,8000}equipSelect\.selectOption/,
    'booking updates must re-apply the KIREIDOT equipment assignment to SalonBoard',
  );
  assert.match(
    scraperSource,
    /expectedPersistedEquipName[\s\S]{0,32000}readReservationEquipmentName\(page, reserveId,[\s\S]{0,10000}設備の保存をSalonBoard予約詳細で確認できませんでした/,
    'booking updates with equipment must verify the persisted SalonBoard detail before reporting success',
  );
  assert.match(
    scraperSource,
    /persistedEquipmentAssignment[\s\S]{0,5000}\^\(\?:YE\|BE\)\\d\+\$[\s\S]{0,1200}actualEquipName = persistedEquipmentAssignment\.matched\.name/,
    'booking updates must accept only SalonBoard-issued persisted equipment assignments as the detail fallback',
  );
  assert.match(
    scraperSource,
    /waitForLoadState\('networkidle'[\s\S]{0,7000}equipmentSelect\.value = equipmentValue[\s\S]{0,1200}formSubmit\(form\.id \|\| 'extReserveChange', 'doComplete'\)/,
    'booking updates must re-apply equipment after availability Ajax and in the same turn as form submission',
  );
  assert.match(
    scraperSource,
    /a#mailEntry:visible[\s\S]{0,18000}form\.id === 'reserveChange'[\s\S]{0,300}net_reservation_requires_official_button/,
    'HotPepper network reservations must use the official mailEntry change flow instead of direct doComplete submission',
  );
  assert.match(
    scraperSource,
    /errorCandidate = bodyHead[\s\S]{0,300}ハイフンなしで入力してください[\s\S]{0,450}operationStateLost/,
    'static no-hyphen helper text must not be misclassified as a booking validation error',
  );
  assert.match(
    scraperSource,
    /ブログ確認画面が空レスポンス[\s\S]{0,300}'SB_SERVER_ERROR'[\s\S]{0,80}!blankResponse/,
    'blank SalonBoard blog responses must remain retryable infrastructure failures',
  );
  assert.match(
    scraperSource,
    /startsAtOrAfterSalonClose[\s\S]{0,1200}'SLOT_NOT_AVAILABLE'[\s\S]{0,80}true/,
    'schedule blocks starting after SalonBoard closing time must stop as a deterministic business conflict',
  );
  assert.match(
    scraperSource,
    /equipment_reset_before_submit[\s\S]{0,900}'EQUIPMENT_FULL',[\s\S]{0,40}true/,
    'deterministic equipment conflicts must stop immediately for manual resolution instead of retrying Cloud',
  );
  assert.match(
    pcWorkerSource,
    /ensureSalonSelected\(page,[\s\S]{0,240}genre:\s*jobGenre[\s\S]{0,120}baseUrl/,
    'PC photo/style jobs must use the same resilient group-salon selection as Cloud',
  );
  assert.match(
    pcWorkerSource,
    /postPhotoGalleryViaForm\(page, payload,[\s\S]{0,220}genre:\s*jobGenre/,
    'PC photo/style posting must propagate the shop genre to salon selection',
  );
  assert.match(
    cloudSource,
    /postPhotoGalleryViaForm\(page, job\.payload,[\s\S]{0,220}genre,/,
    'Cloud photo/style posting must propagate the shop genre to salon selection',
  );
  assert.match(
    photoCloudMigration,
    /including[\s\S]{0,80}push_photo_gallery[\s\S]{0,500}new\.executor := 'playwright_cloud'/,
    'the database boundary must route normal photo/style reflection jobs to Cloud',
  );
  assert.match(
    photoCloudMigration,
    /where job_type = 'push_photo_gallery'[\s\S]{0,120}status in \('queued', 'running', 'retryable_failed'\)/,
    'unfinished legacy PC photo/style jobs must be recovered to Cloud',
  );
  assert.doesNotMatch(
    cloudSource,
    /isTerminalBookingUpdate[\s\S]{0,900}status:\s*"cancelled"/,
    'completed/no-show/past booking writes must not be silently discarded',
  );
  assert.match(
    cloudSource,
    /isInfraTransientError\(result\.errorCode, result\.reason\)/,
    'push booking retries must classify transient failures using both code and reason',
  );
  assert.match(
    cloudSource,
    /has been closed\|ProcessSingleton\|profile directory\.\*in use/,
    'persistent Chrome profile locks must kill the orphan process and retry once',
  );
  assert.match(
    cloudSource,
    /pwInput\.waitFor\(\{ state: "visible", timeout: 15_000 \}\)/,
    'Cloud login must wait for delayed password fields',
  );
  assert.match(
    cloudSource,
    /missingInputState\.imageAuth[\s\S]{0,200}IMAGE_AUTH_REQUIRED/,
    'a missing password field must distinguish image authentication',
  );
  assert.match(
    source,
    /Number\(responseStatus\) >= 200[\s\S]{0,260}予定削除API受理済み/,
    'a 2xx schedule-delete response must survive a browser-close verification failure',
  );
  assert.match(
    source,
    /if \(!onDetail\)[\s\S]{0,500}cancelViaSchedulePopup/,
    'a cancellation redirected to groupTop/login must use the schedule fallback before retrying',
  );
  assert.match(
    source,
    /スケジュール経由の取消も完了できませんでした[\s\S]{0,300}'SB_SERVER_ERROR'[\s\S]{0,40}false/,
    'an unavailable cancellation fallback must remain retryable',
  );
  assert.match(
    source,
    /page\.context\(\)\.newPage\(\)[\s\S]{0,500}readReservationEquipmentName[\s\S]{0,700}変更フォーム設備欄なし・既存割当/,
    'booking changes without an equipment editor must continue when the persisted assignment already matches',
  );
  assert.match(
    cloudSource,
    /result\.errorCode === "SB_UPLOAD_HELD"[\s\S]{0,700}status:\s*"deferred"/,
    'Cloud image-upload holds must be deferred instead of recorded as terminal failures',
  );
  assert.match(
    bookingStatusMigration,
    /salonboard_enrich_job_booking_status[\s\S]{0,1600}\{booking_status\}/,
    'queued booking writes must carry the current KIREIDOT booking status',
  );
  assert.match(
    bookingStatusMigration,
    /RECOVER_LEGACY_PC_TO_CLOUD[\s\S]{0,1000}executor = 'playwright'/,
    'unresolved legacy desktop writes must be recovered to the current Cloud worker',
  );
  assert.match(
    historicalSyncMigration,
    /salonboard_enrich_job_booking_status[\s\S]{0,2600}salonboard_staff_external_id[\s\S]{0,800}return new/,
    'job hydration must recover the canonical SalonBoard staff mapping',
  );
  assert.doesNotMatch(
    historicalSyncMigration,
    /TERMINAL_BOOKING_PUSH_SKIPPED|PAST_ORPHAN_RETIRED/,
    'historical synchronization migration must not retire terminal or past writes',
  );
  assert.match(
    historicalSyncMigration,
    /drop trigger if exists trg_zzzzz_deprioritize_past_writes/,
    'past writes must keep the normal retry policy',
  );
  assert.match(
    cancelHydrationMigration,
    /new\.job_type not in \('push_booking', 'cancel_booking'\)[\s\S]{0,2600}'customer_name', v_booking\.customer_name/,
    'cancel retries must hydrate the canonical customer and booking snapshot',
  );
  assert.match(
    pcWorkerSource,
    /const HANDLED_JOB_TYPES = new Set\(\[[\s\S]{0,220}'push_booking'[\s\S]{0,120}'cancel_booking'[\s\S]{0,120}'push_shifts'[\s\S]{0,120}'push_photo_gallery'/,
    'the desktop worker must execute booking, cancel, shift, and photo jobs explicitly routed to PC',
  );
  assert.match(
    pcWorkerSource,
    /\.eq\('job_type', 'push_photo_gallery'\)[\s\S]{0,120}\.eq\('executor', 'playwright'\)/,
    'the desktop fallback poller must ignore all Cloud-authoritative jobs',
  );
  assert.match(
    pcWorkerSource,
    /PC_EXECUTOR_GUARD[\s\S]{0,260}店舗PCの処理対象外です/,
    'an unexpected desktop claim must be rejected without falsely claiming Cloud rerouting',
  );
  assert.doesNotMatch(
    source,
    /remainingHyphenFields[\s\S]{0,1200}\[-‐‑‒–—―ー−\]/,
    'Japanese long-vowel marks must not be reported as contact-field hyphens',
  );
  assert.match(
    source,
    /replace\(\/\[０-９\]\/g/,
    'SalonBoard contact normalization must convert full-width digits before validation',
  );
  assert.match(
    source,
    /digits\.length < 3/,
    'SalonBoard split phone and postal fields must also be normalized',
  );
}

(async () => {
  await testHtmlDeleteConfirmation();
  await testNeverSyncedCancelIsIdempotent();
  testGuardWaitsForOriginalResultBeforeTimeoutCallback();
  testKnownSalonBoardRecoveryBranchesStayEnabled();
  console.log('worker reliability tests: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
