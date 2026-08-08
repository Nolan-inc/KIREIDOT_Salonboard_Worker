# SalonBoard 固有仕様・地雷集

SalonBoard(ホットペッパービューティー管理画面)を自動操作するうえでの制約とハマりどころ。**「なぜこんな実装になっているのか」が分からなくなったときに読む**リファレンス。

出典はすべてリポジトリ内のコードとコメント(`electron/scrapers.cjs` / `worker.ts` / `salonboard-selectors.ts`)。実装が主戦場なのは `scrapers.cjs` で、worker.ts には旧・自前実装が残骸として併存しています。

関連: [shop-onboarding.md](shop-onboarding.md) / [operations.md](operations.md)

---

## 1. ジャンル(hair / esthetic)でシステムが2つある

genreは**2値**に正規化されます。`'hair'` 以外(`nail`/`eyelash`/`other`含む)はすべて esthetic 扱い。

### 1.1 URL系統の対応表

| 機能 | hair | esthetic系 |
|---|---|---|
| 予約系ルート | `/CLP/bt` | `/KLP` |
| スケジュール | `/CLP/bt/schedule/salonSchedule/` | `/KLP/schedule/salonSchedule/` |
| 予約登録フォーム | `/CLP/bt/reserve/ext/extReserveRegist/` | `/KLP/reserve/ext/extReserveRegist/` |
| 掲載管理 | `/CNB/` | `/CNK/` |
| スタッフ一覧 | `/CNB/draft/stylistList/` | `/CNK/draft/staffList` |
| 設備設定 | **存在しない** | `/CNK/set/equipList/` |
| 勤務パターン | `/CLP/bt/set/workPatternSetup/` | `/KLP/set/workPatternSetup/` |
| 口コミ返信 | `/CLP/bt/review/reviewReply/{id}`(パス) | `/KLP/review/reviewReply/?reviewId=`(クエリ) |
| 管理TOP | `/CLP/bt/top/` | `/KLP/top/` |
| 受付可能数同期 | 対応 | **非対応**(`GENRE_UNSUPPORTED`) |

### 1.2 フォームのパラメータ名・DOMも違う

新規予約の登録URL:
- hair: `?date=YYYYMMDD&time=HHMM&stylistId=T...&rlastupdate=...`
- esthetic: `?staffId=W...&date=YYYYMMDD&rsvHour=HH&rsvMinute=MM&rlastupdate=...`

**スタッフIDのパラメータ名も値の接頭辞も違います**(hair=`stylistId=T...` / esthetic=`staffId=W...`)。

フォームDOM:
- hair: `select[name="stylistId"]` / `select#rsvTime`(時分が結合、value=`"1100"`)/ `select#rsvTermId`(分)。**設備欄 `#equipArea` が無い**
- esthetic: `select#salonStaffList` + hidden `#staffId` / `#jsiRsvHour` + `#jsiRsvMinute`(時分が別select)

hairで所要時間 `rsvTerm` を設定し忘れると**既定30分で登録される**バグになります(URLで時刻は指定済みでも所要は既定のまま)。

その他ジャンル差: シフト一括のチェックボックス名(`stylistIdList` vs `staffIdList`)、クーポン一覧の列構成(hairは「利用条件」列、estheticは「有効期限」列)、スタッフ並び順のDTO名、スケジュールのcolspan粒度(hairは30分刻みの粗い目安で75分が60/90に化ける)など。

### 1.3 ⚠️ 異ジャンルのURLに触るとセッションが壊れる

**最も再現しにくい罠です。** hairの店舗文脈でエステ用URL(`/KLP/reserve/reserveList/init` など)を開くと、SBのセッションが「有効期限切れ」になり、**後続のhair処理まで道連れで失敗します**。

そのため実装では:
- 予約ID逆引きを genre で分岐(hairは `findReserveIdViaScrape`、estheticは `findReserveIdForBooking`)
- 勤務パターン取得は「正規導線ファースト(genre優先)」。異業態URLの総当たり探索は禁忌
- グループ/hairアカウントに `/KLP/top/` を踏ませない(無効パスで SESSION_EXPIRED → 後続のサロン入場まで壊す)

**教訓: 「どのURLか分からないので順に試す」を絶対にやらないこと。**

### 1.4 `salonboard-selectors.ts` は hair 非対応

