-- 【緊急復旧】claim RPC のオーバーロード曖昧化を解消する。
--
-- 事故 (2026-08-09 15:49 UTC〜約14分): shard対応で p_shard 付き6引数版を
-- CREATE OR REPLACE したが、引数リストが異なるため旧5引数版が別関数として残存。
-- PostgREST は同名関数の候補を1つに絞れず全 claim が 500 になり、
-- 全ワーカー(4箱)のジョブ取得が停止した。
--   {"error":"Could not choose the best candidate function between: ..."}
--
-- ⚠️ 教訓: PostgREST 経由の RPC は「引数DEFAULTによる後方互換」が成立しない。
--    PostgreSQL 単体なら DEFAULT で解決できるが、PostgREST は候補を絞れず 500 を返す。
--    シグネチャを増やす変更では、必ず旧シグネチャを同一migrationでDROPすること。
--    (6引数版が p_shard integer DEFAULT NULL を持つため、旧呼び出し形式のままでも動く)
drop function if exists public.salonboard_claim_next_job(text, integer, integer, text, text);

notify pgrst, 'reload schema';
