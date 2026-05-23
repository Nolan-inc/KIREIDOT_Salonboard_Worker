# サロンボードワーカー 複数会社対応 要件定義書

作成日: 2026-05-23
対象リポジトリ: `KIREIDOT_Salonboard_Worker`
参照元: `/Users/uedaakira/dev/ios/KireiDot`

## 1. 目的

現在のサロンボード連携は、KIREIDOT Admin 側の Supabase schema と API にはかなり土台がある。一方で、実際のワーカー `worker.ts` はジョブ取得、ログイン試行、callback までの骨組みで、予約・シフト・スタッフ・ブログのスクレイピング本体は未実装である。

また、現行 DB は `salonboard_credentials.shop_id UNIQUE` を中心にした「1店舗につき1認証情報」の設計であり、次の要件を満たすには拡張が必要である。

- 複数会社がそれぞれ自社のサロンボード ID / パスワードを登録できる。
- 会社単位で複数のサロンボードアカウントを管理できる。
- 1つのサロンボードアカウントを複数店舗へ紐付けられる。
- 店舗ごとに異なるサロンボードアカウントも登録できる。
- 登録済み認証情報を使い、予約状況・シフト・スタッフ状況・ブログ状況をすべて取得できる。

この要件定義書では、現行 Supabase DB / Admin API / Electron ワーカーの状態を前提に、追加・変更すべき仕様を定義する。

### 1.1 関連 AI モデル固定条件

サロンボードワーカー自体はスクレイピングと同期が主目的であり、予約・顧客・スタッフ・シフト・ブログの正規化に AI 推論を必須化しない。ただし、KIREIDOT Admin 側または周辺機能で Gemini を利用する場合は、次のモデル名を固定要件とする。

- Gemini テキスト / 推論モデル: `gemini-3.1-pro-preview`
- Gemini 画像生成モデル: `gemini-3-pro-image-preview`

## 2. 参照した現行実装

### 2.1 このワーカーリポジトリ

- `worker.ts`
- `inspect.ts`
- `renderer/src/lib/data.ts`
- `renderer/src/lib/auth-context.tsx`
- `renderer/src/pages/Settings.tsx`

### 2.2 KIREIDOT DB / Admin

- `/Users/uedaakira/dev/ios/KireiDot/supabase/migrations`
- `/Users/uedaakira/dev/ios/KireiDot/KIREIDOT_Admin/supabase/migrations`
- `/Users/uedaakira/dev/ios/KireiDot/KIREIDOT_Admin/src/app/api/salonboard`
- `/Users/uedaakira/dev/ios/KireiDot/KIREIDOT_Admin/docs/11_database_overview.md`
- `/Users/uedaakira/dev/ios/KireiDot/KIREIDOT_Admin/docs/08_salonboard_integration_setup.md`

## 3. 現行 DB 理解

### 3.1 テナント構造

現行 DB の基本単位は `organizations -> shops -> staff / menus / bookings` である。

`organizations`

- 会社テナント。
- `type` は現在 `owner_company` / `fc_company`。
- `parent_id` により本部会社と FC 会社を表現する。
- `org_group_ids(org_id)` により、本部会社なら自身と傘下 FC をまとめて取得できる。

`shops`

- 店舗。
- `organization_id` で会社に属する。
- 現行サロンボード連携の主キーは実質 `shop_id`。

`profiles`

- Supabase Auth の `auth.users.id` と同一 ID。
- 現在は顧客ユーザー中心。
- 管理者・スタッフ権限は `staff` テーブルへ移行済み。

`staff`

- スタッフ・店長・オーナー・管理者の権限ユーザー。
- `profile_id` で `profiles` と紐づく。
- `organization_id`, `shop_id`, `role`, `is_active` を持つ。
- `role` は `staff`, `shop_manager`, `owner`, `super_owner`, `admin` など。
- `shop_account` は RLS 上 `staff` 相当に正規化される。
- `staff_shop_memberships` により副所属店舗も扱える。

### 3.2 認可ヘルパー

現行 RLS / API は次のヘルパーを前提にしている。

- `auth_role()`
- `auth_org_id()`
- `auth_shop_id()`
- `auth_is_global()`
- `auth_shop_ids()`
- `auth_has_shop(shop_id)`
- `org_group_ids(org_id)`

重要な前提:

- `super_owner` / `admin` はグローバル権限。
- `owner` は自社組織の管理者。
- `shop_manager` は主に自店舗管理者。
- 複数店舗所属は導入済みだが、既存 RLS の全テーブルが `auth_shop_ids()` に移行済みではない。

### 3.3 予約テーブル

`bookings` は初期状態から大きく拡張されている。

現行のサロンボード連携で重要な列:

- `shop_id`
- `staff_id`
- `user_id`
- `customer_id`
- `menu_id`
- `scheduled_at`
- `duration_min`
- `status`: `pending`, `confirmed`, `completed`, `cancelled`, `no_show`
- `payment_status`
- `amount`
- `notes`
- `source`: `kireidot`, `salonboard`, `import`
- `external_booking_id`
- `external_synced_at`
- `salonboard_staff_name`
- `reservation_route`
- `payment_method_label`
- `coupon_name`
- `customer_code`: 既存 migration bridge。最新版の取り込みでは `customers.customer_code` を正として扱い、`bookings.customer_id` へ紐付ける。

