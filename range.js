/* =========================================================
   range.js — parseo del rango de fechas de la query.
   ?from=YYYY-MM-DD&to=YYYY-MM-DD (fechas específicas) o ?days=N|all.
   'to' es inclusivo (día completo). Devuelve {from, to} ISO. Mínimo 2000-01-01.
   Compartido por server.js y quotes.js.
   ========================================================= */
'use strict';

function rangeOf(req) {
  const now = Date.now();
  const minMs = Date.parse('2000-01-01T00:00:00Z');
  const day = 86400000;
  let fromMs, toMs;
  const qf = String(req.query.from || '').trim();
  const qt = String(req.query.to || '').trim();
  if (qf || qt) {
    fromMs = qf ? Date.parse(qf) : minMs;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(qt);       // solo fecha => incluye el día completo
    toMs = qt ? Date.parse(qt) + (dateOnly ? day : 0) : now;
    if (isNaN(fromMs)) fromMs = minMs;
    if (isNaN(toMs)) toMs = now;
  } else {
    const days = req.query.days === 'all' ? 100000 : (Number(req.query.days) || 30);
    fromMs = now - days * day;
    toMs = now + 1000;
  }
  if (fromMs < minMs) fromMs = minMs;
  if (toMs < fromMs) toMs = fromMs + day;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

module.exports = { rangeOf };
