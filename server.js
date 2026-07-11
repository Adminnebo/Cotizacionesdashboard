/* =========================================================
   Analytics WhatsApp — backend (Express + Postgres).
   Lee la MISMA base y calcula métricas: enviados/recibidos,
   por día, horas pico, tiempo de respuesta, último enviado, cotizaciones.
   ========================================================= */
'use strict';
const path = require('path');
const express = require('express');
const sql = require('mssql');
const { q, pool } = require('./db');

const app = express();
app.use(express.json({ limit: '12mb' }));
const PORT = process.env.PORT || 8080;
const TZ = process.env.TZ_DISPLAY || 'America/Santo_Domingo';

// Coste por mensaje. No existe en la base: se aplica una tarifa configurable.
// MSG_COST_OUT = coste por mensaje saliente; MSG_COST_IN = por entrante (normalmente 0).
const MSG_COST_OUT = Number(process.env.MSG_COST_OUT || 0);
const MSG_COST_IN = Number(process.env.MSG_COST_IN || 0);
const COST_CCY = process.env.MSG_COST_CURRENCY || 'USD';

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });

// Cotizaciones: viven en una base MSSQL aparte (site4now). Conexión por env MSSQL_*.
// Cuenta las filas de la tabla de cotizaciones en el rango de fechas.
let mssqlPool = null;
async function getMssql() {
  if (!process.env.MSSQL_SERVER) return null;
  if (mssqlPool && mssqlPool.connected) return mssqlPool;
  try {
    const pool = new sql.ConnectionPool({
      server: process.env.MSSQL_SERVER,
      database: process.env.MSSQL_DATABASE,
      user: process.env.MSSQL_USER,
      password: process.env.MSSQL_PASSWORD,
      port: Number(process.env.MSSQL_PORT || 1433),
      options: { encrypt: process.env.MSSQL_ENCRYPT === 'true', trustServerCertificate: true },
      pool: { max: 4, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000, requestTimeout: 15000
    });
    mssqlPool = await pool.connect();
    mssqlPool.on('error', () => { mssqlPool = null; });
    return mssqlPool;
  } catch (e) { mssqlPool = null; throw e; }
}
async function quotesStat(from) {
  if (!process.env.MSSQL_SERVER) return { available: false };
  const table = process.env.MSSQL_QUOTES_TABLE || 'iCotizacionesWebIA';
  const dateCol = process.env.MSSQL_QUOTES_DATE || 'FechaRegistro';
  const amountCol = process.env.MSSQL_QUOTES_AMOUNT || 'total';
  try {
    const pool = await getMssql();
    const r = await pool.request().input('from', sql.DateTime, new Date(from))
      .query(`SELECT COUNT(*) AS n, COALESCE(SUM([${amountCol}]),0) AS monto FROM [${table}] WHERE [${dateCol}] >= @from`);
    const row = r.recordset[0] || {};
    return { available: true, count: Number(row.n) || 0, amount: Number(row.monto) || 0 };
  } catch (e) {
    mssqlPool = null;
    return { available: false, error: e.message };
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', wrap(async (req, res) => {
  const days = req.query.days === 'all' ? 100000 : (Number(req.query.days) || 30);
  let fromMs = Date.now() - days * 86400000;
  const minMs = Date.parse('2000-01-01T00:00:00Z'); // MSSQL DateTime no admite < 1753
  if (fromMs < minMs) fromMs = minMs;
  const from = new Date(fromMs).toISOString();

  const [kpi, rt, byDay, byHour, byType, quotes] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received,
              max(created_at) FILTER (WHERE direction='out') AS last_sent_at,
              count(DISTINCT conversation_id) AS active_convs
       FROM messages WHERE created_at >= $1`, [from]),
    q(`WITH seq AS (
         SELECT conversation_id, direction, created_at,
                LAG(direction)  OVER w AS pd,
                LAG(created_at) OVER w AS pa
         FROM messages WHERE created_at >= $1
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at))
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created_at - pa))) AS median_secs,
              avg(EXTRACT(EPOCH FROM (created_at - pa))) AS avg_secs,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created_at - pa))) AS p90_secs,
              count(*) AS n
       FROM seq WHERE direction='out' AND pd='in' AND (created_at - pa) < interval '6 hours'`, [from]),
    q(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received
       FROM messages WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [from, TZ]),
    q(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour,
              count(*) FILTER (WHERE direction='out') AS sent,
              count(*) FILTER (WHERE direction='in')  AS received
       FROM messages WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [from, TZ]),
    q(`SELECT COALESCE(type,'text') AS type, count(*)::int AS n
       FROM messages WHERE created_at >= $1 AND direction='out' GROUP BY 1 ORDER BY 2 DESC`, [from]),
    quotesStat(from)
  ]);

  const k = kpi.rows[0] || {};
  const r = rt.rows[0] || {};
  const hourMap = {}; byHour.rows.forEach(x => { hourMap[x.hour] = x; });
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sent: Number((hourMap[h] || {}).sent) || 0, received: Number((hourMap[h] || {}).received) || 0 }));

  res.json({
    range: { days, from, tz: TZ },
    kpi: {
      sent: Number(k.sent) || 0,
      received: Number(k.received) || 0,
      lastSentAt: k.last_sent_at || null,
      activeConversations: Number(k.active_convs) || 0
    },
    responseTime: {
      medianSecs: r.median_secs != null ? Number(r.median_secs) : null,
      avgSecs: r.avg_secs != null ? Number(r.avg_secs) : null,
      p90Secs: r.p90_secs != null ? Number(r.p90_secs) : null,
      samples: Number(r.n) || 0
    },
    byDay: byDay.rows.map(x => ({ day: x.day, sent: Number(x.sent) || 0, received: Number(x.received) || 0 })),
    byHour: hours,
    byType: byType.rows.map(x => ({ type: x.type, n: x.n })),
    quotes
  });
}));

// Mensajes emparejados: cada mensaje entrante junto a su respuesta saliente,
// con el tiempo que tardó la respuesta y el coste del saliente. Un par = un
// saliente cuyo mensaje inmediatamente anterior en la conversación fue entrante.
const trunc = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : (t || ''));
app.get('/api/messages', wrap(async (req, res) => {
  const days = req.query.days === 'all' ? 100000 : (Number(req.query.days) || 30);
  let fromMs = Date.now() - days * 86400000;
  const minMs = Date.parse('2000-01-01T00:00:00Z');
  if (fromMs < minMs) fromMs = minMs;
  const from = new Date(fromMs).toISOString();

  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;

  const [rows, totalR] = await Promise.all([
    q(`WITH seq AS (
         SELECT id, conversation_id, direction, type, text, status, created_at,
                LAG(direction)  OVER w AS prev_dir,
                LAG(text)       OVER w AS prev_text,
                LAG(type)       OVER w AS prev_type,
                LAG(created_at) OVER w AS prev_at
         FROM messages WHERE created_at >= $1
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id))
       SELECT id, conversation_id, created_at AS out_at, status,
              text AS out_text, type AS out_type,
              prev_text AS in_text, prev_type AS in_type, prev_at AS in_at,
              EXTRACT(EPOCH FROM (created_at - prev_at)) AS response_secs
       FROM seq
       WHERE direction='out' AND prev_dir='in'
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`, [from]),
    q(`WITH seq AS (
         SELECT direction, LAG(direction) OVER w AS prev_dir
         FROM messages WHERE created_at >= $1
         WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id))
       SELECT count(*)::int AS n FROM seq WHERE direction='out' AND prev_dir='in'`, [from])
  ]);

  const total = totalR.rows[0] ? totalR.rows[0].n : 0;
  res.json({
    page, limit, total,
    cost: { out: MSG_COST_OUT, in: MSG_COST_IN, currency: COST_CCY },
    items: rows.rows.map(m => ({
      id: String(m.id),
      conversationId: String(m.conversation_id),
      inText: trunc(m.in_text, 240),
      inType: m.in_type || 'text',
      inAt: m.in_at,
      outText: trunc(m.out_text, 240),
      outType: m.out_type || 'text',
      outAt: m.out_at,
      status: m.status || '',
      responseSecs: m.response_secs != null ? Number(m.response_secs) : null,
      cost: MSG_COST_OUT
    }))
  });
}));

// ── Guardado de mensajes de WhatsApp ──────────────────────────────────────
// Reemplaza los webhooks n8n wa-save-in / wa-save-out. Persisten el mensaje en
// la MISMA base (contacts/conversations/messages): upsert contacto (por
// ghl_contact_id, si no por phone) -> upsert conversación (1 por contacto) ->
// insert mensaje (idempotente por wamid, media base64->bytea) -> rollup.
// Endpoints abiertos (sin auth), igual que los webhooks originales.
const mediaLabel = (type) => ({
  image: '[imagen]', audio: '[audio]', voice: '[audio]', ptt: '[audio]',
  video: '[video]', document: '[documento]', sticker: '[sticker]'
}[String(type || '').toLowerCase()] || '');

async function saveWaMessage(direction, req, res) {
  const b = req.body || {};
  const ghlContactId = b.contactId ? String(b.contactId) : null;
  const phone = b.phone ? String(b.phone) : null;
  const name = b.name ? String(b.name) : null;
  const channel = b.channel ? String(b.channel) : 'whatsapp';
  const type = b.type ? String(b.type) : 'text';
  const text = b.text != null ? String(b.text) : null;
  const wamid = b.wamid ? String(b.wamid) : null;
  const mediaUrl = b.mediaUrl ? String(b.mediaUrl) : null;
  const mediaMime = b.mediaMime ? String(b.mediaMime) : null;
  const filename = b.filename ? String(b.filename) : null;
  const mediaData = b.mediaBase64 ? Buffer.from(String(b.mediaBase64), 'base64') : null;
  const status = b.status ? String(b.status) : (direction === 'in' ? 'received' : 'sent');
  const createdAt = (b.createdAt || b.timestamp) ? new Date(b.createdAt || b.timestamp) : new Date();

  if (!ghlContactId && !phone) return res.status(400).json({ success: false, error: 'contactId or phone is required' });
  const rollupText = (text && text.trim()) ? text.slice(0, 1000) : mediaLabel(type);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Contacto
    let contactRowId;
    if (ghlContactId) {
      const r = await client.query(
        `INSERT INTO contacts (ghl_contact_id, phone, name, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (ghl_contact_id) DO UPDATE SET
           phone = COALESCE(EXCLUDED.phone, contacts.phone),
           name  = COALESCE(EXCLUDED.name,  contacts.name)
         RETURNING id`, [ghlContactId, phone, name]);
      contactRowId = r.rows[0].id;
    } else {
      const found = await client.query('SELECT id FROM contacts WHERE phone = $1 LIMIT 1', [phone]);
      if (found.rows.length) {
        contactRowId = found.rows[0].id;
        if (name) await client.query('UPDATE contacts SET name = COALESCE(name, $2) WHERE id = $1', [contactRowId, name]);
      } else {
        const ins = await client.query('INSERT INTO contacts (phone, name, created_at) VALUES ($1, $2, now()) RETURNING id', [phone, name]);
        contactRowId = ins.rows[0].id;
      }
    }

    // 2) Conversación (única por contacto)
    const conv = await client.query(
      `INSERT INTO conversations (contact_id, channel, status, updated_at)
       VALUES ($1, $2, 'open', now())
       ON CONFLICT (contact_id) DO UPDATE SET updated_at = now()
       RETURNING id`, [contactRowId, channel]);
    const conversationId = conv.rows[0].id;

    // 3) Mensaje (idempotente por wamid)
    const msg = await client.query(
      `INSERT INTO messages
         (conversation_id, wamid, direction, type, text, media_url, status,
          created_at, channel, media_mime, media_filename, media_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (wamid) DO NOTHING
       RETURNING id`,
      [conversationId, wamid, direction, type, text, mediaUrl, status,
       createdAt, channel, mediaMime, filename, mediaData]);

    if (msg.rows.length === 0 && wamid) {
      await client.query('COMMIT');
      return res.status(200).json({ success: true, duplicate: true, conversationId: String(conversationId) });
    }

    // 4) Rollup de la conversación
    if (direction === 'in') {
      await client.query(
        `UPDATE conversations SET last_message=$2, last_message_at=$3, last_direction='in',
           last_status=$4, last_inbound=$3, unread_count=COALESCE(unread_count,0)+1, updated_at=now()
         WHERE id=$1`, [conversationId, rollupText, createdAt, status]);
    } else {
      await client.query(
        `UPDATE conversations SET last_message=$2, last_message_at=$3, last_direction='out',
           last_status=$4, unread_count=0, updated_at=now()
         WHERE id=$1`, [conversationId, rollupText, createdAt, status]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      messageId: msg.rows[0] ? String(msg.rows[0].id) : null,
      conversationId: String(conversationId),
      contactId: String(contactRowId)
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`wa-save-${direction}`, e.message);
    return res.status(500).json({ success: false, error: 'Failed to save message' });
  } finally {
    client.release();
  }
}

app.post('/api/wa/save-in', wrap((req, res) => saveWaMessage('in', req, res)));
app.post('/api/wa/save-out', wrap((req, res) => saveWaMessage('out', req, res)));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Analytics escuchando en :${PORT} (TZ ${TZ})`));
