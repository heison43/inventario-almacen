import {
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UploadCloud
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  buildReviewBatchView,
  createReviewBatchFromFiles,
  deleteReviewBatchEverywhere,
  exportReviewBatchXlsx,
  listReviewBatches,
  pullReviewFromSupabase,
  replaceReviewWmsFromFile,
  saveItemRecount
} from '../lib/reviewService.js';
import { formatNumber } from '../lib/utils.js';

const EMPTY_FORM = {
  name: '',
  reviewType: 'sobrantes',
  responsible: '',
  notes: '',
  wmsCutAt: ''
};

export default function DifferenceReviewPage({ user }) {
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [view, setView] = useState({ batch: null, items: [], summary: emptySummary() });
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [codesFile, setCodesFile] = useState(null);
  const [wmsFile, setWmsFile] = useState(null);
  const [replaceWmsFile, setReplaceWmsFile] = useState(null);
  const [expanded, setExpanded] = useState('');
  const [reviewForms, setReviewForms] = useState({});
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('todos');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadBatches();
  }, []);

  useEffect(() => {
    if (selectedBatchId) loadBatchView(selectedBatchId);
    else setView({ batch: null, items: [], summary: emptySummary() });
  }, [selectedBatchId]);

  async function loadBatches(preferredId = '') {
    const rows = await listReviewBatches();
    setBatches(rows);
    const nextId = preferredId || selectedBatchId || rows[0]?.id || '';
    if (nextId && rows.some((row) => row.id === nextId)) setSelectedBatchId(nextId);
    else setSelectedBatchId('');
  }

  async function loadBatchView(batchId) {
    setLoading(true);
    setMessage('Preparando información de WMS e historial de inventario...');
    try {
      const result = await buildReviewBatchView(batchId);
      setView(result);
      setReviewForms(Object.fromEntries(result.items.map((item) => [item.id, {
        recount_qty: item.recount?.recount_qty ?? '',
        verified_location: item.recount?.verified_location || '',
        result: item.recount?.result || 'pendiente',
        responsible: item.recount?.responsible || user?.name || user?.email || '',
        comment: item.recount?.comment || ''
      }])));
      setMessage('');
    } catch (error) {
      setMessage(error?.message || 'No fue posible abrir el grupo de revisión.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshRemote() {
    setRefreshing(true);
    setMessage('Actualizando grupos de revisión desde Supabase...');
    try {
      const result = await pullReviewFromSupabase();
      setMessage(result.message);
      await loadBatches(selectedBatchId);
      if (selectedBatchId) await loadBatchView(selectedBatchId);
    } finally {
      setRefreshing(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('Importando códigos y existencia actual de WMS...');
    try {
      const result = await createReviewBatchFromFiles({
        name: form.name,
        reviewType: form.reviewType,
        responsible: form.responsible,
        notes: form.notes,
        wmsCutAt: form.wmsCutAt,
        codesFile,
        wmsFile,
        user
      });
      setMessage(`Grupo creado con ${result.stats.codes} códigos. Con existencia WMS: ${result.stats.codesWithWms}; en cero/no presentes: ${result.stats.codesWithoutWms}. ${result.sync.message}`);
      setForm(EMPTY_FORM);
      setCodesFile(null);
      setWmsFile(null);
      setShowCreate(false);
      await loadBatches(result.batch.id);
      await loadBatchView(result.batch.id);
    } catch (error) {
      setMessage(error?.message || 'No fue posible crear el grupo de revisión.');
    } finally {
      setLoading(false);
    }
  }

  async function updateWms() {
    if (!selectedBatchId || !replaceWmsFile) {
      setMessage('Selecciona una nueva descarga WMS para actualizar el grupo.');
      return;
    }
    setLoading(true);
    setMessage('Actualizando existencia WMS del grupo...');
    try {
      const result = await replaceReviewWmsFromFile({ batchId: selectedBatchId, wmsFile: replaceWmsFile });
      setMessage(`WMS actualizado: ${result.rows.length} líneas agrupadas. ${result.sync.message}`);
      setReplaceWmsFile(null);
      await loadBatchView(selectedBatchId);
    } catch (error) {
      setMessage(error?.message || 'No fue posible actualizar WMS.');
    } finally {
      setLoading(false);
    }
  }

  async function removeBatch(batch) {
    const confirmed = window.confirm(`¿Eliminar el grupo de revisión “${batch.name}”? Esta acción elimina únicamente este módulo y no toca las campañas de inventario.`);
    if (!confirmed) return;
    setLoading(true);
    const result = await deleteReviewBatchEverywhere(batch.id);
    setMessage(result.message);
    if (result.ok) {
      setSelectedBatchId('');
      await loadBatches();
    }
    setLoading(false);
  }

  function updateReviewForm(itemId, field, value) {
    setReviewForms((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] || {}), [field]: value }
    }));
  }

  async function saveReview(item) {
    const values = reviewForms[item.id] || {};
    setLoading(true);
    setMessage(`Guardando revisión del código ${item.material_code}...`);
    try {
      const result = await saveItemRecount({ item, batch: view.batch, values, user });
      setMessage(`Revisión guardada. ${result.sync.message}`);
      await loadBatchView(selectedBatchId);
    } catch (error) {
      setMessage(error?.message || 'No fue posible guardar la revisión.');
    } finally {
      setLoading(false);
    }
  }

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view.items.filter((item) => {
      const status = item.recount?.result || item.review_status || 'pendiente';
      const statusOk = statusFilter === 'todos' || status === statusFilter;
      const queryOk = !q || `${item.material_code} ${item.material_name}`.toLowerCase().includes(q);
      return statusOk && queryOk;
    });
  }, [view.items, query, statusFilter]);

  return (
    <section className="difference-review-page">
      <div className="panel-card wide-card">
        <div className="section-title">
          <div>
            <h2>Revisión de diferencias</h2>
            <p>Agrupa códigos prioritarios, cruza el WMS actual con el historial del inventario y registra el segundo conteo.</p>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={refreshRemote} disabled={refreshing || loading}>
              <RefreshCw size={16} /> {refreshing ? 'Actualizando...' : 'Actualizar grupos'}
            </button>
            <button className="primary-button" onClick={() => setShowCreate((current) => !current)}>
              <Plus size={16} /> Nuevo grupo
            </button>
          </div>
        </div>

        {message && <div className="info-box">{message}</div>}

        {showCreate && (
          <form className="review-create-card" onSubmit={createBatch}>
            <div className="form-grid three-cols">
              <label>
                Nombre del grupo
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ejemplo: Sobrantes alto valor 01" />
              </label>
              <label>
                Tipo de revisión
                <select value={form.reviewType} onChange={(event) => setForm({ ...form, reviewType: event.target.value })}>
                  <option value="sobrantes">Sobrantes</option>
                  <option value="faltantes">Faltantes</option>
                  <option value="ambos">Sobrantes y faltantes</option>
                </select>
              </label>
              <label>
                Responsable
                <input value={form.responsible} onChange={(event) => setForm({ ...form, responsible: event.target.value })} placeholder={user?.name || user?.email || ''} />
              </label>
              <label>
                Fecha de la descarga WMS
                <input type="datetime-local" value={form.wmsCutAt} onChange={(event) => setForm({ ...form, wmsCutAt: event.target.value })} />
              </label>
              <label className="file-field">
                <span>Listado de códigos</span>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setCodesFile(event.target.files?.[0] || null)} />
                <small>{codesFile?.name || 'Código, descripción, diferencia y valor.'}</small>
              </label>
              <label className="file-field">
                <span>Inventario actual WMS</span>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setWmsFile(event.target.files?.[0] || null)} />
                <small>{wmsFile?.name || 'Código, ubicación, lote y cantidad actual.'}</small>
              </label>
            </div>
            <label>
              Observaciones
              <textarea rows="2" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Alcance o indicaciones para esta revisión." />
            </label>
            <div className="button-row end-row">
              <button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>Cancelar</button>
              <button type="submit" className="primary-button" disabled={loading || !form.name.trim() || !codesFile || !wmsFile}>
                <UploadCloud size={16} /> {loading ? 'Importando...' : 'Crear e importar'}
              </button>
            </div>
          </form>
        )}

        <div className="review-batch-strip">
          {batches.length ? batches.map((batch) => (
            <button
              key={batch.id}
              type="button"
              className={`review-batch-card ${selectedBatchId === batch.id ? 'active' : ''}`}
              onClick={() => setSelectedBatchId(batch.id)}
            >
              <FileSpreadsheet size={19} />
              <span>
                <strong>{batch.name}</strong>
                <small>{reviewTypeLabel(batch.review_type)} · {formatDate(batch.wms_cut_at)}</small>
              </span>
            </button>
          )) : <div className="empty-box">Todavía no hay grupos de revisión. Crea el primero con los archivos de códigos y WMS.</div>}
        </div>
      </div>

      {view.batch && (
        <div className="panel-card wide-card review-detail-card">
          <div className="section-title">
            <div>
              <h2>{view.batch.name}</h2>
              <p>{reviewTypeLabel(view.batch.review_type)} · WMS con corte {formatDate(view.batch.wms_cut_at)} · Responsable: {view.batch.responsible || 'Sin definir'}</p>
            </div>
            <div className="button-row">
              <label className="compact-file-button secondary-button">
                <UploadCloud size={16} /> {replaceWmsFile ? replaceWmsFile.name : 'Nueva data WMS'}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setReplaceWmsFile(event.target.files?.[0] || null)} />
              </label>
              <button className="secondary-button" onClick={updateWms} disabled={!replaceWmsFile || loading}>Actualizar WMS</button>
              <button className="secondary-button" onClick={() => exportReviewBatchXlsx(view.batch.id)} disabled={loading}>
                <Download size={16} /> Exportar grupo
              </button>
              <button className="danger-button" onClick={() => removeBatch(view.batch)} disabled={loading}>
                <Trash2 size={16} /> Eliminar
              </button>
            </div>
          </div>

          <div className="stats-grid six-cols">
            <Stat label="Códigos" value={view.summary.codes} />
            <Stat label="Con existencia WMS" value={view.summary.with_wms} />
            <Stat label="WMS en cero" value={view.summary.without_wms} />
            <Stat label="Revisados" value={view.summary.reviewed} />
            <Stat label="Pendientes" value={view.summary.pending} />
            <Stat label="Valor priorizado" value={formatMoney(view.summary.expected_value)} raw />
          </div>

          <div className="form-grid three-cols review-filters">
            <label>
              Buscar código o descripción
              <div className="input-with-icon"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ejemplo: 5010061238" /></div>
            </label>
            <label>
              Estado de revisión
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="todos">Todos</option>
                <option value="pendiente">Pendiente</option>
                <option value="sobrante_confirmado">Sobrante confirmado</option>
                <option value="faltante_confirmado">Faltante confirmado</option>
                <option value="diferencia_corregida">Diferencia corregida</option>
                <option value="material_trasladado">Material trasladado</option>
                <option value="no_encontrado">No encontrado</option>
              </select>
            </label>
          </div>

          {loading && <div className="info-box">Actualizando información del grupo...</div>}

          <div className="review-item-list">
            {filteredItems.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <article key={item.id} className={`review-item-card ${isOpen ? 'open' : ''}`}>
                  <button className="review-item-summary" type="button" onClick={() => setExpanded(isOpen ? '' : item.id)}>
                    <span className="review-chevron">{isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
                    <span className="review-code-block">
                      <strong>{item.material_code}</strong>
                      <small>{item.material_name}</small>
                    </span>
                    <Metric label="Diferencia listado" value={formatNumber(item.expected_difference)} />
                    <Metric label="WMS actual" value={formatNumber(item.wms_total)} />
                    <Metric label="Físico inventario" value={formatNumber(item.inventory_summary?.physical_qty || 0)} />
                    <Metric label="Brecha actual" value={formatSigned(item.current_difference)} emphasis />
                    <span className={`review-status-pill ${item.recount?.result || 'pendiente'}`}>{resultLabel(item.recount?.result || 'pendiente')}</span>
                  </button>

                  {isOpen && (
                    <div className="review-item-detail">
                      <div className="review-comparison-grid">
                        <div className="review-data-block">
                          <h3>Existencia actual WMS</h3>
                          <p>Total actual: <strong>{formatNumber(item.wms_total)}</strong></p>
                          <div className="mini-table-scroll">
                            <table className="mini-table">
                              <thead><tr><th>Almacén</th><th>Ubicación</th><th>Cantidad</th><th>Lotes</th></tr></thead>
                              <tbody>
                                {item.wms_locations.length ? item.wms_locations.map((row) => (
                                  <tr key={`${row.warehouse}-${row.location}`}>
                                    <td>{row.warehouse}</td>
                                    <td><strong>{row.location}</strong></td>
                                    <td>{formatNumber(row.qty)}</td>
                                    <td>{row.lots.map((lot) => `${lot.batch}: ${formatNumber(lot.qty)}`).join(' | ')}</td>
                                  </tr>
                                )) : <tr><td colSpan="4" className="empty-cell">El código no aparece en la descarga WMS; se toma existencia actual 0.</td></tr>}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <div className="review-data-block">
                          <h3>Historial del inventario físico</h3>
                          <p>Sistema corte: <strong>{formatNumber(item.inventory_summary?.system_qty || 0)}</strong> · Físico: <strong>{formatNumber(item.inventory_summary?.physical_qty || 0)}</strong></p>
                          <div className="mini-table-scroll">
                            <table className="mini-table">
                              <thead><tr><th>Campaña</th><th>Ubicación</th><th>Sistema</th><th>Físico</th><th>Diferencia</th><th>Comentario</th></tr></thead>
                              <tbody>
                                {item.inventory_rows.length ? item.inventory_rows.map((row, index) => (
                                  <tr key={`${row.campaign_id}-${row.location}-${index}`}>
                                    <td>{row.campaign_name}</td>
                                    <td><strong>{row.location}</strong></td>
                                    <td>{formatNumber(row.system_qty || 0)}</td>
                                    <td>{row.physical_qty === null || row.physical_qty === undefined ? '' : formatNumber(row.physical_qty)}</td>
                                    <td>{row.difference === null || row.difference === undefined ? '' : formatSigned(row.difference)}</td>
                                    <td>{row.comment || ''}</td>
                                  </tr>
                                )) : <tr><td colSpan="6" className="empty-cell">No hay historial local para este código. Usa “Actualizar base” en Consulta rápida si necesitas traer información reciente.</td></tr>}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>

                      <div className="review-recount-form">
                        <h3>Segunda revisión</h3>
                        <div className="form-grid five-cols">
                          <label>
                            Cantidad recontada
                            <input type="number" step="any" value={reviewForms[item.id]?.recount_qty ?? ''} onChange={(event) => updateReviewForm(item.id, 'recount_qty', event.target.value)} />
                          </label>
                          <label>
                            Ubicación verificada
                            <input value={reviewForms[item.id]?.verified_location || ''} onChange={(event) => updateReviewForm(item.id, 'verified_location', event.target.value.toUpperCase())} placeholder="Ubicación real" />
                          </label>
                          <label>
                            Resultado
                            <select value={reviewForms[item.id]?.result || 'pendiente'} onChange={(event) => updateReviewForm(item.id, 'result', event.target.value)}>
                              <option value="pendiente">Pendiente</option>
                              <option value="sobrante_confirmado">Sobrante confirmado</option>
                              <option value="faltante_confirmado">Faltante confirmado</option>
                              <option value="diferencia_corregida">Diferencia corregida</option>
                              <option value="material_trasladado">Material trasladado</option>
                              <option value="no_encontrado">No encontrado</option>
                            </select>
                          </label>
                          <label>
                            Responsable
                            <input value={reviewForms[item.id]?.responsible || ''} onChange={(event) => updateReviewForm(item.id, 'responsible', event.target.value)} />
                          </label>
                          <label className="wide-field">
                            Comentario
                            <input value={reviewForms[item.id]?.comment || ''} onChange={(event) => updateReviewForm(item.id, 'comment', event.target.value)} placeholder="Hallazgo o acción realizada" />
                          </label>
                        </div>
                        <div className="review-save-row">
                          <span>Diferencia de revisión = reconteo − WMS actual.</span>
                          <button className="primary-button" type="button" onClick={() => saveReview(item)} disabled={loading}>
                            <Save size={16} /> Guardar revisión
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
            {!filteredItems.length && <div className="empty-box">No hay códigos para los filtros seleccionados.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function emptySummary() {
  return { codes: 0, with_wms: 0, without_wms: 0, reviewed: 0, pending: 0, expected_value: 0 };
}

function reviewTypeLabel(value) {
  return { sobrantes: 'Sobrantes', faltantes: 'Faltantes', ambos: 'Sobrantes y faltantes' }[value] || 'Revisión';
}

function resultLabel(value) {
  return {
    pendiente: 'Pendiente',
    sobrante_confirmado: 'Sobrante confirmado',
    faltante_confirmado: 'Faltante confirmado',
    diferencia_corregida: 'Diferencia corregida',
    material_trasladado: 'Material trasladado',
    no_encontrado: 'No encontrado'
  }[value] || value;
}

function formatDate(value) {
  if (!value) return 'sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${formatNumber(number)}`;
}

function Stat({ label, value, raw = false }) {
  return <div className="stat-card"><span>{label}</span><strong>{raw ? value : formatNumber(value || 0)}</strong></div>;
}

function Metric({ label, value, emphasis = false }) {
  return <span className={`review-metric ${emphasis ? 'emphasis' : ''}`}><small>{label}</small><strong>{value}</strong></span>;
}
