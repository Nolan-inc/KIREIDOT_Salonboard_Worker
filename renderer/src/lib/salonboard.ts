/**
 * 予約同期くん: サロンボード認証情報のマルチ会社×店舗管理
 *
 * Supabase の salonboard_credentials_overview ビューと、
 * salonboard_upsert_credentials / salonboard_delete_credentials /
 * salonboard_set_credential_enabled RPC を呼ぶラッパー。
 *
 * RLS により super_owner / admin のみ書込み可能。
 * super_owner は全組織横断、owner / shop_manager は自組織のみ閲覧。
 */

import { supabase } from './supabase';

export type CredentialOverviewRow = {
  organization_id: string;
  organization_name: string;
  shop_id: string;
  shop_name: string;
  credential_id: string | null;
  login_id: string | null;
  base_url: string | null;
  enabled: boolean | null;
  sync_interval_minutes: number | null;
  last_login_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number | null;
  blocked_until: string | null;
  has_credential: boolean;
  credential_created_at: string | null;
  credential_updated_at: string | null;
};

/**
 * 会社×店舗グリッドを描画するためのフラットな一覧。
 * UI 側で organization_id でグルーピングする。
 *
 * これは「認証情報の設定画面」で使う読み取りなので、Supabase 直読みを維持する。
 * (super_owner / admin / owner / shop_manager で signed-in しているユーザーが
 * RLS 越しに自分の権限内の店舗を見るのが目的)
 *
 * 一方、Electron 同期ループ用 (= device 認証で済む短い view) は
 * fetchDeviceOverview() を使うこと。
 */
export async function fetchCredentialOverview(): Promise<CredentialOverviewRow[]> {
  const { data, error } = await supabase
    .from('salonboard_credentials_overview')
    .select('*');
  if (error) {
    console.warn('[salonboard] fetchCredentialOverview error:', error.message);
    return [];
  }
  return (data ?? []) as CredentialOverviewRow[];
}

// ---------------------------------------------------------------------------
// device 認証経由の overview (Electron アプリの同期ループ用)
//
// 旧: supabase.from('salonboard_credentials_overview') を直叩き
// 新: GET /api/salonboard/device/overview (device token 認証)
//
// これにより Electron 側の Supabase セッションに「組織全体の credentials を見る」
// 強い権限が無くても自分の shop の sync 状態が取れるようになる。
// ---------------------------------------------------------------------------

export type DeviceOverviewShop = {
  shop_id: string;
  shop_name: string;
  organization_id: string;
  credential_status: 'active' | 'missing' | 'disabled' | 'blocked';
  consent_status: 'valid' | 'missing';
  sync_status:
    | 'normal'
    | 'blocked'
    | 'rate_limited'
    | 'login_required'
    | 'captcha_detected'
    | 'warning'
    | 'consent_required'
    | 'credentials_missing';
  enabled: boolean;
  blocked_until: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  consecutive_failures: number;
  base_url: string | null;
  login_id_masked: string | null;
};

export type DeviceOverviewResult = {
  ok: boolean;
  code?: string;
  device: {
    id: string | null;
    organization_id: string | null;
    status: string | null;
    device_name: string | null;
    device_platform: string | null;
    app_version: string | null;
    last_seen_at: string | null;
  } | null;
  shops: DeviceOverviewShop[];
};

function deviceAuthHeaders(): Record<string, string> | null {
  const token = import.meta.env.VITE_SALONBOARD_DEVICE_TOKEN as string | undefined;
  const id = import.meta.env.VITE_SALONBOARD_DEVICE_ID as string | undefined;
  if (!token || !id) return null;
  return {
    Authorization: `Bearer ${token}`,
    'X-Device-Id': id,
    'X-Worker-Id':
      (import.meta.env.VITE_WORKER_ID as string | undefined) ?? 'electron-worker',
    ...(import.meta.env.VITE_APP_VERSION
      ? { 'X-App-Version': String(import.meta.env.VITE_APP_VERSION) }
      : {}),
    'X-Platform':
      typeof window !== 'undefined' && window.salondesk?.platform
        ? String(window.salondesk.platform)
        : 'unknown',
  };
}

function adminApiBase(): string | null {
  const v =
    (import.meta.env.VITE_KIREIDOT_API_URL as string | undefined) ??
    (import.meta.env.VITE_ADMIN_API_URL as string | undefined) ??
    '';
  if (!v) return null;
  return v.replace(/\/+$/, '');
}

export async function fetchDeviceOverview(): Promise<DeviceOverviewResult> {
  const base = adminApiBase();
  const headers = deviceAuthHeaders();
  if (!base || !headers) {
    return { ok: false, code: 'device_auth_missing', device: null, shops: [] };
  }
  try {
    const res = await fetch(`${base}/api/salonboard/device/overview`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        code: (body && body.error) || `http_${res.status}`,
        device: null,
        shops: [],
      };
    }
    const json = (await res.json()) as DeviceOverviewResult;
    return { ok: true, device: json.device ?? null, shops: json.shops ?? [] };
  } catch (e: any) {
    return {
      ok: false,
      code: 'network_error',
      device: null,
      shops: [],
    };
  }
}

