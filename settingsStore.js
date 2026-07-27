/* =========================================================
   settingsStore.js — Ajustes clave/valor del panel (tabla app_settings,
   compartida con el inbox en la misma base). Por ahora: el "porcentaje"
   configurable que el super_admin edita en Ajustes y que se consulta por GET.
   ========================================================= */
'use strict';
const { q } = require('./db');

let ready = null;
function ensure() {
  if (ready) return ready;
  ready = q(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now()
  )`).catch(e => { ready = null; throw e; });
  return ready;
}

const KEY = 'porcentaje';

// Lee el porcentaje guardado (0 si nunca se fijó). Siempre un número finito.
async function getPercent() {
  await ensure();
  const r = await q(`SELECT value FROM app_settings WHERE key=$1`, [KEY]);
  const v = r.rows[0] ? Number(r.rows[0].value) : 0;
  return Number.isFinite(v) ? v : 0;
}

// Guarda el porcentaje. Acepta número o texto; valida finito y >= 0.
async function setPercent(v, actor) {
  await ensure();
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) { const e = new Error('Porcentaje inválido'); e.status = 400; throw e; }
  const val = String(Math.round(n * 100) / 100);   // hasta 2 decimales
  await q(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, val]);
  // Registro (opcional, no rompe si falla).
  try {
    await q(`INSERT INTO action_logs (action, actor_name, detail) VALUES ($1,$2,$3)`,
      ['percent_set', actor || 'panel', 'Porcentaje = ' + val + '%']);
  } catch (_) {}
  return Number(val);
}

module.exports = { getPercent, setPercent };
