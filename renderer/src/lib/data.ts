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
  source?: 'kireidot' | 'salonboard';
  external_id?: string | null;
  position?: string | null;
  catch_phrase?: string | null;
  is_published?: boolean | null;
  matched_staff_id?: string | null;
  last_synced_at?: string | null;
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
  }
  const kireidotRows = ((data ?? []) as StaffRow[]).map((s) => ({ ...s, source: 'kireidot' as const }));

  let importQ: any = supabase
    .from('salonboard_staff_imports')
    .select('id, shop_id, external_id, name, position, catch_phrase, photo_url, is_published, matched_staff_id, last_synced_at')
    .order('last_synced_at', { ascending: false })
    .limit(300);
  if (scope.shopId && (scope.role === 'staff' || scope.role === 'shop_manager')) {
    importQ = importQ.eq('shop_id', scope.shopId);
  }
  const { data: imported, error: importError } = await importQ;
  if (importError) {
    console.warn('[data] fetchSalonboardStaffImports error:', importError.message);
    return kireidotRows;
  }

  const importedRows = ((imported ?? []) as any[]).map(
    (s): StaffRow => ({
      id: `salonboard:${s.id}`,
      full_name: s.name,
      role: null,
      icon_url: s.photo_url ?? null,
      shop_id: s.shop_id ?? null,
      tenure_years: null,
      organization_id: null,
      source: 'salonboard',
      external_id: s.external_id ?? null,
      position: s.position ?? null,
      catch_phrase: s.catch_phrase ?? null,
      is_published: s.is_published ?? null,
      matched_staff_id: s.matched_staff_id ?? null,
      last_synced_at: s.last_synced_at ?? null,
    }),
  );

  return [...kireidotRows, ...importedRows];
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
  source?: 'kireidot' | 'salonboard';
  staff_external_id?: string | null;
  staff_name?: string | null;
  shift_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  is_off?: boolean | null;
  note?: string | null;
  matched_staff_id?: string | null;
  last_synced_at?: string | null;
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
  }
  const kireidotRows = ((data ?? []) as ShiftRow[]).map((s) => ({ ...s, source: 'kireidot' as const }));

  const startDate = toDateKey(start);
  const endDate = toDateKey(end);
  let importQ: any = supabase
    .from('salonboard_shift_imports')
    .select(
      'id, shop_id, staff_external_id, staff_name, shift_date, start_time, end_time, is_off, note, matched_staff_id, last_synced_at',
    )
    .gte('shift_date', startDate)
    .lt('shift_date', endDate)
    .order('shift_date');
  importQ = applyShop(importQ, scope);
  const { data: imported, error: importError } = await importQ;
  if (importError) {
    console.warn('[data] fetchSalonboardShiftImports error:', importError.message);
    return kireidotRows;
  }

  const importedRows = ((imported ?? []) as any[]).map((s): ShiftRow => {
    const startTime = normalizeTimeString(s.start_time) ?? '10:00';
    const endTime = normalizeTimeString(s.end_time) ?? addHoursTime(startTime, 1);
    return {
      id: `salonboard:${s.id}`,
      staff_id: s.matched_staff_id ?? `salonboard:${s.staff_external_id}`,
      shop_id: s.shop_id,
      start_at: jstDateTimeToIso(s.shift_date, startTime),
      end_at: jstDateTimeToIso(s.shift_date, endTime),
      is_requested_off: !!s.is_off,
      is_confirmed: true,
      source: 'salonboard',
      staff_external_id: s.staff_external_id ?? null,
      staff_name: s.staff_name ?? null,
      shift_date: s.shift_date ?? null,
      start_time: startTime,
      end_time: endTime,
      is_off: !!s.is_off,
      note: s.note ?? null,
      matched_staff_id: s.matched_staff_id ?? null,
      last_synced_at: s.last_synced_at ?? null,
    };
  });

  return [...kireidotRows, ...importedRows];
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
  author_name?: string | null;
  shop_id: string | null;
  organization_id: string | null;
  cover_image_url: string | null;
  published_at: string | null;
  created_at: string | null;
  view_count: number | null;
  source?: 'kireidot' | 'salonboard';
  external_id?: string | null;
  category?: string | null;
  url?: string | null;
  last_synced_at?: string | null;
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
  }
  const contentRows = ((data ?? []) as PostRow[]).map((p) => ({ ...p, source: 'kireidot' as const }));

  let importQ: any = supabase
    .from('salonboard_blog_imports')
    .select(
      'id, shop_id, external_id, title, body_excerpt, body_html, cover_image_url, category, author_name, posted_at, is_published, view_count, url, last_synced_at',
    )
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (scope.shopId && (scope.role === 'staff' || scope.role === 'shop_manager')) {
    importQ = importQ.eq('shop_id', scope.shopId);
  }
  const { data: imported, error: importError } = await importQ;
  if (importError) {
    console.warn('[data] fetchSalonboardBlogImports error:', importError.message);
    return contentRows;
  }

  const importedRows = ((imported ?? []) as any[]).map(
    (p): PostRow => ({
      id: `salonboard:${p.id}`,
      title: p.title ?? null,
      body: p.body_excerpt ?? p.body_html ?? null,
      status: p.is_published === false ? 'draft' : 'published',
      author_id: null,
      author_name: p.author_name ?? null,
      shop_id: p.shop_id ?? null,
      organization_id: null,
      cover_image_url: p.cover_image_url ?? null,
      published_at: p.posted_at ?? null,
      created_at: p.last_synced_at ?? null,
      view_count: p.view_count ?? null,
      source: 'salonboard',
      external_id: p.external_id ?? null,
      category: p.category ?? null,
      url: p.url ?? null,
      last_synced_at: p.last_synced_at ?? null,
    }),
  );

  return [...importedRows, ...contentRows];
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeTimeString(value: unknown): string | null {
  const m = String(value ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function addHoursTime(time: string, hours: number): string {
  const [hRaw, mRaw] = time.split(':');
  const h = (Number(hRaw) + hours + 24) % 24;
  const m = Number(mRaw) || 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function jstDateTimeToIso(dateKey: string, time: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute || 0, 0, 0)).toISOString();
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
