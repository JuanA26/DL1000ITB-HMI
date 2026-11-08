// Rolling / one-shot time-series chart (live RPM, duty and accel strips; the
// Bump Test and Free Vibration traces and spectra). Drawn as a MATLAB figure
// through MatlabAxes (js/matlab-axes.js): same look, axes toolbar, zoom tools
// and datatips as every other chart in the HMI.
//
// Data model: one shared x array (`t`) and one y array per series, appended
// with push(x, ...values) -- like MATLAB's plot(t, y) against real sample times
// rather than sample index.
import {
  MatlabAxes, MATLAB_COLORS, MATLAB_STYLE, chartRegistry,
  niceTicks, formatTick, formatCursor, formatTipValue,
} from './matlab-axes.js';

export { niceTicks, formatTick, formatCursor, chartRegistry, MATLAB_COLORS };

// Legacy export (the Log Summary used to opt in to this); every chart is now
// MATLAB-styled, so it only survives for compatibility.
export const MATLAB_PALETTE = {
  background: MATLAB_STYLE.background,
  axis: MATLAB_STYLE.axis,
  grid: MATLAB_STYLE.grid,
  text: MATLAB_STYLE.text,
  title: MATLAB_STYLE.title,
};

// The HMI's light/dark toggle restyles the panels; the charts stay white MATLAB
// figures in both themes (that's the point), so this only repaints them.
export function setChartTheme() {
  for (const chart of chartRegistry) chart.draw();
}

// Identity now (series colours are MATLAB's in every theme); kept for callers.
export function themedColor(color) { return color; }

export class RollingChart extends MatlabAxes {
  constructor(canvas, {
    title = '',
    xLabel = 'Time (s)',
    yLabel = '',
    series = [{ label: '', color: MATLAB_COLORS[0] }],
    maxPoints = 400,
    yMin, yMax,
    autoScaleY = true,
    windowSeconds,
    // push()'s first argument is divided by this to get plotted x units --
    // 1000 (default) treats it as milliseconds, like device time_ms. Pass 1 to
    // plot already-in-natural-units values (seconds, or Hz for a spectrum).
    xScale = 1000,
    // Strip-chart x limits: exactly the buffered span (MATLAB `axis tight` on
    // x). Live charts want this -- "nice" rounded limits would make a scrolling
    // window jump between tick boundaries. One-shot captures keep MATLAB's
    // rounded-out limits (e.g. 0-5 s).
    xTight = false,
    ...axesOpts               // legend, legendLocation, toolbar, dataTips, yTicks, exportName, zoomMode
  } = {}) {
    const yFixed = (!autoScaleY && yMin !== undefined && yMax !== undefined) ? { min: yMin, max: yMax } : null;
    super(canvas, { title, xLabel, yLabel, yFixed, ...axesOpts });
    this.series = series.map((s, i) => ({
      lineStyle: '-', lineWidth: 1.2, ...s, color: s.color || MATLAB_COLORS[i % MATLAB_COLORS.length],
    }));
    this.maxPoints = maxPoints;
    this.yMin = yMin;
    this.yMax = yMax;
    this.autoScaleY = autoScaleY;
    this.xScale = xScale;
    this.xTight = xTight;
    // Fixed-width sliding window (oscilloscope roll mode): push() evicts samples
    // older than windowSeconds behind the latest one.
    this.windowSeconds = windowSeconds;
    this.t = [];
    this.data = series.map(() => []);
    // Spectrum peak markers -- see setPeaks().
    this.peaks = [];
    this._deferDraw = false;
    this._start();
  }

  // Public: set/replace peak markers, e.g. [{x: freqHz, y: amplitude}, ...] from
  // fft.js's findPeaks(). Drawn like MATLAB's findpeaks: inverted triangles.
  setPeaks(peaks) {
    this.peaks = peaks || [];
    this.draw();
  }

  push(x, ...values) {
    const tS = x / this.xScale;
    this.t.push(tS);
    values.forEach((v, i) => this.data[i].push(v));
    let evicted = false;
    if (this.windowSeconds) {
      while (this.t.length > 1 && tS - this.t[0] > this.windowSeconds) {
        this.t.shift();
        this.data.forEach((s) => s.shift());
        evicted = true;
      }
    } else if (this.t.length > this.maxPoints) {
      this.t.shift();
      this.data.forEach((s) => s.shift());
      evicted = true;
    }
    // Datatips pinned on samples that have scrolled out go with them.
    if (evicted && this.tips.length) {
      const t0 = this.t[0];
      this.tips = this.tips.filter((tp) => tp.x >= t0);
    }
    if (!this._deferDraw) this.draw();
  }

  // Batch mode: while active, push() accumulates points WITHOUT redrawing. A
  // redraw per push is fine for live streams but catastrophic for bulk loads
  // (the ~11k-row bump dump): wrap those in beginBatch()/endBatch() so the
  // chart draws once at the end. draw() still works mid-batch for a throttled
  // live preview.
  beginBatch() { this._deferDraw = true; }
  endBatch() { this._deferDraw = false; this.draw(); }

