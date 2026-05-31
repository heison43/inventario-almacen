import { FileSpreadsheet, RefreshCw, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { listAppUsers, listCampaigns, listLocations, updateLocation } from '../lib/db.js';
import { autoDetectMapping, createCampaignFromRows, parseInventoryFile, REQUIRED_FIELDS } from '../lib/importInventory.js';
import { deriveZoneFromLocation, formatNumber, statusLabel } from '../lib/utils.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullFromSupabase, pushCampaignBundle, syncPendingChanges } from '../lib/remoteSync.js';

const GROUPS = Array.from({ length: 10 }, (_, index) => `grupo${index + 1}`);
const visibleMappingFields = ['material_code', 'material_name', 'material_name_cn', 'unit', 'system_qty', 'location', 'department', 'warehouse'];
const technicalMappingFields = ['batch', 'purchase_order', 'unit_price', 'total_value'];

function FieldSelector({ field, mapping, setMapping, columns }) {
  return (
    <label>
      {field.label} {field.required && <span className="required">*</span>}
      {field.help && <small>{field.help}</small>}
      <select
        value={mapping[field.key] || ''}
        onChange={(e) => setMapping((current) => ({ ...current, [field.key]: e.target.value }))}
      >
        <option value="">No usar / valor por defecto</option>
        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
      </select>
    </label>
  );
}

export default function AdminDashboard({ user, onOpenReconciliation }) {
  const [campaigns, setCampaigns] = useState([]);
  const [counters, setCounters] = useState([]);
  const [fileInfo, setFileInfo] = useState(null);
  const [mapping, setMapping] = useState({});
  const [campaignName, setCampaignName] = useState('Inventario zona 2H01H02');
  const [warehouse, setWarehouse] = useState('Higabra');
  const [zone, setZone] = useState('2H01H02');
  const [filterByZone, setFilterByZone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncingRemote, setSyncingRemote] = useState(false);

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    if (isSupabaseConfigured) {
      setSyncingRemote(true);
      const pulled = await pullFromSupabase();
      if (!pulled.ok) setMessage(`Aviso Supabase: ${pulled.message}`);
      setSyncingRemote(false);
    }
    const [rows, userRows] = await Promise.all([listCampaigns(), listAppUsers('contador', { seedDefaults: !isSupabaseConfigured })]);
    const withLocations = await Promise.all(rows.map(async (campaign) => ({
      ...campaign,
      locations: await listLocations(campaign.id)
    })));
    setCampaigns(withLocations);
    setCounters(userRows);
  }

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setMessage('Leyendo archivo...');
    try {
      const parsed = await parseInventoryFile(file);
      setFileInfo({ ...parsed, fileName: file.name });
      setMapping(autoDetectMapping(parsed.columns));
      setMessage(`Archivo cargado: ${formatNumber(parsed.rows.length)} líneas leídas. Revisa el mapeo antes de crear la campaña.`);
    } catch (error) {
      setMessage(`Error leyendo archivo: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  const requiredMissing = useMemo(() => {
    return REQUIRED_FIELDS.filter((field) => field.required && !mapping[field.key]);
  }, [mapping]);

  const normalizedZone = useMemo(() => deriveZoneFromLocation(zone, zone), [zone]);

  async function importCampaign() {
    if (!fileInfo?.rows?.length) {
      setMessage('Primero selecciona un archivo.');
      return;
    }
    if (requiredMissing.length) {
      setMessage(`Faltan columnas obligatorias: ${requiredMissing.map((field) => field.label).join(', ')}. Revisa la sección técnica del mapeo.`);
      return;
    }
    setLoading(true);
    setMessage('Creando campaña y consolidando información...');
    try {
      const result = await createCampaignFromRows({
        campaignName,
        defaultWarehouse: warehouse,
        defaultZone: zone,
        filterByDefaultZone: filterByZone,
        rows: fileInfo.rows,
        mapping,
        createdBy: user
      });
      let remoteMessage = '';
      if (isSupabaseConfigured) {
        const pushed = await pushCampaignBundle(result);
        remoteMessage = pushed.ok ? ` ${pushed.message}` : ` No se pudo subir a Supabase: ${pushed.message}`;
      }
      setMessage(`Campaña creada: ${formatNumber(result.locations.length)} ubicaciones y ${formatNumber(result.snapshotItems.length)} líneas consolidadas. Zona calculada desde la ubicación.${remoteMessage}`);
      setFileInfo(null);
      await refresh();
    } catch (error) {
      setMessage(`Error importando campaña: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function assignLocation(locationId, changes) {
    const next = { ...changes };
    if ('assigned_to' in next) next.status = next.assigned_to ? 'asignada' : 'pendiente';
    await updateLocation(locationId, next);
    if (isSupabaseConfigured) await syncPendingChanges(user);
    await refresh();
  }

  const mappingFields = REQUIRED_FIELDS.filter((field) => visibleMappingFields.includes(field.key));
  const technicalFields = REQUIRED_FIELDS.filter((field) => technicalMappingFields.includes(field.key));

  return (
    <div className="page-grid">
      <section className="panel-card wide-card">
        <div className="section-title">
          <div>
            <h2>Cargar inventario de zona</h2>
            <p>Sube la plantilla oficial de inventario. El sistema consolida por almacén + zona + ubicación + código.</p>
          </div>
          <a className="secondary-button" href="/templates/plantilla_inventario.csv" download>
            Descargar plantilla
          </a>
        </div>

        <div className="form-grid three-cols">
          <label>
            Nombre de campaña
            <input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
          </label>
          <label>
            Almacén lógico por defecto
            <input value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="Ejemplo: Higabra" />
          </label>
          <label>
            Zona a contar
            <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Ejemplo: 2H01H02" />
            <small>Zona normalizada: {normalizedZone || '—'}</small>
          </label>
        </div>

        <label className="inline-check">
          <input type="checkbox" checked={filterByZone} onChange={(e) => setFilterByZone(e.target.checked)} />
          Importar solo ubicaciones cuya zona calculada sea <strong>{normalizedZone || 'la zona indicada'}</strong>
        </label>

        <div className="info-box soft">
          La zona se calcula automáticamente desde la ubicación. Ejemplo: <strong>2H01H0203</strong> pertenece a la zona <strong>2H01H02</strong>. El mapeo principal sigue la plantilla oficial: código, descripción, descripción en chino, UM, inventario total, ubicación, solicitante y almacén.
        </div>

        <label className="upload-box">
          <FileSpreadsheet size={28} />
          <strong>Seleccionar archivo Excel/CSV</strong>
          <span>Formatos soportados: .xlsx, .xls, .csv</span>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} />
        </label>

        {fileInfo && (
          <div className="mapping-card">
            <div className="section-title compact">
              <div>
                <h3>Mapeo de columnas</h3>
                <p>{fileInfo.fileName} · {formatNumber(fileInfo.rows.length)} líneas · Hoja: {fileInfo.sheetName}</p>
              </div>
            </div>
            <div className="mapping-grid four-cols">
              {mappingFields.map((field) => (
                <FieldSelector key={field.key} field={field} mapping={mapping} setMapping={setMapping} columns={fileInfo.columns} />
              ))}
            </div>
            <details className="assignment-panel technical-mapping">
              <summary>Ajustes técnicos de importación</summary>
              <p className="muted-text">Normalmente no tienes que modificar estos campos. Si la plantilla no trae lote, el sistema usará S/L automáticamente.</p>
              <div className="mapping-grid three-cols">
                {technicalFields.map((field) => (
                  <FieldSelector key={field.key} field={field} mapping={mapping} setMapping={setMapping} columns={fileInfo.columns} />
                ))}
              </div>
            </details>
            <button className="primary-button" disabled={loading} onClick={importCampaign}>
              Crear campaña con este archivo
            </button>
          </div>
        )}

        {message && <div className="info-box">{message}</div>}
      </section>

      <section className="panel-card wide-card">
        <div className="section-title">
          <div>
            <h2>Campañas creadas</h2>
            <p>Desde aquí puedes revisar conciliación y asignar ubicaciones a cada contador y grupo.</p>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={refresh} disabled={syncingRemote}><RefreshCw size={16} /> {syncingRemote ? 'Actualizando...' : 'Actualizar'}</button>
          </div>
        </div>

        <div className="campaign-admin-list">
          {campaigns.map((campaign) => (
            <article key={campaign.id} className="campaign-card admin-campaign-card">
              <div className="campaign-card-head">
                <div>
                  <span className="status-pill active">{campaign.status}</span>
                  <h3>{campaign.name}</h3>
                  <p>{campaign.warehouse} · Zona {campaign.zone}</p>
                </div>
                <button className="secondary-button" onClick={() => onOpenReconciliation(campaign.id)}>
                  Ver conciliación
                </button>
              </div>
              <div className="metrics-row">
                <span><strong>{campaign.locations.length}</strong> ubicaciones</span>
                <span><strong>{campaign.locations.filter((location) => location.assigned_to).length}</strong> asignadas</span>
                <span><strong>{new Date(campaign.created_at).toLocaleDateString()}</strong> corte</span>
              </div>

              <details className="assignment-panel">
                <summary><UsersRound size={16} /> Abrir asignación de ubicaciones por contador y grupo</summary>
                <div className="responsive-table compact-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Ubicación</th>
                        <th>Estado</th>
                        <th>Grupo</th>
                        <th>Contador asignado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaign.locations.map((location) => (
                        <tr key={location.id}>
                          <td><strong>{location.location}</strong></td>
                          <td><span className={`status-pill ${location.status}`}>{statusLabel(location.status)}</span></td>
                          <td>
                            <select value={location.assigned_group || ''} onChange={(e) => assignLocation(location.id, { assigned_group: e.target.value || null })}>
                              <option value="">Sin grupo</option>
                              {GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={location.assigned_to || ''} onChange={(e) => assignLocation(location.id, { assigned_to: e.target.value || null })}>
                              <option value="">Sin asignar</option>
                              {counters.map((counter) => (
                                <option key={counter.id} value={counter.email}>{counter.name} · {counter.email}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          ))}
          {!campaigns.length && <div className="empty-state">Aún no hay campañas cargadas.</div>}
        </div>
      </section>
    </div>
  );
}
