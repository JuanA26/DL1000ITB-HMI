// Signal conditioning for the accel traces a student reads BY HAND. Both tools
// here exist for the same reason -- the raw ADXL/ADS1220 trace carries
// broadband noise across the whole ~1165 Hz band, which buries the feature
// being measured -- and both are deliberately PHASE-PRESERVING, because in
// every case the measurement is *when* something happens, not just how big it
// is. A causal filter would shift the peaks and silently corrupt the exact
// quantity the exercise is about.
//
//   lowpassFiltfilt -- zero-phase Butterworth. Used by the free-vibration
//                      ring-down and the Log Summary's smoothed view.
//   syncAverage     -- time-synchronous averaging against the encoder pulse.
//                      Used by the Log Summary.
//
// ------------------------------------------------------------------
// Zero-phase low-pass for the free-vibration ring-down. The raw accel trace is
// noisy, which makes reading peaks (for the natural frequency + logarithmic
// decrement) by hand hard; a low-pass smooths it. The free-vibration mode sits
// at ~2.2-2.5 Hz, so a cutoff a few times that (default 8 Hz) removes the noise
// while leaving the fundamental (and a couple of harmonics) intact.
//
// filtfilt (forward + backward) is used rather than a single causal pass so the
// result is ZERO-PHASE: peaks don't shift in time and don't get attenuated,
// which is exactly what a log-decrement (peak-amplitude decay) and a period
// (peak spacing) measurement need. Two passes also square the magnitude
// response, so a 2nd-order design behaves like a sharper 4th-order one.

// 2nd-order Butterworth low-pass via the bilinear transform (Q = 1/sqrt(2)).
// Returns the biquad difference-equation coefficients for
//   y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] + a1 y[n-1] + a2 y[n-2].
function designButterworth2(cutoffHz, fs) {
  const ita = 1.0 / Math.tan(Math.PI * cutoffHz / fs); // prewarped
  const q = Math.SQRT2;
  const b0 = 1.0 / (1.0 + q * ita + ita * ita);
  const b1 = 2.0 * b0;
  const b2 = b0;
  const a1 = 2.0 * (ita * ita - 1.0) * b0;
  const a2 = -(1.0 - q * ita + ita * ita) * b0;
  return { b0, b1, b2, a1, a2 };
}

// One causal biquad pass. State is initialised to the first sample (DC
// steady-state) so the filter doesn't ring on the leading edge -- important
// here since a ring-down usually starts at a large deflection.
function biquadPass(x, c) {
  const n = x.length;
  const y = new Array(n);
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0];
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 + c.a1 * y1 + c.a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

// Zero-phase low-pass: forward pass, then a backward pass over the result. Falls
// back to a copy of the input when filtering can't be applied meaningfully (too
// few samples, or a cutoff at/above Nyquist).
export function lowpassFiltfilt(x, fs, cutoffHz) {
  if (!(cutoffHz > 0) || !(fs > 0) || x.length < 6 || cutoffHz >= fs / 2) {
    return x.slice();
  }
  const c = designButterworth2(cutoffHz, fs);
  const fwd = biquadPass(x, c);
  const back = biquadPass(fwd.slice().reverse(), c);
  return back.reverse();
}