  clear() {
    this.t = [];
    this.data = this.series.map(() => []);
    this.peaks = [];
    this.tips = [];
    this._hover = null;
    this._zoomX = null;
    this._zoomY = null;
    this._cancelPendingTip();
    this._deferDraw = false; // never leave a cleared chart stuck in batch mode
    this.draw();
  }

  // ---- MatlabAxes hooks ----
  _extent() {
    const n = this.t.length;
    if (!n) return null;
    let yMin = Infinity, yMax = -Infinity;
    for (const s of this.data) {
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        if (v < yMin) yMin = v;      // NaN compares false, so it's skipped
        if (v > yMax) yMax = v;
      }
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
    return { xMin: this.t[0], xMax: this.t[n - 1], yMin, yMax };
  }

  _autoXLim(ext, n) {
    if (this.xTight) return ext.xMax > ext.xMin ? { min: ext.xMin, max: ext.xMax } : { min: ext.xMin, max: ext.xMin + 1 };
    return super._autoXLim(ext, n);
  }

  // First index with t[i] >= x (t is ascending).
  _lowerBound(x) {
    let lo = 0, hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _visibleRange(v) {
    const n = this.t.length;
    const i0 = Math.max(0, this._lowerBound(v.xMin) - 1);
    const i1 = Math.min(n, this._lowerBound(v.xMax) + 1);
    return [i0, i1];
  }

  _drawData(ctx, v) {
    if (this.t.length < 2) return;
    const [i0, i1] = this._visibleRange(v);
    const t = this.t;
    this.data.forEach((s, k) => {
      const cfg = this.series[k];
      this._strokePolyline(ctx, v, i1 - i0, (i) => t[i0 + i], (i) => s[i0 + i],
        cfg.color, cfg.lineWidth, MatlabAxes.dashFor(cfg.lineStyle));
    });
  }

  _drawOver(ctx, v) {
    if (!this.peaks.length) return;
    ctx.save();
    ctx.font = `11px ${MATLAB_STYLE.font}`;
    ctx.textBaseline = 'middle';
    for (const p of this.peaks) {
      if (p.x < v.xMin || p.x > v.xMax || p.y < v.yMin || p.y > v.yMax) continue;
      const px = v.sx(p.x), py = v.sy(p.y);
      ctx.fillStyle = MATLAB_COLORS[1];
      ctx.beginPath();
      ctx.moveTo(px, py - 2);
      ctx.lineTo(px - 4.5, py - 10);
      ctx.lineTo(px + 4.5, py - 10);
      ctx.closePath();
      ctx.fill();
      // Label beside the marker, not above it: a peak sits at the top of the
      // axes, where a centred label lands on the trace. White background like
      // MATLAB's text(..., 'BackgroundColor', 'w').
      const label = `${p.x.toFixed(2)} Hz`;
      const tw = ctx.measureText(label).width;
      const right = px + 8 + tw + 4 <= v.x0 + v.plotW;
      const tx = right ? px + 8 : px - 8 - tw;
      const ty = Math.max(py - 7, v.y0 + 8);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(tx - 2, ty - 7, tw + 4, 14);
      ctx.fillStyle = MATLAB_STYLE.text;
      ctx.textAlign = 'left';
      ctx.fillText(label, tx, ty);
    }
    ctx.restore();
  }

  _legendEntries() {
    return this.series
      .filter((s) => s.label)
      .map((s) => ({ label: s.label, color: s.color, lineStyle: s.lineStyle, lineWidth: s.lineWidth }));
  }

  _hitTest(mx, my, v) {
    const n = this.t.length;
    if (!n) return null;
    const R = 18;
    const lo = Math.max(0, this._lowerBound(v.ix(mx - R)) - 1);
    const hi = Math.min(n - 1, this._lowerBound(v.ix(mx + R)));
    let best = null, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const px = v.sx(this.t[i]);
      if (px < v.x0 - 1 || px > v.x0 + v.plotW + 1) continue;
      for (let k = 0; k < this.data.length; k++) {
        const y = this.data[k][i];
        if (!Number.isFinite(y)) continue;
        const py = v.sy(y);
        if (py < v.y0 - 1 || py > v.y0 + v.plotH + 1) continue;
        const d = Math.hypot(px - mx, py - my);
        if (d < bd) {
          bd = d;
          best = { px, py, x: this.t[i], y, series: k, color: this.series[k].color, xOnly: false };
        }
      }
    }
    return best && bd <= R ? best : null;
  }

  _forEachSample(v, cb) {
    const [i0, i1] = this._visibleRange(v);
    const total = (i1 - i0) * this.data.length;
    const stride = Math.max(1, Math.ceil(total / 3000));
    for (let i = i0; i < i1; i += stride) {
      const px = v.sx(this.t[i]);
      for (const s of this.data) {
        const y = s[i];
        if (Number.isFinite(y)) cb(px, v.sy(y));
      }
    }
  }
}

// Re-exported for callers that format values the way the datatips do.
export { formatTipValue };
