-- ============================================================
-- LegacyHQ — Migration v7: WHITE-LABEL PARTNERS + STATE PACK SYSTEM
-- Run AFTER v1–v6 as admin ("Run without RLS"). Additive only.
-- ============================================================

-- ---------- PARTNERS (funeral homes, advisors, churches) ----------
create table public.partners (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                -- used in links: yoursite.com/?p=CODE
  name text not null,
  logo_url text,
  brand_color text,                          -- hex, optional accent
  contact_email text,
  funeral_home jsonb default '{}'::jsonb,    -- {name, phone, address} prefills the Funeral tab
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
alter table public.partners enable row level security;
create policy "admin manages partners" on public.partners
  for all using (public.is_admin()) with check (public.is_admin());

-- Public, anon-callable lookup: returns only display-safe fields for ACTIVE partners
create or replace function public.get_partner(pcode text)
returns json language sql security definer set search_path = public stable as $$
  select json_build_object('code',code,'name',name,'logo_url',logo_url,
                           'brand_color',brand_color,'funeral_home',funeral_home)
  from public.partners where lower(code)=lower(pcode) and active=true limit 1;
$$;

-- Attribution
alter table public.profiles add column if not exists partner_code text;
alter table public.estates  add column if not exists partner_code text;

-- Admin: partners with signup counts
create or replace function public.admin_list_partners()
returns json language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  return (select coalesce(json_agg(row_to_json(x)),'[]'::json) from (
    select p.*,
      (select count(*) from public.profiles pr where pr.partner_code = p.code) as signups,
      (select count(*) from public.estates e where e.partner_code = p.code) as estates
    from public.partners p order by p.created_at desc
  ) x);
end $$;

-- ---------- STATE PACKS (content as data, editable from Admin) ----------
create table public.state_packs (
  state_code text primary key,               -- 'MI', 'IN', ... or 'GENERIC'
  content jsonb not null,
  version text not null default 'v1',
  reviewed_by text,                          -- e.g., "Jane Smith, MI probate attorney"
  reviewed_at date,
  updated_at timestamptz not null default now()
);
alter table public.state_packs enable row level security;
create policy "signed-in read packs" on public.state_packs
  for select using (auth.uid() is not null);
create policy "admin writes packs" on public.state_packs
  for insert with check (public.is_admin());
create policy "admin updates packs" on public.state_packs
  for update using (public.is_admin());
create policy "admin deletes packs" on public.state_packs
  for delete using (public.is_admin());

-- Seed: Michigan + Generic (mirrors the app's built-in content; edit freely in Admin)
insert into public.state_packs (state_code, content, version, reviewed_at) values
('MI', '{
 "name":"Michigan","term":"personal representative",
 "smallEstate":"Michigan''s small-estate limit is adjusted every year (it has been in the high-$20,000s to low-$30,000s range in recent years, calculated after subtracting funeral/burial costs and liens). Verify the current figure with the county probate court or at courts.mi.gov before choosing this path.",
 "notes":[
  "Michigan calls the executor the ''personal representative'' (PR) — that''s the term on every court form.",
  "Most Michigan estates use UNSUPERVISED (informal) probate — faster, fewer hearings. Supervised probate is for conflict or complexity.",
  "Creditors generally have 4 months from published notice to bring claims.",
  "An estate generally must stay open at least 5 months from the PR''s appointment before closing.",
  "Michigan charges an inventory fee based on the estate''s value, paid to the court.",
  "Vehicles: if vehicles are the only assets (under the state cap) the Secretary of State has a simple transfer-by-affidavit process — no probate needed.",
  "Common SCAO forms: PC 556 (Petition & Order for Assignment — small estates), PC 558 (Application for Informal Probate), PC 572 (Letters of Authority), PC 577 (Inventory), PC 591 (Sworn Statement to Close). Confirm current versions at courts.mi.gov."],
 "paths":{
  "none":{"label":"No probate likely needed","steps":["Record a certified death certificate with the register of deeds for jointly-owned real estate","Present death certificates + beneficiary claims to each institution (POD/TOD accounts, life insurance, retirement plans)","Confirm with the attorney that no solely-titled assets remain"]},
  "small":{"label":"Small estate — Petition for Assignment","steps":["Confirm the estate (minus funeral/burial costs and liens) is under this year''s small-estate limit","File Petition & Order for Assignment (PC 556) with the county probate court + certified death certificate + filing fee","Bring the funeral bill or proof of payment — the person who paid it has priority","Use the signed order to collect and transfer the assets","Keep copies of everything for 7 years"]},
  "informal":{"label":"Unsupervised (informal) probate","steps":["File Application for Informal Probate (PC 558) with the will and certified death certificate at the county probate court","Receive Letters of Authority (PC 572) — this is your legal power to act","Open the estate bank account with an EIN; notify heirs and devisees","Publish notice to creditors — the 4-month claim window starts at publication","File the Inventory (PC 577) within the required window and pay the inventory fee","Review and pay allowed claims in priority order from estate funds","Prepare accountings; distribute with signed receipts after claims and taxes","After 5+ months, file the Sworn Statement to Close (PC 591)"]},
  "formal":{"label":"Supervised / formal probate","steps":["This path runs through court hearings — retain a Michigan probate attorney before filing","File the Petition for Probate; the court supervises major steps","Follow the court''s schedule for inventory, accountings, and approvals","Distribute only on court approval; obtain the order of discharge"]}}
}'::jsonb, 'v1', current_date),
('GENERIC', '{
 "name":"General guidance","term":"executor / personal representative",
 "smallEstate":"Most states offer a simplified small-estate process (affidavit or summary administration) under a dollar threshold that varies widely by state. The county probate court''s website usually states the current figure.",
 "notes":[
  "Probate covers assets titled solely in the deceased''s name with no beneficiary designation.",
  "Joint property, POD/TOD accounts, trust assets, and insurance with living beneficiaries generally bypass probate.",
  "Never pay estate debts from personal funds; claims are paid from estate assets in a legal priority order.",
  "Deadlines for inventories, creditor notices, and accountings vary by state — the probate court clerk can tell you the local rules (clerks can''t give legal advice, but they know the procedure)."],
 "paths":{
  "none":{"label":"No probate likely needed","steps":["Record the death certificate where required for jointly-owned real estate","Claim POD/TOD accounts and insurance directly with each institution","Confirm with an attorney that nothing solely-titled remains"]},
  "small":{"label":"Small-estate process","steps":["Confirm the estate is under your state''s small-estate threshold","Obtain the small-estate affidavit or petition from the county probate court","File with a certified death certificate; follow the court''s instructions to collect assets","Keep records of everything collected and paid"]},
  "informal":{"label":"Standard probate","steps":["File the will and petition/application at the county probate court","Receive letters (your legal authority); get an EIN and open the estate account","Notify heirs; publish creditor notice; file the inventory on the court''s schedule","Pay allowed claims in priority order; keep meticulous records","Prepare accountings, distribute with signed receipts, and close per the court''s process"]},
  "formal":{"label":"Formal / supervised probate","steps":["Retain a probate attorney — this path involves court hearings","Follow the court''s supervision for each major step through discharge"]}}
}'::jsonb, 'v1', current_date)
on conflict (state_code) do nothing;

-- ---------- COUNTY DIRECTORY (court logistics — factual data, no legal review needed) ----------
create table public.county_directory (
  id uuid primary key default gen_random_uuid(),
  state_code text not null,
  county text not null,
  court_name text,
  address text,
  phone text,
  website text,
  filing_note text,
  updated_at timestamptz not null default now(),
  unique (state_code, county)
);
alter table public.county_directory enable row level security;
create policy "signed-in read counties" on public.county_directory
  for select using (auth.uid() is not null);
create policy "admin writes counties" on public.county_directory
  for insert with check (public.is_admin());
create policy "admin updates counties" on public.county_directory
  for update using (public.is_admin());
create policy "admin deletes counties" on public.county_directory
  for delete using (public.is_admin());

-- Starter rows for Michigan's three biggest counties — FILL/VERIFY details in the
-- Admin console using the official directory at courts.mi.gov before relying on them.
insert into public.county_directory (state_code, county, court_name, filing_note) values
('MI','Wayne','Wayne County Probate Court','Verify address, phone, and current filing fees via the court directory at courts.mi.gov'),
('MI','Oakland','Oakland County Probate Court','Verify address, phone, and current filing fees via the court directory at courts.mi.gov'),
('MI','Macomb','Macomb County Probate Court','Verify address, phone, and current filing fees via the court directory at courts.mi.gov')
on conflict do nothing;