// ------------------------------------------------------------------
// Time-synchronous averaging (TSA) against the encoder pulse train.
//
// The classic rotating-machinery tool, and a better fit than a low-pass for the
// Log Summary: it is defined relative to EXACTLY the trigger the student is
// measuring from. Cut the record at every encoder pulse (one pulse per
// revolution), resample each revolution onto a common angular grid, and average
// across them. Anything locked to shaft rotation -- the 1x unbalance response
// and its harmonics, i.e. the whole signal of interest -- adds coherently and
// survives untouched. Anything not locked to it, which is what sensor noise is,
// averages toward zero as 1/sqrt(revolutions): a 1 s window at 1200 RPM holds
// ~20 revolutions, so ~4.5x less noise, and it costs no bandwidth at all (a
// low-pass buys its noise reduction by throwing away high harmonics; this
// doesn't).
//
// Resampling per-revolution onto a NORMALISED grid (rather than averaging fixed
// time slices) makes this order tracking: small speed variations between
// revolutions stretch/compress each segment back into alignment instead of
// smearing the average.
//
// Phase is preserved exactly and by construction -- every segment starts at its
// own pulse, so the output's t=0 IS the encoder trigger, and the delay from t=0
// to the trough is the very quantity being measured. Averaging cannot move it.
//
// WHAT THIS DOES NOT DO: it does not touch rotation-locked HARMONICS. An 8x or
// 11x component is just as synchronous as the 1x, so it adds coherently and
// survives at full strength -- correct behaviour, but on a real rotor it leaves
// a ripple that makes the trough harder to pick out, not easier. Averaging a
// signal that has been low-passed first gets both effects (noise AND harmonics
// removed); see the Log Summary's sync view, which does exactly that.
//
// `pulses` are pulse times on the SAME clock as t. `repeats` tiles the averaged
// revolution so several pulse-to-trough intervals are visible at once rather
// than a single isolated cycle. Returns null when there isn't at least one
// complete revolution inside the window, so callers can fall back.
export function syncAverage(t, y, pulses, { maxPoints = 2048, repeats = 1 } = {}) {
  const n = Math.min(t.length, y.length);
  if (!pulses || pulses.length < 2 || n < 4) return null;
  const t0 = t[0], tEnd = t[n - 1];
  const meanDt = (tEnd - t0) / (n - 1);
  if (!(meanDt > 0)) return null;

  // Only revolutions wholly inside the captured window -- a partial one at
  // either end would average a fragment against full revolutions.
  const ps = [...pulses].sort((a, b) => a - b);
  const revs = [];
  for (let i = 0; i + 1 < ps.length; i++) {
    const a = ps[i], b = ps[i + 1];
    if (b > a && a >= t0 && b <= tEnd) revs.push([a, b]);
  }
  if (!revs.length) return null;

  const period = revs.reduce((s, [a, b]) => s + (b - a), 0) / revs.length;
  // One output point per input sample of an average revolution: finer would
  // interpolate detail that isn't there, coarser would throw detail away.
  const m = Math.max(32, Math.min(maxPoints, Math.round(period / meanDt)));

  // Linear interpolation, since grid points land between samples. Located by
  // binary search rather than an index derived from a single dt: the shipped
  // window is uniform in practice, but if it ever weren't, a computed index
  // would silently misalign every segment and quietly smear the average.
  const sampleAt = (tt) => {
    if (tt <= t[0]) return y[0];
    if (tt >= t[n - 1]) return y[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tt) lo = mid; else hi = mid; }
    const span = t[hi] - t[lo];
    const f = span > 0 ? (tt - t[lo]) / span : 0;
    return y[lo] * (1 - f) + y[hi] * f;
  };

  const acc = new Float64Array(m);
  for (const [a, b] of revs) {
    const T = b - a;                       // this revolution's own period...
    for (let k = 0; k < m; k++) acc[k] += sampleAt(a + (k / m) * T);   // ...normalised out
  }
  const one = Array.from(acc, (v) => v / revs.length);

  // Tile the averaged revolution. Plotted against absolute time (not angle) so
  // the student's phase = 360 * dt / T arithmetic and the T = 60/RPM metric
  // carry over unchanged from the raw view.
  const reps = Math.max(1, Math.min(12, Math.round(repeats)));
  const time = [], accel = [];
  for (let r = 0; r < reps; r++) {
    for (let k = 0; k < m; k++) { time.push((r + k / m) * period); accel.push(one[k]); }
  }
  time.push(reps * period); accel.push(one[0]);   // close the final cycle

  return {
    time, accel, period,
    revolutions: revs.length,
    repeats: reps,
    // One per revolution boundary, including both ends -- these ARE the encoder
    // pulses, by construction (every segment was cut on one).
    pulseTimes: Array.from({ length: reps + 1 }, (_, i) => i * period),
  };
}
