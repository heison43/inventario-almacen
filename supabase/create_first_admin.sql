-- Plantilla para crear el primer administrador.
-- Paso previo: en Supabase Dashboard > Authentication > Users crea el usuario con correo y contraseña.
-- Luego copia el UUID del usuario y reemplaza los valores de abajo.

insert into public.profiles (id, full_name, email, role, active)
values (
  'REEMPLAZA_UUID_DEL_USUARIO'::uuid,
  'Heison Yepes',
  'correo@empresa.com',
  'admin',
  true
)
on conflict (id) do update set
  full_name = excluded.full_name,
  email = excluded.email,
  role = excluded.role,
  active = excluded.active,
  updated_at = now();
