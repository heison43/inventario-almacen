import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Database, Download, FileSpreadsheet, Search, Trash2, UploadCloud } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  deleteReport, formatQty, normalizeCode, normalizeSearch,
  parseReport, readReport, saveReport
} from '../lib/referenceInventory.js';
import '../referenceInventory.css';

const fields = [
  ['code', 'Código'], ['description', 'Descripción'], ['lot', 'Lote'],
  ['location', 'Ubicación'], ['warehouse', 'Almacén'], ['requester', 'Solicitante'],
  ['department', 'Área / departamento'], ['supplier', 'Proveedor'], ['id', 'ID'],
  ['status', 'Estado de inventario'], ['workStatus', 'Estado de trabajo'], ['lock', 'Bloqueo'],
  ['group', 'Grupo de material'], ['order', 'Orden / documento'], ['area', 'Área de almacén']
];
const emptyFilters = () => Object.fromEntries(fields.map(([key]) => [key, '']));
const PAGE_SIZE = 60;
const sum = (rows, field) => rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
const distinct = (rows, field) => new Set(rows.map((r) => r[field]).filter(Boolean)).size;

function runFilters(rows, filters) {
  const active = Object.entries(filters).filter(([, value]) => String(value).trim());
  if (!active.length) return rows;
  return rows.filter((row) => active.every(([key, input]) => {
    const query = key === 'code' ? normalizeCode(input) : normalizeSearch(input);
    const target = key === 'code' ? row.codeKey : normalizeSearch(row[key]);
    return String(target ?? '').toLowerCase().includes(String(query).toLowerCase());
  }));
}
function MaterialTotals({ rows, source }) {
  const oneMaterial = rows.length > 0 && distinct(rows, 'codeKey') === 1 && distinct(rows, 'unit') <= 1;
  const breakdown = useMemo(() => {
    if (!oneMaterial) return [];
    const totals = new Map();
    for (const row of rows) {
      const key = row.warehouse || 'Sin almacén';
      totals.set(key, (totals.get(key) || 0) + row.quantity);
    }
    return Array.from(totals, ([name, qty]) => ({ name, qty }));
  }, [oneMaterial, rows]);
  return <>
    <div className="ri-stats">
      <div><span>Líneas</span><strong>{formatQty(rows.length)}</strong></div>
      <div><span>Códigos</span><strong>{formatQty(distinct(rows, 'codeKey'))}</strong></div>
      <div><span>Lotes</span><strong>{formatQty(distinct(rows, 'lot'))}</strong></div>
      <div><span>{source === 'wms' ? 'Ubicaciones' : 'Almacenes'}</span><strong>{formatQty(distinct(rows, source === 'wms' ? 'location' : 'warehouse'))}</strong></div>
      <div><span>Total del código</span><strong>{oneMaterial ? formatQty(sum(rows, 'quantity')) + ' ' + (rows[0].unit || '') : '—'}</strong></div>
      {source === 'sap' && <div><span>Sin restricciones</span><strong>{oneMaterial ? formatQty(sum(rows, 'available')) : '—'}</strong></div>}
    </div>
    {!oneMaterial && rows.length > 0 && <p className="ri-hint">Para sumar cantidades, filtra un único código y una unidad de medida. No se mezclan cantidades de códigos diferentes.</p>}
    {oneMaterial && breakdown.length > 1 && <div className="ri-breakdown">
      <span>Por almacén:</span>
      {breakdown.map((item) => <span key={item.name}>{item.name}: <b>{formatQty(item.qty)}</b></span>)}
    </div>}
  </>;
}
function InventoryTable({ rows, source, page = 0 }) {
  const displayed = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return <div className="ri-scroll" role="region" aria-label={'Inventario ' + source.toUpperCase()} tabIndex="0">
    <table className="ri-table">
      <thead><tr>
        <th>Código</th><th>Descripción</th><th>Almacén</th>
        {source === 'wms' && <th>Ubicación física</th>}
        <th>Lote</th><th>Cantidad</th>
        {source === 'sap' && <><th>Sin restricciones</th><th>En inspección</th><th>Congelado</th></>}
        <th>UM</th><th>Solicitante</th><th>Departamento</th>
        {source === 'wms' && <><th>Bloqueo</th><th>Trabajo</th><th>Estado inventario</th></>}
        <th>Proveedor</th><th>Orden</th>
      </tr></thead>
      <tbody>{displayed.map((r, i) => {
        const caution = source === 'wms' && (/bloquead/i.test(r.lock) && !/no bloquead/i.test(r.lock) || /por salir/i.test(r.workStatus));
        return <tr key={r.id + ':' + i} className={caution ? 'ri-caution' : ''}>
          <td className="ri-code">{normalizeCode(r.code)}</td>
          <td>{r.description}</td><td>{r.warehouse || '—'}</td>
          {source === 'wms' && <td className="ri-location">{r.location || '—'}<small>{r.locationName}</small></td>}
          <td>{r.lot}</td><td className="ri-num">{formatQty(r.quantity)}</td>
          {source === 'sap' && <><td className="ri-num">{formatQty(r.available)}</td><td className="ri-num">{formatQty(r.inspection)}</td><td className="ri-num">{formatQty(r.frozen)}</td></>}
          <td>{r.unit}</td><td>{r.requester}</td><td>{r.department}</td>
          {source === 'wms' && <><td>{r.lock || '—'}</td><td>{r.workStatus || '—'}</td><td>{r.status || '—'}</td></>}
          <td>{r.supplier || '—'}</td><td>{r.order || '—'}</td>
        </tr>;
      })}
      {!displayed.length && <tr><td colSpan={source === 'sap' ? 13 : 13} className="ri-empty">Sin coincidencias.</td></tr>}
      </tbody>
    </table>
  </div>;
}
function Pages({ page, total, setPage }) {
  const count = Math.ceil(total / PAGE_SIZE);
  if (count < 2) return null;
  return <div className="ri-pages"><span>Página {page + 1} / {count} · {formatQty(total)} registros</span>
    <div><button disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
      <button disabled={page + 1 >= count} onClick={() => setPage(page + 1)}>Siguiente</button></div>
  </div>;
}

