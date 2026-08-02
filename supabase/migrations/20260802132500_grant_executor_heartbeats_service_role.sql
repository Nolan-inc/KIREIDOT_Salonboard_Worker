-- salonboard_executor_heartbeats は 20260802130000 の apply_migration 実行ロール
-- (postgres) にしかGRANTが付与されず、Admin API (service_role/PostgREST) の
-- heartbeat upsert が permission denied で黙って失敗していた (エラーはclaim継続の
-- ためswallowする設計のため無症状)。結果 salonboard_fallback_available() が
-- 常にfalseでFB移管が発動しなかった。service_roleへ明示GRANTして解決。
-- 本番適用済み (apply_migration grant_executor_heartbeats_service_role)。
grant select, insert, update, delete on public.salonboard_executor_heartbeats to service_role;
NOTIFY pgrst, 'reload schema';
