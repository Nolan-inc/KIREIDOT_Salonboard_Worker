# SalonBoard 書込信頼性 根治設計（2026-07-17 インシデント起点）

## 背景：今日の障害の実挙動

- **トリガー**: 短時間の再デプロイ連打 → 各 `docker restart` が in-flight Chrome を SIGKILL → 全店の SB セッション消滅 → 一斉再ログイン → Akamai がログインIPを **スロットル**（`doLogin` がリダイレクトせず 131字ページで停止）。
- **増幅**: throttle 検知後の焦った手動介入（restart / IP切替 / 手動test）が Akamai のタイマーを毎回リセットし悪化。per-shop cooldown(20–45分) が全予約を巻き込む。
- **回復**: Akamai は「試行を止めて時間経過」でしか回復しない（不定・不透明）。
- **書込ブロック**: cold session の IP で `doComplete「まだ登録されていません」/500`。warm な _abck 信頼が要る。

→ 根本は **「スクレイピング依存 × セッション脆弱 × 人的介入で悪化」** の3層。公式API(①)が取れない前提で、②A/②B/③/④で潰す。

---

## ②A. デプロイでセッションを殺さない（最大トリガー除去・最優先）

**問題**: `docker restart` が Chrome を強制killし、セッション(cookie/_abck)がディスクにflushされない → 新worker が `isLoggedIn=false` → 再ログイン嵐 → throttle。

**設計（2層。まず Layer 1 だけで大半解決）**

### Layer 1: Graceful drain + clean Chrome shutdown（即効・低コスト）
1. worker に SIGTERM ハンドラ:
   - `draining=true` にして**新規claimを停止**
   - in-flight ジョブの完了を最大 `DRAIN_TIMEOUT`(既定90s) 待つ
   - 全 Playwright context を `context.close()` で**正常終了**（→ cookie/_abck を userDataDir に flush）
   - exit 0
2. Docker/compose: `stop_grace_period: 120s`（SIGTERM→SIGKILL の猶予をdrainより長く）。
3. デプロイ手順: `docker restart`(猶予不足) をやめ **`docker stop -t 120` → `docker start`**（or compose up）。
4. 結果: Chrome が正常終了 → プロファイルに有効セッション残存 → 新worker が **isLoggedIn=true で再ログインしない** → throttle が起きない。

**実装ポイント（既存コードへの差分）**
- `worker.ts` メインループに `draining` フラグ + `process.on('SIGTERM', gracefulShutdown)`。
- `gracefulShutdown`: `_inFlight` の Promise を `Promise.allSettled` で待つ（既に drain ログはある＝土台あり）→ 全 `ctx.close()`。
- deploy スクリプト(`scratch_deploy/deploy.sh`)の restart を stop/start に。
- **工数**: 小（1–2人日）。**効果**: 大（今日のトリガーをほぼ消す）。

### Layer 2: Blue-Green（ゼロダウンが要るなら・中コスト）
- 新旧2 worker。新は旧が drain してプロファイルロックを解放するまで claim しない（Chrome は profile 単位で1プロセス）。
- 実運用は Layer 1 の「旧drain→新start」で十分。厳密ゼロダウンが要る時のみ。
- **工数**: 中。**優先度**: 低（Layer 1 が効けば後回し可）。

---

## ②B. 店舗(アカウント)別 高信頼 固定IP（スロットル激減）

**問題**: 現状は `isp.decodo.com:PORT`（ISP静的だが共有レンジ・DC隣接）で、連続ログインで Akamai に弾かれる。切替(rotation)は cold session を生み書込ブロック。

**設計**
1. **IPの格を上げる**: **静的レジデンシャル**または**モバイル(4G/5G)** プロキシを、**SBアカウント単位で1本専用**割当（ログイン共有店はまとめて1本：例 ADERグループ=1本、Unelimit各店=各1本、マグ=1本）。
   - モバイルIP＝最も弾かれにくい（キャリアNAT・高信頼）／コスト高。レジデンシャル＝中庸。
2. **割当をDB化**: `proxy-shop-override.json`(手運用)を廃し、`salonboard_account_proxy(account_key, proxy_url, tier, sticky)` テーブルへ。worker がここを読む。
3. **全トラフィック同一IP**（login/fetch/write）で **_abck を温存**。**絶対に rotate しない**。
4. **warm-up手順**: 新IP割当時、gentle login + 数本の fetch で _abck を育ててから書込を許可。
5. **コスト見積**: distinct SBアカウント数 ≈ **10〜12本**。静的レジデンシャル ≈ 数$/IP/月、モバイル ≈ 十数〜数十$/IP/月（provider次第）。まず主要Unelimit＋ADERに絞れば数本から。
- **工数**: 小〜中（設定＋DB化＋warm-up）。**効果**: 大（そもそも throttle されにくく、切替由来の書込ブロックも消える）。

