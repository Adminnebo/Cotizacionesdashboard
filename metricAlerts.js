/* =========================================================
   metricAlerts.js — Avisa a la app de Alertas cuando las métricas de Camila
   se salen de lo normal.

   Dos vigilancias, cada METRIC_ALERTS_MINUTES:
     · P90 de espera del cliente (entrante → respuesta de Camila, < 6 h):
       el de las últimas 2 h ≥ 5 min (umbral fijo, no relativo a la semana: si
       el tiempo sube poco a poco, un umbral relativo nunca avisaría), en 3
       revisiones seguidas (45 min con el intervalo por defecto).
     · % de respuestas con Haiku (respaldo de DeepSeek): el de la última hora
       ≥ ×2 el de los 7 días anteriores Y al menos +10 puntos, en 2 revisiones.

   La de Haiku sale de simular 30 días reales. El P90 normal ronda 40 s, así
   que 5 min solo salta en caídas reales (p.ej. 14/09: 912 s).

   Se avisa UNA vez por episodio: vuelve a poder avisar cuando una revisión con
   datos suficientes sale normal. Además la app agrupa por errorType+node, así
   que un reintento con el incidente abierto solo suma al contador.

   Config:
     ALERTAS_TOKEN           INGEST_TOKEN de la app de Alertas (sin él solo registra)
     ALERTAS_URL             base de la app (def. https://alertas-app-production.up.railway.app)
     ALERTAS_KEY             sistema dado de alta en Alertas (def. n8n-camila)
     METRIC_ALERTS_MINUTES   cada cuánto revisar (def. 15)
   ========================================================= */
'use strict';
const { q } = require('./db');

const ALERTAS_URL = String(process.env.ALERTAS_URL || 'https://alertas-app-production.up.railway.app').replace(/\/+$/, '');
const ALERTAS_TOKEN = process.env.ALERTAS_TOKEN || '';
const ALERTAS_KEY = process.env.ALERTAS_KEY || 'n8n-camila';
const NODO = 'Métricas de Camila';

const REGLAS = {
  p90: { ventanaHoras: 2, minActual: 30, maxSeg: 300, seguidas: 3 },
  haiku: { ventanaHoras: 1, minActual: 15, minBase: 100, factor: 2, puntos: 10, seguidas: 2 }
};

// P90 (s) de lo que tarda Camila en contestar un entrante: ventana actual y los
// 7 días anteriores a ella. Misma definición que el KPI "Tiempo de respuesta",
// pero solo respuestas de Camila (un humano que contesta tarde no es el bot).
async function leerP90(horas) {
  const r = await q(`
    WITH seq AS (
      SELECT direction, created_at, sent_by,
             LAG(direction)  OVER w AS pd,
             LAG(created_at) OVER w AS pa
      FROM messages
      WHERE created_at >= now() - make_interval(hours => $1) - interval '7 days' - interval '6 hours'
      WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at)),
    resp AS (
      SELECT created_at, EXTRACT(EPOCH FROM (created_at - pa)) AS secs
      FROM seq
      WHERE direction = 'out' AND pd = 'in' AND (created_at - pa) < interval '6 hours'
        AND lower(sent_by) = 'camila'
        AND created_at >= now() - make_interval(hours => $1) - interval '7 days')
    SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FILTER (WHERE created_at >= now() - make_interval(hours => $1)) AS actual,
           count(*) FILTER (WHERE created_at >= now() - make_interval(hours => $1))::int AS n_actual,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FILTER (WHERE created_at < now() - make_interval(hours => $1)) AS base,
           count(*) FILTER (WHERE created_at < now() - make_interval(hours => $1))::int AS n_base
    FROM resp`, [horas]);
  const x = r.rows[0] || {};
  return { actual: numero(x.actual), nActual: Number(x.n_actual) || 0, base: numero(x.base), nBase: Number(x.n_base) || 0 };
}

// % de respuestas con Haiku sobre las que traen modelo: ventana actual y 7 días anteriores.
async function leerHaiku(horas) {
  const r = await q(`
    SELECT count(*) FILTER (WHERE created_at >= now() - make_interval(hours => $1))::int AS n_actual,
           count(*) FILTER (WHERE created_at >= now() - make_interval(hours => $1) AND model ILIKE '%haiku%')::int AS h_actual,
           count(*) FILTER (WHERE created_at <  now() - make_interval(hours => $1))::int AS n_base,
           count(*) FILTER (WHERE created_at <  now() - make_interval(hours => $1) AND model ILIKE '%haiku%')::int AS h_base
    FROM messages
    WHERE direction = 'out' AND model IS NOT NULL AND lower(sent_by) = 'camila'
      AND created_at >= now() - make_interval(hours => $1) - interval '7 days'`, [horas]);
  const x = r.rows[0] || {};
  const pct = (h, n) => (n ? (100 * h) / n : null);
  return {
    actual: pct(x.h_actual, x.n_actual), nActual: Number(x.n_actual) || 0,
    base: pct(x.h_base, x.n_base), nBase: Number(x.n_base) || 0
  };
}

function numero(v) { const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : null; }

// ¿La lectura se sale de lo normal? null = no hay datos suficientes para juzgar.
function juzgarP90(l, regla = REGLAS.p90) {
  if (l.nActual < regla.minActual || l.actual == null) return null;
  return l.actual >= regla.maxSeg;
}
function juzgarHaiku(l, regla = REGLAS.haiku) {
  if (l.nActual < regla.minActual || l.nBase < regla.minBase || l.actual == null || l.base == null) return null;
  return l.actual >= l.base * regla.factor && l.actual - l.base >= regla.puntos;
}