重要な制約:

- `bookings_external_uniq`: `(shop_id, source, external_booking_id)` where `external_booking_id is not null`
- `bookings_actor_chk`: `user_id` または `customer_id` のどちらか必須

現行 RPC:

- `salonboard_bulk_upsert_bookings(p_shop_id uuid, p_rows jsonb)`
- `customers_resolve_or_upsert(...)`
- `resolve_salonboard_staff_id(p_shop_id, p_sb_name)`
- `backfill_bookings_staff_from_salonboard(p_shop_id)`

予約取り込みの現在仕様:

- サロンボード予約は `bookings.source = 'salonboard'` で保存する。
- 外部予約 ID は `external_booking_id` に保存する。
- 顧客は `customers_resolve_or_upsert` で `customers` に名寄せしてから `bookings.customer_id` に紐付ける。
- スタッフは `salonboard_staff_imports.matched_staff_id` と `salonboard_staff_name` から自動補完される。

### 3.4 顧客テーブル

`customers`

- `shop_id`
- `person_id`
- `full_name`
- `phone_e164`
- `phone_raw`
- `email`
- `birthday`
- `customer_code`
- `external_source`
- `external_customer_id`
- `source`: `walk_in`, `imported`, `imported_salonboard`, `imported_hpb`, `self_signup`
- `merged_into`
- `notes`

現行の名寄せ優先順:

1. `customer_code`
2. `phone_e164`
3. `email`
4. `full_name`

サロンボード取り込みでは `customer_code`, `customer_phone`, `customer_email`, `customer_birthday` を渡すほど精度が上がる。

### 3.5 スタッフ取り込み staging

`salonboard_staff_imports`

- `shop_id`
- `external_id`
- `name`
- `position`
- `designation_fee`
- `catch_phrase`
- `bio`
- `photo_url`
- `is_published`
- `matched_staff_id`
- `last_synced_at`
- `unique (shop_id, external_id)`

現行 RPC:

- `salonboard_bulk_upsert_staff(p_shop_id uuid, p_rows jsonb)`

現行設計:

- サロンボードスタッフは KIREIDOT の `staff` に直接 merge しない。
- staging に保存し、`matched_staff_id` で手動または自動紐付けする。
- `matched_staff_id` 更新時に `bookings.staff_id` へ伝播するトリガーがある。

### 3.6 シフト取り込み staging

`salonboard_shift_imports`

- `shop_id`
- `staff_external_id`
- `staff_name`
- `shift_date`
- `start_time`
- `end_time`
- `is_off`
- `note`
- `matched_staff_id`
- `last_synced_at`
- `unique (shop_id, staff_external_id, shift_date)`

現行 RPC:

- `salonboard_bulk_upsert_shifts(p_shop_id uuid, p_rows jsonb)`

現行設計:

- `salonboard_staff_imports.external_id` と `staff_external_id` が一致すれば `matched_staff_id` が自動コピーされる。
- 既存の `shifts` テーブルへ直接反映するのではなく、まず import staging に保存する。

### 3.7 ブログ取り込み staging

`salonboard_blog_imports`

- `shop_id`
- `external_id`
- `title`
- `body_excerpt`
- `body_html`
- `cover_image_url`
- `category`
- `author_external_id`
- `author_name`
- `posted_at`
- `is_published`
- `view_count`
- `url`
- `last_synced_at`
- `unique (shop_id, external_id)`

現行 RPC:

- `salonboard_bulk_upsert_blogs(p_shop_id uuid, p_rows jsonb)`

現行設計:

- サロンボードブログは `content_posts` に直接 upsert されていない。
- `salonboard_blog_imports` に staging される。
- Electron 側の `Blog` 画面は現在 `content_posts` を読んでおり、この staging とは未接続。

### 3.8 サロンボード認証情報

`salonboard_credentials`

- `id`
- `shop_id uuid not null unique`
- `organization_id`
- `login_id`
- `password_encrypted`
- `password_key_id`
- `base_url`
- `enabled`
- `sync_interval_minutes`
- `last_login_at`
- `last_success_at`
- `last_error`
- `last_error_at`
- `consecutive_failures`
- `blocked_until`
- `created_by`
- `created_at`
- `updated_at`

現行 RPC:

- `salonboard_upsert_credentials(p_shop_id, p_organization_id, p_login_id, p_password, p_base_url, p_created_by)`
- `salonboard_reveal_credentials(p_shop_id)`

暗号化:

- `pgcrypto` の `pgp_sym_encrypt` を使用。
- 鍵は Supabase Vault の `salonboard_encryption_key`。
- 復号は `service_role` の SECURITY DEFINER RPC 経由のみ。

現行制約:

- `shop_id UNIQUE` のため、1店舗に複数アカウントを登録できない。
- `shop_id NOT NULL` のため、会社共通アカウントを `shop_id = null` で表現できない。
- 1つのアカウントを複数店舗へ紐付ける中間テーブルがない。

### 3.9 ジョブキュー

`salonboard_sync_jobs`

