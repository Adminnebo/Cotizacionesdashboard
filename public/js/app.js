(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const cssvar = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const colors = () => ({ received: cssvar('--received'), sent: cssvar('--sent') });
  let current = null, days = 30;

  const fmtNum = n => (Number(n) || 0).toLocaleString('es-MX');
  function fmtSecs(s) {
    if (s == null) return '—';
    if (s < 90) return Math.round(s) + ' s';
    if (s < 3600) { const m = s / 60; return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' min'; }
    return (s / 3600).toFixed(1) + ' h';
  }
  function relTime(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'hace instantes';
    if (d < 3600) return 'hace ' + Math.floor(d / 60) + ' min';
    if (d < 86400) return 'hace ' + Math.floor(d / 3600) + ' h';
    return 'hace ' + Math.floor(d / 86400) + ' d';
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  }
  const dayLabel = day => { const p = String(day).split('-'); return p.length === 3 ? p[2] + '/' + p[1] : day; };

  function kpi(label, dot, value, sub, muted) {
    return `<div class="kpi ${muted ? 'kpi--muted' : ''}">
      <div class="kpi__label">${dot ? `<span class="kpi__dot" style="background:${dot}"></span>` : ''}${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__sub">${sub || ''}</div></div>`;
  }

  function render() {
    const s = current; if (!s) return;
    const col = colors();
    $('#rangeLabel').textContent = (s.range.days >= 100000 ? 'Todo el histórico' : `Últimos ${s.range.days} días`) + ` · ${s.range.tz}`;

    // KPIs
    const rt = s.responseTime;
    const q = s.quotes || {};
    $('#kpis').innerHTML = [
      kpi('Enviados', col.sent, fmtNum(s.kpi.sent), 'mensajes salientes'),
      kpi('Recibidos', col.received, fmtNum(s.kpi.received), 'mensajes entrantes'),
      kpi('Tiempo de respuesta', '', fmtSecs(rt.medianSecs), `mediana · prom ${fmtSecs(rt.avgSecs)} · p90 ${fmtSecs(rt.p90Secs)}`),
      kpi('Último enviado', '', fmtDateTime(s.kpi.lastSentAt), relTime(s.kpi.lastSentAt)),
      kpi('Conversaciones', '', fmtNum(s.kpi.activeConversations), 'con actividad en el rango'),
      kpi('Cotizaciones', '', q.available ? fmtNum(q.count) : 'Pendiente', q.available ? (q.amount ? 'RD$ ' + fmtNum(Math.round(q.amount)) + ' cotizado' : 'enviadas en el rango') : 'configurar MSSQL', !q.available)
    ].join('');

    // Legends
    const leg = `<span><i style="background:${col.received}"></i>Recibidos</span><span><i style="background:${col.sent}"></i>Enviados</span>`;
    $('#legendDay').innerHTML = leg; $('#legendHour').innerHTML = leg;

    const series = [
      { key: 'received', label: 'Recibidos', color: col.received },
      { key: 'sent', label: 'Enviados', color: col.sent }
    ];
    Charts.lineChart($('#chartDay'), { data: s.byDay.length ? s.byDay : [{ day: '—', sent: 0, received: 0 }], series, xLabel: d => dayLabel(d.day), height: 250 });
    Charts.groupedBar($('#chartHour'), { data: s.byHour, series, xLabel: d => d.hour + 'h', tipLabel: d => String(d.hour).padStart(2, '0') + ':00', height: 230 });

    // hora pico
    const peak = s.byHour.reduce((a, b) => (b.sent + b.received) > (a.sent + a.received) ? b : a, s.byHour[0] || { hour: 0, sent: 0, received: 0 });
    $('#hourNote').textContent = (peak.sent + peak.received) > 0 ? `Pico de actividad: ${String(peak.hour).padStart(2, '0')}:00–${String((peak.hour + 1) % 24).padStart(2, '0')}:00` : 'Sin datos en el rango';

    // tipos enviados
    const types = s.byType || [];
    const maxT = Math.max(1, ...types.map(t => t.n));
    $('#chartType').innerHTML = types.length
      ? types.map(t => `<div class="tbar"><span class="tbar__name">${t.type}</span><div class="tbar__track"><div class="tbar__fill" style="width:${(t.n / maxT) * 100}%"></div></div><span class="tbar__val">${fmtNum(t.n)}</span></div>`).join('')
      : '<p class="card__note">Sin mensajes enviados en el rango.</p>';
  }

  async function load() {
    try {
      const res = await fetch('/api/stats?days=' + days);
      current = await res.json();
      render();
    } catch (e) { $('#kpis').innerHTML = `<div class="kpi kpi--muted"><div class="kpi__value">Error</div><div class="kpi__sub">${e.message}</div></div>`; }
  }

  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); document.body.setAttribute('data-theme', t); try { localStorage.setItem('an_theme', t); } catch (_) {} }

  function init() {
    let t = 'light'; try { t = localStorage.getItem('an_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (_) {}
    applyTheme(t);
    $('#rangeSeg').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $('#rangeSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      b.classList.add('seg--active');
      days = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
      load();
    });
    $('#btnRefresh').addEventListener('click', load);
    $('#btnTheme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      render(); // re-pinta con los colores del tema
    });
    load();
    setInterval(load, 60000); // refresco cada minuto
  }
  document.addEventListener('DOMContentLoaded', init);
})();
