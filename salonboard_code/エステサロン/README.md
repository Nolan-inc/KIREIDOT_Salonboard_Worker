# エステ (esthetic) — SalonBoard 実DOM

エステ系（nail/eyelash も現状はここに準ずる）の画面HTML。URLは主に `/KLP/...` と `/CNK/...`。

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
| `口コミ_reviewList.html` | 口コミ | `https://salonboard.com/KLP/review/reviewList/` |
| `_調査用_salonboard_test.html` | （調査用テンポラリ） | — |

## 状況
- 取得・登録（予約/スタッフ/メニュー/クーポン/ブログ）は実装済みで本番稼働中。
- フォトギャラリー(photoGalleryEdit) は **空き枠に画像+タイトル+キャプション+ジャンル+掲載を入れて一括登録** する方式。
  自動投稿は `postPhotoGalleryViaForm`（scrapers.cjs, job_type `push_photo_gallery`）。詳細は同HTML冒頭コメント参照。
- 口コミ(reviewList) は HTML はあるが scraper 未実装。
