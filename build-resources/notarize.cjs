/**
 * electron-builder afterSign フック: macOS の dmg 内 .app を notarize する。
 *
 * 使い方:
 *   1) 推奨 (Keychain profile 方式)
 *      ターミナルで一度だけ:
 *        xcrun notarytool store-credentials "予約同期くん-notary" \
 *          --apple-id <YOUR_APPLE_ID> \
 *          --team-id 7FMVQPBJKA \
 *          --password <APP-SPECIFIC-PASSWORD>
 *
 *      .env.local に以下を書いておく:
 *        APPLE_NOTARY_KEYCHAIN_PROFILE=予約同期くん-notary
 *
 *      npm run dist:mac:arm64
 *
 *   2) フォールバック (環境変数方式)
 *      .env.local に:
 *        APPLE_ID=...
 *        APPLE_APP_SPECIFIC_PASSWORD=...
 *        APPLE_TEAM_ID=7FMVQPBJKA
 *
 * セキュリティ:
 *   - 秘密情報は .env.local (= .gitignore で除外済み) または macOS Keychain で管理。
 *   - このスクリプト自身には絶対に値を書き込まない。
 *
 * スキップ条件:
 *   - macOS 以外で実行された場合
 *   - SKIP_NOTARIZE=1 が設定されている場合 (開発ビルド用: npm run dist:mac:nosign)
 *
 * 認証情報が無い場合はビルドを失敗させる (旧挙動は警告のみでスキップだったが、
 * 公証なしビルドが誤って公開されると全端末の自動更新が壊れるため fail-fast 化)。
 */

const { notarize } = require("@electron/notarize");
const path = require("node:path");

// dotenv-like loader (devDependency を増やさない軽量実装)
(function loadDotEnv() {
  try {
    const fs = require("node:fs");
    for (const file of [".env.local", ".env"]) {
      const p = path.join(process.cwd(), file);
      if (!fs.existsSync(p)) continue;
      const body = fs.readFileSync(p, "utf8");
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const [, k, rawV] = m;
        if (process.env[k] !== undefined) continue; // 既存を優先
        process.env[k] = rawV.replace(/^['"]|['"]$/g, "");
      }
    }
  } catch (e) {
    console.warn("[notarize] .env.local の読み込みに失敗:", e.message);
  }
})();

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize] SKIP_NOTARIZE=1 のためスキップ");
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const appBundleId = packager.appInfo.id;

  const keychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  // 認証情報が無い場合はビルドを失敗させる (公証なしビルドの誤公開防止)。
  // 開発用ビルドで意図的にスキップする場合は SKIP_NOTARIZE=1 を明示すること。
  // (v0.2.219 事故: 公証スキップ+誤証明書のまま公開され全端末の自動更新が
  //  「コードは指定されたコード要件を満たしていません」で失敗した)
  if (!keychainProfile && !(appleId && password && teamId)) {
    throw new Error(
      "\n[notarize] ❌ 公証の認証情報が見つかりません。公証なしでの公開は自動更新を壊すため中断します。\n" +
        "    開発ビルドで意図的にスキップするには SKIP_NOTARIZE=1 を設定 (npm run dist:mac:nosign)。\n" +
        "    Keychain profile 方式:\n" +
        "      xcrun notarytool store-credentials \"予約同期くん-notary\" \\\n" +
        "        --apple-id <YOUR_APPLE_ID> --team-id 7FMVQPBJKA \\\n" +
        "        --password <APP-SPECIFIC-PASSWORD>\n" +
        "      その後 .env.local に APPLE_NOTARY_KEYCHAIN_PROFILE=予約同期くん-notary を追加\n" +
        "    または環境変数方式:\n" +
        "      APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID を .env.local に設定\n",
    );
  }

  const opts = keychainProfile
    ? {
        tool: "notarytool",
        appPath,
        appBundleId,
        keychainProfile,
      }
    : {
        tool: "notarytool",
        appPath,
        appBundleId,
        appleId,
        appleIdPassword: password,
        teamId,
      };

  console.log(
    `[notarize] start: ${appName}.app (mode: ${keychainProfile ? "keychain-profile" : "env-vars"})`,
  );
  const t0 = Date.now();
  try {
    await notarize(opts);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[notarize] ✅ done in ${sec}s`);
  } catch (e) {
    console.error("[notarize] ❌ 公証に失敗しました:", e.message);
    throw e;
  }
};
