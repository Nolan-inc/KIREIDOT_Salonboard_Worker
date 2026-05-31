あなたは、KIREIDOTの既存コードベースを理解した上で、安全に実装を進めるシニアエンジニアです。

以下の要件に沿って、現在のSalonBoard連携機能を拡張してください。

# 目的

現在のKIREIDOTでは、SalonBoardから予約・スタッフ・シフト・ブログ等をスクレイピングして取得し、Supabaseへ取り込む機能は実装済みです。

今後は、KIREIDOT Admin側で作成した予約を、店舗PC上のElectron WorkerがSalonBoard画面をPlaywrightで操作し、SalonBoard側にも自動登録できるようにしたいです。

つまり、以下の流れを実現します。

1. KIREIDOT Adminで予約を作成する
2. Supabaseの `bookings` に予約を保存する
3. `salonboard_sync_jobs` に `push_booking` ジョブを作成する
4. Electron Workerがジョブをpollする
5. WorkerがSalonBoardにログインし、予約登録画面を操作する
6. SalonBoard側に予約を登録する
7. 成功/失敗をcallback APIでAdmin側へ返す
8. Admin側で `bookings` のSalonBoard同期状態を更新する

# 重要な前提

* Supabase自体がスクレイピングやブラウザ操作をするのではない。
* Playwright操作は、既存のElectron Worker側で行う。
* Admin Web / API / DB は、ジョブ作成・認証・状態管理・callback受信を担当する。
* KIREIDOT側で予約を作成した瞬間に「SalonBoard登録済み」と扱わない。
* SalonBoard登録成功までは「同期待ち」または「未確定」状態として扱う。
* まずはMVPとして「新規予約登録」のみ実装する。
* 予約変更・キャンセルは今回の実装対象外。ただし将来拡張しやすい設計にする。

# 既存構成

現在のSalonBoard連携は以下の構成です。

## Admin Web

主なファイル：

* `src/app/admin/salonboard/page.tsx`
* `src/app/admin/salonboard/SalonboardClient.tsx`
* `src/app/admin/salonboard/actions.ts`
* `src/app/api/salonboard/jobs/route.ts`
* `src/app/api/salonboard/callback/route.ts`
* `src/app/api/salonboard/ingest/route.ts`
* `src/app/api/salonboard/staff-ingest/route.ts`
* `src/app/api/salonboard/shift-ingest/route.ts`
* `src/app/api/salonboard/blog-ingest/route.ts`
* `src/lib/salonboard/api-auth.ts`

## DB / Supabase

既存テーブル：

* `bookings`
* `salonboard_credentials`
* `salonboard_sync_devices`
* `salonboard_sync_device_shops`
* `salonboard_sync_jobs`
* `salonboard_sync_logs`
* `salonboard_sync_runs`
* `salonboard_sync_run_shops`
* `salonboard_staff_imports`
* `salonboard_shift_imports`
* `salonboard_blog_imports`
* `salonboard_sales_snapshots`

既存のジョブ種別には、以下がある想定です。

* `fetch_bookings`
* `fetch_sales`
* `push_booking`
* `cancel_booking`

今回は `push_booking` を実際に動作するように整備してください。

## Worker

リポジトリ：

`/Users/uedaakira/dev/ios/KireiDot/KIREIDOT_Salonboard_Worker`

技術スタック：

* Electron
* React / Vite
* Playwright / Chromium

既に以下のような構成がある想定です。

* Workerが `/api/salonboard/jobs` をpoll
* SalonBoardにログイン
* 取得結果をingest APIへ送信
* callback APIで成功/失敗を報告

# 実装方針

## 1. 予約作成時の状態管理を追加する

KIREIDOT Admin側で予約を作成した際、SalonBoard登録が必要な予約については、`bookings` に以下のような状態で保存してください。

例：

* `source = 'kireidot'`
* `salonboard_sync_status = 'pending_push'`
* `salonboard_push_attempts = 0`
* `salonboard_last_push_error = null`
* `salonboard_pushed_at = null`

既存の `bookings.status` と、SalonBoard同期状態は分けて管理してください。

予約そのものの状態例：

* `reserved`
* `cancelled`
* `completed`
* `no_show`

SalonBoard同期状態例：

* `not_required`
* `pending_push`
* `pushing`
* `synced`
* `failed`
* `manual_required`
* `pending_cancel`
* `cancelled_synced`

今回最低限必要なのは以下です。

* `pending_push`
* `pushing`
* `synced`
* `failed`
* `manual_required`

## 2. DBマイグレーションを追加する

`bookings` に、SalonBoard書き込み管理用のカラムを追加してください。

追加候補：

