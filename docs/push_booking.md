# push_booking (KIREIDOT → SalonBoard 予約書き込み)

KIREIDOT Admin で作成した予約を、店舗 PC の Worker が Playwright で SalonBoard に
登録する機能。MVP は「新規予約登録」のみ。変更・キャンセルは対象外。

## 全体フロー

1. Admin で予約作成 (`createBooking`) → `bookings` 保存
2. `enqueueSalonboardPush` が `salonboard_sync_jobs` に `push_booking` を積み、
   `bookings.salonboard_sync_status = 'pending_push'` にする
3. Worker が `GET /api/salonboard/jobs` をポーリングして claim
   - claim 時に Admin が payload を `bookings` から確定値で組み立て直す
     (`buildPushBookingPayload`)、`salonboard_sync_status = 'pushing'` に更新
4. Worker が SalonBoard にログイン → 新規予約登録画面を操作
5. 確認画面で payload と照合
6. `SALONBOARD_ENABLE_PUSH=true` のときだけ登録ボタンを押す
7. `POST /api/salonboard/callback` で結果を報告
8. Admin が `bookings.salonboard_sync_status` を `synced` / `failed` /
   `manual_required` に更新し、`salonboard_write_attempts` に監査行を残す

## 安全装置 (重要)

| 装置 | 挙動 |
|------|------|
| `SALONBOARD_ENABLE_PUSH` | 有効値は **`1` または `true` (大文字小文字無視) のみ**。未設定・空文字・それ以外の値はすべて無効 = dryRun 相当で、確認画面まで進めて照合するが**登録ボタンは押さない** (`manual_required`)。本番登録は明示有効化が必要。 |
| `DRY_RUN` | SalonBoard に一切アクセスせず、push_booking は `manual_required` で安全に止める (synced にしない)。 |
| 二重登録防止 | 登録前に予約一覧で `KIREIDOT予約ID: {booking_id}` を検索。あれば `already_exists` で synced。enqueue/retry 側も queued/running ジョブ重複と synced 済みを抑止。 |
| 空き枠チェック | 確認画面で「空いていません」等を検出したら `SLOT_NOT_AVAILABLE` (retry 可)。 |
| 確認画面照合 | 顧客名・スタッフ・メニュー・時刻・KIREIDOT予約ID を確認画面テキストと照合。不一致なら `CONFIRMATION_MISMATCH` (manual_required)。 |
| reCAPTCHA | 自動突破しない。`RECAPTCHA_REQUIRED` で停止し credentials を一定時間 block。 |
| リトライ上限 | `job.max_attempts` (既定3)。超過後は `manual_required`。 |

## debug capture (実 DOM 調査用)

予約登録フローで失敗 (要素未検出・確認画面不一致・登録画面に到達できない等) した
ときに、セレクタ調整のための情報を自動保存する。`SALONBOARD_DEBUG_CAPTURE` で
ON/OFF (既定 ON、`0`/`false`/`no` で無効)。

### 保存先・ファイル名ルール
```
~/.kireidot/salonboard-debug/push_booking/{YYYYMMDDThhmmss(JST)}_{job_id先頭8桁}_{label}/
  ├─ meta.json        … URL / page.title() / 表示テキスト抜粋 / 要素一覧 / diagnostics / 失敗ラベル / booking_id
  ├─ elements.json    … input/select/button/a の一覧 (value は除外、select は option ラベル付き)
  ├─ page.html        … HTML スナップショット (秘匿情報をマスク)
  ├─ screenshot.png   … フルページスクリーンショット
  └─ text.txt         … 表示テキスト全文 (秘匿情報をマスク)
```
`label` は失敗箇所を表す: `register_page_not_found` / `staff_select_not_found` /
`menu_not_found` / `datetime_input_not_found` / `confirm_button_not_found` /
`confirmation_mismatch` / `register_button_not_found` / `completion_not_confirmed` /
`confirm_only` (ENABLE_PUSH=false で確認画面まで到達したとき)。

ディレクトリ・ファイルは `0700` / `0600` で作成する。

