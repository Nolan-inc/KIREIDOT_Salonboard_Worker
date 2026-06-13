# OpenClaw 統合 実装仕様 (Tier2 フォールバック)

## 0. 目的とスコープ

Playwright(セレクタ依存)が **DOM/セレクタ変更で失敗**したジョブを、**LLM+画像認識で画面を見て操作する OpenClaw** にフォールバックさせ、「セレクタが壊れるたびに手で直す」運用から脱却する。

- **Tier1 = 現行 Playwright**(`electron/scrapers.cjs`):速い・安い・大多数を処理
- **Tier2 = OpenClaw**:セレクタ破損時だけ拾う保険。**各店舗 Mac 上**(住宅IP+本物Chrome=Akamai通過の条件を満たす)
- クラウドには置かない(データセンターIPは遮断される)

実証で痛感した対象: 変更フロー確定ボタン破損、cancel `#fnc_cancel` 破損、`CONFIRMATION_MISMATCH`、各種 `*_not_found`。

---

## 1. アーキテクチャ

```
店舗Mac(住宅IP)
 ├ 予約同期くん (Playwright worker)              = Tier1
 └ OpenClaw Runner (Docker Compose)              = Tier2
     ├ runner-shim (自作Node) ── claim/preflight/prompt/検証/callback を所有
     ├ OpenClaw agent (LLM+vision, browser toolのみ)
     └ 本物Chrome (channel:chrome + シードプロファイル)
```

**設計原則: shim が全ライフサイクルを所有し、OpenClaw に Admin API を触らせない。** AI の自由度は「ブラウザ操作」だけに限定する。

---

## 2. Admin 側の変更(前提・最小差分)

### 2-1. スキーマ(migration 175 案)

```sql
alter table public.salonboard_sync_jobs
  add column if not exists executor text not null default 'playwright'
    check (executor in ('playwright','openclaw')),
  add column if not exists escalation_path text[] not null default '{}',
  add column if not exists excluded_executors text[] not null default '{}';

create index if not exists idx_jobs_executor_claim
  on public.salonboard_sync_jobs (executor, status, run_at)
  where status = 'queued';
```
- 既存ジョブは `executor='playwright'`(後方互換)。OpenClaw ランナーが出来るまで誰も `openclaw` を生成しない=**ジョブが孤児化しない**。

### 2-2. claim フィルタ(`salonboard_claim_next_job_for_device` / `_job`)

claim クエリの WHERE に `and j.executor = $p_executor` を追加。
- Playwright worker は `?executor=playwright`(未指定なら playwright 互換)で claim
- OpenClaw runner は `?executor=openclaw` で claim
- `jobs/route.ts` は `X-Executor` ヘッダ or クエリで分岐(旧worker無指定=playwright)

### 2-3. フォールバック ルーティング(`callback/route.ts` 行151付近)

`retryable_failed` / `non_retryable_failed` の処理に、**エラー分類によるexecutor昇格**を追加:

```ts
// 純粋関数(テスト可能)。フィーチャーフラグ OPENCLAW_ENABLED で全体ガード。
function nextExecutor(errorCode, captureLabel, escalationPath): 'openclaw' | null {
  if (!OPENCLAW_ENABLED) return null;
  if (escalationPath.includes('openclaw')) return null;     // 1回だけ
  const selectorBreak = /_not_found$/.test(captureLabel ?? '')
    || errorCode === 'CONFIRMATION_MISMATCH'
    || /確定ボタン|キャンセルボタン|見つかりません/.test(reason);
  return selectorBreak ? 'openclaw' : null;
}
```
昇格時: `status='queued', executor='openclaw', escalation_path = escalation_path || '{openclaw}', preflight_required=true`(§6.3のフラグ流用)、attemptsリセット。
- CAPTCHA / LOGIN_FAILED / ビジネス系(SLOT/マッピング)は**昇格しない**(マトリクスは設計書§2)。

---

## 3. runner-shim 仕様(自作 Node、店舗Mac上)

ライフサイクル(1ジョブ):
1. **claim**: `GET /api/salonboard/jobs?executor=openclaw`(device token認証は既存と同じ)
2. **冪等性プリフライト**(必須・決定的): `scrapers.cjs` の `findReserveIdForBooking` 相当を**Playwrightで**実行。既存予約があれば登録せず `already_exists` で callback → 終了(AIに重複判定をさせない)
3. **プロンプト組立**: payload + 操作手順 + 安全制約(§4のスケルトン)
4. **agent起動**: OpenClaw に「このブラウザでこのタスクを」投入(browser toolのみ有効)
5. **出力の構造化検証**: `verification` 全true + `external_id` 形式(`YG\d+`)を機械チェック
6. **独立再検証**: 登録成功報告後、shim が **Playwrightで予約一覧を再スキャン**しマーカー実在を確認(AIの自己申告を信用しない)
7. **callback**: 既存の `POST /api/salonboard/callback` 契約そのまま(`external_id`/status/`recovered`等)

