// One view per figure type for the Figures tab (figures.html). Each builds a
// MATLAB-style figure from a saved capture record, using the same chart classes
// (MatlabAxes: toolbar, zoom tools, datatips) and the same analysis modules as
// the HMI's own modals, so a figure shows exactly what the modal showed.
//
// createFigureView(record) -> { el, update(record), show(), destroy() }
//
// The caller appends `el` to the page, then calls show() whenever the figure
// becomes the visible one. Charts are only built (and only redrawn on update)
// while the figure is visible: a hidden canvas measures 0x0, and the Log
// Summary sizes its pulse trace from the real plot height.
import { BodeChart } from './bode-chart.js';
import { RollingChart, MATLAB_COLORS } from './chart.js';
import { computeFFT, findPeaks } from './fft.js';
import { lowpassFiltfilt } from './filter.js';
import {
  G_TO_MS2, renderLogsumTrace, renderLogsumSpectrum, logsumCaptureFacts, logsumRevealText,
} from './logsum-plot.js';
import { phaseSeriesFor, resonanceFromPhase } from './sweep-analysis.js';
import { analyzeFreeVibration, FREEVIB_FFT_MAX_HZ } from './freevib-analysis.js';

const BUMP_FFT_MAX_HZ = 300;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tiny DOM helper: h('div', { class: 'x', text: 'hi' }, [children])
function h(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function metric(label, value) {
  const v = h('span', { class: 'fig-metric-value', text: value });
  return { el: h('div', { class: 'fig-metric' }, [v, h('span', { class: 'fig-metric-label', html: label })]), v };
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' });
}

const PENDING_TEXT = {
  logsum: 'Recording 5 s at full rate… the figure appears here when the capture arrives.',
  bump: 'Armed — tap the beam. The figure appears here once the capture has arrived.',
  sweep: 'Sweep starting… points appear here as each speed is measured.',
  freevib: 'Recording — deflect the beam and let go. The figure appears here when the recording ends.',
};

export function createFigureView(rec) {
  const title = h('h2', { class: 'fig-title' });
  const meta = h('span', { class: 'fig-meta' });
  const body = h('div', { class: 'fig-body' });
  const el = h('section', { class: 'fig-figure', 'data-id': String(rec.id) }, [
    h('div', { class: 'fig-caption' }, [title, meta]),
    body,
  ]);
  let inner = null;        // type view, once the figure has data
  let builtFor = null;     // status the body was built for
  let latest = rec;        // newest record; rendered when visible
  let dirty = true;        // `latest` not rendered yet
  let pendingText = null;  // the spinner's text, while waiting for data
  let progress = '';       // latest live status from the HMI tab

  const visible = () => el.isConnected && !el.hidden;

  function setHeader(r) {
    title.textContent = `Figure ${r.num}: ${r.title || ''}`;
    meta.textContent = [r.demo ? 'Demo mode (simulated data)' : '', fmtTime(r.createdAt)].filter(Boolean).join(' · ');
  }

  function render(r) {
    setHeader(r);
    const hasData = r.status === 'done' || (r.type === 'sweep' && (r.data?.points || []).length > 0);
    if (!hasData) {
      if (builtFor !== 'pending') {
        for (const c of inner?.charts || []) c.destroy();
        inner = null;
        pendingText = h('span', { text: progress || PENDING_TEXT[r.type] || 'Waiting for data…' });
        body.replaceChildren(h('div', { class: 'fig-pending' }, [h('span', { class: 'fig-spinner' }), pendingText]));
        builtFor = 'pending';
      }
      return;
    }
    if (!inner) {
      body.replaceChildren();
      const make = { logsum: logsumView, bump: bumpView, sweep: sweepView, freevib: freevibView }[r.type];
      inner = make ? make(body, r) : null;
      builtFor = 'data';
    } else {
      inner.update?.(r);
    }
  }

  setHeader(rec);
  return {
    el,
    update(r) {
      latest = r;
      setHeader(r);
      dirty = true;
      if (visible()) { render(r); dirty = false; }
    },
    show() {
      if (dirty && visible()) { render(latest); dirty = false; }
    },
    // Live status of a capture still running ("Recording… 3.2 s"), sent by the HMI tab.
    setProgress(text) {
      progress = text || '';
      if (builtFor === 'pending' && pendingText) pendingText.textContent = progress || PENDING_TEXT[latest.type] || 'Waiting for data…';
    },
    destroy() {
      for (const c of inner?.charts || []) c.destroy();
      inner = null;
    },
  };
}

// ---------------------------------------------------------------- Log Summary
function logsumView(body, rec) {
  const s = rec.data;
  const T_ms = s.rpmAvg > 0 ? 60000 / s.rpmAvg : NaN;
  const metrics = h('div', { class: 'fig-metrics' }, [
    metric('RPM', s.rpmAvg.toFixed(1)).el,
    metric('Frequency <span class="u">(Hz)</span>', s.rpmAvg > 0 ? (s.rpmAvg / 60).toFixed(2) : '—').el,
    metric('T = 60/RPM <span class="u">(ms)</span>', isFinite(T_ms) ? T_ms.toFixed(1) : '—').el,
    metric('Accel amplitude <span class="u">(m/s²)</span>', (s.ampG * G_TO_MS2).toFixed(3)).el,
    metric('Encoder pulses', String(s.pulses.length)).el,
  ]);
  let view = 'lp';
  const viewBtns = {};
  const seg = h('div', { class: 'fig-seg', role: 'group', 'aria-label': 'Trace view' });
  for (const [k, label] of [['raw', 'Raw'], ['lp', 'Low-pass'], ['sync', 'Sync average']]) {
    const b = h('button', { type: 'button', class: 'fig-seg-btn' + (k === view ? ' active' : ''), text: label,
      onclick: () => { view = k; for (const [kk, bb] of Object.entries(viewBtns)) bb.classList.toggle('active', kk === k); draw(); } });
    viewBtns[k] = b;
    seg.appendChild(b);
  }
  const harm = h('input', { type: 'number', value: '5', min: '2', max: '40', step: '1', class: 'fig-num',
    title: 'Low-pass cutoff as a multiple of shaft speed (applies to Low-pass and Sync average)' });
  harm.addEventListener('change', () => { if (view !== 'raw') draw(); });
  const answer = h('span', { class: 'fig-answer' });
  const answerRaw = h('span', { class: 'fig-answer-raw' });
  const btnReveal = h('button', { type: 'button', class: 'fig-btn', text: 'Reveal computed phase',
    disabled: !isFinite(s.phaseDeg),
    onclick: () => {
      const r = logsumRevealText(s);
      if (!r) return;
      answer.textContent = r.main;
      answerRaw.textContent = r.raw;
      btnReveal.disabled = true;
    } });
  const btnClear = h('button', { type: 'button', class: 'fig-btn', text: 'Clear data tips',
    onclick: () => { chart.clearTips(); fft.clearTips(); } });
  const controls = h('div', { class: 'fig-controls' }, [
    h('span', { class: 'fig-label', text: 'Trace' }), seg,
    h('label', { class: 'fig-label', text: 'Harmonics' }), harm,
    btnClear, btnReveal, answer, answerRaw,
  ]);
  const hint = h('p', { class: 'fig-hint', html:
    '<b class="k-red">Red</b> = proximity pulse (1 per revolution), dropping at the trigger instant. ' +
    '<b class="k-blue">Blue</b> = acceleration (m/s²). Δt = pulse falling edge → next <b>trough</b>; ' +
    'T = falling edge → next falling edge; phase = 360° × Δt / T. ' +
    'Axes toolbar (hover the plot, top-right): Data Tips, Pan, Zoom In (drag a box, or a horizontal line to zoom time only), Zoom Out, Restore View.' });
  const cTime = h('canvas', { class: 'fig-chart fig-chart-main' });
  const status = h('p', { class: 'fig-status' });
  const cFft = h('canvas', { class: 'fig-chart fig-chart-fft' });
  const fftStatus = h('p', { class: 'fig-status' });
  body.append(metrics, controls, hint, cTime, status,
    h('p', { class: 'fig-hint', text: 'FFT of the same capture (raw signal, 0–100 Hz). The dashed line is the running speed (1×): the tallest peak should sit on it before you trust the phase. Its height is the vibration amplitude at that speed.' }),
    cFft, fftStatus);

  const chart = new BodeChart(cTime, {
    title: 'Acceleration and Proximity Pulse vs. Time', xLabel: 'Time (s)', yLabel: 'Acceleration (m/s²)',
    legendLocation: 'northoutside', exportName: `Figure ${rec.num} - Log Summary ${s.rpmAvg.toFixed(0)} RPM`,
  });
  const fft = new BodeChart(cFft, {
    title: 'FFT Spectrum (raw signal)', xLabel: 'Frequency (Hz)', yLabel: 'Amplitude (m/s²)',
    resonanceFormat: (hz) => `1× running speed = ${hz.toFixed(1)} Hz`,
    exportName: `Figure ${rec.num} - FFT ${s.rpmAvg.toFixed(0)} RPM`,
  });
  const facts = logsumCaptureFacts(s);
  function draw() {
    harm.disabled = view === 'raw';
    const note = renderLogsumTrace(chart, s, { view, harmonics: harm.value });
    status.textContent = `${facts} ${note}`.trim();
  }
  draw();
  fftStatus.textContent = renderLogsumSpectrum(fft, s);
  return { charts: [chart, fft] };
}

// ---------------------------------------------------------------- Bump Test
function bumpView(body, rec) {
  const d = rec.data;
  const raw = d.raw || [];
  body.append(h('div', { class: 'fig-metrics' }, [
    metric('Samples', String(raw.length)).el,
    metric('Sample rate <span class="u">(SPS)</span>', isFinite(d.actualSps) ? d.actualSps.toFixed(0) : '—').el,
    metric('Peak |accel| <span class="u">(g)</span>', isFinite(d.peakG) ? d.peakG.toFixed(3) : '—').el,
    metric('Trigger threshold <span class="u">(g)</span>', isFinite(d.thresholdG) ? d.thresholdG.toFixed(2) : '—').el,
  ]));
  body.append(h('p', { class: 'fig-hint', text: 'Natural frequency: read the spacing of the decay peaks with data tips (f = 1/T), and check it against the FFT peak.' }));
  const cTime = h('canvas', { class: 'fig-chart fig-chart-mid' });
  const cFft = h('canvas', { class: 'fig-chart fig-chart-mid' });
  const status = h('p', { class: 'fig-status' });
  body.append(cTime, cFft, status);
  const time = new RollingChart(cTime, {
    title: 'Bump Test — Time Domain', xLabel: 'Time (s)', yLabel: 'Accel (g)',
    series: [{ label: 'Accel (g)', color: MATLAB_COLORS[0] }], maxPoints: 60000, xScale: 1,
    exportName: `Figure ${rec.num} - Bump Test time`,
  });
  const fft = new RollingChart(cFft, {
    title: 'Bump Test — FFT Spectrum', xLabel: 'Frequency (Hz)', yLabel: 'Accel (g)',
    series: [{ label: 'FFT Amplitude', color: '#0000ff' }], maxPoints: 20000, xScale: 1,
    exportName: `Figure ${rec.num} - Bump Test FFT`,
  });
  time.beginBatch();
  for (const r of raw) time.push(r.time_s, r.accel_g);
  time.endBatch();
  if (raw.length > 8 && d.actualSps > 0) {
    const { freq, amplitude } = computeFFT(raw.map((r) => r.accel_g), d.actualSps);
    const bf = [], ba = [];
    fft.beginBatch();
    for (let i = 0; i < freq.length && freq[i] <= BUMP_FFT_MAX_HZ; i++) {
      fft.push(freq[i], amplitude[i]);
      bf.push(freq[i]); ba.push(amplitude[i]);
    }
    fft.endBatch();
    const peaks = findPeaks(bf, ba);
    fft.setPeaks(peaks);
    status.textContent = peaks.length
      ? `FFT peaks: ${peaks.map((p) => `${p.x.toFixed(2)} Hz`).join(', ')}.`
      : 'No clear FFT peak.';
  }
  return { charts: [time, fft] };
}

// ---------------------------------------------------------------- RPM Sweep
function sweepView(body, rec) {
  const mPoints = metric('Points', '0');
  const mCase = metric('Case', '');
  const mState = metric('Status', '');
  const mRes = metric('90° crossing', '—');
  body.append(h('div', { class: 'fig-metrics' }, [mPoints.el, mCase.el, mState.el, mRes.el]));
  body.append(h('p', { class: 'fig-hint', text: 'Amplitude is the 1×RPM lock-in; phase is normalised so the far-below-resonance points sit at 0°. The 90° crossing (dashed) marks resonance. Faded points had too weak a 1× tone. Zooming one plot zooms both RPM axes.' }));
  const cAmp = h('canvas', { class: 'fig-chart fig-chart-main' });
  const cPhase = h('canvas', { class: 'fig-chart fig-chart-phase' });
  const status = h('p', { class: 'fig-status' });
  body.append(cAmp, cPhase, status);
  const resRpm = (r) => (isFinite(r.data?.resonanceHz) && r.data.resonanceHz > 0 ? r.data.resonanceHz * 60 : null);
  const amp = new BodeChart(cAmp, {
    title: 'Accel Amplitude vs. RPM', xLabel: 'RPM (measured)', yLabel: 'Accel Amplitude (g, 1×RPM)',
    resonanceX: resRpm(rec), exportName: `Figure ${rec.num} - Sweep amplitude`,
  });
  const phase = new BodeChart(cPhase, {
    title: 'Response Phase vs. RPM', xLabel: 'RPM (measured)', yLabel: 'Phase lag (deg)',
    resonanceX: resRpm(rec), yFixed: { min: -30, max: 210 },
    yTicks: [-30, 0, 30, 60, 90, 120, 150, 180, 210], refY: 90,
    exportName: `Figure ${rec.num} - Sweep phase`,
  });
  amp.linkX(phase);
  function draw(r) {
    const pts = r.data?.points || [];
    const label = `${r.data?.mode === 'damped' ? 'Damped' : 'Undamped'} run`;
    amp.setSeries('run', pts.map((p) => ({ x: p.rpm_avg, y: p.accel_amp_1x_g ?? p.accel_amplitude_g })), MATLAB_COLORS[0], label);
    phase.setSeries('run', phaseSeriesFor(pts), MATLAB_COLORS[0], label);
    mPoints.v.textContent = String(pts.length);
    mCase.v.textContent = r.data?.mode === 'damped' ? 'Damped' : 'Undamped';
    mState.v.textContent = r.status === 'done' ? (r.data?.aborted ? 'Aborted' : 'Complete') : 'Running…';
    const res = resonanceFromPhase(pts);
    if (res) {
      mRes.v.textContent = `${res.rpm.toFixed(0)} RPM`;
      status.textContent = `Phase crosses 90° at ~${res.rpm.toFixed(0)} RPM (${(res.rpm / 60).toFixed(2)} Hz)` +
        (res.spanRpm > 10 ? ` — interpolated across a ${res.spanRpm.toFixed(0)} RPM gap, so treat it as approximate.` : '.');
    } else {
      mRes.v.textContent = '—';
      status.textContent = r.status === 'done' ? 'No 90° crossing in this run.' : '';
    }
  }
  draw(rec);
  return { update: draw, charts: [amp, phase] };
}

// ---------------------------------------------------------------- Free Vibration
function freevibView(body, rec) {
  const d = rec.data;
  const samples = d.samples || [];
  const cutoff = h('input', { type: 'number', value: String(d.cutoffHz || 8), min: '1', max: '50', step: '0.5', class: 'fig-num' });
  const showRaw = h('input', { type: 'checkbox' });
  const answer = h('span', { class: 'fig-answer' });
  const btnReveal = h('button', { type: 'button', class: 'fig-btn', text: 'Reveal computed f & ζ' });
  body.append(h('div', { class: 'fig-controls' }, [
    h('label', { class: 'fig-label', text: 'Low-pass cutoff (Hz)' }), cutoff,
    h('label', { class: 'fig-check' }, [showRaw, ' Show raw (unfiltered)']),
    btnReveal, answer,
  ]));
  body.append(h('p', { class: 'fig-hint', text: 'Read the damped frequency from the peak spacing and the damping from how fast the peaks shrink (log decrement), then reveal to check.' }));
  const cTime = h('canvas', { class: 'fig-chart fig-chart-main' });
  const cFft = h('canvas', { class: 'fig-chart fig-chart-mid' });
  const status = h('p', { class: 'fig-status' });
  body.append(cTime, cFft, status);
  const time = new RollingChart(cTime, {
    title: 'Free Vibration — Ring-down', xLabel: 'Time (s)', yLabel: 'Accel (g)',
    series: [{ label: 'Accel (g)', color: MATLAB_COLORS[0] }], maxPoints: 100000, xScale: 1,
    exportName: `Figure ${rec.num} - Free vibration`,
  });
  const fft = new RollingChart(cFft, {
    title: 'Free Vibration — FFT Spectrum', xLabel: 'Frequency (Hz)', yLabel: 'Accel (g)',
    series: [{ label: 'FFT Amplitude', color: '#0000ff' }], maxPoints: 40000, xScale: 1,
    exportName: `Figure ${rec.num} - Free vibration FFT`,
  });
  const t = samples.map((p) => p.time_s);
  const rawG = samples.map((p) => p.accel_g);
  let filtered = rawG;
  let analysis = null;

  function analyse() {
    const n = samples.length;
    if (n < 8) { status.textContent = `Only ${n} samples — too few to analyse.`; btnReveal.disabled = true; return; }
    const span = t[n - 1] - t[0];
    const sps = span > 0 ? (n - 1) / span : (d.nominalSps || 200);
    const fc = clamp(Number(cutoff.value) || 8, 1, 50);
    filtered = lowpassFiltfilt(rawG, sps, fc);
    const { freq, amplitude } = computeFFT(filtered, sps);
    const bf = [], ba = [];
    fft.clear();
    fft.beginBatch();
    for (let i = 0; i < freq.length && freq[i] <= FREEVIB_FFT_MAX_HZ; i++) {
      fft.push(freq[i], amplitude[i]);
      bf.push(freq[i]); ba.push(amplitude[i]);
    }
    fft.endBatch();
    fft.setPeaks(findPeaks(bf, ba, { minHeightRatio: 0.2, minDistance: 0.3 }));
    analysis = analyzeFreeVibration(t, filtered, sps, bf, ba);
    drawTrace();
    const prefix = `${n} samples, ~${span.toFixed(1)} s at ${sps.toFixed(0)} SPS. Low-pass ${fc} Hz`;
    status.textContent = analysis.ok
      ? `${prefix} · FFT peak ≈ ${analysis.fftPeakHz.toFixed(2)} Hz.`
      : `${prefix}. ${analysis.reason}.`;
    answer.textContent = '';
    btnReveal.disabled = !analysis.ok;
  }
  function drawTrace() {
    const y = showRaw.checked ? rawG : filtered;
    time.clear();
    time.beginBatch();
    for (let i = 0; i < t.length; i++) time.push(t[i], y[i]);
    time.endBatch();
  }
  cutoff.addEventListener('change', analyse);
  showRaw.addEventListener('change', drawTrace);
  btnReveal.addEventListener('click', () => {
    const a = analysis;
    if (!a || !a.ok) return;
    answer.textContent = `f_d ≈ ${a.fd.toFixed(3)} Hz · ζ ≈ ${a.zeta.toFixed(4)} (δ ≈ ${a.delta.toFixed(4)}/cycle) · fₙ ≈ ${a.fn.toFixed(3)} Hz — from ${a.nPeaks} peaks`;
    btnReveal.disabled = true;
  });
  analyse();
  return { charts: [time, fft] };
}
