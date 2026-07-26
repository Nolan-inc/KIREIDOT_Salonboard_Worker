# SalonBoard 書込3分SLA × CAPTCHA非回避 セッション設計

**目的**: 画像認証(CAPTCHA)を一切解かずに、予約書込の3分SLAをほぼ全リクエストで満たす。
CAPTCHAは「解く障害」ではなく「セッション健全性の欠陥」として、**出させない**設計で回避する。

## 計測結果 (2026-07-26 / 直近48h・書込ジョブ)

| 指標 | 値 | 含意 |
|---|---|---|
| claim待ち p50 | **4秒** | warmパスは健全。**スロット飽和なし** |
| claim待ち p90 | 296秒 | テールがSLAを割る |
| claim待ち p99 / max | 108分 / 10.5h | テールは災害的 |
| >3min 件数 | 90 / 656 (14%) | 代官山27・代々木25・新宿三丁目12・WAO11に集中 |
| 失敗の内訳 | login/captcha=1, session_death=3, pc_fallback_dead=4, form_unreachable=6 | 失敗総数は少・**大半はテール遅延** |

**結論**: throughput律速ではない(p50=4s)。テールは
(a) **レーンブロッキング**(1アカウント1セッション制約=同一アカウントの書込が、そのアカウントのセッション回復/長時間opの後ろで直列待ち) と
(b) **クールダウン先送り**(throttle時の手動/自動defer) が主因。
→ **worker増設(スループット目的)は的外れ。レバーはセッション継続性に100%。**

## 真因: デプロイがセッションを壊す

- 現デプロイ(`.github/workflows/deploy-worker.yml`): worker.cjsを差替え後 **`docker restart sb-worker-cloud`**。
- restartは**実行中ジョブ/ブラウザを即kill** → `Target page, context or browser has been closed`(=session_death) → PCフォールバック(死んでいる)→ SLA割れ。
- 短時間の**連続restart**(今日=5回)→ 各restartが再ログインを誘発 → 複数アカウントの再ログインがバースト → **Akamaiが画像認証を差し込む**。今日のCAPTCHAの直接原因。

## 地雷: セッションが非永続

- コンテナのbind-mountは `worker.cjs` のみ。**`.kireidot`(storageState/Chromeプロファイル)はコンテナ書込レイヤ**。
- `docker restart` では消えないが、**`docker rm`→`run`(イメージ更新・インスタンス入替)で全消失** → 全店cold login → CAPTCHA大量発生。

## SBの制約(設計の土台)

- **1アカウント=同時1セッション**。2本目にログインした瞬間に1本目が失効。
  → **warmセッションを2本並列に生かすことは不可能**。
- セッションはIP指紋に紐付く。**IPローテはセッション破壊**(既知の実障害)。書込はISP固定sticky必須。

## 設計 (フェーズ順・効果対効果順)

### Phase 0: セッション永続化(地雷除去・オフピークに1回)
- `.kireidot` をホストの**bind-mount/named volume**へ。以後コンテナ再作成でもセッション不滅。
- 実施は**1回だけコンテナ再作成が要る=1回のセッション消失**を伴うため、**静穏帯(深夜)に人の見守りで**実施。

### Phase 1: graceful-drain デプロイ(真因根絶)
- `docker restart`(hard kill)を廃止。worker が **SIGTERM** を受けたら:
  1. 新規claim停止、2. 実行中ジョブを上限付きで完走、3. storageState保存、4. exit。
- デプロイは `docker stop --time=120`(SIGTERM→猶予)→ コード差替 → `docker start`。
- 実行中killが消える=session_death/PCフォールバック連鎖が消える。再ログインバースト激減。
- ⚠️このPRのマージ自体がデプロイ=restartを1回起こすので、**静穏帯にマージ**。

### Phase 2: keepalive ループ(cold失効を防ぐ)
- 既存の「セッション延命」関数(worker-process.cjs `1店舗のセッションを延命…`)を**背景ループ/cron化**し、各アカウントを N分おきに無害アクセス+storageState再保存。
- 予約リクエスト経路では二度とログインしない=CAPTCHAの登場機会を消す。

### Phase 3: 1アカウント2 IP(主+クリーン予備・逐次)
- 主=ISP固定sticky。**予備=別のクリーンなISP/residential**。
- 用途は**逐次のみ**: 主セッションの死亡を確認してからの(稀な)cold loginを、**まだフラグられていない予備IP**から通す=画像認証を出させない。並列使用は1-session制約で厳禁。
- **容量**: Decodo健全IP ~10-20。10店×2=20本で天井 → プール拡張とセットで確認。

### Phase 4: worker #2 は throughput律速になった時だけ
- 現状p50=4sなので**不要**。将来スロット待ちが支配的になったら、**アカウント分割(店舗アフィニティ固定)**で追加。同一アカウントを2台に触らせるのは1-session制約で自殺行為=禁止。

## 実施順と安全ガード

1. (今) 本設計コミット + Phase 1 の graceful-drain を**PRとして用意**(マージは静穏帯)。
2. 静穏帯: Phase 0(volume化)→ Phase 1(drain deploy)を続けて実施。
3. Phase 2 keepalive を有効化し、cold login頻度を計測で確認。
4. Phase 3 予備IPを付与(Decodoプール確認後)。
5. throughput律速が観測されたら初めて Phase 4。

**タイミング原則**: throttle/CAPTCHAが出ている間はデプロイ(=restart)禁止。攻めずに冷却が最速復旧(既知の教訓)。
