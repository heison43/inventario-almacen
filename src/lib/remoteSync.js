import {
  listPendingDeletedRecords,
  listPendingFoundItems,
  listPendingGroupCounts,
  listPendingLocations,
  markRecordsSynced,
  clearDeletedRecords,
  replaceAppUsers,
  saveAuthorizedUsers,
  saveCampaigns,
  saveFoundItems,
  saveGroupCounts,
  saveLocations,
  pruneSyncedFoundItemsMissingFromRemote,
  saveSnapshotItems
} from './db.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const PAGE_SIZE = 1000;

function chunkRows(rows, size = 500) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}


function stripLocalFields(row) {
  const { sync_status, ...clean } = row || {};
  return clean;
}

async function updateInChunks(table, rows) {
  if (!rows?.length) return 0;
  let total = 0;
  for (const row of rows) {
    const { id, sync_status, created_at, ...patch } = row;
    if (!id) continue;
    const { error } = await supabase.from(table).update(patch).eq('id', id);
    if (error) throw new Error(`${table}: ${error.message}`);
    total += 1;
  }
  return total;
}

async function deleteInChunks(table, ids) {
  if (!ids?.length) return 0;
  let total = 0;
  for (const chunk of chunkRows(ids, 250)) {
    const { error } = await supabase.from(table).delete().in('id', chunk);
    if (error) throw new Error(`${table}: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

async function upsertInChunks(table, rows, options = {}) {
  if (!rows?.length) return 0;
  let total = 0;
  for (const chunk of chunkRows(rows)) {
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) throw new Error(`${table}: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

async function selectAll(table, columns = '*', applyFilters) {
  let from = 0;
  let allRows = [];

  while (true) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data || [];
    allRows = allRows.concat(rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allRows;
}

export async function pushCampaignBundle({ campaign, locations, snapshotItems }) {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado.' };

  try {
    await upsertInChunks('campaigns', [stripLocalFields(campaign)], { onConflict: 'id' });
    await upsertInChunks('campaign_locations', locations.map(stripLocalFields), { onConflict: 'id' });
    await upsertInChunks('inventory_snapshot', snapshotItems.map(stripLocalFields), { onConflict: 'id' });

    await markRecordsSynced('campaigns', [campaign.id]);
    await markRecordsSynced('locations', locations.map((row) => row.id));
    await markRecordsSynced('snapshot', snapshotItems.map((row) => row.id));

    return {
      ok: true,
      message: `Campaña sincronizada en Supabase: ${locations.length} ubicaciones y ${snapshotItems.length} registros base.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function syncPendingChanges(user) {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado.' };

  try {
    const [pendingGroups, pendingFound, pendingLocations, pendingDeletes] = await Promise.all([
      listPendingGroupCounts(),
      listPendingFoundItems(),
      listPendingLocations(),
      listPendingDeletedRecords()
    ]);

    const groupPayload = pendingGroups.map(({ sync_status, created_at, ...row }) => ({
      ...row,
      counted_by: row.counted_by || user?.email || '',
      updated_at: row.updated_at || new Date().toISOString()
    }));

    const foundPayload = pendingFound.map(({ sync_status, ...row }) => ({
      ...row,
      registered_by: row.registered_by || user?.email || '',
      updated_at: row.updated_at || new Date().toISOString()
    }));

    const locationPayload = pendingLocations.map(stripLocalFields);
    const foundDeleteIds = pendingDeletes
      .filter((row) => row.table === 'found_items')
      .map((row) => row.record_id)
      .filter(Boolean);

    // Admin puede crear/actualizar ubicaciones. El contador solo actualiza estado
    // de ubicaciones existentes para evitar errores de RLS por intentos de INSERT.
    const syncedLocations = user?.role === 'admin'
      ? await upsertInChunks('campaign_locations', locationPayload, { onConflict: 'id' })
      : await updateInChunks('campaign_locations', locationPayload);
    const syncedGroups = await upsertInChunks('group_counts', groupPayload, { onConflict: 'id' });
    const syncedFound = await upsertInChunks('found_items', foundPayload, { onConflict: 'id' });
    const deletedFound = await deleteInChunks('found_items', foundDeleteIds);

    await markRecordsSynced('locations', pendingLocations.map((row) => row.id));
    await markRecordsSynced('group_counts', pendingGroups.map((row) => row.id));
    await markRecordsSynced('found_items', pendingFound.map((row) => row.id));
    await clearDeletedRecords(pendingDeletes.map((row) => row.id));

    return {
      ok: true,
      message: `Sincronización lista. Conteos: ${syncedGroups}, nuevos: ${syncedFound}, eliminados: ${deletedFound}, ubicaciones: ${syncedLocations}.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function pullFromSupabase() {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado.' };

  try {
    const [profiles, authorizedUsers, campaigns, locations, snapshot, groupCounts, foundItems, pendingDeletes] = await Promise.all([
      selectAll('profiles', 'id, full_name, email, role, active, created_at, updated_at'),
      selectAll('authorized_users', 'id, full_name, email, role, active, claimed_by, claimed_at, created_at, updated_at'),
      selectAll('campaigns'),
      selectAll('campaign_locations'),
      selectAll('inventory_snapshot'),
      selectAll('group_counts'),
      selectAll('found_items'),
      listPendingDeletedRecords()
    ]);

    await replaceAppUsers(profiles.map((profile) => ({
      id: profile.id,
      name: profile.full_name,
      email: profile.email,
      role: profile.role,
      active: profile.active,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      sync_status: 'synced'
    })));
    await saveAuthorizedUsers(authorizedUsers.map((row) => ({ ...row, sync_status: 'synced' })));
    await saveCampaigns(campaigns.map((row) => ({ ...row, sync_status: 'synced' }))); 
    await saveLocations(locations.map((row) => ({ ...row, sync_status: 'synced' })));
    await saveSnapshotItems(snapshot.map((row) => ({ ...row, sync_status: 'synced' })));
    await saveGroupCounts(groupCounts.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });
    const locallyDeletedIds = new Set(pendingDeletes.filter((row) => row.table === 'found_items').map((row) => row.record_id));
    await saveFoundItems(
      foundItems
        .filter((row) => !locallyDeletedIds.has(row.id))
        .map((row) => ({ ...row, sync_status: 'synced' })),
      { preservePending: true }
    );

    const remoteFoundIds = new Set(foundItems.map((row) => row.id));
    const prunedFoundItems = await pruneSyncedFoundItemsMissingFromRemote(remoteFoundIds, {
      excludeIds: locallyDeletedIds
    });

    return {
      ok: true,
      message: `Datos actualizados desde Supabase. Usuarios autorizados: ${authorizedUsers.length}, campañas: ${campaigns.length}, ubicaciones: ${locations.length}, base: ${snapshot.length}, nuevos limpiados: ${prunedFoundItems}.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
