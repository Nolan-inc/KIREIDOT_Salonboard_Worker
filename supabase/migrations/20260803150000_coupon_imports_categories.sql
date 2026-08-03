-- クーポン取込にカテゴリ (SBのカット/カラー等チェックボックス) を追加。
-- worker が couponEdit ページから checked ラベルの配列を categories として送り、
-- RPC はキーが在るときだけ上書きする (詳細取得失敗時に既存値を消さない)。
alter table public.salonboard_coupon_imports
  add column if not exists categories jsonb;

create or replace function public.salonboard_bulk_upsert_coupons(p_shop_id uuid, p_rows jsonb)
 returns table(inserted integer, updated integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_inserted int := 0; v_updated int := 0; v_now timestamptz := now();
  r jsonb; v_external_id text; v_name text; v_existing_id uuid;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a jsonb array';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_external_id := nullif(trim(r->>'external_id'), '');
    v_name := nullif(trim(r->>'name'), '');
    if v_external_id is null or v_name is null then continue; end if;
    select id into v_existing_id from public.salonboard_coupon_imports
      where shop_id = p_shop_id and external_id = v_external_id limit 1;
    if v_existing_id is null then
      insert into public.salonboard_coupon_imports (
        shop_id, external_id, name, category, expires_label, photo_url, sort_no,
        price, duration_min, content, condition_label, use_condition, categories,
        is_active, is_published, raw, last_synced_at, created_at, updated_at
      ) values (
        p_shop_id, v_external_id, v_name, nullif(r->>'category',''),
        nullif(r->>'expires_label',''), nullif(r->>'photo_url',''),
        nullif(r->>'sort_no','')::int,
        nullif(r->>'price','')::int, nullif(r->>'duration_min','')::int,
        nullif(r->>'content',''), nullif(r->>'condition_label',''), nullif(r->>'use_condition',''),
        case when (r ? 'categories') and jsonb_typeof(r->'categories') = 'array' then r->'categories' else null end,
        coalesce((r->>'is_active')::boolean, true),
        coalesce((r->>'is_published')::boolean, true),
        case when (r ? 'raw') then r->'raw' else null end, v_now, v_now, v_now
      );
      v_inserted := v_inserted + 1;
    else
      update public.salonboard_coupon_imports
         set name = v_name, category = nullif(r->>'category',''),
             expires_label = nullif(r->>'expires_label',''),
             photo_url = nullif(r->>'photo_url',''),
             sort_no = case when (r ? 'sort_no') then nullif(r->>'sort_no','')::int else sort_no end,
             price = case when (r ? 'price') then nullif(r->>'price','')::int else price end,
             duration_min = case when (r ? 'duration_min') then nullif(r->>'duration_min','')::int else duration_min end,
             content = case when (r ? 'content') then nullif(r->>'content','') else content end,
             condition_label = case when (r ? 'condition_label') then nullif(r->>'condition_label','') else condition_label end,
             use_condition = case when (r ? 'use_condition') then nullif(r->>'use_condition','') else use_condition end,
             categories = case
               when (r ? 'categories') and jsonb_typeof(r->'categories') = 'array' then r->'categories'
               else categories
             end,
             is_active = coalesce((r->>'is_active')::boolean, is_active),
             is_published = case
               when r ? 'is_published' then coalesce((r->>'is_published')::boolean, is_published)
               else is_published
             end,
             last_synced_at = v_now, updated_at = v_now
       where id = v_existing_id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  inserted := v_inserted; updated := v_updated; return next;
end $function$;

notify pgrst, 'reload schema';
