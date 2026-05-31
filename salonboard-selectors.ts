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
 */
export function reserveRegistUrl(
  baseUrl: string,
  externalStaffId: string,
  yyyymmdd: string,
  hh: string,
  mm: string,
): string {
  const u = new URL(SB_PATHS.reserveRegist, baseUrl);
  u.searchParams.set("staffId", externalStaffId);
  u.searchParams.set("date", yyyymmdd);
  u.searchParams.set("rsvHour", hh);
  u.searchParams.set("rsvMinute", mm);
  return u.toString();
}

/** 予約スケジュール画面のセレクタ群 (確定)。 */
export const SCHEDULE = {
  /** グリッド全体。data-time-interval="5" / is5min。 */
  grid: { selector: "#schedule.jscScheduleMain", state: "confirmed" } as Sel,

  /**
   * スタッフ列(行)ヘッダ。id="STAFF_<externalId>_<YYYYMMDD>"、title=表示名。
   * 特定スタッフは staffHeadById() で組み立てる。
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

  /** 既存予約ブロック (重複チェックに使う)。 */
  reservationBlock: {
    selector: "div.scheduleReservation.jscScheduleReservation",
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
  /** スタッフ選択 (option value = external_id W...)。 */
  staffSelect: { selector: "select#salonStaffList", state: "confirmed" } as Sel,
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
