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
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (agent_id, slug)
    )`);
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
const shapeModel = m => ({ id: String(m.id), name: m.name, slug: m.slug, percent: Number(m.percent) });

// Todos los agentes con sus modelos anidados.
async function listAll() {
  await ensure();
  const a = await q(`SELECT id, name, slug FROM pct_agents ORDER BY name ASC`);
  const m = await q(`SELECT id, agent_id, name, slug, percent FROM pct_models ORDER BY name ASC`);
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
  const m = await q(`SELECT id, name, slug, percent FROM pct_models WHERE agent_id=$1 ORDER BY name ASC`, [ag.id]);
  return { id: String(ag.id), name: ag.name, slug: ag.slug, models: m.rows.map(shapeModel) };
}

// Un modelo concreto dentro de un agente (o null).
async function getModel(agentName, modelName) {
  await ensure();
  const as = slugify(agentName), ms = slugify(modelName);
  if (!as || !ms) return null;
  const r = await q(
    `SELECT m.id, m.name, m.slug, m.percent, a.name AS agent, a.slug AS agent_slug
     FROM pct_models m JOIN pct_agents a ON a.id = m.agent_id
     WHERE a.slug=$1 AND m.slug=$2`, [as, ms]);
  if (!r.rows[0]) return null;
  const x = r.rows[0];
  return { agent: x.agent, agentSlug: x.agent_slug, model: x.name, slug: x.slug, percent: Number(x.percent) };
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
async function saveModel({ id, agentId, name, percent }) {
  await ensure();
  const nombre = String(name || '').trim();
  if (!nombre || slugify(nombre) === '') throw err('El nombre del modelo es obligatorio');
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw err('Porcentaje inválido');
  const slug = slugify(nombre), valor = Math.round(n * 100) / 100;
  try {
    if (id) {
      const r = await q(`UPDATE pct_models SET name=$2, slug=$3, percent=$4, updated_at=now() WHERE id=$1 RETURNING id,name,slug,percent`, [id, nombre, slug, valor]);
      if (!r.rows[0]) throw err('No existe ese modelo', 404);
      return shapeModel(r.rows[0]);
    }
    if (!agentId) throw err('Falta el agente');
    const r = await q(
      `INSERT INTO pct_models (agent_id, name, slug, percent) VALUES ($1,$2,$3,$4)
       ON CONFLICT (agent_id, slug) DO UPDATE SET name=EXCLUDED.name, percent=EXCLUDED.percent, updated_at=now()
       RETURNING id,name,slug,percent`, [agentId, nombre, slug, valor]);
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

module.exports = { listAll, getAgent, getModel, saveAgent, removeAgent, saveModel, removeModel, slugify };