- `id`
- `shop_id`
- `organization_id`
- `job_type`
- `status`
- `priority`
- `payload`
- `result`
- `error`
- `attempts`
- `max_attempts`
- `locked_at`
- `locked_by`
- `run_at`
- `started_at`
- `completed_at`
- `created_at`
- `updated_at`

現行 `job_type`:

- `fetch_bookings`
- `fetch_sales`
- `push_booking`
- `cancel_booking`

現行 `status`:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

現行 RPC:

- `salonboard_claim_next_job(p_worker_id, p_limit, p_lease_seconds)`

現行制約:

- ジョブに `salonboard_credential_id` / `salonboard_account_id` がない。
- 同一アカウントの同時実行制御ができない。
- シフト・スタッフ・ブログ用のジョブ種別が DB check constraint にない。
- `retry` は callback body 上の概念で、DB status にはない。リトライ時は `queued` に戻す実装になっている。

### 3.10 同期ログ・売上

`salonboard_sync_logs`

- `shop_id`
- `organization_id`
- `job_id`
- `direction`: `read`, `write`
- `status`: `success`, `failure`, `warning`
- `summary`
- `details`
- `created_at`

`salonboard_sales_snapshots`

- `shop_id`
- `organization_id`
- `target_date`
- `total_sales`
- `deposit_sales`
- `product_sales`
- `consumption_sales`
- `new_customers`
- `repeat_customers`
- `total_customers`
- `get_rate`
- `next_reservation_rate`
- `raw`
- `fetched_at`
- `unique (shop_id, target_date)`

### 3.11 アプリ用 API キーと端末

`salonboard_ingest_keys`

- 店舗ごとの「予約同期くん」アプリ用 API キー。
- 平文キーは `sbk_LIVE_...`。
- DB には sha256 hash のみ保存。
- `organization_id`, `shop_id`, `key_prefix`, `key_hash`, `enabled`, `last_used_at` を持つ。

`salonboard_sync_devices`

- 「予約同期くん」アプリのインストール単位。
- `staff_id`, `organization_id`, `shop_id`, `device_id`, `device_name`, `device_platform`, `app_version`, `last_seen_at`, `last_sync_at`, `last_error` を持つ。

### 3.12 現行 Admin API

ワーカー poll 型:

- `GET /api/salonboard/jobs`
- `POST /api/salonboard/callback`

直接 ingest 型:

- `POST /api/salonboard/ingest`
- `POST /api/salonboard/staff-ingest`
- `POST /api/salonboard/shift-ingest`
- `POST /api/salonboard/blog-ingest`

Electron / Desk 支援:

- `GET /api/salonboard/credentials?shop_id=...`
- `POST /api/salonboard/devices/heartbeat`
- `GET /api/salonboard/organizations`
- `GET /api/salonboard/shops`

認証方式:

- Worker API: `SALONBOARD_WORKER_TOKEN`
- Direct ingest: `sbk_LIVE_...` API key または Supabase JWT
- Credentials API: Supabase JWT

## 4. 現行ワーカーの不足点

`worker.ts`

- `JobType` が `fetch_bookings`, `fetch_sales`, `push_booking`, `cancel_booking` のみ。
- `Job` に `shop_id`, `organization_id`, `credentials` はあるが、認証情報レコード ID がない。
- ログイン処理は最小限で、成功判定が URL と password input の有無に依存している。
- `fetch_bookings` は空配列を返すだけ。
- `fetch_sales` はダミー値を返すだけ。
- `fetch_staff`, `fetch_shifts`, `fetch_blog_posts` は未定義。
- callback は予約・売上しか扱わない現行 Admin API に合わせている。
- セッション再利用、アカウント単位ロック、複数アカウント並列、画面構造変更検知がない。

`inspect.ts`

- 予約・売上ページ調査前提の文言になっている。
- スタッフ・シフト・ブログ画面の DOM 調査フローが明示されていない。
- 複数会社・複数店舗・複数アカウントを選んで調査する仕組みがない。

Electron renderer

- 設定画面のサロンボード連携はプレースホルダ。
- 予約画面は `bookings` を表示する。
- スタッフ画面は `staff` を表示するが、`salonboard_staff_imports` は表示していない。
- シフト画面は `shifts` を表示するが、`salonboard_shift_imports` は表示していない。
- ブログ画面は `content_posts` を表示するが、`salonboard_blog_imports` は表示していない。

## 5. 目標仕様

### 5.1 テナント仕様

- 連携の最上位単位は `organization_id`。
- 取得結果は必ず `organization_id` または `shop_id -> shops.organization_id` で会社境界を判定できること。
- `owner_company` は必要に応じて傘下 `fc_company` の連携状況を見られる。
- `fc_company` は自身の会社・店舗だけを扱う。
- `super_owner` / `admin` は全社横断で設定・調査できる。
- `owner` は自社配下のすべてのサロンボードアカウントを管理できる。
- `shop_manager` は自店舗に紐づくアカウントを管理できる。
- `staff` は同期結果の閲覧のみ。ID / password / 復号済み情報は不可。

### 5.2 認証情報仕様

会社単位・複数店舗・複数アカウントを扱うため、現行 `salonboard_credentials` をそのまま主モデルにするのは不十分である。次のいずれかを実装する。

