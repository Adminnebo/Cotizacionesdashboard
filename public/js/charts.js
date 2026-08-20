/* Gráficos SVG livianos (línea + barras agrupadas) con hover. Sin librerías. */
(function (global) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const tip = () => document.getElementById('tip');

  function niceScale(max) {
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
    const target = Math.max(1, max) / 4;
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s >= target) { step = s; break; } }
    return { top: Math.max(step, Math.ceil(max / step) * step), step };
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showTip(html, ev) {
    const t = tip(); t.innerHTML = html; t.hidden = false;
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY - h - pad;
    if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
    if (y < 8) y = ev.clientY + pad;
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  function hideTip() { tip().hidden = true; }

  // ---------- gráfico de línea (2 series) ----------
  function lineChart(el, cfg) {
    const W = 720, H = cfg.height || 250, m = { t: 18, r: 58, b: 26, l: 40 };
    const data = cfg.data, series = cfg.series, n = data.length;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const maxY = Math.max(1, ...data.flatMap(d => series.map(s => d[s.key] || 0)));
    const sc = niceScale(maxY);
    const X = i => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = v => m.t + ih - (v / sc.top) * ih;

    let g = '';
    // gridlines + y labels
    for (let v = 0; v <= sc.top; v += sc.step) {
      const y = Y(v);
      g += `<line class="gridline" x1="${m.l}" y1="${y}" x2="${m.l + iw}" y2="${y}"/>`;
      g += `<text class="axis" x="${m.l - 8}" y="${y + 3}" text-anchor="end">${v}</text>`;
    }
    // x labels (thinned ~6)
    const stepL = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += stepL) {
      g += `<text class="axis" x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(cfg.xLabel ? cfg.xLabel(data[i], i) : data[i].x)}</text>`;
    }
    // lines
    series.forEach(s => {
      const pts = data.map((d, i) => `${X(i)},${Y(d[s.key] || 0)}`).join(' ');
      g += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      // end dot + direct label
      const li = n - 1, lx = X(li), ly = Y(data[li] ? (data[li][s.key] || 0) : 0);
      g += `<circle class="enddot" cx="${lx}" cy="${ly}" r="3.5" fill="${s.color}"/>`;
    });
    // crosshair (oculto) + overlay
    g += `<line class="cross" x1="0" y1="${m.t}" x2="0" y2="${m.t + ih}" stroke-dasharray="3 3" opacity="0"/>`;
    g += `<rect class="ov" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
    // hover
    const svg = el.querySelector('svg'), cross = el.querySelector('.cross'), ov = el.querySelector('.ov');
    ov.addEventListener('mousemove', ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      let i = Math.round((px - m.l) / (iw / Math.max(1, n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', '1');
      const d = data[i];
      const rows = series.map(s => `<div class="tip__r"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${d[s.key] || 0}</b></div>`).join('');
      showTip(`<div class="tip__t">${esc(cfg.xLabel ? cfg.xLabel(d, i) : d.x)}</div>${rows}`, ev);
    });
    ov.addEventListener('mouseleave', () => { cross.setAttribute('opacity', '0'); hideTip(); });
  }

  // ---------- barras agrupadas (2 series por categoría) ----------
  function groupedBar(el, cfg) {
    const W = 720, H = cfg.height || 230, m = { t: 16, r: 14, b: 24, l: 34 };
    const data = cfg.data, series = cfg.series, n = data.length;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const maxY = Math.max(1, ...data.flatMap(d => series.map(s => d[s.key] || 0)));
    const sc = niceScale(maxY);
    const Y = v => m.t + ih - (v / sc.top) * ih;
    const gw = iw / n;                       // ancho por grupo
    const pad = gw * 0.18;                    // padding lateral del grupo
    const inner = gw - pad * 2;
    const bw = (inner - 2) / series.length;   // 2px gap entre barras

    let g = '';
    for (let v = 0; v <= sc.top; v += sc.step) {
      const y = Y(v);
      g += `<line class="gridline" x1="${m.l}" y1="${y}" x2="${m.l + iw}" y2="${y}"/>`;
      g += `<text class="axis" x="${m.l - 7}" y="${y + 3}" text-anchor="end">${v}</text>`;
    }
    data.forEach((d, i) => {
      const gx = m.l + i * gw + pad;
      series.forEach((s, si) => {
        const val = d[s.key] || 0, y = Y(val), h = m.t + ih - y;
        const x = gx + si * (bw + 2);
        if (h > 0) g += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="2.5" fill="${s.color}"/>`;
      });
      if (i % (n > 16 ? 3 : 2) === 0) g += `<text class="axis" x="${gx + inner / 2}" y="${H - 7}" text-anchor="middle">${esc(cfg.xLabel ? cfg.xLabel(d, i) : d.label)}</text>`;
      // overlay por grupo
      g += `<rect class="ovg" data-i="${i}" x="${m.l + i * gw}" y="${m.t}" width="${gw}" height="${ih}" fill="transparent"/>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
    el.querySelectorAll('.ovg').forEach(o => {
      o.addEventListener('mousemove', ev => {
        const d = data[+o.dataset.i];
        const rows = series.map(s => `<div class="tip__r"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${d[s.key] || 0}</b></div>`).join('');
        showTip(`<div class="tip__t">${esc(cfg.tipLabel ? cfg.tipLabel(d) : d.label)}</div>${rows}`, ev);
      });
      o.addEventListener('mouseleave', hideTip);
    });
  }

  // Escala "bonita" entre lo y hi con ~4 pasos (enteros si el paso ≥ 1).
  function axisRange(lo, hi) {
    if (!(hi > lo)) hi = lo + 1;                          // evita línea plana / división por cero
    const rawStep = (hi - lo) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }

  // ---------- tendencia en el tiempo (varias líneas, eje Y dinámico, huecos en null) ----------
  // data: [{ d, <key>: n|null }]  ·  series: [{ key, label, color }]
  // cfg.yMin / cfg.yMax: límites del eje (null = automático mín–máx)  ·  cfg.unit  ·  cfg.xLabel(d,i)
  function trendChart(el, cfg) {
    const W = 720, H = cfg.height || 250, m = { t: 18, r: 54, b: 26, l: 44 };
    const data = cfg.data, series = cfg.series, n = data.length;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const unit = cfg.unit || '';
    const vals = data.flatMap(d => series.map(s => d[s.key])).filter(v => v != null);
    let dataMin = vals.length ? Math.min(...vals) : 0;
    let dataMax = vals.length ? Math.max(...vals) : 1;
    // Límites del eje: manuales (cfg.yMin / cfg.yMax) o automáticos (mín–máx de los datos).
    const lo0 = cfg.yMin != null ? cfg.yMin : dataMin;
    const hi0 = cfg.yMax != null ? cfg.yMax : dataMax;
    const ax = axisRange(lo0, hi0);
    const X = i => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = v => m.t + ih - ((v - ax.lo) / (ax.hi - ax.lo)) * ih;
    const Yc = v => Math.max(m.t, Math.min(m.t + ih, Y(v)));   // recorta al área del plot
    const fmtY = v => (ax.step >= 1 ? String(Math.round(v)) : String(v)) + unit;

    let g = '';
    for (let v = ax.lo; v <= ax.hi + 1e-9; v += ax.step) {
      const y = Y(v);
      g += `<line class="gridline" x1="${m.l}" y1="${y}" x2="${m.l + iw}" y2="${y}"/>`;
      g += `<text class="axis" x="${m.l - 8}" y="${y + 3}" text-anchor="end">${fmtY(v)}</text>`;
    }
    const stepL = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += stepL) {
      g += `<text class="axis" x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(cfg.xLabel ? cfg.xLabel(data[i], i) : data[i].d)}</text>`;
    }
    series.forEach(s => {
      // La línea se corta en los huecos (días sin dato): cada tramo es su propio polyline.
      let seg = [], lastI = -1, lastV = null;
      const flush = () => {
        if (seg.length > 1) g += `<polyline points="${seg.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        else if (seg.length === 1) { const [x, y] = seg[0].split(','); g += `<circle cx="${x}" cy="${y}" r="2.6" fill="${s.color}"/>`; }
        seg = [];
      };
      data.forEach((d, i) => { const v = d[s.key]; if (v == null) flush(); else { seg.push(`${X(i)},${Yc(v)}`); lastI = i; lastV = v; } });
      flush();
      if (lastI >= 0) {
        g += `<circle class="enddot" cx="${X(lastI)}" cy="${Yc(lastV)}" r="3.5" fill="${s.color}"/>`;
        g += `<text class="axis" x="${m.l + iw + 6}" y="${Yc(lastV) + 3}" text-anchor="start" fill="${s.color}" style="font-weight:700">${fmtY(lastV)}</text>`;
      }
    });
    g += `<line class="cross" x1="0" y1="${m.t}" x2="0" y2="${m.t + ih}" stroke-dasharray="3 3" opacity="0"/>`;
    g += `<rect class="ov" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;

    const svg = el.querySelector('svg'), cross = el.querySelector('.cross'), ov = el.querySelector('.ov');
    ov.addEventListener('mousemove', ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      let i = Math.round((px - m.l) / (iw / Math.max(1, n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', '1');
      const d = data[i];
      const rows = series.map(s => `<div class="tip__r"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${d[s.key] == null ? '—' : (unit === '%' ? Math.round(d[s.key]) + '%' : d[s.key])}</b></div>`).join('');
      showTip(`<div class="tip__t">${esc(cfg.xLabel ? cfg.xLabel(d, i) : d.d)}</div>${rows}`, ev);
    });
    ov.addEventListener('mouseleave', () => { cross.setAttribute('opacity', '0'); hideTip(); });
  }

  global.Charts = { lineChart, groupedBar, trendChart };
})(window);
