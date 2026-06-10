import { FileSpreadsheet, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { listAppUsers, listCampaigns, listLocations, updateLocation, updateLocationsBulk } from '../lib/db.js';
import { autoDetectMapping, createCampaignFromRows, parseInventoryFile, REQUIRED_FIELDS } from '../lib/importInventory.js';
import { deriveZoneFromLocation, formatNumber, statusLabel } from '../lib/utils.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { deleteCampaignEverywhere, pullFromSupabase, pushCampaignBundle, syncPendingChanges } from '../lib/remoteSync.js';

const GROUPS = Array.from({ length: 20 }, (_, index) => `grupo${index + 1}`);
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
  const [campaignName, setCampaignName] = useState('Inventario zona');
  const [warehouse, setWarehouse] = useState('Higabra');
  const [zone, setZone] = useState('');
  const [filterByZone, setFilterByZone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [syncingRemote, setSyncingRemote] = useState(false);
  const [bulkAssignments, setBulkAssignments] = useState({});
  const [savingBulkId, setSavingBulkId] = useState('');

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
    if (filterByZone && !normalizedZone) {
      setMessage('Ingresa la zona a contar antes de crear la campaña. Esto evita crear campañas vacías por error.');
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

  function updateCampaignLocationState(locationId, updatedRow) {
    setCampaigns((current) => current.map((campaign) => ({
      ...campaign,
      locations: campaign.locations.map((location) => (location.id === locationId ? { ...location, ...updatedRow } : location))
    })));
  }

  function updateCampaignLocationsState(campaignId, updatedRows) {
    const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
    setCampaigns((current) => current.map((campaign) => {
      if (campaign.id !== campaignId) return campaign;
      return {
        ...campaign,
        locations: campaign.locations.map((location) => updatedById.has(location.id) ? { ...location, ...updatedById.get(location.id) } : location)
      };
    }));
  }

  async function assignLocation(locationId, changes) {
    const next = { ...changes };
    if ('assigned_to' in next) next.status = next.assigned_to ? 'asignada' : 'pendiente';
    const updated = await updateLocation(locationId, next);
    if (updated) updateCampaignLocationState(locationId, updated);
    if (isSupabaseConfigured) {
      const synced = await syncPendingChanges(user);
      if (!synced.ok) setMessage(`Aviso Supabase: ${synced.message}`);
    }
  }

  function getBulkAssignment(campaignId) {
    return bulkAssignments[campaignId] || { from: '', to: '', assigned_group: '', assigned_to: '' };
  }

  function setBulkAssignmentField(campaignId, field, value) {
    setBulkAssignments((current) => ({
      ...current,
      [campaignId]: {
        ...(current[campaignId] || { from: '', to: '', assigned_group: '', assigned_to: '' }),
        [field]: value
      }
    }));
  }

  function locationsInRange(locations, from, to) {
    const start = String(from || '').trim().toUpperCase();
    const end = String(to || '').trim().toUpperCase();
    if (!start || !end) return [];
    const min = start.localeCompare(end) <= 0 ? start : end;
    const max = start.localeCompare(end) <= 0 ? end : start;
    return (locations || []).filter((location) => {
      const value = String(location.location || '').trim().toUpperCase();
      return value.localeCompare(min) >= 0 && value.localeCompare(max) <= 0;
    });
  }

  async function applyBulkAssignment(campaign) {
    const bulk = getBulkAssignment(campaign.id);
    const targetLocations = locationsInRange(campaign.locations, bulk.from, bulk.to);

    if (!bulk.from || !bulk.to) {
      setMessage('Selecciona ubicación inicial y ubicación final para aplicar la asignación masiva.');
      return;
    }
    if (!targetLocations.length) {
      setMessage('No se encontraron ubicaciones dentro del rango indicado.');
      return;
    }
    if (!bulk.assigned_group && !bulk.assigned_to) {
      setMessage('Selecciona al menos un grupo o un contador para aplicar al rango.');
      return;
    }

    const changes = {};
    if (bulk.assigned_group) changes.assigned_group = bulk.assigned_group === '__clear__' ? null : bulk.assigned_group;
    if (bulk.assigned_to) {
      changes.assigned_to = bulk.assigned_to === '__clear__' ? null : bulk.assigned_to;
      changes.status = changes.assigned_to ? 'asignada' : 'pendiente';
    }

    const confirmation = window.confirm(
      `Se actualizarán ${targetLocations.length} ubicaciones de la campaña "${campaign.name}".\n\n` +
      `Desde: ${bulk.from}\nHasta: ${bulk.to}\n\n¿Deseas continuar?`
    );
    if (!confirmation) return;

    setSavingBulkId(campaign.id);
    setMessage(`Aplicando asignación masiva a ${targetLocations.length} ubicaciones...`);
    try {
      const updatedRows = await updateLocationsBulk(targetLocations.map((location) => ({ id: location.id, changes })));
      updateCampaignLocationsState(campaign.id, updatedRows);

      if (isSupabaseConfigured) {
        const synced = await syncPendingChanges(user);
        setMessage(synced.ok
          ? `Asignación masiva aplicada a ${updatedRows.length} ubicaciones. ${synced.message}`
          : `Asignación masiva guardada localmente, pero falta sincronizar con Supabase: ${synced.message}`
        );
      } else {
        setMessage(`Asignación masiva aplicada localmente a ${updatedRows.length} ubicaciones.`);
      }
    } catch (error) {
      setMessage(`Error aplicando asignación masiva: ${error.message}`);
    } finally {
      setSavingBulkId('');
    }
  }

  async function handleDeleteCampaign(campaign) {
    const confirmation = window.confirm(
      `Vas a eliminar la campaña "${campaign.name}".\n\n` +
      'Esta acción borra la campaña, sus ubicaciones y la base importada asociada. ' +
      'Por seguridad, la app no la eliminará si ya tiene conteos o códigos nuevos sincronizados.\n\n' +
      '¿Deseas continuar?'
    );
    if (!confirmation) return;

    setLoading(true);
    setMessage(`Eliminando campaña ${campaign.name}...`);
    const result = await deleteCampaignEverywhere(campaign.id);
    setMessage(result.ok ? result.message : `No se pudo eliminar: ${result.message}`);
    setLoading(false);
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
            <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Obligatorio. Ejemplo: 2H01H02" />
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
                <div className="button-row compact-actions">
                  <button className="secondary-button" onClick={() => onOpenReconciliation(campaign.id)}>
                    Ver conciliación
                  </button>
                  <button className="danger-button subtle-danger" onClick={() => handleDeleteCampaign(campaign)} disabled={loading}>
                    <Trash2 size={16} /> Eliminar
                  </button>
                </div>
              </div>
              <div className="metrics-row">
                <span><strong>{campaign.locations.length}</strong> ubicaciones</span>
                <span><strong>{campaign.locations.filter((location) => location.assigned_to).length}</strong> asignadas</span>
                <span><strong>{new Date(campaign.created_at).toLocaleDateString()}</strong> corte</span>
              </div>

              <details className="assignment-panel">
                <summary><UsersRound size={16} /> Abrir asignación de ubicaciones por contador y grupo</summary>

                <div className="bulk-assignment-card">
                  <div>
                    <h4>Asignación masiva por rango</h4>
                    <p className="muted-text">Selecciona desde qué ubicación hasta qué ubicación quieres aplicar el mismo grupo y/o contador. La app guarda todo el rango de una sola vez.</p>
                  </div>
                  <div className="bulk-assignment-grid">
                    <label>
                      Desde ubicación
                      <select
                        value={getBulkAssignment(campaign.id).from}
                        onChange={(e) => setBulkAssignmentField(campaign.id, 'from', e.target.value)}
                      >
                        <option value="">Seleccionar inicio</option>
                        {campaign.locations.map((location) => <option key={`from-${location.id}`} value={location.location}>{location.location}</option>)}
                      </select>
                    </label>
                    <label>
                      Hasta ubicación
                      <select
                        value={getBulkAssignment(campaign.id).to}
                        onChange={(e) => setBulkAssignmentField(campaign.id, 'to', e.target.value)}
                      >
                        <option value="">Seleccionar final</option>
                        {campaign.locations.map((location) => <option key={`to-${location.id}`} value={location.location}>{location.location}</option>)}
                      </select>
                    </label>
                    <label>
                      Grupo
                      <select
                        value={getBulkAssignment(campaign.id).assigned_group}
                        onChange={(e) => setBulkAssignmentField(campaign.id, 'assigned_group', e.target.value)}
                      >
                        <option value="">No cambiar grupo</option>
                        <option value="__clear__">Quitar grupo</option>
                        {GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
                      </select>
                    </label>
                    <label>
                      Contador
                      <select
                        value={getBulkAssignment(campaign.id).assigned_to}
                        onChange={(e) => setBulkAssignmentField(campaign.id, 'assigned_to', e.target.value)}
                      >
                        <option value="">No cambiar contador</option>
                        <option value="__clear__">Quitar contador</option>
                        {counters.map((counter) => (
                          <option key={counter.id} value={counter.email}>{counter.name} · {counter.email}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="primary-button bulk-apply-button"
                      onClick={() => applyBulkAssignment(campaign)}
                      disabled={savingBulkId === campaign.id}
                    >
                      {savingBulkId === campaign.id ? 'Aplicando...' : 'Aplicar rango'}
                    </button>
                  </div>
                  <small className="muted-text">
                    Ubicaciones afectadas con el rango actual: {locationsInRange(campaign.locations, getBulkAssignment(campaign.id).from, getBulkAssignment(campaign.id).to).length}
                  </small>
                </div>

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
