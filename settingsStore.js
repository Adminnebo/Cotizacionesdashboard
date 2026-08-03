/* =========================================================
   settingsStore.js — Porcentajes CON NOMBRE, configurables por el super_admin
   en Ajustes y consultables por GET (por nombre o todos).
   Tabla propia `percentages` (en la misma base del panel).
   ========================================================= */
'use strict';
const { q } = require('./db');

let ready = null;
function ensure() {
  if (ready) return ready;
  ready = q(`CREATE TABLE IF NOT EXISTS percentages (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    percent NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`).catch(e => { ready = null; throw e; });
  return ready;
}

// Nombre → slug estable para consultar por URL (sin acentos, minúsculas, guiones).
function slugify(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const shape = r => ({ id: String(r.id), name: r.name, slug: r.slug, percent: Number(r.percent) });

// Todos los porcentajes (para la lista de Ajustes).
async function list() {
  await ensure();
  const r = await q(`SELECT id, name, slug, percent FROM percentages ORDER BY name ASC`);
  return r.rows.map(shape);
}

// Uno por nombre (o slug). Devuelve null si no existe.
async function getByName(name) {
  await ensure();
  const s = slugify(name);
  if (!s) return null;
  const r = await q(`SELECT id, name, slug, percent FROM percentages WHERE slug=$1`, [s]);
  return r.rows[0] ? shape(r.rows[0]) : null;
}

function validar(name, percent) {
  const nombre = String(name || '').trim();
  if (!nombre) { const e = new Error('El nombre es obligatorio'); e.status = 400; throw e; }
  if (slugify(nombre) === '') { const e = new Error('El nombre no es válido'); e.status = 400; throw e; }
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) { const e = new Error('Porcentaje inválido'); e.status = 400; throw e; }
  return { nombre, valor: Math.round(n * 100) / 100 };
}

// Crea o actualiza. Con id → edita esa fila (permite renombrar). Sin id → upsert
// por slug (mismo nombre = actualizar su valor). Devuelve la fila resultante.
async function save({ id, name, percent }, actor) {
  await ensure();
  const { nombre, valor } = validar(name, percent);
  const slug = slugify(nombre);
  let row;
  try {
    if (id) {
      const r = await q(
        `UPDATE percentages SET name=$2, slug=$3, percent=$4, updated_at=now() WHERE id=$1
         RETURNING id, name, slug, percent`, [id, nombre, slug, valor]);
      if (!r.rows[0]) { const e = new Error('No existe ese porcentaje'); e.status = 404; throw e; }
      row = r.rows[0];
    } else {
      const r = await q(
        `INSERT INTO percentages (name, slug, percent, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, percent=EXCLUDED.percent, updated_at=now()
         RETURNING id, name, slug, percent`, [nombre, slug, valor]);
      row = r.rows[0];
    }
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) { const err = new Error('Ya existe un porcentaje con ese nombre'); err.status = 409; throw err; }
    throw e;
  }
  try {
    await q(`INSERT INTO action_logs (action, actor_name, detail) VALUES ($1,$2,$3)`,
      ['percent_set', actor || 'panel', `Porcentaje "${nombre}" = ${valor}%`]);
  } catch (_) {}
  return shape(row);
}

async function remove(id) {
  await ensure();
  const r = await q(`DELETE FROM percentages WHERE id=$1 RETURNING id`, [id]);
  return !!r.rows[0];
}

module.exports = { list, getByName, save, remove, slugify };
