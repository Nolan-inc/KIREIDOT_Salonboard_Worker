/**
 * Playwright が使う Chromium バイナリを build-resources/playwright-browsers/ にコピーする。
 *
 * 背景:
 *   .app を配布したとき、Playwright は `process.env.PLAYWRIGHT_BROWSERS_PATH` か、
 *   未設定なら `~/Library/Caches/ms-playwright/` を見にいく。配布先 PC には
 *   後者は存在しないので、配布物 (Resources/playwright-browsers/) を見るように
 *   Electron 起動時に env を設定するのが正解。
 *
 *   そのために、ビルド前にこのスクリプトで開発機の ms-playwright cache から
 *   必要なバージョンの Chromium を build-resources/playwright-browsers にコピー
 *   する。electron-builder の extraResources でこのフォルダを .app に同梱する。
 *
 *   Playwright API がデフォルトで使うのは:
 *     - playwright.chromium.launch({ headless: true })
 *       → chromium_headless_shell-<rev>/  (軽量、推奨)
 *     - playwright.chromium.launch({ headless: false })
 *       → chromium-<rev>/                 (完全版)
 *
 *   今回の worker-process.cjs は showBrowser フラグで両方使い得るので、
 *   見つかった方をコピーする (主に headless_shell)。
 *
 * 注意:
 *   このスクリプトを動かす前に、開発機で必ず以下を実行しておくこと:
 *     npx playwright install chromium chromium-headless-shell
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SRC =
  process.env.PLAYWRIGHT_BROWSERS_PATH ||
  path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

const DEST = path.join(__dirname, 'playwright-browsers');

function rmRfSync(p) {
  if (!fs.existsSync(p)) return;
  if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
  else fs.rmdirSync(p, { recursive: true });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      try {
        fs.symlinkSync(link, d);
      } catch (_e) {
        // 失敗したら実体コピー
        try {
          fs.copyFileSync(fs.realpathSync(s), d);
        } catch (_e2) {
          /* ignore */
        }
      }
    } else if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function findChromiumDirs() {
  if (!fs.existsSync(SRC)) {
    console.error(`[playwright-copy] source not found: ${SRC}`);
    console.error(`  まず "npx playwright install chromium chromium-headless-shell" を実行してください`);
    process.exit(1);
  }
  const entries = fs.readdirSync(SRC, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(
      (n) =>
        n.startsWith('chromium-') ||
        n.startsWith('chromium_headless_shell-'),
    )
    // バージョンが新しいものを優先 (数字の末尾を比較)
    .sort((a, b) => {
      const av = Number((a.match(/(\d+)$/) || [0])[1]);
      const bv = Number((b.match(/(\d+)$/) || [0])[1]);
      return bv - av;
    });

  // showBrowser=true / 予約書き込みテスト (headed Chromium) で完全版 chromium が
  // 必要なため、デフォルトで完全版も同梱する。サイズ削減したい場合のみ
  // INCLUDE_FULL_CHROMIUM=0 で headless_shell だけにできる。
  const includeFull = !/^(0|false|no)$/i.test(process.env.INCLUDE_FULL_CHROMIUM ?? '1');
  const headless = dirs.find((d) => d.startsWith('chromium_headless_shell-'));
  const full = dirs.find((d) => d.startsWith('chromium-') && !d.startsWith('chromium_headless_shell-'));
  const result = [];
  if (headless) result.push(headless);
  if (includeFull && full) result.push(full);
  if (result.length === 0) {
    console.error('[playwright-copy] no chromium_headless_shell directory found in cache');
    console.error(`  まず "npx playwright install chromium-headless-shell" を実行してください`);
    process.exit(1);
  }
  return result;
}

function main() {
  console.log(`[playwright-copy] src=${SRC}`);
  console.log(`[playwright-copy] dest=${DEST}`);
  rmRfSync(DEST);
  fs.mkdirSync(DEST, { recursive: true });

  const dirs = findChromiumDirs();
  for (const name of dirs) {
    const s = path.join(SRC, name);
    const d = path.join(DEST, name);
    console.log(`[playwright-copy] copy ${name}`);
    copyDirSync(s, d);
  }
  console.log('[playwright-copy] done');
}

main();
