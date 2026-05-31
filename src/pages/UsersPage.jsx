import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ensureDefaultUsers, listAppUsers, listAuthorizedUsers, saveAppUser } from '../lib/db.js';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient.js';
import { pullFromSupabase } from '../lib/remoteSync.js';

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [authorizedUsers, setAuthorizedUsers] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', role: 'contador' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    setLoading(true);
    if (isSupabaseConfigured) {
      const pulled = await pullFromSupabase();
      if (!pulled.ok) setMessage(`Aviso Supabase: ${pulled.message}`);
    } else {
      await ensureDefaultUsers();
    }
    setUsers(await listAppUsers('', { seedDefaults: !isSupabaseConfigured }));
    if (isSupabaseConfigured) {
      setAuthorizedUsers(await listAuthorizedUsers());
    }
    setLoading(false);
  }

  async function addUser(event) {
    event.preventDefault();
    if (!form.name.trim() || !form.email.trim()) return;

    try {
      if (isSupabaseConfigured) {
        const payload = {
          full_name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          role: form.role,
          active: true,
          updated_at: new Date().toISOString()
        };
        const { error } = await supabase
          .from('authorized_users')
          .upsert(payload, { onConflict: 'email' });
        if (error) throw new Error(error.message);
        setMessage('Correo autorizado. El usuario ya puede registrarse desde la pantalla de ingreso.');
      } else {
        await saveAppUser({ ...form, active: true });
        setMessage('Usuario local agregado para pruebas.');
      }

      setForm({ name: '', email: '', role: 'contador' });
      await refresh();
    } catch (error) {
      setMessage(`No se pudo guardar el usuario: ${error.message}`);
    }
  }

  return (
    <section className="panel-card wide-card">
      <div className="section-title">
        <div>
          <h2>Usuarios</h2>
          <p>{isSupabaseConfigured ? 'Usuarios autorizados desde Supabase Auth + profiles.' : 'Usuarios locales para pruebas.'}</p>
        </div>
        <button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={16} /> {loading ? 'Actualizando...' : 'Actualizar'}</button>
      </div>

      <form className="form-grid three-cols" onSubmit={addUser}>
          <label>
            Nombre
            <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} placeholder="Nombre del usuario" />
          </label>
          <label>
            Correo
            <input type="email" value={form.email} onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))} placeholder="usuario@empresa.com" />
          </label>
          <label>
            Tipo de usuario
            <select value={form.role} onChange={(e) => setForm((current) => ({ ...current, role: e.target.value }))}>
              <option value="contador">Contador</option>
              <option value="admin">Administrador</option>
            </select>
          </label>
          <button className="primary-button" type="submit"><Plus size={16} /> Autorizar usuario</button>
        </form>

      {isSupabaseConfigured && (
        <div className="info-box soft">
          Flujo recomendado: el administrador autoriza el correo y el tipo de usuario. Luego la persona entra a <strong>Registrarme</strong>, crea su contraseña y el sistema crea automáticamente su perfil.
        </div>
      )}

      {message && <div className="info-box">{message}</div>}

      {isSupabaseConfigured && (
        <>
          <h3>Correos autorizados</h3>
          <div className="responsive-table users-table">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Correo</th>
                  <th>Tipo</th>
                  <th>Registro</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {authorizedUsers.map((user) => (
                  <tr key={user.id}>
                    <td><strong>{user.full_name || user.name}</strong></td>
                    <td>{user.email}</td>
                    <td><span className={`status-pill ${user.role === 'admin' ? 'active' : 'encontrado'}`}>{user.role === 'admin' ? 'Administrador' : 'Contador'}</span></td>
                    <td>{user.claimed_by ? 'Registrado' : 'Pendiente'}</td>
                    <td>{user.active ? 'Activo' : 'Inactivo'}</td>
                  </tr>
                ))}
                {!authorizedUsers.length && <tr><td colSpan="5">No hay correos autorizados todavía.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Usuarios registrados</h3>
      <div className="responsive-table users-table">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Correo</th>
              <th>Tipo</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.name}</strong></td>
                <td>{user.email}</td>
                <td><span className={`status-pill ${user.role === 'admin' ? 'active' : 'encontrado'}`}>{user.role === 'admin' ? 'Administrador' : 'Contador'}</span></td>
                <td>{user.active ? 'Activo' : 'Inactivo'}</td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan="4">No hay usuarios registrados todavía.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
