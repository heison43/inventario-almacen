# Inventario Almacén

Sistema web responsive/PWA para conteo físico y conciliación de inventario por almacén, zona, ubicación, código y lote.

## Estado de esta versión

Versión v23 con módulo independiente de Revisión de diferencias, consulta rápida y optimizaciones de operación.

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

- Consulta rápida por código para administrador y contador.
- Revisión de diferencias por grupos de códigos prioritarios.
- Carga separada del listado a revisar y del inventario actual WMS.
- Agrupación WMS por código + ubicación, conservando detalle de lotes.
- Cruce con el historial del inventario físico existente.
- Registro de segundo conteo, resultado, ubicación verificada, responsable y comentario.
- Exportación del grupo con hojas Resumen, Detalle WMS e Historial Inventario.

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
supabase/migration_v20_counter_found_locations.sql
supabase/migration_v23_review_differences.sql
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


## Versión v13 - sincronización segura

Ajuste operativo: al sincronizar, los códigos nuevos eliminados en Supabase se limpian localmente solo si ya estaban sincronizados y no tienen cambios pendientes. No requiere migración nueva.

## v20 - Ubicación encontrada físicamente

Esta versión agrega la opción **Agregar ubicación encontrada** en la pantalla de conteo.
Sirve para crear dentro de una campaña una ubicación que no venía en la data porque en sistema estaba en cero, pero donde físicamente se encontró material.

Flujo recomendado:
1. Entrar al grupo/zona de conteo.
2. Presionar **Agregar ubicación encontrada**.
3. Escribir la ubicación real encontrada.
4. Crear la ubicación.
5. Entrar a la nueva tarjeta y usar **Agregar código nuevo** para registrar los materiales físicos.
6. Sincronizar cuando haya buena señal.

### Migración requerida

Para que los usuarios contadores puedan crear estas ubicaciones y sincronizarlas con Supabase, ejecutar una sola vez:

`supabase/migration_v20_counter_found_locations.sql`

No crea tablas nuevas. Solo ajusta la política RLS de inserción en `campaign_locations` para permitir que el contador cree ubicaciones asignadas a su propio correo.

## Versión 21 - Consulta rápida y conciliación optimizada

- Nuevo módulo administrativo **Consulta rápida** para buscar un código exacto sin cargar toda la conciliación.
- La búsqueda utiliza índices de IndexedDB y muestra únicamente las campañas y ubicaciones del código consultado.
- Botón **Actualizar base** para traer datos recientes desde Supabase una sola vez y luego consultar localmente.
- Conciliación paginada (25, 50, 100 o 250 filas) para evitar que Chrome intente renderizar decenas de miles de registros.
- La pantalla de conciliación ya no ejecuta una descarga completa de Supabase cada vez que se abre; trabaja con la base local y solo actualiza cuando el administrador lo solicita.
- Actualización local automática de IndexedDB a versión 9. No requiere migración en Supabase y no elimina información offline.


## Versión 22 - Consulta rápida para administradores y contadores

- El módulo **Consulta rápida** ahora aparece tanto en el panel administrador como en el panel contador.
- Conserva la misma búsqueda exacta por código, el resumen, el detalle por campaña/ubicación y la exportación del resultado.
- Cada usuario consulta la información disponible para su cuenta y en su base local, manteniendo las reglas actuales de acceso.
- No requiere migración nueva en Supabase y no modifica conteos, campañas ni datos offline.
