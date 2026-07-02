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

## 2026-07-02 追記: 10006出口IP死亡インシデントと店舗別退避

### 事象
`isp.decodo.com:10006` の出口IPが **SalonBoard にのみ到達不能** になった (他サイトは疎通、
curl/実Chromeとも SBだけ 20s タイムアウト)。FNV-1a hash sticky で同IPに割当たる
新宿三丁目 + WAO表参道 が2日間全滅 (login `chrome-error://chromewebdata` / JOB_TIMEOUT連発)。

### なぜ自動検知できなかったか
- worker のプロキシヘルスチェック (playwright request probe → `/KLP/top/`) は **同じIPで 200 を返し続けた**。
  実Chrome (TLS指紋/HTTP2) と request probe (Node HTTP) で Akamai 側の遮断挙動が異なるため、
  probe では「健全」に見える。→ probe合格は実Chrome到達可能を保証しない。
- さらに JOB_TIMEOUT で放置された孤児 Chrome が profile の SingletonLock を握り、
  後続 launch が `browser has been closed` で失敗する二次障害が連鎖した。

### 対処 (PR#21)
1. **店舗別プロキシ退避ファイル** `/home/pwuser/.kireidot/proxy-shop-override.json`
   (`{"<shop_id>": "isp.decodo.com:10003"}`)。pickProxy が毎回読むため編集即反映・再起動不要。
   probe では検知できない「実Chromeだけ死ぬIP」から特定店舗を手動退避する運用弁。
2. **孤児Chrome kill+再試行**: launch が `has been closed` で失敗したら該当プロファイルの
   Chrome を pkill → 2s → 1回だけ再launch (per-shop mutex により同店舗の正当な並行Chromeは無い)。
3. ヘルスチェックは `resp.ok()` まで確認 (403ブロックページを健全と誤判定しない)。

### 運用手順 (再発時)
1. ポート別に SB到達性を確認: `curl -m 15 -x http://isp.decodo.com:100XX https://salonboard.com/KLP/top/` (EC2上)
2. 死んだポートに hash される店舗を特定 (hash表は下記) → override JSON に空きポートを割当
3. 対象店舗の profile/auth を `.bak` 退避 (新IPでは旧セッション無効) → 自動ログインが再シード
4. 該当 fetch ジョブを `status='queued', run_at=now(), attempts=0` で即時再実行

### hash割当表 (2026-07-02 時点)
| port | 店舗 |
|---|---|
| 10001 | WAO新宿 |
| 10002 | 中目黒, ADER鯖江, マグサロン (3店衝突・要注意) |
| 10003 | (空き→新宿三丁目をoverride退避) |
| 10004 | 代官山 |
| 10005 | 銀座 |
| 10006 | ~~新宿三丁目, WAO表参道~~ (死亡IP・退避済) |
| 10007 | なんば |
| 10008 | (空き→WAO表参道をoverride退避) |
| 10009 | B:ALL表参道 |
| 10010 | 代々木上原 |
