// Multi-series XY chart: the RPM sweep's amplitude/phase plots (live run plus
// loaded overlays), the Log Summary's time trace and spectrum, and the Figures
// tab's copies of them. Drawn as a MATLAB figure through MatlabAxes
// (js/matlab-axes.js) -- same look, axes toolbar, zoom tools and datatips as
// every other chart.
//
// Unlike RollingChart (one shared time buffer), each series here is a named,
// independent list of {x, y} points that can be added/replaced/removed on its
// own -- what a Bode plot with overlays needs (x is RPM, not time).
import { MatlabAxes, MATLAB_STYLE, formatTick } from './matlab-axes.js';

export class BodeChart extends MatlabAxes {
  constructor(canvas, {
    title = '', xLabel = 'RPM', yLabel = 'Accel Amplitude (g)',
    // Labelled vertical reference line (MATLAB xline), e.g. the resonance RPM
    // or the FFT's running-speed line; null hides it.
    resonanceX = null,
    // (x) => label for that line; default "<x> RPM".
    resonanceFormat = null,
    // Fixed y limits when not zoomed (MATLAB ylim). The phase plot wants this:
    // phase lives on a physically bounded scale, and auto-fitting would blow a
    // flat pre-resonance trace up into noise filling the panel.
    yFixed = null,
    // Horizontal reference line (MATLAB yline), e.g. the 90 deg crossing.
    refY = null,
    palette,                  // legacy option (every chart is MATLAB-styled now); ignored
    ...axesOpts               // legend, legendLocation, toolbar, dataTips, yTicks, exportName, zoomMode
  } = {}) {
    super(canvas, { title, xLabel, yLabel, yFixed, ...axesOpts });
    void palette;
    this.resonanceX = resonanceX;
    this.resonanceFormat = resonanceFormat;
    this.refY = refY;
    // Extra unlabelled vertical marker lines at arbitrary x values.
    this.vLines = [];
    // name -> { points: [{x, y, dim?, snap?}], color, label, markers, lineWidth,
    //           lineStyle, presorted, cursor }. Insertion order = legend order.
    this.series = new Map();
    this._start();
  }

  setResonanceX(x) {
    this.resonanceX = x;
    this.draw();
  }

  setVLines(xs) {
    this.vLines = xs || [];
    this.draw();
  }

  // Replaces a named series wholesale.
  //   opts.markers = false   no per-point markers (dense traces); default true
  //                          draws MATLAB 'o' markers (hollow circles)
  //   opts.lineWidth         line width in px (default 1.2)
  //   opts.lineStyle         '-' (default), '--', ':', '-.', or 'none'
  //   opts.presorted         draw points in the given order instead of sorting
  //                          by x (a pulse train's vertical edges are pairs of
  //                          points at the same x)
  //   opts.cursor = 'x'      datatips report X only (y means nothing for a
  //                          scaled reference trace)
  // A point may carry dim: true (drawn faded -- measured but untrustworthy) or
  // snap: false (drawing-only vertex the cursor must never report).
  setSeries(name, points, color, label, opts = {}) {
    this.series.set(name, {
      points, color, label: label ?? name,
      markers: opts.markers !== false,
      lineWidth: opts.lineWidth ?? 1.2,
      lineStyle: opts.lineStyle || '-',
      presorted: !!opts.presorted,
      cursor: opts.cursor || null,
    });
    // Pinned tips on this series follow the new data: re-snapped to the point
    // nearest in x (ties -> nearest in y). Switching Raw/Low-pass keeps the
    // sample times, so a tip stays on the same instant and takes the new value.
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

  // Appends one point to a named series, creating it on first call (the live
  // sweep's points arriving one at a time).
  appendPoint(name, x, y, color, label) {
    let s = this.series.get(name);
    if (!s) {
      s = { points: [], color, label: label ?? name, markers: true, lineWidth: 1.2, lineStyle: '-', presorted: false, cursor: null };
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

  // Removes every series except the one named ("Clear Overlays" keeps the live run).
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
    this._hover = null;
    this._cancelPendingTip();
    this.draw();
  }

  // ---- MatlabAxes hooks ----
  _extent() {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of this.series.values()) {
      for (const p of s.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }
    return isFinite(xMin) ? { xMin, xMax, yMin, yMax } : null;
  }

  _drawUnder(ctx, v) {
    if (this.resonanceX != null && isFinite(this.resonanceX)) {
      const label = this.resonanceFormat
        ? this.resonanceFormat(this.resonanceX)
        : `${formatTick(this.resonanceX)} RPM`;
      this._drawXLine(ctx, v, this.resonanceX, label);
    }
    if (this.refY != null) this._drawYLine(ctx, v, this.refY);
    if (this.vLines.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(38, 38, 38, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of this.vLines) {
        if (!isFinite(x) || x < v.xMin || x > v.xMax) continue;
        const px = Math.round(v.sx(x)) + 0.5;
        ctx.moveTo(px, v.y0); ctx.lineTo(px, v.y0 + v.plotH);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawData(ctx, v) {
    for (const s of this.series.values()) {
      if (!s.points.length) continue;
      // The sweep visits setpoints out of RPM order (ascend, jump to max, then
      // descend), so the connecting line is drawn over a copy sorted by x;
      // markers don't care about order.
      const pts = s.presorted ? s.points : s.points.slice().sort((a, b) => a.x - b.x);
      if (s.lineStyle !== 'none' && pts.length >= 2) {
        this._strokePolyline(ctx, v, pts.length, (i) => pts[i].x, (i) => pts[i].y,
          s.color, s.lineWidth, MatlabAxes.dashFor(s.lineStyle));
      }
      if (!s.markers) continue;
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      for (const p of s.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        ctx.globalAlpha = p.dim ? 0.28 : 1;
        ctx.beginPath();
        ctx.arc(v.sx(p.x), v.sy(p.y), 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _legendEntries() {
    const out = [];
    for (const s of this.series.values()) {
      if (!s.label) continue;
      out.push({ label: s.label, color: s.color, lineStyle: s.lineStyle, lineWidth: s.lineWidth, marker: s.markers ? 'o' : null });
    }
    return out;
  }

  _hitTest(mx, my, v) {
    let best = null, bd = Infinity;
    for (const [name, s] of this.series) {
      for (const p of s.points) {
        if (p.snap === false || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const px = v.sx(p.x), py = v.sy(p.y);
        if (px < v.x0 - 1 || px > v.x0 + v.plotW + 1 || py < v.y0 - 1 || py > v.y0 + v.plotH + 1) continue;
        const d = Math.hypot(px - mx, py - my);
        if (d < bd) {
          bd = d;
          best = { px, py, x: p.x, y: p.y, series: name, color: s.color, xOnly: s.cursor === 'x' };
        }
      }
    }
    return best && bd <= 18 ? best : null;
  }

  _forEachSample(v, cb) {
    let total = 0;
    for (const s of this.series.values()) total += s.points.length;
    const stride = Math.max(1, Math.ceil(total / 3000));
    for (const s of this.series.values()) {
      for (let i = 0; i < s.points.length; i += stride) {
        const p = s.points[i];
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) cb(v.sx(p.x), v.sy(p.y));
      }
    }
  }
}

export { MATLAB_STYLE };
