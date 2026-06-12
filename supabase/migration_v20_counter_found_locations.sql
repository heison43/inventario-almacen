-- v20 - Permitir que el contador cree ubicaciones encontradas físicamente.
-- Uso: cuando una ubicación no venía en la data porque en sistema estaba en cero,
-- el contador puede crearla dentro de la campaña y agregar códigos nuevos.

begin;

drop policy if exists "locations_admin_insert" on public.campaign_locations;

create policy "locations_admin_insert"
on public.campaign_locations
for insert
to authenticated
with check (
  public.is_admin()
  or public.is_admin_user()
  or lower(assigned_to) = lower(auth.email())
);

commit;
