-- A delayed worker callback must never reopen an already reconciled success.
-- Re-running a succeeded operation must be represented by a new job so that
-- the audit history and idempotency boundary remain unambiguous.
create or replace function public.salonboard_preserve_terminal_success()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if old.status = 'succeeded' and new.status <> 'succeeded' then
    new.status := 'succeeded';
    new.completed_at := old.completed_at;
    new.result := old.result;
    new.error := old.error;
    new.locked_at := null;
    new.locked_by := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_preserve_terminal_salonboard_success
  on public.salonboard_sync_jobs;
create trigger trg_preserve_terminal_salonboard_success
before update of status on public.salonboard_sync_jobs
for each row
execute function public.salonboard_preserve_terminal_success();