### 個人情報・パスワード保護
- `input` / `textarea` の **value は一切保存しない** (要素は name / type / placeholder / select の option ラベルのみ)。
- HTML・テキスト中の **ログイン ID とパスワードはマスク** (`***REDACTED***`)。`type=password` の value 属性も除去。
- `meta.json` に顧客名・電話・メール等の payload 個人情報は入れない (ID 系のみ)。
- callback payload にも不要な個人情報は載せない。

調査が済んだら、このディレクトリは手動で削除してよい (機微情報を残さないため、共有時はスクショ/HTML を確認のうえ)。

## セレクタレジストリ (`salonboard-selectors.ts`)

セレクタは `salonboard-selectors.ts` に集約し、`pushBooking()` は必ずそこ経由で
参照する。各セレクタは `state: "confirmed" | "pending"` を持つ。

**確定済み (confirmed)** — 2026-05-30 取得の実 DOM (`salonboard_code/*.html`) より:
- 予約スケジュール `/KLP/schedule/salonSchedule/?date=YYYYMMDD` (新規予約の起点)
  - グリッド `#schedule.jscScheduleMain` (`data-time-interval="5"`)
  - スタッフ列ヘッダ `li.jscScheduleMainHead#STAFF_<externalId>_<YYYYMMDD>` (title=表示名)
  - スタッフ選択 `select#stockNameList` (option value=`STAFF_<id>_<date>`)
  - ドロップ領域 `div.scheduleSetArea.jscScheduleSetArea`
  - 既存予約ブロック `div.scheduleReservation` / 時間帯 `p.jscScheduleTimeZoneSetting` (`["HH:MM","HH:MM"]`)
  - 開始時刻モーダル `a.scheduleTimePeriodLink[data-start-time="HHMM"]` (5分刻み)
  - 新規ドラッグ `#newPlan.jscNewPlan` / 日付ナビ `a.mod_btn_calendar_03/04`
- 予約一覧 `/KLP/reserve/reserveList/init` — 行/詳細リンク `a[href*=extReserveDetail][href*=reserveId=]`
- 予約詳細 `/KLP/reserve/ext/extReserveDetail/?reserveId=YG########`
- スタッフ external_id 形式 `W001######` (= `salonboard_staff_imports.external_id`)

**⚠️ 未確定 (pending) — `REGISTER_FORM`**: 「新規予約登録フォーム」本体。
スケジュールで空き枠をクリック/ドラッグした先の**別画面**で、提供済みキャプチャには
含まれていない (booking.html はスケジュールのみで `<form>`/`<input>` 無し)。
顧客名/電話/スタッフ/メニュー/日時/備考の入力欄、確認・登録ボタンのセレクタは
**この画面の DOM 取得後に `REGISTER_FORM` を埋める**。

それまで `pushBooking()` は:
1. スケジュールを開き、対象スタッフ列を external_id で特定
2. 時間帯重なりの既存予約があれば `ALREADY_EXISTS` で `manual_required` (二重登録防止)
   — ※ ブロックのスタッフ別判定が DOM 未確定のため安全側に倒す
3. 空き枠クリック等で登録フォームを開く操作を試み、**開いた画面を capture**
   (`register_form_opened`) — これが登録フォーム DOM を取得する手段
4. `REGISTER_FORM` が pending の間はフォーム入力を試みず `manual_required` で停止

要素が見つからない場合は推測で危険なクリックをせず、必ず `manual_required` に倒す。

## 予約書き込みテストツール (`test-push-booking.ts`) ← おすすめの動作確認方法

Admin で予約を作らずに、**日付・担当スタッフ・時刻・メニューをコマンドで指定**して
push_booking フローをその場でテストし、**各ステップとエラー原因をすべて表示**する
スタンドアロン CLI。認証情報は `inspect.ts` と同じく Admin API からジョブを 1 件
claim して借り、終了時に再キューへ戻す (借りたジョブは実行しない)。

