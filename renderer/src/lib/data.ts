import { supabase, type StaffScope } from './supabase';

/**
 * UI の選択を反映した「実効スコープ」でクエリを絞る。
 *
 *   - shopId が指定されていれば店舗で絞る (selection-context が UI の選択を入れている)
 *   - organizationId が指定されていれば会社で絞る (RLS と二重化)
 *
 * 旧実装はロール別に絞っていたが、いまは selection-context.tsx 側でロール毎の
 * 強制が済んでいるので、ここでは指定された ID で素直にフィルタする。
 */
function applyShop<T extends { eq: (col: string, v: string) => T }>(
  q: T,
  scope: StaffScope,
  col: string = 'shop_id',
): T {
  if (scope.shopId) return q.eq(col, scope.shopId);
  return q;
}

function applyOrg<T extends { eq: (col: string, v: string) => T }>(
  q: T,
  scope: StaffScope,
  col: string = 'organization_id',
): T {
  if (scope.organizationId) return q.eq(col, scope.organizationId);
  return q;
}

// =========================
// 予約
// =========================
export type BookingRow = {
  id: string;
  scheduled_at: string;
  duration_min: number | null;
  status: string;
  amount: number | null;
  customer_name: string | null;
  user_id: string | null;
  customer_id: string | null;
  staff_id: string | null;
  shop_id: string;
  menu_id: string | null;
  /** サロンボード由来の表示用フィールド */
  salonboard_staff_name?: string | null;
  /** SalonBoard スタッフ external_id (W001...)。書き込み時のスタッフ特定に使う */
  salonboard_staff_external_id?: string | null;
  external_booking_id?: string | null;
  /** 予約の出所: 'salonboard' = SB から取得 / 'kireidot' = KIREIDOT で作成 */
  source?: string | null;
  /** SalonBoard 書き込み同期状態 (kireidot 作成予約のみ意味を持つ) */
  salonboard_sync_status?: string | null;
  /** SalonBoard 予約詳細 URL (同期済みのとき) */
  salonboard_detail_url?: string | null;
  shops?: { name: string } | null;
  staff?: { full_name: string } | null;
  menus?: { name: string } | null;
  profiles?: { full_name: string | null } | null;
  /** 紐付け済み顧客 (customers テーブル) */
  customers?: { full_name: string | null; customer_code: string | null } | null;
};

export async function fetchTodayBookings(scope: StaffScope): Promise<BookingRow[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  let q: any = supabase
    .from('bookings')
    .select(
      'id, scheduled_at, duration_min, status, amount, customer_name, user_id, customer_id, staff_id, shop_id, menu_id, salonboard_staff_name, salonboard_staff_external_id, external_booking_id, source, salonboard_sync_status, salonboard_detail_url, shops(name), profiles!bookings_user_id_fkey(full_name), menus(name), customers(full_name, customer_code)',
    )
    .gte('scheduled_at', start.toISOString())
    .lt('scheduled_at', end.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(200);
  q = applyShop(q, scope);
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchTodayBookings error:', error.message);
    return [];
  }
  return (data ?? []) as BookingRow[];
}

/**
 * @param days 取得日数 (既定 7)
 * @param offsetDays 今日からの開始オフセット日数 (週送り用。+7 で翌週、-7 で先週)
 */
export async function fetchRecentBookings(
  scope: StaffScope,
  days = 7,
  offsetDays = 0,
): Promise<BookingRow[]> {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  let q: any = supabase
    .from('bookings')
    .select(
      'id, scheduled_at, duration_min, status, amount, customer_name, user_id, customer_id, staff_id, shop_id, menu_id, salonboard_staff_name, salonboard_staff_external_id, external_booking_id, source, salonboard_sync_status, salonboard_detail_url, shops(name), profiles!bookings_user_id_fkey(full_name), menus(name), customers(full_name, customer_code)',
    )
    .gte('scheduled_at', start.toISOString())
    .lt('scheduled_at', end.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(500);
  q = applyShop(q, scope);
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchRecentBookings error:', error.message);
    return [];
  }
  return (data ?? []) as BookingRow[];
}

