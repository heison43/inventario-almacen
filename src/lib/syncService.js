import { supabase } from './supabaseClient.js';
import { getDB } from './db.js';

// Primera versión: la app funciona 100% local. Esta función queda lista para activar
// sincronización real cuando creemos las tablas en Supabase y configuremos .env.local.
export async function syncPendingCounts() {
  if (!supabase) {
    return { ok: false, message: 'Supabase no está configurado. Trabajando en modo local.' };
  }

  const db = await getDB();
  const pending = await db.getAllFromIndex('counts', 'sync_status', 'pending');
  if (!pending.length) return { ok: true, message: 'No hay conteos pendientes por sincronizar.' };

  const payload = pending.map((count) => ({
    id: count.id,
    campaign_id: count.campaign_id,
    location_id: count.location_id,
    warehouse: count.warehouse,
    zone: count.zone,
    location: count.location,
    material_code: count.material_code,
    batch: count.batch,
    physical_qty: count.physical_qty,
    status: count.status,
    counted_by: count.counted_by,
    counted_at: count.counted_at,
    updated_at: count.updated_at
  }));

  const { error } = await supabase.from('physical_counts').upsert(payload, { onConflict: 'id' });
  if (error) return { ok: false, message: error.message };

  const tx = db.transaction('counts', 'readwrite');
  await Promise.all(pending.map((count) => tx.store.put({ ...count, sync_status: 'synced' })));
  await tx.done;

  return { ok: true, message: `${pending.length} conteos sincronizados.` };
}