```
# 既定: ブラウザ表示あり / 確認画面まで (登録ボタンは押さない)
npm run test:push -- --date=2026-06-05 --staff=W001123456 --time=10:00 --menu=カット

# 主な引数
#   --date=YYYY-MM-DD     予約日 (JST, 必須)
#   --staff=W001######    SalonBoard スタッフ external_id (必須)
#   --time=HH:MM          開始時刻 (省略時 10:00)
#   --menu="カット"        SalonBoard 上のメニュー/クーポン名 (省略時 "カット")
#   --duration=60         所要分
#   --staff-name="表示名"  確認画面照合用 (任意)
#   --customer / --phone / --notes  顧客情報・備考 (任意。KIREIDOT予約IDは自動付与)
#   --headless            ブラウザを表示しない
#   --keep-open           実行後ブラウザを開いたままにする (Ctrl+C で終了。DevTools 調査用)

# 実際に SalonBoard へ書き込む (確認画面照合OK時のみ登録ボタンを押す)
npm run test:push:write -- --date=2026-06-05 --staff=W001123456 --time=10:00 --menu=カット
```

このツールが表示するもの:
- 入力内容 / 安全モード (ENABLE_PUSH の ON/OFF)
- STEP1 ログイン (`isLoggedIn` / `tryLogin` の結果)
- STEP2 push_booking 本体の結果 (`status` = ok / confirm_only / failed)
  - failed なら `error_code` / `manual_required` / `reason` と、その意味の和文解説
- ブラウザ側の `console.error/warning` / `pageerror` / `requestfailed` / `dialog`
- この実行で保存された debug capture の一覧と、`meta.json` の
  `diagnostics.open_form` (空き枠クリック/モーダル/別ページ/ポップアップの観測) を要約表示

**安全:** `SALONBOARD_ENABLE_PUSH=true` (= `test:push:write`) を明示しない限り
SalonBoard に予約は作られない。現状 `REGISTER_FORM` セレクタが pending のため、
書き込みテストは「登録フォームを開く → capture → `CONFIRMATION_MISMATCH` で停止」まで
進む。その capture (`register_form_opened`) の DOM で `REGISTER_FORM` を確定すれば、
以降は確認画面照合 (`confirm_only`) まで自動で進む。詳細は下記「B / B-2」を参照。

## 動作確認手順

> ⚠️ **重要 — capture を取りたいときの env**
> `DRY_RUN=1` は **SalonBoard に一切アクセスせず**即 `manual_required` を返すため、
> `register_form_opened` の **capture は取得できません**。
> 登録フォームを capture したい場合は **`DRY_RUN` を外し (false)**、
> **`SALONBOARD_ENABLE_PUSH=false` のまま** 実行してください (= 下の B)。

### A. ドライラン (SalonBoard に触らない / ジョブ配線の確認のみ)
```
# .env.local: WORKER_MODE=central-dev, SALONBOARD_WORKER_TOKEN=... , DRY_RUN=1
npm run worker:once   # = tsx worker.ts --once
```
Admin で予約を1件作成 → ジョブが積まれる → worker が1件処理 →
`bookings.salonboard_sync_status` が `manual_required`、`salonboard_write_attempts`
に `manual_required` 行が入ることを確認。**この経路では capture は出ません。**

### B. 登録フォームを開いて capture する (実ログインするが登録しない) ← 現在のゴール
```
# .env.local: DRY_RUN=false, SALONBOARD_ENABLE_PUSH=false (または未設定)
# device 認証情報 or central-dev トークンを設定
npm run worker:once
```
ログイン → 予約スケジュール → 対象スタッフ列を特定 → 空き枠クリックで登録フォームを
開く操作 → **その画面を capture** (`register_form_opened`) → `REGISTER_FORM` が
pending のため `manual_required` (`CONFIRMATION_MISMATCH`) で停止。
**SalonBoard 側に予約は作られない。**

確認すること:
- `~/.kireidot/salonboard-debug/push_booking/{時刻}_{job8}_register_form_opened/`
  に `meta.json` / `elements.json` / `page.html` / `screenshot.png` / `text.txt`
  が保存される (text.txt = 表示テキスト全文・マスク済、meta.json には抜粋のみ)。
- **クリックで別タブ/ポップアップが開いた場合**は、加えて
  `{時刻}_{job8}_register_form_popup/` が保存される (そのページが登録フォームの可能性大)。
