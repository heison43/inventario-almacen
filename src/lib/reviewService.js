import * as XLSX from 'xlsx';
import {
  deleteLocalReviewBatchCascade,
  getReviewBatch,
  listPendingReviewBatches,
  listPendingReviewItems,
  listPendingReviewRecounts,
  listPendingReviewWmsStock,
  listReviewBatches,
  listReviewItems,
  listReviewRecounts,
  listReviewWmsStock,
  markRecordsSynced,
  replaceReviewWmsStock,
  saveReviewBatch,
  saveReviewBatches,
  saveReviewItems,
  saveReviewRecount,
  saveReviewRecounts,
  saveReviewWmsStock,
  updateReviewItem
} from './db.js';
import { buildMaterialLookup } from './reconciliation.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import { normalizeText, toNumber, uid } from './utils.js';

const PAGE_SIZE = 1000;

const CODE_ALIASES = {
  material_code: ['materiales', 'material', 'codigo de material', 'código de material', 'codigo', 'código'],
  material_name: ['descripcion del articulo', 'descripción del artículo', 'descripcion', 'descripción', 'nombre de material'],
  expected_difference: ['cantidad sobrante', 'cantidad faltante', 'diferencia', 'cantidad diferencia', 'cantidad'],
  unit_price: ['precio unitario', 'valor unitario', 'precio'],
  expected_value: ['total sobrante', 'total faltante', 'valor total', 'total diferencia', 'total']
};

const WMS_ALIASES = {
  material_code: ['codigo de material', 'código de material', 'material', 'codigo', 'código'],
  material_name: ['nombre de material', 'descripcion del articulo', 'descripción del artículo', 'descripcion', 'descripción'],
  unit: ['unidad de embalaje', 'unidad de medida', 'um', 'unidad'],
  current_qty: ['cantidad de unidad de contabilidad', 'cantidad actual', 'existencia', 'stock', 'cantidad'],
  location: ['codigo de la ubicacion de almacen', 'código de la ubicación de almacén', 'ubicacion', 'ubicación'],
  batch: ['no. de lote', 'numero de lote', 'número de lote', 'lote'],
  warehouse: ['almacen de logica erp', 'almacén de lógica erp', 'almacen', 'almacén', 'bodega']
};

function cleanCode(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return String(value).trim().replace(/\.0+$/, '');
}

function safeKey(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 220);
}

function findColumn(columns, aliases) {
  const normalized = columns.map((column) => ({ original: column, normalized: normalizeText(column) }));
  for (const alias of aliases) {
    const exact = normalized.find((column) => column.normalized === normalizeText(alias));
    if (exact) return exact.original;
  }
  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    if (normalizedAlias.length < 8) continue;
    const partial = normalized.find((column) => column.normalized.includes(normalizedAlias));
    if (partial) return partial.original;
  }
  return '';
}

function detectMapping(columns, aliasesByField) {
  return Object.fromEntries(Object.entries(aliasesByField).map(([field, aliases]) => [field, findColumn(columns, aliases)]));
}

function readField(row, column) {
  return column ? row?.[column] ?? '' : '';
}

export async function parseReviewSpreadsheet(file, type) {
  if (!file) throw new Error('Selecciona un archivo para continuar.');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const mapping = detectMapping(columns, type === 'codes' ? CODE_ALIASES : WMS_ALIASES);
  return { rows, columns, mapping, sheetName, fileName: file.name };
}

function requireMapping(mapping, fields, label) {
  const missing = fields.filter((field) => !mapping[field]);
  if (missing.length) {
    throw new Error(`${label}: no fue posible identificar las columnas obligatorias: ${missing.join(', ')}.`);
  }
}

