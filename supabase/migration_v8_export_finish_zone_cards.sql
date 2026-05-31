-- Inventario Almacén v8
-- Ajustes de producción: grupos en ubicaciones, campos de exportación y recarga de schema cache.
-- Ejecutar después de las migraciones v5, v6 y v7. Es seguro ejecutarla más de una vez.

alter table public.campaigns
  add column if not exists sync_status text default 'synced';

alter table public.campaign_locations
  add column if not exists sync_status text default 'synced',
  add column if not exists assigned_group text;

alter table public.inventory_snapshot
  add column if not exists sync_status text default 'synced';

alter table public.group_counts
  add column if not exists sync_status text default 'synced',
  add column if not exists material_condition text default 'buen_estado',
  add column if not exists condition_qty numeric default 0,
  add column if not exists comment text;

alter table public.found_items
  add column if not exists sync_status text default 'synced',
  add column if not exists material_condition text default 'buen_estado',
  add column if not exists condition_qty numeric default 0,
  add column if not exists comment text;

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

drop policy if exists "locations_admin_write_v8" on public.campaign_locations;
create policy "locations_admin_write_v8"
on public.campaign_locations
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "locations_counter_update_existing_v8" on public.campaign_locations;
create policy "locations_counter_update_existing_v8"
on public.campaign_locations
for update
to authenticated
using (public.is_counter_or_admin_for_location(id))
with check (public.is_counter_or_admin_for_location(id));

drop view if exists public.v_reconciliation;
create view public.v_reconciliation as
with grouped_snapshot as (
  select
    campaign_id,
    location_id,
    warehouse,
    zone,
    location,
    material_code,
    max(material_name) as material_name,
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

alter view public.v_reconciliation set (security_invoker = true);

select pg_notify('pgrst', 'reload schema');
