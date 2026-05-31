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
} as const;

/** schedule?date= 用に Date → YYYYMMDD (JST 前提の値を渡すこと)。 */
export function scheduleUrl(baseUrl: string, yyyymmdd: string): string {
  const u = new URL(SB_PATHS.schedule, baseUrl);
  u.searchParams.set("date", yyyymmdd);
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
 * ⚠️ 新規予約登録フォーム (未確定)。
 * スケジュールで空き枠を開いた先の画面。DOM 取得後にここを埋める。
 * 現状はすべて pending。pushBooking() は confirmed でない限りフォーム入力を
 * 試みず、画面を capture して manual_required にする。
 */
export const REGISTER_FORM = {
  /** フォームが開いたことを示す指標 (どれか一つでも出れば「フォーム画面」)。 */
  formReadyIndicators: {
    // TODO(DOM): 実フォームの確定値に置き換える。
    selector:
      "form[action*='reserve'], input[name*='customer' i], input[name*='rsv' i], textarea[name*='memo' i]",
    state: "pending",
    note: "登録フォーム DOM 未取得。確定したら formReady を confirmed に。",
  } as Sel,
  customerName: { selector: "", state: "pending" } as Sel,
  customerPhone: { selector: "", state: "pending" } as Sel,
  staffSelect: { selector: "", state: "pending" } as Sel,
  menuSelect: { selector: "", state: "pending" } as Sel,
  date: { selector: "", state: "pending" } as Sel,
  time: { selector: "", state: "pending" } as Sel,
  memo: { selector: "", state: "pending" } as Sel,
  /** 確認画面へ進むボタン。 */
  proceedToConfirm: { selector: "", state: "pending" } as Sel,
  /** 確認画面の指標。 */
  confirmReadyIndicators: { selector: "", state: "pending" } as Sel,
  /** 登録確定ボタン (ENABLE_PUSH=true のときだけ押す)。 */
  registerButton: { selector: "", state: "pending" } as Sel,
  /** 登録完了の指標。 */
  doneIndicators: { selector: "", state: "pending" } as Sel,
} as const;

/** いずれかの selector が pending(未確定) かを判定するヘルパ。 */
export function isPending(...sels: Sel[]): boolean {
  return sels.some((s) => s.state !== "confirmed" || !s.selector);
}
