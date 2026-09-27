/*
 * Dependency-free SVG/HTML charts: an allocation bar list and a value-over-time
 * line with a crosshair tooltip.
 */
(function (root) {
  'use strict';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const tooltip = {
    node: null,
    show(html, x, y) {
      this.node = this.node || document.getElementById('tooltip');
      this.node.innerHTML = html;
      this.node.hidden = false;
      const { offsetWidth: w, offsetHeight: h } = this.node;
      const left = Math.min(x + 14, window.innerWidth - w - 8);
      const top = y - h - 12 < 8 ? y + 16 : y - h - 12;
      this.node.style.left = Math.max(8, left) + 'px';
      this.node.style.top = top + 'px';
    },
    hide() {
      if (this.node) this.node.hidden = true;
    },
  };

  /** Horizontal bar list: every row is labelled, so color is never the only cue. */
  function renderAllocation(container, allocation, fmt) {
    container.innerHTML = '';
    if (!allocation.length) {
      container.innerHTML = '<div class="history-empty">No holdings yet.</div>';
      return;
    }
    const max = Math.max(...allocation.map((a) => a.share));
    for (const a of allocation) {
      const row = document.createElement('div');
      row.className = 'alloc-row';
      const color = `var(--series-${a.slot})`;
      row.innerHTML = `
        <div class="alloc-label"><span class="swatch" style="background:${color}"></span>${escapeHTML(a.label)}</div>
        <div class="alloc-track"><div class="alloc-bar" style="width:${max > 0 ? (a.share / max) * 100 : 0}%;background:${color}"></div></div>
        <div class="alloc-value">${fmt.pct(a.share)}</div>`;
      const track = row.querySelector('.alloc-track');
      const html = `<div class="tt-title">${escapeHTML(a.label)} · ${a.count} holding${a.count === 1 ? '' : 's'}</div>
        <div class="tt-value">${fmt.money(a.value)}</div>
        <div class="${a.gain >= 0 ? 'gain' : 'loss'}">${fmt.signedMoney(a.gain)} unrealized</div>`;
      track.addEventListener('mousemove', (e) => tooltip.show(html, e.clientX, e.clientY));
      track.addEventListener('mouseleave', () => tooltip.hide());
      container.appendChild(row);
    }
  }

  function niceTicks(min, max, count = 4) {
    if (min === max) {
      const pad = Math.abs(min) * 0.05 || 1;
      min -= pad;
      max += pad;
    }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.5; v += step) ticks.push(v);
    return ticks;
  }

  /**
   * Portfolio history line. mode 'value' plots value with the amount invested
   * as a dashed reference; mode 'return' plots cumulative % return around 0.
   * points: [{date, value, cost, pct, gain}], already limited to the range.
   */
  function renderHistory(container, points, { mode = 'value', fmt, emptyText }) {
    container.innerHTML = '';
    if (points.length < 2) {
      container.innerHTML = `<div class="history-empty">${emptyText || 'Not enough history yet.'}</div>`;
      return;
    }
    const isPct = mode === 'return';
    const yOf = (p) => (isPct ? p.pct : p.value);
    const width = Math.max(280, container.clientWidth);
    const height = 240;
    const m = { top: 12, right: 12, bottom: 24, left: isPct ? 48 : 56 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const t0 = Date.parse(points[0].date);
    const t1 = Date.parse(points[points.length - 1].date);
    const values = points.map(yOf);
    if (!isPct) values.push(...points.map((p) => p.cost));
    if (isPct) values.push(0);
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const x = (d) => m.left + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * w;
    const y = (v) => m.top + h - ((v - yMin) / (yMax - yMin || 1)) * h;
    const multiYear = t1 - t0 > 330 * 86400000;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': isPct ? 'Portfolio return over time' : 'Portfolio value over time',
    }, container);
    const zero = isPct ? 0 : yMin;
    for (const t of ticks) {
      el('line', { class: Math.abs(t - zero) < 1e-12 ? 'baseline' : 'gridline', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }, svg);
      el('text', { class: 'axis-label', x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg)
        .textContent = isPct ? fmt.axisPct(t) : fmt.compact(t);
    }
    const xIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    xIdx.forEach((i, n) => {
      const anchor = n === 0 ? 'start' : n === xIdx.length - 1 ? 'end' : 'middle';
      el('text', { class: 'axis-label', x: x(points[i].date), y: height - 6, 'text-anchor': anchor }, svg)
        .textContent = multiYear ? fmt.monthYear(points[i].date) : fmt.shortDate(points[i].date);
    });

    const path = (f) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(f(p)).toFixed(1)}`).join('');
    const d = path(yOf);
    const last = points[points.length - 1];
    el('path', { class: 'area', d: `${d}L${x(last.date)},${y(zero)}L${x(points[0].date)},${y(zero)}Z` }, svg);
    if (!isPct) el('path', { class: 'line-ref', d: path((p) => p.cost) }, svg);
    el('path', { class: 'line', d }, svg);
    el('circle', { class: 'dot end', r: 4, cx: x(last.date), cy: y(yOf(last)) }, svg);

    const cross = el('line', { class: 'crosshair', y1: m.top, y2: m.top + h, visibility: 'hidden' }, svg);
    const dot = el('circle', { class: 'dot', r: 5, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: m.left, y: 0, width: w, height, fill: 'transparent' }, svg);

    const onMove = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - m.left) / w) * (points.length - 1))));
      // Dates are daily and evenly spaced, so the index is the nearest point.
      const best = points[i];
      const bx = x(best.date);
      cross.setAttribute('x1', bx);
      cross.setAttribute('x2', bx);
      dot.setAttribute('cx', bx);
      dot.setAttribute('cy', y(yOf(best)));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      const cls = (n) => (n >= 0 ? 'gain' : 'loss');
      tooltip.show(isPct
        ? `<div class="tt-title">${fmt.longDate(best.date)}</div>
           <div class="tt-value ${cls(best.pct)}">${fmt.signedPct(best.pct)}</div>
           <div>${fmt.signedMoney(best.gain)} since ${fmt.longDate(points[0].date)}</div>
           <div class="muted">Value ${fmt.money(best.value)}</div>`
        : `<div class="tt-title">${fmt.longDate(best.date)}</div>
           <div class="tt-value">${fmt.money(best.value)}</div>
           <div class="muted">Invested ${fmt.money(best.cost)}</div>
           <div class="${cls(best.value - best.cost)}">${fmt.signedMoney(best.value - best.cost)} unrealized</div>`,
      clientX, clientY);
    };
    const onLeave = () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip.hide();
    };
    hit.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    hit.addEventListener('touchstart', (e) => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    hit.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    hit.addEventListener('mouseleave', onLeave);
    hit.addEventListener('touchend', onLeave);
  }

  root.Charts = { renderAllocation, renderHistory, tooltip, escapeHTML };
})(self);
