/* =========================================================
   calls.js — Llamadas del agente de voz.
   Fuente de verdad: tabla propia en Postgres. Se alimenta desde n8n
   (webhook con X-Api-Key). Cada llamada guarda: agente, número,
   transcripción, grabación (URL), duración (segundos) y coste.
   Expone lectura paginada + recap agregado del rango. Se monta en /api.
   ========================================================= */
'use strict';
const express = require('express');
const { q } = require('./db');
const { optionalAuth, configured: authCfg } = require('./analyticsAuth');
const { rangeOf } = require('./range');
const { safeEqual } = require('./security');
const router = express.Router();

// El detalle de coste (texto libre) es SOLO para super_admin. Sin auth (dev) se
// muestra para no estorbar el desarrollo local.
const esSuper = req => !authCfg || req.role === 'super_admin';

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e); res.status(500).json({ error: 'Error interno del servidor' }); });
const COST_CCY = process.env.CALL_COST_CURRENCY || 'USD';

// ---------- Esquema (idempotente) ----------
let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS calls (
      id BIGSERIAL PRIMARY KEY,
      agent TEXT,
      phone TEXT,
      transcript TEXT,
      recording_url TEXT,
      duration_secs INT,
      cost NUMERIC,
      external_id TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Detalle de coste en texto libre (desglose), visible solo para super_admin.
    await q(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_detail TEXT`);
    // Persona de la llamada: nombre + id (ej. id de contacto en GHL/CRM).
    await q(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_name TEXT`);
    await q(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_id TEXT`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS calls_external_id_uq ON calls(external_id) WHERE external_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS calls_created_idx ON calls(created_at)`);
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

// ---------- Helpers ----------
// Duración a segundos: acepta número (segundos), "90", "1:30", "01:02:03".
function parseDuration(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s)));
  const parts = s.split(':').map(x => Number(x));
  if (!parts.length || parts.some(x => !Number.isFinite(x))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
// Coste a número: quita símbolos de moneda ("$1.50", "USD 1.5" -> 1.5).
function parseCost(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const num = (v, d = 0) => (Number(v) || d);

// Webhook de n8n: misma API key que el pipeline (header X-Api-Key).
function requireApiKey(req, res, next) {
  const key = process.env.N8N_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'N8N_API_KEY no configurado en el servidor' });
  const got = req.headers['x-api-key'] || req.query.api_key || '';
  if (!safeEqual(got, key)) return res.status(401).json({ error: 'API key inválida' });
  next();
}

// `super` decide si se incluye el detalle de coste (texto solo super_admin).
const shapeCall = (c, { full = false, super: canSuper = false } = {}) => ({
  id: String(c.id),
  agent: c.agent || null,
  phone: c.phone || null,
  contactName: c.contact_name || null,
  contactId: c.contact_id || null,
  transcript: full ? (c.transcript || '') : undefined,
  transcriptPreview: c.transcript ? (c.transcript.length > 160 ? c.transcript.slice(0, 160) + '…' : c.transcript) : null,
  hasTranscript: !!c.transcript,
  recordingUrl: c.recording_url || null,
  durationSecs: c.duration_secs != null ? Number(c.duration_secs) : null,
  // El coste es dato interno (consumo del agente de voz): solo super_admin.
  cost: canSuper && c.cost != null ? Number(c.cost) : null,
  // Solo el super_admin lo recibe; para el resto ni siquiera viaja el campo.
  costDetail: canSuper ? (c.cost_detail || null) : undefined,
  externalId: c.external_id || null,
  at: c.created_at
});

