/* =========================================================
   agents.js — Ajustes: qué agente de voz atiende las llamadas.
   Proxea el servicio de phone-switch (app.swordaisolutions.com) para que la
   API key NUNCA salga al navegador y para evitar problemas de CORS.
   Config por env: AGENT_API_BASE, AGENT_CLIENT_ID, AGENT_API_KEY.
   Se monta en /api (detrás del gate de plataforma).
   ========================================================= */
'use strict';
const express = require('express');
const { q } = require('./db');
const { userForToken } = require('./analyticsAuth');
const router = express.Router();

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(req.path, e.message); res.status(500).json({ error: e.message }); });

const BASE = String(process.env.AGENT_API_BASE || 'https://app.swordaisolutions.com').replace(/\/+$/, '');
const CLIENT_ID = String(process.env.AGENT_CLIENT_ID || '').trim();
const API_KEY = String(process.env.AGENT_API_KEY || '').trim();
const configurado = () => !!(CLIENT_ID && API_KEY);

// Email de quien hace el cambio (para el registro). Usa la caché del token.
async function actorDe(req) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const u = await userForToken(t);
    return u ? (u.email || u.id) : null;
  } catch (_) { return null; }
}

// ---------- Lectura: agentes disponibles + números y su agente actual ----------
// GET /api/agents
router.get('/agents', wrap(async (_req, res) => {
  if (!configurado()) {
    return res.json({ available: false, agents: [], phoneNumbers: [], error: 'Falta configurar AGENT_CLIENT_ID / AGENT_API_KEY' });
  }
  const url = `${BASE}/api/phone-switch/agents?clientId=${encodeURIComponent(CLIENT_ID)}&apiKey=${encodeURIComponent(API_KEY)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) {
    return res.status(502).json({ available: false, agents: [], phoneNumbers: [], error: (j && (j.error || j.message)) || `El servicio de agentes respondió ${r.status}` });
  }
  res.json({
    available: true,
    agents: (j.agents || []).map(a => ({
      id: a.id, name: a.name || a.id,
      agentType: a.agentType || null,
      connected: !!a.connected
    })),
    phoneNumbers: (j.phoneNumbers || []).map(p => ({
      id: p.id, phoneNumber: p.phoneNumber || null,
      friendlyName: p.friendlyName || null,
      currentAgentId: p.currentAgentId || null,
      currentAgentName: p.currentAgentName || null
    }))
  });
}));

// ---------- Cambio: asigna el agente al número ----------
// POST /api/agents/select  { agentId, phoneNumberId? }
// agentId null o '' => desasigna el número.
router.post('/agents/select', wrap(async (req, res) => {
  if (!configurado()) return res.status(503).json({ error: 'Servicio de agentes no configurado en el servidor' });
  const b = req.body || {};
  const agentId = (b.agentId === null || b.agentId === undefined || b.agentId === '') ? null : String(b.agentId);

  const cuerpo = { clientId: Number(CLIENT_ID), apiKey: API_KEY, agentId };
  // Opcional: solo hace falta si la cuenta tiene más de un número.
  if (b.phoneNumberId != null && b.phoneNumberId !== '') cuerpo.phoneNumberId = Number(b.phoneNumberId);

  const r = await fetch(`${BASE}/api/phone-switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success === false) {
    return res.status(r.ok ? 400 : r.status).json({
      error: (j && (j.error || j.message)) || 'No se pudo cambiar el agente',
      // El servicio lista los números disponibles cuando falta phoneNumberId.
      detail: j || null
    });
  }

  // Registro (aparece en la pestaña Registros). No rompe si falla.
  try {
    const actor = await actorDe(req);
    const nombre = (j.agent && j.agent.name) || (agentId ? agentId : 'sin agente');
    const num = (j.phoneNumber && j.phoneNumber.phoneNumber) || '';
    await q(`INSERT INTO action_logs (action, actor_name, detail) VALUES ($1,$2,$3)`,
      ['agent_switch', actor || 'panel', `Agente de llamadas: ${nombre}${num ? ' → ' + num : ''}`]);
  } catch (e) { console.error('agents log', e.message); }

  res.json({
    ok: true,
    message: j.message || 'Agente actualizado',
    agent: j.agent || null,
    phoneNumber: j.phoneNumber || null
  });
}));

module.exports = router;
