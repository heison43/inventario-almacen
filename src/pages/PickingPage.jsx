import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList, Download, FileSpreadsheet, Plus, Printer, Search, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { formatQty, normalizeCode, normalizeSearch, readReport } from '../lib/referenceInventory.js';
import {
  combineRequests, createPickingResult, filterPickingResult, indexInventoryRecords,
  parsePickingPaste, pickingFieldOptions, PICKING_NO_DATA
} from '../lib/pickingTools.js';
import '../picking.css';

function freshLine() {
  return { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2), code: '', qty: '' };
}
function toAmount(value) {
  if (value === '' || value == null) return 0;
  return Number(String(value).replace(',', '.'));
}
function displayAmount(value) {
  return value === null || value === undefined ? '—' : formatQty(value);
}
function withNumber(value) {
  return value === null || value === undefined ? '—' : Number(value);
}
function configureSheet(sheet, widths) {
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  const ref = XLSX.utils.decode_range(sheet['!ref']);
  if (ref.e.r > ref.s.r) sheet['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_cell({ c: ref.e.c, r: ref.e.r }) };
  return sheet;
}
function sortRows(a, b, sort) {
  const keys = sort === 'code' ? ['requestKey', 'warehouse', 'location', 'lot'] : ['warehouse', 'location', 'requestKey', 'lot'];
  for (const key of keys) {
    const comparison = String(a[key] || '').localeCompare(String(b[key] || ''), 'es', { numeric: true });
    if (comparison !== 0) return comparison;
  }
  return String(a.rowKey).localeCompare(String(b.rowKey), 'es', { numeric: true });
}
function StatusLabel({ item }) {
  if (item.filteredOut) return <span className="pk-status pk-warning">Sin coincidencias con el filtro</span>;
  if (item.wmsLines === 0) return <span className="pk-status pk-missing">Sin ubicación WMS</span>;
  if (item.flaggedCount > 0) return <span className="pk-status pk-warning">Revisar estados ({item.flaggedCount})</span>;
  return <span className="pk-status pk-ok">Ubicaciones encontradas</span>;
}
function MetaLine({ title, text }) {
  return <div className="pk-meta-item"><span>{title}</span><strong>{text || 'No indicado'}</strong></div>;
}

export default function PickingPage({ user, onGoToInventory }) {
  const scope = String(user?.id || user?.email || user?.name || 'local').toLowerCase().trim();
  const [reports, setReports] = useState({ wms: null, sap: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [bulk, setBulk] = useState('');
  const [entries, setEntries] = useState([freshLine()]);
  const [requester, setRequester] = useState('');
  const [department, setDepartment] = useState('');
  const [document, setDocument] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [generated, setGenerated] = useState(null);
  const [plan, setPlan] = useState({});
  const [lineSelections, setLineSelections] = useState({});
  const [sortBy, setSortBy] = useState('location');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([readReport('wms', scope), readReport('sap', scope)])
      .then(([wms, sap]) => { if (alive) setReports({ wms: wms || null, sap: sap || null }); })
      .catch((err) => { if (alive) setError('No se pudieron leer las bases locales: ' + err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope]);

  const warehouses = useMemo(() =>
    Array.from(new Set((reports.wms?.records || []).map((r) => r.warehouse).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'es', { numeric: true })),
    [reports.wms]);

  const wmsIndex = useMemo(() =>
    indexInventoryRecords(warehouseFilter
      ? (reports.wms?.records || []).filter((record) => record.warehouse === warehouseFilter)
      : reports.wms?.records),
    [reports.wms, warehouseFilter]);

  const sapIndex = useMemo(() => indexInventoryRecords(reports.sap?.records), [reports.sap]);
  const fullResults = useMemo(() =>
    generated ? createPickingResult(generated.requests, wmsIndex, sapIndex) : null,
    [generated, wmsIndex, sapIndex]);

  // Filtros por material: no se mezclan líneas de otros códigos ni SAP.
  const codeOptions = useMemo(() => {
    if (!fullResults) return [];
    const grouped = new Map();
    for (const row of fullResults.details) {
      if (!grouped.has(row.requestKey)) grouped.set(row.requestKey, []);
      grouped.get(row.requestKey).push(row);
    }
    return fullResults.summary.map((item) => {
      const rows = grouped.get(item.key) || [];
      return {
        key: item.key, code: item.code, rows,
        departments: pickingFieldOptions(rows, 'department'),
        requesters: pickingFieldOptions(rows, 'requester')
      };
    }).filter((item) => item.departments.length > 1 || item.requesters.length > 1);
  }, [fullResults]);

  const results = useMemo(() =>
    filterPickingResult(fullResults, lineSelections),
    [fullResults, lineSelections]);
  const details = useMemo(() => (results?.details || []).slice().sort((a, b) => sortRows(a, b, sortBy)), [results, sortBy]);

  function changeSelection(codeKey, field, value) {
    setLineSelections((current) => ({
      ...current, [codeKey]: {
        ...current[codeKey], [field]: value,
        ...(field === 'department' ? { requester: '' } : {})
      }
    }));
    setPlan({});
  }
  const plannedPerCode = useMemo(() => {
    const planned = new Map();
    for (const item of results?.details || []) {
      const amount = toAmount(plan[item.rowKey]);
      planned.set(item.requestKey, (planned.get(item.requestKey) || 0) + (Number.isFinite(amount) ? amount : 0));
    }
    return planned;
  }, [results, plan]);
  const planError = useMemo(() => {
    if (!results) return '';
    for (const row of results.details) {
      const qty = toAmount(plan[row.rowKey]);
      if (!Number.isFinite(qty) || qty < 0 || qty > row.quantity) {
        return 'Hay una cantidad propuesta incorrecta o superior a la existencia WMS de una línea.';
      }
      if (row.flagged && qty > 0) return 'No se permite proponer una línea bloqueada, en salida o sin ubicación.';
    }
    for (const item of results.summary) {
      if ((plannedPerCode.get(item.key) || 0) > item.qty + 0.0000001) {
        return 'La cantidad propuesta supera la cantidad solicitada para el código ' + item.key + '.';
      }
    }
    return '';
  }, [results, plan, plannedPerCode]);

  function addBulk() {
    const { parsed, problems } = parsePickingPaste(bulk);
    if (parsed.length) {
      setEntries((current) => [
        ...current.filter((r) => r.code.trim() || String(r.qty).trim()),
        ...parsed.map((r) => ({ ...freshLine(), ...r }))
      ]);
      setBulk('');
      setGenerated(null);
      setPlan({});
    }
    if (parsed.length) setLineSelections({});
    setError(problems.join(' '));
    setMessage(parsed.length ? 'Se agregaron ' + parsed.length + ' líneas a la solicitud.' : 'No se agregaron líneas.');
  }
  function updateEntry(id, field, value) {
    setEntries((current) => current.map((r) => r.id === id ? { ...r, [field]: value } : r));
    setGenerated(null);
    setPlan({});
    setLineSelections({});
  }
  function removeEntry(id) {
    setEntries((current) => {
      const next = current.filter((r) => r.id !== id);
      return next.length ? next : [freshLine()];
    });
    setGenerated(null);
    setPlan({});
    setLineSelections({});
  }
  function generate() {
    setError('');
    setMessage('');
    if (!reports.wms && !reports.sap) {
      setError('Primero carga una base WMS o SAP desde Consulta SAP / WMS, en este mismo navegador.');
      return;
    }
    try {
      const rawRows = entries.filter((r) => r.code.trim() || String(r.qty).trim());
      if (!rawRows.length) throw new Error('Agrega al menos un código y la cantidad requerida.');
      const requests = combineRequests(rawRows);
      setGenerated({
        requests, createdAt: new Date().toISOString(),
        meta: { requester: requester.trim(), department: department.trim(), document: document.trim(), warehouse: warehouseFilter },
        wmsSnapshot: reports.wms?.snapshot || 'Sin WMS',
        sapSnapshot: reports.sap?.snapshot || 'Sin SAP'
      });
      setPlan({});
      setLineSelections({});
      setMessage('Consulta lista: ' + requests.length + ' códigos. Revisa las ubicaciones y genera el Excel.');
    } catch (err) { setError(err.message); }
  }

  function exportExcel() {
    if (!generated || !results || planError) return;
    const now = new Date(generated.createdAt).toLocaleString('es-CO');
    const pedido = results.summary.map((item) => ({
      'Código': item.code, 'Descripción': item.description,
      'Cantidad solicitada': item.qty, 'UM WMS': item.wmsQuantity.unit,
      'Referencia WMS': withNumber(item.wmsQuantity.amount),
      'Líneas WMS': item.wmsLines, 'Ubicaciones WMS': item.locationCount,
      'Líneas a revisar': item.flaggedCount,
      'Referencia SAP': withNumber(item.sapQuantity.amount),
      'UM SAP': item.sapQuantity.unit,
      'SAP sin restricciones': withNumber(item.sapFree.amount),
      'Cantidad a separar': plannedPerCode.get(item.key) || 0,
      'Pendiente de asignar': item.qty - (plannedPerCode.get(item.key) || 0),
      'Estado': item.filteredOut ? 'SIN COINCIDENCIA PARA FILTRO' : item.wmsLines ? (item.flaggedCount ? 'REVISAR ESTADOS' : 'CONSULTA WMS') : 'SIN UBICACIÓN WMS'
    }));
    const ubicaciones = details.map((r) => ({
      'Código': r.code, 'Descripción': r.description,
      'Almacén WMS': r.warehouse, 'Ubicación': r.location,
      'Nombre ubicación': r.locationName, 'Lote': String(r.lot),
      'Cantidad WMS (referencia)': r.quantity, 'UM': r.unit,
      'Solicitado total del código': r.requested,
      'Cantidad a separar': toAmount(plan[r.rowKey]) || '',
      'Cantidad retirada física': '',
      'Solicitante WMS': r.requester,
      'Área / departamento WMS': r.department,
      'Bloqueo': r.lock, 'Trabajo': r.workStatus,
      'Estado inventario': r.status, 'Proveedor': r.supplier,
      'Orden / documento origen': r.order,
      'ADVERTENCIA': r.flagged ? 'REVISAR ANTES DE RETIRAR' : '',
      'Observaciones despacho': ''
    }));
    const sapRows = results.sapDetail.map((r) => ({
      'Código': r.code, 'Descripción': r.description,
      'Almacén SAP': r.warehouse, 'Lote SAP': String(r.lot),
      'Cantidad SAP': r.quantity, 'SAP sin restricciones': r.available,
      'En inspección': r.inspection, 'Congelado': r.frozen, 'UM': r.unit,
      'Solicitante': r.requester, 'Área / departamento': r.department
    }));
    const missing = results.summary.filter((s) => !s.originalWmsLines).map((s) => ({
      'Código': s.code, 'Descripción': s.description, 'Cantidad solicitada': s.qty,
      'Estado': 'SIN UBICACIÓN WMS', 'SAP de referencia': withNumber(s.sapQuantity.amount),
      'Observación': ''
    }));
    const workbook = XLSX.utils.book_new();
    const wsPedido = XLSX.utils.aoa_to_sheet([
      ['HOJA DE PICKING - CONSULTA DE UBICACIONES'],
      ['Fecha de preparación', now], ['Solicitado por', generated.meta.requester],
      ['Área solicitante', generated.meta.department],
      ['No. solicitud / vale', generated.meta.document],
      ['Filtro de almacén WMS', generated.meta.warehouse || 'Todos'],
      ['Fecha de base WMS', generated.wmsSnapshot],
      ['Fecha de base SAP', generated.sapSnapshot],
      ['IMPORTANTE', 'Verificar físicamente antes de retirar. Las bases pueden estar desactualizadas.']
    ]);
    XLSX.utils.sheet_add_json(wsPedido, pedido, { origin: 'A11' });
    wsPedido['!cols'] = [14, 45, 20, 15, 20, 17, 20, 19, 20, 15, 24, 21, 22, 24];
    XLSX.utils.book_append_sheet(workbook, wsPedido, 'PEDIDO');
    XLSX.utils.book_append_sheet(workbook,
      configureSheet(XLSX.utils.json_to_sheet(ubicaciones.length ? ubicaciones : [{ 'Código': 'Sin líneas WMS en esta consulta' }]),
        [15, 46, 30, 22, 24, 19, 25, 12, 20, 19, 22, 29, 30, 20, 18, 18, 18, 25, 23, 26]), 'UBICACIONES_WMS');
    XLSX.utils.book_append_sheet(workbook,
      configureSheet(XLSX.utils.json_to_sheet(sapRows.length ? sapRows : [{ 'Código': 'Sin coincidencias SAP' }]),
        [15, 45, 20, 20, 17, 23, 19, 16, 14, 25, 27]), 'REFERENCIA_SAP');
    if (missing.length) XLSX.utils.book_append_sheet(workbook,
      configureSheet(XLSX.utils.json_to_sheet(missing), [17, 45, 22, 28, 25, 25]), 'SIN_UBICACION');
    const stamp = new Date(generated.createdAt).toISOString().replace(/[-:]/g, '').slice(0, 13);
    XLSX.writeFile(workbook, 'picking-contingencia-' + stamp + '.xlsx');
  }

  function printPicking() {
    if (!generated || planError) return;
    window.print();
  }
  const missingCount = results?.summary.filter((r) => !r.originalWmsLines).length || 0;
  const flaggedCount = results?.details.filter((r) => r.flagged).length || 0;

  return <div className="pk-page">
    <section className="panel-card pk-card pk-no-print">
      <header className="pk-title"><ClipboardList size={25}/><div>
        <h2>Picking de contingencia · Ventana</h2>
        <p>Prepara varias referencias en una sola búsqueda de ubicaciones y lotes.</p>
      </div></header>
      <div className="pk-notice"><AlertTriangle size={18}/>
        <span>Documento de apoyo, no equivale a una reserva, salida de almacén ni vale. WMS muestra ubicaciones según su fecha de corte; SAP, cantidades de otra fecha. Confirma existencias y estados físicamente antes de entregar.</span></div>
      {loading ? <p>Cargando bases locales...</p> : <div className="pk-files">
        <span className={reports.wms ? 'pk-loaded' : 'pk-unloaded'}><FileSpreadsheet size={16}/> WMS: {reports.wms ? formatQty(reports.wms.records.length) + ' líneas · ' + reports.wms.snapshot : 'No cargado'}</span>
        <span className={reports.sap ? 'pk-loaded' : 'pk-unloaded'}><FileSpreadsheet size={16}/> SAP: {reports.sap ? formatQty(reports.sap.records.length) + ' líneas · ' + reports.sap.snapshot : 'No cargado'}</span>
        <button type="button" className="pk-text-btn" onClick={onGoToInventory}>Cargar / actualizar bases</button>
      </div>}
      <div className="pk-metadata">
        <label>Solicitado por<input value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="Opcional" /></label>
        <label>Área solicitante<input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Opcional" /></label>
        <label>No. solicitud / vale<input value={document} onChange={(e) => setDocument(e.target.value)} placeholder="Opcional" /></label>
        <label>Almacén (WMS)<select value={warehouseFilter} onChange={(e) => { setWarehouseFilter(e.target.value); setGenerated(null); setPlan({}); setLineSelections({}); }}>
          <option value="">Todos los almacenes</option>{warehouses.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      <div className="pk-two-col">
        <div><h3>Agregar varios códigos</h3><p className="pk-muted">Pega desde Excel o escribe una línea por código: <strong>código + cantidad</strong>, separados por espacio, tabulación o punto y coma.</p>
          <textarea rows={6} value={bulk} onChange={(e) => setBulk(e.target.value)}
            placeholder={'2010017593   5\n3010014707   2\n5010087957   10'} />
          <button type="button" className="pk-secondary" onClick={addBulk} disabled={!bulk.trim()}><Plus size={16}/> Agregar lista</button>
        </div>
        <div><div className="pk-inline-title"><h3>Solicitud actual ({entries.length} líneas)</h3>
          <button type="button" className="pk-text-btn" onClick={() => { setEntries([freshLine()]); setGenerated(null); setPlan({}); setLineSelections({}); setMessage(''); setError(''); }}>Limpiar</button></div>
          <div className="pk-edit-table"><table><thead><tr><th>Código</th><th>Cantidad pedida</th><th></th></tr></thead>
            <tbody>{entries.map((r) => <tr key={r.id}>
              <td><input aria-label="Código de material" value={r.code} onChange={(e) => updateEntry(r.id, 'code', e.target.value)} placeholder="Código" /></td>
              <td><input aria-label="Cantidad solicitada" type="number" min="0.001" step="any" value={r.qty} onChange={(e) => updateEntry(r.id, 'qty', e.target.value)} placeholder="Cant." /></td>
              <td><button type="button" title="Quitar línea" className="pk-remove" onClick={() => removeEntry(r.id)}><Trash2 size={17}/></button></td>
            </tr>)}</tbody></table></div>
          <div className="pk-controls"><button type="button" className="pk-secondary" onClick={() => setEntries((prev) => [...prev, freshLine()])}><Plus size={16}/> Otra línea</button>
            <button type="button" className="pk-primary" disabled={loading || (!reports.wms && !reports.sap)} onClick={generate}><Search size={17}/> Consultar códigos</button></div>
        </div>
      </div>
      {message && <p className="pk-message" role="status">{message}</p>}
      {error && <p className="pk-error" role="alert">{error}</p>}
    </section>

    {generated && results && <section className="panel-card pk-card pk-print-area">
      <header className="pk-results-top"><div><h2>Hoja de picking · Consulta de ubicaciones</h2>
        <p>Generado: {new Date(generated.createdAt).toLocaleString('es-CO')} · WMS: {generated.wmsSnapshot} · SAP: {generated.sapSnapshot}</p></div>
        <div className="pk-export pk-no-print"><button type="button" className="pk-secondary" disabled={Boolean(planError)} onClick={printPicking}><Printer size={16}/> Imprimir / PDF</button>
          <button type="button" className="pk-primary" disabled={Boolean(planError)} onClick={exportExcel}><Download size={17}/> Descargar Excel</button></div>
      </header>
      {codeOptions.length > 0 && <div className="pk-area-filters pk-no-print">
        <div className="pk-inline-title"><h3>Filtrar por área y solicitante para cada código</h3>
          <button type="button" className="pk-text-btn" onClick={() => { setLineSelections({}); setPlan({}); }}>Mostrar todas las áreas</button></div>
        <p className="pk-muted">Elige el área y/o solicitante. Solo las líneas WMS seleccionadas aparecerán en la impresión y el Excel. La referencia SAP se conserva sin filtrar.</p>
        <div className="pk-area-grid">{codeOptions.map((item) => {
          const chosen = lineSelections[item.key] || {};
          const requesterRows = chosen.department
            ? item.rows.filter((row) => chosen.department === PICKING_NO_DATA
              ? !String(row.department || '').trim()
              : normalizeSearch(row.department) === normalizeSearch(chosen.department))
            : item.rows;
          const requesterOptions = pickingFieldOptions(requesterRows, 'requester');
          const activeCount = results.details.filter((row) => row.requestKey === item.key).length;
          return <div className="pk-area-card" key={item.key}>
            <div className="pk-area-card-head"><strong>{normalizeCode(item.code)}</strong><small>{activeCount} de {item.rows.length} líneas WMS</small></div>
            <label>Área / departamento WMS<select value={chosen.department || ''} onChange={(e) => changeSelection(item.key, 'department', e.target.value)}>
              <option value="">Todas las áreas</option>
              {item.departments.map((value) => <option key={value.value} value={value.value}>{value.label}</option>)}
            </select></label>
            <label>Solicitante WMS<select value={chosen.requester || ''} onChange={(e) => changeSelection(item.key, 'requester', e.target.value)}>
              <option value="">Todos los solicitantes</option>
              {requesterOptions.map((value) => <option key={value.value} value={value.value}>{value.label}</option>)}
            </select></label>
          </div>;
        })}</div>
      </div>}
      <div className="pk-print-meta">
        <MetaLine title="Solicitado por" text={generated.meta.requester}/>
        <MetaLine title="Área" text={generated.meta.department}/>
        <MetaLine title="Solicitud / vale" text={generated.meta.document}/>
        <MetaLine title="Almacén consultado" text={generated.meta.warehouse || 'Todos'}/>
      </div>
      <div className="pk-stats">
        <div><span>Códigos</span><strong>{results.summary.length}</strong></div>
        <div><span>Líneas WMS</span><strong>{formatQty(results.details.length)}</strong></div>
        <div><span>Sin ubicación WMS</span><strong>{missingCount}</strong></div>
        <div><span>Líneas a verificar</span><strong>{flaggedCount}</strong></div>
      </div>
      <h3>Resumen del pedido</h3>
      <div className="pk-scroll"><table className="pk-table pk-summary"><thead><tr>
        <th>Código</th><th>Descripción</th><th>Solicitado</th><th>WMS referencial</th><th>SAP referencial</th><th>A separar</th><th>Sin asignar</th><th>Estado</th>
      </tr></thead><tbody>{results.summary.map((item) => {
        const proposed = plannedPerCode.get(item.key) || 0;
        return <tr key={item.key}><td className="pk-nowrap"><b>{normalizeCode(item.code)}</b></td><td>{item.description || 'Sin descripción'}</td>
          <td className="pk-num">{formatQty(item.qty)}</td>
          <td className="pk-num">{displayAmount(item.wmsQuantity.amount)} <small>{item.wmsQuantity.unit}</small></td>
          <td className="pk-num">{displayAmount(item.sapQuantity.amount)} <small>{item.sapQuantity.unit}</small></td>
          <td className="pk-num">{formatQty(proposed)}</td>
          <td className="pk-num">{formatQty(item.qty - proposed)}</td><td><StatusLabel item={item}/></td></tr>;
      })}</tbody></table></div>
      {planError && <p className="pk-error pk-no-print" role="alert">{planError}</p>}
      {missingCount > 0 && <p className="pk-notice">Hay {missingCount} código(s) sin ubicación WMS. Se incluyen en el resumen y la hoja SIN_UBICACION del Excel; verifica su existencia antes del despacho.</p>}
      <div className="pk-inline-title"><h3>Detalle físico por lote y ubicación</h3>
        <label className="pk-no-print">Ordenar por <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="location">Almacén y ubicación</option><option value="code">Código</option></select></label></div>
      <p className="pk-muted pk-no-print">«A separar» es opcional: indica cuánto piensas recoger de cada lote y ubicación. No descuenta inventario.</p>
      <div className="pk-scroll pk-screen-details pk-no-print"><table className="pk-table"><thead><tr>
        <th>Código</th><th>Descripción</th><th>Almacén</th><th>Ubicación</th><th>Lote</th><th>WMS</th><th>UM</th><th>A recoger</th><th>Solicitante</th><th>Área</th><th>Bloqueo / trabajo</th>
      </tr></thead><tbody>{details.map((r) => <tr className={r.flagged ? 'pk-flagged' : ''} key={r.rowKey}>
        <td><b>{normalizeCode(r.code)}</b></td><td>{r.description}</td><td>{r.warehouse}</td>
        <td className="pk-nowrap"><b>{r.location || 'Sin ubicación'}</b><small>{r.locationName}</small></td>
        <td>{r.lot}</td><td className="pk-num">{formatQty(r.quantity)}</td><td>{r.unit}</td>
        <td><input className="pk-pick-input" type="number" min="0" max={Math.max(0, r.quantity)} step="any"
          aria-label={'Cantidad a recoger de ' + r.code + ' lote ' + r.lot + ' ubicación ' + r.location}
          disabled={r.flagged} value={plan[r.rowKey] ?? ''} onChange={(e) => setPlan((current) => ({ ...current, [r.rowKey]: e.target.value }))} placeholder={r.flagged ? 'Revisar' : '0'} /></td>
        <td>{r.requester}</td><td>{r.department}</td><td>{r.lock || '—'} / {r.workStatus || '—'}{r.flagged && <strong className="pk-flag-text">Revisar antes de retirar</strong>}</td>
      </tr>)}
      {!details.length && <tr><td colSpan="11" className="pk-empty">No hay ubicaciones WMS para los códigos y filtros seleccionados.</td></tr>}
      </tbody></table></div>
      <div className="pk-only-print"><table className="pk-table"><thead><tr>
        <th>Código</th><th>Almacén</th><th>Ubicación</th><th>Lote</th><th>WMS</th><th>UM</th><th>A separar</th><th>Retirado</th><th>Área</th><th>Estado</th>
      </tr></thead><tbody>{details.map((r) => <tr key={r.rowKey}>
        <td>{normalizeCode(r.code)}</td><td>{r.warehouse}</td><td>{r.location}</td><td>{r.lot}</td><td>{formatQty(r.quantity)}</td>
        <td>{r.unit}</td><td>{toAmount(plan[r.rowKey]) || '—'}</td><td>________</td><td>{r.department}</td>
        <td>{r.flagged ? 'REVISAR' : r.lock + ' / ' + r.workStatus}</td></tr>)}
      </tbody></table></div>
    </section>}
  </div>;
}
