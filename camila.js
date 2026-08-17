/* =========================================================
   camila.js — % de eficiencia de Camila a partir de las ejecuciones
   de n8n (API pública). Se monta en /api.

   Mide SOLO los flujos de procesamiento de Camila (los 2 folders de n8n
   "Camila Agente WhatsApp" y "New IG FB WEB CAMILA"), EXCLUYENDO el
   "WhatsApp trigger": ese recibe todos los eventos del webhook de Meta
   (acuses de enviado/entregado/leído), no solo conversaciones, y dispararía
   ~30× más ejecuciones que nunca "fallan" → inflaría el % a ~100%.

   Eficiencia = ejecuciones con status 'success' ÷ ejecuciones terminadas
   (success + error/crashed). Las ejecuciones en curso/canceladas no cuentan.
   Se separa PRODUCCIÓN (mode ≠ 'manual') de TEST (mode = 'manual').

   Rendimiento: la API de n8n no filtra por fecha ni da conteos, y algún
   flujo dispara miles de veces al mes → paginar en cada visita sería lentísimo.
   Por eso se mantiene un espejo EN MEMORIA que se sincroniza de forma
   incremental (solo las ejecuciones nuevas). La tarjeta responde al instante.
   ========================================================= */
'use strict';
const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { optionalAuth } = require('./analyticsAuth');
const { rangeOf } = require('./range');
const router = express.Router();

const API_URL = String(process.env.N8N_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.N8N_API_TOKEN || '';
const CONFIGURED = !!(API_URL && API_TOKEN);

// Los 7 flujos de procesamiento (el WhatsApp trigger queda FUERA a propósito).
const WORKFLOWS = [
  { id: 'l5VYme9yNIWnkni4', name: '2 - WhatsApp bot',                         folder: 'WhatsApp'  },
  { id: 'DfETlpQTmwhQmcLi', name: '2.1 - Procesar Input Camila',              folder: 'WhatsApp'  },
  { id: 'WsHNndYM26fU85Ds', name: 'IG/FB/WEB Bot',                            folder: 'IG/FB/WEB' },
  { id: 'sdk9rxwAyILKJI4R', name: 'Procesar Input (Unificado Web + FB + IG)', folder: 'IG/FB/WEB' },
  { id: 'qnsSUSkJsoJHWANC', name: 'enviar fichatec IG/FB/WEB',                folder: 'IG/FB/WEB' },
  { id: 'HoIVm3AHlNRnuST2', name: 'enviar_imagen IG/FB/WEB',                  folder: 'IG/FB/WEB' },
  { id: 'IqlWkProMlALEQzd', name: 'generar_cotizacion IG/FB/WEB',             folder: 'IG/FB/WEB' }
];

const BACKFILL_DAYS = Number(process.env.CAMILA_BACKFILL_DAYS || 120);   // histórico que se mantiene
const SYNC_MS       = Number(process.env.CAMILA_SYNC_MS || 5 * 60 * 1000);
const MAX_PAGES     = Number(process.env.CAMILA_MAX_PAGES || 600);        // tope de seguridad (250/página)

// Espejo en memoria: workflowId -> Map(execId -> { t:ms, prod:bool, ok:bool|null })
//   ok === true  → success            ok === false → error/crashed
//   ok === null  → en curso/otro estado (NO cuenta en el ratio)
const store = new Map();
WORKFLOWS.forEach(w => store.set(w.id, new Map()));
let lastSync = 0, ready = false, syncing = false, lastError = null;

function apiGet(pathQ) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(API_URL + pathQ); } catch (e) { return reject(new Error('N8N_API_URL inválida')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers: { 'X-N8N-API-KEY': API_TOKEN, accept: 'application/json' }, timeout: 20000 }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => {
        if (r.statusCode >= 400) return reject(new Error('n8n ' + r.statusCode + ': ' + s.slice(0, 140)));
        try { resolve(JSON.parse(s)); } catch (_) { reject(new Error('respuesta no-JSON de n8n')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout n8n')));
    req.on('error', reject);
  });
}

const classify = e => ({
  t: Date.parse(e.startedAt || e.stoppedAt || '') || 0,
  prod: e.mode !== 'manual',
  ok: e.status === 'success' ? true : (e.status === 'error' || e.status === 'crashed') ? false : null
});
const numId = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Sincroniza UN workflow de forma incremental. En el primer arranque baja el
// histórico (hasta BACKFILL_DAYS); después solo trae lo nuevo (se detiene al
// llegar a ids ya conocidos) y refresca las que estaban "en curso".
async function syncWorkflow(w, firstRun) {
  const horizon = Date.now() - BACKFILL_DAYS * 86400000;
  const map = store.get(w.id);
  let maxKnown = 0; for (const id of map.keys()) { const n = numId(id); if (n > maxKnown) maxKnown = n; }

  let cursor = '', pages = 0, added = 0, capped = false;
  do {
    const j = await apiGet('/api/v1/executions?workflowId=' + encodeURIComponent(w.id) + '&limit=250' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const list = j.data || [];
    if (!list.length) break;
    let reachedOld = false, minIdPage = Infinity;
    for (const e of list) {
      const rec = classify(e);
      if (rec.t && rec.t < horizon) { reachedOld = true; break; }   // ya pasamos el histórico
      const id = String(e.id);
      if (!map.has(id)) added++;
      map.set(id, rec);                                             // upsert (actualiza estados que cambiaron)
      minIdPage = Math.min(minIdPage, numId(id));
    }
    cursor = j.nextCursor || '';
    pages++;
    if (reachedOld) break;
    // Incremental: si la página ya bajó por debajo del id máximo que teníamos,
    // cubrimos todo lo nuevo (lo más viejo ya está guardado).
    if (!firstRun && maxKnown && minIdPage <= maxKnown) break;
    if (pages >= MAX_PAGES) { capped = true; break; }
  } while (cursor);

  // Refresca las ejecuciones que seguían "en curso" (por si ya terminaron).
  const pend = [];
  for (const [id, v] of map) if (v.ok === null) pend.push(id);
  for (const id of pend.slice(0, 40)) {
    try { const e = await apiGet('/api/v1/executions/' + encodeURIComponent(id)); if (e && e.id != null) map.set(String(e.id), classify(e)); }
    catch (_) { /* si desapareció, se limpia abajo por horizonte */ }
  }
  // Poda lo más viejo que el horizonte para acotar memoria.
  for (const [id, v] of map) if (v.t && v.t < horizon) map.delete(id);
  return { wf: w.name, added, pages, capped };
}

async function syncAll() {
  if (!CONFIGURED || syncing) return;
  syncing = true;
  const firstRun = !ready;
  try {
    let totAdded = 0, anyCap = false;
    for (const w of WORKFLOWS) {                     // secuencial: no saturar n8n
      try { const r = await syncWorkflow(w, firstRun); totAdded += r.added; if (r.capped) anyCap = true; }
      catch (e) { lastError = w.name + ': ' + e.message; console.error('[camila] sync', w.name, e.message); }
    }
    lastSync = Date.now(); ready = true; if (!lastError || totAdded) lastError = anyCap ? 'histórico truncado por tope de páginas' : null;
    if (firstRun) console.log('[camila] backfill listo:', totAdded, 'ejecuciones' + (anyCap ? ' (truncado)' : ''));
  } finally { syncing = false; }
}

function start() {
  if (!CONFIGURED) { console.warn('[camila] N8N_API_URL / N8N_API_TOKEN sin configurar → métrica deshabilitada'); return; }
  syncAll();                                          // backfill al arrancar
  setInterval(syncAll, SYNC_MS);
}

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e); res.status(500).json({ error: 'Error interno del servidor' }); });