推奨: 新規 `salonboard_accounts` 方式

- `salonboard_accounts` を新設し、認証情報をアカウント単位で保存する。
- `salonboard_account_shops` を新設し、アカウントと KIREIDOT 店舗の対応を管理する。
- 既存 `salonboard_credentials` は migration で `salonboard_accounts` へ移行し、必要なら互換 view または互換 RPC を残す。

代替: `salonboard_credentials` 拡張方式

- `shop_id UNIQUE` を廃止。
- `account_group_id` または `credential_id` をジョブと import テーブルへ持たせる。
- 複数店舗対応の中間テーブルを追加する。

本要件では、新規 `salonboard_accounts` 方式を推奨する。

## 6. DB 変更要件

### 6.1 新規: `salonboard_accounts`

目的:

- 会社が持つサロンボードログインアカウントを表現する。
- 1会社に複数アカウントを許容する。
- 店舗に直接縛らず、複数店舗へマッピングできる。

必須カラム:

- `id uuid primary key`
- `organization_id uuid not null references organizations(id)`
- `display_name text not null`
- `login_id text not null`
- `password_encrypted bytea not null`
- `password_key_id uuid null`
- `base_url text`
- `enabled boolean not null default true`
- `status text not null default 'active'`
- `sync_interval_minutes integer not null default 12`
- `last_login_at timestamptz`
- `last_success_at timestamptz`
- `last_error text`
- `last_error_code text`
- `last_error_at timestamptz`
- `consecutive_failures integer not null default 0`
- `blocked_until timestamptz`
- `created_by uuid references staff(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

`status` 候補:

- `active`
- `paused`
- `login_failed`
- `captcha_blocked`
- `needs_review`
- `deleted`

制約:

- `organization_id, login_id, base_url` の重複は原則禁止。
- password は必ず Vault secret `salonboard_encryption_key` で暗号化する。
- 平文 password を SELECT できる関数は `service_role` 専用。

### 6.2 新規: `salonboard_account_shops`

目的:

- 1アカウントを複数店舗に紐付ける。
- サロンボード上の店舗名・店舗コードと KIREIDOT `shops.id` を対応付ける。

必須カラム:

- `id uuid primary key`
- `salonboard_account_id uuid not null references salonboard_accounts(id)`
- `organization_id uuid not null references organizations(id)`
- `shop_id uuid not null references shops(id)`
- `external_shop_id text`
- `external_shop_name text`
- `is_primary boolean not null default false`
- `enabled boolean not null default true`
- `last_seen_at timestamptz`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

制約:

- `unique (salonboard_account_id, shop_id)`
- `unique (organization_id, external_shop_id)` は `external_shop_id is not null` の場合のみ検討。
- `shops.organization_id` と `salonboard_account_shops.organization_id` は一致必須。

### 6.3 既存 `salonboard_credentials` からの移行

現行データ:

- `salonboard_credentials.shop_id UNIQUE`
- `organization_id`
- `login_id`
- `password_encrypted`
- `base_url`
- `enabled`
- `sync_interval_minutes`
- `last_*`

移行方針:

1. `salonboard_accounts` を作る。
2. 既存 `salonboard_credentials` 1行ごとに `salonboard_accounts` を作る。
3. 同じ `shop_id` を `salonboard_account_shops` に登録する。
4. `salonboard_sync_jobs` に `salonboard_account_id` を追加して backfill する。
5. `salonboard_reveal_credentials(p_shop_id)` は当面互換関数として残す。
6. 新規実装では `salonboard_reveal_account_credentials(p_account_id)` を使う。

### 6.4 既存 `salonboard_sync_jobs` の拡張

追加カラム:

- `salonboard_account_id uuid references salonboard_accounts(id)`
- `target_shop_id uuid references shops(id)` または既存 `shop_id` を維持
- `target_date_from date`
- `target_date_to date`
- `error_code text`
- `warnings jsonb`

`job_type` に追加:

- `verify_credentials`
- `fetch_all`
- `fetch_bookings`
- `fetch_sales`
- `fetch_staff`
- `fetch_shifts`
- `fetch_blog_posts`
- `push_booking`
- `cancel_booking`

制約:

- `fetch_staff`, `fetch_shifts`, `fetch_blog_posts` を DB check constraint に追加する。
- `shop_id` は単一店舗ジョブでは必須。
- 会社共通アカウントの全店舗同期では `payload.shop_ids` または `salonboard_account_shops` から対象店舗を展開する。
- 同一 `salonboard_account_id` の `running` ジョブは同時に1つまで。

### 6.5 `salonboard_claim_next_job` の拡張

現行:

- queued job を `FOR UPDATE SKIP LOCKED` で取得。
- credential のブロック状態は API 側で shop_id から後判定。

変更後:

- DB 関数または API 側で `salonboard_account_id` 単位の実行中ジョブを除外する。
- `salonboard_accounts.enabled = true` のみ払い出す。
- `blocked_until` が未来のアカウントは払い出さない。
- `max_attempts` 超過ジョブは `failed` に落とす。
- `p_limit` は最大並列数に合わせて 1..N を許容する。

### 6.6 `salonboard_sync_logs` の拡張

追加カラム:

- `salonboard_account_id uuid references salonboard_accounts(id)`
- `job_type text`
- `duration_ms integer`
- `fetched_count integer`
- `inserted_count integer`
- `updated_count integer`
- `skipped_count integer`
- `error_code text`
- `warnings jsonb`

目的:

- 会社・店舗・アカウント・ジョブ種別ごとに同期結果を追跡する。
- 画面構造変更とデータ正規化エラーを区別できる。

### 6.7 `salonboard_sales_snapshots` の拡張

追加カラム:

- `salonboard_account_id uuid references salonboard_accounts(id)`
- `external_shop_id text`

一意制約:

- 現行 `unique (shop_id, target_date)` を維持するか、複数アカウント同一店舗を許す場合は `unique (shop_id, target_date, salonboard_account_id)` へ変更する。

推奨:

- 売上は店舗日次で1値に集約したいため、運用上は `unique (shop_id, target_date)` を維持。
- ただし `raw` に account 情報を残し、競合時は primary account を採用する。

### 6.8 `bookings` の拡張

現行でも予約取り込みは可能。ただし複数アカウント対応では以下を追加する。

追加カラム:

- `salonboard_account_id uuid references salonboard_accounts(id)`
- `external_shop_id text`
- `external_updated_at timestamptz`
- `raw_salonboard_payload jsonb`

一意制約:

- 現行: `unique (shop_id, source, external_booking_id)`
- 推奨: 現行を維持し、同一店舗内で external ID が一意でない実例が出た場合のみ `salonboard_account_id` を含む新制約へ移行する。

理由:

- 予約は最終的に店舗カレンダー上で一意に扱うべき。
- 複数アカウントから同一店舗を同期する場合、二重登録の検知を優先する。

### 6.9 `salonboard_staff_imports` の拡張

追加カラム:

- `organization_id uuid references organizations(id)`
- `salonboard_account_id uuid references salonboard_accounts(id)`
- `external_shop_id text`
- `raw_payload jsonb`

一意制約:

- 現行: `unique (shop_id, external_id)`
- 推奨: 維持。
- ただし同一店舗で複数アカウントが別 external ID を返す可能性がある場合は `unique (shop_id, salonboard_account_id, external_id)` を検討。

### 6.10 `salonboard_shift_imports` の拡張

追加カラム:

- `organization_id uuid references organizations(id)`
- `salonboard_account_id uuid references salonboard_accounts(id)`
- `external_shop_id text`
- `shift_external_id text`
- `raw_payload jsonb`

一意制約:

- 現行: `unique (shop_id, staff_external_id, shift_date)`
- 推奨: 現行を維持し、シフトが1日複数分割勤務を持つ場合に備えて `shift_external_id` または `start_time` を含む一意制約へ移行する。

分割勤務対応案:

- `unique (shop_id, staff_external_id, shift_date, start_time, end_time)`
- `shift_external_id` が取れるなら `unique (shop_id, shift_external_id)`

### 6.11 `salonboard_blog_imports` の拡張

追加カラム:

- `organization_id uuid references organizations(id)`
- `salonboard_account_id uuid references salonboard_accounts(id)`
- `external_shop_id text`
- `status text`
- `raw_payload jsonb`
- `content_post_id uuid references content_posts(id)`

一意制約:

- 現行: `unique (shop_id, external_id)`
- 推奨: 維持。

`content_posts` 反映方針:

- 初期は `salonboard_blog_imports` に staging のまま保存する。
- 管理画面で「KIREIDOT記事として取り込む」操作を実装する場合に `content_posts` へ反映する。
- 自動反映する場合は `content_posts` に `source`, `external_id`, `external_synced_at`, `salonboard_account_id` を追加する。

### 6.12 `salonboard_ingest_keys` の扱い

現行 API キーは `shop_id` 固定である。

要件:

- 既存 API キー方式は後方互換として維持する。
- 新方式では Supabase JWT + `shop_id` 指定を優先する。
- 会社共通アカウントで複数店舗を同期する場合、JWT 方式では同期対象店舗を明示する。
- API キー方式で複数店舗アカウントを扱う場合は、店舗ごとに API キーを発行する。

## 7. API 変更要件

### 7.1 `GET /api/salonboard/jobs`

現行レスポンス:

- `id`
- `shop_id`
- `organization_id`
- `job_type`
- `payload`
- `attempts`
- `max_attempts`
- `credentials`

変更後レスポンス:

```json
{
  "jobs": [
    {
      "id": "job-id",
      "organization_id": "org-id",
      "shop_id": "shop-id",
      "salonboard_account_id": "account-id",
      "job_type": "fetch_bookings",
      "payload": {
        "date_from": "2026-05-23",
        "date_to": "2026-05-30"
      },
      "attempts": 1,
      "max_attempts": 3,
      "credentials": {
        "login_id": "plain-for-worker",
        "password": "plain-for-worker",
        "base_url": "https://salonboard.com"
      },
      "shop_mapping": {
        "external_shop_id": "optional",
        "external_shop_name": "optional"
      }
    }
  ]
}
```

要件:

- 復号は `salonboard_account_id` で行う。
- レスポンスは `Cache-Control: no-store`。
- disabled / blocked account のジョブは払い出さない。
- 同一 account の同時払い出しを防ぐ。
- `limit` は worker concurrency に合わせるが最大値を制限する。

### 7.2 `POST /api/salonboard/callback`

現行:

- `fetch_bookings` と `fetch_sales` のみ反映。

変更後:

- `fetch_bookings` は `salonboard_bulk_upsert_bookings`。
- `fetch_sales` は `salonboard_sales_snapshots`。
- `fetch_staff` は `salonboard_bulk_upsert_staff`。
- `fetch_shifts` は `salonboard_bulk_upsert_shifts`。
- `fetch_blog_posts` は `salonboard_bulk_upsert_blogs`。
- `verify_credentials` は account の `last_login_at`, `status`, `last_error` を更新。
- `fetch_all` は worker 側で分割 callback するか、callback 側で `result` 複数種を受ける。

推奨 payload:

```json
{
  "job_id": "job-id",
  "status": "succeeded",
  "summary": "fetch_staff: inserted=3 updated=2",
  "result": {
    "kind": "staff",
    "items": []
  },
  "metrics": {
    "fetched": 5,
    "inserted": 3,
    "updated": 2,
    "skipped": 0,
    "duration_ms": 12000
  },
  "warnings": [],
  "error": null,
  "error_code": null,
  "block": null
}
```

後方互換:

- 当面は既存 `bookings`, `sales` top-level payload も受け付ける。
- 新 worker は `result.kind` を優先する。

### 7.3 Direct ingest endpoints

既存:

- `/api/salonboard/ingest`
- `/api/salonboard/staff-ingest`
- `/api/salonboard/shift-ingest`
- `/api/salonboard/blog-ingest`

要件:

- 既存 endpoint は維持する。
- JWT 認証時は `shop_id` と `organizationId` の一致だけでなく、将来的には `auth_has_shop(shop_id)` または `assertShopInScope` 相当で複数店舗所属を判定する。
- API key 認証は店舗固定のまま維持する。
- `salonboard_account_id` を body で受ける場合は、その account が同じ `organization_id` かつ `shop_id` に紐づくことを検証する。

### 7.4 Credentials API

既存:

- `GET /api/salonboard/credentials?shop_id=...`

要件:

- 既存 endpoint は互換維持。
- 新規 endpoint を追加する。

候補:

- `GET /api/salonboard/accounts`
- `POST /api/salonboard/accounts`
- `PATCH /api/salonboard/accounts/:id`
- `DELETE /api/salonboard/accounts/:id`
- `POST /api/salonboard/accounts/:id/verify`
- `POST /api/salonboard/accounts/:id/sync`
- `GET /api/salonboard/accounts/:id/credentials?shop_id=...` は必要最小限。平文 password を返す API は極力増やさない。

原則:

- フロントエンドへ password を返すのは、ローカル Electron がサロンボードへ直接ログインする現行設計のための例外。
- サーバー型 worker が主になる場合、Electron へ password を返さない構成に移行する。

## 8. スクレイピング要件

### 8.1 共通ログイン

取得元:

- `job.credentials.login_id`
- `job.credentials.password`
- `job.credentials.base_url`

要件:

- `base_url` 未指定時は `https://salonboard.com` または現行運用 URL を使う。
- ログイン入力 selector は複数候補を持つ。
- ログイン成功判定は URL だけでなく、ログイン後ホーム、予約一覧、ナビゲーション要素の存在で判定する。
- CAPTCHA iframe または reCAPTCHA script を検知する。
- ログイン失敗メッセージを取得し、`error_code = login_failed` として返す。
- `storageState` を `salonboard_account_id` 単位で保存・再利用する。
- password 更新、`captcha_detected`, `login_failed`, セッション期限切れ時は storageState を破棄する。

