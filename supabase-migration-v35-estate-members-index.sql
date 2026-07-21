-- ============================================================
-- HomegoingHQ — Migration v35: estate_members(user_id) index (scale)
-- Additive, safe to re-run.
--
-- Why: estate_members already has PRIMARY KEY (estate_id, user_id), which
-- indexes lookups that lead with estate_id (e.g. is_estate_member(estate_id)
-- checking a specific estate). It does NOT efficiently serve the reverse —
-- "every estate this user belongs to" (WHERE user_id = ...), which the app
-- runs on each workspace load and some RLS paths. On a large table that becomes
-- a sequential scan. This index makes that a direct lookup.
--
-- The composite (user_id, estate_id) also lets user-scoped membership checks be
-- answered from the index alone (covering index), avoiding heap fetches.
-- ============================================================

create index if not exists idx_estate_members_user
  on public.estate_members (user_id, estate_id);

-- Optional: if this table is already large and you want to avoid any write-lock
-- while it builds, run the CONCURRENTLY form instead of the line above — but note
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so execute it
-- on its own (not bundled with other statements):
--
--   create index concurrently if not exists idx_estate_members_user
--     on public.estate_members (user_id, estate_id);

analyze public.estate_members;