```sql
alter table public.bookings
  add column if not exists salonboard_sync_status text,
  add column if not exists salonboard_push_attempts integer not null default 0,
  add column if not exists salonboard_last_push_error text,
  add column if not exists salonboard_pushed_at timestamptz,
  add column if not exists salonboard_detail_url text,
  add column if not exists salonboard_external_status text;
```

必要であれば制約やindexも追加してください。

例：

```sql
create index if not exists idx_bookings_salonboard_sync_status
  on public.bookings (salonboard_sync_status);

create index if not exists idx_bookings_shop_salonboard_sync_status
  on public.bookings (shop_id, salonboard_sync_status);
```

また、書き込み操作の監査ログ用に新規テーブルを追加してください。

```sql
create table if not exists public.salonboard_write_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  shop_id uuid not null,
  booking_id uuid,
  job_id uuid,
  device_id uuid,
  operation_type text not null,
  status text not null,
  request_payload jsonb,
  result_payload jsonb,
  error_message text,
  started_at timestamptz default now(),
  finished_at timestamptz,
  created_at timestamptz default now()
);
```

operation_type の想定：

* `push_booking`
* `cancel_booking`
* `update_booking`

今回使うのは `push_booking` のみです。

status の想定：

* `running`
* `succeeded`
* `failed`
* `manual_required`

RLSや権限は、既存の `salonboard_*` テーブル設計に合わせて追加してください。

## 3. 予約作成時に `push_booking` ジョブを作る

KIREIDOT Admin側で予約を作成する処理を探し、SalonBoard同期対象の予約であれば、予約作成と同じトランザクション、または可能な限り近いタイミングで `salonboard_sync_jobs` にジョブを作成してください。

ジョブ例：

```json
{
  "job_type": "push_booking",
  "status": "queued",
  "shop_id": "...",
  "payload": {
    "booking_id": "...",
    "customer_name": "...",
    "customer_phone": "...",
    "customer_email": "...",
    "staff_id": "...",
    "salonboard_staff_external_id": "...",
    "staff_name": "...",
    "menu_id": "...",
    "menu_name": "...",
    "coupon_name": "...",
    "scheduled_at": "2026-06-01T10:00:00+09:00",
    "duration_min": 90,
    "amount": 12000,
    "notes": "KIREIDOT予約ID: ..."
  }
}
```

重要：

* `booking_id` は必ずpayloadに入れる。
* SalonBoard側の備考欄に入れるため、`KIREIDOT予約ID: {booking_id}` を生成できるようにする。
* 二重登録防止のため、同一 `booking_id` の未完了 `push_booking` ジョブが重複作成されないようにする。
* 既に `salonboard_sync_status = 'synced'` の予約には再作成しない。
* 再試行時は明示操作でのみジョブを作る。

## 4. `/api/salonboard/jobs` を `push_booking` 対応にする

既存の `GET /api/salonboard/jobs` が `fetch_bookings` 等を返している場合、`push_booking` も返せるようにしてください。

返却payloadには以下を含めてください。

* job_id
* job_type
* shop_id
* organization_id
* credentials

  * login_id
  * password
  * base_url
* payload

  * booking_id
  * customer情報
  * staff情報
  * menu情報
  * scheduled_at
  * duration_min
  * amount
  * notes

注意：

* credentialsは既存の `salonboard_reveal_credentials` の仕組みを使う。
* `Cache-Control: no-store` を維持する。
* Workerのdeviceスコープ外のshopのジョブを返さない。
* job claim時に `status = 'running'` にする。
* 可能であれば `bookings.salonboard_sync_status = 'pushing'` に更新する。

## 5. `/api/salonboard/callback` を `push_booking` 成功/失敗に対応させる

Workerから `push_booking` のcallbackが来た場合、以下を処理してください。

成功時：

```json
{
  "job_id": "...",
  "job_type": "push_booking",
  "status": "succeeded",
  "booking_id": "...",
  "external_booking_id": "...",
  "salonboard_detail_url": "...",
  "result_payload": {
    "confirmed_customer_name": "...",
    "confirmed_staff_name": "...",
    "confirmed_menu_name": "...",
    "confirmed_scheduled_at": "..."
  }
}
```

成功時のDB更新：

* `salonboard_sync_jobs.status = 'succeeded'`
* `bookings.salonboard_sync_status = 'synced'`
* `bookings.external_booking_id = external_booking_id`
* `bookings.salonboard_detail_url = salonboard_detail_url`
* `bookings.salonboard_pushed_at = now()`
* `bookings.salonboard_last_push_error = null`
* `salonboard_write_attempts.status = 'succeeded'`
* 必要に応じて `salonboard_sync_logs` に記録

失敗時：

```json
{
  "job_id": "...",
  "job_type": "push_booking",
  "status": "failed",
  "booking_id": "...",
  "error_code": "SLOT_NOT_AVAILABLE",
  "error_message": "SalonBoard側で対象時間が空いていません",
  "manual_required": false
}
```

