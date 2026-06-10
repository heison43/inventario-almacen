import { openDB } from 'idb';
import { uid } from './utils.js';

const DB_NAME = 'inventario-almacen-db';
const DB_VERSION = 8;

export const DEFAULT_LOCAL_USERS = [
  { id: 'usr_admin_demo', name: 'Heison Yepes', email: 'heison@empresa.com', role: 'admin', active: true, sync_status: 'local' },
  { id: 'usr_contador_demo', name: 'Contador Demo', email: 'contador@empresa.com', role: 'contador', active: true, sync_status: 'local' }
];

function ensureIndex(store, indexName, keyPath, options = {}) {
  if (!store.indexNames.contains(indexName)) {
    store.createIndex(indexName, keyPath, options);
  }
}

function getOrCreateStore(db, transaction, name, options) {
  return db.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : db.createObjectStore(name, options);
}

function createBaseStores(db, transaction) {
  const campaigns = getOrCreateStore(db, transaction, 'campaigns', { keyPath: 'id' });
  ensureIndex(campaigns, 'status', 'status');
  ensureIndex(campaigns, 'created_at', 'created_at');
  ensureIndex(campaigns, 'sync_status', 'sync_status');

  const locations = getOrCreateStore(db, transaction, 'locations', { keyPath: 'id' });
  ensureIndex(locations, 'campaign_id', 'campaign_id');
  ensureIndex(locations, 'status', 'status');
  ensureIndex(locations, 'location_key', 'location_key', { unique: true });
  ensureIndex(locations, 'sync_status', 'sync_status');

  const snapshot = getOrCreateStore(db, transaction, 'snapshot', { keyPath: 'id' });
  ensureIndex(snapshot, 'campaign_id', 'campaign_id');
  ensureIndex(snapshot, 'location_id', 'location_id');
  ensureIndex(snapshot, 'material_code', 'material_code');
  ensureIndex(snapshot, 'sync_status', 'sync_status');

  // Se conserva para compatibilidad con la versión anterior. El conteo principal es group_counts.
  const counts = getOrCreateStore(db, transaction, 'counts', { keyPath: 'id' });
  ensureIndex(counts, 'campaign_id', 'campaign_id');
  ensureIndex(counts, 'location_id', 'location_id');
  ensureIndex(counts, 'sync_status', 'sync_status');

  const groupCounts = getOrCreateStore(db, transaction, 'group_counts', { keyPath: 'id' });
  ensureIndex(groupCounts, 'campaign_id', 'campaign_id');
  ensureIndex(groupCounts, 'location_id', 'location_id');
  ensureIndex(groupCounts, 'sync_status', 'sync_status');

  const foundItems = getOrCreateStore(db, transaction, 'found_items', { keyPath: 'id' });
  ensureIndex(foundItems, 'campaign_id', 'campaign_id');
  ensureIndex(foundItems, 'location_id', 'location_id');
  ensureIndex(foundItems, 'sync_status', 'sync_status');

  const users = getOrCreateStore(db, transaction, 'users', { keyPath: 'id' });
  ensureIndex(users, 'email', 'email', { unique: true });
  ensureIndex(users, 'role', 'role');

  const authorizedUsers = getOrCreateStore(db, transaction, 'authorized_users', { keyPath: 'id' });
  ensureIndex(authorizedUsers, 'email', 'email', { unique: true });
  ensureIndex(authorizedUsers, 'role', 'role');
  ensureIndex(authorizedUsers, 'active', 'active');

  // Cola local para eliminar registros ya sincronizados cuando el usuario trabaja offline.
  const deletedRecords = getOrCreateStore(db, transaction, 'deleted_records', { keyPath: 'id' });
  ensureIndex(deletedRecords, 'table', 'table');
  ensureIndex(deletedRecords, 'sync_status', 'sync_status');
}


export async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      createBaseStores(db, transaction);
    }
  });
}

async function putMany(storeName, rows, { preservePending = false } = {}) {
  if (!rows?.length) return [];
  const db = await getDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);

  await Promise.all(rows.map(async (row) => {
    if (preservePending) {
      const existing = await store.get(row.id);
      if (existing?.sync_status === 'pending') return;
    }
    await store.put(row);
  }));

  await tx.done;
  return rows;
}

