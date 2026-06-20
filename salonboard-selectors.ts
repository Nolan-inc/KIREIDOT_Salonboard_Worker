/**
 * SalonBoard セレクタレジストリ (push_booking 用).
 *
 * 実 DOM (salonboard_code/*.html, 2026-05-30 取得) から確定したものは `confirmed`、
 * まだ DOM 未取得で推測のものは `pending` としてマークする。
 * pushBooking() は必ずこのレジストリ経由でセレクタを参照し、画面構造が変わったら
 * このファイルだけ直せばよいようにする。
 *
 * 確定済み画面:
 *   - 予約スケジュール   /KLP/schedule/salonSchedule/        (新規予約の起点)
 *   - 予約一覧           /KLP/reserve/reserveList/init        (重複チェック補助)
 *   - 予約詳細           /KLP/reserve/ext/extReserveDetail/?reserveId=YG########
 *   - スタッフ           /CNK/draft/staffList                 (external_id ↔ 名前)
 *
 * ⚠️ 未確定: 「新規予約登録フォーム」本体。
 *   スケジュールの空き枠クリック/ドラッグで開く別画面で、上記キャプチャには
 *   含まれていない。フォーム入力欄・確認/登録ボタンのセレクタは DOM 取得後に
 *   `REGISTER_FORM` を埋める。それまでは pushBooking() がフォームを capture して
 *   manual_required に倒す。
 */

export type SelectorState = "confirmed" | "pending";

export interface Sel {
  /** Playwright セレクタ文字列 (複数候補は "," 区切り or 配列)。 */
  selector: string;
  state: SelectorState;
  note?: string;
}

export const SB_PATHS = {
  /** 予約スケジュール (新規予約の起点)。?date=YYYYMMDD */
  schedule: "/KLP/schedule/salonSchedule/",
  /** 予約一覧 */
  reserveListInit: "/KLP/reserve/reserveList/init",
  /** 予約詳細 (reserveId=YG########) */
  reserveDetail: "/KLP/reserve/ext/extReserveDetail/",
  /** スタッフ一覧 */
  staffList: "/CNK/draft/staffList",
  /**
   * 新規予約登録フォーム (確定: booking_create.html)。
   * ?staffId=W...&date=YYYYMMDD&rsvHour=HH&rsvMinute=MM で直接開ける
   * (スケジュールの空き枠クリック不要)。form#extReserveRegist。
   */
  reserveRegist: "/KLP/reserve/ext/extReserveRegist/",
} as const;

/** schedule?date= 用に Date → YYYYMMDD (JST 前提の値を渡すこと)。 */
export function scheduleUrl(baseUrl: string, yyyymmdd: string): string {
  const u = new URL(SB_PATHS.schedule, baseUrl);
  u.searchParams.set("date", yyyymmdd);
  return u.toString();
}

/**
 * 新規予約登録フォームを直接開く URL。
 * @param yyyymmdd 来店日 (JST)
 * @param hh 開始「時」(0-23)
 * @param mm 開始「分」(00/15/30/45 等、フォームの選択肢に合わせる)
 * @param rlastupdate スケジュール画面 `#rlastupdate` のタイムスタンプ。
 *   これを付けないと登録フォーム (moduleId=KPCL017V01) が
 *   「情報が一部失われています」エラーになる。必ず SCHEDULE.rlastupdate から
 *   取得した値を渡すこと (空文字なら付与しない)。
 */
export function reserveRegistUrl(
  baseUrl: string,
  externalStaffId: string,
  yyyymmdd: string,
  hh: string,
  mm: string,
  rlastupdate?: string,
): string {
  const u = new URL(SB_PATHS.reserveRegist, baseUrl);
  u.searchParams.set("staffId", externalStaffId);
  u.searchParams.set("date", yyyymmdd);
  u.searchParams.set("rsvHour", hh);
  u.searchParams.set("rsvMinute", mm);
  if (rlastupdate) u.searchParams.set("rlastupdate", rlastupdate);
  return u.toString();
}