export function normalizeReviewCodeRows(parsed, reviewType = 'sobrantes') {
  requireMapping(parsed.mapping, ['material_code', 'material_name', 'expected_difference'], 'Archivo de códigos');
  const byCode = new Map();

  parsed.rows.forEach((row, index) => {
    const code = cleanCode(readField(row, parsed.mapping.material_code));
    if (!code) return;
    const difference = toNumber(readField(row, parsed.mapping.expected_difference));
    const unitPrice = toNumber(readField(row, parsed.mapping.unit_price));
    const explicitValue = toNumber(readField(row, parsed.mapping.expected_value));
    const previous = byCode.get(code);
    const record = previous || {
      material_code: code,
      material_name: String(readField(row, parsed.mapping.material_name) || '').trim(),
      expected_difference: 0,
      unit_price: unitPrice,
      expected_value: 0,
      priority: index + 1,
      review_type: reviewType
    };
    record.expected_difference += difference;
    if (!record.material_name) record.material_name = String(readField(row, parsed.mapping.material_name) || '').trim();
    if (!record.unit_price && unitPrice) record.unit_price = unitPrice;
    record.expected_value += explicitValue || (difference * unitPrice);
    byCode.set(code, record);
  });

  return Array.from(byCode.values()).sort((a, b) => Number(a.priority) - Number(b.priority));
}

export function normalizeWmsRows(parsed, batchId, allowedCodes = null) {
  requireMapping(parsed.mapping, ['material_code', 'current_qty', 'location'], 'Archivo WMS');
  const allowed = allowedCodes ? new Set(Array.from(allowedCodes).map(cleanCode)) : null;
  const grouped = new Map();

  parsed.rows.forEach((row) => {
    const code = cleanCode(readField(row, parsed.mapping.material_code));
    if (!code || (allowed && !allowed.has(code))) return;
    const location = String(readField(row, parsed.mapping.location) || '').trim().toUpperCase();
    if (!location) return;
    const lot = String(readField(row, parsed.mapping.batch) || 'S/L').trim() || 'S/L';
    const warehouse = String(readField(row, parsed.mapping.warehouse) || '').trim();
    const key = [batchId, code, warehouse, location, lot].join('::');
    const previous = grouped.get(key);
    if (previous) {
      previous.current_qty += toNumber(readField(row, parsed.mapping.current_qty));
      previous.raw_lines += 1;
    } else {
      grouped.set(key, {
        id: `rwms_${safeKey(key)}`,
        batch_id: batchId,
        material_code: code,
        material_name: String(readField(row, parsed.mapping.material_name) || '').trim(),
        unit: String(readField(row, parsed.mapping.unit) || '').trim(),
        current_qty: toNumber(readField(row, parsed.mapping.current_qty)),
        location,
        batch: lot,
        warehouse,
        raw_lines: 1
      });
    }
  });

  return Array.from(grouped.values());
}

export async function createReviewBatchFromFiles({
  name,
  reviewType = 'sobrantes',
  responsible = '',
  notes = '',
  wmsCutAt = '',
  codesFile,
  wmsFile,
  user
}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Escribe un nombre para el grupo de revisión.');
  if (!codesFile) throw new Error('Selecciona el archivo con los códigos a revisar.');
  if (!wmsFile) throw new Error('Selecciona la descarga actual de WMS.');

  const [codesParsed, wmsParsed] = await Promise.all([
    parseReviewSpreadsheet(codesFile, 'codes'),
    parseReviewSpreadsheet(wmsFile, 'wms')
  ]);
  const normalizedCodes = normalizeReviewCodeRows(codesParsed, reviewType);
  if (!normalizedCodes.length) throw new Error('No se encontraron códigos válidos en el archivo de revisión.');

  const batchId = uid('review');
  const now = new Date().toISOString();
  const batch = {
    id: batchId,
    name: cleanName,
    review_type: reviewType,
    status: 'activa',
    responsible: String(responsible || user?.name || user?.email || '').trim(),
    notes: String(notes || '').trim(),
    wms_cut_at: wmsCutAt ? new Date(wmsCutAt).toISOString() : now,
    codes_file_name: codesFile.name,
    wms_file_name: wmsFile.name,
    created_by: user?.email || user?.name || 'local',
    created_at: now,
    updated_at: now,
    sync_status: 'pending'
  };

  const items = normalizedCodes.map((row) => ({
    id: `ritem_${safeKey(`${batchId}::${row.material_code}`)}`,
    batch_id: batchId,
    ...row,
    review_status: 'pendiente',
    sync_status: 'pending',
    created_at: now,
    updated_at: now
  }));
  const allowedCodes = new Set(items.map((row) => row.material_code));
  const wmsRows = normalizeWmsRows(wmsParsed, batchId, allowedCodes).map((row) => ({ ...row, sync_status: 'pending', created_at: now, updated_at: now }));

  await saveReviewBatch(batch);
  await saveReviewItems(items);
  await replaceReviewWmsStock(batchId, wmsRows);

  const sync = await syncReviewPendingChanges();
  return {
    batch,
    items,
    wmsRows,
    sync,
    stats: {
      codes: items.length,
      wmsRows: wmsRows.length,
      codesWithWms: new Set(wmsRows.map((row) => row.material_code)).size,
      codesWithoutWms: items.filter((item) => !wmsRows.some((row) => row.material_code === item.material_code)).length
    }
  };
}

