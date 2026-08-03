/* =========================================================
   settings.js — Pestaña "Ajustes".
   Por ahora: elegir qué agente de voz atiende las llamadas del número.
   Habla con el propio panel (/api/agents), que proxea el servicio de
   phone-switch — la API key vive en el servidor, nunca acá.
   Expone window.Settings = { init, load }.
   ========================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  let deps = null;            // { authHeaders }
  let data = null;            // { available, agents, phoneNumbers }
  let guardando = false;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Número seleccionado en la interfaz (si hay más de uno).
  let numSel = null;
  const numActual = () => {
    const nums = (data && data.phoneNumbers) || [];
    return nums.find(n => String(n.id) === String(numSel)) || nums[0] || null;
  };

  function render() {
    const box = $('#agBox');
    if (!data) { box.innerHTML = '<p class="muted">Cargando…</p>'; return; }

    if (!data.available) {
      box.innerHTML = `<div class="ag__err">No se pudo consultar el servicio de agentes.<br><span class="muted small">${esc(data.error || '')}</span></div>`;
      return;
    }

    const agentes = data.agents || [];
    const nums = data.phoneNumbers || [];
    if (!nums.length) {
      box.innerHTML = '<div class="ag__err">La cuenta no tiene números configurados.</div>';
      return;
    }

    const num = numActual();
    const actualId = num ? num.currentAgentId : null;

    // Selector de número solo si hay más de uno.
    const selNum = nums.length > 1
      ? `<div class="ag__field">
           <label for="agNum">Número</label>
           <select id="agNum" class="chan-select">
             ${nums.map(n => `<option value="${esc(n.id)}" ${String(n.id) === String(num && num.id) ? 'selected' : ''}>
               ${esc(n.phoneNumber || n.id)}${n.friendlyName ? ' · ' + esc(n.friendlyName) : ''}
             </option>`).join('')}
           </select>
         </div>`
      : '';

    box.innerHTML = `
      <div class="ag__now">
        <div>
          <div class="ag__now-lbl">Número</div>
          <div class="ag__now-val">${esc(num.phoneNumber || '—')}${num.friendlyName ? ` <span class="muted">· ${esc(num.friendlyName)}</span>` : ''}</div>
        </div>
        <div>
          <div class="ag__now-lbl">Agente asignado ahora</div>
          <div class="ag__now-val">${num.currentAgentName ? esc(num.currentAgentName) : '<span class="muted">Sin agente</span>'}</div>
        </div>
      </div>

      ${selNum}

      <div class="ag__field">
        <label for="agSel">Cambiar a</label>
        <select id="agSel" class="chan-select">
          ${agentes.map(a => `<option value="${esc(a.id)}" ${a.id === actualId ? 'selected' : ''}>
            ${esc(a.name)}${a.connected ? '' : ' (desconectado)'}
          </option>`).join('')}
          <option value="">— Sin agente (desasignar) —</option>
        </select>
      </div>

      <div class="ag__actions">
        <button class="q__btn ag__save" id="agSave" ${guardando ? 'disabled' : ''}>${guardando ? 'Guardando…' : 'Guardar'}</button>
        <span id="agMsg" class="ag__msg"></span>
      </div>`;
  }

  function msg(texto, tipo) {
    const el = $('#agMsg');
    if (!el) return;
    el.textContent = texto || '';
    el.className = 'ag__msg' + (tipo ? ' ag__msg--' + tipo : '');
  }

  async function load() {
    try {
      const res = await fetch('/api/agents', { headers: deps.authHeaders() });
      data = await res.json();
      if (!numSel && data && data.phoneNumbers && data.phoneNumbers[0]) numSel = data.phoneNumbers[0].id;
      render();
    } catch (e) {
      data = { available: false, error: e.message };
      render();
    }
    loadPercent();   // el bloque de Porcentaje (solo super_admin)
  }

  // ---------- Agentes → modelos con porcentaje (solo super_admin) ----------
  const esSuper = () => window.NEBO_ROLE === 'super_admin';
  let agentes = [];                 // [{ id, name, slug, models:[{id,name,slug,percent}] }]
  const abiertos = new Set();       // ids de agentes desplegados (persiste entre renders)

  async function loadPercent() {
    const card = $('#pctCard');
    if (!card) return;
    if (!esSuper()) { card.hidden = true; return; }   // los demás ni lo ven
    card.hidden = false;
    try {
      const r = await fetch('/api/porcentaje', { headers: deps.authHeaders() });
      const d = await r.json();
      agentes = (d && d.agents) || [];
      renderAgentes();
    } catch (e) { pctMsg(e.message, 'err'); }
  }

  function renderAgentes() {
    const box = $('#pctList');
    if (!box) return;
    if (!agentes.length) { box.innerHTML = '<p class="muted small">Aún no hay agentes. Crea el primero abajo.</p>'; return; }
    box.innerHTML = agentes.map(a => {
      const open = abiertos.has(a.id);
      const modelos = a.models.map(m => `
        <div class="md-item" data-model="${esc(m.id)}">
          <span class="md-name" title="GET /api/porcentaje?agent=${esc(a.slug)}&model=${esc(m.slug)}">${esc(m.name)}</span>
          <input type="number" class="pct__input md-val" step="0.01" min="0" value="${esc(m.percent)}" />
          <span class="pct__sign">%</span>
          <button class="q__btn md-save" data-act="mdsave">Guardar</button>
          <button class="pct__item-del" data-act="mddel" title="Eliminar modelo">✕</button>
        </div>`).join('');
      return `
      <div class="ag-item ${open ? 'ag-item--open' : ''}" data-agent="${esc(a.id)}">
        <div class="ag-head" data-act="toggle">
          <span class="ag-caret">${open ? '▾' : '▸'}</span>
          <span class="ag-name">${esc(a.name)}</span>
          <span class="ag-count">${a.models.length} modelo${a.models.length === 1 ? '' : 's'}</span>
          <button class="pct__item-del" data-act="agdel" title="Eliminar agente">✕</button>
        </div>
        <div class="ag-body" ${open ? '' : 'hidden'}>
          <div class="md-list">${modelos || '<p class="muted small" style="margin:4px 0 8px">Sin modelos todavía.</p>'}</div>
          <div class="md-add">
            <input type="text" class="pct__name md-new-name" maxlength="60" placeholder="Modelo (ej. Deepseek)" />
            <input type="number" class="pct__input md-new-val" step="0.01" min="0" placeholder="0" />
            <span class="pct__sign">%</span>
            <button class="q__btn md-add-btn" data-act="mdadd">Añadir modelo</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function pctMsg(texto, tipo) {
    const el = $('#pctMsg');
    if (!el) return;
    el.textContent = texto || '';
    el.className = 'ag__msg' + (tipo ? ' ag__msg--' + tipo : '');
  }

  async function api(path, method, body) {
    const opts = { method, headers: deps.authHeaders() };
    if (body) { opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers); opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) throw new Error((d && d.error) || 'Error ' + r.status);
    return d;
  }

  // ---- agentes ----
  async function añadirAgente() {
    const name = ($('#pctNewAgent').value || '').trim();
    if (!name) { pctMsg('Escribe el nombre del agente', 'err'); return; }
    const btn = $('#pctAddAgent'); if (btn) btn.disabled = true;
    pctMsg('Creando…');
    try {
      const d = await api('/api/porcentaje/agente', 'POST', { name });
      $('#pctNewAgent').value = '';
      if (d.agent) abiertos.add(d.agent.id);     // lo dejamos desplegado para añadir modelos
      pctMsg('Agente creado ✓', 'ok');
      await loadPercent();
    } catch (e) { pctMsg(e.message, 'err'); }
    finally { if (btn) btn.disabled = false; }
  }
  async function borrarAgente(id) {
    const a = agentes.find(x => x.id === id);
    if (!confirm('¿Eliminar el agente "' + (a ? a.name : '') + '" y todos sus modelos?')) return;
    pctMsg('Eliminando…');
    try { await api('/api/porcentaje/agente?id=' + encodeURIComponent(id), 'DELETE'); abiertos.delete(id); pctMsg('Eliminado ✓', 'ok'); await loadPercent(); }
    catch (e) { pctMsg(e.message, 'err'); }
  }

  // ---- modelos ----
  async function añadirModelo(agItem) {
    const agentId = agItem.dataset.agent;
    const name = (agItem.querySelector('.md-new-name').value || '').trim();
    const val = Number(agItem.querySelector('.md-new-val').value);
    if (!name) { pctMsg('Escribe el nombre del modelo', 'err'); return; }
    if (!Number.isFinite(val) || val < 0) { pctMsg('Porcentaje inválido (≥ 0)', 'err'); return; }
    pctMsg('Guardando…');
    try { await api('/api/porcentaje/modelo', 'POST', { agentId, name, percent: val }); abiertos.add(agentId); pctMsg('Modelo añadido ✓', 'ok'); await loadPercent(); }
    catch (e) { pctMsg(e.message, 'err'); }
  }
  async function guardarModelo(mdItem, agentId) {
    const id = mdItem.dataset.model;
    const val = Number(mdItem.querySelector('.md-val').value);
    const ag = agentes.find(a => a.id === agentId);
    const name = ((ag && ag.models.find(m => m.id === id)) || {}).name;
    if (!Number.isFinite(val) || val < 0) { pctMsg('Valor inválido', 'err'); return; }
    pctMsg('Guardando…');
    try { abiertos.add(agentId); await api('/api/porcentaje/modelo', 'POST', { id, name, percent: val }); pctMsg('Guardado ✓', 'ok'); await loadPercent(); }
    catch (e) { pctMsg(e.message, 'err'); }
  }
  async function borrarModelo(mdItem, agentId) {
    const id = mdItem.dataset.model;
    if (!confirm('¿Eliminar este modelo?')) return;
    pctMsg('Eliminando…');
    try { abiertos.add(agentId); await api('/api/porcentaje/modelo?id=' + encodeURIComponent(id), 'DELETE'); pctMsg('Eliminado ✓', 'ok'); await loadPercent(); }
    catch (e) { pctMsg(e.message, 'err'); }
  }

  async function guardar() {
    const sel = $('#agSel');
    if (!sel) return;
    const num = numActual();
    const body = { agentId: sel.value };                      // '' = desasignar
    if (num && (data.phoneNumbers || []).length > 1) body.phoneNumberId = num.id;

    guardando = true; render(); msg('');
    try {
      const res = await fetch('/api/agents/select', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, deps.authHeaders()),
        body: JSON.stringify(body)
      });
      const d = await res.json().catch(() => null);
      guardando = false;
      if (!res.ok || !d || d.error) {
        await load();
        msg((d && d.error) || 'No se pudo cambiar el agente', 'err');
        return;
      }
      await load();                                            // refresca el estado real
      msg(d.message || 'Agente actualizado', 'ok');
    } catch (e) {
      guardando = false;
      render();
      msg(e.message, 'err');
    }
  }

  function init(ctx) {
    deps = ctx;
    $('#agRefresh').addEventListener('click', () => { msg(''); load(); });
    // Delegación: el contenido se re-renderiza, así que escuchamos en el contenedor.
    $('#agBox').addEventListener('click', e => {
      if (e.target.closest('#agSave')) guardar();
    });
    $('#agBox').addEventListener('change', e => {
      if (e.target.id === 'agNum') { numSel = e.target.value; msg(''); render(); }
    });
    // Agentes y modelos (solo super_admin; la tarjeta puede estar oculta)
    const addAg = $('#pctAddAgent');
    if (addAg) addAg.addEventListener('click', añadirAgente);
    const newAg = $('#pctNewAgent');
    if (newAg) newAg.addEventListener('keydown', e => { if (e.key === 'Enter') añadirAgente(); });
    const list = $('#pctList');
    if (list) {
      list.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const agItem = b.closest('.ag-item');
        const agentId = agItem ? agItem.dataset.agent : null;
        const act = b.dataset.act;
        if (act === 'toggle') {                       // desplegar/plegar el agente
          if (abiertos.has(agentId)) abiertos.delete(agentId); else abiertos.add(agentId);
          renderAgentes();
        } else if (act === 'agdel') { e.stopPropagation(); borrarAgente(agentId); }
        else if (act === 'mdadd') añadirModelo(agItem);
        else if (act === 'mdsave') guardarModelo(b.closest('.md-item'), agentId);
        else if (act === 'mddel') borrarModelo(b.closest('.md-item'), agentId);
      });
      list.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const agItem = e.target.closest('.ag-item');
        if (e.target.classList.contains('md-val')) guardarModelo(e.target.closest('.md-item'), agItem.dataset.agent);
        else if (e.target.classList.contains('md-new-val') || e.target.classList.contains('md-new-name')) añadirModelo(agItem);
      });
    }
  }

  window.Settings = { init, load };
})();
