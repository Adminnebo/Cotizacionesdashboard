/* =========================================================
   range.js — parseo del rango de fechas de la query.
   ?from=YYYY-MM-DD&to=YYYY-MM-DD (fechas específicas) o ?days=N|all.
   'to' es inclusivo (día completo). Devuelve {from, to} ISO. Mínimo 2000-01-01.
   Las fechas sin hora son días de la zona TZ_DISPLAY (por defecto RD), no de UTC:
   así "11 de octubre" son las 00:00–24:00 de RD, igual que en el reporte de consumo.
   Compartido por server.js, quotes.js, calls.js y camila.js.
   ========================================================= */
'use strict';

const ZONA = process.env.TZ_DISPLAY || 'America/Santo_Domingo';
const DIA = 86400000;
const soloFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// Minutos que la zona está adelantada respecto de UTC en ese instante (RD: -240).
function desfaseMin(zona, ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms) / 60000;
}

// Instante en que empieza el día 'YYYY-MM-DD' en la zona.
function inicioDelDia(fecha, zona = ZONA) {
  const [y, m, d] = fecha.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  return new Date(utc - desfaseMin(zona, utc) * 60000);
}

function rangeOf(req, zona = ZONA) {
  const now = Date.now();
  const minMs = Date.parse('2000-01-01T00:00:00Z');
  let fromMs, toMs;
  const qf = String(req.query.from || '').trim();
  const qt = String(req.query.to || '').trim();
  if (qf || qt) {
    fromMs = !qf ? minMs : soloFecha(qf) ? inicioDelDia(qf, zona).getTime() : Date.parse(qf);
    // 'to' de solo fecha incluye el día completo: hasta el inicio del día siguiente.
    toMs = !qt ? now : soloFecha(qt) ? inicioDelDia(qt, zona).getTime() + DIA : Date.parse(qt);
    if (isNaN(fromMs)) fromMs = minMs;
    if (isNaN(toMs)) toMs = now;
  } else {
    const days = req.query.days === 'all' ? 100000 : (Number(req.query.days) || 30);
    fromMs = now - days * DIA;
    toMs = now + 1000;
  }
  if (fromMs < minMs) fromMs = minMs;
  if (toMs < fromMs) toMs = fromMs + DIA;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

module.exports = { rangeOf, inicioDelDia };
