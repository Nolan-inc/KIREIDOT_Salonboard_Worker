# エステ (esthetic) — SalonBoard 実DOM

エステ系（nail/eyelash も現状はここに準ずる）の画面HTML。URLは主に `/KLP/...` と `/CNK/...`。

## ★ ログイン後の入口 (このジャンルの場合)
- **1店舗(単一)**: `https://salonboard.com/KLP/top/` (サロン選択不要)
- **複数店舗(グループ)**: `https://salonboard.com/KLP/groupTop/` (サロンを選択してから各機能へ)
  - ⚠️ 美容室のグループは `/CNC/groupTop/` だが、**エステは `/KLP/groupTop/`** で prefix が違う。
  - groupTop の DOM は美容室と共通（`#biyouStoreInfoArea` / `#kireiStoreInfoArea` の `<a id="H...">`）。
    DOM参照は `美容室/グループ店舗選択_groupTop.html`。
  - 実装の groupTop 判定は `/(CNC|KLP)/groupTop/` の両方を見る必要がある（詳細は親 README）。
- エステ複数店舗の `/KLP/groupTop/` の実HTMLは未取得（⬜）。取得できると確実。

## ファイル一覧

| ファイル | 画面 | URL |
|---|---|---|
| `予約一覧_reserveList.html` | 予約一覧 | `https://salonboard.com/KLP/reserve/reserveList/init` |
| `予約スケジュール_salonSchedule.html` | 予約スケジュール | `https://salonboard.com/KLP/schedule/salonSchedule/` |
| `予約登録_extReserveRegist.html` | 新規予約登録フォーム | `https://salonboard.com/KLP/reserve/ext/extReserveRegist/?staffId=...&date=YYYYMMDD&rsvHour=HH&rsvMinute=MM` |
| `スタッフ_staffList.html` | スタッフ掲載情報一覧 | `https://salonboard.com/CNK/draft/staffList` |
| `メニュー_menuEdit.html` | メニュー編集 | `https://salonboard.com/CNK/draft/menuEdit` |
| `クーポン_couponList.html` | クーポン一覧 | `https://salonboard.com/CNK/draft/couponList` |
| `ブログ_blog.html` | ブログ投稿フォーム | `https://salonboard.com/KLP/blog/blog/`（一覧は `/KLP/blog/blogList/`） |
| `フォトギャラリー_photoGalleryEdit.html` | フォトギャラリー編集（一括） | `https://salonboard.com/CNK/draft/photoGalleryEdit`（POST: `/doRegister`） |
| `口コミ_reviewList.html` | 口コミ一覧 | `https://salonboard.com/KLP/review/reviewList/`（ページング `?pn=N`） |
| `口コミ返信入力_reviewReply.html` | 口コミ返信フォーム | `https://salonboard.com/KLP/review/reviewReply/?reviewId=R...`（input#replyFrom + textarea + a#replyConfirm） |
| `_調査用_salonboard_test.html` | （調査用テンポラリ） | — |

## 状況
- 取得・登録（予約/スタッフ/メニュー/クーポン/ブログ）は実装済みで本番稼働中。
- フォトギャラリー(photoGalleryEdit) は **空き枠に画像+タイトル+キャプション+ジャンル+掲載を入れて一括登録** する方式。
  自動投稿は `postPhotoGalleryViaForm`（scrapers.cjs, job_type `push_photo_gallery`）。詳細は同HTML冒頭コメント参照。
- 口コミ(reviewList) は `scrapeReviews`(scrapers.cjs) で取得し `salonboard_review_imports` に保存。
  channel=`reviews`(1日1回自動取得)。AI返信案は Admin `/api/salonboard/review-reply` / cron `/api/cron/review-reply`(OpenAI、店舗・スタイリスト情報込み) で生成し `ai_reply_draft` に保存。
- **口コミ返信投稿(reviewReply)**: Admin `/admin/reviews` でAI返信案を編集→「この返信案を使用する」で
  `push_review_reply` ジョブを enqueue → Worker `postReviewReplyViaForm`(scrapers.cjs) が返信フォームに
  replyFrom(担当スタッフ名)+本文を入力し確認→登録。ENABLE_PUSH準拠(false=確認画面まで)。
  結果は callback で `salonboard_review_imports.reply_post_status`(posted/failed/manual_required) に反映。
