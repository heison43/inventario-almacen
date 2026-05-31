# Inventario Almacén

Sistema web responsive/PWA para conteo físico y conciliación de inventario por almacén, zona, ubicación, código y lote.

## Estado de esta versión

Versión v11 con solicitante visible en conteo y conciliación sin detalle de lotes.

Incluye:

- Login con Supabase Auth.
- Roles simples: `admin` y `contador`.
- Autorización de usuarios desde el panel web.
- Registro del usuario con correo previamente autorizado.
- Conteo offline con IndexedDB.
- Sincronización con Supabase PostgreSQL.
- Carga de inventario por zona desde la plantilla oficial: Codigo de material, Descripción del Articulo, Descripcion en Chino, UM, Suma de Inventario total, Ubicación, Departamento Solicitante y Almacen.
- Cálculo automático de zona desde la ubicación.
- Conteo agrupado por código y unidad.
- Detalle de lotes desplegable.
- Registro de código nuevo encontrado con cantidad sistema en 0.
- Campos de conteo: cantidad física, estado físico, cantidad afectada y comentario.
- Asignación de ubicaciones por contador y grupo (`grupo1` a `grupo10`).
- Tarjetas de ubicación coloreadas por grupo y estado.
- Filtros por usuario, grupo, ubicación y estado.
- Conciliación y exportación a Excel.
- PWA configurada con manifest, service worker, favicon, apple-touch-icon e íconos de instalación.

## Instalación local

```bash
npm install
npm run dev
```

Abre:

```text
http://localhost:5173
```

## Variables de entorno

Copia `.env.example` como `.env.local`:

```env
VITE_SUPABASE_URL=https://TU_PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=TU_ANON_KEY_PUBLICA
```

No uses la clave `service_role` en el frontend.

## Base de datos Supabase

Si instalas desde cero, ejecuta primero:

```text
supabase/schema.sql
```

Luego ejecuta las migraciones en este orden:

```text
supabase/migration_v5_authorized_users_and_sync.sql
supabase/migration_v6_groups_condition_comments.sql
supabase/migration_v7_filters_export_zone_rls.sql
supabase/migration_v8_export_finish_zone_cards.sql
supabase/migration_v10_plantilla_oficial.sql
```

Si ya tenías la v8 funcionando, ejecuta únicamente `supabase/migration_v10_plantilla_oficial.sql` para agregar el campo de descripción en chino y actualizar la vista de conciliación.

## Flujo de usuarios

1. El administrador entra al panel.
2. Va a `Usuarios`.
3. Autoriza nombre, correo y tipo de usuario: `admin` o `contador`.
4. El usuario abre la pantalla de ingreso.
5. Selecciona `Registrarme`.
6. Usa el mismo correo autorizado y crea su contraseña.
7. El sistema crea automáticamente su perfil en `profiles`.

Si Supabase exige confirmación de correo, el usuario debe confirmar el correo y luego iniciar sesión.

## Prueba recomendada antes de producción

1. Entrar como admin.
2. Autorizar un contador desde `Usuarios`.
3. Cargar una zona pequeña.
4. Confirmar que `inventory_snapshot` tenga registros en Supabase.
5. Asignar ubicaciones al contador y a un grupo.
6. Entrar como contador.
7. Contar todos los códigos de una ubicación.
8. Intentar finalizar ubicación con pendientes para confirmar que se bloquea.
9. Finalizar ubicación cuando todo esté contado.
10. Sincronizar.
11. Revisar conciliación como admin.
12. Exportar Excel.
13. Probar modo offline: abrir ubicación, quitar internet, contar, cerrar/abrir navegador, reconectar y sincronizar.

## Despliegue en Vercel

1. Sube este proyecto a GitHub.
2. Importa el repositorio en Vercel.
3. En `Project Settings > Environment Variables`, agrega:

```env
VITE_SUPABASE_URL=https://TU_PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=TU_ANON_KEY_PUBLICA
```

4. Build command:

```bash
npm run build
```

5. Output directory:

```text
dist
```

6. Después puedes conectar un dominio o subdominio, por ejemplo:

```text
inventario.tudominio.com
```

## Notas importantes de producción

- No borres datos del navegador si hay conteos pendientes por sincronizar.
- Antes de iniciar una zona real, asegúrate de que el archivo cargado corresponda a la zona bloqueada para conteo.
- La conciliación se realiza contra la foto del inventario cargada en `inventory_snapshot`.
- Los datos de prueba se deben eliminar desde Supabase antes de iniciar el inventario real.
