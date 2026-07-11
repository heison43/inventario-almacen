import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { listCampaigns, listLocations } from '../lib/db.js';
import { buildReconciliation, exportReconciliationXlsx } from '../lib/reconciliation.js';
import { formatNumber, statusLabel } from '../lib/utils.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullFromSupabase } from '../lib/remoteSync.js';

const DEFAULT_PAGE_SIZE = 50;

export default function ReconciliationPage({ selectedCampaignId }) {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignMode, setCampaignMode] = useState(selectedCampaignId ? 'selected' : 'all');
  const [selectedCampaignIds, setSelectedCampaignIds] = useState(selectedCampaignId ? [selectedCampaignId] : []);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [statusFilter, setStatusFilter] = useState('todos');
  const [locationFilter, setLocationFilter] = useState('todos');
  const [locations, setLocations] = useState([]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  useEffect(() => { loadCampaigns(); }, []);

  useEffect(() => {
    if (selectedCampaignId) {
      setCampaignMode('selected');
      setSelectedCampaignIds([selectedCampaignId]);
    }
  }, [selectedCampaignId]);

  const activeCampaignIds = useMemo(() => {
    if (campaignMode === 'all') return campaigns.map((campaign) => campaign.id);
    return selectedCampaignIds;
  }, [campaignMode, campaigns, selectedCampaignIds]);

  useEffect(() => {
    if (campaigns.length) loadReconciliation(activeCampaignIds, campaigns);
  }, [campaigns, activeCampaignIds.join('|')]);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, locationFilter, deferredQuery, pageSize, activeCampaignIds.join('|')]);

  async function loadCampaigns() {
    setLoading(true);
    try {
      const campaignRows = await listCampaigns();
      setCampaigns(campaignRows);
      if (!selectedCampaignId && !selectedCampaignIds.length) setCampaignMode('all');
    } catch (error) {
      setMessage(error?.message || 'No fue posible cargar las campañas locales.');
    } finally {
      setLoading(false);
    }
  }

  async function loadReconciliation(ids = activeCampaignIds, sourceCampaigns = campaigns) {
    const validIds = (ids || []).filter(Boolean);
    if (!validIds.length) {
      setRows([]);
      setSummary(emptySummary());
      setLocations([]);
      return;
    }

    setLoading(true);
    try {
      const campaignMap = new Map(sourceCampaigns.map((campaign) => [campaign.id, campaign]));
      const results = [];

      // Se procesa campaña por campaña para evitar picos de memoria en celulares.
      for (const id of validIds) {
        const [result, campaignLocations] = await Promise.all([
          buildReconciliation(id),
          listLocations(id)
        ]);
        const campaign = campaignMap.get(id);
        results.push({
          id,
          rows: result.rows.map((row) => ({
            ...row,
            campaign_id: id,
            campaign_name: campaign?.name || id
          })),
          locations: campaignLocations
        });
      }

      const allRows = results.flatMap((result) => result.rows);
      const allLocations = results.flatMap((result) => result.locations);
      const uniqueLocations = Array.from(new Set(allLocations.map((location) => location.location))).sort();

      const nextSummary = allRows.reduce(
        (acc, row) => {
          acc.total += 1;
          acc[row.status] = (acc[row.status] || 0) + 1;
          return acc;
        },
        emptySummary()
      );

      setRows(allRows);
      setSummary(nextSummary);
      setLocations(uniqueLocations);
      setLocationFilter('todos');
      setCurrentPage(1);
    } catch (error) {
      setMessage(error?.message || 'No fue posible construir la conciliación local.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshFromSupabase() {
    if (!isSupabaseConfigured) {
      setMessage('Supabase no está configurado. Se conserva la información local disponible.');
      return;
    }

    setRefreshing(true);
    setMessage('Actualizando la base local desde Supabase...');
    try {
      const pulled = await pullFromSupabase();
      if (!pulled.ok) {
        setMessage(`Aviso Supabase: ${pulled.message}`);
        return;
      }

      const campaignRows = await listCampaigns();
      setCampaigns(campaignRows);
      // El cambio de campañas dispara una sola reconstrucción local mediante el efecto.
      setMessage('Base local actualizada correctamente.');
    } catch (error) {
      setMessage(error?.message || 'No fue posible actualizar la base local.');
    } finally {
      setRefreshing(false);
    }
  }

  function toggleCampaign(campaignId) {
    setSelectedCampaignIds((current) => {
      if (current.includes(campaignId)) return current.filter((id) => id !== campaignId);
      return [...current, campaignId];
    });
  }

  function selectCurrentCampaigns(ids) {
    setCampaignMode('selected');
    setSelectedCampaignIds(ids);
  }

  const filteredRows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const statusOk = statusFilter === 'todos' || row.status === statusFilter;
      const locationOk = locationFilter === 'todos' || row.location === locationFilter;
      const queryOk = !q || [
        row.campaign_name,
        row.material_code,
        row.material_name,
        row.material_name_cn,
        row.location,
        row.warehouse,
        row.zone,
        row.department
      ].join(' ').toLowerCase().includes(q);
      return statusOk && locationOk && queryOk;
    });
  }, [rows, statusFilter, locationFilter, deferredQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(currentPage, pageCount);
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safePage, pageSize]);

  return (
    <section className="panel-card wide-card">
      <div className="section-title">
        <div>
          <h2>Conciliación de inventario</h2>
          <p>Comparativo por código totalizado en cada ubicación. La tabla se muestra por páginas para evitar que el navegador se sature.</p>
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={refreshFromSupabase} disabled={refreshing || loading}>
            <RefreshCw size={16} /> {refreshing ? 'Actualizando base...' : 'Actualizar base'}
          </button>
          <button className="primary-button" onClick={() => exportReconciliationXlsx(filteredRows)} disabled={!filteredRows.length}>
            <Download size={16} /> Exportar Excel
          </button>
        </div>
      </div>

      {message && <div className="info-box">{message}</div>}
      {loading && <div className="info-box">Preparando conciliación local. No cierres la página...</div>}

      <div className="form-grid three-cols">
        <label>
          Modo de campañas
          <select value={campaignMode} onChange={(e) => setCampaignMode(e.target.value)}>
            <option value="all">Todas las campañas</option>
            <option value="selected">Campañas seleccionadas</option>
          </select>
        </label>
        <label>
          Ubicación
          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
            <option value="todos">Todas</option>
            {locations.map((location) => <option key={location} value={location}>{location}</option>)}
          </select>
        </label>
        <label>
          Estado
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="todos">Todos</option>
            <option value="ok">OK</option>
            <option value="faltante">Faltante</option>
            <option value="sobrante">Sobrante</option>
            <option value="pendiente">Pendiente</option>
            <option value="encontrado">Encontrado físico</option>
          </select>
        </label>
        <label>
          Buscar
          <div className="input-with-icon"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Código, material, campaña o ubicación..." /></div>
        </label>
      </div>

      {campaignMode === 'selected' && (
        <div className="campaign-picker">
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => selectCurrentCampaigns(campaigns.map((campaign) => campaign.id))}>Seleccionar todas</button>
            <button className="secondary-button" type="button" onClick={() => selectCurrentCampaigns([])}>Quitar selección</button>
          </div>
          <div className="campaign-checkbox-grid">
            {campaigns.map((campaign) => (
              <label key={campaign.id} className="campaign-check-card">
                <input
                  type="checkbox"
                  checked={selectedCampaignIds.includes(campaign.id)}
                  onChange={() => toggleCampaign(campaign.id)}
                />
                <span>
                  <strong>{campaign.name}</strong>
                  <small>{campaign.warehouse} · Zona {campaign.zone}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="stats-grid six-cols">
        <Stat label="Total códigos" value={summary.total || 0} />
        <Stat label="OK" value={summary.ok || 0} />
        <Stat label="Faltantes" value={summary.faltante || 0} />
        <Stat label="Sobrantes" value={summary.sobrante || 0} />
        <Stat label="Pendientes" value={summary.pendiente || 0} />
        <Stat label="Nuevos" value={summary.encontrado || 0} />
      </div>

      <div className="table-toolbar">
        <span>
          Mostrando <strong>{filteredRows.length ? ((safePage - 1) * pageSize) + 1 : 0}</strong>–<strong>{Math.min(safePage * pageSize, filteredRows.length)}</strong> de <strong>{formatNumber(filteredRows.length)}</strong> registros filtrados
        </span>
        <label>
          Filas por página
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="250">250</option>
          </select>
        </label>
      </div>

      <div className="responsive-table">
        <table>
          <thead>
            <tr>
              <th>Campaña</th>
              <th>Almacén</th>
              <th>Zona</th>
              <th>Ubicación</th>
              <th>Grupo</th>
              <th>Código</th>
              <th>Descripción del Articulo</th>
              <th>Descripcion en Chino</th>
              <th>UM</th>
              <th>Solicitante</th>
              <th>Sistema</th>
              <th>Físico</th>
              <th>Diferencia</th>
              <th>Estado</th>
              <th>Estado físico</th>
              <th>Cant. afectada</th>
              <th>Comentario</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length ? pageRows.map((row, index) => (
              <tr key={`${row.campaign_id}-${row.material_code}-${row.batch}-${row.location}-${index}`}>
                <td>{row.campaign_name || ''}</td>
                <td>{row.warehouse}</td>
                <td>{row.zone}</td>
                <td>{row.location}</td>
                <td>{row.assigned_group || 'Sin grupo'}</td>
                <td><strong>{row.material_code}</strong></td>
                <td>{row.material_name}</td>
                <td>{row.material_name_cn || ''}</td>
                <td>{row.unit}</td>
                <td>{row.department || ''}</td>
                <td>{formatNumber(row.system_qty)}</td>
                <td>{row.physical_qty === null || row.physical_qty === undefined ? '' : formatNumber(row.physical_qty)}</td>
                <td>{row.difference === null || row.difference === undefined ? '' : formatNumber(row.difference)}</td>
                <td><span className={`status-pill ${row.status}`}>{statusLabel(row.status)}</span></td>
                <td>{conditionLabel(row.material_condition)}</td>
                <td>{row.condition_qty ?? ''}</td>
                <td>{row.comment || ''}</td>
              </tr>
            )) : (
              <tr><td colSpan="17" className="empty-cell">No hay registros para los filtros seleccionados.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-controls">
        <button className="secondary-button" type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={safePage <= 1}>
          <ChevronLeft size={16} /> Anterior
        </button>
        <span>Página <strong>{safePage}</strong> de <strong>{pageCount}</strong></span>
        <button className="secondary-button" type="button" onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))} disabled={safePage >= pageCount}>
          Siguiente <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function emptySummary() {
  return { total: 0, ok: 0, faltante: 0, sobrante: 0, pendiente: 0, encontrado: 0 };
}

function conditionLabel(value) {
  const labels = {
    buen_estado: 'Buen estado',
    mal_estado: 'Mal estado',
    vencido: 'Vencido',
    averiado: 'Averiado',
    oxidado: 'Oxidado',
    sin_identificar: 'Sin identificar',
    otro: 'Otro'
  };
  return labels[value] || 'Buen estado';
}

function Stat({ label, value }) {
  return <div className="stat-card"><span>{label}</span><strong>{formatNumber(value)}</strong></div>;
}