/**
 * 「キレイドットだけにあって SalonBoard に追加できていない予約」を取得する。
 *
 * 予約一覧 (fetchRecentBookings) は表示中の 30 日ぶんしか取らないため、
 * このリストは表示期間に依存させず「本日以降・キャンセル以外・未連携」の
 * 予約だけを別クエリで全件取得する (Admin Web と同じ考え方)。
 *
 * 判定条件 (SQL で検証済み):
 *   source in ('kireidot','manual')          … KIREIDOT / 手動作成 (SB 由来ではない)
 *   status <> 'cancelled'                     … 有効な予約のみ
 *   scheduled_at >= now                       … 未来分のみ
 *   かつ 次のいずれか:
 *     (a) salonboard_sync_status is null / pending_push / pushing / failed /
 *         manual_required / not_required … 一度も push されていない or 未完了 (= 明確に未連携)
 *     (b) salonboard_sync_status = 'synced' だが external_booking_id が無い
 *         … 「SBに登録は成功したが reserveId を取得できなかった」疑わしいケース。
 *           SBに実在する可能性が高いが確証が無いので、要確認として併せて出す。
 *
 * UI 側 (classifySbSync) でバッジを分け、(b) を誤って「挿入」して二重登録しないようにする。
 */
export async function fetchUnmatchedBookings(scope: StaffScope): Promise<BookingRow[]> {
  const nowIso = new Date().toISOString();
  let q: any = supabase
    .from('bookings')
    .select(
      'id, scheduled_at, duration_min, status, amount, customer_name, user_id, customer_id, staff_id, shop_id, menu_id, salonboard_staff_name, salonboard_staff_external_id, external_booking_id, source, salonboard_sync_status, salonboard_detail_url, shops(name), profiles!bookings_user_id_fkey(full_name), menus(name), customers(full_name, customer_code)',
    )
    .in('source', ['kireidot', 'manual'])
    .neq('status', 'cancelled')
    .gte('scheduled_at', nowIso)
    .or(
      // (a) 明確に未連携 + (b) synced だが external_booking_id 無し (要確認)
      'salonboard_sync_status.is.null,' +
        'salonboard_sync_status.in.(pending_push,pushing,failed,manual_required,not_required),' +
        'and(salonboard_sync_status.eq.synced,external_booking_id.is.null)',
    )
    .order('scheduled_at', { ascending: true })
    .limit(500);
  // bookings には organization_id カラムが無い (shops 経由) ため applyOrg は使わない。
  // 店舗が選ばれていれば shop_id で絞り、未選択なら RLS の範囲 (自組織) を全件返す。
  // fetchRecentBookings と同じ挙動に揃える。
  q = applyShop(q, scope);
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchUnmatchedBookings error:', error.message);
    return [];
  }
  return (data ?? []) as BookingRow[];
}

// =========================
// スタッフ (サロンボード由来)
//
// SalonBoard から取り込んだスタッフを表示する。
// =========================
// 設備 (ベッド/席): salonboard_equipment_imports を shop_id でフィルタ。
// =========================
export type EquipmentRow = {
  id: string;
  external_id: string;
  name: string;
  max_rsv_num: number | null;
  priority: number | null;
  sort_no: number | null;
  matched_resource_id: string | null;
  last_synced_at: string | null;
};

export async function fetchEquipmentList(scope: StaffScope): Promise<EquipmentRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_equipment_imports')
    .select(
      'id, external_id, name, max_rsv_num, priority, sort_no, matched_resource_id, last_synced_at',
    )
    .eq('shop_id', scope.shopId)
    .order('sort_no', { ascending: true, nullsFirst: false })
    .order('name');
  if (error) {
    console.warn('[data] fetchEquipmentList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    name: r.name,
    max_rsv_num: r.max_rsv_num ?? null,
    priority: r.priority ?? null,
    sort_no: r.sort_no ?? null,
    matched_resource_id: r.matched_resource_id ?? null,
    last_synced_at: r.last_synced_at ?? null,
  }));
}

// `staff` (社内 DB) ではなく `salonboard_staff_imports` を見るので
// shop_id でフィルタするだけで店舗ごとの一覧になる。
// =========================
export type StaffRow = {
  id: string;
  full_name: string;
  role: string | null;
  icon_url: string | null;
  shop_id: string | null;
  tenure_years: number | null;
  organization_id: string | null;
  /** サロンボードでの外部 ID (W001234) */
  external_id?: string | null;
  /** 紐付け済み KIREIDOT staff.id (= bookings.staff_id と一致するキー) */
  matched_staff_id?: string | null;
  position?: string | null;
  catch_phrase?: string | null;
  bio?: string | null;
};