`SB_PATHS` は `/KLP/` `/CNK/` 固定で genre 分岐がありません。これを使う worker.ts の旧 pushBooking 経路は hair 店では機能しないはずです(実運用は scrapers.cjs 経由のため顕在化していない)。**新規実装でこのファイルの定数を使わないこと。**

---

## 2. グループ店(1ログイン複数サロン)

### 2.1 サロン選択が必須

グループアカウントはログイン直後 `/CNC/groupTop/`(サロン一覧)に着地します。**対象サロンを選ばずに schedule/reserve へ入ると session_expired になります。**

さらに危険なのは「前のジョブの店舗が選択されたまま」進むケースです。別店舗を検索して候補0件になり、その後の登録が別店舗のスタッフIDで KPCL017V01 に落ちます。

### 2.2 実装上の判定

`shouldSelectSalonContext()` は**設定値より実画面を優先**します。「SBが実際にサロン一覧へ着地させたなら、グループアカウントであることは確定」という考え方です。

### 2.3 サロン選択の地雷

| 地雷 | 対策 |
|---|---|
| 店舗リンク(`a[id^="H"]`)は**AJAX遅延ロード**。待たずに読むと空判定→`group_top_no_stores` を誤発報(郡山ADERの0件の主因) | `waitForSelector` で8秒待つ→空ならreload→反対側のgroupTopパス(`/CNC/` ⇔ `/KLP/`)も試す |
| リンクが `javascript:void(0)` でloadイベントが来ない | `waitForFunction` でURL変化/groupTop離脱を待つ。最大2回クリック(2回目は force) |
| **hairはサロン選択後もURLがgroupTopのまま残る個体がある**(AJAXで選択状態だけ保存) | `/CLP/bt/top/` を開いて「予約管理\|掲載管理」の存在を確認するのが真の成否判定 |
| 選択POST直後の遷移で戻される | 1.2秒待ってから遷移 |
| **単店アカウントには `/CNC/groupTop/` が存在しない**(「指定されたURLは存在しません」) | グループ判定を誤ると存在しないパスへ飛ばして誤失敗(2026-08-01 代官山) |

失敗理由の文字列: `group_top_no_stores` / `still_on_group_top` / `salon_id_not_in_group(H...)` / `group_top_name_unmatched` / `hair_context_not_established(...)` / `single_salon_context_not_verified`

エラーには候補サロン一覧(`H-code=サロン名`、最大8件)が含まれます。**これを見て `salonboard_credentials.salonboard_salon_id` を設定すれば次回から確実に選べます。**

---

## 3. エラーコードと文言の読み方

### 3.1 一過性(infra transient)か決定的かの分類

`isInfraTransientError()`(`worker.ts:308`)が中核です。

**一過性と判定されるもの**:
- エラーコード: `SB_SERVER_ERROR` / `SB_REGISTER_INCOMPLETE` / `SESSION_EXPIRED`
- 文言の正規表現: `login did not complete` / `再度操作しなおしてください` / `システムエラー` / `予定の登録完了を確認できません` / `exact_schedule_not_found` / `予定登録後の実在確認に失敗` / `削除操作後もスケジュール上に予定が残っています` / `フォームに到達できません` / `登録ボタンが見つかりません` / `保存を確認できません` / `timeout` / `navigation` / `net::` ほか

**効果**: 試行上限を超えても `manual_required` に昇格させず `retryable_failed` を維持します。理由は「20〜45分のAkamaiクールダウン窓の中で3回消費しただけの一過性失敗が『手動登録が必要』に固定され、実際は回復後に自動で通るのに人手を要求してしまう」ため。

逆に `SLOT_NOT_AVAILABLE` / `*_MAPPING_NOT_FOUND` / `CONFIRMATION_MISMATCH` / `UNKNOWN_ERROR` は実データ/セレクタ起因として上限超過で manual に倒します。

> ⚠️ **reason文字列がworkerとscrapers間の暗黙の契約になっています。** scrapers側のエラーメッセージを書き換えると分類が変わります(`scrapers.cjs:4136` に明示的な警告あり)。

### 3.2 SBの特徴的な文言

