# SalonBoard クラウドスクレイピング方式 — Akamai 突破の確定レシピ

> **2026-06-17 確定。** 物理PC無しで EC2 上から salonboard にログイン → 予約一覧(深層認証ページ)取得まで **end-to-end 成功**(ログイン 2.3秒)。
> 本書は **同じ試行錯誤を繰り返さないための「動く方法」と「やってはいけないこと」** をまとめる。全体移行設計は [aws-migration.md](./aws-migration.md) を参照。

---

## TL;DR — 動く完全レシピ

salonboard は **Akamai Bot Manager** で守られている(IPだけでなく **クライアント指紋** = TLS/JA3・HTTP/2・ブラウザ指紋 を見る)。クラウド(データセンター)から突破するには **以下3点すべて** が必須。**1つでも欠けると詰まる。**

| # | 要素 | 欠けると |
|---|------|---------|
| 1 | **headful 実Chrome + Xvfb**(headless不可) | GETの時点で tarpit(無応答) |
| 2 | **`docker run --cap-add=SYS_ADMIN`**(→ `--no-sandbox` を使わない) | --no-sandbox有り=doLogin 53秒ホールド / 無し+SYS_ADMIN無し=Chrome起動不可 |
| 3 | **ステルス起動 + 信頼される固定IP(専用ISP + whitelist)** | bot判定・tarpit |

**実測**: この3点で **ログイン 2.3秒 + 予約一覧 200 取得成功**。

---

## 1. headful 実Chrome + Xvfb

- **`channel: "chrome"`** — bundled Chromium ではなく **実 Google Chrome**。
- **headless は使わない。** Akamai は headless Chrome の指紋を検知し、GET の時点で tarpit する(これを長らく「IP評判の壁」と誤診していた → §誤診の歴史)。
- クラウド(GUI無し)では **Xvfb 仮想ディスプレイ上で headful 起動**する。`xvfb-run` は非root下でハングするため使わず、**明示的に `Xvfb :99` をバックグラウンド起動 + `export DISPLAY=:99`**(`docker/entrypoint-worker.sh` 実装済)。
- env: `SB_BROWSER_CHANNEL=chrome` / `SB_HEADLESS=0`。
- ⚠️ **`worker.ts` の既定は `SB_HEADLESS !== "0"` = headless**(`worker.ts:1006` 付近)。必ず **entrypoint 経由(SB_HEADLESS=0)** で起動すること。直叩き(ローカル `tsx`・healthcheck等)は headless になり tarpit する罠。

## 2. `--cap-add=SYS_ADMIN`(`--no-sandbox` を使わない)

- **`--no-sandbox` は Akamai が doLogin POST を無応答ホールドする自動化指紋**(`worker.ts:1082` コメント参照)。
  - 実測: `--no-sandbox` 有り = **doLogin 53秒ホールド** / 無し = **2.3秒成功**。
- だがコンテナ内で `--no-sandbox` 無しに Chrome を起動するにはサンドボックスが名前空間を作る権限が要る。**`docker run --cap-add=SYS_ADMIN`** を付ける。
  - これが無いと `zygote_host_impl_linux.cc ... Operation not permitted` で **Chrome 起動不可**。
- `docker/Dockerfile.worker` は **`USER pwuser`(非root)**。`playwright install --with-deps chrome` で chrome-sandbox(setuid)入り → pwuser + SYS_ADMIN でサンドボックス起動できる。
- ⚠️ **Fargate は `--cap-add` 不可**。SYS_ADMIN が要るので **EC2(または cap 対応の計算ホスト)で動かす**。Fargate は不可。

## 3. ステルス起動 + 信頼される固定IP

**ステルス起動**(`worker.ts` の `launchStealthContext`, line ~1088):
- `chromium.launchPersistentContext(userDataDir, …)` — 店舗ごと `userDataDir`(`~/.kireidot/salonboard-chrome-profile/{shopId}`)。回またぎで Akamai センサー cookie を蓄積し信頼を育てる。
- `ignoreDefaultArgs: ["--enable-automation","--disable-blink-features=AutomationControlled","--no-sandbox"]` — Playwright が付けるこれらの **自動化指紋を除去**。
- `addInitScript`: `navigator.webdriver → undefined` / `window.chrome` を生やす。
- `args: ["--disable-features=IsolateOrigins,site-per-process"]`、viewport 1366×900、`locale: ja-JP`、`timezoneId: Asia/Tokyo`。
- **実Chromeは UA を偽装しない**(Linux実ChromeにMac UAを被せると `Sec-CH-UA-Platform` と矛盾し逆に検知シグナルになる)。

**IP = 専用ISPプロキシ `isp.decodo.com:10001`**(Decodo Dedicated ISP・東京・¥1,500/月で3IP・帯域無制限・既契約。ポート 10001/10002/10003 = 各専用IP):
- クラウドからは **whitelist 認証**(EC2 の EIP を Decodo の Whitelisted IPs に登録 → **認証情報不要**で接続)。
- ⚠️ `SB_PROXY_USERNAME/PASSWORD` の **user/pass 認証はデータセンター送信元IP(EC2 egress)を遮断する**ので、クラウドでは使わない(whitelist で通す)。住宅IP(ローカルMac等)なら user/pass も通る。
- **モバイルプロキシは不要**(「深層ページの壁=IP評判、モバイル必須」は誤診。真因は headless。専用ISP IP で深層もログインも通る)。

