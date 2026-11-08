// RPM-sweep phase analysis, shared by the HMI's Sweep/Bode modal (app.js) and
// the Figures tab (figure-views.js): normalising the firmware's RAW phase to the
// textbook 0 -> 90 -> 180 curve, and locating resonance at the 90 deg crossing.

// ---- Phase normalisation ----
// The firmware reports RAW phase: the true response lag plus a fixed offset
// from the sensor mounting angle and from measuring acceleration rather than
// displacement (accel = -w^2 * x, a flat 180 deg). That offset is constant
// across RPM, so instead of calibrating it we exploit the physics: for
// rotating unbalance the lag tends to 0 well below resonance. Averaging the
// far-below-resonance points and subtracting gives a self-calibrating zero
// that survives someone re-mounting the sensor.
//
// 1000 RPM is r = f/fn ~ 0.75, where the true lag is still only ~2 deg for
// light damping -- close enough to zero to use as the reference, while being
// high enough to include several points with usable signal.
export const PHASE_ZERO_MAX_RPM = 1000;
// Below this ratio of (1x lock-in amplitude) / (broadband RMS amplitude), the
// 1x tone is buried in the noise floor and the lock-in's ANGLE is meaningless
// even though it still returns a number. Same underlying reason amp_1x exists
// at all. Such points are plotted faded rather than dropped.
export const PHASE_MIN_TONE_RATIO = 0.35;

export function circularMeanDeg(degs) {
  let c = 0, s = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    c += Math.cos(r); s += Math.sin(r);
  }
  if (c === 0 && s === 0) return NaN;
  return (Math.atan2(s, c) * 180) / Math.PI;
}

// Wrap into [lo, lo+360). lo = -90 keeps the physical 0-180 band contiguous,
// so a point sitting near 180 can't flip to -180 and tear the trace.
export function wrapPhase(deg, lo = -90) {
  let d = (deg - lo) % 360;
  if (d < 0) d += 360;
  return d + lo;
}

export function phaseZeroOffset(points) {
  const valid = points.filter((p) => isFinite(p.phase_deg));
  if (!valid.length) return NaN;
  let ref = valid.filter((p) => p.rpm_avg < PHASE_ZERO_MAX_RPM);
  if (!ref.length) {
    // No far-below-resonance points (an aborted run, or a loaded partial that
    // never went low). Fall back to the lowest-RPM point as an approximate
    // zero -- worse the closer it sits to resonance, but better than leaving
    // an arbitrary raw offset on the plot.
    ref = [valid.reduce((a, b) => (a.rpm_avg <= b.rpm_avg ? a : b))];
  }
  return circularMeanDeg(ref.map((p) => p.phase_deg));
}

// Build the normalised {x,y,dim} series for a set of raw sweep points.
// Recomputed from scratch on every new live point rather than appended to:
// the zero offset itself sharpens as more low-RPM points arrive, and it has
// to be applied to the whole trace, not just the newest point.
export function phaseSeriesFor(points) {
  const offset = phaseZeroOffset(points);
  if (!isFinite(offset)) return [];
  return points
    .filter((p) => isFinite(p.phase_deg))
    .map((p) => {
      const toneRatio = p.accel_amplitude_g > 0 ? p.accel_amp_1x_g / p.accel_amplitude_g : 0;
      return {
        x: p.rpm_avg,
        y: wrapPhase(p.phase_deg - offset),
        dim: toneRatio < PHASE_MIN_TONE_RATIO,
      };
    });
}

// Resonance estimate from the phase curve's 90 deg crossing. For rotating
// unbalance the response lag passes through exactly 90 deg AT the natural
// frequency whatever the damping, which makes this a sharper estimator than
// the amplitude peak -- that peak sits slightly ABOVE fn (the m*e*w^2 forcing
// grows with speed) and is noise-biased where the tone is weak. Linearly
// interpolates the two trustworthy points straddling 90.
export function resonanceFromPhase(points) {
  const pts = phaseSeriesFor(points).filter((p) => !p.dim).sort((a, b) => a.x - b.x);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].y < 90 && pts[i].y >= 90) {
      const t = (90 - pts[i - 1].y) / (pts[i].y - pts[i - 1].y);
      const rpm = pts[i - 1].x + t * (pts[i].x - pts[i - 1].x);
      // How far apart the straddling points are: on the undamped beam the
      // crossing can fall inside the sweep's no-dwell gap (default 1325-1350,
      // runtime-adjustable via `gap <lo> <hi>` -- see app.js's gap controls),
      // and interpolating across it is much cruder than across a 5 RPM fine
      // step. Fine-band steps are 5 RPM, the default gap spans 25, so 10
      // separates them -- see the `> 10` check below. A gap widened well past
      // the default via `gap` could still slip under this fixed threshold;
      // it's a heuristic, not a hard guarantee.
      return { rpm, spanRpm: pts[i].x - pts[i - 1].x };
    }
  }
  return null;
}
