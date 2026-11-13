import * as XLSX from 'xlsx';
import { openDB } from 'idb';

const DB_NAME = 'inventario-almacen-consulta-sap-wms-v1';
const dbPromise = openDB(DB_NAME, 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('reports')) {
      db.createObjectStore('reports', { keyPath: 'id' });
    }
  }
});
export const normalizeCode = (value) => {
  const str = String(value ?? '').trim().replace(/\.0$/, '');
  return /^\d+$/.test(str) ? (str.replace(/^0+/, '') || '0') : str.toUpperCase();
};
export const normalizeSearch = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const formatQty = (value) =>
  new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(value ?? 0);

const aliases = {
  code: ['codigo de material', 'código material', 'materiales', 'material', 'codigo', 'código'],
  description: ['nombre de material', 'descripcion del articulo', 'descripción del artículo', 'texto breve de material', 'descripcion', 'descripción'],
  lot: ['no. de lote', 'numero de lote', 'número de lote', 'lote', 'batch'],
  quantity: ['cantidad de unidad de contabilidad', 'inventario total', 'suma de inventario total', 'cantidad inventario total', 'stock'],
  available: ['cantidad de inventario sin restricciones', 'inventario sin restricciones', 'libre utilizacion', 'libre utilización'],
  inspection: ['cantidad de inventario de inspeccion de', 'inventario en inspeccion', 'en inspeccion'],
  frozen: ['congelar la cantidad de inventario', 'inventario congelado', 'congelado'],
  unit: ['unidad de embalaje', 'unidad de medida basica', 'um', 'unidad de medida'],
  warehouse: ['almacen de logica erp', 'almacen', 'almacén', 'nombre de almacen', 'centro', 'bodega', 'deposito'],
  location: ['codigo de la ubicacion de almacen', 'ubicacion', 'ubicación', 'ubicacion de almacen', 'ubicacion fisica'],
  locationName: ['nombre de ubicacion de almacen', 'nombre de ubicacion', 'descripcion de ubicacion'],
  requester: ['solicitante', 'nombre solicitante', 'solicitado por'],
  department: ['departamento de solicitud', 'departamento de aplicacion', 'departamento solicitante', 'area solicitante'],
  supplier: ['nombre del proveedor', 'proveedor'],
  status: ['estado de inv.', 'estado de inventario'],
  workStatus: ['estado de trabajo'],
  lock: ['estado de bloqueo'],
  group: ['nombre del grupo de material', 'grupo de materiales'],
  order: ['no. de doc. cliente (sap)', 'numero de orden', 'orden de compra', 'no. de pedido de compra de referencia'],
  area: ['nombre del area de almacen', 'area de almacen'],
  ageDays: ['tiempo de antiguedad del almacen', 'antiguedad dias'],
  recordId: ['id', 'id de inventario', 'id inventario']
};
const accentless = (value) => normalizeSearch(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliasKey = Object.fromEntries(
  Object.entries(aliases).map(([key, values]) => [key, values.map(accentless)])
);
function matchColumns(header) {
  const entries = header.map((item, index) => ({ key: accentless(item), index }));
  const mapping = {};
  for (const [field, candidates] of Object.entries(aliasKey)) {
    const match = entries.find((item) => item.key && candidates.includes(item.key));
    if (match) mapping[field] = match.index;
  }
  return mapping;
}
function get(row, map, key) {
  const pos = map[key];
  return pos === undefined ? '' : (row[pos] ?? '');
}
function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const s = String(value ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;
  // Excel numérico ya entrega números. En formato texto se admite coma decimal.
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}
function asText(value) { return String(value ?? '').trim(); }
function extractDate(filename) {
  const matched = filename.match(/20\d{6}/);
  if (!matched) return 'No indicada en el nombre';
  const y = +matched[0].slice(0, 4);
  const m = +matched[0].slice(4, 6);
  const d = +matched[0].slice(6, 8);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return 'No indicada';
  return String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
}
function selectSheet(workbook, source) {
  let selected = null;
  const required = source === 'sap' ? ['code', 'quantity', 'lot'] : ['code', 'quantity', 'lot', 'location'];
  for (const sheetName of workbook.SheetNames) {
    const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, raw: true, blankrows: false, defval: ''
    });
    for (let headerAt = 0; headerAt < Math.min(20, raw.length); headerAt++) {
      const mapping = matchColumns(raw[headerAt]);
      if (!required.every((key) => mapping[key] !== undefined)) continue;
      const score = Object.keys(mapping).length;
      if (!selected || score > selected.score) selected = { raw, sheetName, headerAt, mapping, score };
    }
  }
  if (!selected) throw new Error(
    'No se reconoció la estructura ' + source.toUpperCase() +
    '. Se necesitan columnas de código, lote, cantidad' + (source === 'wms' ? ' y ubicación' : '') + '.'
  );
  return selected;
}
function rowToRecord(row, mapping, source, index, fallbackWarehouse) {
  const rawCode = asText(get(row, mapping, 'code'));
  if (!rawCode || /^total(es)?$/i.test(rawCode)) return null;
  const codeKey = normalizeCode(rawCode);
  if (!codeKey) return null;
  const sap = source === 'sap';
  return {
    id: asText(get(row, mapping, 'recordId')) || source.toUpperCase() + '-' + index,
    code: rawCode, codeKey,
    description: asText(get(row, mapping, 'description')),
    lot: asText(get(row, mapping, 'lot')) || 'Sin lote',
    quantity: asNumber(get(row, mapping, 'quantity')),
    available: sap ? asNumber(get(row, mapping, 'available')) : null,
    inspection: sap ? asNumber(get(row, mapping, 'inspection')) : null,
    frozen: sap ? asNumber(get(row, mapping, 'frozen')) : null,
    unit: asText(get(row, mapping, 'unit')),
    warehouse: asText(get(row, mapping, 'warehouse')) || (sap ? asText(fallbackWarehouse) : ''),
    location: sap ? '' : asText(get(row, mapping, 'location')),
    locationName: sap ? '' : asText(get(row, mapping, 'locationName')),
    requester: asText(get(row, mapping, 'requester')),
    department: asText(get(row, mapping, 'department')),
    supplier: asText(get(row, mapping, 'supplier')),
    status: sap ? '' : asText(get(row, mapping, 'status')),
    workStatus: sap ? '' : asText(get(row, mapping, 'workStatus')),
    lock: sap ? '' : asText(get(row, mapping, 'lock')),
    group: asText(get(row, mapping, 'group')),
    order: asText(get(row, mapping, 'order')),
    area: sap ? '' : asText(get(row, mapping, 'area')),
    ageDays: sap ? asText(get(row, mapping, 'ageDays')) : ''
  };
}
export async function parseReport(file, source) {
  if (!file || !/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Selecciona un archivo XLSX, XLS o CSV.');
  if (source !== 'wms' && source !== 'sap') throw new Error('Fuente de inventario desconocida.');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const { raw, sheetName, headerAt, mapping } = selectSheet(wb, source);
  const records = [];
  for (let i = headerAt + 1; i < raw.length; i++) {
    // El archivo SAP "Edades" tiene el almacén en AF y su cabecera está vacía.
    const fallbackWarehouse = source === 'sap' && mapping.warehouse === undefined ? raw[i][31] : '';
    const record = rowToRecord(raw[i], mapping, source, i + 1, fallbackWarehouse);
    if (record) records.push(record);
  }
  if (!records.length) throw new Error('No se encontraron líneas de inventario con código.');
  if (source === 'wms' && records.every((item) => !item.location)) {
    throw new Error('La base WMS no contiene ubicaciones reconocidas.');
  }
  return {
    source, filename: file.name, sheetName,
    snapshot: extractDate(file.name),
    loadedAt: new Date().toISOString(),
    records
  };
}
function key(source, scope) { return asText(scope).toLowerCase() + ':' + source; }
export async function readReport(source, scope) {
  return (await dbPromise).get('reports', key(source, scope));
}
export async function saveReport(report, scope) {
  return (await dbPromise).put('reports', { ...report, id: key(report.source, scope) });
}
export async function deleteReport(source, scope) {
  return (await dbPromise).delete('reports', key(source, scope));
}
