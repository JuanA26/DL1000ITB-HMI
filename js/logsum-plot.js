// Log Summary plotting, shared by the HMI's Log Summary modal (app.js) and the
// Figures tab (figure-views.js), so both draw exactly the same thing from the
// same capture: acceleration in m/s² against the capture's own time axis, with
// the encoder pulses redrawn as the old rig's rectangular proximity-probe trace
// (Prak2.m's "Detailed view"), plus the FFT of the same capture.
import { computeAmplitudeSpectrum } from './fft.js';
import { lowpassFiltfilt, syncAverage } from './filter.js';

export const G_TO_MS2 = 9.80665;              // standard gravity: firmware reports g, the worksheet wants m/s²
export const LOGSUM_ACCEL_COLOR = '#0000ff';  // MATLAB '-b'
export const LOGSUM_PULSE_COLOR = '#ff0000';  // MATLAB '-r'
// PCB1 sends one timestamp per revolution (the encoder trigger), not a probe
// voltage, so the old rig's proximity trace is redrawn from those times: high,
// dropping to 0 AT the trigger instant, back up a moment later. The dip width
// is cosmetic -- ~5% of a revolution, what the old probe's dip measured in the
// Prak2.m figures -- and only the FALLING edge carries information, so it is the
// only part of the pulse the cursor and data tips snap to.
const LOGSUM_PULSE_DUTY = 0.05;
// Pulse high level: just above the waveform, like the old 8.6 V probe level over
// the scaled accel in Prak2.m (see logsumPulseHigh for the exact level).
const LOGSUM_PULSE_MIN_HEIGHT = 1.08;
const LOGSUM_PULSE_MAX_HEIGHT = 1.45;
export const LOGSUM_FFT_MAX_HZ = 100;         // Prak2.m: xlim([0 100])
const LOGSUM_FFT_MIN_HZ = 2;                  // ignore near-DC bins when picking the dominant peak

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Rectangular proximity-pulse trace from the encoder timestamps, in drawing
// order. The falling edge sits exactly on each pulse time and carries a few
// extra vertices so the cursor snaps to it anywhere along its height -- every
// one of them reads the trigger time. The rising edge and the baseline are
// drawing-only (snap: false), so nothing can report the cosmetic end of the dip
// as if it were a measurement.
export function proximityPulseTrain(pulses, tStart, tEnd, high, fallbackPeriod) {
  // One dip width for the whole train, from the MEDIAN pulse spacing: uniform
  // like the old probe's, and a missed pulse can't make its neighbour's dip
  // twice as wide.
  const gaps = [];
  for (let k = 0; k + 1 < pulses.length; k++) gaps.push(pulses[k + 1] - pulses[k]);
  gaps.sort((a, b) => a - b);
  let T = gaps.length ? gaps[Math.floor(gaps.length / 2)] : fallbackPeriod;
  if (!(T > 0)) T = 0.05;
  const pts = [{ x: tStart, y: high, snap: false }];
  for (let k = 0; k < pulses.length; k++) {
    const p = pulses[k];
    const width = Math.min(LOGSUM_PULSE_DUTY * T, tEnd - p);
    pts.push({ x: p, y: high }, { x: p, y: 0.75 * high }, { x: p, y: 0.5 * high },
             { x: p, y: 0.25 * high }, { x: p, y: 0 });
    if (width > 0) pts.push({ x: p + width, y: 0, snap: false }, { x: p + width, y: high, snap: false });
  }
  pts.push({ x: tEnd, y: high, snap: false });
  return pts;
}

// The pulse's high level is arbitrary (it's a timing reference), so pick it to
// suit the axis: the auto-scaled y-axis rounds outward to "nice" ticks, and a
// fixed 1.25 x peak often tips it into the next coarse step (data to ~12, axis
// to 20 -- a third of the plot empty). This tries levels from 1.08 to 1.45 x
// peak and keeps the one that leaves the least empty band above the pulse,
// while still clearing the top of the axes box by >= 6% so the pulse line never
// merges into the frame. `predictYLim(min, max)` is the chart's own limit rule
// (MatlabAxes.niceYLimits), so the prediction matches the real axis.
export function logsumPulseHigh(minY, peak, predictYLim) {
  let best = LOGSUM_PULSE_MIN_HEIGHT * peak, bestWaste = Infinity;
  for (let f = LOGSUM_PULSE_MIN_HEIGHT; f <= LOGSUM_PULSE_MAX_HEIGHT + 1e-9; f += 0.01) {
    const high = f * peak;
    const { min, max } = predictYLim(Math.min(minY, 0), high);
    const span = max - min;
    if (!(span > 0) || max - high < 0.06 * span) continue;
    const waste = (max - high) / span;
    if (waste < bestWaste - 1e-9) { bestWaste = waste; best = high; }
  }
  return best;
}