---

## 実証結果(2026-06-17, EC2)

EC2 `i-0f1cc0aff1ac8dd2e`(t3.small / al2023 / EIP **18.178.148.139**)の Docker コンテナ内で:

```
[ec2] proxy check (whitelist): 82.29.246.148          ← 専用IP・認証情報不要で疎通
[probe] login page: "ログイン：SALON BOARD" 2034ms
[probe] post-login: reached_KLP=true login_ms=2307 url=/KLP/top/ title="SALON BOARD : TOP"
[probe] reserveList: status=200 title="SALON BOARD : 予約一覧" expired=false
[probe] body: Unelimit Silk 銀座店 … 予約管理 … 予約一覧 … 未読 仮予定未確定 来店処理未登…
[probe] => OK authenticated deep page fetched
```

テスト店舗: **Unelimit Silk 銀座店 (ID CE51481)**。フレッシュプロファイル(seed無し)でもログイン成功 = **S3セッション再利用は最適化であって必須ではない**(ログイン自体が2.3秒で通る)。

---

## ❌ やってはいけないこと(誤診の歴史)

| 症状 | 誤った結論(回避すべき) | 真因 |
|------|----------------------|------|
| 深層ページが 30〜45秒 tarpit | 「Level3 IPは評判が悪い → モバイルプロキシ必須」 | **headless Chrome の指紋**(headful なら 0.8秒で到達) |
| doLogin が無応答ハング | 「自動ログインは不可能」「Akamai越え不能」 | **`--no-sandbox` 指紋**(SYS_ADMIN + 除去で 2.3秒成功) |
| curl / WebFetch で salonboard が timeout | 「salonboard ダウン」「専用IPが flagged」 | **curl はブラウザ指紋が無く無条件 tarpit**。到達性は **必ず実Chrome(Playwright)** で測る。ipinfo.io 等の Akamai 無しサイトはプロキシ疎通確認には使える |
| Decodo **Scraping API** でログイン不可(システムエラー・`_abck` 未検証) | — | ステートレス(毎回新ブラウザ)で信頼セッションを保持できず**ログインに不向き**。GET読み取りは Akamai 越え可だが、ログインは自前 headful Chrome で行う |
| AWS CLI `credentials … still expired` | 「SSO 再ログインが必要」 | **aws-vault の期限切れ env 認証情報(`AWS_ACCESS_KEY_ID`/`SESSION_TOKEN`)が `--profile` を上書き**。`unset` して `AWS_PROFILE` を使えば SSO キャッシュで通る |

---

## 検証方法(再テスト手順)

### 共通: AWS 認証(重要な落とし穴)

```bash
# aws-vault の古い env 認証情報が profile を上書きするので必ず外す
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_VAULT
export AWS_PROFILE=kireidot-prod AWS_DEFAULT_REGION=ap-northeast-1
aws sts get-caller-identity   # 972293797066 / AdministratorAccess が返ればOK
```
⚠️ **zsh では `REG="--profile x --region y"; aws $REG …` は単語分割されず壊れる**(`Unknown options`)。`AWS_PROFILE` 環境変数を使う。

### EC2 コンテナ内テスト(本番同等)

EC2 起動 → SSM run-command で docker run。要点だけ:
```bash
docker run --rm --cap-add=SYS_ADMIN \
  -e SB_PROXY_SERVER=isp.decodo.com:10001 \
  -e SB_BROWSER_CHANNEL=chrome -e SB_HEADLESS=0 \
  --entrypoint /bin/sh <ECR-image> -c '
    rm -f /tmp/.X99-lock
    Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    export DISPLAY=:99; sleep 2
    cd /app && node /app/probe.mjs        # or the real worker
  '
```
- プロキシ疎通(whitelist)確認: `curl -x http://isp.decodo.com:10001 https://ipinfo.io/ip` → 専用IP(82.29.246.148 等)が返る。
- 検証プローブ `login-probe.ts` / `deeppage-probe.ts` は使い捨て(未コミット)。`launchPersistentContext` + 上記ステルス設定 + `--no-sandbox` を **付けない** こと。

---

## アーキテクチャ / 次の統合(残タスク)

1. **実 worker(`fetch_bookings` 他9種)を SYS_ADMIN 付きで EC2 実行 → Admin API へ結果報告まで** end-to-end。
   - ⚠️ 現 ECR `latest` は **2026-06-14 push = ログイン修正前**。2026-06-16 のログイン修正(`isLoggedIn`=/KLP/top/肯定判定・`tryLogin`=a.common-CNCcommon__primaryBtn 等)を **イメージに焼き込む(再ビルド)** か、ビルド済 `worker.cjs` をマウントする。