### 8.2 予約状況

ジョブ:

- `fetch_bookings`

保存先:

- `bookings`
- `customers`
- 必要に応じて `salonboard_sync_logs`

worker 取得項目:

- `external_id`
- `scheduled_at`
- `duration_min`
- `status`
- `customer_name`
- `customer_code`
- `customer_phone`
- `customer_email`
- `customer_birthday`
- `menu_name`
- `amount`
- `staff_name`
- `staff_external_id`
- `reservation_route`
- `payment_method_label`
- `coupon_name`
- `notes`
- `external_shop_id`
- `external_updated_at`
- `raw_payload`

反映:

- `salonboard_bulk_upsert_bookings` に渡す。
- 既存 RPC にない `salonboard_account_id`, `external_shop_id`, `raw_payload` を扱う場合は RPC を拡張する。
- `customer_code`, phone, email を可能な限り渡して `customers_resolve_or_upsert` の精度を上げる。
- `staff_external_id` は現行 RPC では保存されないため、スタッフ自動紐付け精度向上のため RPC 拡張を検討する。

### 8.3 スタッフ状況

ジョブ:

- `fetch_staff`

保存先:

- `salonboard_staff_imports`

worker 取得項目:

- `external_id`
- `name`
- `position`
- `designation_fee`
- `catch_phrase`
- `bio`
- `photo_url`
- `is_published`
- `display_order`
- `external_shop_id`
- `raw_payload`

