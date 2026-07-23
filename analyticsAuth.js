/* =========================================================
   analyticsAuth.js — Auth de la analítica (ligero, sin supabase-js).
   Verifica el token de Supabase con fetch directo y lee rol + plataformas de
   public.profiles. Config por env: SUPABASE_URL, SUPABASE_ANON_KEY,
   SUPABASE_SERVICE_ROLE_KEY.
   ========================================================= */
'use strict';
const URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const configured = !!(URL && ANON && SERVICE);

const PLATAFORMAS = ['inbox', 'cotizaciones', 'cobranzas'];
function plataformasDe(role, platforms) {
  if (role === 'super_admin' || role === 'admin') return PLATAFORMAS.slice();
  return Array.isArray(platforms) ? platforms : PLATAFORMAS.slice();  // agente; null (pre-migración) = todas
}

const cache = new Map();            // token -> { info, exp }
const TTL = 60 * 1000;

// Devuelve { id, email, role, platforms } o null.
async function userForToken(token) {
  if (!token || !configured) return null;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.info;
  try {
    const ures = await fetch(URL + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + token } });
    if (!ures.ok) return null;
    const u = await ures.json();
    const id = u && u.id;
    if (!id) return null;
    const pres = await fetch(URL + '/rest/v1/profiles?id=eq.' + id + '&select=role,platforms',
      { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE } });
    const rows = pres.ok ? await pres.json() : [];
    const p = rows[0] || {};
    const info = { id, email: u.email || null, role: p.role || null, platforms: plataformasDe(p.role, p.platforms) };
    cache.set(token, { info, exp: Date.now() + TTL });
    return info;
  } catch (_) { return null; }
}

async function roleForToken(token) { const u = await userForToken(token); return u ? u.role : null; }

const tokenDe = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };

// No bloquea: adjunta req.role / req.platforms si hay token válido.
async function optionalAuth(req, _res, next) {
  const u = await userForToken(tokenDe(req));
  req.role = u ? u.role : null;
  req.platforms = u ? u.platforms : null;
  next();
}

// Bloquea si el usuario no tiene acceso a la plataforma. Si la auth no está
// configurada, no bloquea (modo abierto de desarrollo).
function requirePlatform(key) {
  return async (req, res, next) => {
    if (!configured) return next();
    const u = await userForToken(tokenDe(req));
    if (!u) return res.status(401).json({ error: 'No autenticado' });
    req.role = u.role; req.platforms = u.platforms; req.userId = u.id;
    if (!u.platforms.includes(key)) return res.status(403).json({ error: 'Sin acceso a esta plataforma', platform: key });
    next();
  };
}

module.exports = { configured, optionalAuth, requirePlatform, roleForToken, userForToken, plataformasDe, PLATAFORMAS, URL, ANON, SERVICE };
