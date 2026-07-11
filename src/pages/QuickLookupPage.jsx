import { Download, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { buildMaterialLookup, exportReconciliationXlsx } from '../lib/reconciliation.js';
import { formatNumber, statusLabel } from '../lib/utils.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullFromSupabase } from '../lib/remoteSync.js';

export default function QuickLookupPage({ user }) {
  const [input, setInput] = useState('');
  const [searchedCode, setSearchedCode] = useState('');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(emptySummary());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [hasSearched, setHasSearched] = useState(false);

  const canSearch = input.trim().length > 0 && !loading;

  async function runSearch(code = input) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) {
      setMessage('Escribe el código completo del material.');
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      const result = await buildMaterialLookup(cleanCode);
      setRows(result.rows);
      setSummary(result.summary);
      setSearchedCode(cleanCode);
      setHasSearched(true);
      if (!result.rows.length) {
        setMessage(`No se encontraron registros locales para el código ${cleanCode}. Usa “Actualizar base” y vuelve a buscar.`);
      }
    } catch (error) {
      setMessage(error?.message || 'No fue posible consultar el código.');
    } finally {
      setLoading(false);
    }
  }

  async function refreshAndSearch() {
    if (!isSupabaseConfigured) {
      setMessage('Supabase no está configurado. La consulta seguirá usando la información local disponible.');
      return;
    }

    setRefreshing(true);
    setMessage('Actualizando la base local desde Supabase...');
    try {
      const result = await pullFromSupabase(user);
      if (!result.ok) {
        setMessage(`No se pudo actualizar completamente: ${result.message}`);
        return;
      }
      setMessage('Base local actualizada. Buscando el código...');
      if (input.trim()) await runSearch(input);
      else setMessage('Base local actualizada correctamente.');
    } catch (error) {
      setMessage(error?.message || 'No fue posible actualizar la base local.');
    } finally {
      setRefreshing(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    runSearch();
  }

  const uniqueCampaigns = useMemo(
    () => new Set(rows.map((row) => row.campaign_id).filter(Boolean)).size,
    [rows]
  );

  return (
    <section className="panel-card wide-card quick-lookup-page">
      <div className="section-title">
        <div>
          <h2>Consulta rápida por código</h2>
          <p>Busca un código exacto sin cargar toda la conciliación. La consulta usa la base local y muestra solo sus ubicaciones.</p>
        </div>
        <button className="secondary-button" onClick={refreshAndSearch} disabled={refreshing || loading}>
          <RefreshCw size={16} /> {refreshing ? 'Actualizando base...' : 'Actualizar base'}
        </button>
      </div>

      <form className="quick-search-box" onSubmit={handleSubmit}>
        <label htmlFor="quick-material-code">Código de material</label>
        <div className="quick-search-row">
          <div className="input-with-icon quick-search-input">
            <Search size={20} />
            <input
              id="quick-material-code"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ejemplo: 2010016219"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <button className="primary-button" type="submit" disabled={!canSearch}>
            <Search size={17} /> {loading ? 'Buscando...' : 'Buscar código'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!rows.length}
            onClick={() => exportReconciliationXlsx(rows, `consulta-${searchedCode || 'codigo'}.xlsx`)}
          >
            <Download size={17} /> Exportar resultado
          </button>
        </div>
        <small>Para ver información reciente, presiona “Actualizar base” una sola vez al iniciar la revisión o después de nuevos cambios.</small>
      </form>

      {message && <div className="info-box">{message}</div>}

      {hasSearched && (
        <>
          <div className="quick-result-heading">
            <div>
              <span>Resultado para</span>
              <strong>{searchedCode}</strong>
            </div>
            <small>{uniqueCampaigns} campaña(s) encontrada(s)</small>
          </div>

          <div className="stats-grid six-cols">
            <Stat label="Registros" value={summary.matches} />
            <Stat label="Ubicaciones" value={summary.locations} />
            <Stat label="Sistema total" value={summary.system_qty} />
            <Stat label="Físico total" value={summary.physical_qty} />
            <Stat label="Diferencia total" value={summary.difference} />
            <Stat label="Encontrados nuevos" value={summary.found} />
          </div>

          <div className="responsive-table quick-result-table">
            <table>
              <thead>
                <tr>
                  <th>Campaña</th>
                  <th>Almacén</th>
                  <th>Zona</th>
                  <th>Ubicación</th>
                  <th>Grupo</th>
                  <th>Código</th>
                  <th>Descripción</th>
                  <th>UM</th>
                  <th>Sistema</th>
                  <th>Físico</th>
                  <th>Diferencia</th>
                  <th>Estado</th>
                  <th>Estado físico</th>
                  <th>Cant. afectada</th>
                  <th>Comentario</th>
                  <th>Usuario</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((row, index) => (
                  <tr key={`${row.campaign_id}-${row.location}-${row.material_code}-${row.unit}-${index}`}>
                    <td>{row.campaign_name || ''}</td>
                    <td>{row.warehouse || ''}</td>
                    <td>{row.zone || ''}</td>
                    <td><strong>{row.location || ''}</strong></td>
                    <td>{row.assigned_group || 'Sin grupo'}</td>
                    <td><strong>{row.material_code}</strong></td>
                    <td>{row.material_name || ''}</td>
                    <td>{row.unit || ''}</td>
                    <td>{formatNumber(row.system_qty || 0)}</td>
                    <td>{row.physical_qty === null || row.physical_qty === undefined ? '' : formatNumber(row.physical_qty)}</td>
                    <td>{row.difference === null || row.difference === undefined ? '' : formatNumber(row.difference)}</td>
                    <td><span className={`status-pill ${row.status}`}>{statusLabel(row.status)}</span></td>
                    <td>{conditionLabel(row.material_condition)}</td>
                    <td>{row.condition_qty ?? ''}</td>
                    <td>{row.comment || ''}</td>
                    <td>{row.counted_by || ''}</td>
                  </tr>
                )) : (
                  <tr><td colSpan="16" className="empty-cell">No se encontraron registros para este código.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function emptySummary() {
  return { matches: 0, locations: 0, system_qty: 0, physical_qty: 0, difference: 0, found: 0 };
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
  return <div className="stat-card"><span>{label}</span><strong>{formatNumber(value || 0)}</strong></div>;
}