---

## ②C. ログイン流量ガバナー＋自動フェイルオーバー強化（人を排除）

**設計**
- **グローバル・ログイン・トークンバケット**: 全店合計で「毎 `X` 秒に1ログインまで」。バースト自体を発生させない（デプロイ後の一斉再ログインも自然に間引く）。
- **自動residentialフェイルオーバーの永続化**: 現状の `shopThrottleStreak`/`shopAutoResidentialUntil` はメモリ→restartで消える。**DB/ディスク永続化**し、restartでも退避状態を維持。
- **throttle時は cooldown を"延長のみ"でなく、退避IP切替＋警戒解除まで自動化**。
- **工数**: 中。**効果**: 中（バースト抑止＝根本のトリガー緩和）。

---

## ③ ガードレール（今日の"人的ミス"を仕組みで封じる）← 直接原因対策・即効

**今日の悪化は「人が焦って restart/IP切替を連打できてしまった」こと。システムは自動回復するのに人が壊した。**

1. **デプロイ/restart ゲート**: 実行前チェックが以下なら**拒否**（`--force`＋理由ログでのみ突破）:
   - 予約書込が queued/running（保留）中、または
   - いずれかの店が login-cooldown（throttle）中。
   → `scratch_deploy/deploy.sh` 冒頭に DB チェックを追加。
2. **SLAアラート(cron・毎分)**: 予約が **queued 3分超** で Slack #kireidot-info へ通知（受動でなく能動検知）。DB関数＋pg_cron で実装可（既存の reroute cron と同型）。
3. **Runbook明文化**: 「throttle検知時は**触るな**（restart/IP変更/手動test禁止）。自動回復(cooldown+auto-FO)に任せる」。← 今日の教訓。
4. **Incidentモード自動凍結**: throttle検知中はデプロイ自動凍結。
- **工数**: 小（チェック＋cron＋文書）。**効果**: 大（今回の再発を直接防ぐ）。

---

## ④ worker冗長化・被害局所化（可用性）

**設計**
- **worker 複数台**（別IP/別AZ）。**アカウントを worker に分割割当**（各worker が担当アカウントのプロファイルを保持）。1台不調→担当を別台へ再シード。
- claim RPC は既に multi-worker 対応（`for update skip locked`＋per-shop lane）。要追加＝ **shop→worker 割当** と profile locality。
- **工数**: 中〜大。**優先度**: ②③の後（可用性であって throttle 根治ではない）。

---

## 実装ロードマップ（優先度順）

| # | 施策 | 工数 | 月額コスト | 効果 | 順序 |
|---|---|---|---|---|---|
| 1 | **②A Layer1** graceful drain + stop/start deploy | 小(1–2日) | 0 | ★最大トリガー除去 | まず即 |
| 2 | **③ ガードレール**(deploy gate + SLAアラート + Runbook) | 小 | 0 | ★今日の再発防止 | 並行 |
| 3 | **②B 固定高信頼IP**(アカウント別 residential/mobile) | 小〜中 | 数~数十$×10本 | ★スロットル激減 | 次 |
| 4 | **②C ログインガバナー＋退避永続化** | 中 | 0 | バースト抑止 | 次 |
| 5 | **④ worker冗長化** | 中〜大 | EC2+IP追加 | 被害局所化 | 後 |
| (6) | ②A Layer2 Blue-Green | 中 | 0 | ゼロダウン | 必要なら |

**推奨初手**: 1（drain）+ 2（ガードレール）を最優先で入れる（合計 数人日・追加費用ゼロ）。これだけで「デプロイ→throttle→人が触って悪化」の連鎖はほぼ止まる。続けて 3（固定IP）で throttle 自体を激減。

---

## 各施策の "完了の定義"（検証基準）
- ②A: **デプロイ直後に再ログインが発生しない**ことをログで確認（`isLoggedIn=logged_in` が維持・`login retry` が出ない）。
- ②B: 割当店で**24h throttle 0件**。
- ③: 予約 queued 3分超で**必ずSlack通知**が飛ぶ／throttle中のdeployが**ブロックされる**。
- ④: 1 worker 停止時も担当店の書込が**別台で継続**。
