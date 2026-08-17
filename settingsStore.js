/* =========================================================
   settingsStore.js — Agentes y, dentro de cada uno, sus MODELOS con
   porcentaje. Dos niveles: agente → modelos. Configurable por el super_admin
   en Ajustes y consultable por GET (por agente, por modelo, o todo).
   Tablas: pct_agents, pct_models (en la misma base del panel).
   ========================================================= */
'use strict';
const { q } = require('./db');

let ready = null;
function ensure() {
  if (ready) return ready;
  ready = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS pct_agents (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS pct_models (
      id BIGSERIAL PRIMARY KEY,
      agent_id BIGINT REFERENCES pct_agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT,
      percent NUMERIC NOT NULL DEFAULT 0,
      coste NUMERIC NOT NULL DEFAULT 0.03,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (agent_id, slug)
    )`);
    // 'coste' = tarifa de cobro por mensaje de ese modelo (antes fijo en 0.03).
    await q(`ALTER TABLE pct_models ADD COLUMN IF NOT EXISTS coste NUMERIC NOT NULL DEFAULT 0.03`);
    // Precio del modelo por 1.000.000 de tokens (USD): entrada (prompt) y salida
    // (completion). Los define el super_admin; n8n los consulta para calcular el coste.
    await q(`ALTER TABLE pct_models ADD COLUMN IF NOT EXISTS price_in NUMERIC NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE pct_models ADD COLUMN IF NOT EXISTS price_out NUMERIC NOT NULL DEFAULT 0`);
    // Horarios especiales (UTC): franjas con otro precio por 1M tokens (ej. Deepseek
    // off-peak). Array de { start:"HH:MM", end:"HH:MM", priceIn, priceOut } en UTC.
    // Fuera de las franjas aplica price_in/price_out (base).
    await q(`ALTER TABLE pct_models ADD COLUMN IF NOT EXISTS price_windows JSONB NOT NULL DEFAULT '[]'::jsonb`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// Nombre → slug estable para consultar por URL (sin acentos, minúsculas, guiones).
function slugify(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const err = (msg, status) => { const e = new Error(msg); e.status = status || 400; return e; };
const shapeModel = m => ({
  id: String(m.id), name: m.name, slug: m.slug,
  percent: Number(m.percent), coste: Number(m.coste),
  priceIn: Number(m.price_in || 0), priceOut: Number(m.price_out || 0),   // USD por 1M tokens (base)
  priceWindows: normWindows(m.price_windows) || []                        // franjas horarias UTC
});

// --- Horarios especiales (UTC) ---
// hora "HH:MM" válida → normalizada; si no, null.
function hhmm(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
// Valida/normaliza el array de franjas. Acepta array (o su JSON en texto). Lanza
// si algo es inválido. Devuelve [] para vacío.
function normWindows(v) {
  if (v == null) return [];
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { throw err('Horarios inválidos'); } }
  if (!Array.isArray(arr)) throw err('Horarios inválidos');
  const out = [];
  for (const w of arr) {
    if (!w) continue;
    const start = hhmm(w.start), end = hhmm(w.end);
    if (start == null || end == null) throw err('Hora inválida en un horario (usa HH:MM en UTC)');
    const pin = Number(w.priceIn), pout = Number(w.priceOut);
    if (!Number.isFinite(pin) || pin < 0 || !Number.isFinite(pout) || pout < 0) throw err('Precio inválido en un horario');
    out.push({ start, end, priceIn: Math.round(pin * 1e6) / 1e6, priceOut: Math.round(pout * 1e6) / 1e6 });
  }
  return out;
}
const minOf = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const inWindow = (mins, w) => {
  const s = minOf(w.start), e = minOf(w.end);
  if (s === e) return false;
  return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);   // cruza medianoche
};
// Precio efectivo de un modelo en una fecha (UTC): la primera franja que aplique,
// o el precio base. Devuelve { priceIn, priceOut, peak:bool, window }.
function effectivePrice(model, date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of (model.priceWindows || [])) {
    if (inWindow(mins, w)) return { priceIn: w.priceIn, priceOut: w.priceOut, peak: false, window: w };
  }
  return { priceIn: model.priceIn, priceOut: model.priceOut, peak: true, window: null };
}

// Todos los agentes con sus modelos anidados.
async function listAll() {
  await ensure();
  const a = await q(`SELECT id, name, slug FROM pct_agents ORDER BY name ASC`);
  const m = await q(`SELECT id, agent_id, name, slug, percent, coste, price_in, price_out, price_windows FROM pct_models ORDER BY name ASC`);
  const porAgente = new Map();
  m.rows.forEach(r => { const k = String(r.agent_id); if (!porAgente.has(k)) porAgente.set(k, []); porAgente.get(k).push(shapeModel(r)); });
  return a.rows.map(ag => ({ id: String(ag.id), name: ag.name, slug: ag.slug, models: porAgente.get(String(ag.id)) || [] }));
}

// Un agente por nombre/slug, con sus modelos (o null).
async function getAgent(name) {
  await ensure();
  const s = slugify(name);
  if (!s) return null;
  const a = await q(`SELECT id, name, slug FROM pct_agents WHERE slug=$1`, [s]);
  if (!a.rows[0]) return null;
  const ag = a.rows[0];
  const m = await q(`SELECT id, name, slug, percent, coste, price_in, price_out, price_windows FROM pct_models WHERE agent_id=$1 ORDER BY name ASC`, [ag.id]);
  return { id: String(ag.id), name: ag.name, slug: ag.slug, models: m.rows.map(shapeModel) };
}

// Un modelo concreto dentro de un agente (o null).
async function getModel(agentName, modelName) {
  await ensure();
  const as = slugify(agentName), ms = slugify(modelName);
  if (!as || !ms) return null;
  const r = await q(
    `SELECT m.id, m.name, m.slug, m.percent, m.coste, m.price_in, m.price_out, m.price_windows, a.name AS agent, a.slug AS agent_slug
     FROM pct_models m JOIN pct_agents a ON a.id = m.agent_id
     WHERE a.slug=$1 AND m.slug=$2`, [as, ms]);
  if (!r.rows[0]) return null;
  const x = r.rows[0];
  return {
    agent: x.agent, agentSlug: x.agent_slug, model: x.name, slug: x.slug,
    percent: Number(x.percent), coste: Number(x.coste),
    priceIn: Number(x.price_in || 0), priceOut: Number(x.price_out || 0),   // USD por 1M tokens (base)
    priceWindows: normWindows(x.price_windows) || []                        // franjas horarias UTC
  };
}

// Mapa de configuración por (slug agente | slug modelo) y por slug de modelo
// (más laxo). Devuelve { percent, coste } de cada modelo. Lo usa el panel de
// Mensajes para calcular el cobrado = coste_ia × (1 + percent/100).
async function modelMap() {
  const ags = await listAll();
  const byPair = {}, byModel = {};
  ags.forEach(a => a.models.forEach(m => {
    const v = { percent: m.percent, coste: m.coste, priceIn: m.priceIn, priceOut: m.priceOut, priceWindows: m.priceWindows };
    byPair[a.slug + '|' + m.slug] = v;
    byModel[m.slug] = v;
  }));
  return { byPair, byModel };
}

// ---- Agentes ----
async function saveAgent({ id, name }) {
  await ensure();
  const nombre = String(name || '').trim();
  if (!nombre || slugify(nombre) === '') throw err('El nombre del agente es obligatorio');
  const slug = slugify(nombre);
  try {
    if (id) {
      const r = await q(`UPDATE pct_agents SET name=$2, slug=$3, updated_at=now() WHERE id=$1 RETURNING id,name,slug`, [id, nombre, slug]);
      if (!r.rows[0]) throw err('No existe ese agente', 404);
      return { id: String(r.rows[0].id), name: r.rows[0].name, slug: r.rows[0].slug };
    }
    const r = await q(`INSERT INTO pct_agents (name, slug) VALUES ($1,$2) RETURNING id,name,slug`, [nombre, slug]);
    return { id: String(r.rows[0].id), name: r.rows[0].name, slug: r.rows[0].slug };
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw err('Ya existe un agente con ese nombre', 409);
    throw e;
  }
}
async function removeAgent(id) {
  await ensure();
  const r = await q(`DELETE FROM pct_agents WHERE id=$1 RETURNING id`, [id]);
  return !!r.rows[0];
}

// ---- Modelos (dentro de un agente) ----
// coste / priceIn / priceOut son opcionales: si no vienen, se mantiene el valor
// que tenga (update) o se usa el default de la columna (insert).
const RET = 'id,name,slug,percent,coste,price_in,price_out,price_windows';
async function saveModel({ id, agentId, name, percent, coste, priceIn, priceOut, priceWindows }) {
  await ensure();
  const nombre = String(name || '').trim();
  if (!nombre || slugify(nombre) === '') throw err('El nombre del modelo es obligatorio');
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw err('Porcentaje inválido');
  const slug = slugify(nombre), valor = Math.round(n * 100) / 100;

  // null = no tocar (update) / usar default (insert). Hasta 6 decimales.
  const num = (v, label) => {
    if (v == null || v === '') return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw err(label + ' inválido');
    return Math.round(x * 1e6) / 1e6;
  };
  // Columnas opcionales: [columna, valor, castJsonb?]. null = no tocar.
  const extras = [
    ['coste', num(coste, 'Coste'), false],
    ['price_in', num(priceIn, 'Precio de entrada'), false],
    ['price_out', num(priceOut, 'Precio de salida'), false],
    ['price_windows', priceWindows == null ? null : JSON.stringify(normWindows(priceWindows)), true]
  ].filter(([, v]) => v != null);

  try {
    if (id) {
      const sets = ['name=$2', 'slug=$3', 'percent=$4', 'updated_at=now()'];
      const params = [id, nombre, slug, valor];
      for (const [c, v, json] of extras) { params.push(v); sets.push(`${c}=$${params.length}${json ? '::jsonb' : ''}`); }
      const r = await q(`UPDATE pct_models SET ${sets.join(', ')} WHERE id=$1 RETURNING ${RET}`, params);
      if (!r.rows[0]) throw err('No existe ese modelo', 404);
      return shapeModel(r.rows[0]);
    }
    if (!agentId) throw err('Falta el agente');
    // Insert: columnas base + las opcionales provistas (las demás toman su default).
    const cols = ['agent_id', 'name', 'slug', 'percent'];
    const params = [agentId, nombre, slug, valor];
    for (const [c, v] of extras) { cols.push(c); params.push(v); }
    const ph = cols.map((c, i) => '$' + (i + 1) + (c === 'price_windows' ? '::jsonb' : '')).join(',');
    const upd = ['name=EXCLUDED.name', 'percent=EXCLUDED.percent', 'updated_at=now()']
      .concat(extras.map(([c]) => `${c}=EXCLUDED.${c}`)).join(', ');
    const r = await q(
      `INSERT INTO pct_models (${cols.join(',')}) VALUES (${ph})
       ON CONFLICT (agent_id, slug) DO UPDATE SET ${upd}
       RETURNING ${RET}`, params);
    return shapeModel(r.rows[0]);
  } catch (e) {
    if (e.status) throw e;
    if (/foreign key/i.test(e.message)) throw err('El agente no existe', 404);
    throw e;
  }
}
async function removeModel(id) {
  await ensure();
  const r = await q(`DELETE FROM pct_models WHERE id=$1 RETURNING id`, [id]);
  return !!r.rows[0];
}

module.exports = { listAll, getAgent, getModel, modelMap, saveAgent, removeAgent, saveModel, removeModel, slugify, effectivePrice };
