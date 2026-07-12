-- Inventario Almacén v23 - Módulo Revisión de diferencias
-- Tablas independientes para cruzar códigos prioritarios, WMS actual,
-- historial del inventario físico y segundo conteo.
-- No modifica campañas, ubicaciones, conteos ni códigos nuevos existentes.

begin;

create table if not exists public.review_batches (
  id text primary key,
  name text not null,
  review_type text not null default 'sobrantes',
  status text not null default 'activa',
  responsible text,
  notes text,
  wms_cut_at timestamptz,
  codes_file_name text,
  wms_file_name text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_items (
  id text primary key,
  batch_id text not null references public.review_batches(id) on delete cascade,
  material_code text not null,
  material_name text,
  expected_difference numeric not null default 0,
  unit_price numeric not null default 0,
  expected_value numeric not null default 0,
  priority integer not null default 0,
  review_type text not null default 'sobrantes',
  review_status text not null default 'pendiente',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, material_code)
);

create table if not exists public.review_wms_stock (
  id text primary key,
  batch_id text not null references public.review_batches(id) on delete cascade,
  material_code text not null,
  material_name text,
  unit text,
  current_qty numeric not null default 0,
  location text not null,
  batch text not null default 'S/L',
  warehouse text,
  raw_lines integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_recounts (
  id text primary key,
  batch_id text not null references public.review_batches(id) on delete cascade,
  item_id text not null references public.review_items(id) on delete cascade,
  material_code text not null,
  recount_qty numeric,
  verified_location text,
  result text not null default 'pendiente',
  responsible text,
  comment text,
  reviewed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id)
);

create index if not exists idx_review_batches_status on public.review_batches(status);
create index if not exists idx_review_batches_created_at on public.review_batches(created_at desc);
create index if not exists idx_review_items_batch on public.review_items(batch_id);
create index if not exists idx_review_items_material on public.review_items(material_code);
create index if not exists idx_review_items_status on public.review_items(review_status);
create index if not exists idx_review_wms_batch on public.review_wms_stock(batch_id);
create index if not exists idx_review_wms_material on public.review_wms_stock(material_code);
create index if not exists idx_review_wms_location on public.review_wms_stock(location);
create index if not exists idx_review_recounts_batch on public.review_recounts(batch_id);
create index if not exists idx_review_recounts_item on public.review_recounts(item_id);

alter table public.review_batches enable row level security;
alter table public.review_items enable row level security;
alter table public.review_wms_stock enable row level security;
alter table public.review_recounts enable row level security;

drop policy if exists "review_batches_admin_all_v23" on public.review_batches;
create policy "review_batches_admin_all_v23"
on public.review_batches
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "review_items_admin_all_v23" on public.review_items;
create policy "review_items_admin_all_v23"
on public.review_items
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "review_wms_admin_all_v23" on public.review_wms_stock;
create policy "review_wms_admin_all_v23"
on public.review_wms_stock
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

drop policy if exists "review_recounts_admin_all_v23" on public.review_recounts;
create policy "review_recounts_admin_all_v23"
on public.review_recounts
for all
to authenticated
using (public.is_admin() or public.is_admin_user())
with check (public.is_admin() or public.is_admin_user());

select pg_notify('pgrst', 'reload schema');

commit;