// The sync view laid back onto the real time axis. The averaged revolution
// (band-limited first -- see renderLogsumTrace) is stretched onto EVERY actual
// revolution between consecutive pulses, plus the partial revolutions at both
// ends of the window at the mean period, so it lines up with the real pulse
// train and the absolute time axis exactly like the raw and low-pass views.
// Every cycle is identical by construction (that's the noise averaged out);
// revolution-to-revolution speed variation is still honoured, since each copy
// is stretched to its own pulse-to-pulse interval.
export function syncAverageOnRevolutions(t, y, pulses) {
  const avg = syncAverage(t, y, pulses, { repeats: 1 });
  if (!avg) return null;
  const m = avg.time.length - 1;          // the last point just closes the cycle
  const tStart = t[0], tEnd = t[t.length - 1];
  const P = avg.period;
  const bounds = [pulses[0] - P, ...pulses, pulses[pulses.length - 1] + P];
  const points = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b < tStart || a > tEnd) continue;
    // Normally one cycle per pulse interval; a missed pulse leaves a gap two
    // revolutions long, which gets two cycles rather than one stretched one.
    const cycles = Math.max(1, Math.round((b - a) / P));
    const len = (b - a) / cycles;
    for (let c = 0; c < cycles; c++) {
      for (let k = 0; k < m; k++) {
        const x = a + c * len + (avg.time[k] / P) * len;
        if (x >= tStart && x <= tEnd) points.push({ x, y: avg.accel[k] });
      }
    }
  }
  return { points, revolutions: avg.revolutions };
}

// Capture facts (sample count, rate, window) for the status line.
export function logsumCaptureFacts(s) {
  return `${s.samples.length} samples @ ${s.actualSps.toFixed(0)} SPS ` +
    `(${(s.samples.length / s.actualSps).toFixed(2)} s of ${s.durationS.toFixed(0)} s, ` +
    `from t=${s.windowStartS.toFixed(2)} s).`;
}

// Draws the time trace + pulse train for capture `s` on `chart` (a BodeChart)
// in the given view, and returns a one-line note on what the view did.
//   raw  -- exactly what the board sent.
//   lp   -- zero-phase Butterworth. Cutoff is set in HARMONICS of shaft speed,
//           not Hz, because the tone being measured moves with RPM: a fixed Hz
//           cutoff that works at 300 RPM would sit below the fundamental at
//           3400. Keeping ~5 harmonics preserves the waveform's shape while
//           discarding the decade of band above it that is pure noise.
//   sync -- time-synchronous average over the encoder pulses (see syncAverage),
//           redrawn onto every real revolution.
// Both filters keep peak TIMES exact, which is the only reason either is
// allowed near this screen -- the whole exercise is a timing measurement. All
// three views show the WHOLE shipped window on the capture's own time axis.
export function renderLogsumTrace(chart, s, { view = 'lp', harmonics = 5 } = {}) {
  if (!s || s.samples.length < 2) return '';
  const t = s.samples.map((p) => p.time_s);
  // m/s², as Prak2.m's  acc1 = data(:,2)/acc_sensitivity  gives it.
  const y = s.samples.map((p) => p.accel_g * G_TO_MS2);
  const tStart = t[0], tEnd = t[t.length - 1];
  const pulses = s.pulses.filter((p) => p >= tStart && p <= tEnd).sort((a, b) => a - b);
  const shaftHz = s.rpmAvg > 0 ? s.rpmAvg / 60 : 0;
  harmonics = clamp(Number(harmonics) || 5, 2, 40);

  // The harmonics cutoff applies to BOTH filtered views (see the sync branch).
  const cutoffHz = harmonics * shaftHz;
  const bandLimited = shaftHz > 0 ? lowpassFiltfilt(y, s.actualSps, cutoffHz) : y;

  let points = null;
  let note = '';
  if (view === 'sync') {
    // Average the BAND-LIMITED trace, not the raw one. Synchronous averaging
    // rejects noise but not rotation-locked harmonics -- an 8x component is
    // exactly as synchronous as the 1x, so it survives at full strength and
    // leaves a ripple that makes the trough harder to pick out. Low-passing
    // first removes the harmonics, the averaging then removes the noise.
    // Both stages are phase-preserving, so the trough still doesn't move.
    const avg = syncAverageOnRevolutions(t, bandLimited, pulses);
    if (avg) {
      points = avg.points;
      // Only claim a noise win when there was actually something to average.
      note = avg.revolutions > 1
        ? `Sync average of ${plural(avg.revolutions, 'revolution')} ` +
          `(~${Math.sqrt(avg.revolutions).toFixed(1)}× less noise), band-limited to ` +
          `${harmonics}× shaft speed, drawn onto every revolution — every cycle is ` +
          `identical by construction.`
        : `Only one complete revolution — nothing to average, so this is that ` +
          `revolution band-limited to ${harmonics}× shaft speed.`;
    } else {
      // Fewer than one whole revolution (very low RPM, or a stalled rotor).
      note = 'Not enough complete revolutions to sync-average — showing raw.';
    }
  }
  if (!points) {
    let plotted = y;
    if (view === 'lp' && shaftHz > 0) {
      plotted = bandLimited;
      note = `Low-pass ${cutoffHz.toFixed(0)} Hz (${harmonics}× shaft speed), zero-phase.`;
    } else if (view === 'lp') {
      note = 'No measurable RPM — showing raw.';
    }
    points = t.map((x, i) => ({ x, y: plotted[i] }));
  }

  let peak = 0, minY = 0;
  for (const p of points) { peak = Math.max(peak, Math.abs(p.y)); minY = Math.min(minY, p.y); }
  const high = logsumPulseHigh(minY, peak > 0 ? peak : 1, (a, b) => chart.niceYLimits(a, b));

  chart.setVLines([]);
  // Pulse first so the accel trace draws over it -- Prak2.m's plotting order.
  chart.setSeries('pulse', proximityPulseTrain(pulses, tStart, tEnd, high, shaftHz > 0 ? 1 / shaftHz : NaN),
                  LOGSUM_PULSE_COLOR, 'Proximity pulse (1/rev, scaled)',
                  { markers: false, presorted: true, lineWidth: 1.25, cursor: 'x' });
  chart.setSeries('accel', points, LOGSUM_ACCEL_COLOR, 'Acceleration (m/s²)',
                  { markers: false, presorted: true, lineWidth: 1.1 });
  chart.resetZoom();
  return note;
}

