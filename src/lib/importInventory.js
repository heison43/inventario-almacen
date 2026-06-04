import * as XLSX from 'xlsx';
import { buildSnapshotKey, deriveZoneFromLocation, normalizeText, toNumber, uid } from './utils.js';
import { saveCampaign, saveInitialCounts, saveLocations, saveSnapshotItems } from './db.js';

export const REQUIRED_FIELDS = [
  { key: 'material_code', label: 'Codigo de material', required: true, visible: true, help: 'Columna real de la plantilla: Codigo de material.' },
  { key: 'material_name', label: 'Descripción del Articulo', required: true, visible: true, help: 'Columna real de la plantilla: Descripción del Articulo.' },
  { key: 'material_name_cn', label: 'Descripcion en Chino', required: false, visible: true, help: 'Columna real de la plantilla: Descripcion en Chino.' },
  { key: 'unit', label: 'UM', required: false, visible: true, help: 'Columna real de la plantilla: UM.' },
  { key: 'system_qty', label: 'Suma de Inventario total', required: true, visible: true, help: 'Columna real de la plantilla: Suma de Inventario total.' },
  { key: 'location', label: 'Ubicación', required: true, visible: true, help: 'Columna real de la plantilla: Ubicación. De aquí se calcula la zona: 2H01H0203 → 2H01H02.' },
  { key: 'department', label: 'Departamento Solicitante', required: false, visible: true, help: 'Columna real de la plantilla: Departamento Solicitante.' },
  { key: 'warehouse', label: 'Almacen', required: false, visible: true, help: 'Columna real de la plantilla: Almacen. Si no se selecciona, usa el almacén por defecto.' },
  { key: 'batch', label: 'Lote', required: false, visible: false, help: 'Opcional. Si la plantilla no trae lote, el sistema usará S/L.' },
  { key: 'purchase_order', label: 'Orden compra / doc. SAP', required: false, visible: false },
  { key: 'unit_price', label: 'Precio unitario', required: false, visible: false },
  { key: 'total_value', label: 'Valor total', required: false, visible: false }
];

const aliases = {
  warehouse: [
    'almacen',
    'almacén',
    'almacen de logica erp',
    'almacén de lógica erp',
    'nombre de almacen',
    'nombre de almacén',
    'almacen',
    'almacén',
    'bodega',
    'deposito'
  ],
  location: [
    'ubicacion',
    'ubicación',
    'codigo de la ubicacion de almacen',
    'código de la ubicación de almacén',
    'codigo ubicacion almacen',
    'ubicacion de almacen',
    'ubicación de almacén',
    'ubicacion',
    'ubicación'
  ],
  material_code: [
    'codigo de material',
    'código de material',
    'codigo material',
    'código material',
    'material',
    'sku'
  ],
  material_name: [
    'descripcion del articulo',
    'descripción del artículo',
    'descripcion del artículo',
    'descripción del articulo',
    'nombre de material',
    'nombre material',
    'descripcion',
    'descripción',
    'texto breve material',
    'texto breve de material',
    'denominacion'
  ],
  material_name_cn: [
    'descripcion en chino',
    'descripción en chino',
    'descripcion chino',
    'descripción chino',
    'chino',
    'descripcion china',
    'descripción china'
  ],
  unit: [
    'unidad de embalaje',
    'unidad de medida',
    'unidad medida',
    'unidad',
    'um',
    'umb',
    'und'
  ],
  batch: [
    'no. de lote',
    'nro lote',
    'numero de lote',
    'número de lote',
    'lote',
    'batch'
  ],
  system_qty: [
    'suma de inventario total',
    'inventario total',
    'cantidad de unidad de contabilidad',
    'cantidad sistema',
    'cantidad',
    'stock libre',
    'stock',
    'libre utilizacion',
    'libre utilización',
    'existencia'
  ],
  department: [
    'departamento solicitante',
    'solicitante',
    'solicitado por',
    'usuario solicitante',
    'nombre solicitante',
    'departamento de solicitud',
    'departamento solicitante',
    'area solicitante',
    'área solicitante',
    'departamento'
  ],
  purchase_order: [
    'no. de doc. cliente (sap)',
    'no. de pedido de compra de referencia',
    'orden de compra',
    'orden compra',
    'oc',
    'pedido de compra'
  ],
  unit_price: [
    'precio unitario de costos sin incluir impuestos',
    'precio uni. sin impuestos de recepcion',
    'precio uni. sin impuestos de recepción',
    'precio unitario sin impuestos compartido',
    'precio unitario',
    'valor unitario',
    'precio und'
  ],
  total_value: [
    'monto total sin incluir impuestos',
    'importe total incluido el impuesto',
    'monto total',
    'valor total',
    'importe',
    'valor inventario'
  ]
};

export async function parseInventoryFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { rows, columns, sheetName: workbook.SheetNames[0] };
}

