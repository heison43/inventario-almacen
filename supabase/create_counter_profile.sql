-- Plantilla para autorizar un contador sin copiar el UUID manualmente.
-- Paso previo: crea el usuario en Supabase Authentication.
-- Luego cambia el correo y nombre de este script y ejecútalo en SQL Editor.

insert into public.profiles (id, full_name, email, role, active)
select
  au.id,
  'Contador Prueba',
  au.email,
  'contador'::public.user_role,
  true
from auth.users au
where lower(au.email) = lower('prueba04@mail.com')
on conflict (id) do update set
  full_name = excluded.full_name,
  email = excluded.email,
  role = excluded.role,
  active = excluded.active,
  updated_at = now();

-- Si el resultado es 0 filas afectadas, revisa que el correo exista primero en Authentication > Users.
