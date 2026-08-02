const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { chromium } = require('playwright');
const {
  deleteScheduleViaForm,
  cancelBookingViaForm,
  pushStaffViaForm,
  pushMenuViaForm,
  pushCouponViaForm,
  pushEquipmentViaForm,
  scrapeMenus,
  scrapeCoupons,
  _internal,
} = require('./electron/scrapers.cjs');

async function testEquipmentCanCreateAndRecoverSalonBoardIdIdempotently() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let registered = false;

  const equipmentHtml = () => `
    <nav>予約管理 設定</nav>
    <form id="equipListForm">
      <input type="hidden" name="frmEquipListDtoList[0].equipmentId" value="${registered ? 'EQNEW001' : ''}">
      <input name="frmEquipListDtoList[0].equipmentName" value="${registered ? '新規テストベッド' : ''}">
      <select name="frmEquipListDtoList[0].maxRsvNum"><option value="1">1</option></select>
      <input name="frmEquipListDtoList[0].sortNo" value="1">
      <a id="registBtn" href="/CNK/set/equipList/?registered=1">登録</a>
    </form>
    <script>function addRowEquipment() {}</script>`;

  await page.route('http://equipment-create.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('registered') === '1') registered = true;
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: equipmentHtml(),
    });
  });

  const result = await pushEquipmentViaForm(page, {
    create_if_missing: true,
    resource_id: 'internal-resource-id',
    name: '新規テストベッド',
    max_rsv_num: 1,
    sort_no: 1,
  }, { baseUrl: 'http://equipment-create.test/', enablePush: true });

  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.externalId, 'EQNEW001');
  await browser.close();
}

async function testMenuCanCreateIntoBlankSalonBoardSlotIdempotently() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let registered = false;

  const menuHtml = () => `
    <nav>予約管理 掲載管理</nav>
    <form id="menuEditForm" action="/CNK/draft/menuEdit">
      <select name="frmMenuEditMenuDetailList[0].menuCategoryCd"><option value=""></option><option value="MC_OTHER">その他</option></select>
      <select name="frmMenuEditMenuDetailList[0].searchCategoryCd"><option value=""></option><option value="SE_OTHER">その他</option></select>
      <textarea name="frmMenuEditMenuDetailList[0].menuName">${registered ? '新規テストメニュー' : ''}</textarea>
      <textarea name="frmMenuEditMenuDetailList[0].explanation"></textarea>
      <input name="frmMenuEditMenuDetailList[0].price" value="">
      <input name="frmMenuEditMenuDetailList[0].sejyutsuAimTime" value="">
      <input name="frmMenuEditMenuDetailList[0].sortNo" value="1">
      <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="1" checked>
      <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="0">
      <input name="frmMenuEditMenuDetailList[0].menuId" value="${registered ? 'MNEW001' : ''}">
      <a class="jsc_menuEdit_btn_reg" href="/CNK/draft/menuEdit?registered=1">登録</a>
    </form>`;

  await page.route('http://menu-create.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('registered') === '1') registered = true;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: menuHtml() });
  });

  const result = await pushMenuViaForm(page, {
    menu_id: 'internal-kireidot-id',
    create_if_missing: true,
    name: '新規テストメニュー',
    price: 6000,
    duration_min: 60,
    description: '新規同期テスト',
  }, { baseUrl: 'http://menu-create.test/', genre: 'esthetic', enablePush: true });

  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, 'MNEW001');
  assert.equal(result.confirmed.matchedBy, 'blank_slot');
  await browser.close();
}