| 文言 / コード | 意味 |
|---|---|
| `KPCL017V01` / `情報が一部失われています` / `他のユーザによって変更されているため` | rlastupdate(楽観ロック)失効 → §6 |
| `KPCL009V01` | 素の reserveDetail 直リンク遮断(2026-07-02〜)。一覧/スケジュール経由が必要 |
| `KPCL\d{3}V\d{2}` (汎用) | エラーページ全般 = セッション失効扱い |
| `有効期限が切れ` / `再度ログイン` / `操作されなかった` | セッション失効 |
| `指定されたURLは存在しません` | 無効パス(単店でgroupTopを開いた等) |
| `サロンが選択されていません` | サロン未選択 |
| `画像認証` / `イラストを完成` / `パーツをドラッグ` | SB独自のドラッグ式画像認証 → §5 |
| `まだ登録されていません` | doCompleteの2段階確認ページ = **未登録** |
| `本文に利用不可文字が含まれています` | JIS X 0208外の文字(絵文字等) |
| `メニューとの重複登録にご注意ください。` | **常設の注意書き**(誤検知の元 → §3.3) |

### 3.3 body全文検索は誤爆する

かつてページ全体テキストを `/予約できません|空いて|満員|埋ま|重複/` で検索していたため、登録フォームに**常設**の注意書き「メニューとの重複登録にご注意ください。」の「重複」に誤反応していました。

現在はエラー専用要素(`.mod_box_warning, #warningMessageArea, .error, ...`)だけを見ます。ただし警告モーダルの2文言(`スタッフの受付可能数を超えて` / `入力された振り分け日時にスタッフの予定が入っています`)だけはbody全文で判定します。

---

## 4. 入力値の制約

### 4.1 時刻の刻み

| 対象 | 刻み |
|---|---|
| 開始時刻ピッカー | 5分刻み |
| 開始「分」select | 00/15/30/45 |
| **メニュー/クーポンの所要時間** | **5分単位必須**(違反は `VALIDATION_ERROR`) |
| 所要時間select | 時=分換算value(60=1時間)、端数分は別select |

**11:31 のような15分刻み外の予約時刻は永久に失敗します。** 75分のような端数は「60分select + 15分select」で表現します。

### 4.2 文字数上限

| 項目 | 上限 |
|---|---|
| ブログタイトル | 全角25文字(超過は自動切り詰め) |
| 口コミ返信本文 | 500文字 + 改行80回以下 |
| 口コミ返信者名 | 40文字・**必須**(既定「スタッフ一同」) |
| メニュー名 / 説明 | 40 / 70文字 |
| クーポン名 / 内容 | 36 / 90文字 |
| 勤務パターン短縮名 | 半角英数記号2文字以内 |

超過は `VALIDATION_ERROR` + manual。**再実行しても直りません**(データ修正が必要)。

### 4.3 文字種の制約 — SBはShift-JIS基盤

**顧客氏名**:
- `()` や数字・記号を許可しない
- **英字も拒否される**(2026-06-30 "Maki" で doComplete「まだ登録されていません」が一貫発生)→ ローマ字→全角カタカナ変換テーブルを実装
- カナは必須(空なら `ヨヤク` / `キャクサマ` で埋める)
- 敬称は除去(SBが表示時に「様」を付けるため「マキサン 様 様」になる)

**ブログ本文・タイトル**: JIS X 0208 外の文字を拒否。絵文字・国旗・キーキャップ・異体字セレクタ・ZWJ を除去(★☆♪ のみ温存)。

**波ダッシュ問題**: SBの校閲は波ダッシュ(U+301C)を「確認が必要な文字」として扱い、**新規行をサイレントに保存しません**。全角チルダ(U+FF5E)に正規化して回避しています。

**スタッフ名の絵文字ゆらぎ**: KD側 `rimi💕` に対しSB側 `rimi` のような差があるため、NFKC正規化+記号除去+小文字化で照合します。

### 4.4 隠れた必須項目

- **設備(席/ベッド)**: エステ等では必須。未設定だと `errorInput` で登録ボタンが無効化され、**confirmは出るのに登録されない**。必ず1台だけ割り当て、2行目以降を空に戻せなければ送信しない
- **指名予約フラグ**: 担当スタッフを選ぶだけではSBの自動振り分け予約と区別できない。`rsvType` チェックボックスを明示的にONにする。できなければ登録中止
- **hidden の取り違え**: 表示用 `salonStaffList` を選んでも hidden `#staffId` と `staffIdList` が既定スタッフのままだと**全員が既定スタッフで登録される**。3つとも強制同期してイベント発火する

---

## 5. bot対策(CAPTCHA / Akamai)

### 5.1 2種類ある

