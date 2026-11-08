// Free-vibration ring-down analysis, shared by the HMI's Free Vibration modal
// (app.js) and the Figures tab (figure-views.js).

export const FREEVIB_FMIN_HZ = 0.5;    // ignore sub-0.5 Hz drift when hunting the mode
export const FREEVIB_FFT_MAX_HZ = 15;  // display/search ceiling -- the rig rings ~2.5 Hz

// Peak-based analysis of a free-vibration ring-down: damped natural frequency
// (from peak spacing), logarithmic decrement (from a straight-line fit of
// ln(peak amplitude) vs. cycle index), and the derived damping ratio + undamped
// natural frequency. Returns { ok, reason, fd, fn, zeta, delta, nPeaks,
// fftPeakHz }. The cursor-based hand measurement is the primary path for
// students; this is the "reveal" cross-check.
// `t` and `g` are parallel arrays; `g` is the low-pass-filtered accel (cleaner
// peaks than raw). `effSps` is the measured sample rate.
export function analyzeFreeVibration(t, g, effSps, bandF, bandA) {
  // Detrend (remove any residual DC so peaks are about the true zero line).
  const mean = g.reduce((s, v) => s + v, 0) / g.length;
  const gd = g.map((v) => v - mean);

  // Dominant frequency from the FFT band (fallback if peak timing fails, and a
  // reported cross-check regardless).
  let fftPeakHz = NaN, maxA = -Infinity;
  for (let i = 0; i < bandF.length; i++) {
    if (bandF[i] >= FREEVIB_FMIN_HZ && bandA[i] > maxA) { maxA = bandA[i]; fftPeakHz = bandF[i]; }
  }
  if (!isFinite(fftPeakHz) || fftPeakHz <= 0) {
    return { ok: false, reason: 'No clear spectral peak', fftPeakHz: NaN };
  }

  // Positive-peak picker: one local max per cycle, above a noise floor, spaced
  // at least ~60% of the estimated period apart (kills double-detections on
  // noisy crests). minDt from the FFT estimate.
  let maxAbs = 0;
  for (const v of gd) maxAbs = Math.max(maxAbs, Math.abs(v));
  const floor = 0.08 * maxAbs;
  const minDt = 0.6 / fftPeakHz;
  const peaks = [];
  for (let i = 1; i < gd.length - 1; i++) {
    if (gd[i] > floor && gd[i] >= gd[i - 1] && gd[i] > gd[i + 1]) {
      const last = peaks[peaks.length - 1];
      if (last && t[i] - last.t < minDt) {
        if (gd[i] > last.a) { last.t = t[i]; last.a = gd[i]; } // keep the taller of two too-close crests
      } else {
        peaks.push({ t: t[i], a: gd[i] });
      }
    }
  }
  if (peaks.length < 3) {
    return { ok: false, reason: `Only ${peaks.length} clean peaks (need ≥3)`, fftPeakHz };
  }

  // Damped period + frequency from mean peak-to-peak spacing.
  let dtSum = 0;
  for (let i = 1; i < peaks.length; i++) dtSum += peaks[i].t - peaks[i - 1].t;
  const Td = dtSum / (peaks.length - 1);
  const fd = Td > 0 ? 1 / Td : NaN;

  // Logarithmic decrement: least-squares slope of ln(amplitude) vs. cycle index.
  // δ = -slope. Robust across many cycles vs. a single x0/xn pair.
  const N = peaks.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < N; i++) {
    const y = Math.log(peaks[i].a);
    sx += i; sy += y; sxy += i * y; sxx += i * i;
  }
  const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx);
  const delta = -slope;
  if (!(delta > 0) || !isFinite(fd)) {
    return { ok: false, reason: 'Ring-down not decaying cleanly', fftPeakHz, fd };
  }
  const zeta = delta / Math.sqrt(4 * Math.PI * Math.PI + delta * delta);
  const fn = fd / Math.sqrt(Math.max(1e-9, 1 - zeta * zeta));
  return { ok: true, reason: '', fd, fn, zeta, delta, nPeaks: N, fftPeakHz };
}
