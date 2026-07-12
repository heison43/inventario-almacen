-- Inventario Almacén v24
-- 1) Reconteo de un mismo código en varias ubicaciones.
-- 2) Consulta y registro del reconteo disponible para administradores y contadores.
-- No modifica campañas, conteos físicos ni códigos nuevos existentes.

begin;

create table if not exists public.review_recount_lines (
  id text primary key,
  batch_id text not null references public.review_batches(id) on delete cascade,
  item_id text not null references public.review_items(id) on delete cascade,
  recount_id text not null references public.review_recounts(id) on delete cascade,
  material_code text not null,
  location text not null,
  qty numeric not null default 0,
  line_comment text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_review_recount_lines_batch on public.review_recount_lines(batch_id);
create index if not exists idx_review_recount_lines_item on public.review_recount_lines(item_id);
create index if not exists idx_review_recount_lines_recount on public.review_recount_lines(recount_id);
create index if not exists idx_review_recount_lines_material on public.review_recount_lines(material_code);
create index if not exists idx_review_recount_lines_location on public.review_recount_lines(location);

-- Conserva las revisiones hechas en v23: cada revisión antigua se convierte
-- en una primera línea de ubicación/cantidad.
insert into public.review_recount_lines (
  id, batch_id, item_id, recount_id, material_code,
  location, qty, line_comment, created_by, created_at, updated_at
)
select
  'rline_legacy_' || r.id,
  r.batch_id,
  r.item_id,
  r.id,
  r.material_code,
  coalesce(nullif(trim(r.verified_location), ''), 'SIN UBICACION'),
  coalesce(r.recount_qty, 0),
  null,
  r.created_by,
  coalesce(r.created_at, now()),
  coalesce(r.updated_at, now())
from public.review_recounts r
where (r.recount_qty is not null or nullif(trim(r.verified_location), '') is not null)
  and not exists (
    select 1
    from public.review_recount_lines l
    where l.recount_id = r.id
  );

create or replace function public.is_active_inventory_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.active = true
      and (
        p.id = auth.uid()
        or lower(p.email) = lower(auth.email())
      )
  );
$$;

grant execute on function public.is_active_inventory_user() to authenticated;

alter table public.review_recount_lines enable row level security;

-- Reemplaza las políticas administrativas de v23 por políticas separadas:
-- todos los usuarios activos pueden leer los grupos; solo el admin los administra.
drop policy if exists "review_batches_admin_all_v23" on public.review_batches;
drop policy if exists "review_items_admin_all_v23" on public.review_items;
drop policy if exists "review_wms_admin_all_v23" on public.review_wms_stock;
drop policy if exists "review_recounts_admin_all_v23" on public.review_recounts;

drop policy if exists "review_batches_read_v24" on public.review_batches;
drop policy if exists "review_batches_admin_insert_v24" on public.review_batches;
drop policy if exists "review_batches_admin_update_v24" on public.review_batches;
drop policy if exists "review_batches_admin_delete_v24" on public.review_batches;
create policy "review_batches_read_v24"
on public.review_batches for select to authenticated
using (public.is_active_inventory_user());
create policy "review_batches_admin_insert_v24"
on public.review_batches for insert to authenticated
with check (public.is_admin() or public.is_admin_user());
create policy "review_batches_admin_update_v24"
on public.review_batches for update to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());
create policy "review_batches_admin_delete_v24"
on public.review_batches for delete to authenticated
using (public.is_admin() or public.is_admin_user());

drop policy if exists "review_items_read_v24" on public.review_items;
drop policy if exists "review_items_admin_insert_v24" on public.review_items;
drop policy if exists "review_items_admin_update_v24" on public.review_items;
drop policy if exists "review_items_admin_delete_v24" on public.review_items;
create policy "review_items_read_v24"
on public.review_items for select to authenticated
using (public.is_active_inventory_user());
create policy "review_items_admin_insert_v24"
on public.review_items for insert to authenticated
with check (public.is_admin() or public.is_admin_user());
create policy "review_items_admin_update_v24"
on public.review_items for update to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());
create policy "review_items_admin_delete_v24"
on public.review_items for delete to authenticated
using (public.is_admin() or public.is_admin_user());

drop policy if exists "review_wms_read_v24" on public.review_wms_stock;
drop policy if exists "review_wms_admin_insert_v24" on public.review_wms_stock;
drop policy if exists "review_wms_admin_update_v24" on public.review_wms_stock;
drop policy if exists "review_wms_admin_delete_v24" on public.review_wms_stock;
create policy "review_wms_read_v24"
on public.review_wms_stock for select to authenticated
using (public.is_active_inventory_user());
create policy "review_wms_admin_insert_v24"
on public.review_wms_stock for insert to authenticated
with check (public.is_admin() or public.is_admin_user());
create policy "review_wms_admin_update_v24"
on public.review_wms_stock for update to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());
create policy "review_wms_admin_delete_v24"
on public.review_wms_stock for delete to authenticated
using (public.is_admin() or public.is_admin_user());

-- Administradores y contadores activos pueden consultar y registrar la revisión.
drop policy if exists "review_recounts_read_v24" on public.review_recounts;
drop policy if exists "review_recounts_insert_v24" on public.review_recounts;
drop policy if exists "review_recounts_update_v24" on public.review_recounts;
drop policy if exists "review_recounts_admin_delete_v24" on public.review_recounts;
create policy "review_recounts_read_v24"
on public.review_recounts for select to authenticated
using (public.is_active_inventory_user());
create policy "review_recounts_insert_v24"
on public.review_recounts for insert to authenticated
with check (public.is_active_inventory_user());
create policy "review_recounts_update_v24"
on public.review_recounts for update to authenticated
using (public.is_active_inventory_user())
with check (public.is_active_inventory_user());
create policy "review_recounts_admin_delete_v24"
on public.review_recounts for delete to authenticated
using (public.is_admin() or public.is_admin_user());

drop policy if exists "review_recount_lines_read_v24" on public.review_recount_lines;
drop policy if exists "review_recount_lines_insert_v24" on public.review_recount_lines;
drop policy if exists "review_recount_lines_update_v24" on public.review_recount_lines;
drop policy if exists "review_recount_lines_delete_v24" on public.review_recount_lines;
create policy "review_recount_lines_read_v24"
on public.review_recount_lines for select to authenticated
using (public.is_active_inventory_user());
create policy "review_recount_lines_insert_v24"
on public.review_recount_lines for insert to authenticated
with check (public.is_active_inventory_user());
create policy "review_recount_lines_update_v24"
on public.review_recount_lines for update to authenticated
using (public.is_active_inventory_user())
with check (public.is_active_inventory_user());
create policy "review_recount_lines_delete_v24"
on public.review_recount_lines for delete to authenticated
using (public.is_active_inventory_user());

select pg_notify('pgrst', 'reload schema');

commit;
