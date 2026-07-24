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
  }

  window.Settings = { init, load };
})();
