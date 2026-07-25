// Dependency-free rolling strip chart for a canvas element, styled after
// this project's own offline MATLAB plots (PlotClosedLoopLog.m /
// PlotVibrationLog.m): an axis box with numeric tick labels on both axes,
// axis titles, an optional chart title, and a legend -- not just a bare
// line trace. Not a general charting library, just enough for the live
// dashboard panels.

// ---- Theme-aware chart palette ----
// Charts draw straight to canvas, so CSS variables can't restyle them -- the
// palette lives here instead, as `let` bindings (live exports, so bode-chart.js
// sees updates too) swapped by setChartTheme() when the HMI's light/dark toggle
// flips. Every chart registers itself in chartRegistry so setChartTheme() can
// repaint the ones already on screen.
const CHART_THEMES = {
  dark: {
    axis: '#5a6062',
    grid: 'rgba(255,255,255,0.08)',
    text: '#9aa0a0',
    title: '#eaeaea',
    mark: '#e0c341',                    // FFT peak / resonance / refY markers
    markDim: 'rgba(224, 195, 65, 0.55)', // encoder-pulse vLines
    cursor: 'rgba(255,255,255,0.35)',   // data-cursor crosshair
    cursorOutline: '#fff',              // data-cursor point ring
    tooltipBg: 'rgba(20,24,26,0.95)',
  },
  light: {
    axis: '#9aa2a6',
    grid: 'rgba(0,0,0,0.09)',
    text: '#5a6468',
    title: '#1c2124',
    mark: '#9c7c14',
    markDim: 'rgba(156, 124, 20, 0.55)',
    cursor: 'rgba(0,0,0,0.35)',
    cursorOutline: '#2a2f31',
    tooltipBg: 'rgba(255,255,255,0.96)',
  },
};

export let COLOR_AXIS  = CHART_THEMES.dark.axis;
export let COLOR_GRID  = CHART_THEMES.dark.grid;
export let COLOR_TEXT  = CHART_THEMES.dark.text;
export let COLOR_TITLE = CHART_THEMES.dark.title;
export let COLOR_MARK  = CHART_THEMES.dark.mark;
export let COLOR_MARK_DIM = CHART_THEMES.dark.markDim;
export let COLOR_CURSOR = CHART_THEMES.dark.cursor;
export let COLOR_CURSOR_OUTLINE = CHART_THEMES.dark.cursorOutline;
export let COLOR_TOOLTIP_BG = CHART_THEMES.dark.tooltipBg;

// Series colors were tuned for the dark background, and callers (app.js) pass
// them as literals -- rather than rewire every call site, draw code funnels
// series colors through themedColor(), which darkens the known palette entries
// so they keep contrast on the light chart background. Unknown colors pass
// through untouched.
const LIGHT_SERIES_MAP = {
  '#3ecf6e': '#178f47', // accent green
  '#9aa0a0': '#5f696c', // gray (Target RPM)
  '#e0c341': '#9c7c14', // gold (Duty, overlay 1)
  '#5aa9e6': '#2277c9', // blue (FFT, overlay 2)
  '#e0704a': '#c04e28', // orange (overlay 3)
  '#b57edc': '#8a4fc0', // purple (overlay 4)
  '#4ad9c1': '#12907c', // teal (overlay 5)
  '#e05a8f': '#c02a63', // pink (overlay 6)
};
let chartThemeName = 'dark';
export function themedColor(color) {
  if (chartThemeName === 'light') return LIGHT_SERIES_MAP[color] || color;
  return color;
}

// Every live chart instance (RollingChart + BodeChart), so a theme switch can
// repaint charts that only redraw on interaction (sweep, bump, log summary).
export const chartRegistry = new Set();

export function setChartTheme(name) {
  const t = CHART_THEMES[name] || CHART_THEMES.dark;
  chartThemeName = CHART_THEMES[name] ? name : 'dark';
  COLOR_AXIS = t.axis;
  COLOR_GRID = t.grid;
  COLOR_TEXT = t.text;
  COLOR_TITLE = t.title;
  COLOR_MARK = t.mark;
  COLOR_MARK_DIM = t.markDim;
  COLOR_CURSOR = t.cursor;
  COLOR_CURSOR_OUTLINE = t.cursorOutline;
  COLOR_TOOLTIP_BG = t.tooltipBg;
  for (const chart of chartRegistry) chart.draw();
}

