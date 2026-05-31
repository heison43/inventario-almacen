export function uid(prefix = 'id') {
  const random = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value)
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatNumber(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(number);
}

export function deriveWarehouseCodeFromLocation(location) {
  const clean = String(location ?? '').trim().toUpperCase();
  if (!clean) return '';
  return clean.slice(0, 4);
}

export function deriveZoneFromLocation(location, fallback = '') {
  const clean = String(location ?? '').trim().toUpperCase();
  const fb = String(fallback || '').trim().toUpperCase();
  if (!clean) return fb;
  // En la data real las ubicaciones vienen tipo 2H01H0203.
  // 2H01 = código de almacén físico y H02 = zona/área.
  // Por eso la zona operativa queda como 2H01H02.
  if (clean.length >= 7 && /^[A-Za-z0-9]{4}[A-Za-z][0-9]{2}/.test(clean)) {
    return clean.slice(0, 7);
  }
  return clean.slice(0, 6) || fb;
}

export function getStatusFromDifference(physicalQty, systemQty) {
  if (physicalQty === null || physicalQty === undefined || physicalQty === '') return 'pendiente';
  const diff = Number(physicalQty) - Number(systemQty ?? 0);
  if (diff === 0) return 'ok';
  return diff < 0 ? 'faltante' : 'sobrante';
}

export function statusLabel(status) {
  const labels = {
    pendiente: 'Pendiente',
    ok: 'OK',
    faltante: 'Faltante',
    sobrante: 'Sobrante',
    encontrado: 'Encontrado físico',
    finalizada: 'Finalizada',
    en_conteo: 'En conteo',
    activa: 'Activa',
    cerrada: 'Cerrada'
  };
  return labels[status] || status;
}

export function buildSnapshotKey({ campaign_id, warehouse, zone, location, material_code, batch }) {
  return [campaign_id, warehouse, zone, location, material_code, batch || 'S/L']
    .map((value) => String(value ?? '').trim())
    .join('::');
}