/** 予約スケジュール画面のセレクタ群 (確定)。 */
export const SCHEDULE = {
  /**
   * グリッド/スケジュール画面が描画されたことを示す指標 (readiness ゲート)。
   * ⚠️ SalonBoard はタイミング/状況で予約スケジュールの DOM 構造が変わる。
   * 2026-05-30 版は `#schedule.jscScheduleMain` だったが、2026-06-21 の実機では
   * グリッド本体が `table.schedule` / `.jscScheduleTimeTable`(#timeFrameHeaderArea) /
   * `#showSchedule` に変わっていた。新旧どちらでも「スケジュール画面に到達した」と
   * 判定できるよう多候補にする (このゲートの役割はログイン切れ/エラー画面との切り分けのみ。
   * 対象スタッフの存在は staffPresenceSelector() で別途判定する)。
   * 末尾の `select#stockNameList` はスタッフ絞り込みセレクトで、DOM 改訂をまたいで
   * 安定して存在するため最後の保険として含める。
   */
  grid: {
    selector:
      "#schedule.jscScheduleMain, table.schedule, .jscScheduleTimeTable, #showSchedule, select#stockNameList",
    state: "confirmed",
  } as Sel,

  /**
   * スケジュール画面に埋め込まれた更新タイムスタンプ
   * (例: <span id="rlastupdate" class="display_none">20260530200622</span>)。
   * 新規予約登録フォーム (extReserveRegist / moduleId=KPCL017V01) を開くとき
   * `rlastupdate=<この値>` を付与しないと「情報が一部失われています」エラーになる。
   * pushBooking() はスケジュールを開いた時点でこの値を読み、reserveRegistUrl() に渡す。
   */
  rlastupdate: { selector: "#rlastupdate", state: "confirmed" } as Sel,

  /**
   * スタッフ列(行)ヘッダ。id="STAFF_<externalId>_<YYYYMMDD>"、title=表示名。
   * ⚠️ 2026-06-21 の実機ではこの列ヘッダ要素が消え、スタッフは
   * `select#stockNameList` の option として表現されるよう DOM が変わっていた。
   * 対象スタッフの存在判定は staffPresenceSelector()(新旧両対応) を使うこと。
   */
  staffHeadAll: {
    selector: "li.jscScheduleMainHead[id^='STAFF_']",
    state: "confirmed",
  } as Sel,

  /** スタッフ選択用のセレクト (stockNameList)。option value=STAFF_<id>_<date>。 */
  staffSelect: { selector: "select#stockNameList", state: "confirmed" } as Sel,

  /** 各スタッフの予約を置けるドロップ領域 (この中をクリックして登録を開始)。 */
  setArea: {
    selector: "div.scheduleSetArea.jscScheduleSetArea",
    state: "confirmed",
  } as Sel,

  /**
   * 既存予約ブロック (重複チェックに使う)。
   * 2026-05-30 版は `div.scheduleReservation.jscScheduleReservation`。
   * 2026-06-21 実機では内側ラッパ `div.scheduleReservationInner` 構造に変わっていたため
   * 新旧両対応にする (内部の時間帯 JSON は reservationTimeZone で読む)。
   */
  reservationBlock: {
    selector:
      "div.scheduleReservation.jscScheduleReservation, div.scheduleReservationInner",
    state: "confirmed",
  } as Sel,

  /** 予約ブロック内の時間帯 JSON (例: ["16:45","18:00"])。 */
  reservationTimeZone: {
    selector: "p.jscScheduleTimeZoneSetting",
    state: "confirmed",
  } as Sel,

  /** 予約ブロック内の顧客名。 */
  reservationName: {
    selector: "li.scheduleReserveName",
    state: "confirmed",
  } as Sel,

  /** 新規予約ドラッグハンドル (ドラッグ&ドロップで登録開始)。 */
  newPlanHandle: { selector: "#newPlan.jscNewPlan", state: "confirmed" } as Sel,

  /** 開始時刻ピッカー(モーダル)の各リンク。data-start-time="HHMM" (5分刻み)。 */
  timePeriodModal: {
    selector: "ul.jscScheduleTimePeriodModal",
    state: "confirmed",
  } as Sel,
  timePeriodLink: {
    selector: "a.scheduleTimePeriodLink[data-start-time]",
    state: "confirmed",
  } as Sel,

  /** 日付ナビ (前/次の日)。href=/KLP/schedule/salonSchedule/?date=YYYYMMDD */
  prevDay: { selector: "a.mod_btn_calendar_03", state: "confirmed" } as Sel,
  nextDay: { selector: "a.mod_btn_calendar_04", state: "confirmed" } as Sel,
} as const;

/** スタッフ列(行)ヘッダの id セレクタを external_id + 日付から組み立てる。 */
export function staffHeadId(externalId: string, yyyymmdd: string): string {
  return `#STAFF_${externalId}_${yyyymmdd}`;
}
/** stockNameList の option value。 */
export function staffOptionValue(externalId: string, yyyymmdd: string): string {
  return `STAFF_${externalId}_${yyyymmdd}`;
}

/**
 * 対象スタッフがその日のスケジュールに存在する(=シフト内/登録対象)かを判定する
 * 複合セレクタ。SalonBoard の DOM 改訂をまたいで効くよう新旧両方を OR で並べる:
 *   - 新 DOM: `select#stockNameList option[value="STAFF_<ext>_<date>"]`
 *   - 旧 DOM: 列ヘッダ `#STAFF_<ext>_<date>`
 * どちらかが存在すれば「その日そのスタッフの枠がある」とみなす。
 */
export function staffPresenceSelector(
  externalId: string,
  yyyymmdd: string,
): string {
  const token = staffOptionValue(externalId, yyyymmdd);
  return `${staffHeadId(externalId, yyyymmdd)}, select#stockNameList option[value="${token}"]`;
}

