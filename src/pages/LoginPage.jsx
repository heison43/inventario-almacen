import { useState } from 'react';
import { signInWithEmail, signUpWithEmail } from '../lib/authService.js';
import { isSupabaseConfigured } from '../lib/supabaseClient.js';

export default function LoginPage({ onLogin, initialError = '' }) {
  const [name, setName] = useState('Heison Yepes');
  const [email, setEmail] = useState(isSupabaseConfigured ? '' : 'heison@empresa.com');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(initialError);
  const [mode, setMode] = useState('login');

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      if (isSupabaseConfigured) {
        if (mode === 'register') {
          const result = await signUpWithEmail(email, password);
          if (result?.profile) {
            onLogin(result.profile);
          } else {
            setMessage(result?.message || 'Cuenta creada. Ahora inicia sesión.');
          }
          return;
        }
        const profile = await signInWithEmail(email, password);
        onLogin(profile);
      } else {
        onLogin({ name, email, role });
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="login-page">
      <div className="login-card">
        <div className="login-logo"><img src="/app-icon.png" alt="Inventario Almacén" /></div>
        <h1>Inventario Almacén</h1>
        <p>{isSupabaseConfigured ? 'Acceso seguro al sistema de conteo físico de inventario.' : 'Modo local para desarrollo y pruebas.'}</p>

        {isSupabaseConfigured && (
          <div className="mode-switch">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Ingresar</button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Registrarme</button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="form-grid">
          {!isSupabaseConfigured && (
            <label>
              Nombre
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          <label>
            Correo
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {isSupabaseConfigured ? (
            <label>
              Contraseña
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          ) : (
            <label>
              Tipo de usuario
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="admin">Administrador</option>
                <option value="contador">Contador</option>
              </select>
            </label>
          )}
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? 'Procesando...' : (mode === 'register' && isSupabaseConfigured ? 'Crear cuenta' : 'Ingresar')}
          </button>
        </form>

        {message && <div className="info-box warning-box">{message}</div>}
        <div className="info-box">
          {isSupabaseConfigured
            ? 'Para registrarse, el administrador debe haber autorizado previamente el correo desde la pantalla Usuarios.'
            : 'Para producción, configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env.local.'}
        </div>
      </div>
    </section>
  );
}
