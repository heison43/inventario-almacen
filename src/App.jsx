import { useEffect, useState } from 'react';
import Layout from './components/Layout.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import CountPage from './pages/CountPage.jsx';
import CounterDashboard from './pages/CounterDashboard.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ReconciliationPage from './pages/ReconciliationPage.jsx';
import QuickLookupPage from './pages/QuickLookupPage.jsx';
import ReferenceInventoryPage from './pages/ReferenceInventoryPage.jsx';
import DifferenceReviewPage from './pages/DifferenceReviewPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import { getCurrentProfile, signOut } from './lib/authService.js';
import { isSupabaseConfigured } from './lib/supabaseClient.js';
import { pullFromSupabase, syncPendingChanges } from './lib/remoteSync.js';

const USER_KEY = 'inventario-almacen-user';

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('admin');
  const [countTarget, setCountTarget] = useState(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [booting, setBooting] = useState(true);
  const [syncMessage, setSyncMessage] = useState('');

  // La validación de la sesión es lo único que bloquea la pantalla inicial.
  // La descarga de campañas puede tardar mucho; se ejecuta después de abrir.
  function refreshInBackground(profile, isCurrent = () => true) {
    if (!isSupabaseConfigured || !profile) return;

    // No esperamos aquí: la interfaz ya puede utilizar la copia en IndexedDB.
    Promise.resolve()
      .then(() => pullFromSupabase(profile))
      .then((result) => {
        if (!isCurrent()) return;
        if (!result.ok) setSyncMessage(`Aviso de sincronización: ${result.message}`);
        window.dispatchEvent(new CustomEvent('inventario-sync-completed', { detail: { ok: result.ok } }));
      })
      .catch((error) => {
        if (isCurrent()) setSyncMessage(`No se pudo actualizar Supabase: ${error.message}`);
      });
  }

  useEffect(() => {
    let active = true;

    async function init() {
      try {
        if (isSupabaseConfigured) {
          const profile = await getCurrentProfile();
          if (!active) return;
          if (profile) {
            setUser(profile);
            setView(profile.role === 'admin' ? 'admin' : 'counter');
            setBooting(false); // Abrir antes de descargar el inventario remoto.
            refreshInBackground(profile, () => active);
            return;
          }
        } else {
          const stored = localStorage.getItem(USER_KEY);
          if (stored && active) {
            const parsed = JSON.parse(stored);
            setUser(parsed);
            setView(parsed.role === 'admin' ? 'admin' : 'counter');
          }
        }
      } catch (error) {
        if (active) setSyncMessage(error.message);
      } finally {
        if (active) setBooting(false);
      }
    }

    init();
    return () => { active = false; };
  }, []);

  function handleLogin(data) {
    if (!isSupabaseConfigured) {
      localStorage.setItem(USER_KEY, JSON.stringify(data));
    }
    setUser(data);
    setView(data.role === 'admin' ? 'admin' : 'counter');
    // También actualizar tras iniciar sesión manualmente, sin bloquear la vista.
    if (isSupabaseConfigured) refreshInBackground(data);
  }

  async function handleLogout() {
    if (isSupabaseConfigured) await signOut();
    localStorage.removeItem(USER_KEY);
    setUser(null);
    setCountTarget(null);
  }

  async function handleSync() {
    setSyncMessage('Sincronizando...');
    const pushed = await syncPendingChanges(user);
    const pulled = pushed.ok ? await pullFromSupabase(user) : null;
    setSyncMessage(pushed.ok ? `${pushed.message} ${pulled?.message || ''}` : pushed.message);
    window.dispatchEvent(new CustomEvent('inventario-sync-completed', { detail: { ok: pushed.ok } }));
  }

  function openCount(campaignId, locationId) {
    setCountTarget({ campaignId, locationId });
    setView('count');
  }

  function openReconciliation(campaignId) {
    setSelectedCampaignId(campaignId);
    setView('reconciliation');
  }

  if (booting) return <div className="loading-screen">Cargando Inventario Almacén...</div>;
  if (!user) return <LoginPage onLogin={handleLogin} initialError={syncMessage} />;

  return (
    <Layout
      user={user}
      view={view}
      setView={(next) => { setView(next); setCountTarget(null); }}
      onLogout={handleLogout}
      onSync={handleSync}
      syncMessage={syncMessage}
      onlineMode={isSupabaseConfigured}
    >
      {view === 'admin' && <AdminDashboard user={user} onOpenReconciliation={openReconciliation} />}
      {view === 'counter' && <CounterDashboard user={user} onOpenCount={openCount} />}
      {view === 'count' && countTarget && (
        <CountPage
          user={user}
          campaignId={countTarget.campaignId}
          locationId={countTarget.locationId}
          onBack={() => setView('counter')}
        />
      )}
      {view === 'reconciliation' && <ReconciliationPage selectedCampaignId={selectedCampaignId} />}
      {view === 'quick-lookup' && <QuickLookupPage user={user} />}
      {view === 'reference-inventory' && <ReferenceInventoryPage user={user} />}
      {view === 'difference-review' && <DifferenceReviewPage user={user} />}
      {view === 'users' && <UsersPage />}
    </Layout>
  );
}
