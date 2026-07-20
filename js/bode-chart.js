// Multi-series XY chart for the RPM sweep / Bode plot panel. Reuses
// chart.js's MATLAB-style axis-box/tick/legend rendering conventions, but
// RollingChart itself doesn't fit this use case: its x-axis is always
// elapsed time (a single rolling/scrolling buffer), where a Bode plot's
// x-axis is RPM and multiple *named* series (the live run plus however
// many saved runs are loaded for overlay comparison) need to coexist and
// be individually added/removed without disturbing the others.
import {
  COLOR_AXIS, COLOR_GRID, COLOR_TEXT, COLOR_TITLE,
  COLOR_MARK, COLOR_MARK_DIM, COLOR_CURSOR, COLOR_CURSOR_OUTLINE, COLOR_TOOLTIP_BG,
  themedColor, chartRegistry, niceTicks, formatTick, formatCursor,
} from './chart.js';

export class BodeChart {
  constructor(canvas, {
    title = '', xLabel = 'RPM', yLabel = 'Accel Amplitude (g)', resonanceX = null,
    yFixed = null, refY = null,
  } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.title = title;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    // Reference vertical line (e.g. resonance RPM) -- null hides it.
    this.resonanceX = resonanceX;
    // Optional {min,max} y-domain that overrides auto-fit. The phase plot wants
    // this: phase lives on a fixed, physically meaningful 0-180 scale, and
    // auto-fitting would rescale it run-to-run (and blow a flat pre-resonance
    // trace up into meaningless noise filling the whole panel). Wheel-zoom
    // still overrides it, and resetZoom() returns here rather than to auto-fit.
    this.yFixed = yFixed;
    // Optional horizontal reference line (e.g. the 90 deg resonance crossing).
    this.refY = refY;
    // Extra vertical marker lines at arbitrary x values -- the Log Summary uses
    // these to mark every encoder pulse against the accel waveform, which is
    // the whole point of that screen (read peak-to-trigger by eye). Distinct
    // from `resonanceX`, which is one labelled reference line.
    this.vLines = [];
    // name -> { points: [{x,y}], color, label }. Insertion order is
    // preserved (Map), which is also the legend's left-to-right order.
    this.series = new Map();
    // MATLAB-style data cursor: nearest point under the mouse, or null.
    // _layout holds the last draw()'s pixel<->data mapping so mousemove
    // (which fires outside draw()) can hit-test without recomputing the
    // whole axis domain from scratch.
    this._hover = null;
    this._layout = null;
    // Mouse-wheel zoom (MATLAB-style): null means auto-fit to the data,
    // like today; scrolling over the plot area sets an explicit {min,max}
    // window that overrides auto-fit until resetZoom() (double-click).
    this._zoomX = null;
    this._zoomY = null;
    // Left-mouse drag-to-pan: null when not dragging. Grabs whatever data
    // point is under the mouse at mousedown and keeps it under the mouse
    // as it moves (same anchor idea as _onWheel, just continuous) --
    // works whether or not the view is currently zoomed, same as MATLAB.
    this._pan = null;
    this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => { this._hover = null; this.draw(); });
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', () => this.resetZoom());
    this.canvas.addEventListener('mousedown', (e) => this._onDragStart(e));
    window.addEventListener('mousemove', (e) => this._onDragMove(e));
    window.addEventListener('mouseup', () => this._onDragEnd());
    chartRegistry.add(this);
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // Public: change the reference vertical line's x-value (e.g. resonance
  // frequency converted to RPM), or pass null to hide it.
  setResonanceX(x) {
    this.resonanceX = x;
    this.draw();
  }

  // Public: set the extra vertical marker lines (array of x values, or []).
  setVLines(xs) {
    this.vLines = xs || [];
    this.draw();
  }

  // Public: clear any wheel-zoom, back to auto-fitting the data (or back to
  // yFixed on the y-axis, where the caller set one).
  resetZoom() {
    if (!this._zoomX && !this._zoomY) return;
    this._zoomX = null;
    this._zoomY = null;
    this.draw();
  }