export async function replaceReviewWmsFromFile({ batchId, wmsFile }) {
  const batch = await getReviewBatch(batchId);
  if (!batch) throw new Error('No se encontró el grupo de revisión.');
  const items = await listReviewItems(batchId);
  const parsed = await parseReviewSpreadsheet(wmsFile, 'wms');
  const now = new Date().toISOString();
  const rows = normalizeWmsRows(parsed, batchId, new Set(items.map((item) => item.material_code)))
    .map((row) => ({ ...row, sync_status: 'pending', created_at: now, updated_at: now }));
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('review_wms_stock').delete().eq('batch_id', batchId);
    if (error) throw new Error(`review_wms_stock: ${error.message}`);
  }
  await replaceReviewWmsStock(batchId, rows);
  await saveReviewBatch({ ...batch, wms_file_name: wmsFile.name, wms_cut_at: now, sync_status: 'pending' });
  const sync = await syncReviewPendingChanges();
  return { rows, sync };
}

function summarizeWmsForCode(rows) {
  const byLocation = new Map();
  for (const row of rows) {
    const key = `${row.warehouse || ''}::${row.location || ''}`;
    const current = byLocation.get(key) || {
      warehouse: row.warehouse || '',
      location: row.location || '',
      qty: 0,
      lots: []
    };
    current.qty += Number(row.current_qty || 0);
    current.lots.push({ batch: row.batch || 'S/L', qty: Number(row.current_qty || 0), raw_lines: row.raw_lines || 1 });
    byLocation.set(key, current);
  }
  return Array.from(byLocation.values()).sort((a, b) => String(a.location).localeCompare(String(b.location)));
}