async function testCouponCanCreateAndRecoverSalonBoardId() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let registered = false;

  const listHtml = () => `
    <nav>予約管理 掲載管理</nav>
    <form id="couponAddForm" action="/CNK/draft/couponEdit" method="post"></form>
    <form id="couponEditForm" action="/CNK/draft/couponEdit" method="post"><input name="couponId" value=""></form>
    ${registered ? `<table><tr><td><input name="frmCouponListDto[0].couponId" value="CPNEW001"><input type="hidden" name="frmCouponListDto[0].presentFlg" value="1"></td><td></td><td>全員</td><td>新規テストクーポン</td><td></td><td></td><td></td><td><a href="#"><img alt="非掲載にする"></a></td></tr></table>` : ''}`;
  const editHtml = (existing = false) => `
    <nav>予約管理 掲載管理</nav>
    <form id="draft_couponEditForm">
      <input type="radio" name="frmCouponEditCnkDto.selectedCpCouponSetting" value="1"><input type="radio" name="frmCouponEditCnkDto.selectedCpCouponSetting" value="0">
      <select name="frmCouponEditCnkDto.selectedCouponTypeCd"><option value=""></option><option value="CT01">全員</option></select>
      <input name="frmCouponEditCnkDto.couponName" value="${existing ? '新規テストクーポン' : ''}">
      <textarea name="frmCouponEditCnkDto.contentExplanation"></textarea>
      <select name="frmCouponEditCnkDto.selectedTeijiJoukenCd"><option value=""></option><option value="TJ01">予約時</option></select>
      <input name="frmCouponEditCnkDto.useCondition" value="">
      <input type="radio" name="frmCouponEditCnkDto.checkedAutoExpiration" value="true" checked>
      <input type="radio" name="frmCouponEditCnkDto.checkedAutoExpiration" value="false">
      <select name="frmCouponEditCnkDto.selectedSchCouponCategory"><option value=""></option><option value="SE_OTHER">その他</option></select>
      <input type="radio" name="frmCouponEditCnkDto.selectedApplyMenu" value="1" checked>
      <input type="checkbox" name="frmCouponEditCnkDto.selectedMenuCategoryCd" value="MC_OTHER">
      <input name="frmCouponEditCnkDto.price" value="">
      <input name="frmCouponEditCnkDto.sejyutsuAimTime" value="">
      <a id="registBtn" href="/CNK/draft/couponList?registered=1">登録</a>
    </form>`;

  await page.route('http://coupon-create.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/couponList')) {
      if (url.searchParams.get('registered') === '1') registered = true;
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: listHtml() });
      return;
    }
    const existing = registered && /couponId=CPNEW001/.test(request.postData() || '');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: editHtml(existing) });
  });

  const result = await pushCouponViaForm(page, {
    menu_id: 'internal-kireidot-id',
    create_if_missing: true,
    name: '新規テストクーポン',
    price: 5000,
    duration_min: 60,
    content: '新規同期テスト',
    is_published: true,
  }, { baseUrl: 'http://coupon-create.test/', genre: 'esthetic', enablePush: true });

  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, 'CPNEW001');
  assert.equal(result.confirmed.createNew, true);
  await browser.close();
}

