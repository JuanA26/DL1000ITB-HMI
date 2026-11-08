// MATLAB-style axes for every canvas chart in the HMI.
//
// All charts -- the live strip charts, Log Summary, Sweep/Bode, Bump Test,
// Free Vibration, and every plot in the Figures tab -- draw through this one
// base class, so they look and behave like a MATLAB figure:
//
//   look      white axes, `box on` with inward ticks on all four sides,
//             `grid on`, Helvetica/Arial, a centred bold title, a legend
//             inside the axes (or above them for the small live charts),
//             MATLAB's default colour order, MATLAB datatips (X / Y rows).
//
//   toolbar   MATLAB's axes toolbar (R2018b+): appears top-right while the
//             mouse is over the chart -- Export, Data Tips, Pan, Zoom In,
//             Zoom Out, Restore View -- with MATLAB's behaviours:
//               Zoom In : click = zoom 2x about that point (Shift-click = out);
//                         drag a box = zoom to the box; drag a near-horizontal
//                         line = zoom the X axis only; a near-vertical line =
//                         zoom the Y axis only (MATLAB's constrained zoom).
//               Zoom Out: click = zoom 2x out about that point, never past the
//                         original view.
//               Pan     : drag to move the view.
//               Data Tips: click a point to pin a tip; click a tip to delete it.
//               Restore View / double-click: back to the original limits.
//
//   default   with no tool selected (MATLAB's default interactions): scroll
//             to zoom about the cursor, drag to pan, hover for a data tip,
//             click to pin it, double-click to restore the view, right-click
//             for a context menu (restore, delete tips, save/copy image).
//
// Subclasses own the data and implement the hooks in the "Subclass hooks"
// block below (RollingChart in chart.js, BodeChart in bode-chart.js). The base
// never draws in its constructor: subclasses call this._start() once their own
// fields exist.

// ---- Style -------------------------------------------------------------
// MATLAB defaults: axes/ticks/labels [0.15 0.15 0.15], grid the same colour at
// GridAlpha 0.15, white axes, black bold title, lines in the default colour order.
export const MATLAB_COLORS = ['#0072bd', '#d95319', '#edb120', '#7e2f8e', '#77ac30', '#4dbeee', '#a2142f'];
export const MATLAB_STYLE = {
  background: '#ffffff',
  axis: '#262626',
  grid: 'rgba(38, 38, 38, 0.15)',
  text: '#262626',
  title: '#000000',
  ref: '#262626',                       // xline / yline reference lines
  tipBorder: '#c4c4c4',                 // datatip box (light grey edge, as MATLAB draws it)
  tipLabel: '#404040',
  tipValue: '#163e6b',                  // datatip values: bold dark blue
  tipMarker: '#1a1a1a',
  font: 'Helvetica, Arial, sans-serif',
};
const FONT_TICK = `11px ${MATLAB_STYLE.font}`;
const FONT_LABEL = `12px ${MATLAB_STYLE.font}`;
const FONT_TITLE = `bold 13px ${MATLAB_STYLE.font}`;
const FONT_SMALL = `11px ${MATLAB_STYLE.font}`;
const FONT_SMALL_BOLD = `bold 11px ${MATLAB_STYLE.font}`;

// Worst-case y tick label for the left margin, so a live chart's plot box
// doesn't shift a few pixels every time its autoscaling axis gains a minus sign
// or a digit (that read as a constant squish/expand while streaming).
const TICK_RESERVE = '-000.0';

// Every chart instance, so a theme switch (or anything else global) can repaint.
export const chartRegistry = new Set();

// ---- Ticks ---------------------------------------------------------------
// "Nice number" tick algorithm (Heckbert): 1/2/5 x 10^n steps, limits rounded
// outward to whole steps -- the same shape as MATLAB's automatic limits.
function niceNum(range, round) {
  if (range === 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let f;
  if (round) f = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else f = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return f * Math.pow(10, exponent);
}

export function niceTicks(min, max, maxTicks = 5) {
  if (min === max) { min -= 1; max += 1; }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (maxTicks - 1), true);
  // Nudge before rounding outward: 0.3/0.1 is 3.0000000000000004 in floating
  // point, and a bare ceil would add a whole empty step to the axis.
  const EPS = 1e-9;
  const niceMin = Math.floor(min / step + EPS) * step;
  const niceMax = Math.ceil(max / step - EPS) * step;
  const decimals = tickDecimals(step) + 2;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Number(v.toFixed(decimals)));
  return { ticks, min: niceMin, max: niceMax, step };
}

// Decimals a tick step needs (steps are 1/2/5 x 10^n): 0.1 -> 1, 0.05 -> 2, 5 -> 0.
export function tickDecimals(step) {
  if (!(step > 0) || !isFinite(step)) return 0;
  return Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
}

// MATLAB tick label: just the digits the step needs, trailing zeros dropped --
// "5", "5.1", "5.2" ... "6", as in MATLAB, not "5.00".
export function formatTickLabel(v, step) {
  let s = v.toFixed(tickDecimals(step));
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

// Kept for older callers: axis-label precision by magnitude.
export function formatTick(v) {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// Kept for older callers: ~4 significant digits across the visible span.
export function formatCursor(v, span) {
  if (!isFinite(v)) return '—';
  const s = Math.abs(span) > 0 ? Math.abs(span) : Math.abs(v) || 1;
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(s)) + 4));
  return v.toFixed(decimals);
}

