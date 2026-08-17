(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const cssvar = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const colors = () => ({ received: cssvar('--received'), sent: cssvar('--sent') });
  let current = null, days = 30;
  let customFrom = null, customTo = null;
  let msgPage = 1, msgData = null, msgSearch = '', msgSender = 'all', msgChannel = '';
  let logsPage = 1, logsData = null;
  let camilaData = null;
  const ACTION_LABEL = { bot_off: '🔴 Apagó el bot', bot_on: '🟢 Encendió el bot', conv_close: '🔒 Cerró conversación', conv_open: '🔓 Abrió conversación', conv_delete: '🗑️ Eliminó conversación', no_reply: '⏰ Entrante sin respuesta' };

  // Conmutador entre las 3 plataformas (se rellena tras conocer el acceso del usuario).
  const PLATS = [
    { key: 'inbox', label: 'Conversaciones', icon: '💬', url: 'https://whatsapp.neboaiconsulting.com' },
    { key: 'cotizaciones', label: 'Cotizaciones', icon: '📄', url: 'https://panelcotizaciones.neboaiconsulting.com' },
    { key: 'cobranzas', label: 'Cobranzas', icon: '💰', url: 'https://panelcobranzas.neboaiconsulting.com' }
  ];
  function renderPlatSwitcher(current, allowed) {
    const box = $('#platsw'); if (!box) return;
    const puede = k => !Array.isArray(allowed) || !allowed.length || allowed.includes(k);
    box.innerHTML = PLATS.filter(p => p.key === current || puede(p.key)).map(p => {
      const act = p.key === current;
      return act
        ? `<span class="platsw__it platsw__it--on" title="Estás aquí"><span class="platsw__ic">${p.icon}</span>${p.label}</span>`
        : `<a class="platsw__it" href="${p.url}" title="Ir a ${p.label}"><span class="platsw__ic">${p.icon}</span>${p.label}</a>`;
    }).join('');
  }

  // Construye los parámetros de rango: fechas específicas o preset de días.
  function rangeParams() {
    const p = new URLSearchParams();
    if (customFrom || customTo) {
      if (customFrom) p.set('from', new Date(customFrom).toISOString());
      if (customTo) p.set('to', new Date(customTo).toISOString());
    } else {
      p.set('days', String(days));
    }
    return p;
  }

  const fmtNum = n => (Number(n) || 0).toLocaleString('es-MX');
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtCost(v, ccy) {
    if (!v) return '—';
    const dec = v < 1 ? 4 : 2;
    return (ccy || 'USD') + ' ' + Number(v).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtUsd(v, dec) {
    if (v == null) return '—';
    const d = dec || 3;
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtSecs(s) {
    if (s == null) return '—';
    if (s < 90) return Math.round(s) + ' s';
    if (s < 3600) { const m = s / 60; return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' min'; }
    return (s / 3600).toFixed(1) + ' h';
  }
  function fmtExec(secs) {
    if (secs == null) return '—';
    if (secs < 60) { const r = Math.round(secs * 10) / 10; return (Number.isInteger(r) ? r : r.toFixed(1)) + ' s'; }
    return fmtSecs(secs);
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

  function kpi(label, dot, value, sub, muted, cls) {
    return `<div class="kpi ${muted ? 'kpi--muted' : ''} ${cls || ''}">
      <div class="kpi__label">${dot ? `<span class="kpi__dot" style="background:${dot}"></span>` : ''}${label}</div>
      <div class="kpi__value">${value}</div>
      <div class="kpi__sub">${sub || ''}</div></div>`;
  }

  function authHeaders() { return (window.Auth && Auth.currentToken) ? { Authorization: 'Bearer ' + Auth.currentToken } : {}; }

  async function setupAuth() {
    if (!window.Auth) return;
    const btn = document.querySelector('#btnAuth');
    const usersBtn = document.querySelector('#btnUsers');
    try { await Auth.session(); } catch (_) {}      // inicializa
    if (!Auth.configured) { if (btn) btn.hidden = true; return; }
    if (!btn) return;
    btn.hidden = false;
    const s = await Auth.session();
    if (s) { btn.textContent = 'Salir'; btn.title = s.user.email; btn.onclick = () => Auth.signOut(); }
    else { btn.textContent = 'Entrar'; btn.title = 'Iniciar sesión'; btn.onclick = () => (location.href = '/login.html'); }
    if (s) {
      try {
        const me = await (await Auth.fetch('/api/auth/me')).json();
        // Puerta de acceso: si no tiene 'cotizaciones', no entra.
        const plats = me.platforms || [];
        if (Array.isArray(plats) && plats.length && !plats.includes('cotizaciones')) return sinAcceso(plats);
        window.NEBO_ROLE = me.role || null;   // lo usa Ajustes para el bloque de Porcentaje
        renderPlatSwitcher('cotizaciones', plats);   // conmutador de plataformas
        if (usersBtn && ['admin', 'super_admin'].includes(me.role)) usersBtn.hidden = false;
        // Permisos granulares: oculta las pestañas que el agente no tiene y, si la
        // activa quedó oculta, salta a la primera visible.
        if (window.PERMS) {
          PERMS.set(me.permissions); PERMS.aplicar();
          const activa = document.querySelector('.tab.tab--active');
          if (activa && activa.hidden) {
            const primera = document.querySelector('.tab:not([hidden])');
            if (primera) primera.click();
          }
        }
      } catch (_) {}
    }
  }

  function sinAcceso(plats) {
    const dest = { inbox: ['Conversaciones', 'https://whatsapp.neboaiconsulting.com'], cobranzas: ['Panel de cobranzas', 'https://panelcobranzas.neboaiconsulting.com'] };
    const links = (plats || []).filter(p => dest[p]).map(p => `<a class="noacc__link" href="${dest[p][1]}">${dest[p][0]} →</a>`).join('');
    document.body.innerHTML = `<div class="noacc"><div class="noacc__ic">🔒</div><h1>Sin acceso a Cotizaciones</h1><p>Tu usuario no tiene permiso para esta plataforma. Pídeselo a un administrador.</p>${links ? '<div class="noacc__links">' + links + '</div>' : ''}<button class="noacc__out" onclick="window.Auth&&Auth.signOut()">Cerrar sesión</button></div>`;
  }

  function render() {
    const s = current; if (!s) return;
    const col = colors();
    const canCost = s.canSeeCost !== false;   // sin auth (undefined) => visible
    let rlabel;
    if (customFrom || customTo) rlabel = `${(customFrom || '…').replace('T', ' ')} → ${(customTo || 'hoy').replace('T', ' ')}`;
    else rlabel = (days === 'all' || Number(days) >= 100000) ? 'Todo el histórico' : `Últimos ${days} días`;
    $('#rangeLabel').textContent = rlabel + ` · ${s.range.tz}`;

    // KPIs
    const rt = s.responseTime;
    const ex = s.execTime || {};
    const ai = s.aiCost || {};
    const bl = s.billing || {};
    const q = s.quotes || {};
    const kpis = [
      kpi('Enviados', col.sent, fmtNum(s.kpi.sent), 'mensajes salientes'),
      kpi('Recibidos', col.received, fmtNum(s.kpi.received), 'mensajes entrantes'),
      kpi('Tiempo de respuesta', '', fmtSecs(rt.medianSecs), `mediana · prom ${fmtSecs(rt.avgSecs)} · p90 ${fmtSecs(rt.p90Secs)}`)
    ];
    if (canCost) {   // costes reales solo super_admin; si no, se ocultan (no aparecen)
      kpis.push(
        kpi('Coste prom/mensaje', '', ai.runs ? fmtUsd(ai.totalUsd / ai.runs) : '—', ai.runs ? `promedio IA sobre ${fmtNum(ai.runs)} runs` : 'sin datos aún', !ai.runs),
        kpi('Consumo IA', '', ai.runs ? fmtUsd(ai.totalUsd) : '—', ai.runs ? `${fmtNum(ai.runs)} runs · ${(ai.byModel || []).map(m => `${m.model}: ${fmtUsd(m.usd)}`).join(' · ')}` : 'sin datos aún', !ai.runs)
      );
    }
    kpis.push(
      kpi('Cobrado al cliente', '', bl.total != null ? fmtUsd(bl.total, 2) : '—', `${fmtNum(s.kpi.sent)} msg × ${fmtUsd(bl.perOut || 0, 2)}`),
      kpi('Último enviado', '', fmtDateTime(s.kpi.lastSentAt), relTime(s.kpi.lastSentAt), false, 'kpi--sm'),
      kpi('Conversaciones', '', fmtNum(s.kpi.activeConversations), 'con actividad en el rango'),
      kpi('Cotizaciones', '', q.available ? fmtNum(q.count) : 'Pendiente', q.available ? (q.amount ? 'RD$ ' + fmtNum(Math.round(q.amount)) + ' cotizado' : 'enviadas en el rango') : 'configurar MSSQL', !q.available)
    );
    const kpisEl = $('#kpis');
    kpisEl.innerHTML = kpis.join('');
    kpisEl.className = 'kpis' + (canCost ? '' : ' kpis--7');   // 9 KPIs (5/4) vs 7 (4/3)

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

  function msgCell(text, type) {
    if (text) return escapeHtml(text);
    const t = String(type || 'text').toLowerCase();
    const label = t === 'image' ? '🖼️ imagen'
      : (t === 'audio' || t === 'voice' || t === 'ptt') ? '🎤 audio'
      : t === 'video' ? '🎬 video'
      : t === 'document' ? '📎 documento'
      : t === 'sticker' ? '🏷️ sticker' : '—';
    return `<span class="dim">${label}</span>`;
  }

  function sentByCell(name) {
    if (!name) return '<span class="dim">—</span>';
    const bot = String(name).trim().toLowerCase() === 'camila';
    return `<span class="${bot ? 'dim' : 'msgs__human'}">${bot ? '🤖' : '👤'} ${escapeHtml(name)}</span>`;
  }

  // % de ganancia/pérdida por mensaje (solo super_admin; verde gana, rojo pierde).
  function marginCell(p) {
    if (p == null) return '<span class="dim">—</span>';
    const v = Number(p);
    const cls = v >= 0 ? 'msgs__gain' : 'msgs__loss';
    const sign = v > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${v.toFixed(0)}%</span>`;
  }

  // Recap de ganancia/pérdida del rango COMPLETO (no solo la página). Solo super_admin.
  function renderMarginRecap(d) {
    const box = $('#msgsRecap');
    if (!box) return;
    const r = d.marginRecap;
    if (!r || d.canSeeMargin === false) { box.hidden = true; box.innerHTML = ''; return; }
    const ccy = (d.cost && d.cost.currency) || 'USD';
    const gana = (Number(r.profit) || 0) >= 0;
    const cls = gana ? 'msgs__gain' : 'msgs__loss';
    const pct = r.profitPct == null ? '—' : (r.profitPct > 0 ? '+' : '') + Number(r.profitPct).toFixed(0) + '%';
    box.hidden = false;
    box.innerHTML = `
      <span class="msgs-recap__tag">Solo super admin</span>
      <span class="msgs-recap__item"><b>Coste IA total</b> ${fmtUsd(r.cost)}</span>
      <span class="msgs-recap__item"><b>Cobrado total</b> ${fmtCost(r.charged, ccy)}</span>
      <span class="msgs-recap__item msgs-recap__net ${cls}">
        <b>${gana ? 'Ganancia' : 'Pérdida'} del rango</b> ${fmtCost(r.profit, ccy)} <span class="msgs-recap__pct ${cls}">(${pct})</span>
      </span>`;
  }

  const CHANNELS = {
    whatsapp:   { label: 'WhatsApp',    icon: '💬' },
    instagram:  { label: 'Instagram',   icon: '📸' },
    facebook:   { label: 'Facebook',    icon: '📘' },
    pagina_web: { label: 'Página web',  icon: '🌐' }
  };

  function chanCell(ch) {
    const key = String(ch || '').toLowerCase();
    const meta = CHANNELS[key];
    if (!meta) return `<span class="dim">${escapeHtml(ch || '—')}</span>`;
    return `<span class="chip chip--${key}">${meta.icon} ${meta.label}</span>`;
  }

  function renderMessages() {
    const d = msgData; if (!d) return;
    const tbl = $('#msgsTable');
    if (tbl) {
      tbl.classList.toggle('msgs--nocost', d.canSeeCost === false);       // oculta col Coste IA
      tbl.classList.toggle('msgs--nomodel', d.canSeeCost === false);      // oculta col Modelo (dato interno)
      tbl.classList.toggle('msgs--nomargin', d.canSeeMargin === false);   // oculta col Ganancia (no super admin)
    }
    renderMarginRecap(d);
    const body = $('#msgsBody');
    if (!d.items.length) {
      body.innerHTML = `<tr><td colspan="12" class="msgs__empty">Sin intercambios en el rango.</td></tr>`;
    } else {
      body.innerHTML = d.items.map(m => `<tr>
        <td class="nowrap">${fmtDateTime(m.inAt || m.outAt)}</td>
        <td class="nowrap">${m.phone ? escapeHtml(m.phone) : '<span class="dim">—</span>'}${m.name ? `<div class="msgs__name">${escapeHtml(m.name)}</div>` : ''}</td>
        <td class="nowrap">${chanCell(m.channel)}</td>
        <td class="msgs__in"><span class="msgs__text">${msgCell(m.inText, m.inType)}</span></td>
        <td class="msgs__out"><span class="msgs__text">${msgCell(m.outText, m.outType)}</span></td>
        <td class="nowrap">${sentByCell(m.sentBy)}</td>
        <td class="num">${m.execSecs != null ? fmtExec(m.execSecs) : '<span class="dim">—</span>'}</td>
        <td class="cap">${m.model ? escapeHtml(m.model) : '<span class="dim">—</span>'}</td>
        <td class="num">${m.costUsd != null ? fmtUsd(m.costUsd) : '<span class="dim">—</span>'}</td>
        <td class="num">${fmtCost(m.cost, d.cost.currency)}</td>
        <td class="num">${marginCell(m.marginPct)}</td>
        <td class="cap dim">${escapeHtml(m.status || '—')}</td>
      </tr>`).join('');
    }
    // paginador
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const first = d.total ? (d.page - 1) * d.limit + 1 : 0;
    const last = Math.min(d.page * d.limit, d.total);
    $('#msgsPager').innerHTML = `
      <span>${fmtNum(first)}–${fmtNum(last)} de ${fmtNum(d.total)} intercambios</span>
      <div class="pager__btns">
        <button class="pgbtn" data-pg="prev" ${d.page <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span class="pager__n">Pág. ${d.page} / ${pages}</span>
        <button class="pgbtn" data-pg="next" ${d.page >= pages ? 'disabled' : ''}>Siguiente →</button>
      </div>`;
    const rateNote = d.cost.out
      ? `Coste por respuesta a tarifa ${fmtCost(d.cost.out, d.cost.currency)}.`
      : 'Coste sin tarifa configurada (MSG_COST_OUT).';
    $('#msgsNote').textContent = rateNote + ' Cada fila empareja un mensaje entrante del cliente con la respuesta del bot; "Ejecución" es el tiempo que tardó el bot en generar la respuesta (por run).';
  }

  async function loadMessages() {
    try {
      const params = rangeParams();
      params.set('page', String(msgPage));
      params.set('limit', '50');
      if (msgSearch) params.set('search', msgSearch);
      if (msgSender !== 'all') params.set('sender', msgSender);
      if (msgChannel) params.set('channel', msgChannel);
      const res = await fetch('/api/messages?' + params.toString(), { headers: authHeaders() });
      msgData = await res.json();
      renderMessages();
    } catch (e) {
      $('#msgsBody').innerHTML = `<tr><td colspan="12" class="msgs__empty">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderLogs() {
    const d = logsData; if (!d) return;
    const body = $('#logsBody');
    if (!d.items.length) body.innerHTML = '<tr><td colspan="5" class="msgs__empty">Sin acciones en el rango.</td></tr>';
    else body.innerHTML = d.items.map(l => `<tr>
      <td class="nowrap">${fmtDateTime(l.at)}</td>
      <td class="nowrap">${l.actor ? '👤 ' + escapeHtml(l.actor) : '<span class="dim">—</span>'}</td>
      <td class="nowrap">${ACTION_LABEL[l.action] || escapeHtml(l.action)}</td>
      <td class="nowrap">${l.contact ? escapeHtml(l.contact) : '<span class="dim">—</span>'}</td>
      <td class="dim">${l.detail ? escapeHtml(l.detail) : '—'}</td>
    </tr>`).join('');
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    const first = d.total ? (d.page - 1) * d.limit + 1 : 0;
    const last = Math.min(d.page * d.limit, d.total);
    $('#logsPager').innerHTML = `
      <span>${fmtNum(first)}–${fmtNum(last)} de ${fmtNum(d.total)} acciones</span>
      <div class="pager__btns">
        <button class="pgbtn" data-pg="prev" ${d.page <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span class="pager__n">Pág. ${d.page} / ${pages}</span>
        <button class="pgbtn" data-pg="next" ${d.page >= pages ? 'disabled' : ''}>Siguiente →</button>
      </div>`;
  }
  async function loadLogs() {
    try {
      const params = rangeParams(); params.set('page', String(logsPage)); params.set('limit', '50');
      const res = await fetch('/api/logs?' + params.toString(), { headers: authHeaders() });
      logsData = await res.json();
      renderLogs();
    } catch (e) { $('#logsBody').innerHTML = `<tr><td colspan="5" class="msgs__empty">Error: ${escapeHtml(e.message)}</td></tr>`; }
  }

  // ── Eficiencia de Camila (ejecuciones de n8n) ──────────────────────────────
  const pctTxt = e => e == null ? '—' : (e * 100).toFixed(1) + '%';
  // >=95% bien · 85–95% atención · <85% mal (colores de estado).
  const effClass = e => e == null ? 'na' : e >= 0.95 ? 'good' : e >= 0.85 ? 'warn' : 'bad';
  const folderChip = f => f === 'WhatsApp' ? 'chip--whatsapp' : 'chip--pagina_web';

  // Rango PROPIO de la tarjeta (barra arrastrable), independiente del selector
  // global de arriba: cambiarla NO afecta al resto de métricas ni al revés.
  const CAM_DAY = 86400000;
  let camInited = false, camDrag = null, camDetail = false;   // camDetail: vista detallada (solo super admin)
  let camDomA = 0, camDomB = 0, camFrom = 0, camTo = 0;   // dominio y selección (ms)
  const camFmtDay = ms => new Date(ms).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  const camDaysBetween = (a, b) => Math.max(1, Math.round((b - a) / CAM_DAY));
  const camSnap = ms => Math.round(ms / CAM_DAY) * CAM_DAY;   // ajusta a día

  function camRangeParams() {
    const p = new URLSearchParams();
    if (camInited) { p.set('from', new Date(camFrom).toISOString()); p.set('to', new Date(camTo).toISOString()); }
    else p.set('days', '30');
    return p;
  }

  function camInitSlider(d) {
    const horizon = (d.horizonDays || 120) * CAM_DAY, now = Date.now();
    camDomA = camSnap(d.oldestAt ? Math.max(Date.parse(d.oldestAt), now - horizon) : now - horizon);
    camDomB = camSnap(now) + CAM_DAY;                        // fin inclusivo (hasta hoy)
    camTo = camDomB;
    camFrom = Math.max(camDomA, camSnap(now - 30 * CAM_DAY)); // por defecto: últimos 30 días
    camInited = true;
    $('#camilaRange').hidden = false;
    camRenderTicks(); camRenderSlider();
  }

  function camRenderTicks() {
    const box = $('#camilaTicks'); if (!box) return;
    const n = 4, out = [];
    for (let i = 0; i <= n; i++) out.push(`<span>${camFmtDay(camDomA + (camDomB - camDomA) * i / n)}</span>`);
    box.innerHTML = out.join('');
  }
  const camPct = ms => camDomB > camDomA ? ((ms - camDomA) / (camDomB - camDomA)) * 100 : 0;

  function camRenderSlider() {
    const h0 = $('#camilaH0'), h1 = $('#camilaH1'), sel = $('#camilaSel'), lbl = $('#camilaRangeLbl');
    if (!h0) return;
    const a = camPct(camFrom), b = camPct(camTo);
    h0.style.left = a + '%'; h1.style.left = b + '%';
    sel.style.left = a + '%'; sel.style.width = (b - a) + '%';
    if (lbl) lbl.textContent = `${camFmtDay(camFrom)} → ${camFmtDay(camTo - CAM_DAY)} · ${camDaysBetween(camFrom, camTo)} días`;
  }
  function camPosToMs(clientX) {
    const r = $('#camilaSlider').getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return camSnap(camDomA + frac * (camDomB - camDomA));
  }
  function camOnMove(ev) {
    if (!camDrag) return;
    const ms = camPosToMs(ev.clientX);
    if (camDrag.mode === 'start') camFrom = Math.min(Math.max(camDomA, ms), camTo - CAM_DAY);
    else if (camDrag.mode === 'end') camTo = Math.max(Math.min(camDomB, ms), camFrom + CAM_DAY);
    else {                                                   // 'band': mueve todo el rango
      const width = camDrag.to0 - camDrag.from0;
      let nf = camDrag.from0 + (ms - camDrag.grab), nt = nf + width;
      if (nf < camDomA) { nf = camDomA; nt = nf + width; }
      if (nt > camDomB) { nt = camDomB; nf = nt - width; }
      camFrom = nf; camTo = nt;
    }
    camRenderSlider();
  }
  function camOnUp() {
    if (!camDrag) return;
    camDrag = null;
    document.removeEventListener('pointermove', camOnMove);
    document.removeEventListener('pointerup', camOnUp);
    loadCamila();                                            // recarga SOLO la tarjeta al soltar
  }
  function camStart(mode, ev) {
    if (!camInited) return;
    ev.preventDefault();
    $('#camilaPresets').querySelectorAll('.cam-preset').forEach(x => x.classList.remove('cam-preset--on'));
    camDrag = { mode, grab: camPosToMs(ev.clientX), from0: camFrom, to0: camTo };
    document.addEventListener('pointermove', camOnMove);
    document.addEventListener('pointerup', camOnUp);
  }

  function camRow(nameHtml, e) {
    const c = effClass(e.eff), width = e.eff == null ? 0 : Math.round(e.eff * 100);
    return `<div class="camila__row">
      <div class="camila__wf">${nameHtml}</div>
      <div class="camila__bar"><div class="camila__barfill camila__barfill--${c}" style="width:${width}%"></div></div>
      <div class="camila__nums"><b class="camila__eff--${c}">${pctTxt(e.eff)}</b> <span class="dim">${fmtNum(e.total)} ejec · ${fmtNum(e.failed)} fall.</span></div>
    </div>`;
  }

  function renderCamila() {
    const d = camilaData, body = $('#camilaBody'); if (!body || !d) return;
    const upd = $('#camilaUpdated'), note = $('#camilaNote'), seg = $('#camilaViewSeg');
    if (d.available === false) {
      body.innerHTML = `<p class="card__note">Métrica no disponible: ${escapeHtml(d.error || 'n8n no configurado')}.</p>`;
      if (upd) upd.textContent = ''; if (note) note.textContent = ''; if (seg) seg.hidden = true; return;
    }
    // El toggle detallado es SOLO para super_admin; el cliente ve siempre lo agrupado.
    if (seg) seg.hidden = !d.canDetail;
    if (!d.canDetail) camDetail = false;
    const detailed = camDetail && d.canDetail && Array.isArray(d.byWorkflow);

    const p = d.overall.prod, test = d.overall.test;
    const cls = effClass(p.eff);
    const hero = `<div class="camila__hero">
        <div class="camila__big camila__big--${cls}">${pctTxt(p.eff)}<span class="camila__biglbl">eficiencia · producción</span></div>
        <div class="camila__tiles">
          <div class="camila__tile"><span class="camila__tnum">${fmtNum(p.total)}</span><span class="camila__tlbl">ejecuciones</span></div>
          <div class="camila__tile"><span class="camila__tnum camila__tnum--fail">${fmtNum(p.failed)}</span><span class="camila__tlbl">fallidas</span></div>
          ${test.total ? `<div class="camila__tile"><span class="camila__tnum">${pctTxt(test.eff)}</span><span class="camila__tlbl">test · ${fmtNum(test.total)} ejec</span></div>` : ''}
        </div>
      </div>`;
    let rows;
    if (detailed) {
      rows = d.byWorkflow.map(w => camRow(
        `<span class="chip ${folderChip(w.folder)}">${escapeHtml(w.folder)}</span><span class="camila__wfname">${escapeHtml(w.name)}</span>`, w.prod)).join('');
    } else {
      rows = (d.byFolder || []).map(f => camRow(
        `<span class="chip ${folderChip(f.folder)} camila__botchip">${escapeHtml(f.folder)}</span>`, f.prod)).join('');
    }
    body.innerHTML = hero + `<div class="camila__list">${rows}</div>`;
    if (upd) upd.textContent = d.updatedAt ? ('actualizado ' + relTime(d.updatedAt)) : (d.syncing ? 'sincronizando…' : '');
    if (note) note.textContent = (d.warning ? '⚠️ ' + d.warning + '. ' : '') +
      'Eficiencia = ejecuciones exitosas ÷ terminadas (en n8n), sobre los flujos de procesamiento de Camila (WhatsApp bot + IG/FB/WEB). No incluye el trigger de WhatsApp (eventos de Meta) ni ejecuciones en curso.' +
      (detailed ? '' : ' Vista general por bot.');
  }

  async function loadCamila() {
    try {
      const res = await fetch('/api/camila-eficiencia?' + camRangeParams().toString(), { headers: authHeaders() });
      camilaData = await res.json();
    } catch (e) { camilaData = { available: false, error: e.message }; }
    if (!camInited && camilaData && camilaData.available !== false) camInitSlider(camilaData);
    renderCamila();
  }

  async function load() {
    try {
      const res = await fetch('/api/stats?' + rangeParams().toString(), { headers: authHeaders() });
      current = await res.json();
      render();
      loadLogs();
      loadCamila();
    } catch (e) { $('#kpis').innerHTML = `<div class="kpi kpi--muted"><div class="kpi__value">Error</div><div class="kpi__sub">${e.message}</div></div>`; }
  }

  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); document.body.setAttribute('data-theme', t); try { localStorage.setItem('an_theme', t); } catch (_) {} }

  function init() {
    let t = 'light'; try { t = localStorage.getItem('an_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (_) {}
    applyTheme(t);
    renderPlatSwitcher('cotizaciones', null);   // por defecto muestra las 3; /me lo refina
    if (window.Pipeline) Pipeline.init();
    if (window.Quotes) Quotes.init({ rangeParams, authHeaders });
    if (window.Calls) Calls.init({ rangeParams, authHeaders });
    if (window.Settings) Settings.init({ authHeaders });
    $('#rangeSeg').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $('#rangeSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      b.classList.add('seg--active');
      days = b.dataset.days === 'all' ? 'all' : Number(b.dataset.days);
      customFrom = customTo = null;                       // preset cancela rango custom
      $('#dateFrom').value = ''; $('#dateTo').value = ''; $('#dateClear').hidden = true;
      msgPage = 1;
      load(); loadMessages();
      if (window.Quotes) Quotes.refreshIfVisible();
      if (window.Calls) Calls.refreshIfVisible();
    });
    $('#dateApply').addEventListener('click', () => {
      const f = $('#dateFrom').value, t = $('#dateTo').value;
      if (!f && !t) return;
      customFrom = f || null; customTo = t || null;
      $('#rangeSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      $('#dateClear').hidden = false;
      msgPage = 1;
      load(); loadMessages();
      if (window.Quotes) Quotes.refreshIfVisible();
      if (window.Calls) Calls.refreshIfVisible();
    });
    $('#dateClear').addEventListener('click', () => {
      customFrom = customTo = null;
      $('#dateFrom').value = ''; $('#dateTo').value = ''; $('#dateClear').hidden = true;
      days = 30;
      $('#rangeSeg').querySelectorAll('.seg').forEach(x => x.classList.toggle('seg--active', x.dataset.days === '30'));
      msgPage = 1;
      load(); loadMessages();
      if (window.Quotes) Quotes.refreshIfVisible();
      if (window.Calls) Calls.refreshIfVisible();
    });
    $('#tabs').addEventListener('click', e => {
      const b = e.target.closest('.tab'); if (!b) return;
      $('#tabs').querySelectorAll('.tab').forEach(x => x.classList.remove('tab--active'));
      b.classList.add('tab--active');
      const t = b.dataset.tab;
      $('#tabResumen').hidden = t !== 'resumen';
      $('#tabMensajes').hidden = t !== 'mensajes';
      $('#tabPipeline').hidden = t !== 'pipeline';
      $('#tabCotizaciones').hidden = t !== 'cotizaciones';
      $('#tabLlamadas').hidden = t !== 'llamadas';
      $('#tabRegistros').hidden = t !== 'registros';
      $('#tabAjustes').hidden = t !== 'ajustes';
      if (t === 'registros') { logsPage = 1; loadLogs(); }
      if (t === 'pipeline' && window.Pipeline) Pipeline.load();
      if (t === 'cotizaciones' && window.Quotes) Quotes.load();
      if (t === 'llamadas' && window.Calls) Calls.load();
      if (t === 'ajustes' && window.Settings) Settings.load();
    });
    $('#logsPager').addEventListener('click', e => {
      const b = e.target.closest('.pgbtn'); if (!b || b.disabled) return;
      logsPage += b.dataset.pg === 'next' ? 1 : -1;
      if (logsPage < 1) logsPage = 1;
      loadLogs();
    });
    $('#msgsPager').addEventListener('click', e => {
      const b = e.target.closest('.pgbtn'); if (!b || b.disabled) return;
      msgPage += b.dataset.pg === 'next' ? 1 : -1;
      if (msgPage < 1) msgPage = 1;
      loadMessages();
    });
    let searchTimer = null;
    $('#msgSearch').addEventListener('input', e => {
      const v = e.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { msgSearch = v; msgPage = 1; loadMessages(); }, 350);
    });
    $('#senderSeg').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $('#senderSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      b.classList.add('seg--active');
      msgSender = b.dataset.sender; msgPage = 1;
      loadMessages();
    });
    $('#chanSel').addEventListener('change', e => {
      msgChannel = e.target.value; msgPage = 1;
      loadMessages();
    });
    $('#btnRefresh').addEventListener('click', () => { load(); loadMessages(); });
    // Barra de fechas propia de la tarjeta de Camila (arrastre de extremos y del rango).
    $('#camilaH0').addEventListener('pointerdown', e => camStart('start', e));
    $('#camilaH1').addEventListener('pointerdown', e => camStart('end', e));
    $('#camilaSel').addEventListener('pointerdown', e => camStart('band', e));
    $('#camilaPresets').addEventListener('click', e => {
      const b = e.target.closest('.cam-preset'); if (!b || !camInited) return;
      $('#camilaPresets').querySelectorAll('.cam-preset').forEach(x => x.classList.remove('cam-preset--on'));
      b.classList.add('cam-preset--on');
      camTo = camDomB;
      camFrom = b.dataset.d === 'all' ? camDomA : Math.max(camDomA, camSnap(Date.now() - Number(b.dataset.d) * CAM_DAY));
      camRenderSlider(); loadCamila();
    });
    // Toggle "Por bot / Detallado" (solo se muestra al super admin).
    $('#camilaViewSeg').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $('#camilaViewSeg').querySelectorAll('.seg').forEach(x => x.classList.remove('seg--active'));
      b.classList.add('seg--active');
      camDetail = b.dataset.view === 'detail';
      renderCamila();
    });
    $('#btnTheme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      render(); // re-pinta con los colores del tema
      renderMessages();
    });
    (async () => {
      if (window.Auth) { const s = await Auth.requireSession(); if (!s) return; } // exige sesión
      await setupAuth();
      load(); loadMessages();
      if (window.Quotes) Quotes.refreshIfVisible();
      if (window.Calls) Calls.refreshIfVisible();
    })();
    setInterval(() => { load(); loadMessages(); }, 60000); // refresco cada minuto
  }
  document.addEventListener('DOMContentLoaded', init);
})();
