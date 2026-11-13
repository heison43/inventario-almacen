import { normalizeCode, normalizeSearch } from './referenceInventory.js';

export function parsePickingPaste(raw) {
  const parsed = [];
  const problems = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (/^(codigo|código|material|cod)\b/i.test(text)) continue;
    let fields;
    if (text.includes('\t')) fields = text.split(/\t+/);
    else if (text.includes(';')) fields = text.split(';');
    else if (text.includes('|')) fields = text.split('|');
    else if (/\s/.test(text)) fields = text.split(/\s+/);
    else if (text.includes(',')) fields = text.split(',');
    else fields = [text];
    fields = fields.map((field) => field.trim()).filter(Boolean);
    if (fields.length > 2) {
      problems.push('Línea ' + (i + 1) + ': utiliza únicamente código y cantidad.');
      continue;
    }
    const code = fields[0] || '';
    if (!/^[\w.-]{3,40}$/.test(code)) {
      problems.push('Línea ' + (i + 1) + ': código no reconocido.');
      continue;
    }
    const qty = (fields[1] || '').replace(',', '.');
    if (qty && (!Number.isFinite(Number(qty)) || Number(qty) <= 0)) {
      problems.push('Línea ' + (i + 1) + ': la cantidad debe ser mayor que cero.');
      continue;
    }
    parsed.push({ code, qty });
  }
  return { parsed, problems };
}

export function combineRequests(rows) {
  const combined = new Map();
  for (const row of rows) {
    const code = String(row.code || '').trim();
    const key = normalizeCode(code);
    const qty = Number(String(row.qty ?? '').replace(',', '.'));
    if (!key || !Number.isFinite(qty) || qty <= 0) {
      throw new Error('Todos los códigos deben tener una cantidad solicitada mayor que cero.');
    }
    if (combined.has(key)) combined.get(key).qty += qty;
    else combined.set(key, { key, code, qty });
  }
  return Array.from(combined.values());
}

export function indexInventoryRecords(records) {
  const index = new Map();
  for (const record of records || []) {
    const key = record.codeKey || normalizeCode(record.code);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  }
  return index;
}

export function isUncertainLine(record) {
  const lock = normalizeSearch(record.lock);
  const work = normalizeSearch(record.workStatus);
  const blocked = /\bbloquea|bloquead|bloqueo|inmoviliz/.test(lock) &&
    !/no bloquead|sin bloqueo|desbloquead/.test(lock);
  const outbound = /por salir|reservad|despach|entregad|por entrega/.test(work);
  return blocked || outbound || Number(record.quantity) <= 0 || !record.location;
}

export function sumInSingleUnit(records, field = 'quantity') {
  if (!records?.length) return { amount: null, unit: '', mixed: false };
  const units = new Set(records.map((item) => normalizeSearch(item.unit)).filter(Boolean));
  if (units.size > 1) return { amount: null, unit: 'UM diferentes', mixed: true };
  return {
    amount: records.reduce((acc, item) => acc + (Number(item[field]) || 0), 0),
    unit: records.find((item) => item.unit)?.unit || '',
    mixed: false
  };
}

export function createPickingResult(requests, wmsIndex, sapIndex) {
  const summary = [];
  const details = [];
  const sapDetail = [];
  for (const request of requests) {
    const wmsRows = wmsIndex.get(request.key) || [];
    const sapRows = sapIndex.get(request.key) || [];
    const wmsQuantity = sumInSingleUnit(wmsRows);
    const sapQuantity = sumInSingleUnit(sapRows);
    const sapFree = sumInSingleUnit(sapRows, 'available');
    summary.push({
      ...request,
      description: wmsRows.find((row) => row.description)?.description ||
        sapRows.find((row) => row.description)?.description || '',
      wmsQuantity, sapQuantity, sapFree,
      wmsLines: wmsRows.length,
      sapLines: sapRows.length,
      locationCount: new Set(wmsRows.map((row) => row.location).filter(Boolean)).size,
      flaggedCount: wmsRows.filter(isUncertainLine).length
    });
    wmsRows.forEach((record, index) => {
      details.push({ ...record, rowKey: request.key + ':' + index, requestKey: request.key,
        requested: request.qty, flagged: isUncertainLine(record) });
    });
    sapRows.forEach((record, index) => {
      sapDetail.push({ ...record, rowKey: request.key + ':' + index, requestKey: request.key,
        requested: request.qty });
    });
  }
  return { summary, details, sapDetail };
}
