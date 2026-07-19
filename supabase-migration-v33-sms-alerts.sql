-- HomegoingHQ — Migration v33: SMS deadline reminders.
--  sms_subscriptions: a family member's explicit opt-in (phone + consent) per estate.
--  sms_sent_log: one reminder per task per user (dedupe; service-role only).

create table if not exists public.sms_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  estate_id  uuid not null references public.estates(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  phone      text not null,                       -- E.164, e.g. +13135550100
  consent    boolean not null default false,      -- explicit in-app opt-in
  opted_out  boolean not null default false,      -- set by STOP or "turn off"
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (estate_id, user_id)
);
alter table public.sms_subscriptions enable row level security;
grant select, insert, update on public.sms_subscriptions to authenticated;

-- Members manage only their OWN subscription, and only for estates they belong to.
drop policy if exists sms_own_read on public.sms_subscriptions;
create policy sms_own_read on public.sms_subscriptions for select
  using (user_id = auth.uid() and public.is_estate_member(estate_id));
drop policy if exists sms_own_insert on public.sms_subscriptions;
create policy sms_own_insert on public.sms_subscriptions for insert
  with check (user_id = auth.uid() and public.is_estate_member(estate_id));
drop policy if exists sms_own_update on public.sms_subscriptions;
create policy sms_own_update on public.sms_subscriptions for update
  using (user_id = auth.uid() and public.is_estate_member(estate_id));

-- Dedupe: at most one reminder per task per user. Written by the scheduler
-- (service role) only — no grants to authenticated, so RLS blocks all client access.
create table if not exists public.sms_sent_log (
  id       uuid primary key default gen_random_uuid(),
  task_id  uuid not null references public.tasks(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  sent_at  timestamptz not null default now(),
  unique (task_id, user_id)
);
alter table public.sms_sent_log enable row level security;