- `meta.json` の `diagnostics.open_form` に **openRegisterForm() のステップ観測**が入る:
  - `setAreaCount` / `setAreaClicked` … 空き枠クリックの可否
  - `timeModalAppeared` / `timeLinkFound` / `timeLinkClicked` … 開始時刻モーダルの挙動
  - `popupOpened` / `popupUrl` … 別タブが開いたか・その URL
  - `urlChanged` / `urlAfter` … 別ページ遷移したか
  - `formIndicatorCount` … フォームらしき要素が出たか
  - `steps[]` … 各操作のログ
  → これを見れば「**空き枠クリックで開くのがモーダルか・別ページか・別タブか**」、
    `scheduleSetArea` クリックが効いたか座標クリック/ドラッグが要るか、を判断できる。

判断後の調整方針:
- **モーダルが同一ページに出る** (`urlChanged=false`, `popupOpened=false`, フォーム要素あり)
  → `REGISTER_FORM` をそのページのセレクタで埋める。
- **別ページ遷移** (`urlChanged=true`) → 遷移先 (`urlAfter`) のフォームに合わせる。
- **別タブ/ポップアップ** (`popupOpened=true`) → `register_form_popup` の DOM に合わせ、
  `pushBooking()` は `popupPage` を対象に入力するよう拡張する。
- **クリックが効かない** (`setAreaClicked=false` やフォーム要素ゼロ)
  → クリック対象 (特定スタッフ行の setArea / 座標クリック / `#newPlan` ドラッグ) を
    `openRegisterForm()` で調整する。
- `REGISTER_FORM` を `confirmed` で埋めると `formSelectorsReady` が true になり、自動で
  フォーム入力→確認画面照合→`confirm_only` (確認画面まで・登録しない) に進む。確認画面も
  `confirm_screen` ラベルで capture される。

その他の capture ラベル: `schedule_grid_not_found` / `staff_column_not_found` /
`overlap_candidate` / `register_form_opened` / `register_form_popup` /
`confirm_screen` / `register_button_not_found` / `completion_not_confirmed`。

### B-2. capture からセレクタ候補を抽出する (inspector)

capture した `page.html` を Chromium で読み込み、`REGISTER_FORM` 各項目の
セレクタ候補を自動抽出するヘルパ。SalonBoard には一切アクセスしない読み取り専用。
```
# capture の page.html を salonboard_code/ にコピーしてから:
node scripts/inspect-register-form.mjs salonboard_code/register_form_opened.html
```
出力:
- 各項目 (customerName/customerPhone/customerEmail/staffSelect/menuSelect/
  date/time/amount/memo/proceedToConfirm/registerButton) のセレクタ候補 (スコア順)
- `⚠️ 候補なし` の項目 = 推測で埋めない (該当が無ければその項目は manual_required 対象)
- 全フォーム要素の生の一覧 (name/id/placeholder/label/option)

この出力を見て `salonboard-selectors.ts` の `REGISTER_FORM` を確定 (state を
`confirmed` に、selector を実値に) する。pending を残した項目があると
`formSelectorsReady=false` のままなので、必須項目 (staff/menu/date/time/
proceedToConfirm) が揃って初めて confirm_only まで進む。

### C. 本番登録 (明示有効化)
```
# .env.local: SALONBOARD_ENABLE_PUSH=true
npm run worker:once
```
確認画面照合 OK のときのみ登録ボタンを押し、完了画面から external_id / detail_url
を取得。`bookings.salonboard_sync_status = 'synced'`、`external_booking_id` /
`salonboard_detail_url` / `salonboard_pushed_at` が入ることを確認。

## Admin 側の状態表示・再試行

- 予約詳細 (`/admin/bookings/{id}`) に「SalonBoard 同期」パネル
  (状態バッジ / 最終エラー / 試行回数 / 詳細URL / 再試行ボタン)。
- 予約一覧の各行に同期状態の小チップ。
- 再試行は `failed` / `manual_required`、上限未満で表示。上限超過時は強制再試行。
  応答なしで `pushing` のまま固まった予約は、アクティブなジョブが無ければ
  `retryPushBooking` 側で救済 (failed に倒して再投入)。
