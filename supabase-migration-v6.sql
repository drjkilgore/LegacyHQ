-- ============================================================
-- LegacyHQ — Migration v6: ADMIN CONSOLE
-- Run as admin ("Run without RLS"). Additive only.
-- ============================================================

-- Who is an admin (you). Managed only via SQL — deliberately not via the app.
create table public.admin_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
create policy "admins read admin list" on public.admin_users
  for select using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

-- ---------- Admin RPCs (every one checks is_admin first) ----------
create or replace function public.admin_stats()
returns json language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  return json_build_object(
    'users',        (select count(*) from public.profiles),
    'users_7d',     (select count(*) from public.profiles where created_at > now()-interval '7 days'),
    'estates',      (select count(*) from public.estates),
    'plans',        (select count(*) from public.plans),
    'paid_users',   (select count(*) from public.profiles where plan_tier <> 'free'),
    'tasks_done',   (select count(*) from public.tasks where status='done'),
    'memorials_live',(select count(*) from public.memorial_settings where enabled=true)
  );
end $$;

create or replace function public.admin_list_users(search text default '')
returns json language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  return (select coalesce(json_agg(row_to_json(u)),'[]'::json) from (
    select p.id, p.email, p.full_name, p.plan_tier, p.created_at,
      (select count(*) from public.estate_members m where m.user_id=p.id) as estates,
      (select count(*) from public.plan_members m where m.user_id=p.id) as plans
    from public.profiles p
    where search = '' or p.email ilike '%'||search||'%' or p.full_name ilike '%'||search||'%'
    order by p.created_at desc limit 100
  ) u);
end $$;

create or replace function public.admin_set_tier(target uuid, new_tier text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return false; end if;
  if new_tier not in ('free','settle','premium') then return false; end if;
  update public.profiles set plan_tier = new_tier where id = target;
  return found;
end $$;

create or replace function public.admin_recent_activity()
returns json language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  return (select coalesce(json_agg(row_to_json(a)),'[]'::json) from (
    select al.action, al.detail, al.created_at, p.email, e.decedent_name
    from public.activity_log al
    left join public.profiles p on p.id = al.user_id
    left join public.estates e on e.id = al.estate_id
    order by al.created_at desc limit 50
  ) a);
end $$;

-- ============================================================
-- MAKE YOURSELF ADMIN — edit the email, run this once:
--
--   insert into public.admin_users (user_id)
--   select id from public.profiles where email = 'drjkilgore@gmail.com'
--   on conflict do nothing;
-- ============================================================
