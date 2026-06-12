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
  saveSnapshotItems,
  deleteLocalCampaignCascade
} from './db.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const PAGE_SIZE = 1000;
const IN_FILTER_CHUNK = 120;

function chunkRows(rows, size = 500) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function stripLocalFields(row) {
  const { sync_status, created_from_physical, local_only, sync_error, ...clean } = row || {};
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

async function selectAllByLocationIds(table, locationIds, columns = '*') {
  const ids = unique(locationIds);
  if (!ids.length) return [];
  const results = [];

  for (const idChunk of chunkRows(ids, IN_FILTER_CHUNK)) {
    const rows = await selectAll(table, columns, (query) => query.in('location_id', idChunk));
    results.push(...rows);
  }

  return results;
}

function allowedLocationsForUser(locations, user) {
  if (!user?.email || user?.role === 'admin') return locations || [];
  const email = String(user.email || '').trim().toLowerCase();
  return (locations || []).filter((location) => {
    const assigned = String(location.assigned_to || '').trim().toLowerCase();
    return !assigned || assigned === email;
  });
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

    const manualLocations = pendingLocations.filter((row) => row.created_from_physical || String(row.id || '').startsWith('loc_found_'));
    const regularLocations = pendingLocations.filter((row) => !manualLocations.some((manual) => manual.id === row.id));
    const manualLocationPayload = manualLocations.map(stripLocalFields);
    const regularLocationPayload = regularLocations.map(stripLocalFields);
    const foundDeleteIds = pendingDeletes
      .filter((row) => row.table === 'found_items')
      .map((row) => row.record_id)
      .filter(Boolean);

    // Las ubicaciones normales ya se crean durante la importación de la campaña,
    // por eso se actualizan con UPDATE. Las ubicaciones encontradas físicamente
    // sí deben insertarse si no existían en Supabase.
    const insertedManualLocations = await upsertInChunks('campaign_locations', manualLocationPayload, { onConflict: 'id' });
    const updatedRegularLocations = await updateInChunks('campaign_locations', regularLocationPayload);
    const syncedLocations = insertedManualLocations + updatedRegularLocations;
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


async function countRows(table, applyFilters) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (applyFilters) query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count || 0;
}

export async function deleteCampaignEverywhere(campaignId, { allowWithCounts = false } = {}) {
  if (!campaignId) return { ok: false, message: 'No se recibió campaña para eliminar.' };

  try {
    if (isSupabaseConfigured) {
      const [countedRows, foundRows] = await Promise.all([
        countRows('group_counts', (query) => query.eq('campaign_id', campaignId)),
        countRows('found_items', (query) => query.eq('campaign_id', campaignId))
      ]);

      if (!allowWithCounts && (countedRows > 0 || foundRows > 0)) {
        return {
          ok: false,
          message: `No se eliminó la campaña porque ya tiene conteos o códigos nuevos sincronizados. Conteos: ${countedRows}, nuevos: ${foundRows}.`
        };
      }

      const { error } = await supabase.from('campaigns').delete().eq('id', campaignId);
      if (error) throw new Error(`campaigns: ${error.message}`);
    }

    const local = await deleteLocalCampaignCascade(campaignId);
    return {
      ok: true,
      message: `Campaña eliminada. Ubicaciones: ${local.locations}, base: ${local.snapshot}, conteos locales: ${local.group_counts}, nuevos locales: ${local.found_items}.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function saveRemoteBundle({ profiles, authorizedUsers, campaigns, locations, snapshot, groupCounts, foundItems, pendingDeletes, pruneLocationIds = null }) {
  if (profiles) {
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
  }

  if (authorizedUsers) {
    await saveAuthorizedUsers(authorizedUsers.map((row) => ({ ...row, sync_status: 'synced' })));
  }

  if (campaigns) await saveCampaigns(campaigns.map((row) => ({ ...row, sync_status: 'synced' })));
  if (locations) await saveLocations(locations.map((row) => ({ ...row, sync_status: 'synced' })));
  if (snapshot) await saveSnapshotItems(snapshot.map((row) => ({ ...row, sync_status: 'synced' })));
  if (groupCounts) await saveGroupCounts(groupCounts.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });

  if (foundItems) {
    const locallyDeletedIds = new Set((pendingDeletes || []).filter((row) => row.table === 'found_items').map((row) => row.record_id));
    await saveFoundItems(
      foundItems
        .filter((row) => !locallyDeletedIds.has(row.id))
        .map((row) => ({ ...row, sync_status: 'synced' })),
      { preservePending: true }
    );

    const remoteFoundIds = new Set(foundItems.map((row) => row.id));
    const scopedLocationIds = pruneLocationIds || (locations ? locations.map((location) => location.id) : foundItems.map((row) => row.location_id));
    const prunedFoundItems = await pruneSyncedFoundItemsMissingFromRemote(remoteFoundIds, {
      excludeIds: locallyDeletedIds,
      locationIds: scopedLocationIds
    });
    return prunedFoundItems;
  }

  return 0;
}

export async function pullFromSupabase(user = null) {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado.' };

  try {
    // Hotfix operación: primero traemos tablas livianas. Después, las tablas pesadas
    // se consultan solo por las ubicaciones visibles/asignadas. Esto evita timeouts
    // en inventory_snapshot y group_counts cuando ya existen muchas campañas.
    const [profiles, authorizedUsers, campaigns, locations, pendingDeletes] = await Promise.all([
      selectAll('profiles', 'id, full_name, email, role, active, created_at, updated_at'),
      selectAll('authorized_users', 'id, full_name, email, role, active, claimed_by, claimed_at, created_at, updated_at'),
      selectAll('campaigns'),
      selectAll('campaign_locations'),
      listPendingDeletedRecords()
    ]);

    const scopedLocations = allowedLocationsForUser(locations, user);
    const scopedLocationIds = scopedLocations.map((location) => location.id);

    const [snapshot, groupCounts, foundItems] = await Promise.all([
      selectAllByLocationIds('inventory_snapshot', scopedLocationIds),
      selectAllByLocationIds('group_counts', scopedLocationIds),
      selectAllByLocationIds('found_items', scopedLocationIds)
    ]);

    const prunedFoundItems = await saveRemoteBundle({
      profiles,
      authorizedUsers,
      campaigns,
      locations,
      snapshot,
      groupCounts,
      foundItems,
      pendingDeletes
    });

    return {
      ok: true,
      message: `Datos actualizados desde Supabase. Campañas: ${campaigns.length}, ubicaciones: ${locations.length}, base descargada: ${snapshot.length}, conteos remotos: ${groupCounts.length}, nuevos limpiados: ${prunedFoundItems}.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function pullLocationFromSupabase(locationId) {
  if (!isSupabaseConfigured || !locationId) return { ok: false, message: 'Supabase no está configurado.' };

  try {
    const [snapshot, groupCounts, foundItems, pendingDeletes] = await Promise.all([
      selectAll('inventory_snapshot', '*', (query) => query.eq('location_id', locationId)),
      selectAll('group_counts', '*', (query) => query.eq('location_id', locationId)),
      selectAll('found_items', '*', (query) => query.eq('location_id', locationId)),
      listPendingDeletedRecords()
    ]);

    const prunedFoundItems = await saveRemoteBundle({
      snapshot,
      groupCounts,
      foundItems,
      pendingDeletes,
      pruneLocationIds: [locationId]
    });

    return {
      ok: true,
      message: `Ubicación actualizada. Base: ${snapshot.length}, conteos: ${groupCounts.length}, nuevos limpiados: ${prunedFoundItems}.`
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