// Spectrum of the RAW capture, not the current view's filtered trace: this is
// the data-validity check, and filtering would hide exactly what it is there to
// catch. Peak heights read true amplitude (see computeAmplitudeSpectrum), so
// the 1x peak is the vibration amplitude at running speed, in m/s². Returns the
// status message.
export function renderLogsumSpectrum(chart, s) {
  const y = s.samples.map((p) => p.accel_g * G_TO_MS2);
  const { freq, amplitude } = computeAmplitudeSpectrum(y, s.actualSps, { maxHz: LOGSUM_FFT_MAX_HZ });
  const pts = Array.from(freq, (f, i) => ({ x: f, y: amplitude[i] }));
  const f1x = s.rpmAvg > 0 ? s.rpmAvg / 60 : NaN;
  chart.setResonanceX(isFinite(f1x) && f1x <= LOGSUM_FFT_MAX_HZ ? f1x : null);
  chart.setSeries('fft', pts, LOGSUM_ACCEL_COLOR, 'Amplitude (m/s²)',
                  { markers: false, presorted: true, lineWidth: 1.1 });
  chart.resetZoom();

  let kPk = -1;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] < LOGSUM_FFT_MIN_HZ) continue;
    if (kPk < 0 || amplitude[i] > amplitude[kPk]) kPk = i;
  }
  if (kPk < 0) return '';
  let msg = `Dominant peak: ${freq[kPk].toFixed(1)} Hz, ${amplitude[kPk].toFixed(3)} m/s².`;
  if (isFinite(f1x)) {
    // A 1 s record resolves ~1 Hz, so "on the 1x line" means within about a bin.
    const onRunningSpeed = Math.abs(freq[kPk] - f1x) <= Math.max(1, 0.03 * f1x);
    msg += ` Running speed 1× = ${f1x.toFixed(1)} Hz (${s.rpmAvg.toFixed(0)} RPM) — ` +
      (onRunningSpeed
        ? '✓ dominant at running speed.'
        : '⚠ not at running speed: let the RPM settle and check the sensor before reading the phase.');
  }
  return msg;
}

// The firmware's lock-in correlates the ACCEL signal, so its raw phase is
// "pulse -> accel peak". The encoder fires at maximum displacement, which is the
// accel TROUGH (a = -w^2 * x inverts the signal), 180 deg away. Subtracting that
// 180 gives the displacement-referenced phase: the textbook 0 -> 90 -> 180
// number, and exactly what a student measures reading pulse -> trough.
//
// Any offset left after this is sensor mounting angle, unknowable from one
// capture -- which is precisely what the Bode plot's low-RPM normalisation
// exists to remove.
export function displacementPhaseDeg(rawDeg) {
  // Wrap into [-90, 270) rather than [0, 360) so the physical 0-180 band stays
  // contiguous: a reading a hair below zero shows as -2 deg (obviously "≈0")
  // instead of flipping to 358.
  return ((rawDeg - 180 + 90) % 360 + 360) % 360 - 90;
}

// "Reveal computed phase" text for capture `s`: { main, raw } or null.
export function logsumRevealText(s) {
  if (!s || !isFinite(s.phaseDeg)) return null;
  const T_ms = s.rpmAvg > 0 ? 60000 / s.rpmAvg : NaN;
  const disp = displacementPhaseDeg(s.phaseDeg);
  const dt_ms = isFinite(T_ms) ? (disp / 360) * T_ms : NaN;
  return {
    main: isFinite(dt_ms)
      ? `${disp.toFixed(1)}°  (Δt ≈ ${dt_ms.toFixed(1)} ms, pulse → trough)`
      : `${disp.toFixed(1)}°`,
    raw: `raw (pulse → accel peak): ${s.phaseDeg.toFixed(1)}°`,
  };
}
