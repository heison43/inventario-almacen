import { Download, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { listCampaigns, listLocations } from '../lib/db.js';
import { buildReconciliation, exportReconciliationXlsx } from '../lib/reconciliation.js';
import { formatNumber, statusLabel } from '../lib/utils.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullFromSupabase } from '../lib/remoteSync.js';

export default function ReconciliationPage({ selectedCampaignId }) {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState(selectedCampaignId || '');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [statusFilter, setStatusFilter] = useState('todos');
  const [locationFilter, setLocationFilter] = useState('todos');
  const [locations, setLocations] = useState([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadCampaigns(); }, []);
  useEffect(() => { if (selectedCampaignId) setCampaignId(selectedCampaignId); }, [selectedCampaignId]);
  useEffect(() => { if (campaignId) loadReconciliation(campaignId); }, [campaignId]);

  async function loadCampaigns() {
    if (isSupabaseConfigured) {
      const pulled = await pullFromSupabase();
      if (!pulled.ok) setMessage(`Aviso Supabase: ${pulled.message}`);
    }
    const rows = await listCampaigns();
    setCampaigns(rows);
    if (!campaignId && rows[0]) setCampaignId(rows[0].id);
  }

  async function loadReconciliation(id = campaignId) {
    if (!id) return;
    setLoading(true);
    if (isSupabaseConfigured) {
      const pulled = await pullFromSupabase();
      if (!pulled.ok) setMessage(`Aviso Supabase: ${pulled.message}`);
    }
    const [result, campaignLocations] = await Promise.all([buildReconciliation(id), listLocations(id)]);
    setRows(result.rows);
    setSummary(result.summary);
    setLocations(campaignLocations);
    setLocationFilter('todos');
    setLoading(false);
  }

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      const statusOk = statusFilter === 'todos' || row.status === statusFilter;
      const locationOk = locationFilter === 'todos' || row.location === locationFilter;
      const queryOk = !q || [row.material_code, row.material_name, row.material_name_cn, row.location, row.warehouse, row.zone, row.department]
        .join(' ')
        .toLowerCase()
        .includes(q);
      return statusOk && locationOk && queryOk;
    });
  }, [rows, statusFilter, locationFilter, query]);

  return (
    <section className="panel-card wide-card">
      <div className="section-title">
        <div>
          <h2>Conciliación de inventario</h2>
          <p>Comparativo por código totalizado en cada ubicación. La exportación sale con los campos definidos para cierre del conteo.</p>
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={() => loadReconciliation()} disabled={loading}><RefreshCw size={16} /> {loading ? 'Actualizando...' : 'Actualizar'}</button>
          <button className="primary-button" onClick={() => exportReconciliationXlsx(filteredRows)}><Download size={16} /> Exportar Excel</button>
        </div>
      </div>

      {message && <div className="info-box">{message}</div>}

      <div className="form-grid three-cols">
        <label>
          Campaña
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Seleccionar campaña</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        <label>
          Ubicación
          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
            <option value="todos">Todas</option>
            {locations.map((location) => <option key={location.id} value={location.location}>{location.location}</option>)}
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
          <div className="input-with-icon"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Código, material o ubicación..." /></div>
        </label>
      </div>

      <div className="stats-grid six-cols">
        <Stat label="Total códigos" value={summary.total || 0} />
        <Stat label="OK" value={summary.ok || 0} />
        <Stat label="Faltantes" value={summary.faltante || 0} />
        <Stat label="Sobrantes" value={summary.sobrante || 0} />
        <Stat label="Pendientes" value={summary.pendiente || 0} />
        <Stat label="Nuevos" value={summary.encontrado || 0} />
      </div>

      <div className="responsive-table">
        <table>
          <thead>
            <tr>
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
            {filteredRows.map((row, index) => (
              <tr key={`${row.material_code}-${row.batch}-${row.location}-${index}`}>
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
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
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