**(A) reCAPTCHA** — `iframe[src*="recaptcha"]` で検知。
→ `RECAPTCHA_REQUIRED` + manual → worker が **6時間ブロック**、自動リトライしない。プロキシの良し悪しと切り分けられないため、出口の成功/失敗にカウントしない。

**(B) SB独自のドラッグ式画像認証** — `画像認証|イラストを完成|パーツをドラッグ` + `input[name="captchaLogin"]` で検知。
→ **Cloudでは解けない。** 6時間ブロックせず通常失敗として返し、規定回数後に画面操作可能なPCへ移管します。

> **1回目で打ち切る設計**: 「アカウント/Akamaiフラグ起因で、出口を替えて連続再ログインしても解けない。試行を重ねるほどフラグを強化し、ログインペーシングとアカウントレーンを数十分占有して予約書込の遅延源になるため、1回目で打ち切って次回に任せる」(`worker.ts:1193`)

### 5.2 予防側の作り込み

- **ステルス起動**: `--enable-automation` 等を外す、`navigator.webdriver` 除去、ja-JP/Asia-Tokyo、実Chrome(`SB_BROWSER_CHANNEL=chrome`)
- **userDataDir永続**: アカウント単位でプロファイルを持ち、Akamaiのセンサーcookie(`_abck`)を回またぎで蓄積して信頼を育てる
- **ウォームアップ**: 深層ページへ直接入らず、TOPで2.5秒待ち→マウス移動→スクロール→待機、で `_abck` の信頼を立ててからscrapeに入る
- **書込前の人間化**: submit直前にマウス軌跡を作る(Akamaiは書込POSTも採点する)
- **ログインPOSTのペーシング**: endpoint単位+アカウント単位の両キーで直列化、最小間隔10秒。「**doLogin試行回数こそがフラグの主因**」
- **人手風ランダム待機**: 日付めくり300〜1200ms、詳細ページ開封0.4〜1.1秒

### 5.3 IPと `_abck` の関係

**`_abck` は発行時のIPに紐づく**ため、店舗→出口IPのsticky割当が必須です。IPをローテートするとセッションが壊れます(2026-06-30に判明した書込500の真因)。

住宅IP(residential)は **`/login/` をHTTP応答段階から拒否**されることを本番で確認済み。読み取り専用にしか使えません。

### 5.4 画像アップロードのホールド

CNBスタイル画像の `doUpload` はAkamaiに中断されやすく(`ERR_ABORTED`=「通信に失敗しました」)、45秒無応答なら一時ホールドと判断して `SB_UPLOAD_HELD` → **15分後にdeferred**(失敗確定しない)。

Playwrightの `request` API直POSTはブラウザのTLS指紋/センサーを持たないため弾かれます。JS注入(File+DataTransfer)も `isTrusted=false` で評価が下がります。銀座(CNK)ではXHRで通るがCNBはダメ、という店舗/genre差も記録されています。

---

## 6. rlastupdate(楽観ロックトークン) — KPCL017の正体

新規予約登録フォームを開くとき `rlastupdate=<YYYYMMDDHHmmss>` を付けないと「情報が一部失われています」(KPCL017V01)になります。スケジュール画面に埋め込まれた更新タイムスタンプです。

### 6.1 鮮度の罠(実機知見の蓄積)

| 事象 | 対策 |
|---|---|
| 要素が最初に現れた瞬間の値はAjax更新前の古いトークン(銀座は毎回KPCL017) | 75ms間隔で監視し**3回連続同値**になってから採用(最大1.8秒) |
| `state=visible` で待つとhidden要素で毎回8秒タイムアウト、その間に失効 | `state: 'attached'` だけ待つ |
| WAO新宿: スケジュール画面の常時AJAXで登録フォームへの遷移が最大**14秒**遅れ、その間に失効 | 遷移直前に `window.stop()` |
| Chrome HTTP cacheが古いHTMLを返す | URLに `_kd_token=Date.now()` を付与 |
| 未来日の重いスケジュール描画で失効 | 再試行時は日付を付けず**当日**から取得 |

**rlastupdateは日付非依存の「現在時刻トークン」**です(SBの枠クリックUIもクリック時点の現在時刻を使うことを実機確認)。ただし店舗差があり、WAO新宿は現在時刻で十分、銀座は正規値の完全一致が必要。そのため**初回は正規値、KPCL再試行の奇数回だけ現在時刻**に切り替えます。

### 6.2 リトライ設計

全工程(スケジュール再取得含む)を**最大4回**やり直し、5回目で `SB_SERVER_ERROR`(manualRequired=false)として次attempt(fresh browser/proxy)へ渡します。

