# KIREIDOT Salonboard Worker

KIREIDOT と SalonBoard(ホットペッパービューティー管理画面)を**双方向同期**するワーカー群のリポジトリ。

- **クラウドワーカー**(`worker.ts` + `electron/scrapers.cjs`): EC2上のDockerで常時稼働。予約書込・各種取込のメイン実行体
- **予約同期くん**(Electronデスクトップアプリ): 店舗PC(Mac Studio)で実Chromeセッションを保持し、クラウドが書けない状況(CAPTCHA等)の避難レーン+フォト/スタイル投稿を担当

アーキテクチャ全体・信頼性メカニズム・改善ロードマップは **[docs/system-architecture.md](docs/system-architecture.md)** を参照。
インフラ構成図(編集可能): **[docs/infra-architecture.drawio](docs/infra-architecture.drawio)**

---

## 1. 要件

### 1.1 機能要件 — 同期対象エンティティ

| エンティティ | SB→KD(取込) | KD→SB(反映) | 備考 |
|---|---|---|---|
| 予約 | ○ 巡回fetch+**予約通知メール取込**(即時) | ○ create/update/cancel | KD→SBは**3分SLA**。担当解決の後続ジョブあり |
| ブロック予定(休憩/会議等) | ○ スケジュール読取 | ○ | シフト日次反映に連動して再push |
| シフト/勤務パターン | ○(パターン未使用店は営業時間方式) | ○ 日次00:00+編集即時 | シフト一括入力は予定を消すため日別モーダル方式 |
| スタッフ | ○ | ○ プロフィール編集 | SB側再作成によるコード失効はclaim時に自動差替 |
| メニュー | ○ | ○ | |
| クーポン | ○ 9項目(No/写真/種別/名前/利用条件/内容/カテゴリ/金額/目安時間) | ○ 内容・掲載状態 | fetchは一覧+詳細のfetch直POST方式 |
| 設備(ベッド等) | ○ | ○ 受付可能数(+/-)含む | |
| 口コミ | ○ 一覧+全文 | ○ 返信投稿 | |
| ブログ | ○ | ○ クーポン紐付け対応 | |
| フォト/スタイル | ○ | ○ | 画像uploadはSB bot対策のため**PC経路**が既定 |
| こだわり/特集/サロン情報 | ○ | 一部 | 連携開始時の一括取込対象 |
| 売上 | 未実装 | - | scraper未実装(enqueue対象外にすること) |

制御要件:

- **機能別×方向別トグル**: `sync_features` の `<feature>_fetch` / `<feature>_push`(未設定=ON)。店舗単位で読み取り専用運用が可能(例: ADERはシフト取込のみON)
- **店舗形態**: 単独アカウント店と**グループアカウント店**(1ログインでN店舗・サロン選択必須)の両対応。hair(/CNB,/CLP)とesthetic(/CNK,/KLP)の**ジャンル混在**(GINA=ヘアグループ配下エステ)も対応
- **冪等性**: 全書込は「POST受理≠保存」を前提に実在確認まで行い、同一ジョブ再実行が安全であること

### 1.2 非機能要件

| 項目 | 要件 |
|---|---|
| SLO | 書込ジョブ成功率 **日次≥99%** / 実顧客予約の反映 **3分以内** |
| 可用性 | 書込フォールバック連鎖 **Cloud→予備Cloud→店舗PC**。単一ワーカー停止でSLAを失わない |
| SalonBoard側制約 | 同一アカウント同時1セッション/Akamai bot対策(画像認証CAPTCHA・ログインPOSTホールド)/データセンターIP拒否(**static ISP=書込・住宅IP=読み専用**)/予約枠15分刻み/クーポン名36字・内容90字・施術時間5分単位 |
| フラグ対応 | CAPTCHA検知時はログイン連打禁止(fail-fast)→アカウント冷却→**予約系は即PC移管**。フラグは3〜4時間で自然減衰する前提で設計 |
| セッション | userDataDir永続+SIGTERM flush でデプロイを跨いで維持。フレッシュログインは最終手段 |
| 監視/通知 | SuperAdmin同期監視ダッシュボード+Slack `#kireidot-info` へ結果通知(成功/失敗/手動要) |
| データ保護 | SB認証情報は `salonboard_credentials`(Supabase)のみ。ログ/通知に秘密情報を出さない |