export async function fetchStaffList(scope: StaffScope): Promise<StaffRow[]> {
  // 店舗が選ばれていないときは空 (店舗別表示が前提)
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_staff_imports')
    .select(
      'id, shop_id, external_id, name, position, catch_phrase, bio, photo_url, is_published, matched_staff_id',
    )
    .eq('shop_id', scope.shopId)
    .order('name');
  if (error) {
    console.warn('[data] fetchStaffList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    full_name: r.name,
    role: r.position ?? null,
    icon_url: r.photo_url ?? null,
    shop_id: r.shop_id,
    tenure_years: null,
    organization_id: null,
    external_id: r.external_id,
    matched_staff_id: r.matched_staff_id ?? null,
    position: r.position,
    catch_phrase: r.catch_phrase,
    bio: r.bio,
  })) as StaffRow[];
}

/**
 * 予約を KIREIDOT 側でキャンセル状態にする (SalonBoard 未連携の予約用)。
 * SalonBoard 連携済みの予約は worker 経由 (workerCancelBooking) で SB もキャンセルする。
 * 戻り値の error は失敗時のメッセージ文字列、成功時は null。
 */
export async function cancelBookingLocal(bookingId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId);
  return { error: error ? error.message : null };
}

/**
 * 予約の時間/所要を KIREIDOT 側で更新する (SalonBoard 連携済み予約の変更時、先に KIREIDOT を更新)。
 * scheduledAtIso は ISO (JST オフセット付き) 文字列。
 */
export async function updateBookingTimeLocal(
  bookingId: string,
  scheduledAtIso: string,
  durationMin: number,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('bookings')
    .update({ scheduled_at: new Date(scheduledAtIso).toISOString(), duration_min: durationMin })
    .eq('id', bookingId);
  return { error: error ? error.message : null };
}

// =========================
// メニュー (サロンボード由来) — 予約作成時の選択用
// salonboard_menu_imports を読む (メニュー同期で投入される)。
// =========================
export type MenuRow = {
  id: string;
  external_id: string;
  name: string;
  category: string | null;
  price: number | null;
  duration_min: number | null;
};

export async function fetchMenuList(scope: StaffScope): Promise<MenuRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_menu_imports')
    .select('id, external_id, name, category, price, duration_min, is_active')
    .eq('shop_id', scope.shopId)
    .eq('is_active', true)
    .order('category', { nullsFirst: false })
    .order('name');
  if (error) {
    console.warn('[data] fetchMenuList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    name: r.name,
    category: r.category ?? null,
    price: r.price ?? null,
    duration_min: r.duration_min ?? null,
  })) as MenuRow[];
}

// =========================
// salonboard_style_imports を読む (美容室スタイル同期で投入される。画像付き)。
// =========================
export type StyleRow = {
  id: string;
  external_id: string;
  name: string | null;
  image_url: string | null;
  length: string | null;
  stylist_name: string | null;
  last_synced_at: string | null;
};

export async function fetchStyleList(scope: StaffScope): Promise<StyleRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_style_imports')
    .select('id, external_id, name, image_url, length, stylist_name, last_synced_at')
    .eq('shop_id', scope.shopId)
    .order('last_synced_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) {
    console.warn('[data] fetchStyleList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    name: r.name ?? null,
    image_url: r.image_url ?? null,
    length: r.length ?? null,
    stylist_name: r.stylist_name ?? null,
    last_synced_at: r.last_synced_at ?? null,
  })) as StyleRow[];
}

// 選択中店舗のジャンル (hair / esthetic / ...) を取得する。
export async function fetchShopGenre(scope: StaffScope): Promise<string | null> {
  if (!scope.shopId) return null;
  const { data, error } = await supabase
    .from('shops')
    .select('genre')
    .eq('id', scope.shopId)
    .maybeSingle();
  if (error) {
    console.warn('[data] fetchShopGenre error:', error.message);
    return null;
  }
  return (data as any)?.genre ?? null;
}

// =========================
// salonboard_photo_gallery_imports を読む (エステ等のフォトギャラリー同期で投入)。
// =========================
export type PhotoGalleryRow = {
  id: string;
  external_id: string;
  title: string | null;
  caption: string | null;
  image_url: string | null;
  genre_code: string | null;
  is_published: boolean;
  last_synced_at: string | null;
};

export async function fetchPhotoGalleryList(scope: StaffScope): Promise<PhotoGalleryRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_photo_gallery_imports')
    .select('id, external_id, title, caption, image_url, genre_code, is_published, last_synced_at')
    .eq('shop_id', scope.shopId)
    .order('last_synced_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) {
    console.warn('[data] fetchPhotoGalleryList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    title: r.title ?? null,
    caption: r.caption ?? null,
    image_url: r.image_url ?? null,
    genre_code: r.genre_code ?? null,
    is_published: r.is_published !== false,
    last_synced_at: r.last_synced_at ?? null,
  })) as PhotoGalleryRow[];
}

