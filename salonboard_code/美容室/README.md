# 美容室 (hair) — SalonBoard 実DOM

美容室の画面HTML。URLはエステ(`/KLP`,`/CNK`)とは別系統で、主に `/CLP/...`・`/CLS/...`・`/CNB/...`。

## ★ ログイン後の入口 (このジャンルの場合)
- **1店舗(単一)**: `https://salonboard.com/CNC/top/` (サロン選択不要)
- **複数店舗(グループ)**: `https://salonboard.com/CNC/groupTop/` (サロンを選択してから各機能へ)
  - エステ等は `/KLP/groupTop/` で **prefix が違う**点に注意 (詳細は親 `salonboard_code/README.md`)。

## ファイル一覧 (取得済み ✅)

| ファイル | 画面 | URL | scraper |
|---|---|---|---|
| `グループ店舗選択_groupTop.html` | 複数店舗のサロン選択 | `https://salonboard.com/CNC/groupTop/` | ✅ ensureStoreSelected / ensureSalonSelected |
| `スタイリスト_stylistList.html` | スタイリスト一覧 | `https://salonboard.com/CNB/draft/stylistList/` | ✅ scrapeStylists |
| `スタイル_styleList.html` | スタイル一覧 | `https://salonboard.com/CNB/draft/styleList/` | ✅ scrapeStyles |
| `スタイル登録_styleEdit.html` | スタイル掲載情報編集/登録（新規追加=`addStyle`） | `https://salonboard.com/CNB/draft/styleEdit/`（POST: `/doRegister`） | ✅ **postHairStyleViaForm**（フォトギャラリー自動投稿 kind=style） |
| `予約一覧フォーム_hairReservations.html` | 予約一覧の検索フォーム(React SPA) | `https://salonboard.com/CLS/hair/reservations/init/` | 不使用(スケジュール方式に変更) |
| `スケジュール_salonSchedule.html` | スケジュール(予約明細あり) | `https://salonboard.com/CLP/bt/schedule/salonSchedule/?date=YYYYMMDD` | ✅ **scrapeHairBookings (本採用)** |
| `口コミ_reviewList.html` | 口コミ一覧 | `https://salonboard.com/CLP/bt/review/reviewList/`（ページング `?pn=N`） | ✅ **scrapeReviews**（テーブル `table.mod_table03` はエステと共通。返信URLが `/CLP/bt/review/reviewReply/R...`） |

## ⚠️ 重要: 予約一覧は React製SPA (エステの旧式フォームと別物)

- CSSは `style_xxx__hash` (CSS modules)。`name` 属性は意味のある英語名。
- **検索ボタンは `type="button"`**（フォームsubmitではなくJS実行）。クリック→XHRで結果描画の可能性が高い。
- **来店日 input は `readonly`** で値は「2026年6月7日（日）」形式（yyyy/mm/dd や yyyymmdd ではない）。
  → 防御的に値を埋めても効かない可能性。日付ピッカー操作 or 「本日/明日」ボタン、または
     ショートカット検索リンク (`/CLS/hair/reservations/search/...`) の利用を検討。
- 検索条件の name (確定):
  - 来店日 `startDate` / `endDate`
  - ステータス `nonCancelStatus`(TEMPORARY/WAITING/IN_PROGRESS/DONE/FIXED/SALES_REGISTERED) /
    `cancelStatus`(REFUSAL/CANCEL/SALON_CANCEL/UNAUTHORIZED_CANCEL/TEMPORARY_CANCEL)
  - 確認状況 `confirmationStatus`(UNREAD/READ)
  - 顧客名 `customerLastName` / `customerFirstName`、予約番号 `reservationId`
  - スタイリスト `staffId`(T...)、予約経路 `reservationRouteId`(K...)
- ショートカット検索リンク（GETで結果ページに直行できる可能性が高い・有用）:
  - 未読: `/CLS/hair/reservations/search/nonRead/`
  - 確定待ちの仮予約: `/CLS/hair/reservations/search/tempReserve/`
  - 来店処理未登録: `/CLS/hair/reservations/search/accountant/`

## 取得してほしいHTML（⬜ = 未取得）

> いずれも **CSSが当たっていなくてOK**（構造だけ分かれば実装できます）。
> 取得方法: 対象画面で「ページのソースを表示(View Source)」して保存、または
> 予約同期くんの debug capture (`~/.kireidot/salonboard-debug/bookings/{日時}_hair_result/page.html`) を共有。

| 優先 | 画面 | URL | ファイル名(保存先) | 用途 |
|---|---|---|---|---|
| ★最優先 | **予約一覧 検索結果(明細が並んだ状態)** | `/CLS/hair/reservations/init/`（検索実行後） or ショートカット `/CLS/hair/reservations/search/nonRead/` 等 | `予約一覧結果_hairReservations.html` | 予約明細の抽出(日時/顧客/スタッフ/メニュー/金額/ステータス/予約番号B…)を実装するため。**予約が1件以上ある状態**で取得してほしい |
| ✅済 | 予約一覧 検索フォーム | `/CLS/hair/reservations/init/`（検索前） | `予約一覧フォーム_hairReservations.html` | 取得済み・構造確定済 |
| 中 | 単一店舗TOP | `/CNC/top/` | `TOP_top.html` | 単一店舗ログイン時の着地TOP（任意・構造確認用） |
| 中 | 新規予約登録フォーム | （TOP/予約一覧から「新規予約」で開く画面のURL） | `予約登録_hair.html` | KIREIDOT→SB の予約書き込み(push)を美容室対応するため |
| ✅済 | グループ サロン選択 | `/CNC/groupTop/` | `グループ店舗選択_groupTop.html` | 取得済み（複数店舗のサロン選択） |
| 低 | ブログ / クーポン | （美容室でのURLを要確認。KLP共通か別系統か） | — | 美容室のブログ/クーポンが /KLP 共通かどうか確認 |

## 状況メモ
- ログイン後の着地: 単一=`/CNC/top/` / 複数=`/CNC/groupTop/`。予約スケジュールは `/CLP/bt/schedule/salonSchedule/`。
- セッション切れ問題は解決済み（予約一覧=`/CLS/hair/reservations/init/` に分岐済み, Worker v0.2.91〜）。
- 予約一覧ページには「セッションを保ったまま到達」できる状態（v0.2.92〜93）。残るは**検索結果の明細抽出**で、上表★最優先のHTMLがあれば実装可能。
- スタイリスト=`T…`、スタイル=`L…`、クーポン=`CP…`、サロンID=`H…`、予約番号=`B…` のID体系。