---

## 2. リポジトリ構成

```
worker.ts               クラウドワーカー本体(claim/実行/callback/フォールバック)
electron/
  ├ scrapers.cjs        SalonBoard操作の実体(全エンティティのscraper/pusher 約1.6万行)
  ├ worker-process.cjs  予約同期くん内のワーカープロセス
  └ main.cjs ほか       Electronアプリ(予約同期くん)
renderer/               予約同期くんUI (React + Vite + Tailwind)
supabase/migrations/    ジョブ基盤のRPC/cron/テーブル定義
docs/                   設計資料(system-architecture.md が入口)
salonboard_code/        SB実DOMサンプル(パーサ検証用・エステ/美容室別)
docker/                 EC2デプロイ用エントリポイント
.github/workflows/
  ├ deploy-worker.yml   main push→EC2自動デプロイ(paths: worker.ts/scrapers.cjs等のみ)
  └ release-desktop.yml タグ v* →予約同期くんのビルド/公証/リリース
```

## 3. 開発

```bash
cp .env.example .env.local
#   SALONBOARD_WORKER_TOKEN を Admin 側と完全一致させる
#   KIREIDOT_API_URL は通常 http://localhost:3000

npm install
npx playwright install chromium

npm run type-check                    # worker.ts の型チェック
node --check electron/scrapers.cjs    # scraper の構文チェック
npm run dev                           # 予約同期くん(デスクトップ)の開発起動
```

ワーカーをローカルで回す(サロンボードに触らない疎通確認):

```bash
npm run dry-run    # queuedジョブを即succeededに変えるだけ(UI動線確認用)
npm run once       # 1ジョブだけ処理して終了
```

### トラブルシューティング(ローカル)

| 症状 | 原因と対処 |
|---|---|
| `jobs fetch failed: 401` | `SALONBOARD_WORKER_TOKEN` が Admin と不一致 |
| `jobs fetch failed: 500 worker token not configured` | Admin 側 `.env.local` に token が無い / dev server 再起動忘れ |
| `navigation: ...timeout` | 実サーバー到達不可。まず `DRY_RUN=true` で切り分け |
| 画像認証/CAPTCHAで止まる | ログイン連打しない。冷却待ち or 店舗PCレーンへ(README §4 鉄則参照) |

## 4. デプロイ/運用

| 対象 | 方法 | 注意 |
|---|---|---|
| クラウドワーカー | main へ push → GH Actions が EC2 の docker を更新 | **デプロイ=コンテナ再起動**。頻発させるとコールド再ログイン波→CAPTCHAの引き金になるためまとめる。docs/README等のみの変更はデプロイされない(paths filter) |
| 予備(FB)ワーカー | 別repo `KIREIDOT_Salonboard_Fallback_Worker` に upstream merge → push | 本体修正後の**merge忘れに注意**(自動化はロードマップP3) |
| 予約同期くん | タグ `v*` push → ビルド+Developer ID署名+公証 | 自動更新は署名要件あり(docs/参照) |
| DBマイグレーション | `supabase/migrations/` に追加し Supabase MCP/CLI で適用 | 新テーブルは明示GRANT+`notify pgrst`必須 |

### 運用の鉄則(過去障害からの学び)

1. **throttle/CAPTCHAが出たら止めて待つ**。ログイン試行の追加・大量re-queue・冷却の手動解除はすべて悪化要因
2. **「実行中0+待機N」≠ワーカー停止**。claim→即defer の反復は外から見えない。15分以上・複数アカウント跨ぎの完全無活動で初めて停止を疑う
3. 失敗ジョブの再投入は**原因修正後に**。データ起因(文字数超過等)は再実行しても失敗する
4. 詳細な失敗診断は EC2 の `docker logs sb-worker-cloud` と `~/.kireidot/salonboard-debug/` のcapture

## 5. 関連リポジトリ

| repo | 役割 |
|---|---|
| KireidotAdimn | 管理画面・callback/claim API・予約台帳 |
| Kireidot_SuperAdmin | 同期監視ダッシュボード・一括取込UI |
| KIREIDOT_Salonboard_Fallback_Worker | 予備Cloudワーカー(本repoがupstream) |