// Avanza el estado de una vigilancia. Devuelve { estado, avisar }.
// Sin datos suficientes se corta la racha, pero el episodio sigue abierto: una
// madrugada sin mensajes no debe hacer que la misma caída vuelva a sonar.
function avanzar(estado, malo, seguidas) {
  if (malo === null) return { estado: { racha: 0, avisado: estado.avisado }, avisar: false };
  if (!malo) return { estado: { racha: 0, avisado: false }, avisar: false };
  const racha = estado.racha + 1;
  return { estado: { racha, avisado: estado.avisado }, avisar: racha >= seguidas && !estado.avisado };
}

async function avisar(evento) {
  if (!ALERTAS_TOKEN) return false;
  try {
    const res = await fetch(`${ALERTAS_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': ALERTAS_TOKEN },
      body: JSON.stringify({ key: ALERTAS_KEY, node: NODO, severity: 'WARN', ...evento }),
      signal: AbortSignal.timeout(10000)   // si Alertas se cuelga, no se queda esperando
    });
    if (!res.ok) console.error('[metric-alerts] Alertas respondió', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) {
    console.error('[metric-alerts] Alertas', e.message);
    return false;
  }
}

const fmt = n => (n == null ? '—' : Math.round(n * 10) / 10);

function eventoP90(l) {
  return {
    errorType: 'P90 de respuesta elevado',
    message: `El P90 de lo que tarda Camila en responder es ${fmt(l.actual)} s en las últimas ${REGLAS.p90.ventanaHoras} h ` +
      `(límite: ${REGLAS.p90.maxSeg / 60} min; lo normal en 7 días: ${fmt(l.base)} s). ${l.nActual} respuestas.`,
    payload: { p90Seg: fmt(l.actual), limiteSeg: REGLAS.p90.maxSeg, normalSeg: fmt(l.base), respuestas: l.nActual, ventanaHoras: REGLAS.p90.ventanaHoras }
  };
}
function eventoHaiku(l) {
  return {
    errorType: 'Uso de Haiku disparado',
    message: `Haiku respondió el ${fmt(l.actual)}% de los mensajes en la última hora (lo normal en 7 días: ${fmt(l.base)}%). ` +
      `Puede que DeepSeek esté fallando o que se cambió el modelo principal. ${l.nActual} respuestas.`,
    payload: { haikuPct: fmt(l.actual), normalPct: fmt(l.base), respuestas: l.nActual, ventanaHoras: REGLAS.haiku.ventanaHoras }
  };
}

const VIGILANCIAS = [
  { nombre: 'p90', leer: () => leerP90(REGLAS.p90.ventanaHoras), juzgar: juzgarP90, seguidas: REGLAS.p90.seguidas, evento: eventoP90 },
  { nombre: 'haiku', leer: () => leerHaiku(REGLAS.haiku.ventanaHoras), juzgar: juzgarHaiku, seguidas: REGLAS.haiku.seguidas, evento: eventoHaiku }
];
const estados = Object.fromEntries(VIGILANCIAS.map(v => [v.nombre, { racha: 0, avisado: false }]));
const ultimas = {};

// Una pasada: lee, juzga y avisa si toca. Cada vigilancia va por separado para
// que el fallo de una consulta no deje ciega a la otra.
async function revisar() {
  for (const v of VIGILANCIAS) {
    try {
      const lectura = await v.leer();
      const malo = v.juzgar(lectura);
      const { estado, avisar: toca } = avanzar(estados[v.nombre], malo, v.seguidas);
      if (toca) {
        // Si Alertas no responde, no se marca como avisado: se reintenta en la siguiente pasada.
        estado.avisado = await avisar(v.evento(lectura));
        console.log(`[metric-alerts] ${v.nombre} fuera de lo normal`, estado.avisado ? '→ avisado' : '→ sin avisar');
      }
      estados[v.nombre] = estado;
      ultimas[v.nombre] = { ...lectura, malo, racha: estado.racha, avisado: estado.avisado, at: new Date().toISOString() };
      console.log(`[metric-alerts] ${v.nombre} actual=${fmt(lectura.actual)} (n=${lectura.nActual}) normal=${fmt(lectura.base)} (n=${lectura.nBase}) ` +
        `${malo === null ? 'sin datos suficientes' : malo ? `ALTO racha=${estado.racha}` : 'ok'}`);
    } catch (e) {
      console.error(`[metric-alerts] ${v.nombre}`, e.message);
    }
  }
  return ultimas;
}

function start() {
  const mins = Math.max(1, Number(process.env.METRIC_ALERTS_MINUTES || 15));
  // Nunca dos revisiones a la vez: si una se alarga, la siguiente se salta.
  let enCurso = false;
  const tick = async () => {
    if (enCurso) return;
    enCurso = true;
    try { await revisar(); } catch (e) { console.error('[metric-alerts]', e.message); } finally { enCurso = false; }
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, mins * 60 * 1000);
  console.log(`[metric-alerts] vigilando P90 y % Haiku cada ${mins} min` + (ALERTAS_TOKEN ? ` → Alertas (${ALERTAS_KEY})` : ' (sin ALERTAS_TOKEN: solo registra)'));
}

module.exports = { start, revisar, juzgarP90, juzgarHaiku, avanzar, eventoP90, eventoHaiku, leerP90, leerHaiku, REGLAS };