反映:

- `salonboard_bulk_upsert_staff` に渡す。
- `matched_staff_id` は自動推定または管理画面で手動設定する。
- `matched_staff_id` 更新により予約とシフトへ紐付けが伝播する。

### 8.4 シフト

ジョブ:

- `fetch_shifts`

保存先:

- `salonboard_shift_imports`
- 将来的に `shifts` への反映を検討。

worker 取得項目:

- `staff_external_id`
- `staff_name`
- `shift_date`
- `start_time`
- `end_time`
- `is_off`
- `note`
- `shift_external_id`
- `external_shop_id`
- `raw_payload`

反映:

- `salonboard_bulk_upsert_shifts` に渡す。
- 現行 unique は `(shop_id, staff_external_id, shift_date)` なので、分割勤務を拾う場合は DB 拡張が必要。
- `matched_staff_id` は `salonboard_staff_imports` から自動解決される。

### 8.5 ブログ状況

ジョブ:

- `fetch_blog_posts`

保存先:

- `salonboard_blog_imports`
- 必要に応じて `content_posts`

worker 取得項目:

- `external_id`
- `title`
- `body_excerpt`
- `body_html`
- `cover_image_url`
- `category`
- `author_external_id`
- `author_name`
- `posted_at`
- `is_published`
- `view_count`
- `url`
- `status`
- `external_shop_id`
- `raw_payload`

