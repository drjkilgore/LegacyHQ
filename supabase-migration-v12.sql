-- ============================================================
-- HomegoingHQ — Migration v12: COMPANION TIER
-- Run AFTER v1–v11 as admin ("Run without RLS").
-- ============================================================
-- Allow the new tier in the admin tier-setter.
create or replace function public.admin_set_tier(target uuid, new_tier text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return false; end if;
  if new_tier not in ('free','companion','settle','premium') then return false; end if;
  update public.profiles set plan_tier = new_tier where id = target;
  return found;
end $$;