// MATLAB datatip value: up to 6 significant digits, trailing zeros dropped --
// "5.5475", "-6.86397", "0.00430677", exactly how MATLAB prints them.
export function formatTipValue(v) {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  return String(Number(v.toPrecision(6)));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Toolbar icons (16x16 box, drawn with canvas paths) --------------------
const ICON_HAND = new Path2D(
  'M5.3 7.4V3.7a1 1 0 0 1 2 0V7 M7.3 6.6V2.7a1 1 0 0 1 2 0V7 ' +
  'M9.3 7V3.7a1 1 0 0 1 2 0V8 M11.3 6a1 1 0 0 1 2 0v3c0 2.4-1.9 4.3-4.3 4.3H8.2' +
  'c-1.3 0-2.4-.6-3.1-1.6L2.7 9.1a1 1 0 0 1 1.5-1.3L5.3 9V7.4');

function drawIcon(ctx, id, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.3;
  const magnifier = () => {
    ctx.beginPath(); ctx.arc(6.5, 6.5, 4.6, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(10, 10); ctx.lineTo(14.2, 14.2); ctx.stroke();
    ctx.lineWidth = 1.3;
  };
  switch (id) {
    case 'zoomin':
      magnifier();
      ctx.beginPath(); ctx.moveTo(4.3, 6.5); ctx.lineTo(8.7, 6.5); ctx.moveTo(6.5, 4.3); ctx.lineTo(6.5, 8.7); ctx.stroke();
      break;
    case 'zoomout':
      magnifier();
      ctx.beginPath(); ctx.moveTo(4.3, 6.5); ctx.lineTo(8.7, 6.5); ctx.stroke();
      break;
    case 'pan':
      ctx.lineWidth = 1.2;
      ctx.stroke(ICON_HAND);
      break;
    case 'datatip':
      ctx.strokeRect(6.5, 1.5, 8, 6.5);
      ctx.beginPath(); ctx.moveTo(8.3, 3.8); ctx.lineTo(12.7, 3.8); ctx.moveTo(8.3, 5.8); ctx.lineTo(11.5, 5.8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(6.5, 8); ctx.lineTo(3.6, 12.4); ctx.stroke();
      ctx.beginPath(); ctx.arc(3.2, 13, 1.7, 0, 2 * Math.PI); ctx.fill();
      break;
    case 'restore':
      ctx.beginPath(); ctx.moveTo(1.8, 8.2); ctx.lineTo(8, 2.3); ctx.lineTo(14.2, 8.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(3.8, 6.6); ctx.lineTo(3.8, 13.7); ctx.lineTo(12.2, 13.7); ctx.lineTo(12.2, 6.6); ctx.stroke();
      ctx.strokeRect(6.6, 9.6, 2.8, 4.1);
      break;
    case 'export':
      ctx.beginPath(); ctx.moveTo(2.5, 8.5); ctx.lineTo(2.5, 13.5); ctx.lineTo(12, 13.5); ctx.lineTo(12, 8.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(7.2, 10.5); ctx.lineTo(7.2, 2.5); ctx.moveTo(4.4, 5.2); ctx.lineTo(7.2, 2.4); ctx.lineTo(10, 5.2); ctx.stroke();
      // small down-arrow: this button opens a menu
      ctx.beginPath(); ctx.moveTo(13.2, 11.2); ctx.lineTo(16, 11.2); ctx.lineTo(14.6, 13); ctx.closePath(); ctx.fill();
      break;
    default: break;
  }
  ctx.restore();
}

const TOOLBAR = [
  { id: 'export', label: 'Export' },
  { id: 'datatip', label: 'Data Tips', toggle: true },
  { id: 'pan', label: 'Pan', toggle: true },
  { id: 'zoomin', label: 'Zoom In', toggle: true },
  { id: 'zoomout', label: 'Zoom Out', toggle: true },
  { id: 'restore', label: 'Restore View' },
];
const TB_BTN = 22;      // button size (px)
const TB_GAP = 1;
const TIP_PIN_DELAY_MS = 250;   // a click pins a tip only if it isn't the first half of a double-click

export class MatlabAxes {
  constructor(canvas, {
    title = '',
    xLabel = '',
    yLabel = '',
    legend = 'auto',            // 'auto' (shown for >= 2 labelled series) | true | false
    legendLocation = 'best',    // 'best' | 'northeast' | 'northwest' | 'southeast' | 'southwest' | 'northoutside'
    toolbar = true,
    dataTips = true,
    yFixed = null,              // {min,max}: fixed y limits when not zoomed (MATLAB ylim([a b]))
    yTicks = null,              // explicit y tick values (MATLAB yticks([...]))
    exportName = '',            // file name stem for Save as PNG (default: the title)
    zoomMode = 'xy',            // scroll-wheel zoom / pan axes: 'xy' (MATLAB default) or 'x'
  } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.title = title;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    this.legend = legend;
    this.legendLocation = legendLocation;
    this.toolbar = toolbar;
    this.dataTips = dataTips;
    this.yFixed = yFixed;
    this.yTicks = yTicks;
    this.exportName = exportName;
    this.zoomMode = zoomMode;

    this.mode = 'none';         // 'none' | 'datatip' | 'pan' | 'zoomin' | 'zoomout'
    // Manual limits set by zoom/pan; null = automatic (fit the data, or yFixed).
    this._zoomX = null;
    this._zoomY = null;
    // Pinned datatips, in DATA coordinates so they stay on the trace through
    // zoom/pan: { series, x, y, xOnly }.
    this.tips = [];
    this._hover = null;         // hover preview: nearest point under the mouse
    this._view = null;          // last draw's pixel <-> data mapping
    this._drag = null;
    this._pendingTip = null;
    this._mouseInside = false;
    this._tbHover = null;
    this._tbRects = [];
    this._menu = null;
    this._menuRects = [];
    this._flash = null;         // short status note drawn in the corner ("Copied")
    this._legendLoc = null;
    this._linkedX = new Set();
    this._exporting = false;
  }

  // Subclasses call this at the end of their constructor.
  _start() {
    const c = this.canvas;
    // One AbortController owns every listener, so destroy() can drop them all.
    this._listeners = new AbortController();
    const signal = this._listeners.signal;
    c.addEventListener('mousemove', (e) => this._onMove(e), { signal });
    c.addEventListener('mouseleave', () => this._onLeave(), { signal });
    c.addEventListener('mousedown', (e) => this._onDown(e), { signal });
    c.addEventListener('dblclick', (e) => this._onDblClick(e), { signal });
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false, signal });
    c.addEventListener('contextmenu', (e) => this._onContextMenu(e), { signal });
    window.addEventListener('mousemove', (e) => this._onWindowMove(e), { signal });
    window.addEventListener('mouseup', (e) => this._onUp(e), { signal });
    // A click anywhere else closes an open menu.
    window.addEventListener('mousedown', (e) => {
      if (this._menu && e.target !== this.canvas) { this._menu = null; this.draw(); }
    }, { signal });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._menu) { this._menu = null; this.draw(); }
    }, { signal });
    chartRegistry.add(this);
    // Re-measure whenever the canvas changes size -- including the moment a
    // hidden modal or figure tab becomes visible (it measures 0x0 while hidden).
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(c);
    }
    window.addEventListener('resize', () => this._resize(), { signal });
    this._resize();
  }

  // Detaches the chart for good (a closed figure): listeners, observer and the
  // registry entry. The canvas itself is left for the caller to remove.
  destroy() {
    this._cancelPendingTip?.();
    clearTimeout(this._flashTimer);
    this._listeners?.abort();
    this._ro?.disconnect();
    chartRegistry.delete(this);
    for (const c of this._linkedX) c._linkedX.delete(this);
    this._linkedX.clear();
  }

  // ======================= Subclass hooks =======================
  // Raw data extent over everything plotted: {xMin, xMax, yMin, yMax} or null.
  _extent() { return null; }
  // Automatic limits from that extent (default: MATLAB-style "nice" limits).
  _autoXLim(ext, n) { return this._niceLim(ext.xMin, ext.xMax, n); }
  _autoYLim(ext, n) { return this._niceLim(ext.yMin, ext.yMax, n); }
  // Reference lines etc. drawn under the data (clipped to the axes).
  _drawUnder(_ctx, _v) {}
  // The data itself (clipped to the axes).
  _drawData(_ctx, _v) {}
  // Markers/labels drawn over the data (not clipped).
  _drawOver(_ctx, _v) {}
  // Legend rows: [{ label, color, lineStyle, lineWidth, marker }].
  _legendEntries() { return []; }
  // Nearest data point to (mx, my): { px, py, x, y, series, color, xOnly } or null.
  _hitTest(_mx, _my, _v) { return null; }
  // Visits a bounded sample of plotted points in pixels (for legend 'best').
  _forEachSample(_v, _cb) {}
  // =============================================================

  // Auto limits rounded out to whole tick steps. Carries its own ticks: the
  // ticks of an already-rounded range can come out on a different step (0-0.06
  // with ticks 0, 0.05), which MATLAB never does.
  _niceLim(min, max, n) {
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    const t = niceTicks(min, max, n);
    return t.max > t.min ? { min: t.min, max: t.max, ticks: t.ticks, step: t.step } : { min: t.min - 1, max: t.min + 1 };
  }

  // Public: the y limits this chart's auto-scaling would pick for [min, max] at
  // its current size -- lets a caller size a reference trace (the Log Summary's
  // pulse level) so the axis stays snug.
  niceYLimits(min, max) {
    const plotH = Math.max(10, (this.h || 300) - this._padTop() - this._padBottom());
    return this._niceLim(min, max, this._nYTicks(plotH));
  }

  _nYTicks(plotH) { return clamp(Math.round(plotH / 45) + 1, 3, 11); }
  _nXTicks(plotW) { return clamp(Math.round(plotW / 80) + 1, 3, 12); }
  _padTop() {
    const legendRow = this._legendVisible() && this.legendLocation === 'northoutside' ? 17 : 0;
    return (this.title ? 26 : 10) + legendRow;
  }
  _padBottom() { return 20 + (this.xLabel ? 17 : 0); }

  _legendVisible() {
    if (this.legend === false) return false;
    const n = this._legendEntries().length;
    return this.legend === true ? n > 0 : n >= 2;
  }

  // ---- Public API ----
  resize() { this._resize(); }

  // Restore View: back to automatic limits (and the linked axes' x too).
  resetZoom() {
    const hadX = !!this._zoomX;
    if (!this._zoomX && !this._zoomY) { this.draw(); return; }
    this._zoomX = null;
    this._zoomY = null;
    if (hadX) for (const c of this._linkedX) { c._zoomX = null; c.draw(); }
    this.draw();
  }

  clearTips() {
    this._cancelPendingTip();
    if (!this.tips.length) return;
    this.tips = [];
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
    this._hover = null;
    this.draw();
  }

  // MATLAB linkaxes(...,'x'): zoom/pan/restore on either chart moves both x axes.
  linkX(other) {
    if (!other || other === this) return;
    this._linkedX.add(other);
    other._linkedX.add(this);
  }

  // Renders the chart without toolbar/hover/menu (pinned tips kept) at `scale`x.
  exportPng({ scale = 2 } = {}) {
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(this.w * scale));
    off.height = Math.max(1, Math.round(this.h * scale));
    const octx = off.getContext('2d');
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    const saved = this.ctx;
    this.ctx = octx;
    this._exporting = true;
    try { this.draw(); } finally { this.ctx = saved; this._exporting = false; this.draw(); }
    return new Promise((resolve) => off.toBlob(resolve, 'image/png'));
  }

  async saveAsPng() {
    const blob = await this.exportPng();
    if (!blob) return;
    const stem = (this.exportName || this.title || 'figure').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'figure';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async copyAsImage() {
    try {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('no clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': this.exportPng() })]);
      this._showFlash('Copied to clipboard');
    } catch {
      this._showFlash('Copy not allowed here — use Save as PNG');
    }
  }

  _showFlash(text) {
    this._flash = text;
    this.draw();
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this._flash = null; this.draw(); }, 1800);
  }

  // ---- Geometry ----
  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H || this.w !== rect.width || this.h !== rect.height) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width;
      this.h = rect.height;
    }
    this.draw();
  }

  _localXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _inPlot(mx, my) {
    const v = this._view;
    return !!v && mx >= v.x0 && mx <= v.x0 + v.plotW && my >= v.y0 && my <= v.y0 + v.plotH;
  }

  _makeView(x0, y0, plotW, plotH, xl, yl) {
    const xs = xl.max - xl.min || 1, ys = yl.max - yl.min || 1;
    return {
      x0, y0, plotW, plotH,
      xMin: xl.min, xMax: xl.max, yMin: yl.min, yMax: yl.max,
      sx: (x) => x0 + ((x - xl.min) / xs) * plotW,
      sy: (y) => y0 + plotH - ((y - yl.min) / ys) * plotH,
      ix: (px) => xl.min + ((px - x0) / plotW) * xs,
      iy: (py) => yl.min + ((y0 + plotH - py) / plotH) * ys,
    };
  }

  _ticksFor(lim, n, fixed) {
    const span = lim.max - lim.min;
    const eps = Math.abs(span) * 1e-9;
    if (Array.isArray(fixed) && fixed.length) {
      const values = fixed.filter((v) => v >= lim.min - eps && v <= lim.max + eps);
      let step = Infinity;
      for (let i = 1; i < fixed.length; i++) step = Math.min(step, Math.abs(fixed[i] - fixed[i - 1]));
      return { values, step: isFinite(step) ? step : 1 };
    }
    const t = niceTicks(lim.min, lim.max, n);
    return { values: t.ticks.filter((v) => v >= lim.min - eps && v <= lim.max + eps), step: t.step };
  }

  // ---- Limits (zoom/pan) ----
  _setLimits(xl, yl) {
    const xChanged = xl !== undefined;
    if (xChanged) this._zoomX = xl;
    if (yl !== undefined) this._zoomY = yl;
    if (xChanged) {
      for (const c of this._linkedX) { c._zoomX = xl ? { ...xl } : null; c.draw(); }
    }
    this.draw();
  }

  _zoomAbout(px, py, factor) {
    const v = this._view;
    if (!v) return;
    const cx = v.ix(px), cy = v.iy(py);
    const nx = { min: cx - (cx - v.xMin) * factor, max: cx + (v.xMax - cx) * factor };
    const ny = { min: cy - (cy - v.yMin) * factor, max: cy + (v.yMax - cy) * factor };
    this._setLimits(nx, this.zoomMode === 'x' ? undefined : ny);
  }

  // Zoom-out click: 2x about the point, but never past the original view
  // (MATLAB's zoom-out stops at the limits the plot started with).
  _zoomOutAbout(px, py) {
    const v = this._view;
    if (!v) return;
    const ext = this._extent();
    const n = this._nXTicks(v.plotW);
    const autoX = ext ? this._autoXLim(ext, n) : { min: 0, max: 1 };
    const autoY = this.yFixed || (ext ? this._autoYLim(ext, this._nYTicks(v.plotH)) : { min: 0, max: 1 });
    const cx = v.ix(px), cy = v.iy(py);
    let nx = { min: cx - (cx - v.xMin) * 2, max: cx + (v.xMax - cx) * 2 };
    let ny = { min: cy - (cy - v.yMin) * 2, max: cy + (v.yMax - cy) * 2 };
    if (nx.max - nx.min >= autoX.max - autoX.min) nx = null;
    else if (nx.min < autoX.min) nx = { min: autoX.min, max: autoX.min + (nx.max - nx.min) };
    else if (nx.max > autoX.max) nx = { min: autoX.max - (nx.max - nx.min), max: autoX.max };
    if (ny.max - ny.min >= autoY.max - autoY.min) ny = null;
    else if (ny.min < autoY.min) ny = { min: autoY.min, max: autoY.min + (ny.max - ny.min) };
    else if (ny.max > autoY.max) ny = { min: autoY.max - (ny.max - ny.min), max: autoY.max };
    this._setLimits(nx, ny);
  }

  // ---- Datatips ----
  _cancelPendingTip() {
    if (this._pendingTip) { clearTimeout(this._pendingTip); this._pendingTip = null; }
  }

  _tipAt(mx, my) {
    const v = this._view;
    if (!v) return -1;
    for (let i = this.tips.length - 1; i >= 0; i--) {
      const t = this.tips[i];
      const px = v.sx(t.x), py = v.sy(t.y);
      if (Math.hypot(px - mx, py - my) <= 6) return i;
      const b = t._box;
      if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return i;
    }
    return -1;
  }

  // Click: delete the tip under the mouse, else pin one on the point under it.
  _clickTip(mx, my, hover) {
    if (!this.dataTips) return;
    const idx = this._tipAt(mx, my);
    if (idx >= 0) { this.tips.splice(idx, 1); this.draw(); return; }
    if (!hover) return;
    this.tips.push({ series: hover.series, x: hover.x, y: hover.y, xOnly: !!hover.xOnly });
    this.draw();
  }

  // ---- Mouse ----
  _toolbarVisible() {
    return this.toolbar && !this._exporting && (this._mouseInside || this.mode !== 'none' || !!this._menu);
  }

  _toolbarAt(mx, my) {
    if (!this._toolbarVisible()) return null;
    for (const r of this._tbRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r.id;
    }
    return null;
  }

  _menuAt(mx, my) {
    for (const r of this._menuRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r.index;
    }
    return -1;
  }

  _updateCursor(mx, my) {
    let c = 'default';
    if (this._menu && this._menuAt(mx, my) >= 0) c = 'pointer';
    else if (this._toolbarAt(mx, my)) c = 'pointer';
    else if (this._inPlot(mx, my)) {
      if (this.mode === 'zoomin') c = 'zoom-in';
      else if (this.mode === 'zoomout') c = 'zoom-out';
      else if (this.mode === 'pan') c = 'grab';
      else c = 'crosshair';
    }
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  _onMove(e) {
    if (this._drag) return;   // the window-level handler owns drags
    const [mx, my] = this._localXY(e);
    let redraw = !this._mouseInside;
    this._mouseInside = true;
    if (this._menu) {
      const idx = this._menuAt(mx, my);
      if (idx !== this._menu.hover) { this._menu.hover = idx; redraw = true; }
    }
    const tb = this._toolbarAt(mx, my);
    if (tb !== this._tbHover) { this._tbHover = tb; redraw = true; }
    let next = null;
    if (!tb && !this._menu && (this.mode === 'none' || this.mode === 'datatip') && this._inPlot(mx, my)) {
      next = this._hitTest(mx, my, this._view);
    }
    const prev = this._hover;
    const same = (!next && !prev) ||
      (next && prev && next.x === prev.x && next.y === prev.y && next.series === prev.series);
    if (!same) { this._hover = next; redraw = true; }
    this._updateCursor(mx, my);
    if (redraw) this.draw();
  }

  _onLeave() {
    if (this._drag) return;
    this._mouseInside = false;
    this._hover = null;
    this._tbHover = null;
    this.draw();
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const [mx, my] = this._localXY(e);
    if (this._menu) {
      const idx = this._menuAt(mx, my);
      const menu = this._menu;
      this._menu = null;
      e.preventDefault();
      if (idx >= 0 && !menu.items[idx].disabled && menu.items[idx].action) menu.items[idx].action();
      this.draw();
      return;
    }
    const tb = this._toolbarAt(mx, my);
    if (tb) { e.preventDefault(); this._onToolbar(tb); return; }
    if (!this._inPlot(mx, my)) return;
    e.preventDefault();
    // Second press of a double-click: the dblclick handler restores the view;
    // don't start a drag or pin a tip for it.
    if (e.detail >= 2) { this._cancelPendingTip(); return; }
    const v = this._view;
    const base = { sx: mx, sy: my, cx: mx, cy: my, clientX: e.clientX, clientY: e.clientY, moved: false };
    if (this.mode === 'zoomin') {
      this._drag = { ...base, kind: 'zoom', shift: e.shiftKey };
    } else if (this.mode === 'zoomout') {
      this._drag = { ...base, kind: 'click', action: 'zoomout' };
    } else if (this.mode === 'datatip') {
      this._drag = { ...base, kind: 'click', action: 'tip', hover: this._hover };
    } else {
      // 'none' and 'pan': drag pans; a click without moving pins a tip ('none' only).
      this._drag = {
        ...base, kind: 'pan', hover: this.mode === 'none' ? this._hover : null,
        lim: { xMin: v.xMin, xMax: v.xMax, yMin: v.yMin, yMax: v.yMax },
      };
    }
  }

  _onWindowMove(e) {
    const d = this._drag;
    if (!d) return;
    const dxp = e.clientX - d.clientX, dyp = e.clientY - d.clientY;
    if (!d.moved && Math.hypot(dxp, dyp) < 3) return;
    d.moved = true;
    const v = this._view;
    if (!v) return;
    if (d.kind === 'pan') {
      this._hover = null;
      const xs = d.lim.xMax - d.lim.xMin, ys = d.lim.yMax - d.lim.yMin;
      const dx = (xs * dxp) / v.plotW, dy = (ys * dyp) / v.plotH;
      const nx = { min: d.lim.xMin - dx, max: d.lim.xMax - dx };
      const ny = { min: d.lim.yMin + dy, max: d.lim.yMax + dy };
      this.canvas.style.cursor = 'grabbing';
      this._setLimits(nx, this.zoomMode === 'x' ? undefined : ny);
    } else if (d.kind === 'zoom') {
      d.cx = clamp(d.sx + dxp, v.x0, v.x0 + v.plotW);
      d.cy = clamp(d.sy + dyp, v.y0, v.y0 + v.plotH);
      this.draw();
    }
  }

  // Which zoom a rubber-band drag means: a box, or (MATLAB's constrained zoom)
  // a near-horizontal line = X only, a near-vertical line = Y only.
  static zoomKind(dx, dy) {
    if (dx < 4 && dy < 4) return 'click';
    if (dy <= Math.max(8, dx * 0.12)) return 'x';
    if (dx <= Math.max(8, dy * 0.12)) return 'y';
    return 'box';
  }

  _onUp(e) {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    const v = this._view;
    if (d.kind === 'pan') {
      this._updateCursorFromEvent(e);
      if (!d.moved && d.hover !== undefined && this.mode === 'none') this._deferTip(d.sx, d.sy, d.hover, e);
      return;
    }
    if (d.kind === 'click') {
      if (d.moved) return;
      if (d.action === 'zoomout') this._zoomOutAbout(d.sx, d.sy);
      else if (d.action === 'tip') this._deferTip(d.sx, d.sy, d.hover, e);
      return;
    }
    if (d.kind === 'zoom' && v) {
      const dx = Math.abs(d.cx - d.sx), dy = Math.abs(d.cy - d.sy);
      const kind = MatlabAxes.zoomKind(dx, dy);
      if (kind === 'click' || !d.moved) {
        if (d.shift) this._zoomOutAbout(d.sx, d.sy);
        else this._zoomAbout(d.sx, d.sy, 0.5);
        return;
      }
      const xa = v.ix(Math.min(d.sx, d.cx)), xb = v.ix(Math.max(d.sx, d.cx));
      const ya = v.iy(Math.max(d.sy, d.cy)), yb = v.iy(Math.min(d.sy, d.cy));
      if (kind === 'x') this._setLimits({ min: xa, max: xb }, undefined);
      else if (kind === 'y') this._setLimits(undefined, { min: ya, max: yb });
      else this._setLimits({ min: xa, max: xb }, { min: ya, max: yb });
    }
  }

  _updateCursorFromEvent(e) {
    const [mx, my] = this._localXY(e);
    this._updateCursor(mx, my);
  }

  _deferTip(mx, my, hover, e) {
    if (!this.dataTips) return;
    if (e && e.detail >= 2) { this._cancelPendingTip(); return; }
    this._cancelPendingTip();
    this._pendingTip = setTimeout(() => { this._pendingTip = null; this._clickTip(mx, my, hover); }, TIP_PIN_DELAY_MS);
  }

  _onDblClick(e) {
    const [mx, my] = this._localXY(e);
    if (this._toolbarAt(mx, my) || !this._inPlot(mx, my)) return;
    this._cancelPendingTip();
    this.resetZoom();
  }

  _onWheel(e) {
    const [mx, my] = this._localXY(e);
    if (!this._inPlot(mx, my)) return;   // outside the axes the page scrolls normally
    e.preventDefault();
    const factor = Math.exp(clamp(e.deltaY, -300, 300) * 0.0016);   // one notch (100) ~ 15 %
    this._zoomAbout(mx, my, factor);
  }

  _onContextMenu(e) {
    e.preventDefault();
    const [mx, my] = this._localXY(e);
    this._openMenu(mx, my, [
      { label: 'Restore View', action: () => this.resetZoom() },
      { label: 'Delete All Data Tips', action: () => this.clearTips(), disabled: !this.tips.length },
      { separator: true },
      { label: 'Save as PNG…', action: () => this.saveAsPng() },
      { label: 'Copy as Image', action: () => this.copyAsImage() },
    ]);
  }

  _openMenu(x, y, items) {
    this._menu = { x, y, items, hover: -1 };
    this._hover = null;
    this.draw();
  }

  _onToolbar(id) {
    if (id === 'export') {
      const r = this._tbRects.find((b) => b.id === 'export');
      this._openMenu(r ? r.x : 4, r ? r.y + r.h + 2 : 24, [
        { label: 'Save as PNG…', action: () => this.saveAsPng() },
        { label: 'Copy as Image', action: () => this.copyAsImage() },
      ]);
      return;
    }
    if (id === 'restore') { this.resetZoom(); return; }
    this.setMode(this.mode === id ? 'none' : id);
  }

  // ======================= Drawing =======================
  draw() {
    const ctx = this.ctx;
    const { w, h } = this;
    if (!w || !h) return;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = MATLAB_STYLE.background;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    const ext = this._extent();
    const padTop = this._padTop();
    const padBottom = this._padBottom();
    const plotH = Math.max(10, h - padTop - padBottom);

    // y limits/ticks first: the widest y tick label decides the left margin.
    const nY = this._nYTicks(plotH);
    let yl = this._zoomY || this.yFixed || (ext ? this._autoYLim(ext, nY) : { min: 0, max: 1 });
    if (!(yl.max > yl.min)) yl = { min: yl.min - 1, max: yl.min + 1 };
    const yT = (!this._zoomY && !this.yFixed && yl.ticks && !this.yTicks)
      ? { values: yl.ticks, step: yl.step }
      : this._ticksFor(yl, nY, this._zoomY ? null : this.yTicks);
    ctx.font = FONT_TICK;
    const yLabels = yT.values.map((v) => formatTickLabel(v, yT.step));
    let tickW = ctx.measureText(TICK_RESERVE).width;
    for (const s of yLabels) tickW = Math.max(tickW, ctx.measureText(s).width);
    const padLeft = Math.ceil((this.yLabel ? 19 : 3) + tickW + 7);

    let plotW = Math.max(10, w - padLeft - 16);
    const nX = this._nXTicks(plotW);
    let xl = this._zoomX || (ext ? this._autoXLim(ext, nX) : { min: 0, max: 1 });
    if (!(xl.max > xl.min)) xl = { min: xl.min - 1, max: xl.min + 1 };
    const xT = (!this._zoomX && xl.ticks) ? { values: xl.ticks, step: xl.step } : this._ticksFor(xl, nX, null);
    const xLabels = xT.values.map((v) => formatTickLabel(v, xT.step));
    // Right margin: half the last x label when that tick sits on the right edge.
    let padRight = 10;
    if (xT.values.length) {
      const last = xT.values[xT.values.length - 1];
      if (Math.abs(last - xl.max) <= (xl.max - xl.min) * 0.02) {
        padRight = Math.max(10, Math.ceil(ctx.measureText(xLabels[xLabels.length - 1]).width / 2) + 4);
      }
    }
    plotW = Math.max(10, w - padLeft - padRight);
    const v = this._makeView(padLeft, padTop, plotW, plotH, xl, yl);
    this._view = v;
    const { x0, y0 } = v;

    // ---- grid ----
    ctx.strokeStyle = MATLAB_STYLE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of yT.values) {
      const y = Math.round(v.sy(t)) + 0.5;
      if (y <= y0 + 1 || y >= y0 + plotH - 1) continue;
      ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y);
    }
    for (const t of xT.values) {
      const x = Math.round(v.sx(t)) + 0.5;
      if (x <= x0 + 1 || x >= x0 + plotW - 1) continue;
      ctx.moveTo(x, y0); ctx.lineTo(x, y0 + plotH);
    }
    ctx.stroke();

    // ---- data (clipped to the axes, as MATLAB clips) ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, plotW, plotH);
    ctx.clip();
    this._drawUnder(ctx, v);
    this._drawData(ctx, v);
    ctx.restore();

    // ---- axes box + inward ticks on all four sides (MATLAB `box on`) ----
    ctx.strokeStyle = MATLAB_STYLE.axis;
    ctx.lineWidth = 1;
    const bx = Math.round(x0) + 0.5, by = Math.round(y0) + 0.5;
    const bw = Math.round(plotW), bh = Math.round(plotH);
    ctx.strokeRect(bx, by, bw, bh);
    const tickLen = clamp(Math.round(0.01 * Math.max(plotW, plotH)), 3, 6);
    ctx.beginPath();
    for (const t of yT.values) {
      const y = Math.round(v.sy(t)) + 0.5;
      ctx.moveTo(bx, y); ctx.lineTo(bx + tickLen, y);
      ctx.moveTo(bx + bw, y); ctx.lineTo(bx + bw - tickLen, y);
    }
    for (const t of xT.values) {
      const x = Math.round(v.sx(t)) + 0.5;
      ctx.moveTo(x, by + bh); ctx.lineTo(x, by + bh - tickLen);
      ctx.moveTo(x, by); ctx.lineTo(x, by + tickLen);
    }
    ctx.stroke();

    // ---- tick labels ----
    ctx.fillStyle = MATLAB_STYLE.text;
    ctx.font = FONT_TICK;
    ctx.textAlign = 'right';
    yT.values.forEach((t, i) => ctx.fillText(yLabels[i], x0 - 5, v.sy(t)));
    ctx.textAlign = 'center';
    xT.values.forEach((t, i) => ctx.fillText(xLabels[i], v.sx(t), y0 + plotH + 11));

    // ---- axis labels + title ----
    ctx.font = FONT_LABEL;
    if (this.xLabel) ctx.fillText(this.xLabel, x0 + plotW / 2, y0 + plotH + 28);
    if (this.yLabel) {
      ctx.save();
      ctx.translate(9, y0 + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(this.yLabel, 0, 0);
      ctx.restore();
    }
    if (this.title) {
      ctx.font = FONT_TITLE;
      ctx.fillStyle = MATLAB_STYLE.title;
      ctx.fillText(this.title, x0 + plotW / 2, 13);
    }

    this._drawOver(ctx, v);
    if (this._legendVisible()) this._drawLegend(ctx, v);
    this._drawTips(ctx, v);
    if (!this._exporting) {
      if (this._hover && (this.mode === 'none' || this.mode === 'datatip')) this._drawHover(ctx, v);
      if (this._drag && this._drag.kind === 'zoom' && this._drag.moved) this._drawRubberBand(ctx, v);
      this._drawToolbar(ctx, v);
      if (this._menu) this._drawMenu(ctx);
      if (this._flash) this._drawFlash(ctx, v);
    }
    ctx.restore();
  }

  // ---- Line helper: polyline with NaN gaps and min/max decimation when the
  // trace has many more points than pixels (bump captures: ~11k-40k samples).
  _strokePolyline(ctx, v, n, getX, getY, color, width = 1, dash = null) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    const dense = n > 3 * v.plotW;
    let pen = false;
    if (!dense) {
      for (let i = 0; i < n; i++) {
        const x = getX(i), y = getY(i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
        const px = v.sx(x), py = v.sy(y);
        if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
      }
    } else {
      // One vertical min-max run per pixel column, in drawing order.
      let col = null, first = 0, last = 0, lo = 0, hi = 0;
      const flush = () => {
        if (col === null) return;
        if (pen) ctx.lineTo(col, first); else { ctx.moveTo(col, first); pen = true; }
        ctx.lineTo(col, lo); ctx.lineTo(col, hi); ctx.lineTo(col, last);
      };
      for (let i = 0; i < n; i++) {
        const x = getX(i), y = getY(i);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { flush(); col = null; pen = false; continue; }
        const px = Math.round(v.sx(x)), py = v.sy(y);
        if (px !== col) { flush(); col = px; first = last = lo = hi = py; }
        else { last = py; if (py < lo) lo = py; if (py > hi) hi = py; }
      }
      flush();
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  static dashFor(style) {
    switch (style) {
      case '--': return [6, 4];
      case ':': return [1.5, 3];
      case '-.': return [6, 3, 1.5, 3];
      default: return null;
    }
  }

  // MATLAB xline / yline: dashed reference line with an optional label.
  _drawXLine(ctx, v, x, label, color = MATLAB_STYLE.ref) {
    if (!isFinite(x) || x < v.xMin || x > v.xMax) return;
    const px = Math.round(v.sx(x)) + 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(px, v.y0); ctx.lineTo(px, v.y0 + v.plotH); ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = color;
      const tw = ctx.measureText(label).width;
      const right = px + 4 + tw <= v.x0 + v.plotW - 2;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, right ? px + 4 : px - 4, v.y0 + 10);
    }
    ctx.restore();
  }

  _drawYLine(ctx, v, y, color = MATLAB_STYLE.ref) {
    if (!isFinite(y) || y < v.yMin || y > v.yMax) return;
    const py = Math.round(v.sy(y)) + 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(v.x0, py); ctx.lineTo(v.x0 + v.plotW, py); ctx.stroke();
    ctx.restore();
  }

  // ---- Legend ----
  _drawLegend(ctx, v) {
    const entries = this._legendEntries();
    if (!entries.length) return;
    ctx.save();
    ctx.font = FONT_SMALL;
    const SAMPLE = 22, ROW = 16;
    if (this.legendLocation === 'northoutside') {
      // One horizontal row centred above the axes.
      const widths = entries.map((e) => SAMPLE + 5 + ctx.measureText(e.label).width + 12);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = Math.max(4, v.x0 + v.plotW / 2 - total / 2);
      const y = v.y0 - 9;
      entries.forEach((e, i) => {
        this._legendSample(ctx, e, x, y, SAMPLE);
        ctx.fillStyle = MATLAB_STYLE.text;
        ctx.textAlign = 'left';
        ctx.fillText(e.label, x + SAMPLE + 5, y);
        x += widths[i];
      });
      ctx.restore();
      return;
    }
    let textW = 0;
    for (const e of entries) textW = Math.max(textW, ctx.measureText(e.label).width);
    const bw = Math.ceil(8 + SAMPLE + 6 + textW + 8), bh = 6 + entries.length * ROW;
    const M = 6;
    const corners = {
      northeast: [v.x0 + v.plotW - bw - M, v.y0 + M],
      northwest: [v.x0 + M, v.y0 + M],
      southeast: [v.x0 + v.plotW - bw - M, v.y0 + v.plotH - bh - M],
      southwest: [v.x0 + M, v.y0 + v.plotH - bh - M],
    };
    let loc = this.legendLocation;
    if (loc === 'best') loc = this._bestLegendCorner(v, corners, bw, bh);
    const [lx, ly] = corners[loc] || corners.northeast;
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fillRect(lx, ly, bw, bh);
    ctx.strokeStyle = MATLAB_STYLE.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(lx) + 0.5, Math.round(ly) + 0.5, bw, bh);
    entries.forEach((e, i) => {
      const y = ly + 3 + ROW / 2 + i * ROW;
      this._legendSample(ctx, e, lx + 8, y, SAMPLE);
      ctx.fillStyle = MATLAB_STYLE.text;
      ctx.textAlign = 'left';
      ctx.fillText(e.label, lx + 8 + SAMPLE + 6, y);
    });
    ctx.restore();
  }

  _legendSample(ctx, e, x, y, len) {
    ctx.save();
    ctx.strokeStyle = e.color;
    ctx.lineWidth = Math.min(2, e.lineWidth || 1.2);
    ctx.setLineDash(MatlabAxes.dashFor(e.lineStyle) || []);
    if (e.lineStyle !== 'none') { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke(); }
    ctx.setLineDash([]);
    if (e.marker === 'o') {
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x + len / 2, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // MATLAB 'best': the corner covering the fewest plotted points. Sticky -- it
  // only moves when another corner is clearly better, so a streaming chart's
  // legend doesn't hop around frame to frame.
  _bestLegendCorner(v, corners, bw, bh) {
    const names = ['northeast', 'northwest', 'southeast', 'southwest'];
    const counts = { northeast: 0, northwest: 0, southeast: 0, southwest: 0 };
    this._forEachSample(v, (px, py) => {
      for (const n of names) {
        const [cx, cy] = corners[n];
        if (px >= cx - 2 && px <= cx + bw + 2 && py >= cy - 2 && py <= cy + bh + 2) counts[n]++;
      }
    });
    let best = names[0];
    for (const n of names) if (counts[n] < counts[best]) best = n;
    const cur = this._legendLoc;
    if (cur && counts[cur] !== undefined && !(counts[best] < counts[cur] * 0.6 - 1)) return cur;
    this._legendLoc = best;
    return best;
  }

  // ---- Datatips ----
  _drawTips(ctx, v) {
    for (const t of this.tips) {
      t._box = null;
      if (t.x < v.xMin || t.x > v.xMax || t.y < v.yMin || t.y > v.yMax) continue;
      t._box = this._drawTipBox(ctx, v, v.sx(t.x), v.sy(t.y), t.x, t.y, t.xOnly, null);
    }
  }

  _drawHover(ctx, v) {
    const hv = this._hover;
    // Already pinned? Its tip is showing; don't draw a second box over it.
    if (this.tips.some((t) => t.series === hv.series && t.x === hv.x && t.y === hv.y)) return;
    this._drawTipBox(ctx, v, hv.px, hv.py, hv.x, hv.y, hv.xOnly, hv.color || MATLAB_STYLE.tipMarker);
  }

  // One MATLAB datatip: a dot on the point and a white box beside it with
  // "X <value>" / "Y <value>" rows (values bold blue). `ring` set = the hover
  // preview (dot ringed in the series colour); null = a pinned tip.
  _drawTipBox(ctx, v, px, py, x, y, xOnly, ring) {
    const rows = [['X', formatTipValue(x)]];
    if (!xOnly) rows.push(['Y', formatTipValue(y)]);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.arc(px, py, ring ? 4 : 3.2, 0, 2 * Math.PI);
    ctx.fillStyle = ring || MATLAB_STYLE.tipMarker;
    ctx.fill();
    if (ring) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
    ctx.font = FONT_SMALL;
    const labelW = Math.max(...rows.map(([k]) => ctx.measureText(k).width));
    ctx.font = FONT_SMALL_BOLD;
    const valueW = Math.max(...rows.map(([, s]) => ctx.measureText(s).width));
    const bw = Math.ceil(labelW + 6 + valueW + 14);
    const bh = rows.length * 15 + 7;
    let bx = px + 8, by = py - bh - 8;
    if (bx + bw > v.x0 + v.plotW) bx = px - bw - 8;
    if (bx < v.x0) bx = v.x0 + 2;
    if (by < v.y0) by = py + 8;
    if (by + bh > v.y0 + v.plotH) by = Math.max(v.y0 + 2, v.y0 + v.plotH - bh - 2);
    bx = Math.round(bx) + 0.5; by = Math.round(by) + 0.5;
    ctx.fillStyle = ring ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.97)';
    ctx.strokeStyle = MATLAB_STYLE.tipBorder;
    ctx.lineWidth = 1;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.textAlign = 'left';
    rows.forEach(([k, s], i) => {
      const ty = by + 11 + i * 15;
      ctx.font = FONT_SMALL;
      ctx.fillStyle = MATLAB_STYLE.tipLabel;
      ctx.fillText(k, bx + 7, ty);
      ctx.font = FONT_SMALL_BOLD;
      ctx.fillStyle = MATLAB_STYLE.tipValue;
      ctx.fillText(s, bx + 7 + labelW + 6, ty);
    });
    ctx.restore();
    return { x: bx, y: by, w: bw, h: bh };
  }

  // ---- Zoom rubber band: a box, or a line with end caps for 1-axis zoom ----
  _drawRubberBand(ctx, v) {
    const d = this._drag;
    const dx = Math.abs(d.cx - d.sx), dy = Math.abs(d.cy - d.sy);
    const kind = MatlabAxes.zoomKind(dx, dy);
    ctx.save();
    ctx.strokeStyle = MATLAB_STYLE.axis;
    ctx.lineWidth = 1;
    if (kind === 'x') {
      const y = Math.round(d.sy) + 0.5, a = Math.min(d.sx, d.cx), b = Math.max(d.sx, d.cx);
      ctx.beginPath();
      ctx.moveTo(a, y); ctx.lineTo(b, y);
      ctx.moveTo(a, y - 6); ctx.lineTo(a, y + 6);
      ctx.moveTo(b, y - 6); ctx.lineTo(b, y + 6);
      ctx.stroke();
    } else if (kind === 'y') {
      const x = Math.round(d.sx) + 0.5, a = Math.min(d.sy, d.cy), b = Math.max(d.sy, d.cy);
      ctx.beginPath();
      ctx.moveTo(x, a); ctx.lineTo(x, b);
      ctx.moveTo(x - 6, a); ctx.lineTo(x + 6, a);
      ctx.moveTo(x - 6, b); ctx.lineTo(x + 6, b);
      ctx.stroke();
    } else if (kind === 'box') {
      const x = Math.min(d.sx, d.cx), y = Math.min(d.sy, d.cy);
      ctx.fillStyle = 'rgba(0, 114, 189, 0.08)';
      ctx.fillRect(x, y, dx, dy);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(dx), Math.round(dy));
    }
    ctx.restore();
  }

  // ---- Axes toolbar ----
  _drawToolbar(ctx, v) {
    this._tbRects = [];
    if (!this._toolbarVisible()) return;
    const n = TOOLBAR.length;
    const tw = n * TB_BTN + (n - 1) * TB_GAP + 4;
    const tx = Math.max(2, Math.min(this.w - tw - 2, v.x0 + v.plotW - tw));
    const ty = 1;   // top band: over the title's right end, clear of a legend row
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(Math.round(tx) + 0.5, Math.round(ty) + 0.5, tw, TB_BTN + 4);
    ctx.fill();
    ctx.stroke();
    TOOLBAR.forEach((b, i) => {
      const bx = tx + 2 + i * (TB_BTN + TB_GAP), by = ty + 2;
      const active = b.toggle && this.mode === b.id;
      const hovered = this._tbHover === b.id;
      if (active || hovered) {
        ctx.fillStyle = active ? '#d6e6f7' : '#ebebeb';
        ctx.fillRect(bx, by, TB_BTN, TB_BTN);
        if (active) { ctx.strokeStyle = '#7aa7d6'; ctx.strokeRect(bx + 0.5, by + 0.5, TB_BTN - 1, TB_BTN - 1); }
      }
      drawIcon(ctx, b.id, bx + 3, by + 3, active ? '#0072bd' : '#3c3c3c');
      this._tbRects.push({ id: b.id, x: bx, y: by, w: TB_BTN, h: TB_BTN });
    });
    // Tooltip under the hovered button.
    if (this._tbHover && !this._menu) {
      const b = TOOLBAR.find((t) => t.id === this._tbHover);
      const r = this._tbRects.find((t) => t.id === this._tbHover);
      if (b && r) {
        ctx.font = FONT_SMALL;
        const pad = 5, tw2 = Math.ceil(ctx.measureText(b.label).width) + 2 * pad, th = 18;
        let lx = r.x + r.w / 2 - tw2 / 2;
        lx = Math.max(2, Math.min(this.w - tw2 - 2, lx));
        const ly = r.y + r.h + 6;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#767676';
        ctx.fillRect(Math.round(lx) + 0.5, Math.round(ly) + 0.5, tw2, th);
        ctx.strokeRect(Math.round(lx) + 0.5, Math.round(ly) + 0.5, tw2, th);
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'left';
        ctx.fillText(b.label, lx + pad, ly + th / 2 + 0.5);
      }
    }
    ctx.restore();
  }

  _drawMenu(ctx) {
    const m = this._menu;
    this._menuRects = [];
    ctx.save();
    ctx.font = FONT_SMALL;
    const ROW = 22, SEP = 7;
    let mw = 0;
    for (const it of m.items) if (!it.separator) mw = Math.max(mw, ctx.measureText(it.label).width);
    mw = Math.ceil(mw) + 32;
    let mh = 4;
    for (const it of m.items) mh += it.separator ? SEP : ROW;
    const x = Math.max(2, Math.min(this.w - mw - 2, m.x));
    const y = Math.max(2, Math.min(this.h - mh - 2, m.y));
    ctx.fillStyle = '#f9f9f9';
    ctx.strokeStyle = '#a0a0a0';
    ctx.lineWidth = 1;
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillRect(x, y, mw, mh);
    ctx.shadowColor = 'transparent';
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, mw, mh);
    let cy = y + 2;
    m.items.forEach((it, i) => {
      if (it.separator) {
        ctx.strokeStyle = '#d0d0d0';
        ctx.beginPath(); ctx.moveTo(x + 6, Math.round(cy + SEP / 2) + 0.5); ctx.lineTo(x + mw - 6, Math.round(cy + SEP / 2) + 0.5); ctx.stroke();
        cy += SEP;
        return;
      }
      if (i === m.hover && !it.disabled) {
        ctx.fillStyle = '#d6e6f7';
        ctx.fillRect(x + 2, cy, mw - 4, ROW);
      }
      ctx.fillStyle = it.disabled ? '#a0a0a0' : '#000000';
      ctx.textAlign = 'left';
      ctx.fillText(it.label, x + 14, cy + ROW / 2);
      this._menuRects.push({ index: i, x: x + 2, y: cy, w: mw - 4, h: ROW });
      cy += ROW;
    });
    ctx.restore();
  }

  _drawFlash(ctx, v) {
    ctx.save();
    ctx.font = FONT_SMALL;
    const tw = Math.ceil(ctx.measureText(this._flash).width) + 14;
    const x = v.x0 + 6, y = v.y0 + 6;
    ctx.fillStyle = 'rgba(38,38,38,0.88)';
    ctx.fillRect(x, y, tw, 20);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(this._flash, x + 7, y + 10.5);
    ctx.restore();
  }
}
