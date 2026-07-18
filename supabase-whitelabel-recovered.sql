-- HomegoingHQ — White-label foundation (RECOVERY)
-- =====================================================================
-- These objects were created directly in Supabase (the original v13–v15
-- migrations were never saved to the repo). This file restores the whole
-- white-label / concierge / funeral-home / church foundation into Git:
-- tables, functions, AND row-level security policies.
--
-- EXACT:      every function is a verbatim pg_get_functiondef() dump, and every
--             RLS policy is verbatim from pg_policies — safe to re-run.
-- INFERRED:   table PRIMARY KEYs, FOREIGN KEYs, and the subdomain UNIQUE were
--             reconstructed from column metadata + how the code uses them.
-- For a byte-perfect disaster-recovery artifact, also keep a
--   pg_dump --schema-only  backup (Supabase → Database → Connection string).
-- Idempotent: `if not exists` on tables, `create or replace` on functions,
-- `drop policy if exists` before each policy, body validation disabled.
-- =====================================================================

set check_function_bodies = off;

create extension if not exists pg_trgm;

-- ---------- WHITE-LABEL TABLES (columns/defaults exact; keys inferred) ----------
create table if not exists public.concierge_accounts (
  id                     uuid primary key default gen_random_uuid(),
  owner_user_id          uuid not null references public.profiles(id) on delete cascade,
  tenant_type            text not null default 'concierge',   -- concierge | funeral_home | church
  business_name          text not null,
  tier                   text not null default 'starter',
  status                 text not null default 'active',
  estate_limit           integer not null default 25,
  storage_bytes_used     bigint not null default 0,
  ai_tokens_used         bigint not null default 0,
  subdomain              text unique,
  custom_domain          text,
  stripe_subscription_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table if not exists public.tenant_branding (
  account_id        uuid primary key references public.concierge_accounts(id) on delete cascade,
  logo_url          text,
  favicon_url       text,
  hero_url          text,
  color_ink         text default '#26332E',
  color_accent      text default '#8F6A24',
  color_accent_deep text default '#75561D',
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  footer_note       text,
  updated_at        timestamptz not null default now()
);

create table if not exists public.concierge_pending_provisions (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  tier          text not null,
  tenant_type   text not null default 'concierge',
  business_name text,
  paythen_ref   text,
  claimed       boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------- WHITE-LABEL FUNCTIONS (verbatim from the live database) ----------

-- === function: account_active_estates ===
CREATE OR REPLACE FUNCTION public.account_active_estates(a uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::int from public.estates where account_id = a and status = 'active';
$function$;

-- === function: account_add_usage ===
CREATE OR REPLACE FUNCTION public.account_add_usage(a uuid, storage_delta bigint, ai_delta bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.concierge_accounts
    set storage_bytes_used = greatest(0, storage_bytes_used + coalesce(storage_delta,0)),
        ai_tokens_used     = greatest(0, ai_tokens_used     + coalesce(ai_delta,0)),
        updated_at = now()
  where id = a;
$function$;

-- === function: admin_list_accounts ===
CREATE OR REPLACE FUNCTION public.admin_list_accounts(search text DEFAULT ''::text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  return (select coalesce(json_agg(row_to_json(x)),'[]'::json) from (
    select ca.id, ca.business_name, ca.tenant_type, ca.tier, ca.status,
           ca.estate_limit, ca.storage_bytes_used, ca.ai_tokens_used,
           ca.subdomain, ca.custom_domain, ca.created_at,
           p.email as owner_email,
           public.account_active_estates(ca.id) as estates_used
    from public.concierge_accounts ca
    join public.profiles p on p.id = ca.owner_user_id
    where search = '' or ca.business_name ilike '%'||search||'%' or p.email ilike '%'||search||'%'
    order by ca.created_at desc limit 200
  ) x);
end $function$;

-- === function: admin_set_account_status ===
CREATE OR REPLACE FUNCTION public.admin_set_account_status(target uuid, new_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then return false; end if;
  if new_status not in ('active','past_due','suspended','canceled') then return false; end if;
  update public.concierge_accounts set status = new_status, updated_at = now() where id = target;
  return found;
end $function$;

-- === function: admin_set_account_tier ===
CREATE OR REPLACE FUNCTION public.admin_set_account_tier(target uuid, new_tier text, reset_limit boolean DEFAULT true)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then return false; end if;
  if new_tier not in ('starter','professional','enterprise','agency') then return false; end if;
  update public.concierge_accounts
    set tier = new_tier,
        estate_limit = case when reset_limit then public.default_estate_limit(new_tier) else estate_limit end,
        updated_at = now()
  where id = target;
  return found;
end $function$;

-- === function: admin_set_custom_domain ===
CREATE OR REPLACE FUNCTION public.admin_set_custom_domain(target uuid, domain text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare clean text;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  clean := nullif(lower(regexp_replace(coalesce(domain,''), '[^a-z0-9.-]', '', 'g')), '');
  if clean is not null and exists (select 1 from public.concierge_accounts where lower(custom_domain)=clean and id<>target) then
    return json_build_object('error','taken'); end if;
  update public.concierge_accounts set custom_domain = clean, updated_at = now() where id = target;
  return json_build_object('ok', true, 'custom_domain', clean);
end $function$;

-- === function: admin_set_estate_limit ===
CREATE OR REPLACE FUNCTION public.admin_set_estate_limit(target uuid, new_limit integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then return false; end if;
  if new_limit < 0 then return false; end if;
  update public.concierge_accounts set estate_limit = new_limit, updated_at = now() where id = target;
  return found;
end $function$;

-- === function: admin_upsert_branding ===
CREATE OR REPLACE FUNCTION public.admin_upsert_branding(target uuid, p_logo text, p_favicon text, p_hero text, p_ink text, p_accent text, p_accent_deep text, p_cname text, p_cemail text, p_cphone text, p_footer text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  insert into public.tenant_branding(account_id, logo_url, favicon_url, hero_url,
      color_ink, color_accent, color_accent_deep, contact_name, contact_email, contact_phone, footer_note, updated_at)
    values (target, p_logo, p_favicon, p_hero, coalesce(p_ink,'#26332E'),
      coalesce(p_accent,'#8F6A24'), coalesce(p_accent_deep,'#75561D'),
      p_cname, p_cemail, p_cphone, p_footer, now())
  on conflict (account_id) do update set
      logo_url=excluded.logo_url, favicon_url=excluded.favicon_url, hero_url=excluded.hero_url,
      color_ink=excluded.color_ink, color_accent=excluded.color_accent, color_accent_deep=excluded.color_accent_deep,
      contact_name=excluded.contact_name, contact_email=excluded.contact_email,
      contact_phone=excluded.contact_phone, footer_note=excluded.footer_note, updated_at=now();
  return json_build_object('ok', true);
end $function$;

-- === function: assign_estate_to_account ===
CREATE OR REPLACE FUNCTION public.assign_estate_to_account(p_estate uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare aid uuid;
begin
  select id into aid from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
  if aid is null then return json_build_object('error','no_account'); end if;
  if not public.is_estate_owner(p_estate) then return json_build_object('error','not_estate_owner'); end if;
  if public.account_active_estates(aid)
       >= (select estate_limit from public.concierge_accounts where id = aid) then
    return json_build_object('error','limit_reached');
  end if;
  update public.estates set account_id = aid where id = p_estate;
  return json_build_object('ok', true);
end $function$;

-- === function: claim_my_provision ===
CREATE OR REPLACE FUNCTION public.claim_my_provision()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare myemail text; pend record;
begin
  select email into myemail from public.profiles where id = auth.uid();
  if myemail is null then return json_build_object('claimed', false); end if;

  select * into pend from public.concierge_pending_provisions
    where lower(email) = lower(myemail) and claimed = false
    order by created_at desc limit 1;
  if pend.id is null then return json_build_object('claimed', false); end if;

  perform public.provision_concierge_account(auth.uid(), pend.tier, pend.business_name, null, pend.paythen_ref, pend.tenant_type);
  update public.concierge_pending_provisions set claimed = true where id = pend.id;
  return json_build_object('claimed', true, 'tier', pend.tier);
end $function$;

-- === function: is_account_owner ===
CREATE OR REPLACE FUNCTION public.is_account_owner(a uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.concierge_accounts
                 where id = a and owner_user_id = auth.uid());
$function$;

-- === function: list_preferred_providers ===
CREATE OR REPLACE FUNCTION public.list_preferred_providers()
 RETURNS TABLE(business_name text, category text, services_offered text, service_area text, phone text, website text, business_description text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select business_name, category, services_offered, service_area, phone, website, business_description
  from public.provider_applications
  where published = true and status = 'approved' and kind = 'provider'
  order by business_name;
$function$;

-- === function: my_account ===
CREATE OR REPLACE FUNCTION public.my_account()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record;
begin
  select ca.*, tb.logo_url, tb.favicon_url, tb.hero_url,
         tb.color_ink, tb.color_accent, tb.color_accent_deep,
         tb.contact_name, tb.contact_email, tb.contact_phone, tb.footer_note
    into a
  from public.concierge_accounts ca
  left join public.tenant_branding tb on tb.account_id = ca.id
  where ca.owner_user_id = auth.uid() limit 1;
  if a.id is null then return json_build_object('found', false); end if;
  return json_build_object(
    'found', true, 'id', a.id, 'business_name', a.business_name,
    'tier', a.tier, 'status', a.status, 'estate_limit', a.estate_limit,
    'estates_used', public.account_active_estates(a.id),
    'storage_bytes_used', a.storage_bytes_used, 'ai_tokens_used', a.ai_tokens_used,
    'subdomain', a.subdomain, 'custom_domain', a.custom_domain, 'tenant_type', a.tenant_type,
    'branding', json_build_object(
      'logo_url', a.logo_url, 'favicon_url', a.favicon_url, 'hero_url', a.hero_url,
      'color_ink', a.color_ink, 'color_accent', a.color_accent, 'color_accent_deep', a.color_accent_deep,
      'contact_name', a.contact_name, 'contact_email', a.contact_email,
      'contact_phone', a.contact_phone, 'footer_note', a.footer_note)
  );
end $function$;

-- === function: my_account_id ===
CREATE OR REPLACE FUNCTION public.my_account_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
$function$;

-- === function: owner_set_business ===
CREATE OR REPLACE FUNCTION public.owner_set_business(p_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare aid uuid;
begin
  select id into aid from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
  if aid is null then return json_build_object('error','no_account'); end if;
  if coalesce(trim(p_name),'') = '' then return json_build_object('error','empty'); end if;
  update public.concierge_accounts set business_name = trim(p_name), updated_at = now() where id = aid;
  return json_build_object('ok', true);
end $function$;

-- === function: owner_set_subdomain ===
CREATE OR REPLACE FUNCTION public.owner_set_subdomain(p_sub text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare aid uuid; clean text;
begin
  select id into aid from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
  if aid is null then return json_build_object('error','no_account'); end if;
  clean := lower(regexp_replace(coalesce(p_sub,''), '[^a-z0-9-]', '', 'g'));
  if length(clean) < 3 then return json_build_object('error','too_short'); end if;
  if exists (select 1 from public.concierge_accounts where lower(subdomain)=clean and id<>aid) then
    return json_build_object('error','taken'); end if;
  update public.concierge_accounts set subdomain = clean, updated_at = now() where id = aid;
  return json_build_object('ok', true, 'subdomain', clean);
end $function$;

-- === function: owner_update_branding ===
CREATE OR REPLACE FUNCTION public.owner_update_branding(p_logo text, p_favicon text, p_hero text, p_ink text, p_accent text, p_accent_deep text, p_cname text, p_cemail text, p_cphone text, p_footer text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare aid uuid;
begin
  select id into aid from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
  if aid is null then return json_build_object('error','no_account'); end if;
  insert into public.tenant_branding(account_id, logo_url, favicon_url, hero_url,
      color_ink, color_accent, color_accent_deep, contact_name, contact_email, contact_phone, footer_note, updated_at)
    values (aid, p_logo, p_favicon, p_hero, coalesce(p_ink,'#26332E'),
      coalesce(p_accent,'#8F6A24'), coalesce(p_accent_deep,'#75561D'),
      p_cname, p_cemail, p_cphone, p_footer, now())
  on conflict (account_id) do update set
      logo_url=excluded.logo_url, favicon_url=excluded.favicon_url, hero_url=excluded.hero_url,
      color_ink=excluded.color_ink, color_accent=excluded.color_accent, color_accent_deep=excluded.color_accent_deep,
      contact_name=excluded.contact_name, contact_email=excluded.contact_email,
      contact_phone=excluded.contact_phone, footer_note=excluded.footer_note, updated_at=now();
  return json_build_object('ok', true);
end $function$;

-- === function: owns_asset_folder ===
CREATE OR REPLACE FUNCTION public.owns_asset_folder(objname text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare fid text;
begin
  fid := split_part(objname, '/', 1);
  if fid !~ '^[0-9a-fA-F-]{36}$' then return false; end if;   -- must look like a uuid
  return public.is_account_owner(fid::uuid);
end $function$;

-- === function: provision_by_email ===
CREATE OR REPLACE FUNCTION public.provision_by_email(p_email text, p_tier text, p_business text, p_ref text, p_tenant_type text DEFAULT 'concierge'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid; res json;
begin
  if coalesce(p_email,'') = '' then return json_build_object('error','no_email'); end if;
  if p_tier not in ('starter','professional','enterprise','agency') then p_tier := 'starter'; end if;

  select id into uid from public.profiles where lower(email) = lower(p_email) limit 1;
  if uid is not null then
    res := public.provision_concierge_account(uid, p_tier, p_business, null, p_ref, p_tenant_type);
    return json_build_object('ok', true, 'mode', 'provisioned', 'detail', res);
  end if;

  if exists (select 1 from public.concierge_pending_provisions where lower(email)=lower(p_email) and claimed=false) then
    update public.concierge_pending_provisions
      set tier = p_tier,
          business_name = coalesce(p_business, business_name),
          paythen_ref = coalesce(p_ref, paythen_ref),
          tenant_type = coalesce(p_tenant_type, tenant_type)
      where lower(email)=lower(p_email) and claimed=false;
  else
    insert into public.concierge_pending_provisions(email, tier, tenant_type, business_name, paythen_ref)
      values (lower(p_email), p_tier, coalesce(p_tenant_type,'concierge'), p_business, p_ref);
  end if;
  return json_build_object('ok', true, 'mode', 'pending');
end $function$;

-- === function: provision_concierge_account ===
CREATE OR REPLACE FUNCTION public.provision_concierge_account(p_owner uuid, p_tier text, p_business text, p_subdomain text, p_stripe_sub text, p_tenant_type text DEFAULT 'concierge'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare aid uuid; clean_sub text;
begin
  if p_owner is null then return json_build_object('error','no_owner'); end if;
  if p_tier not in ('starter','professional','enterprise','agency') then p_tier := 'starter'; end if;

  select id into aid from public.concierge_accounts where owner_user_id = p_owner limit 1;

  clean_sub := nullif(lower(regexp_replace(coalesce(p_subdomain,''), '[^a-z0-9-]', '', 'g')), '');
  if clean_sub is not null and exists
     (select 1 from public.concierge_accounts where lower(subdomain)=clean_sub and (aid is null or id<>aid)) then
    clean_sub := clean_sub || '-' || substr(md5(random()::text),1,4);
  end if;

  if aid is null then
    insert into public.concierge_accounts(owner_user_id, tenant_type, business_name, tier, status,
        estate_limit, subdomain, stripe_subscription_id)
      values (p_owner, coalesce(p_tenant_type,'concierge'), coalesce(nullif(p_business,''),'My Practice'),
        p_tier, 'active', public.default_estate_limit(p_tier), clean_sub, p_stripe_sub)
      returning id into aid;
    insert into public.tenant_branding(account_id) values (aid) on conflict do nothing;
  else
    update public.concierge_accounts
      set tier = p_tier, status = 'active',
          estate_limit = public.default_estate_limit(p_tier),
          business_name = coalesce(nullif(p_business,''), business_name),
          subdomain = coalesce(subdomain, clean_sub),
          stripe_subscription_id = coalesce(p_stripe_sub, stripe_subscription_id),
          updated_at = now()
    where id = aid;
  end if;
  return json_build_object('ok', true, 'account_id', aid);
end $function$;

-- === function: public_branding ===
CREATE OR REPLACE FUNCTION public.public_branding(host text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record; sub text;
begin
  host := lower(coalesce(host,''));
  sub  := split_part(host, '.', 1);
  select ca.id, ca.business_name, ca.tier, ca.tenant_type, ca.status,
         tb.logo_url, tb.favicon_url, tb.hero_url,
         tb.color_ink, tb.color_accent, tb.color_accent_deep,
         tb.contact_name, tb.contact_email, tb.contact_phone, tb.footer_note
    into a
  from public.concierge_accounts ca
  left join public.tenant_branding tb on tb.account_id = ca.id
  where ca.status = 'active'
    and ( lower(ca.custom_domain) = host
          or (host like '%.homegoinghq.com' and lower(ca.subdomain) = sub) )
  limit 1;

  if a.id is null then
    return json_build_object('found', false);
  end if;

  return json_build_object(
    'found', true,
    'business_name', a.business_name,
    'tenant_type',   a.tenant_type,
    -- Starter keeps HomegoingHQ visible; Professional/Enterprise are fully white-labeled.
    'homegoing_visible', (a.tier = 'starter'),
    'logo_url',    a.logo_url,
    'favicon_url', a.favicon_url,
    'hero_url',    a.hero_url,
    'color_ink',         coalesce(a.color_ink,'#26332E'),
    'color_accent',      coalesce(a.color_accent,'#8F6A24'),
    'color_accent_deep', coalesce(a.color_accent_deep,'#75561D'),
    'contact_name',  a.contact_name,
    'contact_email', a.contact_email,
    'contact_phone', a.contact_phone,
    'footer_note',   a.footer_note
  );
end $function$;

-- === function: set_death_state ===
CREATE OR REPLACE FUNCTION public.set_death_state(p_estate uuid, p_state text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s text;
begin
  if not ( public.is_estate_owner(p_estate) or public.is_admin()
           or exists (select 1 from public.estates e
                      join public.concierge_accounts ca on ca.id = e.account_id
                      where e.id = p_estate and ca.owner_user_id = auth.uid()) ) then
    return json_build_object('error','forbidden');
  end if;
  s := nullif(upper(left(coalesce(p_state,''),2)),'');
  update public.estates set death_state = s where id = p_estate;
  return json_build_object('ok', true, 'death_state', s);
end $function$;

-- === function: set_estate_status ===
CREATE OR REPLACE FUNCTION public.set_estate_status(p_estate uuid, p_status text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_status not in ('active','closed','archived') then return json_build_object('error','bad_status'); end if;
  if not ( public.is_estate_owner(p_estate) or public.is_admin()
           or exists (select 1 from public.estates e
                      join public.concierge_accounts ca on ca.id = e.account_id
                      where e.id = p_estate and ca.owner_user_id = auth.uid()) ) then
    return json_build_object('error','forbidden');
  end if;
  update public.estates set status = p_status where id = p_estate;
  return json_build_object('ok', true, 'status', p_status);
end $function$;

-- === function: submit_concierge_application ===
CREATE OR REPLACE FUNCTION public.submit_concierge_application(p_business_name text, p_contact_name text, p_business_address text, p_phone text, p_email text, p_website text, p_service_area text, p_years_in_business text, p_business_description text, p_eo_insurer text, p_eo_policy_number text, p_eo_expiry text, p_eo_additional_insured boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare new_id uuid;
begin
  if coalesce(trim(p_contact_name),'')='' or coalesce(trim(p_email),'')='' then
    return json_build_object('error','missing_required');
  end if;
  insert into public.provider_applications
    (kind, status, business_name, contact_name, business_address, phone, email, website,
     service_area, years_in_business, business_description,
     eo_insurer, eo_policy_number, eo_expiry, eo_additional_insured)
  values
    ('concierge','pending', trim(p_business_name), trim(p_contact_name), p_business_address, p_phone,
     trim(p_email), p_website, p_service_area, p_years_in_business, p_business_description,
     p_eo_insurer, p_eo_policy_number, p_eo_expiry, p_eo_additional_insured)
  returning id into new_id;
  return json_build_object('ok', true, 'id', new_id);
end $function$;

-- === function: submit_provider_application ===
CREATE OR REPLACE FUNCTION public.submit_provider_application(p_business_name text, p_contact_name text, p_business_address text, p_phone text, p_email text, p_website text, p_service_area text, p_category text, p_services_offered text, p_years_in_business text, p_business_description text, p_license_number text, p_references text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare new_id uuid;
begin
  if coalesce(trim(p_business_name),'')='' or coalesce(trim(p_email),'')='' then
    return json_build_object('error','missing_required');
  end if;
  insert into public.provider_applications
    (kind, status, business_name, contact_name, business_address, phone, email, website,
     service_area, category, services_offered, years_in_business, business_description, license_number, references_text)
  values
    ('provider','pending', trim(p_business_name), trim(p_contact_name), p_business_address, p_phone,
     trim(p_email), p_website, p_service_area, p_category, p_services_offered, p_years_in_business,
     p_business_description, p_license_number, p_references)
  returning id into new_id;
  return json_build_object('ok', true, 'id', new_id);
end $function$;

-- === function: touch_account_updated ===
CREATE OR REPLACE FUNCTION public.touch_account_updated()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at = now(); return new; end $function$;


-- ---------- ROW-LEVEL SECURITY (verbatim from pg_policies) ----------
-- Created after the functions above so is_admin()/is_account_owner() exist.
alter table public.concierge_accounts          enable row level security;
alter table public.tenant_branding             enable row level security;
alter table public.concierge_pending_provisions enable row level security;

-- concierge_accounts (no INSERT policy: rows are created only by the
-- SECURITY DEFINER provisioning functions / service role)
drop policy if exists "owner or admin reads account" on public.concierge_accounts;
create policy "owner or admin reads account" on public.concierge_accounts
  for select using ((owner_user_id = auth.uid()) or is_admin());
drop policy if exists "admin updates account" on public.concierge_accounts;
create policy "admin updates account" on public.concierge_accounts
  for update using (is_admin()) with check (is_admin());
drop policy if exists "admin deletes account" on public.concierge_accounts;
create policy "admin deletes account" on public.concierge_accounts
  for delete using (is_admin());

-- tenant_branding
drop policy if exists "owner or admin reads branding" on public.tenant_branding;
create policy "owner or admin reads branding" on public.tenant_branding
  for select using (is_account_owner(account_id) or is_admin());
drop policy if exists "owner or admin inserts branding" on public.tenant_branding;
create policy "owner or admin inserts branding" on public.tenant_branding
  for insert with check (is_account_owner(account_id) or is_admin());
drop policy if exists "owner or admin updates branding" on public.tenant_branding;
create policy "owner or admin updates branding" on public.tenant_branding
  for update using (is_account_owner(account_id) or is_admin())
             with check (is_account_owner(account_id) or is_admin());

-- concierge_pending_provisions: RLS enabled with NO client policies — reachable
-- only via the claim_my_provision SECURITY DEFINER function and the service-role
-- key (Paythen/Stripe webhooks). This matches the live DB (no policies returned).