/** 予約一覧画面のセレクタ群 (確定)。重複チェック補助に使う。 */
export const RESERVE_LIST = {
  resultTable: { selector: "table#resultList", state: "confirmed" } as Sel,
  row: { selector: "table#resultList tr", state: "confirmed" } as Sel,
  /** 詳細リンク。href に reserveId=YG######## を含む。 */
  detailLink: {
    selector: "a[href*='extReserveDetail'][href*='reserveId=']",
    state: "confirmed",
  } as Sel,
  customerName: { selector: "p.icon02.wordBreak", state: "confirmed" } as Sel,
} as const;

/** reserveId (YG########) を href から抜く。 */
export const RESERVE_ID_RE = /reserveId=([A-Za-z0-9]+)/;

/**
 * 新規予約登録フォーム (確定: booking_create.html / form#extReserveRegist)。
 * reserveRegistUrl() で ?staffId&date&rsvHour&rsvMinute を付けて直接開ける。
 *
 * このフォームは「確認画面」を挟まず、同一画面の「登録する」(a#regist) で確定する
 * 1 ページ構成。スタッフ/時刻/日付は URL クエリで初期選択されるが、念のため
 * セレクトも明示設定する。メニューは netCouponId (クーポン) を label 一致で選ぶ。
 */
export const REGISTER_FORM = {
  /** フォームが開いたことを示す指標。 */
  formReadyIndicators: {
    selector: "form#extReserveRegist, #regist, textarea#rsvEtc",
    state: "confirmed",
  } as Sel,
  /** 顧客 姓 / 名 (SalonBoard は姓名分割)。 */
  customerSei: { selector: "input#nmSei", state: "confirmed" } as Sel,
  customerMei: { selector: "input#nmMei", state: "confirmed" } as Sel,
  /** 顧客 セイ / メイ (カナ)。 */
  customerSeiKana: { selector: "input#nmSeiKana", state: "confirmed" } as Sel,
  customerMeiKana: { selector: "input#nmMeiKana", state: "confirmed" } as Sel,
  /** 電話。 */
  customerPhone: { selector: "input#tel", state: "confirmed" } as Sel,
  /** スタッフ選択 (表示用セレクト。option value = external_id W...)。 */
  staffSelect: { selector: "select#salonStaffList", state: "confirmed" } as Sel,
  /**
   * 実際に送信される hidden スタッフ ID (input#staffId)。
   * 表示用 salonStaffList を選んでも、この hidden が既定スタッフのままだと
   * 「どのスタッフを選んでも既定スタッフで登録される」不整合が起きるため、
   * external_id へ強制同期する。確定 DOM: input[type=hidden name=staffId id=staffId]。
   */
  staffHiddenId: {
    selector: "input#staffId, input[name='staffId']",
    state: "confirmed",
  } as Sel,
  /**
   * 担当割当セレクト (select[name=staffIdList])。表示用 salonStaffList とは別に
   * 送信されるため、option が一致すれば同じ external_id に揃える。
   */
  staffIdList: {
    selector: "select[name='staffIdList'], select.staffIdList",
    state: "confirmed",
  } as Sel,
  /** メニュー = ネット予約クーポン (option label がメニュー/クーポン名)。 */
  menuSelect: { selector: "select#jsiNetCouponId, select[name='netCouponId']", state: "confirmed" } as Sel,
  /** 開始 時 / 分。 */
  startHour: { selector: "select#jsiRsvHour", state: "confirmed" } as Sel,
  startMinute: { selector: "select#jsiRsvMinute", state: "confirmed" } as Sel,
  /** 所要 時(分換算 value) / 分。 */
  termHour: { selector: "select#jsiRsvTermHour", state: "confirmed" } as Sel,
  termMinute: { selector: "select#jsiRsvTermMinute", state: "confirmed" } as Sel,
  /** 予約経路 (任意)。 */
  routeSelect: { selector: "select[name='rsvRouteId']", state: "confirmed" } as Sel,
  /** 備考 (KIREIDOT予約ID を入れる)。 */
  memo: { selector: "textarea#rsvEtc", state: "confirmed" } as Sel,
  /** 登録確定ボタン (ENABLE_PUSH=true のときだけ押す)。 */
  registerButton: { selector: "a#regist", state: "confirmed" } as Sel,
  /** 登録完了の指標 (完了後は予約詳細/一覧へ遷移)。 */
  doneIndicators: {
    selector: "a[href*='extReserveDetail'], text=/登録しました|予約を登録|受け付け/",
    state: "confirmed",
  } as Sel,
} as const;

/** いずれかの selector が pending(未確定) かを判定するヘルパ。 */
export function isPending(...sels: Sel[]): boolean {
  return sels.some((s) => s.state !== "confirmed" || !s.selector);
}
