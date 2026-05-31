-- Inventario Almacén v6
-- Ejecuta este archivo si ya tenías la base en v5.
-- Agrega grupos por ubicación, estado físico, cantidad afectada, comentario y políticas RLS más tolerantes para admin.

alter table public.campaign_locations
  add column if not exists assigned_group text;

alter table public.group_counts
  add column if not exists material_condition text default 'buen_estado',
  add column if not exists condition_qty numeric default 0,
  add column if not exists comment text;

alter table public.found_items
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

-- Políticas adicionales para evitar bloqueos al sincronizar campañas/ubicaciones desde el panel admin.
drop policy if exists "campaigns_admin_write_v6" on public.campaigns;
create policy "campaigns_admin_write_v6"
on public.campaigns
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "locations_admin_write_v6" on public.campaign_locations;
create policy "locations_admin_write_v6"
on public.campaign_locations
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "snapshot_admin_write_v6" on public.inventory_snapshot;
create policy "snapshot_admin_write_v6"
on public.inventory_snapshot
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

-- Vista de conciliación actualizada con estado físico y comentario.
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
left join public.group_counts c on c.id = concat_ws('::', s.campaign_id, s.location_id, s.warehouse, s.zone, s.location, s.material_code, coalesce(s.unit, ''))
union all
select
  f.campaign_id,
  f.location_id,
  f.warehouse,
  f.zone,
  f.location,
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
from public.found_items f;

alter view public.v_reconciliation set (security_invoker = true);