失敗時のDB更新：

* `salonboard_sync_jobs.status = 'failed'`
* `bookings.salonboard_sync_status = 'failed'` または `manual_required`
* `bookings.salonboard_push_attempts = salonboard_push_attempts + 1`
* `bookings.salonboard_last_push_error = error_message`
* `salonboard_write_attempts.status = 'failed'` または `manual_required`
* 必要に応じて `salonboard_sync_logs` に記録

manual_required にすべきケース：

* reCAPTCHAが表示された
* ログインできない
* SalonBoard画面構造が変わって操作できない
* 対象スタッフが見つからない
* 対象メニューが見つからない
* 確認画面の内容がpayloadと一致しない
* 予約登録成功/失敗が判定不能

## 6. Worker側に `push_booking` 実行処理を追加する

Electron Worker側で、job_type が `push_booking` の場合に以下を実行してください。

処理フロー：

1. credentialsを使ってSalonBoardへログイン
2. ログイン成功を確認
3. 予約管理画面へ移動
4. 新規予約登録画面へ移動
5. 登録前に対象日時・スタッフの空き状況を確認
6. 顧客情報を入力、または既存顧客を検索
7. スタッフを選択
8. メニューまたはクーポンを選択
9. 日時・所要時間・金額・備考を入力
10. 備考欄に `KIREIDOT予約ID: {booking_id}` を入れる
11. 確認画面に進む
12. 確認画面の内容とpayloadを照合する
13. 一致すれば登録ボタンを押す
14. 完了画面からSalonBoard側の予約ID、詳細URLなどを取得
15. 可能であれば予約一覧を再取得して、登録されたことを確認
16. callback APIへ成功/失敗を送信する

## 7. Worker側の安全装置

以下は必ず入れてください。

### 二重登録防止

登録前にSalonBoard側で以下を確認してください。

* 備考欄または予約一覧に同じ `KIREIDOT予約ID` が存在しないか
* 同じ顧客名 / 電話番号 / 日時 / スタッフ の予約が既に存在しないか

既に存在する場合：

* 新規登録は行わない
* 可能であれば既存予約の `external_booking_id` / detail_url を取得
* callbackは `succeeded` または `already_exists` 相当で返す
* KIREIDOT側を `synced` にできるようにする

### 登録前の空き枠チェック

SalonBoard側で対象日時が埋まっている場合は、登録しない。

エラー例：

```json
{
  "error_code": "SLOT_NOT_AVAILABLE",
  "error_message": "SalonBoard側で対象時間が空いていません"
}
```

### 確認画面チェック

登録ボタンを押す前に、確認画面の内容をpayloadと比較してください。

チェック項目：

* 顧客名
* 予約日時
* スタッフ
* メニュー / クーポン
* 金額
* 所要時間
* 備考内のKIREIDOT予約ID

一致しない場合は登録せず、`manual_required` としてcallbackしてください。

### reCAPTCHA対応

reCAPTCHAが表示された場合、自動突破しないでください。

* 操作を停止する
* `manual_required` としてcallback
* error_code は `RECAPTCHA_REQUIRED` とする

### リトライ上限

同一予約に対する自動リトライは上限を設けてください。

例：

* 最大3回
* それ以上は `manual_required`

## 8. メニューマッピングを実装、または最低限の仮対応を入れる

予約登録にはKIREIDOT側メニューとSalonBoard側メニューの対応が必要です。

現在、メニュー自動マッピングは未実装のため、以下のどちらかを実装してください。

### 推奨：マッピングテーブル追加

例：