  _onWheel(e) {
    if (!this._layout) return;
    const { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Ignore wheel events outside the axes box (e.g. over the title/legend
    // margin) so the page can still scroll normally there.
    if (mx < x0 || mx > x0 + plotW || my < y0 || my > y0 + plotH) return;
    e.preventDefault();

    // Zoom both axes together around the data point under the cursor, so
    // that point stays fixed on screen as you scroll -- same feel as
    // MATLAB's scroll-to-zoom.
    const dataX = xMin + ((mx - x0) / plotW) * (xMax - xMin);
    const dataY = yMax - ((my - y0) / plotH) * (yMax - yMin);
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85; // scroll up/away = zoom in
    const xFrac = (dataX - xMin) / (xMax - xMin);
    const yFrac = (dataY - yMin) / (yMax - yMin);
    const newXSpan = (xMax - xMin) * factor;
    const newYSpan = (yMax - yMin) * factor;

    this._zoomX = { min: dataX - newXSpan * xFrac, max: dataX + newXSpan * (1 - xFrac) };
    this._zoomY = { min: dataY - newYSpan * yFrac, max: dataY + newYSpan * (1 - yFrac) };
    this.draw();
  }

  _onDragStart(e) {
    if (e.button !== 0 || !this._layout) return;
    const { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < x0 || mx > x0 + plotW || my < y0 || my > y0 + plotH) return;
    e.preventDefault();
    this._pan = {
      startClientX: e.clientX, startClientY: e.clientY,
      startXMin: xMin, startXMax: xMax, startYMin: yMin, startYMax: yMax,
      moved: false, // stays false for a plain click (no movement), so it doesn't pin auto-fit
    };
  }

  _onDragMove(e) {
    if (!this._pan || !this._layout) return;
    const dxPixels = e.clientX - this._pan.startClientX;
    const dyPixels = e.clientY - this._pan.startClientY;
    if (!this._pan.moved && Math.hypot(dxPixels, dyPixels) < 3) return;
    this._pan.moved = true;
    this._hover = null; // suppress the data cursor while panning
    const { plotW, plotH } = this._layout;
    const { startXMin, startXMax, startYMin, startYMax } = this._pan;
    const xSpan = startXMax - startXMin, ySpan = startYMax - startYMin;
    const dx = (xSpan * dxPixels) / plotW;
    const dy = (ySpan * dyPixels) / plotH;
    this._zoomX = { min: startXMin - dx, max: startXMax - dx };
    this._zoomY = { min: startYMin + dy, max: startYMax + dy };
    this.canvas.style.cursor = 'grabbing';
    this.draw();
  }

  _onDragEnd() {
    if (!this._pan) return;
    this._pan = null;
    this.canvas.style.cursor = '';
  }

  _onMouseMove(e) {
    if (this._pan) return; // drag handling owns mousemove while active
    if (!this._layout) return;
    const { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let nearest = null;
    let nearestDist = Infinity;
    for (const s of this.series.values()) {
      for (const p of s.points) {
        const px = x0 + ((p.x - xMin) / (xMax - xMin)) * plotW;
        const py = y0 + plotH - ((p.y - yMin) / (yMax - yMin)) * plotH;
        const d = Math.hypot(px - mx, py - my);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { px, py, dataX: p.x, dataY: p.y, color: s.color };
        }
      }
    }
    // Only snap to a point within a small pixel radius, so the cursor
    // disappears (rather than jumping to a far-off point) once the mouse
    // is well clear of the trace.
    const HIT_RADIUS_PX = 18;
    const next = nearest && nearestDist <= HIT_RADIUS_PX ? nearest : null;
    const prev = this._hover;
    const unchanged = (!next && !prev) || (next && prev && next.dataX === prev.dataX && next.dataY === prev.dataY);
    if (unchanged) return;
    this._hover = next;
    this.draw();
  }

  resize() { this._resize(); }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  // Replaces a named series wholesale (e.g. loading a saved run file).
  // opts.markers = false suppresses the per-point dots (for dense traces).
  setSeries(name, points, color, label, opts = {}) {
    this.series.set(name, { points, color, label: label ?? name, markers: opts.markers !== false });
    this.draw();
  }

  // Appends one point to a named series, creating it on first call (e.g.
  // the live sweep's points arriving one at a time as 'sweep-point' fires).
  appendPoint(name, x, y, color, label) {
    let s = this.series.get(name);
    if (!s) {
      s = { points: [], color, label: label ?? name };
      this.series.set(name, s);
    }
    s.points.push({ x, y });
    this.draw();
  }

  removeSeries(name) {
    this.series.delete(name);
    this.draw();
  }

  // Removes every series except the one named (e.g. "Clear Overlays" while
  // keeping the current live/in-progress run visible).
  clearExcept(keepName) {
    for (const key of [...this.series.keys()]) {
      if (key !== keepName) this.series.delete(key);
    }
    this.draw();
  }

  clear() {
    this.series.clear();
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    const padTop = this.title ? 28 : 16;
    const padBottom = 34;
    const padLeft = 48;
    const padRight = 10;
    const plotW = Math.max(1, w - padLeft - padRight);
    const plotH = Math.max(1, h - padTop - padBottom);
    const x0 = padLeft, y0 = padTop;

    if (this.title) {
      ctx.font = '600 12px Segoe UI, sans-serif';
      ctx.fillStyle = COLOR_TITLE;
      ctx.textAlign = 'left';
      ctx.fillText(this.title, x0, 11);
    }

    ctx.font = '11px Segoe UI, sans-serif';
    const series = [...this.series.values()];
    const labeled = series.filter((s) => s.label);
    if (labeled.length) {
      const widths = labeled.map((s) => ctx.measureText(s.label).width + 16);
      let sx = x0 + plotW - widths.reduce((a, b) => a + b, 0);
      ctx.textAlign = 'left';
      labeled.forEach((s, i) => {
        ctx.fillStyle = themedColor(s.color);
        ctx.fillRect(sx, 6, 9, 9);
        ctx.fillStyle = COLOR_TEXT;
        ctx.fillText(s.label, sx + 13, 11);
        sx += widths[i];
      });
    }

    const allPoints = series.flatMap((s) => s.points);
    const xs = allPoints.map((p) => p.x);
    const ys = allPoints.map((p) => p.y);

    const xData = xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : { min: 0, max: 1 };
    const yData = ys.length ? { min: Math.min(...ys), max: Math.max(...ys) } : { min: 0, max: 1 };

    // Wheel-zoom (_onWheel) overrides the auto-fit domain with a
    // user-picked window; resetZoom() (double-click) clears it back.
    let xMin, xMax, xTicks;
    if (this._zoomX) {
      xMin = this._zoomX.min; xMax = this._zoomX.max;
      xTicks = niceTicks(xMin, xMax, 6).ticks.filter((v) => v >= xMin && v <= xMax);
    } else {
      const xNice = niceTicks(xData.min, xData.max, 6);
      xMin = xNice.min; xMax = xNice.max === xNice.min ? xNice.min + 1 : xNice.max;
      xTicks = xNice.ticks;
    }
    let yMin, yMax, yTicks;
    if (this._zoomY) {
      yMin = this._zoomY.min; yMax = this._zoomY.max;
      yTicks = niceTicks(yMin, yMax, 5).ticks.filter((v) => v >= yMin && v <= yMax);
    } else if (this.yFixed) {
      yMin = this.yFixed.min; yMax = this.yFixed.max;
      yTicks = niceTicks(yMin, yMax, 5).ticks.filter((v) => v >= yMin && v <= yMax);
    } else {
      const yNice = niceTicks(yData.min, yData.max, 5);
      yMin = yNice.min; yMax = yNice.max === yNice.min ? yNice.min + 1 : yNice.max;
      yTicks = yNice.ticks;
    }

    // Cached for _onMouseMove's hit-testing (data cursor) -- draw() is the
    // only place that (re)computes the axis domain.
    this._layout = { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax };

    // ---- Gridlines + y tick labels ----
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    yTicks.forEach((v) => {
      const y = y0 + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText(formatTick(v), x0 - 6, y);
    });

    // ---- X ticks + labels ----
    ctx.textAlign = 'center';
    xTicks.forEach((v) => {
      const x = x0 + ((v - xMin) / (xMax - xMin)) * plotW;
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + plotH); ctx.stroke();
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText(formatTick(v), x, y0 + plotH + 12);
    });

    // ---- Axis box ----
    ctx.strokeStyle = COLOR_AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + plotH); ctx.lineTo(x0 + plotW, y0 + plotH);
    ctx.stroke();

    // ---- Axis titles ----
    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = 'center';
    ctx.fillText(this.xLabel, x0 + plotW / 2, y0 + plotH + 24);
    if (this.yLabel) {
      ctx.save();
      ctx.translate(13, y0 + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(this.yLabel, 0, 0);
      ctx.restore();
    }

    // ---- Resonance reference line (e.g. natural frequency, converted to
    // RPM by the caller since this chart's x-axis is RPM) ----
    if (this.resonanceX != null && isFinite(this.resonanceX) && this.resonanceX >= xMin && this.resonanceX <= xMax) {
      const rx = x0 + ((this.resonanceX - xMin) / (xMax - xMin)) * plotW;
      ctx.save();
      ctx.strokeStyle = COLOR_MARK;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(rx, y0);
      ctx.lineTo(rx, y0 + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR_MARK;
      ctx.font = '10px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${formatTick(this.resonanceX)} RPM`, rx + 3, y0 + 9);
      ctx.restore();
    }

    // ---- Encoder-pulse (or other) vertical markers ----
    // Drawn under the trace so the waveform stays readable on top of them.
    if (this.vLines.length) {
      ctx.save();
      ctx.strokeStyle = COLOR_MARK_DIM;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const vx of this.vLines) {
        if (!isFinite(vx) || vx < xMin || vx > xMax) continue;
        const px = x0 + ((vx - xMin) / (xMax - xMin)) * plotW;
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y0 + plotH);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- Horizontal reference line (the phase plot's 90 deg crossing) ----
    // Where this line meets the trace is the resonance: phase = 90 deg is a
    // sharper, less noise-biased marker of the natural frequency than the
    // amplitude peak, which for rotating unbalance sits slightly above it.
    if (this.refY != null && isFinite(this.refY) && this.refY >= yMin && this.refY <= yMax) {
      const ry = y0 + plotH - ((this.refY - yMin) / (yMax - yMin)) * plotH;
      ctx.save();
      ctx.strokeStyle = COLOR_MARK;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, ry);
      ctx.lineTo(x0 + plotW, ry);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Series: connected line + point markers ----
    // The connecting line is drawn over a copy of the points sorted by x
    // (measured RPM). The sweep visits setpoints out of RPM order -- it
    // ascends to the gap's lower edge, jumps to max RPM, then descends the
    // super-resonance grid (reverse cycle, to dodge Sommerfeld capture) --
    // so points do NOT arrive in ascending x; sorting keeps the line clean
    // instead of tangled. Markers are drawn in arrival order (order is
    // irrelevant for dots).
    series.forEach((s) => {
      if (!s.points.length) return;
      const toXY = (p) => [
        x0 + ((p.x - xMin) / (xMax - xMin)) * plotW,
        y0 + plotH - ((p.y - yMin) / (yMax - yMin)) * plotH,
      ];
      if (s.points.length >= 2) {
        const sorted = s.points.slice().sort((a, b) => a.x - b.x);
        ctx.strokeStyle = themedColor(s.color);
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        sorted.forEach((p, i) => {
          const [x, y] = toXY(p);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      // Dense series (e.g. the Log Summary's ~2330-sample waveform) pass
      // markers:false -- one arc+fill per point would be thousands of canvas
      // ops per redraw, and redraw runs on every pan/zoom mousemove.
      if (s.markers === false) return;
      // A point may carry `dim: true` to mark it as measured-but-untrustworthy
      // (the phase plot uses it where the 1x tone was too weak for the lock-in
      // angle to mean anything). Drawn faded rather than dropped, so the gap
      // isn't mistaken for missing data.
      s.points.forEach((p) => {
        const [x, y] = toXY(p);
        ctx.save();
        if (p.dim) ctx.globalAlpha = 0.28;
        ctx.fillStyle = themedColor(s.color);
        ctx.beginPath();
        ctx.arc(x, y, 2.25, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      });
    });

    // ---- MATLAB-style data cursor: crosshair + highlighted point + value
    // box for whatever point _onMouseMove last snapped to ----
    if (this._hover) {
      const { px, py, dataX, dataY, color } = this._hover;
      ctx.save();
      ctx.strokeStyle = COLOR_CURSOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x0 + plotW, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y0 + plotH); ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = themedColor(color);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLOR_CURSOR_OUTLINE;
      ctx.stroke();

      // Full-precision readout, scaled to the visible span (see formatCursor) --
      // this is the number a student actually measures Δt with, so axis-tick
      // rounding would defeat the purpose.
      const line1 = `${this.xLabel}: ${formatCursor(dataX, xMax - xMin)}`;
      const line2 = `${this.yLabel}: ${formatCursor(dataY, yMax - yMin)}`;
      ctx.font = '11px Segoe UI, sans-serif';
      const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 14;
      const boxH = 36;
      let bx = px + 10, by = py - boxH - 8;
      if (bx + boxW > x0 + plotW) bx = px - boxW - 10;
      if (by < y0) by = py + 10;

      ctx.fillStyle = COLOR_TOOLTIP_BG;
      ctx.strokeStyle = COLOR_AXIS;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = COLOR_TITLE;
      ctx.textAlign = 'left';
      ctx.fillText(line1, bx + 7, by + 12);
      ctx.fillText(line2, bx + 7, by + 26);
      ctx.restore();
    }
  }
}
