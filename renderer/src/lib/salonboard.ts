export type SalonboardShop = {
  id: string;
  name: string;
  organization_id: string;
  has_credentials: boolean;
  salonboard_enabled: boolean;
};

export type SalonboardOrganization = {
  id: string;
  name: string;
  invite_code: string | null;
  shops: SalonboardShop[];
};

export type SyncTargets = {
  bookings: boolean;
  staff: boolean;
  shifts: boolean;
  blogs: boolean;
};

export type SyncTargetResult = {
  scraped: number;
  received?: number;
  inserted: number;
  updated: number;
  errors?: string[];
  error?: string;
};

export type SalonboardSyncResult = {
  ok: boolean;
  shopId: string;
  syncedAt: string;
  results: Partial<Record<keyof SyncTargets, SyncTargetResult>>;
  logs: string[];
};

export const DEFAULT_SYNC_TARGETS: SyncTargets = {
  bookings: true,
  staff: true,
  shifts: true,
  blogs: true,
};

export function defaultApiUrl(): string {
  return (import.meta.env.VITE_KIREIDOT_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export async function fetchSalonboardOrganizations(
  apiUrl: string,
  accessToken: string,
): Promise<SalonboardOrganization[]> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/salonboard/organizations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Cache-Control': 'no-store',
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `組織一覧の取得に失敗しました (${res.status})`);
  }
  return (json?.organizations ?? []) as SalonboardOrganization[];
}

export async function saveSalonboardCredentials(input: {
  apiUrl: string;
  accessToken: string;
  shopId: string;
  loginId: string;
  password: string;
  baseUrl: string;
  syncIntervalMinutes: number;
}): Promise<void> {
  const res = await fetch(`${input.apiUrl.replace(/\/+$/, '')}/api/salonboard/credentials`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shop_id: input.shopId,
      login_id: input.loginId,
      password: input.password,
      base_url: input.baseUrl.trim() || null,
      sync_interval_minutes: input.syncIntervalMinutes,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `認証情報の保存に失敗しました (${res.status})`);
  }
}

export async function runLocalSalonboardSync(input: {
  apiUrl: string;
  accessToken: string;
  shopId: string;
  targets: SyncTargets;
  showBrowser: boolean;
}): Promise<SalonboardSyncResult> {
  if (!window.salondesk?.syncSalonboard) {
    throw new Error('Electron の同期 API が見つかりません。デスクトップアプリから実行してください。');
  }
  return await window.salondesk.syncSalonboard(input);
}
