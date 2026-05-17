import { supabase, type StaffScope } from './supabase';

/** scope に基づいて bookings / staff / shifts / posts などをフィルタするヘルパ */
function applyShop<T extends { eq: (col: string, v: string) => T }>(
  q: T,
  scope: StaffScope,
  col: string = 'shop_id',
): T {
  // shop_manager / staff は自店舗のみ
  if (scope.shopId && (scope.role === 'staff' || scope.role === 'shop_manager')) {
    return q.eq(col, scope.shopId);
  }
  return q;
}

function applyOrg<T extends { eq: (col: string, v: string) => T }>(
  q: T,
  scope: StaffScope,
  col: string = 'organization_id',
): T {
  if (scope.organizationId && scope.role !== 'admin' && scope.role !== 'super_owner') {
    return q.eq(col, scope.organizationId);
  }
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
  shops?: { name: string } | null;
  staff?: { full_name: string } | null;
  menus?: { name: string } | null;
  profiles?: { full_name: string | null } | null;
};

export async function fetchTodayBookings(scope: StaffScope): Promise<BookingRow[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  let q: any = supabase
    .from('bookings')
    .select(
      'id, scheduled_at, duration_min, status, amount, customer_name, user_id, customer_id, staff_id, shop_id, menu_id, shops(name), profiles!bookings_user_id_fkey(full_name), menus(name)',
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

export async function fetchRecentBookings(scope: StaffScope, days = 7): Promise<BookingRow[]> {
  const start = new Date();
  start.setDate(start.getDate() - 0);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  let q: any = supabase
    .from('bookings')
    .select(
      'id, scheduled_at, duration_min, status, amount, customer_name, user_id, customer_id, staff_id, shop_id, menu_id, shops(name), profiles!bookings_user_id_fkey(full_name), menus(name)',
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
// スタッフ
// =========================
export type StaffRow = {
  id: string;
  full_name: string;
  role: string | null;
  icon_url: string | null;
  shop_id: string | null;
  tenure_years: number | null;
  organization_id: string | null;
};

export async function fetchStaffList(scope: StaffScope): Promise<StaffRow[]> {
  let q: any = supabase
    .from('staff')
    .select('id, full_name, role, icon_url, shop_id, tenure_years, organization_id')
    .eq('is_active', true)
    .order('full_name');
  q = applyOrg(q, scope);
  if (scope.role === 'shop_manager' && scope.shopId) {
    q = q.eq('shop_id', scope.shopId);
  }
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchStaffList error:', error.message);
    return [];
  }
  return (data ?? []) as StaffRow[];
}

// =========================
// シフト
// =========================
export type ShiftRow = {
  id: string;
  staff_id: string;
  shop_id: string;
  start_at: string;
  end_at: string;
  is_requested_off: boolean | null;
  is_confirmed: boolean | null;
};

export async function fetchShiftsForWeek(scope: StaffScope): Promise<ShiftRow[]> {
  const start = new Date();
  // 月曜起点
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  let q: any = supabase
    .from('shifts')
    .select('id, staff_id, shop_id, start_at, end_at, is_requested_off, is_confirmed')
    .gte('start_at', start.toISOString())
    .lt('start_at', end.toISOString())
    .order('start_at');
  q = applyShop(q, scope);
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchShiftsForWeek error:', error.message);
    return [];
  }
  return (data ?? []) as ShiftRow[];
}

// =========================
// ブログ / コンテンツポスト
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
};

export async function fetchPosts(scope: StaffScope): Promise<PostRow[]> {
  // content_posts テーブルが運用上の「ブログ」相当
  let q: any = supabase
    .from('content_posts')
    .select(
      'id, title, body, status, author_id, shop_id, organization_id, cover_image_url, published_at, created_at, view_count',
    )
    .order('created_at', { ascending: false })
    .limit(100);
  q = applyOrg(q, scope);
  if (scope.role === 'shop_manager' && scope.shopId) {
    q = q.eq('shop_id', scope.shopId);
  }
  const { data, error } = await q;
  if (error) {
    console.warn('[data] fetchPosts error:', error.message, '— content_posts テーブルが無い可能性');
    return [];
  }
  return (data ?? []) as PostRow[];
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

  let staffQ: any = supabase
    .from('staff')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);
  staffQ = applyOrg(staffQ, scope);

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
