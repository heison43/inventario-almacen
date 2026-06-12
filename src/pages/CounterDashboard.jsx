import { ChevronDown, ChevronRight, ClipboardList, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createDiscoveredLocation, listAppUsers, listCampaigns, listLocations, listLocationSyncStates } from '../lib/db.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';
import { pullFromSupabase } from '../lib/remoteSync.js';
import { statusLabel } from '../lib/utils.js';

const GROUPS = Array.from({ length: 20 }, (_, index) => `grupo${index + 1}`);
const FILTER_STORAGE_KEY = 'inventario-almacen-counter-filters';

function groupClass(group) {
  const match = String(group || '').match(/grupo(\d+)/i);
  return match ? `group-${match[1]}` : 'group-none';
}

export default function CounterDashboard({ user, onOpenCount }) {
  const [campaigns, setCampaigns] = useState([]);
  const [counters, setCounters] = useState([]);
  const savedFilters = (() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  })();
  const [showOnlyAssigned, setShowOnlyAssigned] = useState(savedFilters.showOnlyAssigned ?? true);
  const [selectedGroup, setSelectedGroup] = useState(savedFilters.selectedGroup || 'todos');
  const [selectedUser, setSelectedUser] = useState(savedFilters.selectedUser || 'todos');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [collapsedCampaigns, setCollapsedCampaigns] = useState({});
  const [manualFormCampaignId, setManualFormCampaignId] = useState('');
  const [manualLocationValue, setManualLocationValue] = useState('');
  const [manualGroupValue, setManualGroupValue] = useState(savedFilters.selectedGroup && savedFilters.selectedGroup !== 'todos' ? savedFilters.selectedGroup : '');

  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ showOnlyAssigned, selectedGroup, selectedUser }));
    // Operación rápida: al volver desde una ubicación o cambiar filtros, primero
    // se pinta la información que ya está en IndexedDB. No se consulta Supabase
    // automáticamente porque con campañas grandes eso hace lento el botón Volver.
    refresh({ remote: false });
  }, [showOnlyAssigned, selectedGroup, selectedUser]);

  useEffect(() => {
    const handleSyncCompleted = () => refresh({ remote: false });
    window.addEventListener('inventario-sync-completed', handleSyncCompleted);
    return () => window.removeEventListener('inventario-sync-completed', handleSyncCompleted);
  }, [showOnlyAssigned, selectedGroup, selectedUser]);

  async function refresh({ remote = false } = {}) {
    setLoading(true);
    let remoteMessage = '';

    if (remote && isSupabaseConfigured) {
      const pulled = await pullFromSupabase(user);
      if (!pulled.ok) remoteMessage = `Aviso Supabase: ${pulled.message}`;
      else remoteMessage = pulled.message || '';
    }

    const [rows, counterRows] = await Promise.all([
      listCampaigns(),
      isAdmin ? listAppUsers('contador', { seedDefaults: !isSupabaseConfigured }) : Promise.resolve([])
    ]);

    setCounters(counterRows);

    const hydrated = await Promise.all(rows.map(async (campaign) => {
      const locations = await listLocations(campaign.id);
      const visibleLocations = locations.filter((location) => {
        const groupOk = selectedGroup === 'todos' || (location.assigned_group || '') === selectedGroup;
        if (!groupOk) return false;

        if (isAdmin) {
          return selectedUser === 'todos' || (location.assigned_to || '') === selectedUser;
        }

        const assignedOk = !showOnlyAssigned || !location.assigned_to || location.assigned_to === user.email;
        return assignedOk;
      });

      const syncStates = await listLocationSyncStates(visibleLocations.map((location) => location.id));
      return {
        ...campaign,
        locations: visibleLocations.map((location) => ({
          ...location,
          syncState: syncStates[location.id] || { pending: 0, synced: true, details: {} }
        }))
      };
    }));

    setCampaigns(hydrated.filter((campaign) => campaign.locations.length > 0));
    if (remoteMessage) setMessage(remoteMessage);
    setLoading(false);
  }

  function toggleCampaign(campaignId) {
    setCollapsedCampaigns((current) => ({ ...current, [campaignId]: !current[campaignId] }));
  }


  async function addDiscoveredLocation(campaign) {
    const selectedManualGroup = manualGroupValue || (selectedGroup !== 'todos' ? selectedGroup : '');
    const assignedEmail = isAdmin && selectedUser !== 'todos' ? selectedUser : (user?.email || '');
    const result = await createDiscoveredLocation({
      campaign,
      location: manualLocationValue,
      assignedGroup: selectedManualGroup,
      userEmail: assignedEmail
    });

    setMessage(result.message || (result.ok ? 'Ubicación encontrada agregada.' : 'No se pudo agregar la ubicación.'));
    if (!result.ok) return;

    setManualLocationValue('');
    setManualFormCampaignId('');
    if (selectedManualGroup && selectedManualGroup !== selectedGroup) {
      setSelectedGroup(selectedManualGroup);
      return;
    }
    await refresh({ remote: false });
  }

  const groupOptions = useMemo(() => GROUPS, []);

  return (
    <section className="panel-card wide-card">
      <div className="section-title">
        <div>
          <h2>Ubicaciones disponibles para conteo</h2>
          <p>Selecciona la ubicación asignada. La información queda disponible en el navegador para trabajar offline.</p>
        </div>
        <div className="button-row counter-filter-row">
          {isAdmin ? (
            <label className="compact-select-label">
              Usuario
              <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                <option value="todos">Todos</option>
                {counters.map((counter) => (
                  <option key={counter.id} value={counter.email}>{counter.name} · {counter.email}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="inline-check compact-check">
              <input type="checkbox" checked={showOnlyAssigned} onChange={(e) => setShowOnlyAssigned(e.target.checked)} />
              Solo mis asignadas
            </label>
          )}

          <label className="compact-select-label">
            Grupo
            <select value={selectedGroup} onChange={(e) => setSelectedGroup(e.target.value)}>
              <option value="todos">Todos</option>
              {groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </label>

          {selectedGroup !== 'todos' && (
            <button className="ghost-light-button" type="button" onClick={() => setSelectedGroup('todos')}>Ver todos los grupos</button>
          )}
          <button className="secondary-button" onClick={() => refresh({ remote: true })} disabled={loading}><RefreshCw size={16} /> {loading ? 'Actualizando...' : 'Actualizar'}</button>
        </div>
      </div>

      {message && <div className="info-box">{message}</div>}

      <div className="location-list">
        {campaigns.map((campaign) => {
          const collapsed = Boolean(collapsedCampaigns[campaign.id]);
          return (
            <div key={campaign.id} className="campaign-location-block collapsible-zone">
              <button className="zone-toggle" type="button" onClick={() => toggleCampaign(campaign.id)}>
                <span>{collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}</span>
                <span>
                  <h3>{campaign.name}</h3>
                  <p>{campaign.warehouse} · Zona {campaign.zone} · {campaign.locations.length} ubicaciones visibles</p>
                </span>
              </button>
              {!collapsed && (
                <>
                  <div className="button-row manual-location-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        setManualFormCampaignId((current) => current === campaign.id ? '' : campaign.id);
                        setManualGroupValue(selectedGroup !== 'todos' ? selectedGroup : (manualGroupValue || ''));
                      }}
                    >
                      <Plus size={16} /> Agregar ubicación encontrada
                    </button>
                  </div>

                  {manualFormCampaignId === campaign.id && (
                    <div className="manual-location-panel">
                      <div>
                        <strong>Crear ubicación vacía en esta campaña</strong>
                        <p>Úsala cuando la ubicación no venía en la data porque el sistema estaba en cero, pero físicamente sí tiene material.</p>
                      </div>
                      <label>
                        Ubicación real encontrada
                        <input
                          value={manualLocationValue}
                          onChange={(e) => setManualLocationValue(e.target.value.toUpperCase())}
                          placeholder={`Ejemplo: ${campaign.zone}020610`}
                        />
                      </label>
                      <label>
                        Grupo
                        <select value={manualGroupValue} onChange={(e) => setManualGroupValue(e.target.value)}>
                          <option value="">Sin grupo</option>
                          {groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}
                        </select>
                      </label>
                      <div className="button-row">
                        <button className="primary-button" type="button" onClick={() => addDiscoveredLocation(campaign)}><Plus size={16} /> Crear ubicación</button>
                        <button className="secondary-button" type="button" onClick={() => setManualFormCampaignId('')}><X size={16} /> Cancelar</button>
                      </div>
                    </div>
                  )}

                  <div className="location-grid">
                  {campaign.locations.map((location) => (
                    <button
                      key={location.id}
                      className={`location-card ${groupClass(location.assigned_group)} status-${location.status} ${location.syncState?.synced ? 'sync-synced' : 'sync-pending'}`}
                      onClick={() => onOpenCount(campaign.id, location.id)}
                      title={location.syncState?.synced ? 'Ubicación sincronizada' : `Pendiente por sincronizar: ${location.syncState?.pending || 1} cambio(s)`}
                    >
                      <ClipboardList size={20} />
                      <strong>{location.location}</strong>
                      <span className={`status-pill ${location.status}`}>{statusLabel(location.status)}</span>
                      <small>{location.assigned_group || 'Sin grupo'}</small>
                      <span className={`sync-pill ${location.syncState?.synced ? 'synced' : 'pending'}`}>
                        {location.syncState?.synced ? 'Sincronizada' : 'Sin sincronizar'}
                      </span>
                    </button>
                  ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {!campaigns.length && <div className="empty-state">No hay ubicaciones para mostrar con los filtros seleccionados.</div>}
      </div>
    </section>
  );
}