2. **`--cap-add=SYS_ADMIN` を本番起動コマンド / タスク定義に必須反映**(Fargate不可 → EC2 等)。
3. **S3 セッション再利用**(`STATE_S3_BUCKET`): ログイン1回 → `storageState` を S3 保存 → 以後再利用(ログイン頻度・所要時間を最小化)。`worker.ts` は既に店舗別 storageState 保存・再利用の作り。
4. **pg_cron で fetch 系を定期 enqueue**(クラウドはキュー経由)。
5. **他のクロール対象**(スタッフ/メニュー/シフト/売上/予約登録 push 等)も **同じレシピで横展開**(深層ページは全て同じ Akamai 壁)。

## コスト

- 専用ISP **¥1,500/月**(3IP・帯域無制限・既契約)。1IP で複数店舗共有可(上限は Akamai の「1IP×多アカウント」検知で実測チューニング)。
- EC2 t3.small **~$20/月**(常時起動時。待機時 stop で節約・EIP 保持)。
- **モバイルプロキシ不要**。

---

## A① 本番移行(クラウド fetch ルーティング)の設計 — 2026-06-17 prep

`fetch_bookings` を EC2 に流し、PC に横取り(掴んで cancel)させないための設計。Admin リポジトリ `KireidotAdimn` の claim RPC を精読した結果。

**現状の claim(精読済):**
- `salonboard_claim_next_job`(central-dev = **EC2 が使用**、`029_salonboard_integration.sql:279`): フィルタ無しで **全 queued ジョブを claim**(`status='queued' and run_at<=now() and 未locked`、priority/run_at 順、`FOR UPDATE SKIP LOCKED`)。
- `salonboard_claim_next_job_for_device`(**PC** = device、`118_salonboard_drop_consent_check.sql:18`): 自 device 許可店舗の **全種別を claim**(同店 5分以内 running は除外する shop 排他あり)。→ **PC が fetch_bookings も掴む → 処理せず cancel → EC2 をブロック**(= A① の障害の正体)。
- 既存 hook: `executor` 列(`175_salonboard_jobs_executor_column.sql`、既定 `'playwright'`、CHECK `playwright/openclaw`、**routing/claim フィルタ未実装**)。
- 別機構: アクティブ/スタンバイ機(`X-Machine-Id` + `salonboard_worker_heartbeats.is_active`、`jobs/route.ts:50`)。

**🚨 設計訂正 (2026-06-23 実装時、本番DBで判明)**: 上の「PC = device 認証」前提は**誤り**。本番の店舗 PC は **device 認証ではなく global token = central-dev モード**で動いている(`salonboard_sync_devices` テーブルは**空**=device 経路は本番未使用。直近ジョブも全て central 経由)。**つまり PC も EC2 も同じ `salonboard_claim_next_job`(central-dev)を使い、認証モードでは区別できない**。区別は **worker 申告の capabilities**(worker.ts が `?capabilities=`=`WORKER_CAPABILITIES` を送る)で行う。

**実装した設計(executor ルーティング、2026-06-23 本番適用済 / KireidotAdimn `feat/salonboard-executor-cloud-routing` commit 3b4d391):**
1. `executor` CHECK に `'playwright_cloud'` を追加(`('playwright','playwright_cloud','openclaw')`)。
2. `salonboard_claim_next_job`(central, **PC も EC2 も使う**)に **`p_executor text default null`** を追加(3引数→4引数, 旧版 DROP)。`(p_executor is null or executor = p_executor)` で**自分の executor のジョブだけ** exact-match claim。
3. `jobs/route.ts` の central-dev 分岐で **`?capabilities=` に `playwright_cloud` を含めば `p_executor='playwright_cloud'`(EC2)、それ以外/未指定は `p_executor='playwright'`(PC)** を渡す。→ PC↔playwright / EC2↔playwright_cloud に住み分け。
4. `salonboard_claim_next_job_for_device`(device, 本番未使用だが将来の多テナント用)にも `executor is distinct from 'playwright_cloud'` を追加。
5. `fetch_bookings`(+将来の fetch 系)を **`executor='playwright_cloud'`** で enqueue するのは**カットオーバー手順**(pg_cron 定期 enqueue / `enqueueSalonboardFetchBookings` 既定変更)。migration 自体は executor を変えない=デプロイで no-op。
6. callback / データ反映は既存実証済みコード(`callback/route.ts`)をそのまま使用(worker 非依存)。

**検証(実施済)**: 本番1059件全て `executor='playwright'`・cloud ジョブ皆無=適用は no-op。read-only シミュレーションでパーティション確認、適用後 smoke test(`p_limit=0`)で central claim 実行・署名・CHECK・queued 全件 PC 可視(非回帰)を確認。claim 関数の内部依存なし(DROP 安全)。Supabase ブランチは不要だった(no-op + ロジック証明 + smoke test で十分)。

**残(カットオーバー)**: ① route 変更を Vercel デプロイ ② EC2 に `WORKER_CAPABILITIES=playwright_cloud` 設定 ③ fetch を `executor='playwright_cloud'` で enqueue(pg_cron)④ EC2 常時起動 + 本番 ECR 再ビルド。ロールバックは 029/118 の旧定義再適用。
