// =====================================================================
// device 設定の永続化 (v0.2.5)
//
// 店舗 PC ごとに異なる device_id / device_token を、ビルド成果物に焼き込まず
// Electron の userData 配下に保存する。
//
//   保存先: {userData}/salonboard-device.json   (パーミッション 0600)
//
// セキュリティ方針:
//   - deviceToken はログに出さない (この モジュールは絶対に token を console に出さない)
//   - DB には plain token を保存しない既存方針は維持 (ここはローカル PC のみ)
//   - ファイル権限を 0600 に制限
//   - renderer に返すときは token を last4 だけにマスクする (getMasked)
//
// 将来 (v0.3.0+): Electron safeStorage で暗号化保存に移行する余地を残す。
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

/** 設定ファイルのフルパス。app は呼び出し側から渡す (テスト容易性のため)。 */
function configPath(app) {
  return path.join(app.getPath('userData'), 'salonboard-device.json');
}

/**
 * device 設定を読む。無ければ null。
 * 戻り値は raw (token を含む) — main process 内 / worker への受け渡しのみで使う。
 */
function readDeviceConfig(app) {
  try {
    const p = configPath(app);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object') return null;
    return {
      deviceId: typeof json.deviceId === 'string' ? json.deviceId : null,
      deviceToken: typeof json.deviceToken === 'string' ? json.deviceToken : null,
      apiUrl: typeof json.apiUrl === 'string' ? json.apiUrl : null,
      deviceName: typeof json.deviceName === 'string' ? json.deviceName : null,
      workerId: typeof json.workerId === 'string' ? json.workerId : null,
      configuredAt: json.configuredAt ?? null,
      lastVerifiedAt: json.lastVerifiedAt ?? null,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * device 設定を書く。token を含む raw を受け取り、0600 で保存する。
 * 既存の configuredAt は維持する。
 */
function writeDeviceConfig(app, cfg) {
  const p = configPath(app);
  const existing = readDeviceConfig(app);
  const merged = {
    deviceId: cfg.deviceId ?? existing?.deviceId ?? null,
    deviceToken: cfg.deviceToken ?? existing?.deviceToken ?? null,
    apiUrl: cfg.apiUrl ?? existing?.apiUrl ?? null,
    deviceName: cfg.deviceName ?? existing?.deviceName ?? null,
    workerId: cfg.workerId ?? existing?.workerId ?? null,
    configuredAt: existing?.configuredAt ?? new Date().toISOString(),
    lastVerifiedAt:
      cfg.lastVerifiedAt !== undefined
        ? cfg.lastVerifiedAt
        : existing?.lastVerifiedAt ?? null,
  };
  // 先に書いてから chmod (umask に左右されないよう明示)
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch (_e) {
    /* 一部 FS では失敗するが致命的でない */
  }
  return merged;
}

/** device 設定を削除する。 */
function clearDeviceConfig(app) {
  try {
    const p = configPath(app);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * renderer に返す用に token をマスクした設定を返す。
 * deviceToken は last4 のみ ("****abcd")。完全な token は決して renderer に渡さない。
 */
function getMaskedDeviceConfig(app) {
  const cfg = readDeviceConfig(app);
  if (!cfg) {
    return { configured: false };
  }
  return {
    // global token 運用: deviceId が無くても token + apiUrl があれば「設定済み」。
    configured: !!(cfg.deviceToken && cfg.apiUrl),
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    apiUrl: cfg.apiUrl,
    workerId: cfg.workerId,
    configuredAt: cfg.configuredAt,
    lastVerifiedAt: cfg.lastVerifiedAt,
    tokenLast4: cfg.deviceToken ? cfg.deviceToken.slice(-4) : null,
  };
}

/**
 * device 設定の接続テスト。
 *
 * 与えられた apiUrl / deviceId / deviceToken で
 * GET /api/salonboard/device/overview を叩き、結果を分類して返す。
 *
 * 引数 cfg を省略した場合は userData の保存済み設定を使う。
 *
 * 戻り値 (token は含めない):
 *   { ok: true,  code: 'connected', shops: [...], device: {...} }
 *   { ok: false, code: 'device_unconfigured' | 'unauthorized' | 'no_shops_assigned'
 *                     | 'network_error' | 'http_xxx' | 'unknown', message: '...' }
 *
 * 注意: この関数は deviceToken をログ・戻り値・error に含めない。
 */
async function testDeviceConfig(app, cfg) {
  const c = cfg ?? readDeviceConfig(app);
  // global token 運用: apiUrl + token があれば OK (deviceId は任意)。
  if (!c || !c.apiUrl || !c.deviceToken) {
    return { ok: false, code: 'device_unconfigured', message: 'API URL と Token を入力してください' };
  }
  const base = String(c.apiUrl).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/api/salonboard/device/overview`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${c.deviceToken}`,
        // deviceId がある場合のみ device 認証ヘッダを付ける。
        // 無ければ global token モード (X-Device-Id を付けない → 全店舗)。
        ...(c.deviceId ? { 'X-Device-Id': c.deviceId } : {}),
        'X-Worker-Id': c.workerId || 'electron-worker',
        'X-Platform': process.platform,
      },
    });
  } catch (_e) {
    // ネットワークエラー: 例外メッセージに token が混ざらないよう固定文言で返す
    return {
      ok: false,
      code: 'network_error',
      message: 'KIREIDOT Admin に接続できません。API URL とネット接続を確認してください。',
    };
  }

  if (res.status === 401) {
    return {
      ok: false,
      code: 'unauthorized',
      message:
        'device token が正しくないか、この device は無効化/一時停止されています。',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: `http_${res.status}`,
      message: `API エラー (HTTP ${res.status})`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (_e) {
    return { ok: false, code: 'unknown', message: 'API レスポンスを解析できませんでした' };
  }

  const shops = Array.isArray(json.shops) ? json.shops : [];
  if (shops.length === 0) {
    return {
      ok: false,
      code: 'no_shops_assigned',
      message: 'この device に紐付いた店舗がありません。管理画面で紐付けてください。',
      device: json.device ?? null,
      shops: [],
    };
  }

  return {
    ok: true,
    code: 'connected',
    device: json.device ?? null,
    // shops は token を含まないので renderer にそのまま返してよい
    shops,
  };
}

module.exports = {
  configPath,
  readDeviceConfig,
  writeDeviceConfig,
  clearDeviceConfig,
  getMaskedDeviceConfig,
  testDeviceConfig,
};
