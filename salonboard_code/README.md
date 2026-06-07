# salonboard_code — SalonBoard 実DOMリファレンス

スクレイピング実装の根拠にする「SalonBoard の各画面の実HTML」を、**ジャンル別**に保管する場所です。
コードはこのフォルダのHTMLを実行時に読みません（あくまで開発時の参照・セレクタ確定用）。

## 重要: ジャンルでURL/DOMが大きく異なる

| | エステ等 (esthetic/nail/eyelash) | 美容室 (hair) |
|---|---|---|
| 管理TOP | `/KLP/top/` | `/CLP/bt/top/` |
| 予約一覧 | `/KLP/reserve/reserveList/init` | `/CLS/hair/reservations/init/` |
| スタッフ | `/CNK/draft/staffList` (スタッフ) | `/CNB/draft/stylistList/` (スタイリスト) |
| メニュー | `/CNK/draft/menuEdit` (メニュー) | `/CNB/draft/styleList/` (スタイル) |
| グループ店舗 | ログイン後 `/CNC/groupTop/` でサロン選択（共通） | 同左 |

→ Worker は `shops.genre` で取得方法を分岐する（[[salonboard-genre-scraping]] / 実装は `electron/scrapers.cjs`）。

## ファイル命名規則

`機能名_SBパス末尾.html`（例: `予約一覧_reserveList.html`）。
HTMLを追加したら、対応するジャンルの README の表を更新してください。

## 収集状況 (✅=あり / ⬜=要取得) と スクレイパー対応状況

### エステ (esthetic) — `エステサロン/`
| 画面 | URL | HTML | スクレイパー |
|---|---|---|---|
| 予約一覧 | `/KLP/reserve/reserveList/init` | ✅ | ✅ scrapeBookings |
| 予約スケジュール | `/KLP/schedule/salonSchedule/` | ✅ | ✅ (所要時間補正) |
| 予約登録 | `/KLP/reserve/ext/extReserveRegist/` | ✅ | ✅ pushBookingViaForm |
| スタッフ | `/CNK/draft/staffList` | ✅ | ✅ scrapeStaff |
| メニュー | `/CNK/draft/menuEdit` | ✅ | ✅ scrapeMenus |
| クーポン | `/CNK/draft/couponList` | ✅ | ✅ scrapeCoupons |
| ブログ | `/KLP/blog/blogList/` 他 | ✅ | ✅ scrapeBlogs / postBlogViaForm |
| 口コミ | `/KLP/review/reviewList/` | ✅ | ⬜ 未実装 |

### 美容室 (hair) — `美容室/`
| 画面 | URL | HTML | スクレイパー |
|---|---|---|---|
| スタイリスト | `/CNB/draft/stylistList/` | ✅ | ✅ scrapeStylists |
| スタイル | `/CNB/draft/styleList/` | ✅ | ✅ scrapeStyles |
| **予約一覧(検索結果/明細)** | `/CLS/hair/reservations/init/` | ⬜ **要取得(最優先・予約あり状態)** | 🟡 到達のみ(明細抽出は要DOM) |
| 予約一覧(検索フォーム) | `/CLS/hair/reservations/init/` | ✅ (React SPA・構造確定) | 🟡 |
| 管理TOP | `/CLP/bt/top/` | ⬜ 要取得(任意) | — |
| 予約登録(新規予約) | （未確認） | ⬜ 要取得 | ⬜ 未実装 |
| ブログ | （未確認 / KLP共通か要確認） | ⬜ 要確認 | — |
| クーポン | （未確認） | ⬜ 要確認 | — |

各ジャンルの詳細・取得依頼は `エステサロン/README.md` / `美容室/README.md` を参照。