export async function buildReviewBatchView(batchId) {
  const [batch, items, wmsRows, recounts] = await Promise.all([
    getReviewBatch(batchId),
    listReviewItems(batchId),
    listReviewWmsStock(batchId),
    listReviewRecounts(batchId)
  ]);
  if (!batch) return { batch: null, items: [], summary: emptyBatchSummary() };

  const wmsByCode = new Map();
  for (const row of wmsRows) {
    if (!wmsByCode.has(row.material_code)) wmsByCode.set(row.material_code, []);
    wmsByCode.get(row.material_code).push(row);
  }
  const recountByItem = new Map(recounts.map((row) => [row.item_id, row]));

  const enriched = await Promise.all(items.map(async (item) => {
    const inventory = await buildMaterialLookup(item.material_code);
    const codeWmsRows = wmsByCode.get(item.material_code) || [];
    const wmsLocations = summarizeWmsForCode(codeWmsRows);
    const wmsTotal = wmsLocations.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    const recount = recountByItem.get(item.id) || null;
    const recountQty = recount?.recount_qty;
    const currentDifference = recountQty === null || recountQty === undefined || recountQty === ''
      ? Number(inventory.summary.physical_qty || 0) - wmsTotal
      : Number(recountQty || 0) - wmsTotal;

    return {
      ...item,
      wms_total: wmsTotal,
      wms_locations: wmsLocations,
      wms_lot_rows: codeWmsRows,
      inventory_rows: inventory.rows,
      inventory_summary: inventory.summary,
      current_difference: currentDifference,
      recount
    };
  }));

  const summary = enriched.reduce((acc, item) => {
    acc.codes += 1;
    acc.expected_difference += Number(item.expected_difference || 0);
    acc.expected_value += Number(item.expected_value || 0);
    acc.wms_total += Number(item.wms_total || 0);
    acc.inventory_physical += Number(item.inventory_summary?.physical_qty || 0);
    if (item.wms_locations.length) acc.with_wms += 1;
    else acc.without_wms += 1;
    if (item.recount) acc.reviewed += 1;
    else acc.pending += 1;
    return acc;
  }, emptyBatchSummary());

  return { batch, items: enriched, summary };
}

function emptyBatchSummary() {
  return {
    codes: 0,
    with_wms: 0,
    without_wms: 0,
    reviewed: 0,
    pending: 0,
    expected_difference: 0,
    expected_value: 0,
    wms_total: 0,
    inventory_physical: 0
  };
}

export async function saveItemRecount({ item, batch, values, user }) {
  const now = new Date().toISOString();
  const record = await saveReviewRecount({
    id: `recount_${safeKey(item.id)}`,
    batch_id: batch.id,
    item_id: item.id,
    material_code: item.material_code,
    recount_qty: values.recount_qty === '' || values.recount_qty === null || values.recount_qty === undefined ? null : toNumber(values.recount_qty),
    verified_location: String(values.verified_location || '').trim().toUpperCase(),
    result: String(values.result || 'pendiente'),
    responsible: String(values.responsible || user?.name || user?.email || '').trim(),
    comment: String(values.comment || '').trim(),
    reviewed_at: now,
    created_by: user?.email || user?.name || 'local',
    sync_status: 'pending',
    created_at: now,
    updated_at: now
  });
  await updateReviewItem(item.id, { review_status: record.result || 'revisado' });
  const sync = await syncReviewPendingChanges();
  return { record, sync };
}

function stripLocal(row) {
  const { sync_status, ...clean } = row || {};
  return clean;
}