> KPCL017V01 は入力内容やスタッフ紐付けの不整合ではなく、**別操作でrlastupdateが更新された一時競合**です。冒頭の既存予約確認により、直前の試行が実は成功していた場合も二重登録にはなりません。

**運用上の含意**: KPCL017が多発したら「密度」を疑ってください。同一店舗への高密度書込・並行実行が原因で、店舗固有バグではありません。ホールドされた書込の一括再投入は厳禁、10〜12分間隔で1件ずつ。

---

## 7. 偽成功を防ぐ仕組み

### 7.1 SBはPOSTを受理してから黙って破棄する

既存予定と重複する予定登録などで発生します(2026-07-25 中目黒: 既存予定と重複した予定が消えたのに synced 扱いの偽成功)。**POST受理は成功の証拠になりません。**

### 7.2 予約登録の多段判定

1. エラーページ着地(`/ErrorDocument/50x`)→ `SB_SERVER_ERROR`(retryable)
2. エラー専用要素だけを読む(body全文は使わない)
3. 警告モーダル文言はbody全文で判定
4. **`まだ登録されていません` があれば未登録** → `SB_REGISTER_INCOMPLETE`(retryable)。**doCompleteは成功画面ではなく2段階確認画面**
5. URLに `doComplete` が無く `extReserveRegist` のまま → 送信されていない
6. 完了サインが無くてもダイアログを承認済みなら**一覧を再照合**(誤failを成功に転換し、再試行による二重登録を防ぐ)
7. reserveIdが取れなくても成功扱いにする(`idUnverified`)。IDは後続のメール取込/一括取込で補完

### 7.3 予定(ブロック)登録は実在確認が真実源

POST受理後にスケジュール画面を開き直して実在を確認します。受理されたのに実在しなければ「SalonBoard側で破棄された可能性があります」として `CONFIRMATION_MISMATCH`。既存予定を検出したら冪等成功(`alreadyExists`)。

### 7.4 二重登録防止プリフライト

`payload.preflight_required` が真のときだけ実行(孤児再enqueue・手動リトライ・sweep再enqueue時にAdminが付与):

- reserveIdがあれば詳細を直接開いて `active` / `cancelled` / `not_found` / `unknown` を判定
- **`unknown` なら登録に進まず安全側で manual に倒す**(二重登録を避ける)
- 顧客名がある時だけ一覧照合(空だと全件スキャンで240sハングする)
- **一覧マッチだけで断定しない**。キャンセル済み行が一覧に残るため、詳細で `active` 確認が必須(2026-07-11 銀座: キャンセル済み予約に誤マッチして登録がスキップされ続けた偽already_exists)

### 7.5 構造的な限界

**予約一覧に備考列が無いため、KIREIDOT予約IDでの照合ができません。** 「時間帯の重なり」だけで判定すると別スタッフの予約まで重複扱いする危険があるため、重なり候補があれば自動 already_exists にせず manual に倒しています。

### 7.6 その他の冪等化

- キャンセル: 既にキャンセル済み/ボタン無し → 冪等成功
- 削除系: SB上に既に無ければ成功。削除後にフォームを開き直して消えたか検証
- 口コミ返信: 返信済みならスキップ
- メニュー/クーポン: 同名行を再利用、無い時だけ空き行に作成
- 受付可能数: 「戻す→+/-クリック→設定」の冪等モデル。保存後に再読して変化が無ければ**偽成功として失敗扱い**
- 勤務パターン: 名前が違っても時間一致なら同一とみなす

---

## 8. セッション・ログイン

### 8.1 同一アカウント同時1セッション

SBは1ログインで複数店舗を持つため、DBの店舗単位レーンだけでは同一ログインの店舗が並列実行され、サロン選択・フォーム状態・Cookieを奪い合います。

対策は3層:
1. DB claim: `coalesce(group_account_id, shop_id)` をレーンキーに advisory lock
2. worker内: ログインアカウント単位で直列化
3. ログインPOST: endpoint+アカウントの両キーで直列化

さらに**予約書込はfetchを即preempt**します(走行中fetchのshop_idが書込待ちに含まれたらAbort+page.close)。

### 8.2 userDataDir