反映:

- `salonboard_bulk_upsert_blogs` に渡す。
- `body_html` は保存前または表示前にサニタイズする。
- `content_posts` へ自動反映するか staging で止めるかを UI 要件で決める。

## 9. ワーカー設計要件

### 9.1 モジュール分割

現行 `worker.ts` に全実装を追加せず、以下へ分割する。

```text
worker/
  index.ts
  env.ts
  api-client.ts
  runner.ts
  browser.ts
  login.ts
  session-store.ts
  types.ts
  scrapers/
    bookings.ts
    sales.ts
    staff.ts
    shifts.ts
    blog.ts
  normalizers/
    booking.ts
    sale.ts
    staff.ts
    shift.ts
    blog.ts
```

`worker.ts` は互換エントリとして残す。

### 9.2 並列・ロック

要件:

- `WORKER_CONCURRENCY` で同時ジョブ数を制御する。
- 同一 `salonboard_account_id` のジョブは同時実行しない。
- 異なる `salonboard_account_id` は並列実行できる。
- サロンボードアクセスにはジッターを入れる。
- 失敗時は Admin API 側の指数バックオフを尊重する。

### 9.3 エラー分類

必須 `error_code`:

- `login_failed`
- `captcha_detected`
- `credential_disabled`
- `credential_blocked`
- `navigation_timeout`
- `selector_not_found`
- `unexpected_page`
- `session_expired`
- `rate_limited`
- `network_error`
- `callback_failed`
- `normalization_failed`
- `mapping_required`
- `partial_parse_failed`

### 9.4 ログ

出す情報:

- `worker_id`
- `job_id`
- `organization_id`
- `shop_id`
- `salonboard_account_id`
- `job_type`
- `duration_ms`
- 件数
- `error_code`

出さない情報:

- password
- cookie
- storageState の中身
- 顧客電話番号
- 顧客メールアドレス
- 顧客氏名の大量ログ

## 10. UI 要件

### 10.1 Admin / Electron 設定画面

必要機能:

- 会社内サロンボードアカウント一覧
- アカウント追加・更新・削除
- password 再設定
- 接続確認
- アカウントと店舗の紐付け
- 店舗マッピングの自動推定と手動修正
- 同期対象の選択
- 同期間隔の設定
- CAPTCHA / ログイン失敗 / ブロック状態の表示
- 同期ログ表示
- 端末一覧 `salonboard_sync_devices` の表示

### 10.2 予約画面

追加表示:

- `source = salonboard`
- `external_booking_id`
- `external_synced_at`
- `salonboard_staff_name`
- `reservation_route`
- `payment_method_label`
- `coupon_name`
- `customers.customer_code`

### 10.3 スタッフ画面

追加表示:

- `salonboard_staff_imports`
- `matched_staff_id`
- 未紐付けスタッフ
- サロンボード外部 ID
- スタッフ紐付け / 解除操作

### 10.4 シフト画面

追加表示:

- `salonboard_shift_imports`
- KIREIDOT `shifts` との差分
- 未紐付けスタッフのシフト
- 休みフラグ
- サロンボード同期時刻

### 10.5 ブログ画面

追加表示:

- `salonboard_blog_imports`
- KIREIDOT `content_posts` との対応
- サロンボード記事のプレビュー
- `content_posts` へ取り込みボタン
- 公開状態

## 11. セキュリティ要件

- password は平文保存禁止。
- 復号済み password は worker または認可済み Electron API のみに返す。
- 可能なら今後はサーバー worker 方式へ寄せ、Electron に password を返す範囲を縮小する。
- `salonboard_accounts` / `salonboard_account_shops` は RLS を有効化する。
- `staff` ロールには認証情報の閲覧・編集を許可しない。
- `shop_manager` は自店舗紐付けアカウントのみ管理可能。
- `owner` は自社アカウントのみ管理可能。
- `super_owner` / `admin` は監査付きで全社管理可能。
- `audit_logs` に認証情報登録、更新、削除、接続確認、手動同期を記録する。
- ログ・callback result に password / cookie / 個人情報全文を含めない。

