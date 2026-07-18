-- HomegoingHQ — Migration v25: admin-side co-brand partner provisioning
-- Lets an admin onboard a funeral home or church in one step from the admin
-- panel. Wraps the existing provision_concierge_account (unchanged) and sets the
-- admin-chosen subdomain. tenant_type drives the co-brand attribution; the v24
-- trigger forces the unlimited family cap. The owner must already have a
-- HomegoingHQ account (a profiles row) with the given email.
-- Idempotent.

create or replace function public.admin_provision_partner(
  p_owner_email text,
  p_tenant_type text,
  p_business    text,
  p_subdomain   text
) returns json language plpgsql security definer set search_path = public as $$
declare uid uuid; clean text; res json; aid uuid;
begin
  if not public.is_admin() then
    return json_build_object('error','forbidden');
  end if;
  if coalesce(p_tenant_type,'') not in ('funeral_home','church') then
    p_tenant_type := 'funeral_home';
  end if;

  -- The owner must already have a HomegoingHQ account (they sign up first).
  select id into uid from public.profiles
   where lower(email) = lower(coalesce(p_owner_email,'')) limit 1;
  if uid is null then
    return json_build_object('error','no_such_user');
  end if;

  clean := nullif(lower(regexp_replace(coalesce(p_subdomain,''), '[^a-z0-9-]', '', 'g')), '');
  if clean is not null and length(clean) < 3 then
    return json_build_object('error','subdomain_too_short');
  end if;
  if clean is not null and exists (
       select 1 from public.concierge_accounts
        where lower(subdomain) = clean and owner_user_id <> uid) then
    return json_build_object('error','subdomain_taken');
  end if;

  -- Reuse the existing provisioning path. Tier is a placeholder for co-brand
  -- partners (the v24 trigger overrides estate_limit to unlimited regardless).
  res := public.provision_concierge_account(uid, 'professional', p_business, clean, null, p_tenant_type);

  -- provision_concierge_account only sets the subdomain on first insert; force
  -- the admin's chosen value so re-provisioning or a subdomain change sticks.
  if clean is not null then
    update public.concierge_accounts
       set subdomain = clean, updated_at = now()
     where owner_user_id = uid;
  end if;

  select id into aid from public.concierge_accounts where owner_user_id = uid limit 1;
  return json_build_object('ok', true, 'account_id', aid, 'detail', res);
end $$;

grant execute on function public.admin_provision_partner(text,text,text,text) to authenticated;

-- Verify (optional):
-- select public.admin_provision_partner('director@example.com','funeral_home','Grace Funeral Home','grace-funeral');
