-- Inventario Almacén - esquema de producción para Supabase/PostgreSQL
-- Flujo: carga de zona, conteo offline en navegador, sincronización, conciliación y exportación.

create extension if not exists pgcrypto;

create type public.user_role as enum ('admin', 'contador');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique not null,
  role public.user_role not null default 'contador',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


create table if not exists public.authorized_users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text unique not null,
  role public.user_role not null default 'contador',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id text primary key,
  name text not null,
  warehouse text not null,
  zone text not null,
  status text not null default 'activa',
  cut_date timestamptz not null default now(),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_locations (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  warehouse text not null,
  zone text not null,
  location text not null,
  location_key text unique not null,
  assigned_to text,
  assigned_group text,
  status text not null default 'pendiente',
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_snapshot (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  location_id text not null references public.campaign_locations(id) on delete cascade,
  warehouse text not null,
  zone text not null,
  location text not null,
  material_code text not null,
  material_name text,
  material_name_cn text,
  unit text,
  batch text not null default 'S/L',
  system_qty numeric not null default 0,
  department text,
  purchase_order text,
  unit_price numeric default 0,
  total_value numeric default 0,
  raw_lines integer not null default 1,
  created_at timestamptz not null default now()
);

-- Conteo principal: una línea por ubicación + código + unidad.
-- El detalle de lotes queda en inventory_snapshot y se consulta solo como detalle.
create table if not exists public.group_counts (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  location_id text not null references public.campaign_locations(id) on delete cascade,
  warehouse text not null,
  zone text not null,
  location text not null,
  material_code text not null,
  material_name text,
  material_name_cn text,
  unit text,
  physical_qty numeric,
  status text not null default 'pendiente',
  counted_by text,
  counted_at timestamptz,
  material_condition text default 'buen_estado',
  condition_qty numeric default 0,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.found_items (
  id text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  location_id text references public.campaign_locations(id) on delete set null,
  warehouse text not null,
  zone text not null,
  location text not null,
  material_code text not null,
  material_name text,
  material_name_cn text,
  unit text,
  batch text default 'S/L',
  system_qty numeric not null default 0,
  physical_qty numeric not null default 0,
  registered_by text,
  material_condition text default 'buen_estado',
  condition_qty numeric default 0,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_authorized_users_email on public.authorized_users(email);
create index if not exists idx_authorized_users_role on public.authorized_users(role);
create index if not exists idx_campaigns_status on public.campaigns(status);
create index if not exists idx_locations_campaign on public.campaign_locations(campaign_id);
create index if not exists idx_locations_assigned on public.campaign_locations(assigned_to);
create index if not exists idx_snapshot_campaign on public.inventory_snapshot(campaign_id);
create index if not exists idx_snapshot_location on public.inventory_snapshot(location_id);
create index if not exists idx_snapshot_material on public.inventory_snapshot(material_code);
create index if not exists idx_group_counts_campaign on public.group_counts(campaign_id);
create index if not exists idx_group_counts_location on public.group_counts(location_id);
create index if not exists idx_found_campaign on public.found_items(campaign_id);
create index if not exists idx_found_location on public.found_items(location_id);

-- Funciones de ayuda para RLS.
create or replace function public.current_user_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role::text
  from public.profiles
  where id = auth.uid()
    and active = true
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;



create or replace function public.is_admin_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where active = true
      and role = 'admin'
      and (id = auth.uid() or lower(email) = lower(auth.email()))
  );
$$;

create or replace function public.claim_profile_from_invitation()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.authorized_users%rowtype;
  result_profile public.profiles%rowtype;
begin
  if auth.uid() is null or auth.email() is null then
    raise exception 'Usuario no autenticado.';
  end if;

  select *
  into invitation
  from public.authorized_users
  where lower(email) = lower(auth.email())
    and active = true
  limit 1;

  if not found then
    raise exception 'Correo no autorizado para Inventario Almacén.';
  end if;

  insert into public.profiles (id, full_name, email, role, active)
  values (auth.uid(), invitation.full_name, auth.email(), invitation.role, true)
  on conflict (id) do update set
    full_name = excluded.full_name,
    email = excluded.email,
    role = excluded.role,
    active = excluded.active,
    updated_at = now()
  returning * into result_profile;

  update public.authorized_users
  set claimed_by = auth.uid(),
      claimed_at = coalesce(claimed_at, now()),
      updated_at = now()
  where id = invitation.id;

  return result_profile;
end;
$$;

grant execute on function public.claim_profile_from_invitation() to authenticated;

create or replace function public.is_counter_or_admin_for_location(location_id_arg text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.campaign_locations l
    where l.id = location_id_arg
      and (
        public.is_admin()
        or public.is_admin_user()
        or l.assigned_to is null
        or lower(l.assigned_to) = lower(auth.email())
      )
  );
$$;

-- Vista de conciliación por código totalizado y ubicación.
create or replace view public.v_reconciliation as
with grouped_snapshot as (
  select
    campaign_id,
    location_id,
    warehouse,
    zone,
    location,
    material_code,
    max(material_name) as material_name,
    max(material_name_cn) as material_name_cn,
    max(unit) as unit,
    string_agg(coalesce(batch, 'S/L') || ': ' || system_qty::text, ' | ' order by batch) as lot_detail,
    sum(system_qty) as system_qty,
    sum(total_value) as total_value,
    sum(raw_lines) as raw_lines,
    max(department) as department,
    max(purchase_order) as purchase_order
  from public.inventory_snapshot
  group by campaign_id, location_id, warehouse, zone, location, material_code
)
select
  s.campaign_id,
  s.location_id,
  s.warehouse,
  s.zone,
  s.location,
  l.assigned_group,
  s.material_code,
  s.material_name,
  s.material_name_cn,
  s.unit,
  s.lot_detail,
  s.system_qty,
  c.physical_qty,
  case when c.physical_qty is null then null else c.physical_qty - s.system_qty end as difference,
  case
    when c.physical_qty is null then 'pendiente'
    when c.physical_qty = s.system_qty then 'ok'
    when c.physical_qty < s.system_qty then 'faltante'
    else 'sobrante'
  end as status,
  c.counted_by,
  c.counted_at,
  c.material_condition,
  c.condition_qty,
  c.comment,
  s.raw_lines,
  s.department,
  s.purchase_order,
  case when s.system_qty = 0 then 0 else s.total_value / s.system_qty end as unit_price,
  s.total_value,
  case when c.physical_qty is null or s.system_qty = 0 then null else (c.physical_qty - s.system_qty) * (s.total_value / s.system_qty) end as difference_value
from grouped_snapshot s
left join public.campaign_locations l on l.id = s.location_id
left join public.group_counts c on c.id = concat_ws('::', s.campaign_id, s.location_id, s.warehouse, s.zone, s.location, s.material_code, coalesce(s.unit, ''))
union all
select
  f.campaign_id,
  f.location_id,
  f.warehouse,
  f.zone,
  f.location,
  l.assigned_group,
  f.material_code,
  f.material_name,
  f.material_name_cn,
  f.unit,
  coalesce(f.batch, 'S/L') as lot_detail,
  0 as system_qty,
  f.physical_qty,
  f.physical_qty as difference,
  'encontrado' as status,
  f.registered_by as counted_by,
  f.created_at as counted_at,
  f.material_condition,
  f.condition_qty,
  f.comment,
  0 as raw_lines,
  null as department,
  null as purchase_order,
  0 as unit_price,
  0 as total_value,
  0 as difference_value
from public.found_items f
left join public.campaign_locations l on l.id = f.location_id;

-- Seguridad por filas.
alter table public.profiles enable row level security;
alter table public.authorized_users enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_locations enable row level security;
alter table public.inventory_snapshot enable row level security;
alter table public.group_counts enable row level security;
alter table public.found_items enable row level security;

-- Limpieza defensiva de políticas si el script se ejecuta más de una vez.
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
drop policy if exists "profiles_admin_write" on public.profiles;
drop policy if exists "authorized_users_select_admin_or_self" on public.authorized_users;
drop policy if exists "authorized_users_admin_write" on public.authorized_users;
drop policy if exists "campaigns_select_authenticated" on public.campaigns;
drop policy if exists "campaigns_admin_write" on public.campaigns;
drop policy if exists "locations_select_assigned_or_admin" on public.campaign_locations;
drop policy if exists "locations_admin_or_counter_update" on public.campaign_locations;
drop policy if exists "locations_admin_insert" on public.campaign_locations;
drop policy if exists "snapshot_select_assigned_or_admin" on public.inventory_snapshot;
drop policy if exists "snapshot_admin_write" on public.inventory_snapshot;
drop policy if exists "group_counts_select_assigned_or_admin" on public.group_counts;
drop policy if exists "group_counts_write_assigned_or_admin" on public.group_counts;
drop policy if exists "found_items_select_assigned_or_admin" on public.found_items;
drop policy if exists "found_items_write_assigned_or_admin" on public.found_items;

create policy "profiles_select_own_or_admin"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

create policy "profiles_admin_write"
on public.profiles
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

create policy "authorized_users_select_admin_or_self"
on public.authorized_users
for select
to authenticated
using (public.is_admin() or public.is_admin_user() or lower(email) = lower(auth.email()));

create policy "authorized_users_admin_write"
on public.authorized_users
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

create policy "campaigns_select_authenticated"
on public.campaigns
for select
to authenticated
using (true);

create policy "campaigns_admin_write"
on public.campaigns
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

create policy "locations_select_assigned_or_admin"
on public.campaign_locations
for select
to authenticated
using (public.is_admin() or public.is_admin_user() or assigned_to is null or lower(assigned_to) = lower(auth.email()));

create policy "locations_admin_insert"
on public.campaign_locations
for insert
to authenticated
with check (public.is_admin() or public.is_admin_user());

create policy "locations_admin_or_counter_update"
on public.campaign_locations
for update
to authenticated
using (public.is_admin() or public.is_admin_user() or assigned_to is null or lower(assigned_to) = lower(auth.email()))
with check (public.is_admin() or public.is_admin_user() or assigned_to is null or lower(assigned_to) = lower(auth.email()));

create policy "snapshot_select_assigned_or_admin"
on public.inventory_snapshot
for select
to authenticated
using (public.is_counter_or_admin_for_location(location_id));

create policy "snapshot_admin_write"
on public.inventory_snapshot
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

create policy "group_counts_select_assigned_or_admin"
on public.group_counts
for select
to authenticated
using (public.is_counter_or_admin_for_location(location_id));

create policy "group_counts_write_assigned_or_admin"
on public.group_counts
for all
to authenticated
using (public.is_counter_or_admin_for_location(location_id))
with check (public.is_counter_or_admin_for_location(location_id));

create policy "found_items_select_assigned_or_admin"
on public.found_items
for select
to authenticated
using (location_id is null or public.is_counter_or_admin_for_location(location_id));

create policy "found_items_write_assigned_or_admin"
on public.found_items
for all
to authenticated
using (location_id is null or public.is_counter_or_admin_for_location(location_id))
with check (location_id is null or public.is_counter_or_admin_for_location(location_id));

-- La vista debe respetar las políticas RLS del usuario que consulta.
alter view public.v_reconciliation set (security_invoker = true);
