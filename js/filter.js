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
