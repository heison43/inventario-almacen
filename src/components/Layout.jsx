import { BarChart3, ClipboardCheck, ClipboardList, LogOut, Menu, RefreshCw, Search, ShieldCheck, UploadCloud, Users } from 'lucide-react';
import { useState } from 'react';

export default function Layout({ user, view, setView, onLogout, onSync, syncMessage, onlineMode, children }) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const nav = user.role === 'admin'
    ? [
        { id: 'admin', label: 'Campañas', icon: UploadCloud },
        { id: 'reconciliation', label: 'Conciliación', icon: BarChart3 },
        { id: 'quick-lookup', label: 'Consulta rápida', icon: Search },
        { id: 'difference-review', label: 'Revisión diferencias', icon: ClipboardCheck },
        { id: 'counter', label: 'Conteo', icon: ClipboardList },
        { id: 'users', label: 'Usuarios', icon: Users }
      ]
    : [
        { id: 'counter', label: 'Conteo', icon: ClipboardList },
        { id: 'quick-lookup', label: 'Consulta rápida', icon: Search }
      ];

  async function handleSync() {
    if (!onSync) return;
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? 'show' : ''}`}>
        <div className="brand">
          <div className="brand-icon"><img src="/app-icon.png" alt="Inventario Almacén" /></div>
          <div>
            <strong>Inventario Almacén</strong>
            <span>Sistema de conteo físico de inventario</span>
          </div>
        </div>

        <nav className="nav-list">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => {
                  setView(item.id);
                  setOpen(false);
                }}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-card">
            <ShieldCheck size={18} />
            <div>
              <strong>{user.name}</strong>
              <span>{user.role === 'admin' ? 'Administrador' : 'Contador'}</span>
            </div>
          </div>
          <button className="ghost-button" onClick={onLogout}>
            <LogOut size={16} /> Salir
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setOpen(true)}>
            <Menu size={22} />
          </button>
          <div>
            <h1>{titleByView(view)}</h1>
            <p>Conteo por zona, ubicación, código y lote.</p>
          </div>
          <div className="topbar-actions">
            <button className="secondary-button" onClick={handleSync} disabled={syncing || !onlineMode} title={onlineMode ? 'Sincronizar con Supabase' : 'Configura Supabase para sincronizar'}>
              <RefreshCw size={16} /> {syncing ? 'Sincronizando...' : 'Sincronizar'}
            </button>
            <span className={`connection-pill ${onlineMode ? 'online' : ''}`}>
              {onlineMode ? 'Sistema conectado / modo offline disponible' : 'Modo local / offline listo'}
            </span>
          </div>
        </header>
        {syncMessage && <div className="sync-message">{syncMessage}</div>}
        {children}
      </main>
    </div>
  );
}

function titleByView(view) {
  const titles = {
    admin: 'Panel administrativo',
    counter: 'Conteo físico',
    reconciliation: 'Conciliación',
    'quick-lookup': 'Consulta rápida',
    'difference-review': 'Revisión de diferencias',
    users: 'Usuarios'
  };
  return titles[view] || 'Inventario Almacén';
}
