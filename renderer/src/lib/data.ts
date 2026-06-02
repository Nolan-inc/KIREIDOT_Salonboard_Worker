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

// =========================
// スタッフ (サロンボード由来)
//
// SalonBoard から取り込んだスタッフを表示する。
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
