/* =========================================================
   authUsers.js — Gestión de usuarios para la analítica (sin supabase-js).
   Usa la Admin API de Supabase (GoTrue) + REST de profiles vía fetch.
   Solo admin / super_admin. El rol super_admin NO se asigna por el panel.
   Se monta en /api/auth.
   ========================================================= */
'use strict';
const express = require('express');
const { URL, SERVICE, configured, roleForToken, userForToken, plataformasDe, PLATAFORMAS } = require('./analyticsAuth');
const { limpiar: limpiarPermisos, permisosDe } = require('./permcatalog');
const router = express.Router();
const ROLES = ['admin', 'agent'];
function limpiarPlataformas(v){ if(!Array.isArray(v)) return null; return [...new Set(v.map(String))].filter(x=>PLATAFORMAS.includes(x)); }
// De una lista de permisos, las plataformas implicadas (para mantener sinc).
const platsDePermisos = perms => [...new Set(perms.map(k => k.split('.')[0]))];

const svc = (extra) => Object.assign({ apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' }, extra || {});

// Escribe en profiles tolerando esquemas viejos: si PostgREST aún no conoce la
// columna 'permissions' (o 'platforms'), reintenta sin ella para no romper el
// resto del cambio (rol, contraseña…). Devuelve un texto de error o null.
async function escribirPerfil(method, id, obj) {
  const url = method === 'POST' ? URL + '/rest/v1/profiles' : URL + '/rest/v1/profiles?id=eq.' + id;
  const prefer = method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal';
  const intentar = async payload => {
    const r = await fetch(url, { method, headers: svc({ Prefer: prefer }), body: JSON.stringify(payload) });
    if (r.ok) return null;
    return (await r.text().catch(() => '')) || ('HTTP ' + r.status);
  };
  let err = await intentar(obj);
  for (const col of ['permissions', 'platforms', 'created_via', 'hidden']) {
    if (err && (col in obj) && err.includes(`'${col}'`)) { delete obj[col]; err = await intentar(obj); }
  }
  return err;
}
async function tokenRole(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return roleForToken(t);
}
async function requireAdmin(req, res, next) {
  if (!configured) return res.status(503).json({ error: 'Auth no configurado' });
  const role = await tokenRole(req);
  if (!['admin', 'super_admin'].includes(role)) return res.status(403).json({ error: 'Solo administradores' });
  req.role = role;
  next();
}

// Rol del usuario actual (para que el frontend muestre/oculte la sección).
router.get('/me', async (req, res) => {
  const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):'';
  const u=await userForToken(t);
  res.json({ role: u?u.role:null, platforms: u?u.platforms:null, permissions: u?u.permissions:null });
});

// Lee profiles con todas sus columnas (tolera esquemas sin 'hidden'/'created_via').
async function fetchProfiles() {
  const r = await fetch(URL + '/rest/v1/profiles?select=*', { headers: svc() });
  return r.ok ? await r.json() : [];
}

// Lista de usuarios. SOLO los creados desde este panel (los que tienen fila en
// profiles). Los marcados como ocultos no aparecen, salvo que un super_admin pida
// verlos con ?includeHidden=1.
router.get('/users', requireAdmin, async (req, res) => {
  const verOcultos = req.role === 'super_admin' && ['1', 'true'].includes(String(req.query.includeHidden || ''));
  const ures = await fetch(URL + '/auth/v1/admin/users?page=1&per_page=500', { headers: svc() });
  if (!ures.ok) return res.status(500).json({ error: 'listUsers ' + ures.status });
  const uj = await ures.json();
  const profs = await fetchProfiles();
  const pmap = {}; profs.forEach(p => { pmap[p.id] = p; });
  const users = (uj.users || [])
    .filter(u => pmap[u.id])                       // solo usuarios creados desde el panel (tienen perfil)
    .map(u => {
      const p = pmap[u.id];
      return { id: u.id, email: u.email, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at, role: p.role || 'agent', fullName: p.full_name || null, platforms: plataformasDe(p.role, p.platforms), permissions: permisosDe(p), hidden: !!p.hidden, fromPanel: p.created_via === 'panel' };
    })
    .filter(u => verOcultos || !u.hidden);         // ocultar los marcados salvo que super_admin los pida
  res.json({ users, canHide: req.role === 'super_admin', includeHidden: verOcultos });
});

router.post('/users', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || password.length < 6) return res.status(400).json({ error: 'Email y contraseña (mínimo 6) requeridos' });
  const role = ROLES.includes(b.role) ? b.role : 'agent';   // super_admin no asignable por panel
  const cres = await fetch(URL + '/auth/v1/admin/users', { method: 'POST', headers: svc(), body: JSON.stringify({ email, password, email_confirm: true }) });
  const cj = await cres.json().catch(() => ({}));
  if (!cres.ok) return res.status(400).json({ error: cj.msg || cj.error_description || ('createUser ' + cres.status) });
  const perfil = { id: cj.id, email, role, full_name: b.fullName || null, created_via: 'panel' };
  const perms = limpiarPermisos(b.permissions);
  if (perms) { perfil.permissions = perms; perfil.platforms = platsDePermisos(perms); }
  else { const pl = limpiarPlataformas(b.platforms); if (pl) perfil.platforms = pl; }
  const perr = await escribirPerfil('POST', null, perfil);
  if (perr) return res.status(500).json({ error: 'usuario creado pero falló el perfil: ' + perr });
  res.status(201).json({ ok: true, id: cj.id });
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.role && ROLES.includes(b.role)) patch.role = b.role;
  if ('fullName' in b) patch.full_name = b.fullName || null;
  if ('permissions' in b) { const p=limpiarPermisos(b.permissions); if(p){ patch.permissions=p; patch.platforms=platsDePermisos(p); } }
  else if ('platforms' in b) { const p=limpiarPlataformas(b.platforms); if(p) patch.platforms=p; }
  const authUpd = {};
  if (b.password) authUpd.password = String(b.password);
  if (b.email) { authUpd.email = String(b.email).trim().toLowerCase(); patch.email = authUpd.email; }
  if (Object.keys(authUpd).length) {
    const r = await fetch(URL + '/auth/v1/admin/users/' + req.params.id, { method: 'PUT', headers: svc(), body: JSON.stringify(authUpd) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(400).json({ error: e.msg || e.error_description || ('update ' + r.status) }); }
  }
  if (Object.keys(patch).length) {
    const perr = await escribirPerfil('PATCH', req.params.id, patch);
    if (perr) return res.status(400).json({ error: perr });
  }
  res.json({ ok: true });
});

// Ocultar / mostrar un usuario del listado. SOLO super_admin. No borra nada: marca
// profiles.hidden. Requiere la columna profiles.hidden (ver migración en el README).
async function requireSuper(req, res, next) {
  if (!configured) return res.status(503).json({ error: 'Auth no configurado' });
  const role = await tokenRole(req);
  if (role !== 'super_admin') return res.status(403).json({ error: 'Solo el super admin puede ocultar usuarios' });
  req.role = role;
  next();
}
router.patch('/users/:id/hidden', requireSuper, async (req, res) => {
  const hidden = !!(req.body && req.body.hidden);
  const perr = await escribirPerfil('PATCH', req.params.id, { hidden });
  if (perr) return res.status(400).json({ error: 'No se pudo actualizar (¿falta la columna profiles.hidden?): ' + perr });
  res.json({ ok: true, hidden });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  await fetch(URL + '/auth/v1/admin/users/' + req.params.id, { method: 'DELETE', headers: svc() });
  await fetch(URL + '/rest/v1/profiles?id=eq.' + req.params.id, { method: 'DELETE', headers: svc({ Prefer: 'return=minimal' }) });
  res.json({ ok: true });
});

module.exports = router;