// =========================
// メニュー統合一覧 (SalonBoard取得 + KIREIDOT) — 出所付きで両方表示
// =========================
export type MergedMenuRow = {
  id: string;
  name: string;
  category: string | null;
  price: number | null;
  duration_min: number | null;
  /** 'salonboard' = SB 取込 / 'kireidot' = KIREIDOT 登録 */
  source: 'salonboard' | 'kireidot';
  /** SB メニューが KIREIDOT メニューと紐付いているか (source=salonboard のみ) */
  linked?: boolean;
  /** 割引率 (kireidot のみ) */
  discount_rate?: number | null;
  is_active: boolean;
};

/**
 * SalonBoard 取込メニュー (salonboard_menu_imports, shop 単位) と
 * KIREIDOT メニュー (menus, organization 単位) を 1 つのリストに統合して返す。
 * UI 側で source バッジで区別する。
 */
export async function fetchMenusMerged(scope: StaffScope): Promise<MergedMenuRow[]> {
  const out: MergedMenuRow[] = [];

  // SalonBoard 取込メニュー (店舗単位)
  if (scope.shopId) {
    const { data, error } = await supabase
      .from('salonboard_menu_imports')
      .select('id, name, category, price, duration_min, matched_menu_id, is_active')
      .eq('shop_id', scope.shopId)
      .order('category', { nullsFirst: false })
      .order('name');
    if (error) console.warn('[data] fetchMenusMerged (sb) error:', error.message);
    for (const r of (data ?? []) as any[]) {
      out.push({
        id: `sb_${r.id}`,
        name: r.name,
        category: r.category ?? null,
        price: r.price ?? null,
        duration_min: r.duration_min ?? null,
        source: 'salonboard',
        linked: !!r.matched_menu_id,
        is_active: r.is_active ?? true,
      });
    }
  }

  // KIREIDOT メニュー (組織単位)
  if (scope.organizationId) {
    const { data, error } = await supabase
      .from('menus')
      .select('id, name, price, duration_minutes, discount_rate, is_active, organization_id')
      .eq('organization_id', scope.organizationId)
      .order('name');
    if (error) console.warn('[data] fetchMenusMerged (kireidot) error:', error.message);
    for (const r of (data ?? []) as any[]) {
      out.push({
        id: `kd_${r.id}`,
        name: r.name,
        category: null,
        price: r.price ?? null,
        duration_min: r.duration_minutes ?? null,
        source: 'kireidot',
        discount_rate: r.discount_rate ?? null,
        is_active: r.is_active ?? true,
      });
    }
  }

  return out;
}

// =========================
// 口コミ (サロンボード由来) — salonboard_review_imports を読む
// =========================
export type ReviewRow = {
  id: string;
  external_id: string;
  posted_at_label: string | null;
  visit_date_label: string | null;
  customer_name: string | null;
  staff_name: string | null;
  body_excerpt: string | null;
  reply_status: 'unreplied' | 'replied';
  audit_status: string | null;
  reply_url: string | null;
  ai_reply_draft: string | null;
  ai_reply_generated_at: string | null;
};

export async function fetchReviewList(scope: StaffScope): Promise<ReviewRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_review_imports')
    .select(
      'id, external_id, posted_at_label, visit_date_label, customer_name, staff_name, body_excerpt, reply_status, audit_status, reply_url, ai_reply_draft, ai_reply_generated_at',
    )
    .eq('shop_id', scope.shopId)
    .order('posted_at_label', { ascending: false, nullsFirst: false });
  if (error) {
    console.warn('[data] fetchReviewList error:', error.message);
    return [];
  }
  return (data ?? []) as ReviewRow[];
}

/** AI 返信案を保存する (生成は Admin API、保存は RLS update で本人店舗のみ可)。 */
export async function saveReviewAiReply(reviewId: string, reply: string): Promise<boolean> {
  const { error } = await supabase
    .from('salonboard_review_imports')
    .update({ ai_reply_draft: reply, ai_reply_generated_at: new Date().toISOString() })
    .eq('id', reviewId);
  if (error) {
    console.warn('[data] saveReviewAiReply error:', error.message);
    return false;
  }
  return true;
}

