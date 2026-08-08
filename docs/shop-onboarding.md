# 新店舗オンボーディング手順

SalonBoard 連携を新しい店舗で開始するときの設定手順。**順番に意味がある**(特に §3 の初回一括取込は15分の時間制限がある)。

関連: [operations.md](operations.md)(運用・障害対応) / [salonboard-quirks.md](salonboard-quirks.md)(SB固有仕様)

---

## 0. 全体像 — 何を設定するのか

| # | 設定 | 実体 | 未設定だとどうなるか |
|---|---|---|---|
| 1 | 店舗レコード・ジャンル | `shops.genre` | hair店を誤設定すると**全fetchが0件**になる(URL系統が別) |
| 2 | SBログイン情報 | `salonboard_credentials` | 同期対象にならない |
| 3 | グループ店の紐付け | `group_account_id` + `salonboard_salon_id` | サロン選択に失敗/別店舗の文脈で書込む事故 |
| 4 | 初回一括取込 | ジョブ enqueue(**15分以内**) | こだわり・特集・サロン情報などが**後から取り込めない** |
| 5 | スタッフ紐付け | `salonboard_staff_imports.matched_staff_id` | 予約書込が `STAFF_MAPPING_NOT_FOUND` で手動対応行き |
| 6 | 設備紐付け | `salonboard_equipment_imports.matched_resource_id` | エステ系で予約登録できない(設備必須) |
| 7 | メニュー/クーポン紐付け | `matched_menu_id` | メニューは任意。クーポンは反映対象外になる |
| 8 | シフトパターン | `salonboard_shift_patterns.matched_preset_id` | 時刻が一致しない日が**警告のみで未反映** |
| 9 | 機能別トグル | `sync_features` (jsonb) | 未設定=全部ON(意図せず全機能が動く) |
| 10 | 書込ルーティング | `cloud_push_enabled` | false だと書込が退役PC行きで**永久滞留** |
| 11 | 予約通知メール | `email_ingest_code` + `configure_notice_mail` | 予約の即時取込が効かない(巡回fetch頼み) |
| 12 | PC避難レーン | 予約同期くんへのログイン設定 | CAPTCHA時に書込レーンが消える |

---

## 1. 店舗レコードとジャンル

`shops.genre`(enum: `hair` / `nail` / `esthetic` / `eyelash` / `other`)を**正しく設定する**。

workerは `hair` かどうかの**2値**にしか正規化しません(`worker.ts:2184` ほか)。`nail`/`eyelash`/`other` はすべて esthetic 系のURL(`/KLP/` `/CNK/`)を使います。

- hair店を esthetic のまま登録すると、掲載系fetchが `/CNK/` を見て**全て0件**になります(ADER開発店・郡山で実際に発生)
- 逆に、ヘアグループアカウント配下のサロン(例: ADERグループ配下のGINA)は KD 上の genre が esthetic 系でも実体は `/CLP/bt` 側にあります。workerは両ジャンル経路のフォールバックを持ちますが(`electron/scrapers.cjs:4970`)、最初から正しい方が速い

## 2. SBログイン情報の登録

### 2.1 単独店舗

RPC `salonboard_upsert_credentials` で登録(`login_id` / `password` / `base_url`)。`salonboard_credentials` は **1店舗1行**(UNIQUE制約)。

### 2.2 グループ店(1ログインで複数サロン)

**必ず `salonboard_link_group_salon` 経由で登録する。** 通常の `salonboard_upsert_credentials` は `group_account_id` を設定しないため、これで登録するとグループ店として認識されません。

```
salonboard_group_accounts(アカウント) → salonboard_group_salon_imports(サロン一覧をfetch)
  → salonboard_link_group_salon(import_id, shop_id) で KD の shop と紐付け
     ↳ salonboard_credentials.group_account_id と .salonboard_salon_id (Hコード) を同時に設定
```

これが効く場所は2つあります:

1. **サロン選択**: `salonboard_salon_id`(`H` + 6桁以上の数字)があると、groupTop画面で確実に対象サロンを選べます。未設定だと店名一致にフォールバックするため不安定
2. **claimのアカウントレーン排他**: claim は `coalesce(group_account_id, shop_id)` をレーンキーにします。未設定だと店舗単位のレーンになり、**同一SBログインの別店舗が同時実行されてセッションを奪い合います**(SBは同一アカウント同時1セッションのみ)

紐付けRPCは以下をガードします: 別organizationのshop / 既に他サロンと紐付き済み / 個別credentialsが既存(`p_force=false`のとき)。

### 2.3 有効化フラグ

