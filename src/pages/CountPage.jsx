import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Download, Plus, Search, Trash2, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  buildGroupCountId,
  getCampaign,
  getLocation,
  deleteFoundItem,
  listFoundItemsByLocation,
  listGroupCountsByLocation,
  listSnapshotByLocation,
  saveFoundItem,
  updateGroupCount,
  updateLocation
} from '../lib/db.js';
import { exportLocalBackup } from '../lib/reconciliation.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullLocationFromSupabase } from '../lib/remoteSync.js';
import { formatNumber, getStatusFromDifference, statusLabel, toNumber } from '../lib/utils.js';

const MATERIAL_CONDITIONS = [
  { value: 'buen_estado', label: 'Buen estado' },
  { value: 'mal_estado', label: 'Mal estado' },
  { value: 'vencido', label: 'Vencido' },
  { value: 'averiado', label: 'Averiado' },
  { value: 'oxidado', label: 'Oxidado' },
  { value: 'sin_identificar', label: 'Sin identificar' },
  { value: 'otro', label: 'Otro' }
];

function conditionLabel(value) {
  return MATERIAL_CONDITIONS.find((item) => item.value === value)?.label || 'Buen estado';
}

function groupSnapshotRows(snapshots, groupCounts, foundItems) {
  const countMap = new Map(groupCounts.map((count) => [count.id, count]));
  const groupMap = new Map();

  for (const item of snapshots) {
    const key = buildGroupCountId({
      campaign_id: item.campaign_id,
      location_id: item.location_id,
      warehouse: item.warehouse,
      zone: item.zone,
      location: item.location,
      material_code: item.material_code,
      unit: item.unit
    });

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        id: key,
        campaign_id: item.campaign_id,
        location_id: item.location_id,
        warehouse: item.warehouse,
        zone: item.zone,
        location: item.location,
        material_code: item.material_code,
        material_name: item.material_name,
        material_name_cn: item.material_name_cn || '',
        unit: item.unit,
        department: item.department || '',
        system_qty: 0,
        raw_lines: 0,
        lots: [],
        is_found: false,
        count: countMap.get(key) || null
      });
    }

    const group = groupMap.get(key);
    group.system_qty += Number(item.system_qty || 0);
    group.raw_lines += Number(item.raw_lines || 1);
    group.lots.push({ batch: item.batch || 'S/L', system_qty: Number(item.system_qty || 0), raw_lines: item.raw_lines || 1 });
  }

  const groups = Array.from(groupMap.values()).map((group) => ({
    ...group,
    lots: group.lots.sort((a, b) => String(a.batch).localeCompare(String(b.batch)))
  }));

  const foundGroups = foundItems.map((item) => ({
    id: item.id,
    campaign_id: item.campaign_id,
    location_id: item.location_id,
    warehouse: item.warehouse,
    zone: item.zone,
    location: item.location,
    material_code: item.material_code,
    material_name: item.material_name || 'Material no inventariado',
    material_name_cn: item.material_name_cn || '',
    unit: item.unit || '',
    department: '',
    system_qty: 0,
    raw_lines: 0,
    lots: [{ batch: item.batch || 'S/L', system_qty: 0, raw_lines: 0 }],
    is_found: true,
    found_record: item,
    count: {
      physical_qty: item.physical_qty,
      status: 'encontrado',
      counted_by: item.registered_by,
      counted_at: item.created_at,
      material_condition: item.material_condition || 'buen_estado',
      condition_qty: item.condition_qty ?? 0,
      comment: item.comment || ''
    }
  }));

  return [...groups, ...foundGroups].sort((a, b) => `${a.material_code}-${a.material_name}`.localeCompare(`${b.material_code}-${b.material_name}`));
}