function SourceCard({ source, data, busy, onUpload, onDelete }) {
  return <div className="ri-source">
    <h3><FileSpreadsheet size={20} /> {source.toUpperCase()}</h3>
    <p>{source === 'wms' ? 'Lotes, ubicaciones físicas, almacenes y estados.' : 'Existencias por código, lote y almacén.'}</p>
    <label className="ri-upload"><UploadCloud size={16} /> {busy ? 'Procesando…' : data ? 'Reemplazar base' : 'Cargar Excel'}
      <input type="file" disabled={busy} accept=".xlsx,.xls,.csv" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onUpload(file, source);
        e.target.value = '';
      }} />
    </label>
    {data ? <div className="ri-meta">
      <b>{formatQty(data.records.length)} registros</b>
      <span title={data.filename}>{data.filename}</span>
      <span>Corte según nombre del archivo: {data.snapshot}</span>
      <button disabled={busy} onClick={() => onDelete(source)}><Trash2 size={14} /> Eliminar copia local</button>
    </div> : <small>Sin archivo cargado en este navegador.</small>}
  </div>;
}

export default function ReferenceInventoryPage({ user }) {
  const scope = String(user?.id || user?.email || user?.name || 'local').toLowerCase().trim();
  const [reports, setReports] = useState({ wms: null, sap: null });
  const [tab, setTab] = useState('wms');
  const [filters, setFilters] = useState(emptyFilters);
  const [codeCompare, setCodeCompare] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([readReport('wms', scope), readReport('sap', scope)])
      .then(([wms, sap]) => { if (alive) setReports({ wms: wms || null, sap: sap || null }); })
      .catch((err) => { if (alive) setError('No se pudieron cargar los datos locales: ' + err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope]);

  const upload = useCallback(async (file, source) => {
    setBusy(true);
    setError('');
    try {
      await new Promise((done) => setTimeout(done, 25));
      const result = await parseReport(file, source);
      await saveReport(result, scope);
      setReports((prev) => ({ ...prev, [source]: result }));
      setTab(source);
      setFilters(emptyFilters());
      setPage(0);
    } catch (err) {
      setError(err.message || 'No fue posible procesar este archivo.');
    } finally { setBusy(false); }
  }, [scope]);

  async function remove(source) {
    if (!window.confirm('¿Borrar la base ' + source.toUpperCase() + ' de este navegador? No se modificará el Excel original.')) return;
    setBusy(true);
    setError('');
    try {
      await deleteReport(source, scope);
      setReports((prev) => ({ ...prev, [source]: null }));
      setPage(0);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const data = reports[tab];
  const filtered = useMemo(() => runFilters(data?.records || [], filters), [data, filters]);
  const compareKey = normalizeCode(codeCompare);
  const compareWms = useMemo(() =>
    (compareKey && reports.wms ? reports.wms.records.filter((r) => r.codeKey === compareKey) : []),
    [reports.wms, compareKey]);
  const compareSap = useMemo(() =>
    (compareKey && reports.sap ? reports.sap.records.filter((r) => r.codeKey === compareKey) : []),
    [reports.sap, compareKey]);

  function download() {
    if (!filtered.length) return;
    const output = filtered.map((r) => ({
      'Código': normalizeCode(r.code), 'Descripción': r.description, 'Almacén': r.warehouse,
      'Ubicación': r.location, 'Lote': r.lot, 'Cantidad': r.quantity, 'UM': r.unit,
      'Sin restricciones SAP': r.available ?? '', 'En inspección SAP': r.inspection ?? '',
      'Congelado SAP': r.frozen ?? '', 'Solicitante': r.requester,
      'Departamento': r.department, 'Bloqueo': r.lock, 'Estado de trabajo': r.workStatus,
      'Estado inventario': r.status, 'Proveedor': r.supplier, 'Orden': r.order
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(output), tab.toUpperCase());
    XLSX.writeFile(wb, 'consulta-' + tab + '-' + new Date().toISOString().slice(0, 10) + '.xlsx');
  }

  const visibleFields = fields.filter(([key]) => tab === 'wms' ||
    !['location', 'status', 'workStatus', 'lock', 'area'].includes(key));

  return <div className="ri-page">
    <section className="panel-card ri-panel">
      <header className="ri-heading"><Database size={26} /><div><h2>Consulta inventario · SAP / WMS</h2>
        <p>Contingencia de consulta. No crea movimientos ni modifica campañas de conteo.</p></div></header>
      <div className="ri-warning"><AlertTriangle size={17} />
        <span>Son reportes con fechas distintas. WMS orienta sobre ubicaciones; SAP informa cantidades según su fecha de corte. Comprueba físicamente antes de separar o ajustar materiales.</span>
      </div>
      <div className="ri-sources">
        <SourceCard source="wms" data={reports.wms} busy={busy} onUpload={upload} onDelete={remove}/>
        <SourceCard source="sap" data={reports.sap} busy={busy} onUpload={upload} onDelete={remove}/>
      </div>
      <p className="ri-privacy">Los archivos se procesan y almacenan en el navegador de este dispositivo (IndexedDB). No se envían a Supabase, GitHub ni Vercel. No se comparten automáticamente con otros dispositivos.</p>
      {busy && <p className="ri-processing" role="status">Procesando archivo; no cierres esta pestaña…</p>}
      {error && <p className="ri-error" role="alert">{error}</p>}
    </section>
    <section className="panel-card ri-panel">
      <div className="ri-tabs">
        <button className={tab === 'wms' ? 'active' : ''} onClick={() => { setTab('wms'); setPage(0); setFilters(emptyFilters()); }}><Database size={16}/> WMS</button>
        <button className={tab === 'sap' ? 'active' : ''} onClick={() => { setTab('sap'); setPage(0); setFilters(emptyFilters()); }}><FileSpreadsheet size={16}/> SAP</button>
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}><ArrowLeftRight size={16}/> Comparar código</button>
      </div>
      {loading ? <p>Cargando archivos locales…</p> : tab === 'compare' ? (
        <div>
          <label className="ri-compare-input"><span>Código de material en ambas bases</span><input value={codeCompare} onChange={(e) => setCodeCompare(e.target.value)} placeholder="Ej.: 2010015339" /></label>
          {!compareKey ? <p className="ri-hint">Ingresa un código completo para ver sus registros SAP y WMS por separado.</p> : <>
            <h3>WMS · {formatQty(compareWms.length)} líneas · {reports.wms?.snapshot || 'Sin archivo'}</h3>
            <MaterialTotals rows={compareWms} source="wms" />
            <InventoryTable rows={compareWms.slice(0, PAGE_SIZE)} source="wms" />
            {compareWms.length > PAGE_SIZE && <p className="ri-hint">Mostrando las primeras {PAGE_SIZE} líneas; consulta el resto en WMS.</p>}
            <h3>SAP · {formatQty(compareSap.length)} líneas · {reports.sap?.snapshot || 'Sin archivo'}</h3>
            <MaterialTotals rows={compareSap} source="sap" />
            <InventoryTable rows={compareSap.slice(0, PAGE_SIZE)} source="sap" />
            {compareSap.length > PAGE_SIZE && <p className="ri-hint">Mostrando las primeras {PAGE_SIZE} líneas; consulta el resto en SAP.</p>}
            <p className="ri-hint">No se calculan diferencias entre fechas ni se mezclan cantidades SAP y WMS.</p>
          </>}
        </div>
      ) : data ? <>
        <header className="ri-results-head"><div><h3>Consulta {tab.toUpperCase()}</h3><p>Archivo: {data.filename} · Fecha identificada: {data.snapshot}</p></div>
          <button className="ri-action" disabled={!filtered.length} onClick={download}><Download size={16} /> Exportar filtrado</button></header>
        <div className="ri-filters">
          {visibleFields.map(([key, label]) => <label key={key}><span>{label}</span>
            <input value={filters[key]} onChange={(e) => { setFilters((prev) => ({ ...prev, [key]: e.target.value })); setPage(0); }} placeholder={'Filtrar ' + label.toLowerCase()} /></label>)}
        </div>
        <div className="ri-filter-actions"><button className="ri-action" onClick={() => { setFilters(emptyFilters()); setPage(0); }}>Limpiar filtros</button><small><Search size={14}/> Filtros combinables en tiempo real</small></div>
        <MaterialTotals rows={filtered} source={tab} />
        <InventoryTable rows={filtered} source={tab} page={page} />
        <Pages page={page} total={filtered.length} setPage={setPage} />
      </> : <div className="ri-blank"><FileSpreadsheet size={35} /><p>Carga el Excel {tab.toUpperCase()} para consultar códigos, cantidades, lotes y almacenes.</p></div>}
    </section>
  </div>;
}
