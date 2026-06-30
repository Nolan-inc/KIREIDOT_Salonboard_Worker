# SalonBoard 書込IP アーキテクチャ — 間欠500の根本原因と対策

最終更新: 2026-06-30 / 関連: cloud worker(EC2 i-0f1cc0aff1ac8dd2e), Decodo proxy

## 現象
- 銀座(及び他店)の **書込(push, form-POST)が間欠的に SBの `500.html` に着地**して失敗。読み(fetch, GET)は同一IP・同一時間帯で全通。
- 直近2hの銀座: 読み **6/6成功**、書込 **3/6失敗**(500含む)。同一の固定IP(`isp.decodo.com` の銀座割当)。
- この固定IPの **累計書込は 477件**(+毎日の大量読み)。
- 失敗予約は内容正常(**手動登録は通る**)。SBは落ちていない(読み・手動とも通る)。

## 根本原因(挙動からの推定・証拠は強い)
SBは **Akamai Bot Manager**(`_abck` センサーCookie)で防御。Akamaiはアクションの重要度で審査の厳しさを変える:
- GET(読み)= 低リスク → 緩い → 通る
- 予約登録のPOST(書込)= 高リスク → 厳しい → bot指紋が悪いと弾く

1本の固定IPが、毎日大量の読み + 累計477件の機械的form-POSTを同一テレメトリで叩き続け、その **IP+Cookieの行動指紋がbotと学習** → 高リスクな書込POSTから間欠的に500/challenge。`login did not complete:500` は悪化時にセッション確立すら弾かれた状態。手動が通るのは **別IP + 人間テレメトリ** だから。

> 留保: パケット観測ではなく挙動からの推定。**確証テスト = 「新品IPで即成功するか」**。成功すればIP評価劣化で確定、それでも500なら別要因(CSRFトークン/アカウント単位レート制限)を疑う。

## なぜ固定IPがリスクを高めたか(設計史)
- 元: rotating gateway(`gate.decodo.com`)がセッション途中でIPを変える → `_abck`/login Cookieが別IPから送られ Akamaiがセッション乗っ取り扱いでブロック。
- 対処: 書込も読みと同じ **ISP固定IP**(`SB_PROXY_POOL`, commit f5413c6)。mid-session rotation 破壊を解消。
- **代償**: (1)単一障害点(1本劣化で店の書込全滅) (2)評価の集中蓄積(1本が全bot信号を永久蓄積)。
- ※ 「固定をやめてローテに戻す」は **誤り**(元のセッション破壊バグが再発)。正解は別構造(下記)。

## 制約(なぜ単純に読み書きを分けられないか)
- 書込も読みも **ログイン済みセッションが必要**で、そのセッションは `_abck` により **IP固定**(login したIPから読まないと Akamaiがブロック)。→ 読み書きが同一セッション=同一IPを共有。
- 読みを別IPに逃がすには「Akamaiを別レイヤで処理し、SBの login Cookie だけ passthrough」する方式(= Site Unblocker)が要る。

## 現状の在庫(2026-06-30 実機確認)
- Decodoアカウント `spr22wr3yb`: ISP固定 **10IP**(`isp.decodo.com:10001-10010`、1店1IP割当) + rotating residential gateway(`gate.decodo.com:7000`、fallback)。
- **Site Unblocker / Scraping API は未契約/未設定**。

## 対策(ROI順)

### Phase 1 ★本命: 読みを Site Unblocker へ逃がす
読みはステートレスGET。Decodo Site Unblocker(別製品。Akamaiを製品側で突破、SBの login Cookie は passthrough)に移す。
→ **固定IPは"低頻度の書込専用"** に → 負荷が桁で減 → bot評価回復 → 書込500激減。単一障害点の影響も「書込の瞬間だけ」に縮小。
- **前提(未充足・調達アクション)**: Decodoアカウントで Site Unblocker を有効化 + 「SBの login Cookie passthrough」「sticky session」対応を確認。
- worker側: fetch経路を「headfulブラウザ巡回」→「Site Unblocker API + login Cookie」へリファクタ(env gate)。1店パイロット → 全店。

### Phase 2: (セッション+IP)を"単位"でローテ
1本永久ではなく、fresh IPで login → N件/T分使用 → fresh IPで再login。店ごとにウォームセッションの小プール、書込ごとに評価良好な1本を選択、500を出したIPは即クールダウン退役。
- **前提(調達)**: ISP IPを増やす(現状10IPは1店1で予備なし=ローテ先が無い)。

### Phase 3(調達不要・即実施可): 負荷低減・人間化【暫定で書込500を減らせる】
- 同一セッションで fetch と push を **同時に走らせない**(直列化。トークン/`_abck`レース回避)。
- 書込前にマウス/間のテレメトリ注入、`_abck`ウォームアップ、ジッター低速化。
- fetch頻度を必要十分まで下げ、固定IPの読み負荷を削る。
- 500を出したIPのバックオフを長め + 店単位クールダウン。

## 確認事項(オープン)
- Decodo ISP IPは **専用か共用か**(共用なら他社bot通信で評価が下がる=制御外 → Site Unblocker化の根拠が強まる)。
- Site Unblockerが SBの login Cookie passthrough + sticky session に対応するか。

## 即時の運用
失敗した書込は worker のバックオフで再試行(良い窓で成功)。Phase 3の暫定対策で改善。Phase 1(Site Unblocker)が恒久解。
