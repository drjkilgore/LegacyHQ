-- ============================================================
-- HomegoingHQ — Migration v34: ADMIN DELETE USER
-- Adds an admin-only RPC to permanently delete a user account.
--   • Guarded: caller must be admin; cannot delete self; cannot delete another admin.
--   • Deletes estates the user CREATED first (estates.created_by has no cascade),
--     which cascades to that estate's tasks, documents, ledger, members, memories, etc.
--   • Then deletes the auth.users row; profiles + memberships + sms_subscriptions
--     cascade off auth.users / profiles automatically.
--   • Estates the user only JOINED as a member are NOT deleted — only their membership.
-- Note: files already uploaded to storage buckets are not removed by this RPC
--       (only their database rows). Orphaned storage files can be swept separately.
-- ============================================================

create or replace function public.admin_delete_user(target uuid)
returns json language plpgsql security definer set search_path = public as $$
declare est_deleted int := 0;
begin
  if not public.is_admin() then
    return json_build_object('error','not_admin');
  end if;
  if target = auth.uid() then
    return json_build_object('error','cannot_delete_self');
  end if;
  if exists (select 1 from public.admin_users where user_id = target) then
    return json_build_object('error','target_is_admin');
  end if;

  -- Estates this user created (cascades to all child rows of those estates).
  delete from public.estates where created_by = target;
  get diagnostics est_deleted = row_count;

  -- The login itself; profiles (and everything keyed to it) cascade from here.
  delete from auth.users where id = target;

  return json_build_object('ok', true, 'estates_deleted', est_deleted);
end $$;

grant execute on function public.admin_delete_user(uuid) to authenticated;