const CHART_FONT = '11px Segoe UI, sans-serif';
const CHART_TITLE_FONT = '600 12px Segoe UI, sans-serif';

// Width reserved for the y tick labels, as a WORST-CASE TEMPLATE rather than
// the width of the labels currently on the axis.
//
// Measuring the current labels is the obvious thing and it is wrong on a live
// chart: an autoscaling axis changes its widest label as the data grows
// ("0.40" gains a minus sign the first time the trace dips negative; "500.0"
// becomes "2000" during spin-up), so the left margin -- and with it the whole
// plot box -- shifted by a few pixels every time the axis rescaled. On a
// streaming chart that reads as a constant squish/expand.
//
// This template is the widest string formatTick can produce for any axis in
// this app (see formatTick's three branches: "-999.9" is wider than either
// "-9.99" or "-3400"), so the box is pinned for the whole run. Two bonuses:
// stacked pairs that are meant to be read against each other -- rpm/duty, and
// the sweep's amplitude/phase -- now share one left margin, so their x-axes
// line up. max() below keeps a pathological domain (values in the millions)
// from colliding anyway, at the cost of stability only in that case.
const TICK_RESERVE_TEMPLATE = '-000.0';

// Shared frame layout for both chart classes (RollingChart + BodeChart), which
// draw identical furniture around their plot areas.
//
// The margins are MEASURED from the text that has to fit in them rather than
// fixed, because fixed ones collide as soon as the text grows: a "200.0" y tick
// label overran the 44px left margin and printed straight through the rotated
// "Duty (0-255)" axis title, and a long chart title ran into the legend. So the
// left margin is sized from the widest tick label the current y-domain will
// produce, and a title/legend that won't fit on one row puts the legend on its
// own row underneath (growing the top strip to match).
//
// Draws the title, legend and both axis titles as a side effect, and returns
// the plot-area geometry the caller needs for everything inside the axes.
export function layoutChartFrame(ctx, {
  w, h, title = '', xLabel = '', yLabel = '', yTicks = [], legend = [],
} = {}) {
  ctx.font = CHART_FONT;
  const yTitleBand = yLabel ? 17 : 0;                    // rotated axis title
  const tickW = Math.max(
    ctx.measureText(TICK_RESERVE_TEMPLATE).width,        // fixed reserve -- see above
    yTicks.reduce((mx, v) => Math.max(mx, ctx.measureText(formatTick(v)).width), 0),
  );
  const padLeft = Math.ceil(yTitleBand + tickW + 10);    // + 6px tick gap + 4px edge
  const padRight = 10;
  const padBottom = xLabel ? 34 : 20;                    // tick row + axis title row

  ctx.font = CHART_TITLE_FONT;
  const titleW = title ? ctx.measureText(title).width : 0;
  ctx.font = CHART_FONT;
  const labeled = legend ? [...legend].filter((s) => s && s.label) : [];
  const itemW = labeled.map((s) => ctx.measureText(s.label).width + 16);
  const legendW = itemW.reduce((a, b) => a + b, 0);
  const legendWrapped = !!title && legendW > 0 &&
                        titleW + 14 + legendW > Math.max(1, w - padLeft - padRight);
  const padTop = title ? (legendWrapped ? 44 : 28) : (legendW ? 24 : 16);

  const plotW = Math.max(1, w - padLeft - padRight);
  const plotH = Math.max(1, h - padTop - padBottom);
  const x0 = padLeft, y0 = padTop;

  if (title) {
    ctx.font = CHART_TITLE_FONT;
    ctx.fillStyle = COLOR_TITLE;
    ctx.textAlign = 'left';
    ctx.fillText(title, x0, 11);
  }

  ctx.font = CHART_FONT;
  if (legendW) {
    const ly = legendWrapped ? 28 : 11;
    let sx = x0 + plotW - legendW;
    ctx.textAlign = 'left';
    labeled.forEach((s, i) => {
      ctx.fillStyle = themedColor(s.color);
      ctx.fillRect(sx, ly - 4, 9, 9);
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText(s.label, sx + 13, ly);
      sx += itemW[i];
    });
  }

  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  if (xLabel) ctx.fillText(xLabel, x0 + plotW / 2, y0 + plotH + 26);
  if (yLabel) {
    ctx.save();
    ctx.translate(Math.round(yTitleBand / 2), y0 + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  return { x0, y0, plotW, plotH };
}

export class RollingChart {
  constructor(canvas, {
    title = '',
    xLabel = 'Time (s)',
    yLabel = '',
    series = [{ label: '', color: '#3ecf6e' }],
    maxPoints = 400,
    yMin, yMax,
    autoScaleY = true,
    windowSeconds,
    // push()'s first argument is divided by this to get plotted x units --
    // 1000 (default) treats it as milliseconds, like device time_ms or a
    // demo elapsed-ms counter. Pass 1 to plot already-in-natural-units
    // values directly (e.g. frequency in Hz for an FFT chart).
    xScale = 1000,
  } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.title = title;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    this.series = series;
    this.maxPoints = maxPoints;
    this.yMin = yMin;
    this.yMax = yMax;
    this.autoScaleY = autoScaleY;
    this.xScale = xScale;
    // Fixed-width sliding window (like an oscilloscope's roll mode): once
    // full, push() evicts samples older than windowSeconds behind the
    // latest one, so the visible span continuously creeps forward one
    // sample at a time instead of autoscaling to whatever's buffered.
    this.windowSeconds = windowSeconds;
    this.t = [];
    this.data = series.map(() => []);
    // Optional FFT/spectrum-style peak markers -- see setPeaks().
    this.peaks = [];
    // MATLAB-style data cursor (mirrors BodeChart's): nearest point under
    // the mouse, or null. _layout holds the last draw()'s pixel<->data
    // mapping so mousemove (outside draw()) can hit-test without
    // recomputing the axis domain from scratch.
    this._hover = null;
    this._layout = null;
    // Mouse-wheel zoom (MATLAB-style): null means auto-fit (the rolling
    // window / autoscale behavior above), like today; scrolling over the
    // plot area sets an explicit {min,max} window that overrides it until
    // resetZoom() (double-click). Note this "wins" over windowSeconds'
    // auto-scroll too -- on a continuously-live chart, zooming pins the
    // view to a fixed span while new samples keep streaming in behind it,
    // same tradeoff as zooming a live oscilloscope trace.
    this._zoomX = null;
    this._zoomY = null;
    // Left-mouse drag-to-pan (mirrors BodeChart's): null when not dragging.
    // Grabs whatever data point is under the mouse at mousedown and keeps
    // it under the mouse as it moves.
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

  // Public: set/replace FFT peak markers, e.g. [{x: freqHz, y: amplitude}, ...]
  // from fft.js's findPeaks(). Pass [] to clear.
  setPeaks(peaks) {
    this.peaks = peaks || [];
    this.draw();
  }

  // Public: clear any wheel-zoom, back to auto-fit/auto-scroll.
  resetZoom() {
    if (!this._zoomX && !this._zoomY) return;
    this._zoomX = null;
    this._zoomY = null;
    this.draw();
  }

  _onWheel(e) {
    if (!this._layout) return;
    const { x0, y0, plotW, plotH, tMin, tSpan, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < x0 || mx > x0 + plotW || my < y0 || my > y0 + plotH) return;
    e.preventDefault();

    const dataX = tMin + ((mx - x0) / plotW) * tSpan;
    const dataY = yMax - ((my - y0) / plotH) * (yMax - yMin);
    const factor = e.deltaY < 0 ? 0.85 : 1 / 0.85; // scroll up/away = zoom in
    const xFrac = (dataX - tMin) / tSpan;
    const yFrac = (dataY - yMin) / (yMax - yMin);
    const newXSpan = tSpan * factor;
    const newYSpan = (yMax - yMin) * factor;

    this._zoomX = { min: dataX - newXSpan * xFrac, max: dataX + newXSpan * (1 - xFrac) };
    this._zoomY = { min: dataY - newYSpan * yFrac, max: dataY + newYSpan * (1 - yFrac) };
    this.draw();
  }

  _onDragStart(e) {
    if (e.button !== 0 || !this._layout) return;
    const { x0, y0, plotW, plotH, tMin, tSpan, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < x0 || mx > x0 + plotW || my < y0 || my > y0 + plotH) return;
    e.preventDefault();
    this._pan = {
      startClientX: e.clientX, startClientY: e.clientY,
      startTMin: tMin, startTSpan: tSpan, startYMin: yMin, startYMax: yMax,
      moved: false, // stays false for a plain click (no movement), so it doesn't pin auto-fit/auto-scroll
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
    const { startTMin, startTSpan, startYMin, startYMax } = this._pan;
    const ySpan = startYMax - startYMin;
    const newTMin = startTMin - (startTSpan * dxPixels) / plotW;
    const dy = (ySpan * dyPixels) / plotH;
    this._zoomX = { min: newTMin, max: newTMin + startTSpan };
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
    if (!this._layout || !this.t.length) return;
    const { x0, y0, plotW, plotH, tMin, tSpan, yMin, yMax } = this._layout;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Binary search this.t (always time/frequency-ascending) for the
    // sample nearest the mouse's x position, instead of scanning every
    // point -- matters for the bump test's up-to-40000-sample captures.
    const targetT = tMin + ((mx - x0) / plotW) * tSpan;
    let lo = 0, hi = this.t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < targetT) lo = mid + 1; else hi = mid;
    }
    let idx = lo;
    if (lo > 0 && Math.abs(this.t[lo - 1] - targetT) < Math.abs(this.t[lo] - targetT)) idx = lo - 1;

    // Multi-series charts (e.g. RPM's Target/Measured) share one t[] --
    // pick whichever series is pixel-closest to the mouse's y at that index.
    let best = null, bestDist = Infinity;
    this.data.forEach((s, i) => {
      const v = s[idx];
      if (!Number.isFinite(v)) return;
      const px = x0 + ((this.t[idx] - tMin) / tSpan) * plotW;
      const py = y0 + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
      const d = Math.hypot(px - mx, py - my);
      if (d < bestDist) {
        bestDist = d;
        best = { px, py, dataX: this.t[idx], dataY: v, color: this.series[i].color, label: this.series[i].label };
      }
    });

    const HIT_RADIUS_PX = 20;
    const next = best && bestDist <= HIT_RADIUS_PX ? best : null;
    const prev = this._hover;
    const unchanged = (!next && !prev) ||
      (next && prev && next.dataX === prev.dataX && next.dataY === prev.dataY && next.label === prev.label);
    if (unchanged) return;
    this._hover = next;
    this.draw();
  }

  // Public: call after the canvas becomes visible (e.g. leaving a
  // display:none screen) -- getBoundingClientRect() reports 0x0 while
  // hidden, so a chart built off-screen needs re-measuring here.
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

  // x: the sample's own x-value (device time_ms by default -- see xScale --
  // or already-natural-units like Hz when xScale:1) -- plotted like
  // MATLAB's plot(t, y), rather than assuming uniform sample spacing.
  push(x, ...values) {
    const tS = x / this.xScale;
    this.t.push(tS);
    values.forEach((v, i) => this.data[i].push(v));

    if (this.windowSeconds) {
      // Continuously-sliding fixed-width window (like an oscilloscope's
      // roll mode): evict samples older than windowSeconds behind the
      // latest one every push, instead of a scrolling-then-reset sweep --
      // the lower bound creeps forward one sample at a time (e.g. at
      // t=3.5s it's 0.5s) rather than jumping back to 0 every 3s.
      while (this.t.length > 1 && tS - this.t[0] > this.windowSeconds) {
        this.t.shift();
        this.data.forEach((s) => s.shift());
      }
    } else if (this.t.length > this.maxPoints) {
      this.t.shift();
      this.data.forEach((s) => s.shift());
    }
    if (!this._deferDraw) this.draw();
  }

  // Batch mode: while active, push() accumulates points WITHOUT redrawing.
  // A full canvas redraw per push is fine for live streams (a few points per
  // frame) but catastrophic for bulk loads -- the bump dump pushes ~11k rows,
  // and 11k synchronous redraws block the main thread long enough to stall the
  // serial read loop and make the board drop data. beginBatch()/endBatch()
  // wrap such loads so the chart draws once at the end. (Calling draw()
  // directly still works mid-batch, e.g. for a throttled live preview.)
  beginBatch() { this._deferDraw = true; }
  endBatch() { this._deferDraw = false; this.draw(); }

  clear() {
    this.t = [];
    this.data = this.series.map(() => []);
    this.peaks = [];
    this._hover = null;
    this._zoomX = null;
    this._zoomY = null;
    this._deferDraw = false; // never leave a cleared chart stuck in batch mode
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    // ---- Y domain + ticks ----
    // Resolved BEFORE the layout below, because the widest tick label is what
    // decides how much left margin the axes need -- a fixed padLeft ran wide
    // labels ("200.0") straight through the rotated y-axis title.
    //
    // Wheel-zoom (_onWheel) overrides autoscale/fixed-yMin-yMax alike with
    // a user-picked window; resetZoom() (double-click) clears it back.
    let yMin, yMax, yTicks;
    if (this._zoomY) {
      yMin = this._zoomY.min; yMax = this._zoomY.max;
      yTicks = niceTicks(yMin, yMax, 5).ticks.filter((v) => v >= yMin && v <= yMax);
    } else {
      yMin = this.yMin; yMax = this.yMax;
      if (this.autoScaleY || yMin === undefined || yMax === undefined) {
        const all = this.data.flat().filter(Number.isFinite);
        const dataMin = all.length ? Math.min(...all) : 0;
        const dataMax = all.length ? Math.max(...all) : 1;
        const nice = niceTicks(dataMin, dataMax, 5);
        yMin = nice.min; yMax = nice.max; yTicks = nice.ticks;
      } else {
        yTicks = niceTicks(yMin, yMax, 5).ticks.filter((v) => v >= yMin && v <= yMax);
      }
    }
    if (yMax === yMin) yMax = yMin + 1;

    const { x0, y0, plotW, plotH } = layoutChartFrame(ctx, {
      w, h, title: this.title, xLabel: this.xLabel, yLabel: this.yLabel,
      yTicks, legend: this.series,
    });

    // push() already trims to the last windowSeconds when set, so the
    // buffered range itself is the visible span -- no separate fixed
    // domain needed here, unless wheel-zoomed (see _onWheel/resetZoom).
    let tMin, tMax;
    if (this._zoomX) {
      tMin = this._zoomX.min; tMax = this._zoomX.max;
    } else {
      tMin = this.t.length ? this.t[0] : 0;
      tMax = this.t.length ? this.t[this.t.length - 1] : 1;
    }
    const tSpan = (tMax - tMin) || 1;

    // Cached for _onMouseMove's hit-testing (data cursor) -- draw() is the
    // only place that (re)computes the axis domain.
    this._layout = { x0, y0, plotW, plotH, tMin, tSpan, yMin, yMax };

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

    // ---- X ticks + labels (evenly spaced across the visible window) ----
    // Decimal places scale with the visible span so a wheel-zoomed-in view
    // (tSpan can get arbitrarily small) doesn't render duplicate-looking
    // tick labels rounded to the same one decimal place.
    const xTickCount = 5;
    const xDecimals = tSpan < 0.01 ? 4 : tSpan < 1 ? 3 : tSpan < 10 ? 2 : 1;
    ctx.textAlign = 'center';
    for (let i = 0; i <= xTickCount; i++) {
      const tv = tMin + (tSpan * i) / xTickCount;
      const x = x0 + (plotW * i) / xTickCount;
      ctx.strokeStyle = COLOR_GRID;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + plotH); ctx.stroke();
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText(tv.toFixed(xDecimals), x, y0 + plotH + 12);
    }

    // ---- Axis box ----
    ctx.strokeStyle = COLOR_AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + plotH); ctx.lineTo(x0 + plotW, y0 + plotH);
    ctx.stroke();

    // ---- Series traces ----
    if (this.t.length >= 2) {
      this.data.forEach((s, i) => {
        ctx.strokeStyle = themedColor(this.series[i].color);
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        for (let idx = 0; idx < s.length; idx++) {
          const x = x0 + ((this.t[idx] - tMin) / tSpan) * plotW;
          const y = y0 + plotH - ((s[idx] - yMin) / (yMax - yMin)) * plotH;
          idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    }

    // ---- Peak markers (e.g. FFT peaks from fft.js's findPeaks()) ----
    if (this.peaks.length) {
      ctx.save();
      ctx.font = '600 10px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      this.peaks.forEach((p) => {
        if (p.x < tMin || p.x > tMin + tSpan) return;
        const px = x0 + ((p.x - tMin) / tSpan) * plotW;
        const py = y0 + plotH - ((p.y - yMin) / (yMax - yMin)) * plotH;
        ctx.fillStyle = COLOR_MARK;
        ctx.beginPath();
        ctx.moveTo(px, py - 8);
        ctx.lineTo(px - 4, py - 1);
        ctx.lineTo(px + 4, py - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillText(`${formatTick(p.x)} Hz`, px, Math.max(py - 13, y0 + 9));
      });
      ctx.restore();
    }

    // ---- MATLAB-style data cursor: crosshair + highlighted point + value
    // box for whatever point _onMouseMove last snapped to ----
    if (this._hover) {
      const { px, py, dataX, dataY, color, label } = this._hover;
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

      // Span-scaled cursor precision (see formatCursor) -- axis-tick rounding
      // is too coarse for reading peak spacings off a zoomed-in trace.
      const line1 = `${this.xLabel}: ${formatCursor(dataX, tSpan)}`;
      const line2 = `${label || this.yLabel}: ${formatCursor(dataY, yMax - yMin)}`;
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

export function formatTick(v) {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// Like formatTick, but for the DATA CURSOR, where the whole point is reading an
// exact value -- formatTick's axis-label precision (2 decimals under 10) turns
// t=2.5041 s into "2.51", which is useless when you're measuring a pulse-to-peak
// gap of a few ms.
//
// Precision is derived from the currently VISIBLE span rather than fixed, so it
// adapts to whatever the axis actually holds (seconds, RPM, degrees, g) AND
// sharpens automatically as you wheel-zoom in -- ~4 significant digits across
// the visible range, capped at 6 decimals so it never turns into float noise.
export function formatCursor(v, span) {
  if (!isFinite(v)) return '—';
  const s = Math.abs(span) > 0 ? Math.abs(span) : Math.abs(v) || 1;
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(s)) + 4));
  return v.toFixed(decimals);
}

// "Nice number" tick algorithm (Heckbert) -- picks human-friendly axis
// bounds/step (1/2/5 x 10^n) instead of scaling exactly to the data's
// raw min/max, same as MATLAB's default axis autoscaling.
function niceNum(range, round) {
  if (range === 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

export function niceTicks(min, max, maxTicks = 5) {
  if (min === max) { min -= 1; max += 1; }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (maxTicks - 1), true);
  // Nudge before rounding outward. Data whose extreme lands EXACTLY on a tick
  // rarely divides exactly in floating point -- 0.3/0.1 is 3.0000000000000004,
  // so a bare Math.ceil jumps to 4 and the axis gains a whole empty step (a
  // 0-0.3 s trace drawn on a 0-0.4 s axis). The error is ~1e-16 relative, so a
  // 1e-9 tolerance kills it without ever swallowing a real data point: nothing
  // that far inside a tick is distinguishable on screen anyway.
  const EPS = 1e-9;
  const niceMin = Math.floor(min / step + EPS) * step;
  const niceMax = Math.ceil(max / step - EPS) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, min: niceMin, max: niceMax };
}