| カラム | 既定 | 意味 |
|---|---|---|
| `enabled` | true | false だと全ジョブ対象外 |
| `sync_fetch_enabled` / `sync_push_enabled` | true | 取込/反映の大元スイッチ |
| `cloud_fetch_enabled` / `cloud_push_enabled` | true | **false にするとPC(退役)行きになり滞留する** |

`sync_push_enabled` を false→true に切り替えると、未同期シフトのcatchupが自動enqueueされます(トリガ `salonboard_credentials_catchup_shifts_on_push_enable`)。

---

## 3. ⚠️ 初回一括取込は「credentials作成から15分以内」

**この手順を飛ばすと、こだわり・特集・サロン情報・ブログ・フォトギャラリーは後から取り込めません。**

トリガ `trg_000_salonboard_fetch_initial_only` の仕様:

- **常時許可**(いつでもenqueue可): `fetch_bookings` / `fetch_shifts` / `fetch_staff` / `fetch_menu` / `fetch_coupon` / `fetch_equipment` / `fetch_reviews` / `fetch_shift_patterns` / `fetch_style`
- **初回のみ**(上記以外の `fetch_*`。`fetch_salon` / `fetch_kodawari` / `fetch_feature` / `fetch_blog` / `fetch_photo_gallery` など):
  - `salonboard_credentials` の作成から **15分以内**、かつ
  - `payload.reason` が `'super_admin_initial_sync'` または `'initial_import'`
  - どちらか外れると、ジョブは**作られずに黙って捨てられます**(`return null`)

実務上は、credentials を登録したら**すぐに SuperAdmin の一括取込UIを実行**してください。窓を逃した場合は credentials を作り直すか、DB側でトリガを一時的に迂回する必要があります。

---

## 4. エンティティの紐付け(KD実体 ↔ SBコード)

fetch でSB側の一覧が `salonboard_*_imports` に入るので、KD側の実体と紐付けます。

### 4.1 スタッフ(最重要・予約書込の前提)

- テーブル: `salonboard_staff_imports`(`external_id` = SB側コード, `matched_staff_id` → `staff.id`)
- 紐付けると `staff.salonboard_external_id` に伝播します(トリガ `trg_sync_staff_salonboard_external_id_from_import`)
- 予約作成時、`bookings.staff_id` から `salonboard_staff_external_id` が焼き込まれ、ジョブpayloadに注入されます
- **未紐付けだと**: `worker.ts:4381` で `STAFF_MAPPING_NOT_FOUND` + manualRequired=true → 自動リトライされず手動対応行き

コード体系がジャンルで違う点に注意:

| ジャンル | コード | 取得元画面 |
|---|---|---|
| esthetic系 | `W001######` | `/CNK/draft/staffList` |
| hair | `T#########`(stylistId) | `/CNB/draft/stylistList/` |

同じ `external_id` カラムに入りますが別体系です。hairのスタイル/フォト投稿でも T-code が必須で、無いと `STYLIST_REQUIRED` / `STYLIST_NOT_FOUND` になります。

**SB側でスタッフを再作成するとコードが変わり、古いコードは死にます。** 予約書込が「フォーム到達不能」で失敗し続ける場合はこれを疑ってください。

### 4.2 設備(エステ系は必須)

- テーブル: `salonboard_equipment_imports`(`external_id` = `EQ...`, `matched_resource_id`)
- エステ等ベッドのある店舗では**登録フォームで設備指定が必須**。未指定だと登録ボタンが `errorInput` で無効化され、見た目は confirm が出るのに登録されません
- 未紐付け/満床は `EQUIPMENT_FULL` になります
- **hair の SalonBoard には設備設定画面が存在しません**(紐付け不要)

### 4.3 メニュー・クーポン

- メニュー(`salonboard_menu_imports.matched_menu_id`)は**任意**。KD側がメニュー未設定で予約を作れる以上、SB側もメニュー無しで登録します(2026-06-29方針)
- クーポン(`salonboard_coupon_imports.matched_menu_id`)は反映対象にするなら必要
- SB側の文字数制約に注意(メニュー名40字/説明70字/クーポン名36字/内容90字、所要時間は5分単位)。超過は `VALIDATION_ERROR` で決定的に失敗します

### 4.4 シフトパターン

- テーブル: `salonboard_shift_patterns`(`external_id` = SB勤務パターンID, `matched_preset_id` → 会社の `organizations.shift_presets` / `shift_presets_2` の要素id)
- 自動マッチは `salonboard_auto_match_shift_patterns()`(maintenance cron `*/3`)が実行しますが、条件は **`HH:MM` の開始・終了が完全一致**のみ。近似・包含はマッチしません
- **前提**: SalonBoard の「勤務パターン登録」に、KDで使う出勤時間帯と完全一致するパターンが**事前に登録されている**こと
- **自動登録はしません**(2026-08-01方針)。未マッチ時刻は警告ログのみで**サイレントに未反映**になります。理由はSBの勤務パターン上限(30件/店)を自動生成で圧迫した2026-07-29のインシデント
- 短縮名は半角英数2文字以内。SB側で重複していると照合できません

