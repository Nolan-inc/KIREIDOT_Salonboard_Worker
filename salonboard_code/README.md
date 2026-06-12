# salonboard_code — SalonBoard 実DOMリファレンス

スクレイピング実装の根拠にする「SalonBoard の各画面の実HTML」を、**ジャンル別**に保管する場所です。
コードはこのフォルダのHTMLを実行時に読みません（あくまで開発時の参照・セレクタ確定用）。

## ★ ログイン後の入口URL (ジャンル × 単一/複数店舗) — 最重要

ログイン直後に着地するページは **ジャンルと店舗数で異なる**。ここを取り違えると
「ログインできるのに店が開けない」(サロン未選択)になる。

| | 1店舗 (単一) | 複数店舗 (グループ) |
|---|---|---|
| **美容室 (hair)** | `https://salonboard.com/CNC/top/` | `https://salonboard.com/CNC/groupTop/` |
| **エステ等 (esthetic/nail/eyelash)** | `https://salonboard.com/KLP/top/` | `https://salonboard.com/KLP/groupTop/` |

- **複数店舗(グループ)** は groupTop でサロン(ID=`H...`)を選択してから各機能URLへ。
  - 美容室は **`/CNC/groupTop/`**、エステ等は **`/KLP/groupTop/`** (← prefix が違う! `CNC` ≠ `KLP`)。
  - groupTop の DOM は共通: `<table id="biyouStoreInfoArea">`(ヘア) / `<table id="kireiStoreInfoArea">`(キレイ=エステ/まつげ)。
    各行 `<a href="javascript:void(0);" id="H...">サロン名</a>` をクリックして店舗文脈に入る。
  - 1アカウントがヘア店舗とキレイ店舗の両方を持つことがある。
  - サロン選択: `credentials.salonboard_salon_id`(H...) があればそのIDで確実選択。無ければ店舗名一致 or 単一なら自動。
  - DOM参照: `美容室/グループ店舗選択_groupTop.html`。
- **単一店舗** は groupTop に着地しない (`/CNC/top/` or `/KLP/top/`)。サロン選択は不要。
- 実装: worker `ensureStoreSelected` / scrapers `ensureSalonSelected` は **URLを `/(CNC|KLP)/groupTop/` の両方**で判定する。

## 重要: ジャンルでURL/DOMが大きく異なる

| | エステ等 (esthetic/nail/eyelash) | 美容室 (hair) |
|---|---|---|
| ログイン後TOP(単一) | `/KLP/top/` | `/CNC/top/` |
| グループ選択(複数) | `/KLP/groupTop/` | `/CNC/groupTop/` |
| 予約一覧 | `/KLP/reserve/reserveList/init` | `/CLS/hair/reservations/init/` |
| 予約スケジュール | `/KLP/schedule/salonSchedule/` | `/CLP/bt/schedule/salonSchedule/` |
| スタッフ/スタイリスト | `/CNK/draft/staffList` | `/CNB/draft/stylistList/` |
| メニュー/スタイル | `/CNK/draft/menuEdit` | `/CNB/draft/styleList/` |
| クーポン | `/CNK/draft/couponList` | （要確認） |
| ブログ | `/KLP/blog/blogList/` | （要確認 / KLP共通か別系統か） |
| フォトギャラリー/スタイル投稿 | `/CNK/draft/photoGalleryEdit` | `/CNB/draft/styleEdit/` |
| 口コミ一覧 | `/KLP/review/reviewList/` | `/CLP/bt/review/reviewList/` |
| 口コミ返信入力 | `/KLP/review/reviewReply/?reviewId=R...` | `/CLP/bt/review/reviewReply/R...` |

→ Worker は `shops.genre` で取得方法を分岐する（[[salonboard-genre-scraping]] / 実装は `electron/scrapers.cjs`）。

## ファイル命名規則

`機能名_SBパス末尾.html`（例: `予約一覧_reserveList.html`）。
HTMLを追加したら、対応するジャンルの README の表を更新してください。

## 収集状況 (✅=あり / ⬜=要取得) と スクレイパー対応状況

### エステ (esthetic) — `エステサロン/`
| 画面 | URL | HTML | スクレイパー |
|---|---|---|---|
| ログイン後TOP(単一) | `/KLP/top/` | ⬜ 要取得(任意) | — |
| グループ選択(複数) | `/KLP/groupTop/` | ⬜ 要取得 | ✅ ensureSalonSelected (DOMは美容室と共通) |
| 予約一覧 | `/KLP/reserve/reserveList/init` | ✅ | ✅ scrapeBookings |
| 予約スケジュール | `/KLP/schedule/salonSchedule/` | ✅ | ✅ (所要時間補正) |
| 予約登録 | `/KLP/reserve/ext/extReserveRegist/` | ✅ | ✅ pushBookingViaForm |
| スタッフ | `/CNK/draft/staffList` | ✅ | ✅ scrapeStaff |
| メニュー | `/CNK/draft/menuEdit` | ✅ | ✅ scrapeMenus |
| クーポン | `/CNK/draft/couponList` | ✅ | ✅ scrapeCoupons |
| ブログ | `/KLP/blog/blogList/` 他 | ✅ | ✅ scrapeBlogs / postBlogViaForm |
| フォトギャラリー | `/CNK/draft/photoGalleryEdit` | ✅ | ✅ scrapePhotoGallery / postPhotoGalleryViaForm |
| 口コミ取得 | `/KLP/review/reviewList/` | ✅ | ✅ scrapeReviews (AI返信案: /api/salonboard/review-reply) |
| 口コミ返信投稿 | `/KLP/review/reviewReply/?reviewId=` | ✅ | ✅ postReviewReplyViaForm (job_type push_review_reply・ENABLE_PUSH準拠) |

### 美容室 (hair) — `美容室/`
| 画面 | URL | HTML | スクレイパー |
|---|---|---|---|
| ログイン後TOP(単一) | `/CNC/top/` | ⬜ 要取得(任意) | — |
| グループ選択(複数) | `/CNC/groupTop/` | ✅ `グループ店舗選択_groupTop.html` | ✅ ensureSalonSelected |
| スタイリスト | `/CNB/draft/stylistList/` | ✅ | ✅ scrapeStylists |
| スタイル一覧 | `/CNB/draft/styleList/` | ✅ | ✅ scrapeStyles |
| スタイル登録 | `/CNB/draft/styleEdit/` | ✅ | ✅ postHairStyleViaForm (フォトギャラリー kind=style) |
| 予約スケジュール | `/CLP/bt/schedule/salonSchedule/` | ✅ | ✅ scrapeHairBookings (本採用) |
| **予約一覧(検索結果/明細)** | `/CLS/hair/reservations/init/` | ⬜ 要取得(予約あり状態) | 🟡 不使用(スケジュール方式に変更) |
| 予約一覧(検索フォーム) | `/CLS/hair/reservations/init/` | ✅ (React SPA・構造確定) | 🟡 不使用 |
| 予約登録(新規予約) | （未確認） | ⬜ 要取得 | ⬜ 未実装 |
| ブログ | （未確認 / KLP共通か要確認） | ⬜ 要確認 | — |
| クーポン | （未確認） | ⬜ 要確認 | — |
| 口コミ一覧 | `/CLP/bt/review/reviewList/` | ✅ `口コミ_reviewList.html` | ✅ scrapeReviews (テーブル構造はエステと共通) |

各ジャンルの詳細・取得依頼は `エステサロン/README.md` / `美容室/README.md` を参照。
