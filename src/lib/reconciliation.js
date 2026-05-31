import * as XLSX from 'xlsx';
import { buildGroupCountId, listFoundItemsByCampaign, listGroupCountsByCampaign, listLocations, listSnapshotByCampaign } from './db.js';
import { formatNumber, getStatusFromDifference } from './utils.js';

function buildGroupedSnapshot(snapshots) {
  const map = new Map();

  for (const item of snapshots) {
    const key = buildGroupCountId({
      campaign_id: item.campaign_id,
      location_id: item.location_id,
      warehouse: item.warehouse,
      zone: item.zone,
      location: item.location,
      material_code: item.material_code,
      unit: item.unit
    });

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        campaign_id: item.campaign_id,
        location_id: item.location_id,
        warehouse: item.warehouse,
        zone: item.zone,
        location: item.location,
        material_code: item.material_code,
        material_name: item.material_name,
        material_name_cn: item.material_name_cn || '',
        unit: item.unit,
        batch: '',
        lot_detail: [],
        system_qty: 0,
        raw_lines: 0,
        department: item.department,
        purchase_order: item.purchase_order,
        unit_price: Number(item.unit_price || 0),
        total_value: 0
      });
    }

    const group = map.get(key);
    group.system_qty += Number(item.system_qty || 0);
    group.raw_lines += Number(item.raw_lines || 1);
    group.total_value += Number(item.total_value || 0);
    group.lot_detail.push(`${item.batch || 'S/L'}: ${formatNumber(item.system_qty)}`);
  }

  return Array.from(map.values()).map((group) => ({
    ...group,
    batch: group.lot_detail.join(' | ')
  }));
}

export async function buildReconciliation(campaignId) {
  const [snapshots, groupCounts, foundItems, locations] = await Promise.all([
    listSnapshotByCampaign(campaignId),
    listGroupCountsByCampaign(campaignId),
    listFoundItemsByCampaign(campaignId),
    listLocations(campaignId)
  ]);

  const countMap = new Map(groupCounts.map((count) => [count.id, count]));
  const locationMap = new Map(locations.map((location) => [location.id, location]));
  const groupedSnapshot = buildGroupedSnapshot(snapshots);

  const rows = groupedSnapshot.map((item) => {
    const count = countMap.get(item.id);
    const physicalQty = count?.physical_qty;
    const difference = physicalQty === null || physicalQty === undefined || physicalQty === ''
      ? null
      : Number(physicalQty) - Number(item.system_qty ?? 0);
    const status = getStatusFromDifference(physicalQty, item.system_qty);
    const averageUnitPrice = Number(item.system_qty || 0) === 0 ? Number(item.unit_price || 0) : Number(item.total_value || 0) / Number(item.system_qty || 1);
    return {
      warehouse: item.warehouse,
      zone: item.zone,
      location: item.location,
      material_code: item.material_code,
      material_name: item.material_name,
      material_name_cn: item.material_name_cn || '',
      unit: item.unit,
      batch: item.batch,
      system_qty: item.system_qty,
      physical_qty: physicalQty,
      difference,
      status,
      counted_by: count?.counted_by || '',
      counted_at: count?.counted_at || '',
      assigned_group: locationMap.get(item.location_id)?.assigned_group || '',
      material_condition: count?.material_condition || 'buen_estado',
      condition_qty: count?.condition_qty ?? 0,
      comment: count?.comment || '',
      raw_lines: item.raw_lines,
      department: item.department,
      purchase_order: item.purchase_order,
      unit_price: averageUnitPrice,
      total_value: item.total_value,
      difference_value: difference === null ? null : difference * averageUnitPrice
    };
  });

  for (const found of foundItems) {
    rows.push({
      warehouse: found.warehouse,
      zone: found.zone,
      location: found.location,
      material_code: found.material_code,
      material_name: found.material_name,
      material_name_cn: found.material_name_cn || '',
      unit: found.unit,
      batch: found.batch || 'S/L',
      system_qty: 0,
      physical_qty: found.physical_qty,
      difference: found.physical_qty,
      status: 'encontrado',
      counted_by: found.registered_by || '',
      counted_at: found.created_at || '',
      assigned_group: locationMap.get(found.location_id)?.assigned_group || '',
      material_condition: found.material_condition || 'buen_estado',
      condition_qty: found.condition_qty ?? 0,
      comment: found.comment || '',
      raw_lines: 0,
      department: '',
      purchase_order: '',
      unit_price: 0,
      total_value: 0,
      difference_value: 0
    });
  }

  const summary = rows.reduce(
    (acc, row) => {
      acc.total += 1;
      acc[row.status] = (acc[row.status] || 0) + 1;
      if (row.status !== 'ok' && row.status !== 'pendiente') acc.withDifferences += 1;
      return acc;
    },
    { total: 0, ok: 0, faltante: 0, sobrante: 0, pendiente: 0, encontrado: 0, withDifferences: 0 }
  );

  return { rows, summary };
}

function splitDateTime(value) {
  if (!value) return { fecha: '', hora: '' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { fecha: '', hora: '' };
  return {
    fecha: date.toLocaleDateString('es-CO'),
    hora: date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
}

export function exportReconciliationXlsx(rows, fileName = 'conciliacion-inventario.xlsx') {
  const labels = {
    buen_estado: 'Buen estado',
    mal_estado: 'Mal estado',
    vencido: 'Vencido',
    averiado: 'Averiado',
    oxidado: 'Oxidado',
    sin_identificar: 'Sin identificar',
    otro: 'Otro'
  };

  const exportRows = rows.map((row) => {
    const { fecha, hora } = splitDateTime(row.counted_at);
    return {
      'Codigo de material': row.material_code,
      'Descripción del Articulo': row.material_name,
      'Descripcion en Chino': row.material_name_cn || '',
      UM: row.unit,
      'Suma de Inventario total': row.system_qty ?? '',
      'Ubicación': row.location,
      'Departamento Solicitante': row.department || '',
      Almacen: row.warehouse,
      CantidadFisica: row.physical_qty ?? '',
      Diferencia: row.difference ?? '',
      Estado: row.status,
      UsuarioConteo: row.counted_by || '',
      GrupoConteo: row.assigned_group || '',
      FechaConteo: fecha,
      HoraConteo: hora,
      EstadoFisico: labels[row.material_condition] || labels.buen_estado,
      CantidadEstadoFisico: row.condition_qty ?? '',
      Comentario: row.comment || ''
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Conciliacion');
  XLSX.writeFile(workbook, fileName);
}

export function exportLocalBackup(rows, fileName = 'respaldo-conteo-local.xlsx') {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'RespaldoLocal');
  XLSX.writeFile(workbook, fileName);
}

export { formatNumber };
