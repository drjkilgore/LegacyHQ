-- HomegoingHQ — Migration v31: header display controls for white-label pages.
--  • header_text (+ font / bold / italic / size): a wordmark shown next to the logo
--    (useful when the logo is small or icon-only).
--  • logo_size: how large the header logo renders (sm / md / lg / xl).

alter table public.tenant_branding add column if not exists header_text   text;
alter table public.tenant_branding add column if not exists header_font   text;
alter table public.tenant_branding add column if not exists header_bold   boolean not null default false;
alter table public.tenant_branding add column if not exists header_italic boolean not null default false;
alter table public.tenant_branding add column if not exists header_size   text not null default 'md';
alter table public.tenant_branding add column if not exists logo_size     text not null default 'md';

create or replace function public.admin_set_header_text(
  target uuid, p_text text, p_font text, p_bold boolean, p_italic boolean,
  p_size text, p_logo_size text default 'md')
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return false; end if;
  insert into public.tenant_branding
      (account_id, header_text, header_font, header_bold, header_italic, header_size, logo_size, updated_at)
  values
      (target, nullif(trim(coalesce(p_text,'')),''), nullif(p_font,''),
       coalesce(p_bold,false), coalesce(p_italic,false),
       coalesce(nullif(p_size,''),'md'), coalesce(nullif(p_logo_size,''),'md'), now())
  on conflict (account_id) do update
    set header_text   = excluded.header_text,
        header_font   = excluded.header_font,
        header_bold   = excluded.header_bold,
        header_italic = excluded.header_italic,
        header_size   = excluded.header_size,
        logo_size     = excluded.logo_size,
        updated_at    = now();
  return true;
end $$;
grant execute on function public.admin_set_header_text(uuid,text,text,boolean,boolean,text,text) to authenticated;

-- Recreate public_branding so branded pages receive the new display fields.
create or replace function public.public_branding(host text)
returns json language plpgsql stable security definer set search_path = public as $$
declare a record; sub text;
begin
  host := lower(coalesce(host,''));
  sub  := split_part(host, '.', 1);
  select ca.id, ca.business_name, ca.tier, ca.tenant_type, ca.status,
         tb.logo_url, tb.favicon_url, tb.hero_url,
         tb.color_ink, tb.color_accent, tb.color_accent_deep,
         tb.contact_name, tb.contact_email, tb.contact_phone, tb.footer_note,
         tb.header_text, tb.header_font, tb.header_bold, tb.header_italic, tb.header_size, tb.logo_size
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
    'footer_note',   a.footer_note,
    'header_text',   a.header_text,
    'header_font',   a.header_font,
    'header_bold',   coalesce(a.header_bold,false),
    'header_italic', coalesce(a.header_italic,false),
    'header_size',   coalesce(a.header_size,'md'),
    'logo_size',     coalesce(a.logo_size,'md')
  );
end $$;