function chunkRows(rows, size = 500) {
  const chunks = [];
  for (let i = 0; i < (rows || []).length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

async function upsertChunks(table, rows) {
  let total = 0;
  for (const chunk of chunkRows(rows)) {
    const { error } = await supabase.from(table).upsert(chunk.map(stripLocal), { onConflict: 'id' });
    if (error) throw new Error(`${table}: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

async function selectAll(table) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export async function syncReviewPendingChanges() {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado. La revisión quedó guardada localmente.' };
  try {
    const [batches, items, wms, recounts] = await Promise.all([
      listPendingReviewBatches(),
      listPendingReviewItems(),
      listPendingReviewWmsStock(),
      listPendingReviewRecounts()
    ]);
    const totals = {
      batches: await upsertChunks('review_batches', batches),
      items: await upsertChunks('review_items', items),
      wms: await upsertChunks('review_wms_stock', wms),
      recounts: await upsertChunks('review_recounts', recounts)
    };
    await Promise.all([
      markRecordsSynced('review_batches', batches.map((row) => row.id)),
      markRecordsSynced('review_items', items.map((row) => row.id)),
      markRecordsSynced('review_wms_stock', wms.map((row) => row.id)),
      markRecordsSynced('review_recounts', recounts.map((row) => row.id))
    ]);
    return { ok: true, message: `Revisión sincronizada. Grupos: ${totals.batches}, códigos: ${totals.items}, WMS: ${totals.wms}, revisiones: ${totals.recounts}.`, totals };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function pullReviewFromSupabase() {
  if (!isSupabaseConfigured) return { ok: false, message: 'Supabase no está configurado.' };
  try {
    const [batches, items, wms, recounts] = await Promise.all([
      selectAll('review_batches'),
      selectAll('review_items'),
      selectAll('review_wms_stock'),
      selectAll('review_recounts')
    ]);
    await saveReviewBatches(batches.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });
    await saveReviewItems(items.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });
    await saveReviewWmsStock(wms.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });
    await saveReviewRecounts(recounts.map((row) => ({ ...row, sync_status: 'synced' })), { preservePending: true });
    return { ok: true, message: `Revisiones actualizadas. Grupos: ${batches.length}, códigos: ${items.length}, líneas WMS: ${wms.length}, verificaciones: ${recounts.length}.` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function deleteReviewBatchEverywhere(batchId) {
  if (!batchId) return { ok: false, message: 'No se recibió el grupo de revisión.' };
  try {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('review_batches').delete().eq('id', batchId);
      if (error) throw new Error(`review_batches: ${error.message}`);
    }
    const local = await deleteLocalReviewBatchCascade(batchId);
    return { ok: true, message: `Grupo eliminado. Códigos: ${local.items}, WMS: ${local.wms}, revisiones: ${local.recounts}.` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function exportReviewBatchXlsx(batchId) {
  const view = await buildReviewBatchView(batchId);
  if (!view.batch) throw new Error('No se encontró el grupo para exportar.');

  const summaryRows = view.items.map((item) => ({
    Codigo: item.material_code,
    Descripcion: item.material_name,
    Prioridad: item.priority,
    TipoRevision: item.review_type,
    DiferenciaListado: item.expected_difference,
    PrecioUnitario: item.unit_price,
    ValorDiferencia: item.expected_value,
    WMSActual: item.wms_total,
    UbicacionesWMS: item.wms_locations.map((row) => `${row.location}: ${row.qty}`).join(' | '),
    SistemaInventario: item.inventory_summary?.system_qty || 0,
    FisicoInventario: item.inventory_summary?.physical_qty || 0,
    DiferenciaInventario: item.inventory_summary?.difference || 0,
    UbicacionesConteo: item.inventory_rows.map((row) => `${row.location}: ${row.physical_qty ?? ''}`).join(' | '),
    CantidadReconteo: item.recount?.recount_qty ?? '',
    DiferenciaActual: item.current_difference,
    Resultado: item.recount?.result || 'pendiente',
    UbicacionVerificada: item.recount?.verified_location || '',
    Responsable: item.recount?.responsible || '',
    Comentario: item.recount?.comment || '',
    FechaRevision: item.recount?.reviewed_at || ''
  }));

  const wmsRows = view.items.flatMap((item) => item.wms_lot_rows.map((row) => ({
    Codigo: item.material_code,
    Descripcion: item.material_name,
    Almacen: row.warehouse,
    Ubicacion: row.location,
    Lote: row.batch,
    CantidadWMS: row.current_qty,
    UM: row.unit,
    LineasAgrupadas: row.raw_lines
  })));

  const inventoryRows = view.items.flatMap((item) => item.inventory_rows.map((row) => ({
    Codigo: item.material_code,
    Descripcion: item.material_name,
    Campaña: row.campaign_name,
    Almacen: row.warehouse,
    Zona: row.zone,
    Ubicacion: row.location,
    Grupo: row.assigned_group,
    Sistema: row.system_qty,
    Fisico: row.physical_qty ?? '',
    Diferencia: row.difference ?? '',
    Estado: row.status,
    Usuario: row.counted_by,
    Comentario: row.comment
  })));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(wmsRows), 'Detalle WMS');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(inventoryRows), 'Historial Inventario');
  XLSX.writeFile(workbook, `${safeKey(view.batch.name) || 'revision-diferencias'}.xlsx`);
}

export { listReviewBatches };
