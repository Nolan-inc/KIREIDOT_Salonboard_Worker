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