async function testMenuPublicationStateIsIndependentFromImportActivity() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();

  await page.route('http://menu.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `
        <nav>予約管理 掲載管理</nav>
        <form action="/CNK/draft/menuEdit">
          <input name="frmMenuEditMenuDetailList[0].menuId" value="M001">
          <textarea name="frmMenuEditMenuDetailList[0].menuName">掲載メニュー</textarea>
          <input name="frmMenuEditMenuDetailList[0].price" value="5500">
          <input name="frmMenuEditMenuDetailList[0].sejyutsuAimTime" value="60">
          <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="1" checked>
          <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="0">

          <input name="frmMenuEditMenuDetailList[1].menuId" value="M002">
          <textarea name="frmMenuEditMenuDetailList[1].menuName">非掲載メニュー</textarea>
          <input name="frmMenuEditMenuDetailList[1].price" value="7500">
          <input name="frmMenuEditMenuDetailList[1].sejyutsuAimTime" value="75">
          <input type="radio" name="frmMenuEditMenuDetailList[1].presentFlg" value="1">
          <input type="radio" name="frmMenuEditMenuDetailList[1].presentFlg" value="0" checked>
        </form>`,
    });
  });

  const result = await scrapeMenus(page, {
    baseUrl: 'http://menu.test/',
    genre: 'esthetic',
  });
  assert.deepEqual(
    result.rows.map((row) => ({
      external_id: row.external_id,
      is_active: row.is_active,
      is_published: row.is_published,
    })),
    [
      { external_id: 'M001', is_active: true, is_published: true },
      { external_id: 'M002', is_active: true, is_published: false },
    ],
  );
  await browser.close();
}

async function testMenuPublicationOnlyPushPersistsAndVerifies() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let published = false;

  const menuHtml = () => `
    <nav>予約管理 掲載管理</nav>
    <form id="menuEditForm">
      <input name="frmMenuEditMenuDetailList[0].menuId" value="M-PUBLISH">
      <textarea name="frmMenuEditMenuDetailList[0].menuName">掲載切替メニュー</textarea>
      <input name="frmMenuEditMenuDetailList[0].price" value="5500">
      <input name="frmMenuEditMenuDetailList[0].sejyutsuAimTime" value="60">
      <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="1" ${published ? 'checked' : ''}>
      <input type="radio" name="frmMenuEditMenuDetailList[0].presentFlg" value="0" ${published ? '' : 'checked'}>
      <a class="jsc_menuEdit_btn_reg" href="#" onclick="location.href='/CNK/draft/menuEdit?published='+document.querySelector('[name=&quot;frmMenuEditMenuDetailList[0].presentFlg&quot;]:checked').value;return false;">登録</a>
    </form>`;

  await page.route('http://menu-publication-push.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('published')) published = url.searchParams.get('published') === '1';
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: menuHtml(),
    });
  });

  const result = await pushMenuViaForm(page, {
    external_id: 'M-PUBLISH',
    publication_only: true,
    is_published: true,
  }, {
    baseUrl: 'http://menu-publication-push.test/',
    genre: 'esthetic',
    enablePush: true,
  });

  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.externalId, 'M-PUBLISH');
  assert.equal(published, true);
  assert.equal(result.confirmed.diag.reRead.published, true);
  await browser.close();
}

async function testCouponPublicationStateFromInverseActionLabel() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();

  await page.route('http://coupon.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/couponEdit')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<input name="frmCouponEditCnkDto.couponName" value="詳細"><input name="frmCouponEditCnkDto.price" value="5500"><input name="frmCouponEditCnkDto.sejyutsuAimTime" value="60">',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `
        <nav>予約管理 掲載管理</nav>
        <form id="couponEditForm" action="/CNK/draft/couponEdit" method="post">
          <input name="couponId" value="">
        </form>
        <table>
          <tr>
            <td class="td_value_store_c"><input name="frmCouponListDto[0].couponId" value="C001"><input value="1"></td>
            <td class="td_value_store_c"><img name="couponPhoto" src="published.jpg"></td>
            <td class="td_value_store_c">全員</td><td class="td_value_store_c">掲載クーポン</td><td class="td_value_store_c">なし</td>
            <td class="td_value_store_c">OK</td><td class="td_value_store_c">詳細</td>
            <td class="td_value_store_c"><input type="button" value="非掲載にする"><input type="button" value="削除する"></td>
          </tr>
          <tr>
            <td class="td_value_store_c"><input name="frmCouponListDto[1].couponId" value="C002"><input value="2"></td>
            <td class="td_value_store_c"><img name="couponPhoto" src="unpublished.jpg"></td>
            <td class="td_value_store_c">新規</td><td class="td_value_store_c">非掲載クーポン</td><td class="td_value_store_c">なし</td>
            <td class="td_value_store_c">OK</td><td class="td_value_store_c">詳細</td>
            <td class="td_value_store_c"><img alt="掲載にする" src="publish.gif"><input type="button" value="削除する"></td>
          </tr>
        </table>`,
    });
  });

  const result = await scrapeCoupons(page, {
    baseUrl: 'http://coupon.test/',
    genre: 'esthetic',
  });
  assert.deepEqual(
    result.rows.map((row) => ({
      external_id: row.external_id,
      is_active: row.is_active,
      is_published: row.is_published,
    })),
    [
      { external_id: 'C001', is_active: true, is_published: true },
      { external_id: 'C002', is_active: true, is_published: false },
    ],
  );
  await browser.close();
}

async function testCouponPublicationOnlyPushPersistsAndVerifies() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  let published = false;

  const listHtml = () => `
    <nav>予約管理 掲載管理</nav>
    <form id="couponEditForm"><input name="couponId" value=""></form>
    <table><tr>
      <td><input name="frmCouponListDto[0].couponId" value="C-PUBLISH"><input type="hidden" name="frmCouponListDto[0].presentFlg" value="${published ? '1' : '0'}"></td>
      <td></td><td>全員</td><td>掲載切替クーポン</td><td></td><td>OK</td><td>詳細</td>
      <td><a href="/CNK/draft/couponList?publish=${published ? '0' : '1'}"><img alt="${published ? '非掲載にする' : '掲載にする'}"></a></td>
    </tr></table>`;

  await page.route('http://coupon-publication-push.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('publish')) published = url.searchParams.get('publish') === '1';
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: listHtml(),
    });
  });

  const result = await pushCouponViaForm(page, {
    external_id: 'C-PUBLISH',
    name: '掲載切替クーポン',
    publication_only: true,
    is_published: true,
  }, {
    baseUrl: 'http://coupon-publication-push.test/',
    genre: 'esthetic',
    enablePush: true,
  });

  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.externalId, 'C-PUBLISH');
  assert.equal(published, true);
  assert.equal(result.confirmed.publication.after.published, true);
  await browser.close();
}

async function testExplicitSingleSalonContextAndUnpublishedStaffSort() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  const visited = [];
  let sortSubmits = 0;

  await page.route('http://single.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    visited.push(url.pathname);
    if (request.method() === 'POST') sortSubmits += 1;
    if (url.pathname.includes('/schedule/salonSchedule/')) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `
        <nav>予約管理 掲載管理</nav>
        <main id="scheduleItemArea">スケジュール 予約一覧</main>
        <footer>Une limit Silk【アンリミット シルク】（旧:Une limit 代官山店） H000738520</footer>` });
      return;
    }
    if (url.pathname === '/CNK/draft/staffList') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `
        <form id="staffSortForm">
          <input type="hidden" name="frmStaffListStafferDtoList[0].staffId" value="W001210861">
          <input name="frmStaffListStafferDtoList[0].sortNo" value="" disabled>
          <input type="hidden" name="frmStaffListStafferDtoList[0].presentFlg" value="0">
        </form>` });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>ok</p>' });
  });

  const context = await _internal.ensureReserveSalonContext(page, 'http://single.test/', {
    salonId: null,
    shopName: 'Unelimit Silk　代官山店',
    genre: 'esthetic',
    isGroupAccount: false,
  });
  assert.equal(context.ok, true, JSON.stringify(context));

  const staff = await pushStaffViaForm(page, {
    external_id: 'W001210861',
    sort_no: 5,
    is_published: false,
  }, {
    baseUrl: 'http://single.test/',
    enablePush: true,
    salonId: 'H000623535',
    shopName: 'Unelimit WAO! 新宿店',
    isGroupAccount: false,
  });
  assert.equal(staff.status, 'ok', JSON.stringify(staff));
  assert.equal(staff.confirmed.sortSkippedForUnpublished, true);
  assert.equal(sortSubmits, 0, 'disabled sort order for an unpublished row must not be submitted');
  assert.equal(visited.some((p) => /groupTop/i.test(p)), false, `single account opened groupTop: ${visited.join(',')}`);
  await browser.close();
}

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

async function testScheduleVerificationUsesCoveringTodoNotTitle() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();
  const render = async (body) => page.setContent(`
    <div class="scheduleMainHead" id="STAFF_W000958269_20260806">Hinako</div>
    <div class="jscScheduleMainTableStaff">
      <div class="scheduleMainTableLine">${body}</div>
    </div>
  `);
  const verify = () => page.evaluate(_internal.findScheduleBlockInPage, {
    staffExt: 'W000958269',
    startTotal: 12 * 60 + 30,
    endTotal: 18 * 60 + 30,
    title: '日常業務',
  });

  await render(`
    <div class="jscScheduleToDo">
      <span class="todoTitle">予定あり</span>
      <p class="scheduleTimeZoneSetting">[&quot;12:30&quot;, &quot;18:30&quot;]</p>
    </div>
  `);
  const coveringTodo = await verify();
  assert.equal(coveringTodo.ok, true, JSON.stringify(coveringTodo));
  assert.equal(coveringTodo.matchedBlock.titleMismatch, true);

  await render(`
    <div class="jscScheduleToDo">
      <span class="todoTitle">日常業務</span>
      <p class="scheduleTimeZoneSetting">[&quot;12:30&quot;, &quot;17:30&quot;]</p>
    </div>
  `);
  assert.equal((await verify()).ok, false, 'partial coverage must not be accepted');

  await render(`
    <div class="jscScheduleToDo isDayOff">
      <span class="todoTitle">予定あり</span>
      <p class="scheduleTimeZoneSetting">[&quot;10:00&quot;, &quot;19:00&quot;]</p>
    </div>
  `);
  assert.equal((await verify()).ok, false, 'day off must not be accepted as a business block');

  await render(`
    <div class="scheduleReservation jscScheduleReservation">
      <span class="scheduleReserveName">予約のお客様</span>
      <p class="scheduleTimeZoneSetting">[&quot;12:30&quot;, &quot;18:30&quot;]</p>
    </div>
  `);
  assert.equal((await verify()).ok, false, 'customer reservation must not be accepted as a business block');
  await browser.close();
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
    /AsyncLocalStorage<string>[\s\S]{0,3000}currentExecution === guardTimedOutExecution/,
    'late-callback suppression must be scoped to one execution, because fetch retries reuse the same job id',
  );
  assert.match(
    source,
    /run\(executionToken, \(\) => handleJob\(job\)\)[\s\S]{0,3000}_guardTimedOutJobs\.set\(job\.id, executionToken\)/,
    'each guarded execution must get a distinct token before a timed-out callback is suppressed',
  );
  assert.match(
    source,
    /isGuardTimeoutReport[\s\S]*reportError\.includes\("\[JOB_TIMEOUT\]"\)/,
    'the final guard timeout callback must pass through late-callback suppression',
  );
  assert.match(
    source,
    /function cleanupOldDebugCaptures[\s\S]{0,1800}salonboard-debug[\s\S]{0,1800}rmSync\(capturePath, \{ recursive: true, force: true \}\)[\s\S]{0,900}cleanupOldDebugCaptures\(\)/,
    'Cloud startup must prune expired debug capture directories before disk exhaustion crashes Chrome',
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
  const parityMigration = readFileSync(
    require.resolve('./supabase/migrations/20260731234938_guarantee_schedule_shift_booking_parity.sql'),
    'utf8',
  );
  const staffBackfillMigration = readFileSync(
    require.resolve('./supabase/migrations/20260801000048_backfill_canonical_booking_staff_identity.sql'),
    'utf8',
  );
  assert.match(
    source,
    /if \(start <= startTotal && end >= endTotal\) \{[\s\S]{0,220}titleMismatch:/,
    'covering business schedules must be confirmed by staff and interval even when SalonBoard rewrites the title',
  );
  assert.match(
    source,
    /matchedStartMin[\s\S]{0,900}hh:\s*String\(matchedStartHour\)/,
    'schedule deletion must verify the exact block selected from the grid, including containing blocks',
  );
  assert.doesNotMatch(
    source,
    /isDayOff && start <= startTotal && end >= endTotal[\s\S]{0,120}found = true/,
    'a SalonBoard day-off must not hide a missing KIREIDOT business block',
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
    /readStableRlastupdate[\s\S]{0,1200}jscScheduleMainTableStaff[\s\S]{0,180}timeout: 1_500/,
    'schedule blocks must wait briefly for the Ajax-rendered staff grid before reading rlastupdate',
  );
  assert.match(
    source,
    /formAttempt <= 5/,
    'schedule blocks must retry stale form opens inside one Cloud attempt',
  );
  assert.match(
    source,
    /window\.stop\(\)[\s\S]{0,900}formAttempt % 2 === 1[\s\S]{0,1000}source=\$\{tokenSource\}/,
    'schedule blocks must stop pending Ajax and alternate current/official optimistic-lock tokens',
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
    /KPCL017 grid-drag fallback[\s\S]{0,500}openedByGridDrag/,
    'schedule blocks must fall back to SalonBoard native grid drag when direct registration URLs stay stale',
  );
  assert.match(
    source,
    /conflictError\.scheduleRows = rows[\s\S]{0,8000}erasedScheduleRows[\s\S]{0,12000}pushScheduleViaForm\(page,[\s\S]{0,1600}シフト更新前の予定を自動復元できません/,
    'shift batch fallback must restore SalonBoard-only schedule rows that it temporarily erases',
  );
  assert.doesNotMatch(
    source,
    /partial coverage|partialCoverageCompleted|register uncovered/,
    'partial coverage must not split or falsely complete an exact business block',
  );
  assert.doesNotMatch(
    source,
    /merged\.some\(\(m\) => m\.start <= startTotal && m\.end >= endTotal\)/,
    'unrelated schedules and customer reservations must not satisfy exact block verification',
  );
  assert.match(
    source,
    /const appliedStaff =[\s\S]{0,1800}'CONFIRMATION_MISMATCH'/,
    'booking changes must reject a form that did not accept the requested staff',
  );
  assert.match(
    source,
    /wantStaffExt[\s\S]{0,1800}staffOk[\s\S]{0,900}persistedState\?\.staffOk/,
    'booking updates must re-read and verify the persisted SalonBoard staff',
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
    /readStableScheduleToken[\s\S]{0,1200}jscScheduleMainTableStaff[\s\S]{0,180}timeout: 1_500/,
    'new bookings must wait briefly for the Ajax-rendered staff grid before reading rlastupdate',
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
    /if \(selectedEquipmentValue\)[\s\S]{0,1000}waitForLoadState\('networkidle'[\s\S]{0,12000}equipmentSelect\.value = equipmentValue/,
    'booking updates must wait for availability Ajax before re-applying equipment',
  );
  assert.match(
    scraperSource,
    /equipmentSelect\.value = equipmentValue[\s\S]{0,2200}formSubmit\(form\.id \|\| 'extReserveChange', 'doComplete'\)/,
    'booking updates must re-apply equipment after availability Ajax and in the same turn as form submission',
  );
  assert.match(
    scraperSource,
    /setExact\(estHour, schedule\.hour\)[\s\S]{0,3000}schedule_value_mismatch_at_submit[\s\S]{0,5000}formSubmit\(form\.id \|\| 'extReserveChange', 'doComplete'\)/,
    'booking updates must pin time and duration in the same turn as form submission',
  );
  assert.match(
    scraperSource,
    /a#mailEntry:visible[\s\S]{0,18000}form\.id === 'reserveChange'[\s\S]{0,300}net_reservation_requires_official_button/,
    'HotPepper network reservations must use the official mailEntry change flow instead of direct doComplete submission',
  );
  assert.match(
    scraperSource,
    /a#sendMailConfirm:visible[\s\S]{0,300}a#sendMail:visible[\s\S]{0,2500}finalBtn\.click/,
    'HotPepper network reservation changes must complete both mail confirmation steps',
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
    parityMigration,
    /new\.salonboard_staff_external_id := v_staff_external_id[\s\S]{0,120}new\.salonboard_staff_name := v_staff_name/,
    'staff reassignment must replace stale SalonBoard identity fields',
  );
  assert.match(
    parityMigration,
    /'salonboard_staff_external_id', coalesce\([\s\S]{0,120}v_staff_external_id[\s\S]{0,240}'salonboard_staff_name', coalesce\([\s\S]{0,120}v_staff_name/,
    'job hydration must prioritize the currently assigned staff',
  );
  assert.match(
    parityMigration,
    /salonboard_credentials_catchup_shifts_on_push_enable[\s\S]{0,1200}salonboard_recheck_blocks_after_shift_write/,
    'push re-enable and shift completion must automatically repair skipped shifts and business blocks',
  );
  assert.match(
    staffBackfillMigration,
    /staff_was_mismatched[\s\S]{0,2400}canonical_staff_identity_backfill[\s\S]{0,700}staff_was_mismatched is true[\s\S]{0,1600}salonboard_sync_status = 'pending_push'/,
    'future reservations with stale staff snapshots must be requeued for canonical staff correction',
  );
  assert.match(
    pcWorkerSource,
    /const HANDLED_JOB_TYPES = new Set\(\[[\s\S]{0,220}'push_booking'[\s\S]{0,120}'cancel_booking'[\s\S]{0,120}'push_shifts'[\s\S]{0,120}'push_photo_gallery'/,
    'the desktop worker must execute booking, cancel, shift, and photo jobs explicitly routed to PC',
  );
  assert.match(
    pcWorkerSource,
    /\.in\('job_type', PC_CLAIMABLE_PUSH_JOB_TYPES\)[\s\S]{0,120}\.eq\('executor', 'playwright'\)/,
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
  if (process.env.WORKER_TEST_CASE === 'schedule-verification') {
    await testScheduleVerificationUsesCoveringTodoNotTitle();
    console.log('schedule verification test: ok');
    return;
  }
  if (process.env.WORKER_TEST_CASE === 'menu-publication') {
    await testMenuPublicationStateIsIndependentFromImportActivity();
    await testMenuPublicationOnlyPushPersistsAndVerifies();
    console.log('menu publication test: ok');
    return;
  }
  if (process.env.WORKER_TEST_CASE === 'coupon-publication') {
    await testCouponPublicationStateFromInverseActionLabel();
    await testCouponPublicationOnlyPushPersistsAndVerifies();
    console.log('coupon publication test: ok');
    return;
  }
  if (process.env.WORKER_TEST_CASE === 'menu-coupon-create') {
    await testMenuCanCreateIntoBlankSalonBoardSlotIdempotently();
    await testCouponCanCreateAndRecoverSalonBoardId();
    await testEquipmentCanCreateAndRecoverSalonBoardIdIdempotently();
    console.log('menu/coupon/equipment create tests: ok');
    return;
  }
  await testMenuPublicationStateIsIndependentFromImportActivity();
  await testMenuPublicationOnlyPushPersistsAndVerifies();
  await testCouponPublicationStateFromInverseActionLabel();
  await testCouponPublicationOnlyPushPersistsAndVerifies();
  await testMenuCanCreateIntoBlankSalonBoardSlotIdempotently();
  await testCouponCanCreateAndRecoverSalonBoardId();
  await testEquipmentCanCreateAndRecoverSalonBoardIdIdempotently();
  await testHtmlDeleteConfirmation();
  await testNeverSyncedCancelIsIdempotent();
  await testScheduleVerificationUsesCoveringTodoNotTitle();
  await testExplicitSingleSalonContextAndUnpublishedStaffSort();
  testGuardWaitsForOriginalResultBeforeTimeoutCallback();
  testKnownSalonBoardRecoveryBranchesStayEnabled();
  console.log('worker reliability tests: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