// GET /api/camila-eficiencia?days=30|all | from&to
router.get('/camila-eficiencia', optionalAuth, wrap(async (req, res) => {
  if (!CONFIGURED) return res.json({ available: false, error: 'n8n API no configurada (N8N_API_URL / N8N_API_TOKEN)' });
  const { from, to } = rangeOf(req);
  const f = Date.parse(from), t = Date.parse(to);

  const blank = () => ({ total: 0, ok: 0, failed: 0 });
  const add = (a, b) => { a.total += b.total; a.ok += b.ok; a.failed += b.failed; };
  const overall = { prod: blank(), test: blank() };
  const folders = new Map();
  const byWorkflow = [];

  for (const w of WORKFLOWS) {
    const map = store.get(w.id) || new Map();
    const prod = blank(), test = blank();
    for (const v of map.values()) {
      if (!v.t || v.t < f || v.t >= t) continue;
      if (v.ok === null) continue;                    // en curso/cancelada: no cuenta
      const b = v.prod ? prod : test;
      b.total++; if (v.ok) b.ok++; else b.failed++;
    }
    add(overall.prod, prod); add(overall.test, test);
    if (!folders.has(w.folder)) folders.set(w.folder, { folder: w.folder, prod: blank(), test: blank() });
    const fo = folders.get(w.folder); add(fo.prod, prod); add(fo.test, test);
    byWorkflow.push({ id: w.id, name: w.name, folder: w.folder, prod, test });
  }

  const eff = o => ({ total: o.total, ok: o.ok, failed: o.failed, eff: o.total ? o.ok / o.total : null });
  const pack = x => ({ prod: eff(x.prod), test: eff(x.test) });

  res.json({
    available: true,
    ready,
    syncing,
    updatedAt: lastSync ? new Date(lastSync).toISOString() : null,
    warning: lastError || null,
    range: { from, to },
    overall: pack(overall),
    byFolder: [...folders.values()].map(x => ({ folder: x.folder, ...pack(x) })),
    byWorkflow: byWorkflow.map(x => ({ id: x.id, name: x.name, folder: x.folder, ...pack(x) }))
  });
}));

module.exports = router;
module.exports.start = start;