// =========================
// クーポン (サロンボード由来) — salonboard_coupon_imports を読む
// ホットペッパー上ではメニューとクーポンは別概念なので別テーブル。
// =========================
export type CouponRow = {
  id: string;
  external_id: string;
  name: string;
  category: string | null;
  expires_label: string | null;
  photo_url: string | null;
  price: number | null;
  duration_min: number | null;
  content: string | null;
  condition_label: string | null;
  use_condition: string | null;
};

export async function fetchCouponList(scope: StaffScope): Promise<CouponRow[]> {
  if (!scope.shopId) return [];
  const { data, error } = await supabase
    .from('salonboard_coupon_imports')
    .select('id, external_id, name, category, expires_label, photo_url, price, duration_min, content, condition_label, use_condition, is_active')
    .eq('shop_id', scope.shopId)
    .eq('is_active', true)
    .order('category', { nullsFirst: false })
    .order('name');
  if (error) {
    console.warn('[data] fetchCouponList error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    external_id: r.external_id,
    name: r.name,
    category: r.category ?? null,
    expires_label: r.expires_label ?? null,
    photo_url: r.photo_url ?? null,
    price: r.price ?? null,
    duration_min: r.duration_min ?? null,
    content: r.content ?? null,
    condition_label: r.condition_label ?? null,
    use_condition: r.use_condition ?? null,
  })) as CouponRow[];
}

// =========================
// シフト (サロンボード由来)
//
// `salonboard_shift_imports` を読む。1行 = 1スタッフ × 1日 (date + time)。
// Shifts.tsx 側は `start_at` / `end_at` (timestamptz) を期待しているので、
// shift_date + start_time / end_time を JST のローカル時刻として ISO に変換する。
// =========================
export type ShiftRow = {
  id: string;
  staff_id: string;
  staff_name?: string | null;
  shop_id: string;
  start_at: string;
  end_at: string;
  is_requested_off: boolean | null;
  is_confirmed: boolean | null;
  is_off?: boolean | null;
  note?: string | null;
};

export async function fetchShiftsForWeek(scope: StaffScope): Promise<ShiftRow[]> {
  if (!scope.shopId) return [];
  const start = new Date();
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('salonboard_shift_imports')
    .select(
      'id, shop_id, staff_external_id, staff_name, shift_date, start_time, end_time, is_off, note, matched_staff_id',
    )
    .eq('shop_id', scope.shopId)
    .gte('shift_date', toIso(start))
    .lt('shift_date', toIso(end))
    .order('shift_date');
  if (error) {
    console.warn('[data] fetchShiftsForWeek error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => {
    const date = r.shift_date as string;
    const s = r.start_time ?? '00:00';
    const e = r.end_time ?? '00:00';
    // ローカル時刻 → JS Date は UTC 解釈する。SalonBoard は JST 想定なので
    // タイムゾーンオフセット (+09:00) を明示。
    const startAt = `${date}T${normalizeTime(s)}+09:00`;
    const endAt = `${date}T${normalizeTime(e)}+09:00`;
    return {
      id: r.id,
      staff_id: r.matched_staff_id ?? r.staff_external_id,
      staff_name: r.staff_name,
      shop_id: r.shop_id,
      start_at: new Date(startAt).toISOString(),
      end_at: new Date(endAt).toISOString(),
      is_requested_off: r.is_off ?? null,
      is_confirmed: null,
      is_off: r.is_off,
      note: r.note,
    } as ShiftRow;
  });
}

function normalizeTime(t: string): string {
  // 'HH:MM' or 'HH:MM:SS' → 'HH:MM:SS'
  if (/^\d{2}:\d{2}$/.test(t)) return `${t}:00`;
  return t;
}

// =========================
// ブログ / コンテンツ (統合)
//
// 2 つのソースを統合して表示する:
//   1. KIREIDOT Admin で作成された content_posts (shop_id 紐付け)
//   2. SalonBoard から取り込んだ salonboard_blog_imports
// 同じ画面に並べ、出典 (source) で区別する。
// =========================
export type PostRow = {
  id: string;
  title: string | null;
  body: string | null;
  status: string | null;
  author_id: string | null;
  shop_id: string | null;
  organization_id: string | null;
  cover_image_url: string | null;
  published_at: string | null;
  created_at: string | null;
  view_count: number | null;
  /** SalonBoard 内の記事 URL (sb_imports のときのみ) */
  source_url?: string | null;
  category?: string | null;
  author_name?: string | null;
  /** "kireidot" (content_posts) | "salonboard" (sb_imports) */
  source: 'kireidot' | 'salonboard';
  /** SalonBoard 投稿連携の状態 (content_posts のみ) */
  sync_to_salonboard?: boolean;
  salonboard_external_id?: string | null;
};

