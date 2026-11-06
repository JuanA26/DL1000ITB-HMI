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
  themedColor, chartRegistry, niceTicks, formatTick, formatCursor, layoutChartFrame,
} from './chart.js';

export class BodeChart {
  constructor(canvas, {
    title = '', xLabel = 'RPM', yLabel = 'Accel Amplitude (g)', resonanceX = null,
    yFixed = null, refY = null,
    // Opt-in extras, all off by default so existing charts are unchanged:
    //   palette          -- fixed colour set (e.g. MATLAB_PALETTE from chart.js)
    //                       that ignores the light/dark theme, fills the canvas
    //                       with its own background and, with `box`, draws a
    //                       full MATLAB-style axes box with inward ticks.
    //   dataTips         -- click a point to pin a MATLAB-style data tip (click
    //                       it again to remove it); see _toggleTip().
    //   resonanceFormat  -- (x) => label for the resonanceX reference line;
    //                       default keeps the sweep's "<x> RPM".
    //   zoomMode         -- 'xy' (default) or 'x': wheel-zoom / drag-pan the x
    //                       axis only, y staying auto-fit to the data -- like
    //                       MATLAB's xlim([a b]). For time traces, where the
    //                       reading is a time and the whole amplitude should
    //                       stay in view while zooming in on a few cycles.
    palette = null, dataTips = false, resonanceFormat = null, zoomMode = 'xy',
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
    this.palette = palette;
    this.dataTips = dataTips;
    this.resonanceFormat = resonanceFormat;
    this.zoomMode = zoomMode;
    // Pinned data tips: { series, x, y, xOnly } in DATA coordinates, so they
    // stay put on the trace through zoom/pan (and follow it across a view
    // switch -- see setSeries). _pendingTip defers a click's pin by one
    // double-click interval so a double-click (reset zoom) doesn't pin one.
    this.tips = [];
    this._pendingTip = null;
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
    this.canvas.addEventListener('dblclick', () => { this._cancelPendingTip(); this.resetZoom(); });
    this.canvas.addEventListener('mousedown', (e) => this._onDragStart(e));
    window.addEventListener('mousemove', (e) => this._onDragMove(e));
    window.addEventListener('mouseup', (e) => this._onDragEnd(e));
    chartRegistry.add(this);
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  // Colour lookup: the fixed palette when one was given, else the live theme
  // colour (chart.js swaps those on a light/dark toggle).
  _col(key) {
    if (this.palette) return this.palette[key];
    switch (key) {
      case 'axis': return COLOR_AXIS;
      case 'grid': return COLOR_GRID;
      case 'text': return COLOR_TEXT;
      case 'title': return COLOR_TITLE;
      case 'mark': return COLOR_MARK;
      case 'markDim': return COLOR_MARK_DIM;
      case 'cursor': return COLOR_CURSOR;
      case 'cursorOutline': return COLOR_CURSOR_OUTLINE;
      case 'tooltipBg': return COLOR_TOOLTIP_BG;
      default: return COLOR_TEXT;
    }
  }

  // Series colour: literal under a fixed palette (MATLAB '-b' is '-b'),
  // theme-mapped otherwise.
  _sc(color) { return this.palette ? color : themedColor(color); }

  // Public: remove every pinned data tip.
  clearTips() {
    this._cancelPendingTip();
    if (!this.tips.length) return;
    this.tips = [];
    this.draw();
  }

  _cancelPendingTip() {
    if (this._pendingTip) { clearTimeout(this._pendingTip); this._pendingTip = null; }
  }

  // Click on a point: pin a tip there, or remove the tip already pinned there
  // (same as clicking a MATLAB datatip and deleting it).
  _toggleTip(hit) {
    if (!this._layout) return;
    const { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax } = this._layout;
    const toPx = (t) => [
      x0 + ((t.x - xMin) / (xMax - xMin)) * plotW,
      y0 + plotH - ((t.y - yMin) / (yMax - yMin)) * plotH,
    ];
    const existing = this.tips.findIndex((t) => {
      const [px, py] = toPx(t);
      return Math.hypot(px - hit.px, py - hit.py) <= 6;
    });
    if (existing >= 0) this.tips.splice(existing, 1);
    else this.tips.push({ series: hit.series, x: hit.dataX, y: hit.dataY, xOnly: !!hit.xOnly });
    this.draw();
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
    if (this.zoomMode !== 'x') this._zoomY = { min: dataY - newYSpan * yFrac, max: dataY + newYSpan * (1 - yFrac) };
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
      hoverAtDown: this._hover ? { ...this._hover } : null, // what a click would pin
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
    if (this.zoomMode !== 'x') this._zoomY = { min: startYMin + dy, max: startYMax + dy };
    this.canvas.style.cursor = 'grabbing';
    this.draw();
  }

  _onDragEnd(e) {
    if (!this._pan) return;
    const wasClick = !this._pan.moved;
    const hit = this._pan.hoverAtDown;
    this._pan = null;
    this.canvas.style.cursor = '';
    if (!this.dataTips || !wasClick) return;
    // Second click of a double-click: that gesture means "reset zoom", so drop
    // the pin the first click scheduled instead of leaving a stray tip.
    if (e && e.detail >= 2) { this._cancelPendingTip(); return; }
    if (!hit) return;
    this._cancelPendingTip();
    this._pendingTip = setTimeout(() => { this._pendingTip = null; this._toggleTip(hit); }, 250);
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
    for (const [name, s] of this.series) {
      for (const p of s.points) {
        // `snap: false` marks a drawing-only vertex (e.g. the rising edge of a
        // synthesised pulse) that the cursor should never report.
        if (p.snap === false) continue;
        const px = x0 + ((p.x - xMin) / (xMax - xMin)) * plotW;
        const py = y0 + plotH - ((p.y - yMin) / (yMax - yMin)) * plotH;
        // Zoomed in, points off the visible axes can't be picked.
        if (px < x0 - 1 || px > x0 + plotW + 1 || py < y0 - 1 || py > y0 + plotH + 1) continue;
        const d = Math.hypot(px - mx, py - my);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { px, py, dataX: p.x, dataY: p.y, color: s.color, series: name, xOnly: s.cursor === 'x' };
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
  // opts.lineWidth overrides the 1.75 px line; opts.presorted skips the
  // sort-by-x before drawing (points already in drawing order -- needed for a
  // pulse train, whose vertical edges are pairs of points at the same x);
  // opts.cursor = 'x' makes the cursor/tips report X only (y is meaningless
  // for a scaled reference trace).
  setSeries(name, points, color, label, opts = {}) {
    this.series.set(name, {
      points, color, label: label ?? name, markers: opts.markers !== false,
      lineWidth: opts.lineWidth, presorted: !!opts.presorted, cursor: opts.cursor || null,
    });
    // Pinned tips on this series follow the new data: re-snapped to the point
    // nearest in x (ties -> nearest in y). Switching Raw/Low-pass keeps the
    // sample times, so a tip stays on the same instant and just takes the new
    // value -- what you'd want when comparing views.
    if (this.tips.length) {
      this.tips = this.tips.filter((tip) => {
        if (tip.series !== name) return true;
        let best = null, bestDx = Infinity, bestDy = Infinity;
        for (const p of points) {
          if (p.snap === false) continue;
          const dx = Math.abs(p.x - tip.x), dy = Math.abs(p.y - tip.y);
          if (dx < bestDx || (dx === bestDx && dy < bestDy)) { best = p; bestDx = dx; bestDy = dy; }
        }
        if (!best) return false;
        tip.x = best.x; tip.y = best.y; tip.xOnly = opts.cursor === 'x';
        return true;
      });
    }
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
    this.tips = this.tips.filter((t) => t.series !== name);
    this.draw();
  }

  // Removes every series except the one named (e.g. "Clear Overlays" while
  // keeping the current live/in-progress run visible).
  clearExcept(keepName) {
    for (const key of [...this.series.keys()]) {
      if (key !== keepName) this.series.delete(key);
    }
    this.tips = this.tips.filter((t) => t.series === keepName);
    this.draw();
  }

  clear() {
    this.series.clear();
    this.tips = [];
    this._cancelPendingTip();
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    // A fixed palette brings its own figure background (a MATLAB figure is
    // white whatever the HMI theme); themed charts stay transparent over the
    // CSS --chart-bg as before.
    if (this.palette && this.palette.background) {
      ctx.fillStyle = this.palette.background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.textBaseline = 'middle';

    const series = [...this.series.values()];
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

    // Frame (title/legend/axis titles) and the margins they need. Drawn after
    // the domains are known because the left margin is sized from the widest
    // y tick label -- see layoutChartFrame().
    const { x0, y0, plotW, plotH } = layoutChartFrame(ctx, {
      w, h, title: this.title, xLabel: this.xLabel, yLabel: this.yLabel,
      yTicks, legend: series, palette: this.palette,
    });

    // Cached for _onMouseMove's hit-testing (data cursor) -- draw() is the
    // only place that (re)computes the axis domain.
    this._layout = { x0, y0, plotW, plotH, xMin, xMax, yMin, yMax };
    const toPxX = (v) => x0 + ((v - xMin) / (xMax - xMin)) * plotW;
    const toPxY = (v) => y0 + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ---- Gridlines + y tick labels ----
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    yTicks.forEach((v) => {
      const y = toPxY(v);
      ctx.strokeStyle = this._col('grid');
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
      ctx.fillStyle = this._col('text');
      ctx.fillText(formatTick(v), x0 - 6, y);
    });

    // ---- X ticks + labels ----
    ctx.textAlign = 'center';
    xTicks.forEach((v) => {
      const x = toPxX(v);
      ctx.strokeStyle = this._col('grid');
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + plotH); ctx.stroke();
      ctx.fillStyle = this._col('text');
      ctx.fillText(formatTick(v), x, y0 + plotH + 12);
    });

    // ---- Axis box ----
    ctx.strokeStyle = this._col('axis');
    ctx.lineWidth = 1;
    if (this.palette && this.palette.box) {
      // MATLAB `box on`: all four sides, short tick marks pointing inward.
      ctx.beginPath();
      ctx.rect(x0, y0, plotW, plotH);
      const TICK = 5;
      yTicks.forEach((v) => {
        const y = toPxY(v);
        ctx.moveTo(x0, y); ctx.lineTo(x0 + TICK, y);
        ctx.moveTo(x0 + plotW, y); ctx.lineTo(x0 + plotW - TICK, y);
      });
      xTicks.forEach((v) => {
        const x = toPxX(v);
        ctx.moveTo(x, y0 + plotH); ctx.lineTo(x, y0 + plotH - TICK);
        ctx.moveTo(x, y0); ctx.lineTo(x, y0 + TICK);
      });
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + plotH); ctx.lineTo(x0 + plotW, y0 + plotH);
      ctx.stroke();
    }

    // ---- Resonance reference line (e.g. natural frequency, converted to
    // RPM by the caller since this chart's x-axis is RPM) ----
    if (this.resonanceX != null && isFinite(this.resonanceX) && this.resonanceX >= xMin && this.resonanceX <= xMax) {
      const rx = toPxX(this.resonanceX);
      ctx.save();
      ctx.strokeStyle = this._col('mark');
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(rx, y0);
      ctx.lineTo(rx, y0 + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this._col('mark');
      ctx.font = '10px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      const label = this.resonanceFormat
        ? this.resonanceFormat(this.resonanceX)
        : `${formatTick(this.resonanceX)} RPM`;
      ctx.fillText(label, rx + 3, y0 + 9);
      ctx.restore();
    }

    // ---- Encoder-pulse (or other) vertical markers ----
    // Drawn under the trace so the waveform stays readable on top of them.
    if (this.vLines.length) {
      ctx.save();
      ctx.strokeStyle = this._col('markDim');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const vx of this.vLines) {
        if (!isFinite(vx) || vx < xMin || vx > xMax) continue;
        const px = toPxX(vx);
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
      const ry = toPxY(this.refY);
      ctx.save();
      ctx.strokeStyle = this._col('mark');
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
    // irrelevant for dots). A `presorted` series is drawn in the order given.
    //
    // Clipped to the axes whenever the view is zoomed/panned (or the chart is
    // a fixed-palette MATLAB figure): otherwise the off-screen part of the
    // trace is drawn straight across the tick labels and title. Unzoomed,
    // auto-fit keeps every point inside anyway, so themed charts look as before.
    const clip = !!(this._zoomX || this._zoomY || this.palette);
    if (clip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, plotW, plotH);
      ctx.clip();
    }
    series.forEach((s) => {
      if (!s.points.length) return;
      const toXY = (p) => [toPxX(p.x), toPxY(p.y)];
      if (s.points.length >= 2) {
        const ordered = s.presorted ? s.points : s.points.slice().sort((a, b) => a.x - b.x);
        ctx.strokeStyle = this._sc(s.color);
        ctx.lineWidth = s.lineWidth ?? 1.75;
        ctx.beginPath();
        ordered.forEach((p, i) => {
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
        ctx.fillStyle = this._sc(s.color);
        ctx.beginPath();
        ctx.arc(x, y, 2.25, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      });
    });
    if (clip) ctx.restore();

    const xSpan = xMax - xMin, ySpan = yMax - yMin;

    // ---- Pinned data tips (MATLAB datatips) ----
    for (const tip of this.tips) {
      if (tip.x < xMin || tip.x > xMax || tip.y < yMin || tip.y > yMax) continue;
      this._drawTipBox(ctx, toPxX(tip.x), toPxY(tip.y), tip.x, tip.y, tip.xOnly,
                       null, xSpan, ySpan, { x0, y0, plotW, plotH });
    }

    // ---- MATLAB-style data cursor: crosshair + highlighted point + value
    // box for whatever point _onMouseMove last snapped to ----
    if (this._hover) {
      const { px, py, dataX, dataY, color, xOnly } = this._hover;
      ctx.save();
      ctx.strokeStyle = this._col('cursor');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      if (!xOnly) { ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x0 + plotW, py); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y0 + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      if (this.palette) {
        // Same look as a pinned tip, so hovering previews exactly what a click
        // pins -- unless that point is already pinned (its tip is showing).
        const pinned = this.tips.some((t) => t.series === this._hover.series && t.x === dataX && t.y === dataY);
        if (!pinned) this._drawTipBox(ctx, px, py, dataX, dataY, xOnly, color, xSpan, ySpan, { x0, y0, plotW, plotH });
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = this._sc(color);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = this._col('cursorOutline');
        ctx.stroke();

        // Full-precision readout, scaled to the visible span (see formatCursor) --
        // this is the number a student actually measures Δt with, so axis-tick
        // rounding would defeat the purpose.
        const line1 = `${this.xLabel}: ${formatCursor(dataX, xSpan)}`;
        const line2 = xOnly ? '' : `${this.yLabel}: ${formatCursor(dataY, ySpan)}`;
        ctx.font = '11px Segoe UI, sans-serif';
        const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 14;
        const boxH = xOnly ? 22 : 36;
        let bx = px + 10, by = py - boxH - 8;
        if (bx + boxW > x0 + plotW) bx = px - boxW - 10;
        if (by < y0) by = py + 10;

        ctx.fillStyle = this._col('tooltipBg');
        ctx.strokeStyle = this._col('axis');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, boxW, boxH);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = this._col('title');
        ctx.textAlign = 'left';
        ctx.fillText(line1, bx + 7, by + 12);
        if (line2) ctx.fillText(line2, bx + 7, by + 26);
        ctx.restore();
      }
    }
  }

  // One MATLAB-style datatip: a dot on the point and a white box beside it
  // reading "X <value>" / "Y <value>" (values bold, MATLAB's datatip blue).
  // `ringColor` set = the live hover preview (dot ringed in the series colour);
  // null = a pinned tip (solid dark dot, as MATLAB draws it).
  _drawTipBox(ctx, px, py, dataX, dataY, xOnly, ringColor, xSpan, ySpan, area) {
    const { x0, y0, plotW, plotH } = area;
    const pal = this.palette;
    const valueColor = (pal && pal.tipValue) || this._col('title');
    const rows = [['X', formatCursor(dataX, xSpan)]];
    if (!xOnly) rows.push(['Y', formatCursor(dataY, ySpan)]);

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.arc(px, py, ringColor ? 4 : 3.2, 0, 2 * Math.PI);
    ctx.fillStyle = ringColor ? this._sc(ringColor) : this._col('axis');
    ctx.fill();
    if (ringColor) { ctx.lineWidth = 1.5; ctx.strokeStyle = this._col('cursorOutline'); ctx.stroke(); }

    const LABEL_FONT = '11px Segoe UI, sans-serif';
    const VALUE_FONT = '600 11px Segoe UI, sans-serif';
    ctx.font = LABEL_FONT;
    const labelW = Math.max(...rows.map(([k]) => ctx.measureText(k).width));
    ctx.font = VALUE_FONT;
    const valueW = Math.max(...rows.map(([, v]) => ctx.measureText(v).width));
    const boxW = Math.ceil(labelW + 6 + valueW + 14);
    const boxH = rows.length * 15 + 7;
    let bx = px + 9, by = py - boxH - 9;
    if (bx + boxW > x0 + plotW) bx = px - boxW - 9;
    if (bx < x0) bx = x0 + 2;
    if (by < y0) by = py + 9;
    if (by + boxH > y0 + plotH) by = Math.max(y0 + 2, y0 + plotH - boxH - 2);

    ctx.fillStyle = this._col('tooltipBg');
    ctx.strokeStyle = this._col('axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(Math.round(bx) + 0.5, Math.round(by) + 0.5, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    rows.forEach(([k, v], i) => {
      const ty = by + 11 + i * 15;
      ctx.font = LABEL_FONT;
      ctx.fillStyle = this._col('text');
      ctx.fillText(k, bx + 7, ty);
      ctx.font = VALUE_FONT;
      ctx.fillStyle = valueColor;
      ctx.fillText(v, bx + 7 + labelW + 6, ty);
    });
    ctx.restore();
  }
}
