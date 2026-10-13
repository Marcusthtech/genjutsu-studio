-- Security hardening (2026-10-13).

-- Clients only ever read their own rows; all writes go through edge functions / RPCs.
revoke all on public.profiles, public.payments, public.jobs from anon, authenticated;
grant select on public.profiles, public.payments, public.jobs to authenticated;

-- PayPal refunds / chargebacks take the order's credits back (never below zero).
alter table public.payments add column if not exists clawed_credits integer not null default 0;

create or replace function public.claw_payment(p_order_id text, p_target integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_prev integer; v_delta integer;
begin
  select user_id, clawed_credits into v_user, v_prev from payments
   where order_id = p_order_id and status = 'completed' for update;
  if v_user is null or p_target <= v_prev then return 0; end if;
  v_delta := p_target - v_prev;
  update payments set clawed_credits = p_target where order_id = p_order_id;
  update profiles set credits = greatest(credits - v_delta, 0) where user_id = v_user;
  return v_delta;
end $$;
revoke execute on function public.claw_payment(text, integer) from public, anon, authenticated;

-- Uploads (faces, source videos) are private; Higgsfield gets signed URLs. Only media, max 50 MB (project limit).
update storage.buckets set public = false, file_size_limit = 52428800,
  allowed_mime_types = array['video/mp4','video/quicktime','image/jpeg','image/png','image/webp']
 where id = 'inputs';

-- Trend scenes are public and read-only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('presets', 'presets', true, 52428800, array['video/mp4'])
on conflict (id) do nothing;