勤務パターンを使わない店舗(hair の「出(全日)」運用)は、KDの営業時間からシフトを取り込む経路があります。

---

## 5. 機能別トグル(`sync_features`)

エンティティごと・方向ごとに同期をON/OFFできます。

- **保存場所**: 会社=`organizations.salonboard_sync_features`、店舗=`salonboard_credentials.sync_features`(どちらもjsonb)
- **未設定はON**。判定は「値が文字列 `'false'` のときだけOFF」で、キーが無い/null/その他の値はすべてON
- **キー名**: `<feature>` と `<feature>_fetch` / `<feature>_push` の**AND**、さらに**会社レベルと店舗レベルのAND**。4つのうち1つでもfalseなら不許可

feature名とジョブ種別の対応:

| feature | 対象job_type |
|---|---|
| `bookings` | push_booking / cancel_booking / fetch_bookings |
| `staff` | fetch_staff / push_staff |
| `shifts` | push_shifts / fetch_shifts / fetch_shift_patterns / push_shift_patterns |
| `menus` | fetch_menu / push_menu |
| `coupons` | fetch_coupon / push_coupon |
| `reviews` | fetch_reviews / push_review_reply |
| `equipment` | fetch_equipment / push_equipment |

上記に無いjob_type(ブログ・フォト・こだわり・特集・受付可能数など)は**ゲート対象外で常に通ります**。

ゲートは2箇所で効きます:

1. **enqueue時**(トリガ `trg_salonboard_sync_jobs_feature_gate`): 不許可ならジョブを作らない
2. **claim時**(フィルタ): 既にキューにある行は対象外になるだけ

**⚠️ 落とし穴**: 既にqueuedの行を後からOFFにすると、cancelされずに**永久「待機」表示**で残ります。滞留と誤認しないでください。

読み取り専用運用の例(ADER系5店): `{"shifts_fetch": true, "shifts_push": false, ...}`

---

## 6. 予約通知メールの取込設定

即時取込(巡回fetchを待たない)を有効にする場合:

1. `salonboard_credentials.email_ingest_code` を発行
2. `configure_notice_mail` ジョブを投げると、workerがSB側の通知メール設定画面に `ingest+<code>@inbound.kireidot.jp` を登録します
3. SBから届く確認メールで `email_verify_url` / `email_verified_at` が埋まる

Edge Function `salonboard-email-ingest` が受信して予約を取り込みます。

---

## 7. 店舗PC(予約同期くん)の設定 — CAPTCHA避難レーン

Cloudが書けない状況(SB画像認証など)の避難先です。**ここが未設定の店舗は、CAPTCHA中に書込レーンがゼロになります。**

実務上必要なのは「予約同期くんが動いているMacのChromeに、その店舗のSBアカウントでログイン済みであること」です。

DB側には店舗別affinityの仕組み(`salonboard_sync_device_shops`)が用意されていますが、**2026-08-08時点で0行**で、device claim経路は使われていません。現在のPCレーンは共通トークンでclaimしており、PC移管の可否は `salonboard_pc_available()`(heartbeatが7分以内 + `enable_push` + アプリ v0.2.234以上)という**店舗を問わない判定**です。

そのため、PC移管が発生しても実際にログインしていない店舗では失敗します。恒久的な解決は「予約同期くんに対象アカウントを追加する」ことです。

PC固有の設定として `chrome_profile_no` / `chrome_debug_port`(RPC `salonboard_set_chrome_profile`)があり、1台で複数アカウントを扱う場合に使います。

---

## 8. オンボーディング後の確認

- [ ] `fetch_staff` を実行し、`salonboard_staff_imports` に行が入るか(0件ならgenre設定かサロン選択を疑う)
- [ ] スタッフを紐付け、`staff.salonboard_external_id` が埋まったか
- [ ] エステ系なら設備を紐付けたか
- [ ] SB側の勤務パターンとKDプリセットの時刻が一致しているか(`matched_preset_id` が埋まるか)
- [ ] テスト予約を1件push して成功するか(**1件だけ**。連投はKPCL017やIPフラグの原因)
- [ ] `cloud_push_enabled=true` か
- [ ] 初回一括取込(15分窓)を実行したか
- [ ] CAPTCHA時の避難先として予約同期くんにログイン設定したか
