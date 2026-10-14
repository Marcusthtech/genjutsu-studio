-- Security re-review fixes (2026-10-14).

-- Keep-alive: anon can no longer read tables, so give the scheduled ping one harmless view.
create or replace view public.keepalive as select 1 as ok;
grant select on public.keepalive to anon;

-- A refund or chargeback after the credits were spent leaves the balance negative (a debt),
-- so spend_credits refuses new renders until the user buys enough to cover it.
alter table public.profiles drop constraint if exists profiles_credits_check;

create or replace function public.claw_payment(p_order_id text, p_target integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_prev integer; v_delta integer;
begin
  select user_id, clawed_credits into v_user, v_prev from payments
   where order_id = p_order_id and status = 'completed' for update;
  if v_user is null or p_target <= v_prev then return 0; end if;
  v_delta := p_target - v_prev;
  update payments set clawed_credits = p_target where order_id = p_order_id;
  update profiles set credits = credits - v_delta where user_id = v_user;
  return v_delta;
end $$;
revoke execute on function public.claw_payment(text, integer) from public, anon, authenticated;

-- Seconds the job was priced at, so the finished render's length can be checked against it.
alter table public.jobs add column if not exists billed_secs integer;