// ---------------------------------------------------------------------------
// device 認証経由の「新規予約作成 → SalonBoard 書き戻し」
//
// 予約同期くんの画面から予約を作る。Worker は顧客マスタや Admin の
// menu_id / staff_id を持たないため、SalonBoard 解決済みの値
// (スタッフ external_id・メニュー名・顧客名手入力) を Admin API に渡す。
// Admin 側で bookings 挿入 + push_booking ジョブ投入まで行う。
//
//   POST /api/salonboard/device/bookings/create
// ---------------------------------------------------------------------------

export type CreateBookingViaDeviceArgs = {
  shopId: string;
  scheduledAt: string; // JST オフセット付き ISO (例 2026-06-05T10:00:00+09:00)
  staffExternalId: string; // W001######
  staffName?: string | null;
  menuName?: string | null; // SalonBoard メニュー名
  durationMin?: number;
  amount?: number;
  customerName?: string | null;
  notes?: string | null;
};

export type CreateBookingViaDeviceResult =
  | {
      ok: true;
      bookingId: string;
      /** "pending_push" = push ジョブ投入済み / "not_enqueued" = 連携無効等で未投入 */
      syncStatus: 'pending_push' | 'not_enqueued';
    }
  | { ok: false; error: string; status?: number };

/**
 * 予約を作成し、SalonBoard への push_booking ジョブまで積む。
 * device token が無い / Admin API URL 未設定なら ok:false を返す。
 * エラーは UI でそのまま表示できるよう、原因を文字列で返す。
 */
export async function createBookingViaDevice(
  args: CreateBookingViaDeviceArgs,
): Promise<CreateBookingViaDeviceResult> {
  // 認証情報 (apiUrl / token) は userData の device 設定にあり、renderer から
  // 直接は読めない。main プロセス (window.kireidotApp.deviceConfig.createBooking)
  // 経由で Admin API を叩く。VITE_ 環境変数には依存しない。
  const bridge = typeof window !== 'undefined' ? window.kireidotApp : undefined;
  if (!bridge?.deviceConfig?.createBooking) {
    return {
      ok: false,
      error: 'この機能はデスクトップアプリでのみ利用できます (ブラウザ版では不可)',
    };
  }
  try {
    const r = await bridge.deviceConfig.createBooking({
      shopId: args.shopId,
      scheduledAt: args.scheduledAt,
      staffExternalId: args.staffExternalId,
      staffName: args.staffName ?? null,
      menuName: args.menuName ?? null,
      durationMin: args.durationMin ?? 60,
      amount: args.amount ?? 0,
      customerName: args.customerName ?? null,
      notes: args.notes ?? null,
    });
    if (!r.ok) {
      return { ok: false, error: r.error ?? '予約の作成に失敗しました', status: r.status };
    }
    return {
      ok: true,
      bookingId: r.bookingId ?? '',
      syncStatus: r.syncStatus === 'pending_push' ? 'pending_push' : 'not_enqueued',
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * 認証情報を upsert する。
 * - shop_id ごとに 1 行 (UNIQUE(shop_id))
 * - password は平文で送信し、DB 側で pgsodium 暗号化される
 * - super_owner / admin 以外は forbidden エラー
 */
export async function upsertSalonboardCredentials(args: {
  shopId: string;
  organizationId: string;
  loginId: string;
  password: string;
  baseUrl: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('salonboard_upsert_credentials', {
    p_shop_id: args.shopId,
    p_organization_id: args.organizationId,
    p_login_id: args.loginId,
    p_password: args.password,
    p_base_url: args.baseUrl ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: String(data) };
}

/**
 * 既存の認証情報 (平文パスワード含む) を取得する。
 * 編集モーダルを開いたときに「すでに保存済みのパスワード」を prefill するために使う。
 *
 *   - super_owner / admin: 全店舗
 *   - owner: 自社の店舗のみ
 *   - shop_manager: 自店舗のみ
 *   - staff: 拒否される
 */
export async function revealSalonboardCredentials(
  shopId: string,
): Promise<
  | { ok: true; loginId: string; password: string; baseUrl: string | null }
  | { ok: false; error: string }
> {
  const { data, error } = await supabase.rpc('salonboard_reveal_credentials', {
    p_shop_id: shopId,
  });
  if (error) return { ok: false, error: error.message };
  const row = (data as Array<{ login_id: string; password: string; base_url: string | null }>)?.[0];
  if (!row) return { ok: false, error: '認証情報が見つかりません' };
  return {
    ok: true,
    loginId: row.login_id,
    password: row.password,
    baseUrl: row.base_url,
  };
}

/** 認証情報を削除 (super_owner / admin のみ) */
export async function deleteSalonboardCredentials(
  shopId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.rpc('salonboard_delete_credentials', {
    p_shop_id: shopId,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** 有効/無効を切り替え (一時的な停止に使う) */
export async function setSalonboardCredentialEnabled(
  shopId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.rpc('salonboard_set_credential_enabled', {
    p_shop_id: shopId,
    p_enabled: enabled,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ====================================================================
// 同期実行履歴 (salonboard_sync_run_summary view)
// ====================================================================
export type SyncRunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  total_shops: number;
  ok_shops: number;
  ng_shops: number;
  aborted: boolean;
  channels: string[] | null;
  source: string | null;
  total_bookings: number;
  total_staff: number;
  total_blogs: number;
  total_customers: number;
};

export async function fetchRecentSyncRuns(limit = 20): Promise<SyncRunRow[]> {
  const { data, error } = await supabase
    .from('salonboard_sync_run_summary')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[salonboard] fetchRecentSyncRuns error:', error.message);
    return [];
  }
  return (data ?? []) as SyncRunRow[];
}
