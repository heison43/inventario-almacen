import { isSupabaseConfigured, supabase } from './supabaseClient.js';

async function claimProfileFromInvitation() {
  const { error } = await supabase.rpc('claim_profile_from_invitation');
  if (error) throw new Error(error.message);
}

async function loadProfileByCurrentSession(session) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role, active')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return profile;
}

export async function getCurrentProfile() {
  if (!isSupabaseConfigured) return null;

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  const session = sessionData?.session;
  if (!session?.user) return null;

  let profile = await loadProfileByCurrentSession(session);

  if (!profile) {
    // Si el admin preautorizó el correo en authorized_users, el usuario
    // puede reclamar su perfil al iniciar sesión o registrarse por primera vez.
    try {
      await claimProfileFromInvitation();
      profile = await loadProfileByCurrentSession(session);
    } catch (claimError) {
      await supabase.auth.signOut();
      throw new Error('Tu correo no está autorizado para Inventario Almacén. Solicita al administrador que lo agregue en Usuarios.');
    }
  }

  if (!profile) {
    await supabase.auth.signOut();
    throw new Error('No se pudo crear o cargar tu perfil autorizado.');
  }
  if (!profile.active) {
    await supabase.auth.signOut();
    throw new Error('Tu usuario está inactivo. Solicita activación al administrador.');
  }

  return {
    id: profile.id,
    name: profile.full_name,
    email: profile.email || session.user.email,
    role: profile.role,
    active: profile.active
  };
}

export async function signInWithEmail(email, password) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase no está configurado.');
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return getCurrentProfile();
}


export async function signUpWithEmail(email, password) {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase no está configurado.');
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);

  // Si Supabase exige confirmación de correo, no habrá sesión todavía.
  // El perfil se creará cuando el usuario confirme el correo e inicie sesión.
  if (!data?.session) {
    return {
      needsConfirmation: true,
      message: 'Cuenta creada. Revisa el correo para confirmar la cuenta y luego inicia sesión.'
    };
  }

  const profile = await getCurrentProfile();
  return { profile };
}

export async function signOut() {
  if (isSupabaseConfigured) {
    await supabase.auth.signOut();
  }
}
