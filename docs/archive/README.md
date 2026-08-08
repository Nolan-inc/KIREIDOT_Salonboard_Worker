# archive — 歴史的資料(現行仕様ではない)

このディレクトリの文書は**当時の検討記録**であり、現在の構成とは異なります。現行仕様は `docs/` 直下を参照してください。

| ファイル | 当時 | 現在との差 |
|---|---|---|
| `aws-migration.md` | 2026-06 | Fargate移行の設計。実際は**EC2 + Docker**構成になったため未採用。3段フォールバックの考え方だけは現行に引き継がれている |
| `v0.3.0-plan.md` | 2026-06 | 予約同期くんの当時の計画 |
| `openclaw-integration-plan.md` | 2026-06 | OpenClaw連携の検討 |
| `multitenant-worker-flow.html` / `.pdf` | 2026-06-20 | マルチテナントworkerのフロー図。レーン分割前の構成 |

現行の資料:

- 全体構成: [../system-architecture.md](../system-architecture.md) / [../infra-architecture.png](../infra-architecture.png)
- 運用・障害対応: [../operations.md](../operations.md)
- 新店舗追加: [../shop-onboarding.md](../shop-onboarding.md)
- SB固有仕様: [../salonboard-quirks.md](../salonboard-quirks.md)
- 監視・通知: [../monitoring.md](../monitoring.md)