```sql
create table if not exists public.salonboard_menu_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shop_id uuid not null,
  menu_id uuid,
  salonboard_menu_name text,
  salonboard_coupon_name text,
  duration_min integer,
  amount integer,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

このテーブルで以下を管理します。

* KIREIDOT menu_id
* SalonBoard側のメニュー名
* SalonBoard側のクーポン名
* 所要時間
* 金額

Admin画面での編集UIはMVPでは簡易でよいです。

### 仮対応

すぐにマッピングUIまで作れない場合は、既存 `bookings.menu_name` と `coupon_name` を使い、SalonBoard上で完全一致検索してください。

ただし、見つからない場合は登録せず `manual_required` にしてください。

## 9. スタッフマッピングを既存機能と接続する

既存の `salonboard_staff_imports.matched_staff_id` を使い、KIREIDOTの `staff_id` からSalonBoard側のスタッフ名またはexternal_idを取得してください。

スタッフが見つからない場合は、予約登録しないでください。

エラー例：

```json
{
  "error_code": "STAFF_MAPPING_NOT_FOUND",
  "error_message": "KIREIDOTスタッフに対応するSalonBoardスタッフが見つかりません"
}
```

## 10. Admin UIに最低限の状態表示を追加する

予約一覧またはSalonBoard連携画面に、以下が分かる表示を追加してください。

* SalonBoard同期状態

  * 同期待ち
  * 同期中
  * 同期済み
  * 失敗
  * 手動対応必要
* 最終エラー
* 再試行ボタン
* SalonBoard詳細URLがある場合はリンク
* push_attempts

再試行ボタンは以下の条件で表示してください。

* `salonboard_sync_status = 'failed'`
* または `manual_required`
* かつ `salonboard_push_attempts` が上限未満、または管理者が明示的に再試行する場合

再試行時は、同じ `booking_id` に対して新しい `push_booking` ジョブを作成してください。ただし、同一予約のqueued/runningジョブが既にある場合は作成しないでください。

## 11. API設計・型定義を整理する

可能であれば、以下の型を共通化してください。

* `PushBookingJobPayload`
* `PushBookingCallbackPayload`
* `SalonboardSyncStatus`
* `SalonboardJobType`
* `SalonboardErrorCode`

エラーコード例：

* `LOGIN_FAILED`
* `RECAPTCHA_REQUIRED`
* `SLOT_NOT_AVAILABLE`
* `STAFF_MAPPING_NOT_FOUND`
* `MENU_MAPPING_NOT_FOUND`
* `CONFIRMATION_MISMATCH`
* `ALREADY_EXISTS`
* `UNKNOWN_ERROR`

## 12. 実装対象外

今回やらないこと：

* 予約変更
* 予約キャンセル
* 顧客マスタの完全同期
* メニュー自動学習
* reCAPTCHAの自動突破
* SalonBoard画面変更に対する完全自動修復
* Staff iOS側のSalonBoard専用機能

ただし、将来追加しやすいように、`operation_type` や `job_type` は拡張可能にしてください。

# 受け入れ条件

以下を満たしてください。

1. Admin側で予約を作成すると、`bookings` に保存される
2. SalonBoard同期対象の場合、`salonboard_sync_jobs` に `push_booking` ジョブが作成される
3. Workerが `push_booking` ジョブを取得できる
4. WorkerがSalonBoardにログインし、新規予約登録処理を実行できる
5. 登録前に空き枠・重複・スタッフ・メニューを確認する
6. 登録前の確認画面でpayloadと表示内容を照合する
7. 成功時にcallbackで `bookings` が `synced` になる
8. 成功時に `external_booking_id` または `salonboard_detail_url` が保存される
9. 失敗時に `failed` または `manual_required` になり、エラー内容が保存される
10. 同一予約が二重登録されない
11. reCAPTCHAが出た場合は自動突破せず `manual_required` になる
12. Admin画面で同期状態・エラー・再試行が確認できる
13. 既存のSalonBoard取得機能を壊さない
14. 既存のDevice認証 / shop scope / credentials復号の仕組みを維持する

# 実装前に必ずやること

まず既存コードを調査してください。

特に以下を確認してください。

* `salonboard_sync_jobs` のschema
* `job_type` のenum/check制約の有無
* `/api/salonboard/jobs` のclaim処理
* `/api/salonboard/callback` の更新処理
* Admin側の予約作成処理の場所
* Worker側のjob dispatcher
* Worker側のSalonBoardログイン処理
* Worker側の既存Playwright scraper構造
* `salonboard_staff_imports` と `staff` の紐づけ方法
* `bookings` の現在のカラム構成
* RLS / RPC / SECURITY DEFINER の既存方針

既存実装と矛盾しないように、必要最小限の差分で実装してください。

# 実装時の注意

* 本番SalonBoardに対していきなり登録ボタンを押す実装にしないでください。
* まずは `dryRun` または確認画面までで止められるモードを用意してください。
* 本番登録処理は明示的に有効化された場合のみ実行してください。
* ログにSalonBoardの平文パスワードを出さないでください。
* credentialsや個人情報をconsole.logしないでください。
* callback payloadにも不要な個人情報を含めすぎないでください。
* 失敗時に予約データを削除しないでください。
* エラーはAdminが判断できる粒度で保存してください。
* 画面構造が不明な場合は、推測で危険なクリックをせず、manual_requiredにしてください。

# 最終的に作ってほしいもの

1. DB migration
2. booking作成時の `push_booking` job作成処理
3. `/api/salonboard/jobs` の `push_booking` 対応
4. `/api/salonboard/callback` の `push_booking` 成功/失敗対応
5. Worker側の `push_booking` dispatcher
6. Worker側のSalonBoard予約登録Playwright処理
7. 重複チェック・空き枠チェック・確認画面チェック
8. Admin UIでの同期状態表示
9. 再試行処理
10. 必要な型定義
11. テストまたは動作確認手順

まずは既存コードを読んで、実装計画を短くまとめてから修正を開始してください。
