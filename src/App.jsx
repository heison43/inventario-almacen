import { useEffect, useState } from 'react';
import Layout from './components/Layout.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import CountPage from './pages/CountPage.jsx';
import CounterDashboard from './pages/CounterDashboard.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ReconciliationPage from './pages/ReconciliationPage.jsx';
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

  useEffect(() => {
    async function init() {
      try {
        if (isSupabaseConfigured) {
          const profile = await getCurrentProfile();
          if (profile) {
            setUser(profile);
            setView(profile.role === 'admin' ? 'admin' : 'counter');
            await pullFromSupabase(profile);
          }
        } else {
          const stored = localStorage.getItem(USER_KEY);
          if (stored) {
            const parsed = JSON.parse(stored);
            setUser(parsed);
            setView(parsed.role === 'admin' ? 'admin' : 'counter');
          }
        }
      } catch (error) {
        setSyncMessage(error.message);
      } finally {
        setBooting(false);
      }
    }

    init();
  }, []);

  function handleLogin(data) {
    if (!isSupabaseConfigured) {
      localStorage.setItem(USER_KEY, JSON.stringify(data));
    }
    setUser(data);
    setView(data.role === 'admin' ? 'admin' : 'counter');
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
      {view === 'users' && <UsersPage />}
    </Layout>
  );
}