export function autoDetectMapping(columns) {
  const normalizedColumns = columns.map((column) => ({ original: column, normalized: normalizeText(column) }));
  const mapping = {};

  for (const field of REQUIRED_FIELDS) {
    const candidates = aliases[field.key] || [];
    let found = null;

    // Primero busca coincidencias exactas para evitar confundir columnas como
    // “Código de la ubicación de almacén” con “Almacén”.
    for (const alias of candidates) {
      const normalizedAlias = normalizeText(alias);
      found = normalizedColumns.find((column) => column.normalized === normalizedAlias);
      if (found) break;
    }

    // Si no encuentra exacto, permite coincidencia parcial solo con alias largos.
    if (!found) {
      for (const alias of candidates) {
        const normalizedAlias = normalizeText(alias);
        if (normalizedAlias.length < 8) continue;
        found = normalizedColumns.find((column) => column.normalized.includes(normalizedAlias));
        if (found) break;
      }
    }

    mapping[field.key] = found?.original || '';
  }

  return mapping;
}

function value(row, columnName) {
  if (!columnName) return '';
  return row[columnName] ?? '';
}

export async function createCampaignFromRows({
  campaignName,
  defaultWarehouse,
  defaultZone,
  rows,
  mapping,
  createdBy,
  filterByDefaultZone = true
}) {
  const campaignId = uid('camp');
  const now = new Date().toISOString();
  // El usuario puede digitar una zona real (2H01H02) o una ubicación completa
  // (2H01H0203). En ambos casos normalizamos la zona operativa.
  const campaignZone = deriveZoneFromLocation(defaultZone || '', defaultZone || '');
  const campaign = {
    id: campaignId,
    name: campaignName,
    warehouse: defaultWarehouse,
    zone: campaignZone,
    status: 'activa',
    cut_date: now,
    created_by: createdBy?.email || createdBy?.name || 'local',
    created_at: now,
    updated_at: now
  };

  const locationMap = new Map();
  const snapshotMap = new Map();

  for (const row of rows) {
    const location = String(value(row, mapping.location) || '').trim().toUpperCase();
    const warehouse = String(value(row, mapping.warehouse) || defaultWarehouse || '').trim();
    const zone = deriveZoneFromLocation(location, defaultZone || campaignZone);
    const selectedZone = deriveZoneFromLocation(defaultZone || campaignZone || '', campaignZone);
    if (filterByDefaultZone && selectedZone && zone !== selectedZone) continue;
    const materialCode = String(value(row, mapping.material_code) || '').trim();
    const materialName = String(value(row, mapping.material_name) || '').trim();
    const materialNameCn = String(value(row, mapping.material_name_cn) || '').trim();
    const batch = String(value(row, mapping.batch) || 'S/L').trim() || 'S/L';
    const unit = String(value(row, mapping.unit) || '').trim();
    const systemQty = toNumber(value(row, mapping.system_qty));

    if (!location || !materialCode) continue;

    const locationKey = [campaignId, warehouse, zone, location].join('::');
    if (!locationMap.has(locationKey)) {
      locationMap.set(locationKey, {
        id: uid('loc'),
        campaign_id: campaignId,
        warehouse,
        zone,
        location,
        location_key: locationKey,
        assigned_to: null,
        assigned_group: null,
        status: 'pendiente',
        created_at: now,
        updated_at: now
      });
    }

    const locationRecord = locationMap.get(locationKey);
    const keyPayload = {
      campaign_id: campaignId,
      warehouse,
      zone,
      location,
      material_code: materialCode,
      batch
    };
    const snapshotKey = buildSnapshotKey(keyPayload);
    const previous = snapshotMap.get(snapshotKey);

    if (previous) {
      previous.system_qty += systemQty;
      previous.total_value += toNumber(value(row, mapping.total_value));
      previous.raw_lines += 1;
      if (!previous.material_name_cn && materialNameCn) previous.material_name_cn = materialNameCn;
    } else {
      snapshotMap.set(snapshotKey, {
        id: snapshotKey,
        campaign_id: campaignId,
        location_id: locationRecord.id,
        warehouse,
        zone,
        location,
        material_code: materialCode,
        material_name: materialName,
        material_name_cn: materialNameCn,
        unit,
        batch,
        system_qty: systemQty,
        department: String(value(row, mapping.department) || '').trim(),
        purchase_order: String(value(row, mapping.purchase_order) || '').trim(),
        unit_price: toNumber(value(row, mapping.unit_price)),
        total_value: toNumber(value(row, mapping.total_value)),
        raw_lines: 1,
        created_at: now
      });
    }
  }

  const locations = Array.from(locationMap.values()).sort((a, b) => a.location.localeCompare(b.location));
  const snapshotItems = Array.from(snapshotMap.values()).sort((a, b) =>
    `${a.location}-${a.material_code}-${a.batch}`.localeCompare(`${b.location}-${b.material_code}-${b.batch}`)
  );

  if (!locations.length || !snapshotItems.length) {
    throw new Error('No se encontraron ubicaciones para la zona indicada. Revisa la zona a contar o desactiva el filtro por zona si el archivo contiene varias zonas.');
  }

  const zones = Array.from(new Set(locations.map((location) => location.zone).filter(Boolean))).sort();
  campaign.zone = zones.length === 1 ? zones[0] : (campaignZone || 'varias');

  await saveCampaign(campaign);
  await saveLocations(locations);
  await saveSnapshotItems(snapshotItems);
  await saveInitialCounts(snapshotItems);

  return { campaign, locations, snapshotItems, zones };
}