shim は OpenClaw に **Admin API キー・認証情報を渡さない**。ログイン済みセッション(シードプロファイル)を使い、PWはプロンプトに入れない。

---

## 4. エージェント プロンプト スケルトン(push_booking)

```
# 役割: SalonBoard の予約を1件「新規登録」することだけがタスク。
# 予約内容(これ以外の値を入力禁止): {booking_id/日時/スタッフ/メニュー/顧客名/電話}
#   備考欄に必ず「KIREIDOT予約ID: {booking_id}」を含める。
# 手順: 登録フォームを開く→入力→(確認画面なし単一ページ a#regist)。
# 登録前の必須照合: 顧客名/スタッフ/メニュー/日時/備考ID の5点をSSで確認しJSON報告。
#   1項目でも不一致なら押さず CONFIRMATION_MISMATCH で停止。
# approval_mode != auto: 確認後に停止しSS+照合を報告して人間承認を待つ(押すな)。
# 絶対禁止: 既存予約の変更/削除、「キャンセル/削除/変更」要素のクリック、
#   CAPTCHA を解く(出たら CAPTCHA_DETECTED で即停止)、値の創作・近いもの選択、
#   登録ボタンの複数回クリック、salonboard.com 外への遷移。
# 出力(shimが機械検証): {result, error_code, external_id:"YG...", verification:{...}, screenshots:[...]}
```

---

## 5. ガードレール(AIが書き込みをやる以上、必須)

1. プリフライト強制(shimが決定的に実施、AIに任せない)
2. `OPENCLAW_ENABLE_PUSH` ゲート(OFFなら確認のみ=approval強制)
3. テナント毎初回 N=10件は `human_approve`(確認画面SSをSlack→承認後に登録)
4. URL allowlist: `salonboard.com` 外への navigation を CDP で遮断
5. 「キャンセル/削除/変更」要素のクリック遮断 + プロンプト禁止
6. 全ステップ SS を保存(監査証跡)
7. 1ジョブ 8分 / 40ステップ上限(超過は `manual_required` 終端)
8. トークン/日次コスト上限超過で OpenClaw 層を自動停止 → Tier1/手動へ
9. concurrency=1(同一アカウント同時セッション防止)
10. PW をプロンプトに入れない(既ログインセッションを使う)

---

## 6. 段階ロールアウト(ジョブを孤児化させない順序)

| Phase | 内容 | ゲート |
|---|---|---|
| **0** | Admin: §2のスキーマ + claimフィルタ。**ルーティングは `OPENCLAW_ENABLED=false`** で無効のまま(executor列だけ入れる=無害) | 既存挙動不変を確認 |
| **1** | OpenClaw runner を **Mac Studio 1台**にDocker構築。**fetch(読み取り)フォールバックのみ** 有効化。Playwright結果とシャドー比較 | fetch一致率 ≥95% × 2週間 |
| **2** | push/cancel フォールバック・**承認モード**(確認画面で停止→Slack承認) | 承認10件連続で照合不一致ゼロ |
| **3** | 実証済みフローを全自動化(テナント単位で `approval_mode='auto'`) | テナント毎初回N件は承認維持 |

---

## 7. 前提・必要なもの

- **LLMキー**: Claude(vision対応モデル)の API キー。OpenClaw の設定で browser tool のみ有効化、file/shell tool は無効化
- **OpenClaw 本体**: Docker Compose(参考: github.com/p0x0q/openclaw-hands-on の Step4=Chromium browser）
- **店舗Mac**: 本物Chrome + シードプロファイル(Playwright側と別個体、§4.2のshop lease で排他)
- **コスト予算**: vision LLM は1ジョブ数十ステップで安くない → **フォールバック限定**(全件ではなく失敗分のみ)が前提。日次上限を設定

---

## 8. オープンクエスチョン

1. モデル選定とコスト実測(vision必須。fetchシャドー比較期間で1ジョブ単価を測る)
2. OpenClaw runner の配置(Mac Studio同居 vs 別ミニPC。PC障害の単一障害点化に注意)
3. 同一SalonBoardアカウント同時セッションの挙動(後勝ち破棄?)→ shop lease TTL に反映
4. SalonBoard利用規約上の OpenClaw 利用の事業判断
5. `cancel_booking` は削除系操作なので OpenClaw 禁止(ガードレール5)のままで良いか

---

## 9. 関連実装

- `electron/scrapers.cjs` `findReserveIdForBooking`(プリフライト/再検証で再利用)、`pushBookingViaForm`(Tier1)
- Admin `src/app/api/salonboard/callback/route.ts` 行151付近(ルーティング差込)、`jobs/route.ts`(executorフィルタ)
- `salonboard_claim_next_job_for_device`(claimにexecutor条件追加)
- 既存の監視(migration 170-174):OpenClaw層の成功率・コストもここに足す
