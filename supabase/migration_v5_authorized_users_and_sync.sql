-- Inventario Almacén v5
-- Ejecuta este archivo una sola vez si ya habías corrido schema.sql de la v3/v4.
-- Agrega autorización previa de correos, registro automático y ajuste de vista de conciliación.

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

create index if not exists idx_authorized_users_email on public.authorized_users(email);
create index if not exists idx_authorized_users_role on public.authorized_users(role);

alter table public.authorized_users enable row level security;

drop policy if exists "authorized_users_select_admin_or_self" on public.authorized_users;
drop policy if exists "authorized_users_admin_write" on public.authorized_users;

create policy "authorized_users_select_admin_or_self"
on public.authorized_users
for select
to authenticated
using (public.is_admin() or lower(email) = lower(auth.email()));

create policy "authorized_users_admin_write"
on public.authorized_users
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

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

-- Recomendado: hace que la vista respete RLS del usuario que consulta.
alter view public.v_reconciliation set (security_invoker = true);