## 12. 実装フェーズ

### Phase 1: DB 拡張

- `salonboard_accounts` 作成。
- `salonboard_account_shops` 作成。
- 既存 `salonboard_credentials` から backfill。
- `salonboard_sync_jobs` に `salonboard_account_id` と新 job_type を追加。
- `salonboard_sync_logs` に account / count / error_code を追加。
- import staging 3テーブルに `organization_id`, `salonboard_account_id`, `raw_payload` を追加。

### Phase 2: Admin API 拡張

- `salonboard_reveal_account_credentials(account_id)` RPC 追加。
- `salonboard_claim_next_job` を account lock 対応にする。
- `/api/salonboard/jobs` を account 対応にする。
- `/api/salonboard/callback` を `fetch_staff`, `fetch_shifts`, `fetch_blog_posts` 対応にする。
- Direct ingest endpoints に `salonboard_account_id` 任意受け取りを追加する。

### Phase 3: ワーカー実装

- worker をモジュール分割。
- ログインと session reuse 実装。
- `verify_credentials` 実装。
- `fetch_staff` 実装。
- `fetch_bookings` 実装。
- `fetch_shifts` 実装。
- `fetch_blog_posts` 実装。
- `fetch_sales` は既存要件を維持する場合のみ実装。

### Phase 4: UI 実装

- 設定画面でアカウント管理。
- 店舗マッピング UI。
- 同期ログ UI。
- スタッフ紐付け UI。
- シフト import 表示。
- ブログ import 表示。

### Phase 5: 運用強化

- CAPTCHA ブロック運用。
- selector 変更検知。
- `inspect.ts` を account / shop / job_type 指定可能にする。
- 本番 worker の監視。
- 同期失敗通知。

## 13. 受け入れ条件

### 13.1 会社・アカウント

- 会社 A と会社 B が同じ login_id 形式のサロンボード認証情報を別々に登録できる。
- 会社 A のユーザーは会社 B のアカウントを取得・更新・利用できない。
- 1会社に複数サロンボードアカウントを登録できる。
- 1サロンボードアカウントを複数店舗に紐付けできる。
- 店舗ごとに異なるサロンボードアカウントを選べる。

### 13.2 予約

- 指定期間の予約を取得できる。
- `bookings.source = 'salonboard'` として保存される。
- `external_booking_id` により再同期で重複しない。
- `customers` が作成・名寄せされる。
- `salonboard_staff_name` と `salonboard_staff_imports` から `staff_id` が解決される。

### 13.3 スタッフ

- サロンボードスタッフ一覧を取得し、`salonboard_staff_imports` に保存できる。
- 既存 `staff` と紐付けできる。
- 紐付け後に予約とシフトの担当者解決へ反映される。

### 13.4 シフト

- 指定週または期間のシフトを取得し、`salonboard_shift_imports` に保存できる。
- 休み、出勤、備考を区別できる。
- スタッフ紐付け済み行は `matched_staff_id` が入る。
- 分割勤務がある場合に欠落しない設計になっている。

### 13.5 ブログ

- サロンボードブログ一覧を取得し、`salonboard_blog_imports` に保存できる。
- タイトル、本文抜粋、本文 HTML、画像、投稿者、公開日時、公開状態を保存できる。
- 同じ記事を再同期しても重複しない。
- 必要に応じて `content_posts` へ取り込める。

### 13.6 エラー・運用

- ログイン失敗は `login_failed` として保存される。
- CAPTCHA は `captcha_detected` として account を一時ブロックする。
- selector 不一致は `selector_not_found` として同期ログに残る。
- 同一 account のジョブが同時実行されない。
- worker 異常終了後、lease 切れでジョブが再実行可能になる。

## 14. 未確定事項

- 実際のサロンボード画面で取得できる安定した external ID。
- 1アカウント複数店舗ログイン時の店舗切替 UI / URL / 店舗コード。
- シフトの分割勤務が存在するか。
- ブログ本文 HTML の安全な表示・保存方針。
- `content_posts` へ自動反映するか staging に留めるか。
- Electron へ復号済み password を返し続けるか、サーバー worker に寄せるか。
- `salonboard_credentials` を廃止するか、互換 view として残すか。

## 15. 実装前チェックリスト

- Supabase 本番 schema に上記 migration が全て適用済みか確認する。
- `029_salonboard_integration.sql` と `20260515_001_salonboard_shift_blog_imports.sql` の適用順を確認する。
- `salonboard_bulk_upsert_bookings` の最新版が `customers_resolve_or_upsert` 版であることを確認する。
- 既存 `salonboard_credentials` の件数と `shop_id UNIQUE` 制約を確認する。
- 実サロンボードアカウントで予約・スタッフ・シフト・ブログ各画面の DOM sample を取得する。
- account migration の backfill と rollback 方針を決める。
- ワーカー callback と direct ingest のどちらを主経路にするか決める。