// ---------- Ingesta (n8n) ----------
// POST /api/calls/hook   (header: X-Api-Key: <N8N_API_KEY>)
// body: { phone, contactName?, contactId?, agent?, transcript?, recordingUrl?,
//         duration?, cost?, costDetail?, externalId?, at?, meta? }
//   - contactName: nombre de la persona (alias: name, nombre)
//   - contactId:   id de la persona/contacto (alias: contact_id, ghlContactId)
//   - duration: segundos, "mm:ss" o "hh:mm:ss"   · cost: número o "$1.50"
// Idempotente por externalId (si viene): re-postear actualiza en vez de duplicar.
router.post('/calls/hook', requireApiKey, wrap(async (req, res) => {
  await ensureSchema();
  const b = req.body || {};
  const agent = b.agent != null ? String(b.agent) : null;
  const phone = b.phone != null ? String(b.phone) : (b.numero != null ? String(b.numero) : null);
  // Persona: nombre e id (acepta varias formas por comodidad desde n8n).
  const contactNameRaw = b.contactName ?? b.name ?? b.nombre ?? b.clientName ?? null;
  const contactName = contactNameRaw != null && String(contactNameRaw).trim() !== '' ? String(contactNameRaw).trim() : null;
  const contactIdRaw = b.contactId ?? b.contact_id ?? b.idContacto ?? b.ghlContactId ?? b.personId ?? null;
  const contactId = contactIdRaw != null && String(contactIdRaw).trim() !== '' ? String(contactIdRaw).trim() : null;
  const transcript = b.transcript != null ? String(b.transcript) : (b.transcripcion != null ? String(b.transcripcion) : null);
  const recordingUrl = b.recordingUrl || b.recording || b.grabacion || null;
  const durationSecs = parseDuration(b.durationSecs != null ? b.durationSecs : (b.duration != null ? b.duration : b.duracion));
  const cost = parseCost(b.cost != null ? b.cost : b.coste);
  // Detalle de coste (texto libre): desglose que solo verá el super_admin.
  const costDetailRaw = b.costDetail ?? b.costeDetalle ?? b.detalleCoste ?? b.detalle_coste ?? b.costDetalle ?? null;
  const costDetail = costDetailRaw != null && String(costDetailRaw).trim() !== '' ? String(costDetailRaw) : null;
  const ext = b.externalId != null ? String(b.externalId) : null;
  const at = b.at ? new Date(b.at) : null;
  const meta = b.meta != null ? JSON.stringify(b.meta) : null;

  if (ext) {
    const upd = await q(
      `INSERT INTO calls (agent, phone, contact_name, contact_id, transcript, recording_url, duration_secs, cost, cost_detail, external_id, meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now()))
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         agent = COALESCE(EXCLUDED.agent, calls.agent),
         phone = COALESCE(EXCLUDED.phone, calls.phone),
         contact_name = COALESCE(EXCLUDED.contact_name, calls.contact_name),
         contact_id = COALESCE(EXCLUDED.contact_id, calls.contact_id),
         transcript = COALESCE(EXCLUDED.transcript, calls.transcript),
         recording_url = COALESCE(EXCLUDED.recording_url, calls.recording_url),
         duration_secs = COALESCE(EXCLUDED.duration_secs, calls.duration_secs),
         cost = COALESCE(EXCLUDED.cost, calls.cost),
         cost_detail = COALESCE(EXCLUDED.cost_detail, calls.cost_detail),
         meta = COALESCE(EXCLUDED.meta, calls.meta)
       RETURNING *`,
      [agent, phone, contactName, contactId, transcript, recordingUrl ? String(recordingUrl) : null, durationSecs, cost, costDetail, ext, meta, at]
    );
    // El emisor es n8n (API key), le devolvemos el registro completo.
    return res.json({ ok: true, call: shapeCall(upd.rows[0], { full: true, super: true }) });
  }

  const ins = await q(
    `INSERT INTO calls (agent, phone, contact_name, contact_id, transcript, recording_url, duration_secs, cost, cost_detail, meta, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, now())) RETURNING *`,
    [agent, phone, contactName, contactId, transcript, recordingUrl ? String(recordingUrl) : null, durationSecs, cost, costDetail, meta, at]
  );
  res.status(201).json({ ok: true, call: shapeCall(ins.rows[0], { full: true, super: true }) });
}));

// ---------- Lectura: listado + recap del rango ----------
// GET /api/calls?days=30|all | from&to  &search=&agent=&page=&limit=
router.get('/calls', optionalAuth, wrap(async (req, res) => {
  await ensureSchema();
  const { from, to } = rangeOf(req);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;

  const params = [from, to];
  let where = `created_at >= $1 AND created_at < $2`;
  const search = String(req.query.search || '').trim();
  if (search) { params.push('%' + search + '%'); where += ` AND (phone ILIKE $${params.length} OR agent ILIKE $${params.length} OR contact_name ILIKE $${params.length} OR contact_id ILIKE $${params.length} OR transcript ILIKE $${params.length})`; }
  const agent = String(req.query.agent || '').trim();
  if (agent) { params.push(agent); where += ` AND agent = $${params.length}`; }

  const [rows, agg, byAgent] = await Promise.all([
    q(`SELECT id, agent, phone, contact_name, contact_id, transcript, recording_url, duration_secs, cost, cost_detail, external_id, created_at
       FROM calls WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    q(`SELECT count(*)::int AS calls, COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(duration_secs),0)::bigint AS dur
       FROM calls WHERE ${where}`, params),
    q(`SELECT COALESCE(NULLIF(TRIM(agent),''),'(sin agente)') AS agent,
              count(*)::int AS calls, COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(duration_secs),0)::bigint AS dur
       FROM calls WHERE ${where} GROUP BY 1 ORDER BY calls DESC, cost DESC`, params)
  ]);

  const a = agg.rows[0] || {};
  const calls = num(a.calls);
  const totalCost = num(a.cost);
  const totalDur = num(a.dur);
  // El coste (consumo del agente de voz) es dato interno: SOLO super_admin.
  const canCost = esSuper(req);

  res.json({
    range: { from, to },
    page, limit, total: calls, currency: COST_CCY,
    canSeeCost: canCost,
    recap: {
      calls,
      totalCost: canCost ? totalCost : null,
      totalDurationSecs: totalDur,
      avgDurationSecs: calls ? totalDur / calls : 0,
      avgCost: canCost ? (calls ? totalCost / calls : 0) : null,
      agents: byAgent.rows.map(r => ({ agent: r.agent, calls: num(r.calls), cost: canCost ? num(r.cost) : null, durationSecs: num(r.dur) }))
    },
    items: rows.rows.map(c => shapeCall(c, { super: canCost }))
  });
}));

// ---------- Detalle (transcripción completa) ----------
// GET /api/calls/:id
router.get('/calls/:id', optionalAuth, wrap(async (req, res) => {
  await ensureSchema();
  const r = await q(`SELECT * FROM calls WHERE id=$1`, [Number(req.params.id)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Llamada no encontrada' });
  res.json({ call: shapeCall(r.rows[0], { full: true, super: esSuper(req) }) });
}));

module.exports = router;