- パス: `~/.kireidot/salonboard-chrome-profile/account-<hash>`(認証情報はパスに出さない)
- **SIGTERM時にcontextを明示closeしてcookie/`_abck` をflush**する。docker の SIGKILL でChromeを強制killするとセッション未flush → 次起動で全店再ログイン → Akamaiスロットル、という障害連鎖になる(だから `docker stop -t 40`)
- 孤児Chromeの `SingletonLock` は `pkill -f -- "--user-data-dir=..."` で解消して1回再試行
- env変更はコンテナ再作成が必要でプロファイルが消えるため、並行度・プール・レーンは**ファイルでホット設定**する

### 8.3 keepalive(既定OFF)

温かいセッションを15分ごとに軽く触って延命し、cold loginの嵐(=画像認証/KPCL017の増幅器)を根絶する仕組み。needs_loginのアカウントはスキップ(再ログインを撃たない)。**書込走行中のみスキップ**(fetch中は許可 — かつてfetch中もスキップしていたためfetchが多い時間帯にセッションがcold化していた)。

### 8.4 ログイン画面の特殊事情

- **ログインボタンは `<a>`**(`onclick="dologin(event)"`)。`button[type=submit]` は存在しない
- 1文字ずつ入力(`delay: 90ms`)してbot検知を避ける
- 負荷時はID欄が先に描画されパスワード欄が遅れて差し込まれる。ID だけ待って即入力すると恒久的なフォーム欠落と誤判定する
- **`/KLP/`(末尾スラッシュのみ)は404**。ログインフォームが無くURLに `/login` も含まないため、旧実装はこれを「ログイン済み」と誤判定し、無効セッションのまま**常に0件**をscrapeしていた
- ログイン判定は**肯定的に**行う(管理ナビ「予約管理\|掲載管理」の存在、またはサロン一覧の存在)。「ログインフォームが無い=ログイン済み」は誤り

---

## 9. タイムアウト・安全弁

| 定数 | 値 | 意味 |
|---|---|---|
| `READ_JOB_SAFETY_TIMEOUT_MS` | **10分** | 取得系の**ハング検知**用(処理期限ではない)。「N件目以降だけ欠損 + 実行ちょうど10分」はこれによるChrome killのサイン |
| `CLOUD_WRITE_FALLBACK_TIMEOUT_MS` | **330秒** | 予約/シフト書込。3回の全工程再実行を6分以内で完結させ、残り時間でcallback/PC移管を行う |
| `JOB_TIMEOUT_SETTLE_GRACE_MS` | 60秒 | Chrome kill後、元処理の確定を待つ。待たずにJOB_TIMEOUTを返すと**成功したcallbackを捨てて再実行**してしまう |
| reCAPTCHAブロック | 6時間 | |
| `SB_UPLOAD_HELD` deferred | 15分 | |
| ログイン最小間隔 | 10秒(上限15秒) | |
| KPCL017リトライ | 最大4回 | |
| `formFieldTimeoutMs` | 750ms | 旧実装は項目あたり最大30秒で入力だけで90秒消費していた |
| `networkidle` 待ち | 3,500ms | SBは常時通信で40秒近く待つことがあるため長く待たない |

タイムアウト時は浮きChromeを `pkill` します(そうしないと次ジョブが同一プロファイルへ突入してセッションを相互破壊する)。タイムアウト後30分は孤児callbackを抑止します。

---

## 10. 非自明な地雷トップ10(要約)

1. **異ジャンルURLに1回でも触るとセッションが壊れ、後続処理まで道連れ**。総当たり探索は禁忌
2. **`/KLP/` は404、hairに `/KLP/top/` は無効**。ログイン判定は肯定的に行う
3. **rlastupdateは数秒〜14秒で失効する**。しかも店舗によって「正規値必須」「現在時刻でOK」と挙動が違う
4. **doCompleteは成功画面ではなく2段階確認画面**。`まだ登録されていません` を見落とすと偽成功
5. **SBはPOST受理後に無言で破棄する**。実在確認が唯一の真実源
6. **予約一覧に備考列が無い**ためKD予約IDで照合できない(構造的制約)
7. **キャンセル済み行が一覧に残る**ため、一覧マッチだけでは偽already_exists
8. **SBはShift-JIS基盤**。絵文字・波ダッシュ・英字氏名が拒否され、しかも波ダッシュは**サイレントな保存失敗**
9. **表示用selectを選んでもhiddenが同期されない** → 全員が既定スタッフで登録される
10. **doLogin試行回数そのものがフラグの主因**。失敗したら粘らず切って次回に任せるのが正解
