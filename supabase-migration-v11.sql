-- ============================================================
-- HomegoingHQ — Migration v11: FREE-TIER METERING
-- Run AFTER v1–v10 as admin ("Run without RLS"). Additive only.
-- ============================================================
alter table public.profiles add column if not exists ai_uses integer not null default 0;

-- Increments the caller's AI usage counter and returns the new total.
create or replace function public.increment_ai_use()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.profiles set ai_uses = ai_uses + 1
   where id = auth.uid()
   returning ai_uses into n;
  return coalesce(n, 0);
end $$;
