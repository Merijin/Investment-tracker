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

  function renderHistory(container, snapshots, rangeDays, fmt) {
    container.innerHTML = '';
    let points = snapshots;
    if (rangeDays > 0) {
      const cutoff = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10);
      points = snapshots.filter((s) => s.date >= cutoff);
    }
    if (points.length < 2) {
      container.innerHTML = `<div class="history-empty">Your value history builds up automatically —<br>
        one data point per day you open or update the tracker.</div>`;
      return;
    }

    const width = Math.max(280, container.clientWidth);
    const height = 240;
    const m = { top: 12, right: 12, bottom: 24, left: 56 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const t0 = Date.parse(points[0].date);
    const t1 = Date.parse(points[points.length - 1].date);
    const values = points.map((p) => p.value);
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const x = (d) => m.left + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * w;
    const y = (v) => m.top + h - ((v - yMin) / (yMax - yMin || 1)) * h;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Portfolio value over time' }, container);
    for (const t of ticks) {
      el('line', { class: t === yMin ? 'baseline' : 'gridline', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }, svg);
      el('text', { class: 'axis-label', x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = fmt.compact(t);
    }
    const xIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    xIdx.forEach((i, n) => {
      const anchor = n === 0 ? 'start' : n === xIdx.length - 1 ? 'end' : 'middle';
      el('text', { class: 'axis-label', x: x(points[i].date), y: height - 6, 'text-anchor': anchor }, svg).textContent = fmt.shortDate(points[i].date);
    });

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    el('path', { class: 'area', d: `${d}L${x(points[points.length - 1].date)},${y(yMin)}L${x(points[0].date)},${y(yMin)}Z` }, svg);
    el('path', { class: 'line', d }, svg);

    const cross = el('line', { class: 'crosshair', y1: m.top, y2: m.top + h, visibility: 'hidden' }, svg);
    const dot = el('circle', { class: 'dot', r: 5, visibility: 'hidden' }, svg);
    const hit = el('rect', { x: m.left, y: 0, width: w, height, fill: 'transparent' }, svg);

    const onMove = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      let best = points[0];
      for (const p of points) if (Math.abs(x(p.date) - px) < Math.abs(x(best.date) - px)) best = p;
      const bx = x(best.date);
      cross.setAttribute('x1', bx);
      cross.setAttribute('x2', bx);
      dot.setAttribute('cx', bx);
      dot.setAttribute('cy', y(best.value));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      const gain = best.value - (best.cost || 0);
      tooltip.show(`<div class="tt-title">${fmt.longDate(best.date)}</div>
        <div class="tt-value">${fmt.money(best.value)}</div>
        ${best.cost ? `<div class="${gain >= 0 ? 'gain' : 'loss'}">${fmt.signedMoney(gain)} vs invested</div>` : ''}`, clientX, clientY);
    };
    const onLeave = () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip.hide();
    };
    hit.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    hit.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    hit.addEventListener('mouseleave', onLeave);
    hit.addEventListener('touchend', onLeave);
  }

  root.Charts = { renderAllocation, renderHistory, tooltip, escapeHTML };
})(self);
