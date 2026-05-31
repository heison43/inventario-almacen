-- Inventario Almacén v10
-- Adaptación a la plantilla oficial: Codigo de material, Descripción del Articulo,
-- Descripcion en Chino, UM, Suma de Inventario total, Ubicación, Departamento Solicitante, Almacen.
-- Ejecutar después de la migración v8. Es seguro ejecutarla más de una vez.

alter table public.inventory_snapshot
  add column if not exists material_name_cn text;

alter table public.group_counts
  add column if not exists material_name_cn text;

alter table public.found_items
  add column if not exists material_name_cn text;

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

alter view public.v_reconciliation set (security_invoker = true);

select pg_notify('pgrst', 'reload schema');
