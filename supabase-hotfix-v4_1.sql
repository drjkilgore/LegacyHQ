-- ============================================================
-- LegacyHQ — HOTFIX v4.1: estate/plan creation failing silently
-- Run the whole file in Supabase SQL Editor ("Run without RLS" / as admin).
-- Safe to run more than once.
-- ============================================================

-- 1) FIX: creators must be able to see their own estates/plans,
--    otherwise the membership self-insert policy can never pass.
drop policy if exists "members read estates" on public.estates;
create policy "members read estates" on public.estates
  for select using (public.is_estate_member(id) or created_by = auth.uid());

drop policy if exists "members read plans" on public.plans;
create policy "members read plans" on public.plans
  for select using (public.is_plan_member(id) or created_by = auth.uid());

-- 2) CLEANUP: remove half-created estates/plans from failed attempts
--    (an estate with no tasks and no members was a failed wizard run).
delete from public.estates e
 where not exists (select 1 from public.tasks t where t.estate_id = e.id)
   and not exists (select 1 from public.estate_members m where m.estate_id = e.id);

delete from public.plans p
 where not exists (select 1 from public.plan_entries pe where pe.plan_id = p.id)
   and not exists (select 1 from public.plan_members m where m.plan_id = p.id);

-- 3) REPAIR: any surviving estate/plan whose creator lost membership
--    gets its owner membership restored.
insert into public.estate_members (estate_id, user_id, role)
select id, created_by, 'owner' from public.estates
on conflict do nothing;

insert into public.plan_members (plan_id, user_id, role)
select id, created_by, 'owner' from public.plans
on conflict do nothing;