export async function fetchPosts(scope: StaffScope): Promise<PostRow[]> {
  if (!scope.shopId) return [];

  // 並列に両ソースを取得
  const [sbRes, cpRes] = await Promise.all([
    supabase
      .from('salonboard_blog_imports')
      .select(
        'id, shop_id, external_id, title, body_excerpt, body_html, cover_image_url, category, author_external_id, author_name, posted_at, is_published, view_count, url, created_at',
      )
      .eq('shop_id', scope.shopId)
      .order('posted_at', { ascending: false, nullsFirst: false })
      .limit(200),
    supabase
      .from('content_posts')
      .select(
        'id, shop_id, organization_id, title, body, type, tags, author_id, cover_image_url, images, published_at, created_at, sync_to_salonboard, salonboard_external_id',
      )
      .eq('shop_id', scope.shopId)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  if (sbRes.error) console.warn('[data] fetchPosts (sb) error:', sbRes.error.message);
  if (cpRes.error) console.warn('[data] fetchPosts (cp) error:', cpRes.error.message);

  const sbRows: PostRow[] = (sbRes.data ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    body: r.body_html ?? r.body_excerpt ?? null,
    status: r.is_published ? 'published' : 'draft',
    author_id: r.author_external_id,
    shop_id: r.shop_id,
    organization_id: null,
    cover_image_url: r.cover_image_url,
    published_at: r.posted_at,
    created_at: r.created_at,
    view_count: r.view_count,
    source_url: r.url,
    category: r.category,
    author_name: r.author_name,
    source: 'salonboard',
  }));

  const cpRows: PostRow[] = (cpRes.data ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    body: r.body ?? null,
    status: r.published_at ? 'published' : 'draft',
    author_id: r.author_id,
    shop_id: r.shop_id,
    organization_id: r.organization_id,
    cover_image_url: r.cover_image_url ?? (Array.isArray(r.images) && r.images[0]) ?? null,
    published_at: r.published_at,
    created_at: r.created_at,
    view_count: null,
    source_url: null,
    category: r.type, // content_type を category として流用
    author_name: null,
    source: 'kireidot',
    sync_to_salonboard: r.sync_to_salonboard ?? false,
    salonboard_external_id: r.salonboard_external_id ?? null,
  }));

  // 公開/作成日の新しい順でマージ
  const merged = [...sbRows, ...cpRows].sort((a, b) => {
    const ka = a.published_at ?? a.created_at ?? '';
    const kb = b.published_at ?? b.created_at ?? '';
    return kb.localeCompare(ka);
  });
  return merged;
}

// =========================
// ダッシュボード集計
// =========================
export type DashboardSummary = {
  todayBookings: number;
  todayRevenue: number;
  activeStaff: number;
  newCustomersToday: number;
};

export async function fetchDashboardSummary(scope: StaffScope): Promise<DashboardSummary> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  // 並列に集計
  let bookingsQ: any = supabase
    .from('bookings')
    .select('id, amount, status, user_id, customer_id', { count: 'exact' })
    .gte('scheduled_at', start.toISOString())
    .lt('scheduled_at', end.toISOString());
  bookingsQ = applyShop(bookingsQ, scope);

  // スタッフはサロンボード取り込み (salonboard_staff_imports) の件数を表示
  let staffQ: any = supabase
    .from('salonboard_staff_imports')
    .select('id', { count: 'exact', head: true });
  if (scope.shopId) staffQ = staffQ.eq('shop_id', scope.shopId);

  const [bookingsRes, staffRes] = await Promise.all([bookingsQ, staffQ]);

  let todayRevenue = 0;
  for (const b of (bookingsRes.data ?? []) as Array<{ amount: number | null; status: string }>) {
    if (b.status === 'cancelled') continue;
    todayRevenue += Number(b.amount ?? 0);
  }
  const todayBookings = (bookingsRes.count ?? bookingsRes.data?.length ?? 0) as number;
  const activeStaff = (staffRes.count ?? 0) as number;

  return {
    todayBookings,
    todayRevenue,
    activeStaff,
    newCustomersToday: 0, // TODO: 当日の new customers ロジック (customers + profiles)
  };
}