export default function CountPage({ user, campaignId, locationId, onBack }) {
  const [campaign, setCampaign] = useState(null);
  const [location, setLocation] = useState(null);
  const [snapshotRows, setSnapshotRows] = useState([]);
  const [groupCounts, setGroupCounts] = useState([]);
  const [foundItems, setFoundItems] = useState([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [showFoundForm, setShowFoundForm] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [selectedRowId, setSelectedRowId] = useState('');
  const [foundForm, setFoundForm] = useState({
    material_code: '',
    material_name: '',
    material_name_cn: '',
    unit: '',
    batch: '',
    physical_qty: '',
    material_condition: 'buen_estado',
    condition_qty: '',
    comment: ''
  });

  useEffect(() => { load(); }, [campaignId, locationId]);

  async function load() {
    // Limpiamos temporalmente la tabla para evitar que se vea información de una
    // ubicación anterior mientras carga la ubicación actual.
    setSnapshotRows([]);
    setGroupCounts([]);
    setFoundItems([]);

    const [campaignRow, locationRow] = await Promise.all([
      getCampaign(campaignId),
      getLocation(locationId)
    ]);

    setCampaign(campaignRow);
    setLocation(locationRow);

    if (isSupabaseConfigured) {
      const pulled = await pullLocationFromSupabase(locationId);
      if (!pulled.ok) setMessage(`Aviso Supabase: ${pulled.message}. Se muestran datos locales disponibles.`);
    }

    const [snapshots, counts, found] = await Promise.all([
      listSnapshotByLocation(locationId),
      listGroupCountsByLocation(locationId),
      listFoundItemsByLocation(locationId)
    ]);

    // Filtro defensivo: aunque el navegador tenga datos locales viejos o mezclados,
    // la pantalla solo muestra registros de esta campaña y esta ubicación.
    const exactLocation = String(locationRow?.location || '').trim();
    const exactSnapshots = snapshots.filter((row) =>
      row.campaign_id === campaignId &&
      row.location_id === locationId &&
      (!exactLocation || String(row.location || '').trim() === exactLocation)
    );
    const exactCounts = counts.filter((row) =>
      row.campaign_id === campaignId &&
      row.location_id === locationId &&
      (!exactLocation || String(row.location || '').trim() === exactLocation)
    );
    const exactFound = found.filter((row) =>
      row.campaign_id === campaignId &&
      row.location_id === locationId &&
      (!exactLocation || String(row.location || '').trim() === exactLocation)
    );

    setSnapshotRows(exactSnapshots);
    setGroupCounts(exactCounts);
    setFoundItems(exactFound);

    if (locationRow?.status === 'pendiente' || locationRow?.status === 'asignada') {
      await updateLocation(locationId, { status: 'en_conteo' });
    }
  }

  const groupedRows = useMemo(() => groupSnapshotRows(snapshotRows, groupCounts, foundItems), [snapshotRows, groupCounts, foundItems]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groupedRows;
    return groupedRows.filter((item) =>
      [item.material_code, item.material_name, item.material_name_cn, item.unit, item.location, item.count?.comment, ...item.lots.map((lot) => lot.batch)]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [groupedRows, query]);

  const stats = useMemo(() => {
    return groupedRows.reduce((acc, item) => {
      const qty = item.count?.physical_qty;
      const status = item.is_found ? 'encontrado' : getStatusFromDifference(qty, item.system_qty);
      acc.total += 1;
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, { total: 0, ok: 0, faltante: 0, sobrante: 0, pendiente: 0, encontrado: 0 });
  }, [groupedRows]);

  async function saveGroupChange(item, changes) {
    if (item.is_found) return;
    const physicalQty = changes.physical_qty !== undefined
      ? (changes.physical_qty === '' ? null : Number(changes.physical_qty))
      : item.count?.physical_qty;
    const status = getStatusFromDifference(physicalQty, item.system_qty);
    const updated = await updateGroupCount(item, {
      physical_qty: physicalQty,
      status,
      counted_by: user.email,
      counted_at: new Date().toISOString(),
      material_condition: item.count?.material_condition || 'buen_estado',
      condition_qty: item.count?.condition_qty ?? 0,
      comment: item.count?.comment || '',
      ...changes,
      physical_qty: physicalQty
    });

    setGroupCounts((current) => {
      const exists = current.some((row) => row.id === updated.id);
      return exists ? current.map((row) => (row.id === updated.id ? updated : row)) : [...current, updated];
    });
  }

  async function addFoundItem(event) {
    event.preventDefault();
    if (!foundForm.material_code.trim() || foundForm.physical_qty === '') {
      setMessage('Para agregar un código nuevo debes ingresar mínimo código y cantidad física.');
      return;
    }

    await saveFoundItem({
      campaign_id: campaignId,
      location_id: locationId,
      warehouse: location.warehouse,
      zone: location.zone,
      location: location.location,
      material_code: foundForm.material_code.trim(),
      material_name: foundForm.material_name.trim() || 'Material no inventariado',
      material_name_cn: foundForm.material_name_cn.trim(),
      unit: foundForm.unit.trim(),
      batch: foundForm.batch.trim() || 'S/L',
      physical_qty: toNumber(foundForm.physical_qty),
      material_condition: foundForm.material_condition,
      condition_qty: foundForm.condition_qty === '' ? 0 : toNumber(foundForm.condition_qty),
      comment: foundForm.comment.trim(),
      registered_by: user.email
    });

    setFoundForm({ material_code: '', material_name: '', material_name_cn: '', unit: '', batch: '', physical_qty: '', material_condition: 'buen_estado', condition_qty: '', comment: '' });
    setShowFoundForm(false);
    setMessage('Código nuevo agregado con cantidad sistema 0. Quedará como encontrado físico en conciliación.');
    await load();
  }


  async function updateFoundItem(item, changes) {
    if (!item.is_found || !item.found_record) return;
    const current = item.found_record;
    const updated = await saveFoundItem({
      ...current,
      ...changes,
      physical_qty: changes.physical_qty !== undefined
        ? (changes.physical_qty === '' ? 0 : toNumber(changes.physical_qty))
        : Number(current.physical_qty || 0),
      condition_qty: changes.condition_qty !== undefined
        ? (changes.condition_qty === '' ? 0 : toNumber(changes.condition_qty))
        : Number(current.condition_qty || 0),
      comment: changes.comment !== undefined ? String(changes.comment || '') : (current.comment || '')
    });

    setFoundItems((currentRows) => currentRows.map((row) => (row.id === updated.id ? updated : row)));
  }

  async function removeFoundItem(item) {
    if (!item.is_found || !item.id) return;
    const ok = window.confirm(`¿Eliminar el código nuevo ${item.material_code}? Esta acción se sincronizará con Supabase.`);
    if (!ok) return;
    await deleteFoundItem(item.id);
    setFoundItems((currentRows) => currentRows.filter((row) => row.id !== item.id));
    setMessage('Código nuevo eliminado. Recuerda sincronizar para aplicar el cambio en Supabase.');
  }

  async function finishLocation() {
    const pending = stats.pendiente;
    if (pending > 0) {
      setMessage(`No se puede finalizar la ubicación. Aún quedan ${pending} códigos pendientes por contar.`);
      return;
    }
    await updateLocation(locationId, { status: 'finalizada', finished_at: new Date().toISOString() });
    setMessage('Ubicación marcada como finalizada.');
    await load();
  }

  function backup() {
    const rows = groupedRows.map((item) => ({
      Campaña: campaign?.name,
      Almacen: item.warehouse,
      Zona: item.zone,
      Ubicacion: item.location,
      Codigo: item.material_code,
      DescripcionArticulo: item.material_name,
      DescripcionChino: item.material_name_cn || '',
      UM: item.unit,
      Solicitante: item.department || '',
      Lotes: item.lots.map((lot) => `${lot.batch}: ${formatNumber(lot.system_qty)}`).join(' | '),
      CantidadFisica: item.count?.physical_qty ?? '',
      Diferencia: item.count?.physical_qty === null || item.count?.physical_qty === undefined ? '' : Number(item.count.physical_qty) - Number(item.system_qty || 0),
      Estado: item.is_found ? 'encontrado' : (item.count?.status || 'pendiente'),
      UsuarioConteo: item.count?.counted_by || '',
      EstadoFisico: conditionLabel(item.count?.material_condition || 'buen_estado'),
      CantidadEstadoFisico: item.count?.condition_qty ?? '',
      Comentario: item.count?.comment || ''
    }));
    exportLocalBackup(rows, `respaldo-${location?.location || 'ubicacion'}.xlsx`);
  }

  if (!campaign || !location) return <div className="panel-card">Cargando conteo...</div>;

  return (
    <section className="panel-card wide-card count-page">
      <div className="section-title">
        <div>
          <button className="text-button" onClick={onBack}><ArrowLeft size={16} /> Volver</button>
          <h2>{location.location}</h2>
          <p>{campaign.name} · {location.warehouse} · Zona {location.zone}{location.assigned_group ? ` · ${location.assigned_group}` : ''}</p>
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={() => setShowFoundForm(true)}><Plus size={16} /> Agregar código nuevo</button>
          <button className="secondary-button" onClick={backup}><Download size={16} /> Respaldo local</button>
          <button className="primary-button" onClick={finishLocation}><CheckCircle2 size={16} /> Finalizar ubicación</button>
        </div>
      </div>

      <div className="stats-grid six-cols">
        <Stat label="Total códigos" value={stats.total} />
        <Stat label="OK" value={stats.ok} />
        <Stat label="Faltantes" value={stats.faltante} />
        <Stat label="Sobrantes" value={stats.sobrante} />
        <Stat label="Pendientes" value={stats.pendiente} />
        <Stat label="Nuevos" value={stats.encontrado} />
      </div>

      <div className="search-box">
        <Search size={18} />
        <input placeholder="Buscar por código, nombre, UM, lote o comentario..." value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {showFoundForm && (
        <form className="found-form" onSubmit={addFoundItem}>
          <div className="section-title compact">
            <div>
              <h3>Agregar código encontrado físicamente</h3>
              <p>Quedará con sistema 0 y diferencia igual a la cantidad física. El lote es opcional.</p>
            </div>
            <button className="icon-button" type="button" onClick={() => setShowFoundForm(false)}><X size={16} /></button>
          </div>
          <div className="form-grid four-cols">
            <label>
              Código *
              <input value={foundForm.material_code} onChange={(e) => setFoundForm((current) => ({ ...current, material_code: e.target.value }))} />
            </label>
            <label>
              Nombre material
              <input value={foundForm.material_name} onChange={(e) => setFoundForm((current) => ({ ...current, material_name: e.target.value }))} />
            </label>
            <label>
              Descripción en chino
              <input value={foundForm.material_name_cn} onChange={(e) => setFoundForm((current) => ({ ...current, material_name_cn: e.target.value }))} />
            </label>
            <label>
              UM
              <input value={foundForm.unit} onChange={(e) => setFoundForm((current) => ({ ...current, unit: e.target.value }))} placeholder="EA, ST, M3..." />
            </label>
            <label>
              Lote opcional
              <input value={foundForm.batch} onChange={(e) => setFoundForm((current) => ({ ...current, batch: e.target.value }))} placeholder="S/L si se deja vacío" />
            </label>
            <label>
              Cantidad física *
              <input type="number" step="0.001" value={foundForm.physical_qty} onChange={(e) => setFoundForm((current) => ({ ...current, physical_qty: e.target.value }))} />
            </label>
            <label>
              Estado físico
              <select value={foundForm.material_condition} onChange={(e) => setFoundForm((current) => ({ ...current, material_condition: e.target.value }))}>
                {MATERIAL_CONDITIONS.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
              </select>
            </label>
            <label>
              Cantidad afectada
              <input type="number" step="0.001" value={foundForm.condition_qty} onChange={(e) => setFoundForm((current) => ({ ...current, condition_qty: e.target.value }))} placeholder="0 si todo está bien" />
            </label>
            <label>
              Comentario
              <input value={foundForm.comment} onChange={(e) => setFoundForm((current) => ({ ...current, comment: e.target.value }))} placeholder="Opcional" />
            </label>
          </div>
          <button className="primary-button" type="submit"><Plus size={16} /> Guardar código nuevo</button>
        </form>
      )}

      {message && <div className="info-box">{message}</div>}

      <div className="responsive-table">
        <table className="count-table">
          <thead>
            <tr>
              <th></th>
              <th>Código</th>
              <th>Descripción del Articulo</th>
              <th>Descripcion en Chino</th>
              <th>UM</th>
              <th>Solicitante</th>
              <th>Sistema total</th>
              <th>Físico</th>
              <th>Estado físico</th>
              <th>Cant. afectada</th>
              <th>Comentario</th>
              <th>Diferencia</th>
              <th>Estado</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const physical = item.count?.physical_qty;
              const diff = physical === null || physical === undefined || physical === '' ? '' : Number(physical) - Number(item.system_qty);
              const status = item.is_found ? 'encontrado' : getStatusFromDifference(physical, item.system_qty);
              const isOpen = Boolean(expanded[item.id]);
              return (
                <Fragment key={item.id}>
                  <tr className={selectedRowId === item.id ? 'selected-row' : ''} onClick={() => setSelectedRowId(item.id)}>
                    <td>
                      <button className="icon-button detail-toggle" onClick={(event) => { event.stopPropagation(); setExpanded((current) => ({ ...current, [item.id]: !current[item.id] })); }} title="Ver detalle de lotes">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                    <td><strong>{item.material_code}</strong></td>
                    <td>{item.material_name}</td>
                    <td>{item.material_name_cn || ''}</td>
                    <td>{item.unit}</td>
                    <td>{item.department || ''}</td>
                    <td>{formatNumber(item.system_qty)}</td>
                    <td>
                      <input
                        className="qty-input"
                        type="number"
                        step="0.001"
                        value={physical ?? ''}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelectedRowId(item.id)}
                        onChange={(e) => item.is_found ? updateFoundItem(item, { physical_qty: e.target.value }) : saveGroupChange(item, { physical_qty: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="compact-select"
                        value={item.count?.material_condition || 'buen_estado'}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelectedRowId(item.id)}
                        onChange={(e) => item.is_found ? updateFoundItem(item, { material_condition: e.target.value }) : saveGroupChange(item, { material_condition: e.target.value })}
                      >
                        {MATERIAL_CONDITIONS.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        className="small-number-input"
                        type="number"
                        step="0.001"
                        value={item.count?.condition_qty ?? ''}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelectedRowId(item.id)}
                        onChange={(e) => item.is_found ? updateFoundItem(item, { condition_qty: e.target.value }) : saveGroupChange(item, { condition_qty: e.target.value === '' ? 0 : Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        className="comment-input"
                        value={item.count?.comment || ''}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setSelectedRowId(item.id)}
                        onChange={(e) => item.is_found ? updateFoundItem(item, { comment: e.target.value }) : saveGroupChange(item, { comment: e.target.value })}
                        placeholder="Comentario"
                      />
                    </td>
                    <td>{diff === '' ? '' : formatNumber(diff)}</td>
                    <td><span className={`status-pill ${status}`}>{statusLabel(status)}</span></td>
                    <td>
                      {item.is_found ? (
                        <button className="danger-mini-button" type="button" onClick={(event) => { event.stopPropagation(); removeFoundItem(item); }}>
                          <Trash2 size={14} /> Borrar
                        </button>
                      ) : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail-row">
                      <td></td>
                      <td colSpan="13">
                        <div className="lot-detail">
                          <strong>Detalle por lote en esta ubicación</strong>
                          <div className="lot-chip-list">
                            {item.lots.map((lot) => (
                              <span key={`${item.id}-${lot.batch}`} className="lot-chip">
                                Lote: <strong>{lot.batch}</strong> · Sistema: <strong>{formatNumber(lot.system_qty)}</strong>
                              </span>
                            ))}
                          </div>
                          {item.is_found && (
                            <div className="found-edit-grid" onClick={(event) => event.stopPropagation()}>
                              <label>Código<input value={item.found_record?.material_code || ''} onChange={(e) => updateFoundItem(item, { material_code: e.target.value.trim() })} /></label>
                              <label>Descripción<input value={item.found_record?.material_name || ''} onChange={(e) => updateFoundItem(item, { material_name: e.target.value })} /></label>
                              <label>Descripción en chino<input value={item.found_record?.material_name_cn || ''} onChange={(e) => updateFoundItem(item, { material_name_cn: e.target.value })} /></label>
                              <label>UM<input value={item.found_record?.unit || ''} onChange={(e) => updateFoundItem(item, { unit: e.target.value })} /></label>
                              <label>Lote<input value={item.found_record?.batch || 'S/L'} onChange={(e) => updateFoundItem(item, { batch: e.target.value || 'S/L' })} /></label>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return <div className="stat-card"><span>{label}</span><strong>{formatNumber(value)}</strong></div>;
}
