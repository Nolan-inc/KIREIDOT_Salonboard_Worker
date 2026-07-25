-- This function is invoked only by a database trigger. It must not be exposed
-- as an anonymous/authenticated PostgREST RPC.

revoke all on function public.salonboard_prevent_terminal_timeout_failure()
  from public;
revoke all on function public.salonboard_prevent_terminal_timeout_failure()
  from anon;
revoke all on function public.salonboard_prevent_terminal_timeout_failure()
  from authenticated;