export async function markRecordsSynced(storeName, ids) {
  if (!ids?.length) return;
  const db = await getDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  await Promise.all(ids.map(async (id) => {
    const current = await store.get(id);
    if (current) await store.put({ ...current, sync_status: 'synced', updated_at: current.updated_at || new Date().toISOString() });
  }));
  await tx.done;
}

export async function ensureDefaultUsers() {
  const db = await getDB();
  const existing = await db.getAll('users');
  if (existing.length) return existing;
  const tx = db.transaction('users', 'readwrite');
  await Promise.all(DEFAULT_LOCAL_USERS.map((user) => tx.store.put({ ...user, created_at: new Date().toISOString() })));
  await tx.done;
  return DEFAULT_LOCAL_USERS;
}

export async function listAppUsers(role = '', { seedDefaults = true } = {}) {
  const db = await getDB();
  if (seedDefaults) await ensureDefaultUsers();
  const rows = role ? await db.getAllFromIndex('users', 'role', role) : await db.getAll('users');
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function replaceAppUsers(users) {
  const db = await getDB();
  const tx = db.transaction('users', 'readwrite');
  await tx.store.clear();
  await Promise.all((users || []).map((user) => tx.store.put({
    id: user.id,
    name: user.name || user.full_name,
    email: user.email,
    role: user.role || 'contador',
    active: user.active ?? true,
    sync_status: user.sync_status || 'synced',
    created_at: user.created_at || new Date().toISOString(),
    updated_at: user.updated_at || new Date().toISOString()
  })));
  await tx.done;
  return users;
}

export async function saveAppUser(user) {
  const db = await getDB();
  const record = {
    id: user.id || uid('usr'),
    name: user.name || user.full_name,
    email: user.email,
    role: user.role || 'contador',
    active: user.active ?? true,
    sync_status: user.sync_status || 'local',
    created_at: user.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await db.put('users', record);
  return record;
}

export async function saveAppUsers(users) {
  return putMany('users', users.map((user) => ({
    id: user.id,
    name: user.name || user.full_name,
    email: user.email,
    role: user.role || 'contador',
    active: user.active ?? true,
    sync_status: user.sync_status || 'synced',
    created_at: user.created_at || new Date().toISOString(),
    updated_at: user.updated_at || new Date().toISOString()
  })));
}

export async function saveAuthorizedUsers(users) {
  return putMany('authorized_users', (users || []).map((user) => ({
    id: user.id,
    name: user.name || user.full_name,
    full_name: user.full_name || user.name,
    email: user.email,
    role: user.role || 'contador',
    active: user.active ?? true,
    claimed_by: user.claimed_by || null,
    claimed_at: user.claimed_at || null,
    sync_status: user.sync_status || 'synced',
    created_at: user.created_at || new Date().toISOString(),
    updated_at: user.updated_at || new Date().toISOString()
  })));
}

export async function listAuthorizedUsers() {
  const db = await getDB();
  const rows = await db.getAll('authorized_users');
  return rows.sort((a, b) => String(a.email).localeCompare(String(b.email)));
}


export async function saveCampaign(campaign) {
  const db = await getDB();
  const record = {
    ...campaign,
    sync_status: campaign.sync_status || 'pending',
    updated_at: campaign.updated_at || new Date().toISOString()
  };
  await db.put('campaigns', record);
  return record;
}

export async function saveCampaigns(campaigns) {
  return putMany('campaigns', campaigns);
}

export async function listCampaigns() {
  const db = await getDB();
  const rows = await db.getAll('campaigns');
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getCampaign(id) {
  const db = await getDB();
  return db.get('campaigns', id);
}

export async function saveLocations(locations) {
  const rows = locations.map((location) => ({
    ...location,
    sync_status: location.sync_status || 'pending',
    updated_at: location.updated_at || new Date().toISOString()
  }));
  return putMany('locations', rows);
}

export async function listLocations(campaignId) {
  const db = await getDB();
  const rows = await db.getAllFromIndex('locations', 'campaign_id', campaignId);
  return rows.sort((a, b) => String(a.location).localeCompare(String(b.location)));
}

export async function getLocation(id) {
  const db = await getDB();
  return db.get('locations', id);
}

export async function updateLocation(id, changes) {
  const db = await getDB();
  const current = await db.get('locations', id);
  if (!current) return null;
  const updated = {
    ...current,
    ...changes,
    sync_status: changes.sync_status || 'pending',
    updated_at: new Date().toISOString()
  };
  await db.put('locations', updated);
  return updated;
}

export async function updateLocationsBulk(updates = []) {
  if (!updates.length) return [];
  const db = await getDB();
  const tx = db.transaction('locations', 'readwrite');
  const store = tx.objectStore('locations');
  const now = new Date().toISOString();
  const updatedRows = [];

  for (const update of updates) {
    const id = update?.id;
    if (!id) continue;
    const current = await store.get(id);
    if (!current) continue;
    const changes = update.changes || {};
    const updated = {
      ...current,
      ...changes,
      sync_status: changes.sync_status || 'pending',
      updated_at: now
    };
    await store.put(updated);
    updatedRows.push(updated);
  }

  await tx.done;
  return updatedRows;
}

export async function listPendingLocations() {
  const db = await getDB();
  return db.getAllFromIndex('locations', 'sync_status', 'pending');
}

export async function saveSnapshotItems(items) {
  const rows = items.map((item) => ({ ...item, sync_status: item.sync_status || 'pending' }));
  return putMany('snapshot', rows);
}

export async function listSnapshotByLocation(locationId) {
  const db = await getDB();
  return db.getAllFromIndex('snapshot', 'location_id', locationId);
}

export async function listSnapshotByCampaign(campaignId) {
  const db = await getDB();
  return db.getAllFromIndex('snapshot', 'campaign_id', campaignId);
}

export async function saveInitialCounts(snapshotItems) {
  const db = await getDB();
  const tx = db.transaction('counts', 'readwrite');
  await Promise.all(
    snapshotItems.map((item) => tx.store.put({
      id: item.id,
      campaign_id: item.campaign_id,
      location_id: item.location_id,
      warehouse: item.warehouse,
      zone: item.zone,
      location: item.location,
      material_code: item.material_code,
      batch: item.batch,
      physical_qty: null,
      status: 'pendiente',
      sync_status: 'local',
      counted_by: null,
      counted_at: null,
      updated_at: new Date().toISOString()
    }))
  );
  await tx.done;
}

export async function getCount(id) {
  const db = await getDB();
  return db.get('counts', id);
}

export async function listCountsByLocation(locationId) {
  const db = await getDB();
  return db.getAllFromIndex('counts', 'location_id', locationId);
}

export async function listCountsByCampaign(campaignId) {
  const db = await getDB();
  return db.getAllFromIndex('counts', 'campaign_id', campaignId);
}

export async function updateCount(id, changes) {
  const db = await getDB();
  const current = await db.get('counts', id);
  if (!current) return null;
  const updated = {
    ...current,
    ...changes,
    sync_status: 'pending',
    updated_at: new Date().toISOString()
  };
  await db.put('counts', updated);
  return updated;
}

export function buildGroupCountId({ campaign_id, location_id, warehouse, zone, location, material_code, unit }) {
  return [campaign_id, location_id, warehouse, zone, location, material_code, unit || ''].map((value) => String(value ?? '').trim()).join('::');
}

export async function listGroupCountsByLocation(locationId) {
  const db = await getDB();
  return db.getAllFromIndex('group_counts', 'location_id', locationId);
}

export async function listGroupCountsByCampaign(campaignId) {
  const db = await getDB();
  return db.getAllFromIndex('group_counts', 'campaign_id', campaignId);
}

export async function saveGroupCounts(rows, options = {}) {
  return putMany('group_counts', rows, options);
}

export async function listPendingGroupCounts() {
  const db = await getDB();
  return db.getAllFromIndex('group_counts', 'sync_status', 'pending');
}

export async function updateGroupCount(group, changes) {
  const db = await getDB();
  const id = group.id || buildGroupCountId(group);
  const current = await db.get('group_counts', id);
  const now = new Date().toISOString();
  const updated = {
    ...(current || {
      id,
      campaign_id: group.campaign_id,
      location_id: group.location_id,
      warehouse: group.warehouse,
      zone: group.zone,
      location: group.location,
      material_code: group.material_code,
      material_name: group.material_name,
      material_name_cn: group.material_name_cn || '',
      unit: group.unit,
      material_condition: group.material_condition || 'buen_estado',
      condition_qty: group.condition_qty ?? 0,
      comment: group.comment || '',
      created_at: now
    }),
    ...changes,
    id,
    sync_status: 'pending',
    updated_at: now
  };
  await db.put('group_counts', updated);
  return updated;
}

export async function saveFoundItem(item) {
  const db = await getDB();
  const record = {
    id: item.id || uid('found'),
    ...item,
    system_qty: 0,
    material_condition: item.material_condition || 'buen_estado',
    condition_qty: item.condition_qty ?? 0,
    comment: item.comment || '',
    sync_status: item.sync_status || 'pending',
    created_at: item.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await db.put('found_items', record);
  return record;
}

export async function saveFoundItems(rows, options = {}) {
  return putMany('found_items', rows, options);
}

export async function listPendingFoundItems() {
  const db = await getDB();
  return db.getAllFromIndex('found_items', 'sync_status', 'pending');
}

export async function listFoundItemsByCampaign(campaignId) {
  const db = await getDB();
  return db.getAllFromIndex('found_items', 'campaign_id', campaignId);
}

export async function listFoundItemsByLocation(locationId) {
  const db = await getDB();
  return db.getAllFromIndex('found_items', 'location_id', locationId);
}



export async function pruneSyncedFoundItemsMissingFromRemote(remoteIds, { excludeIds = [], locationIds = null } = {}) {
  const remoteSet = remoteIds instanceof Set ? remoteIds : new Set(remoteIds || []);
  const excludeSet = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const locationSet = locationIds ? (locationIds instanceof Set ? locationIds : new Set(locationIds || [])) : null;
  const db = await getDB();
  const tx = db.transaction('found_items', 'readwrite');
  const rows = await tx.store.getAll();
  let deleted = 0;

  await Promise.all(rows.map(async (row) => {
    // Protección crítica: nunca eliminar registros creados/editados localmente
    // que todavía no han sido sincronizados. Solo se limpian registros que
    // ya estaban en estado synced y desaparecieron de Supabase.
    if (locationSet && !locationSet.has(row.location_id)) return;
    if (row?.sync_status === 'synced' && !remoteSet.has(row.id) && !excludeSet.has(row.id)) {
      await tx.store.delete(row.id);
      deleted += 1;
    }
  }));

  await tx.done;
  return deleted;
}


export async function listLocationSyncStates(locationIds = []) {
  const ids = Array.from(new Set((locationIds || []).filter(Boolean)));
  if (!ids.length) return {};

  const idSet = new Set(ids);
  const states = new Map(ids.map((id) => [id, {
    pending: 0,
    synced: true,
    details: { location: 0, counts: 0, found: 0, deleted: 0 }
  }]));

  function addPending(locationId, type) {
    if (!idSet.has(locationId)) return;
    const current = states.get(locationId) || {
      pending: 0,
      synced: true,
      details: { location: 0, counts: 0, found: 0, deleted: 0 }
    };
    current.pending += 1;
    current.synced = false;
    current.details[type] = (current.details[type] || 0) + 1;
    states.set(locationId, current);
  }

  const db = await getDB();
  const tx = db.transaction(['locations', 'group_counts', 'found_items', 'deleted_records'], 'readonly');

  const [pendingLocations, pendingCounts, pendingFound, pendingDeleted] = await Promise.all([
    tx.objectStore('locations').index('sync_status').getAll('pending'),
    tx.objectStore('group_counts').index('sync_status').getAll('pending'),
    tx.objectStore('found_items').index('sync_status').getAll('pending'),
    tx.objectStore('deleted_records').index('sync_status').getAll('pending')
  ]);

  pendingLocations.forEach((row) => addPending(row.location_id || row.id, 'location'));
  pendingCounts.forEach((row) => addPending(row.location_id, 'counts'));
  pendingFound.forEach((row) => addPending(row.location_id, 'found'));
  pendingDeleted.forEach((row) => addPending(row.location_id, 'deleted'));

  await tx.done;
  return Object.fromEntries(states.entries());
}

export async function deleteFoundItem(id, { queueRemote = true } = {}) {
  const db = await getDB();
  const tx = db.transaction(['found_items', 'deleted_records'], 'readwrite');
  const foundStore = tx.objectStore('found_items');
  const deletedStore = tx.objectStore('deleted_records');
  const current = await foundStore.get(id);
  if (!current) {
    await tx.done;
    return null;
  }

  // Si el registro ya pudo haber llegado a Supabase, dejamos una marca local
  // para que la siguiente sincronización lo elimine también en la nube.
  if (queueRemote) {
    await deletedStore.put({
      id: `found_items::${id}`,
      table: 'found_items',
      record_id: id,
      campaign_id: current.campaign_id,
      location_id: current.location_id,
      location: current.location,
      material_code: current.material_code,
      sync_status: 'pending',
      created_at: new Date().toISOString()
    });
  }

  await foundStore.delete(id);
  await tx.done;
  return current;
}

export async function listPendingDeletedRecords() {
  const db = await getDB();
  return db.getAllFromIndex('deleted_records', 'sync_status', 'pending');
}

export async function clearDeletedRecords(ids) {
  if (!ids?.length) return;
  const db = await getDB();
  const tx = db.transaction('deleted_records', 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

export async function clearLocalDatabase() {
  const db = await getDB();
  const stores = ['campaigns', 'locations', 'snapshot', 'counts', 'group_counts', 'found_items', 'deleted_records'];
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((store) => tx.objectStore(store).clear()));
  await tx.done;
}


export async function deleteLocalCampaignCascade(campaignId) {
  if (!campaignId) return { campaigns: 0, locations: 0, snapshot: 0, group_counts: 0, found_items: 0, counts: 0 };
  const db = await getDB();
  const stores = ['campaigns', 'locations', 'snapshot', 'counts', 'group_counts', 'found_items', 'deleted_records'];
  const tx = db.transaction(stores, 'readwrite');

  const locations = await tx.objectStore('locations').index('campaign_id').getAll(campaignId);
  const locationIds = new Set(locations.map((location) => location.id));
  const snapshot = await tx.objectStore('snapshot').index('campaign_id').getAll(campaignId);
  const counts = await tx.objectStore('counts').index('campaign_id').getAll(campaignId);
  const groupCounts = await tx.objectStore('group_counts').index('campaign_id').getAll(campaignId);
  const foundItems = await tx.objectStore('found_items').index('campaign_id').getAll(campaignId);
  const deletedRecords = await tx.objectStore('deleted_records').getAll();

  await tx.objectStore('campaigns').delete(campaignId);
  await Promise.all(locations.map((row) => tx.objectStore('locations').delete(row.id)));
  await Promise.all(snapshot.map((row) => tx.objectStore('snapshot').delete(row.id)));
  await Promise.all(counts.map((row) => tx.objectStore('counts').delete(row.id)));
  await Promise.all(groupCounts.map((row) => tx.objectStore('group_counts').delete(row.id)));
  await Promise.all(foundItems.map((row) => tx.objectStore('found_items').delete(row.id)));

  // Limpia marcas de borrado locales asociadas a códigos nuevos de la campaña eliminada.
  await Promise.all(deletedRecords.map(async (row) => {
    const recordId = row?.record_id || '';
    const belongsToDeletedLocation = row?.location_id && locationIds.has(row.location_id);
    const belongsToDeletedFound = foundItems.some((item) => item.id === recordId);
    if (belongsToDeletedLocation || belongsToDeletedFound) {
      await tx.objectStore('deleted_records').delete(row.id);
    }
  }));

  await tx.done;
  return {
    campaigns: 1,
    locations: locations.length,
    snapshot: snapshot.length,
    counts: counts.length,
    group_counts: groupCounts.length,
    found_items: foundItems.length
  };
}
