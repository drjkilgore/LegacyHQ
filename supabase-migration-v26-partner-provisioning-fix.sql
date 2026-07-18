-- HomegoingHQ — Migration v26: harden admin_provision_partner
-- Fixes two problems found in testing:
--   1) provision_concierge_account only sets tenant_type when it CREATES a row,
--      not when it updates one — so provisioning a church onto an email that
--      already had a concierge account left tenant_type = 'concierge' (wrong pill,
--      wrong 100 cap instead of unlimited).
--   2) One login = one white-label account. Reusing an email that already owns a
--      DIFFERENT-type account silently overwrote it. Now we refuse with a clear
--      error instead of clobbering, and we force tenant_type + unlimited on the
--      accounts we do provision.
-- Idempotent.

create or replace function public.admin_provision_partner(
  p_owner_email text,
  p_tenant_type text,
  p_business    text,
  p_subdomain   text
) returns json language plpgsql security definer set search_path = public as $$
declare uid uuid; clean text; existing record; aid uuid;
begin
  if not public.is_admin() then
    return json_build_object('error','forbidden');
  end if;
  if coalesce(p_tenant_type,'') not in ('funeral_home','church') then
    p_tenant_type := 'funeral_home';
  end if;

  select id into uid from public.profiles
   where lower(email) = lower(coalesce(p_owner_email,'')) limit 1;
  if uid is null then
    return json_build_object('error','no_such_user');
  end if;

  -- One white-label account per login. If this owner already has an account of a
  -- DIFFERENT type, refuse rather than overwrite it.
  select id, tenant_type, business_name into existing
    from public.concierge_accounts where owner_user_id = uid limit 1;
  if existing.id is not null and existing.tenant_type is distinct from p_tenant_type then
    return json_build_object('error','owner_has_other_account',
      'existing_type', existing.tenant_type, 'existing_business', existing.business_name);
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

  -- Create or refresh the account, then FORCE the co-brand type + unlimited cap +
  -- subdomain (provision's UPDATE path doesn't set tenant_type, so we set it here).
  perform public.provision_concierge_account(uid, 'professional', p_business, clean, null, p_tenant_type);

  update public.concierge_accounts
     set tenant_type   = p_tenant_type,
         estate_limit  = 1000000000,
         business_name = coalesce(nullif(p_business,''), business_name),
         subdomain     = coalesce(clean, subdomain),
         updated_at    = now()
   where owner_user_id = uid;

  select id into aid from public.concierge_accounts where owner_user_id = uid limit 1;
  return json_build_object('ok', true, 'account_id', aid);
end $$;

grant execute on function public.admin_provision_partner(text,text,text,text) to authenticated;
