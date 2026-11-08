import { PCB1Client } from './pcb1-client.js';
import { RollingChart, setChartTheme, MATLAB_COLORS } from './chart.js';
import { BodeChart } from './bode-chart.js';
import { computeFFT, findPeaks } from './fft.js';
import { lowpassFiltfilt } from './filter.js';
import { phaseSeriesFor, resonanceFromPhase } from './sweep-analysis.js';
import { analyzeFreeVibration } from './freevib-analysis.js';
import {
  G_TO_MS2, renderLogsumTrace as drawLogsumTrace, renderLogsumSpectrum as drawLogsumSpectrum,
  logsumCaptureFacts, logsumRevealText,
} from './logsum-plot.js';
import {
  claimHmiSession, createFigure, updateFigure, deleteFigure, postFigureMessage,
  openFiguresWindow, figureTitle, reapOrphanFigures,
} from './figure-store.js';

const client = new PCB1Client();

// ============================================================
// Light/dark theme -- the topbar sun/moon buttons toggle body.light (CSS
// variables restyle the DOM) and swap the canvas-chart palette in step
// (setChartTheme repaints every registered chart, including static ones like
// the sweep/bump plots that otherwise only redraw on interaction). Persisted
// so the choice survives reloads. Dark stays the default look.
// ============================================================
const THEME_KEY = 'hmi-theme';
let theme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';

function applyTheme() {
  document.body.classList.toggle('light', theme === 'light');
  setChartTheme(theme);
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.textContent = theme === 'light' ? '🌙 Dark' : '☀ Light';
    btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  });
}
applyTheme(); // runs before the charts below are constructed, so their first draw matches

document.querySelectorAll('.theme-toggle').forEach((btn) =>
  btn.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, theme);
    applyTheme();
  }),
);

// ============================================================
// Figures -- the MATLAB-style Figures tab (figures.html). Every capture (Log
// Summary, Bump Test, RPM Sweep, Free Vibration) is saved there as a numbered
// figure that stays until it is closed, so going back to the motor panel,
// changing the speed and taking the next capture never loses the last plot.
// Lifecycle: a figure is created when the capture starts (a spinner -- and,
// with Auto-open on, the Figures tab comes to the front, which a browser only
// allows inside the click), filled in when the result arrives, and dropped if
// the capture ends with nothing to show. The modals here are unchanged.
// See figure-store.js (storage, numbering) and figures.js (the tab).
// ============================================================
const HMI_SESSION = claimHmiSession();
const FIGURES_AUTO_KEY = 'hmi-figures-autoopen';
const chkFiguresAuto = document.getElementById('chk-figures-auto');
const toastEl = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const toastOpen = document.getElementById('toast-open');

try { chkFiguresAuto.checked = localStorage.getItem(FIGURES_AUTO_KEY) !== '0'; } catch { /* storage blocked */ }
chkFiguresAuto.addEventListener('change', () => {
  try { localStorage.setItem(FIGURES_AUTO_KEY, chkFiguresAuto.checked ? '1' : '0'); } catch { /* storage blocked */ }
});

const POPUP_BLOCKED = 'The browser blocked the Figures tab — allow pop-ups for this site, then use the Figures button.';
document.querySelectorAll('.btn-figures').forEach((btn) => btn.addEventListener('click', () => {
  if (!openFiguresWindow()) showToast(POPUP_BLOCKED, { open: false, ms: 8000 });
}));
toastOpen.addEventListener('click', () => { hideToast(); openFiguresWindow(); });
document.getElementById('toast-close').addEventListener('click', () => hideToast());

let toastTimer = null;
function showToast(text, { open = true, ms = 5000 } = {}) {
  toastText.textContent = text;
  toastOpen.hidden = !open;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); toastEl.hidden = true; }

// type -> the capture currently filling that figure:
// { demo, started, idPromise (-> figure id | null), chain (serialises writes) }
const pendingFig = { logsum: null, bump: null, sweep: null, freevib: null };
// A Log Summary result normally lands within ~10 s; past this the spinner is
// dropped (a late result still becomes a figure -- see finishFigure).
const LOGSUM_FIGURE_TIMEOUT_MS = 30000;

// Call synchronously from the capture's click handler, before any await.
function beginFigure(type, data = null) {
  if (chkFiguresAuto.checked && !openFiguresWindow()) showToast(POPUP_BLOCKED, { open: false, ms: 8000 });
  if (pendingFig[type]) dropFigure(type);
  const demo = client.isDemo;
  const status = type === 'sweep' ? 'running' : 'pending';
  const p = { demo, started: false, idPromise: null, chain: null };
  p.idPromise = createFigure({
    type, status, demo, owner: HMI_SESSION, data, title: figureTitle(type, data, { demo, status }),
  }).then((record) => {
    postFigureMessage({ type: 'upsert', record, select: true });
    return record.id;
  }).catch((err) => { console.warn('[figures] could not create the figure:', err); return null; });
  p.chain = p.idPromise.then(() => {});
  pendingFig[type] = p;
  if (type === 'logsum') {
    setTimeout(() => { if (pendingFig.logsum === p) dropFigure('logsum'); }, LOGSUM_FIGURE_TIMEOUT_MS);
  }
}

// The capture ended with nothing to show: remove its placeholder figure.
function dropFigure(type) {
  const p = pendingFig[type];
  if (!p) return;
  pendingFig[type] = null;
  p.chain = p.chain.then(async () => {
    const id = await p.idPromise;
    if (id == null) return;
    await deleteFigure(id);
    postFigureMessage({ type: 'delete', id });
  }).catch((err) => console.warn('[figures] could not remove the figure:', err));
}

// Live data for a figure still running (the sweep's points).
function updatePendingFigure(type, data) {
  const p = pendingFig[type];
  if (!p) return;
  const title = figureTitle(type, data, { demo: p.demo, status: 'running' });
  p.chain = p.chain.then(async () => {
    const id = await p.idPromise;
    if (id == null) return;
    const record = await updateFigure(id, { data, title });   // null if it was closed meanwhile
    if (record) postFigureMessage({ type: 'upsert', record, select: false });
  }).catch((err) => console.warn('[figures] could not update the figure:', err));
}

// The result arrived: fill the figure in. If it was closed in the Figures tab
// meanwhile (or never got created), a finished capture is still kept -- as a
// new figure, like MATLAB's plot() opening one when there is none.
function finishFigure(type, data, { select = true } = {}) {
  const p = pendingFig[type];
  pendingFig[type] = null;
  const demo = p ? p.demo : client.isDemo;
  const fields = { status: 'done', data, title: figureTitle(type, data, { demo }), finishedAt: new Date().toISOString() };
  (p ? p.chain : Promise.resolve()).then(async () => {
    const id = p ? await p.idPromise : null;
    let record = id != null ? await updateFigure(id, fields) : null;
    if (!record) record = await createFigure({ type, demo, owner: HMI_SESSION, ...fields });
    postFigureMessage({ type: 'upsert', record, select });
    showToast(`Saved as Figure ${record.num} in the Figures tab.`);
  }).catch((err) => {
    console.warn('[figures] could not save the figure:', err);
    appendLog(`[warn] This capture could not be saved to the Figures tab (${err?.message || err}).`);
  });
}

// Live status text for a figure's spinner ("Receiving data… 3200 samples"),
// at most a few per second. Sent from the data events, not the animation-frame
// previews: those stop while the HMI tab is in the background.
const progressSentAt = {};
function progressFigure(type, text, { force = false } = {}) {
  const p = pendingFig[type];
  if (!p) return;
  const now = performance.now();
  if (!force && now - (progressSentAt[type] || 0) < 250) return;
  progressSentAt[type] = now;
  p.idPromise.then((id) => {
    if (id != null && pendingFig[type] === p) postFigureMessage({ type: 'progress', id, text });
  });
}

function sweepFigureData(aborted = false) {
  return {
    mode: currentRunDamped ? 'damped' : 'undamped',
    points: currentSweepPoints.slice(),
    resonanceHz: Number(sweepResonanceHz.value),
    aborted,
  };
}
function freevibFigureData(aborted = false) {
  return {
    samples: freevibSamples.slice(),
    nominalSps: freevibNominalSps,
    cutoffHz: Number(freevibCutoff.value) || 8,
    aborted,
  };
}

client.addEventListener('mode', (e) => {
  const m = e.detail;
  // "started" = the board really entered the capture (runBumpTest etc. first
  // pass through busy/idle while stopping whatever was running).
  if (pendingFig.bump && m.startsWith('bump')) pendingFig.bump.started = true;
  if (pendingFig.freevib && m === 'freevib') pendingFig.freevib.started = true;
  if (pendingFig.sweep && m === 'sweep') pendingFig.sweep.started = true;
  if (m !== 'idle' && m !== 'disconnected') return;
  // Back to idle without the result event (bump aborted while armed, a stop
  // that timed out, the cable pulled): keep what's worth keeping.
  if (pendingFig.bump?.started) dropFigure('bump');
  if (pendingFig.freevib?.started) {
    if (freevibSamples.length >= 8) finishFigure('freevib', freevibFigureData(true));
    else dropFigure('freevib');
  }
  if (pendingFig.sweep?.started) {
    if (currentSweepPoints.length) finishFigure('sweep', sweepFigureData(true), { select: false });
    else dropFigure('sweep');
  }
  if (m === 'disconnected') dropFigure('logsum');   // its result can't arrive any more
});

// Figures left half-made by an HMI tab that was closed or reloaded mid-capture.
reapOrphanFigures({ mySession: HMI_SESSION }).catch((err) => console.warn('[figures] orphan check failed:', err));

// ============================================================
// Apparatus panel image -- one reference render, swapped between deployed
// (strobe mode initialized/running) and retracted (everything else), driven
// off the same 'mode' event that already drives the strobo start/stop
// button enablement below.
// ============================================================
const apparatusImage = document.getElementById('apparatus-image');
const apparatusImageCaption = document.getElementById('apparatus-image-caption');
function setApparatusDeployed(deployed) {
  apparatusImage.src = deployed
    ? 'assets/deployed - clear background.png'
    : 'assets/retracted - clear background.png';
  apparatusImage.alt = deployed
    ? 'Apparatus with stroboscope arm deployed'
    : 'Apparatus with stroboscope arm retracted';
  apparatusImageCaption.textContent = deployed ? 'Deployed' : 'Retracted';
}

// ============================================================
// Screen navigation
// ============================================================
// Crossfade between full-screen sections. display can't be transitioned, so we
// fade the outgoing screen out (remove .visible), swap display once that's
// done, then fade the incoming one in on the next frame. Same dark background
// throughout, so it reads as a smooth dissolve rather than a hard cut.
const SCREEN_FADE_MS = 350;
function showScreen(id, onShown) {
  const target = document.getElementById(id);
  const current = document.querySelector('.screen.active');
  if (!target || current === target) return;

  const reveal = () => {
    if (current) current.classList.remove('active', 'visible');
    window.scrollTo(0, 0);
    target.classList.add('active');
    // Target is display:block now (measurable), even though the opacity fade
    // hasn't started -- callers that need real dimensions (e.g. chart resize)
    // run here rather than synchronously after showScreen, which now defers
    // display until the outgoing fade-out completes.
    if (onShown) onShown();
    // Two frames so display:block lands before opacity flips -- otherwise the
    // browser coalesces both and the transition never runs.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => target.classList.add('visible')),
    );
  };

  if (!current) {
    reveal();
    return;
  }

  current.classList.remove('visible'); // start fade-out
  let done = false;
  const finish = (e) => {
    if (done || (e && e.target !== current)) return; // ignore bubbled child transitions
    done = true;
    current.removeEventListener('transitionend', finish);
    reveal();
  };
  current.addEventListener('transitionend', finish);
  setTimeout(finish, SCREEN_FADE_MS + 80); // fallback if transitionend is missed
}

// Splash is user-dismissed: the Continue button fades in (CSS) once the intro
// animation has settled, and clicking it advances to the status screen. No
// auto-advance -- the user can linger on the splash as long as they like.
document
  .getElementById('btn-splash-continue')
  .addEventListener('click', () => showScreen('screen-status'));

// ============================================================
// Shared serial log (mirrored into both screens' log panels) -- a real
// debugging surface for bench bring-up: both directions (RX/TX), local-time
// timestamps, a saveable in-memory buffer, an optional high-rate-row filter,
// and a console mirror. See the log toolbar in the dashboard's Auxiliary panel.
// ============================================================
const logOutputs = [document.getElementById('log-output'), document.getElementById('dash-log-output')];

// Full session buffer (every line, both directions) -- what "Save Log"
// exports, independent of what the display filter currently shows. Capped
// generously so a full bump dump (~11k rows) plus context still fits.
const LOG_BUFFER_MAX = 20000;
const logBuffer = [];
let hideDataRows = false; // display filter: hide high-rate R/V/K stream rows

const DIR_MARK = { rx: '<', tx: '>', sys: '*' };
const isDataRow = (text) => /^[RVK],/.test(text);
// High-rate rows we don't want to flood the DevTools console with: the tagged
// R/V/K stream rows AND the bare-CSV rows of a bulk dump (e.g. the bump test's
// ~11k rows, which start with "<index>,"). 11k console.log calls per dump is
// itself enough main-thread load to help stall the serial read loop.
const isBulkRow = (text) => isDataRow(text) || /^\d+,/.test(text);

function logTimestamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const formatEntry = (e) => `${e.t} ${DIR_MARK[e.dir] || '*'} ${e.text}`;

client.link.addEventListener('line', (e) => appendLog(e.detail, 'rx'));
client.link.addEventListener('tx', (e) => appendLog(e.detail, 'tx'));

// dir: 'rx' (from board), 'tx' (sent by us), 'sys' (client-side notes/errors).
function appendLog(text, dir = 'sys') {
  const entry = { t: logTimestamp(), dir, text };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);

  // Console mirror for everything except the high-rate stream rows (which
  // would flood DevTools) -- gives a searchable/savable copy that survives
  // even if the connect handshake fails before the dashboard is reached.
  if (!(dir === 'rx' && isBulkRow(text))) console.log(formatEntry(entry));

  if (hideDataRows && dir === 'rx' && isDataRow(text)) return; // buffered, not shown
  renderAppend(formatEntry(entry));
}

// Batched DOM rendering. Appending to the log element once per line is a
// main-thread bottleneck during bulk dumps (~11k bump rows): it slows the
// serial read loop enough that the board's USB TX buffer backs up and drops
// lines (corrupt/gappy captures, and a lost '#END' hangs the transfer). We
// coalesce pending lines and flush at most once per animation frame instead.
let pendingLogText = '';
let logFlushScheduled = false;

function renderAppend(line) {
  pendingLogText += line + '\n';
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushLog);
  }
}

function flushLog() {
  logFlushScheduled = false;
  const chunk = pendingLogText;
  pendingLogText = '';
  if (!chunk) return;
  logOutputs.forEach((el) => {
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    el.textContent += chunk;
    if (el.textContent.length > 24000) el.textContent = el.textContent.slice(-18000);
    if (atBottom) el.scrollTop = el.scrollHeight;
  });
}

// Full redraw from the buffer (e.g. after toggling the filter).
function rerenderLog() {
  pendingLogText = ''; // this rebuilds the whole view from the buffer -- drop any queued appends
  logFlushScheduled = false;
  const tail = logBuffer
    .filter((e) => !(hideDataRows && e.dir === 'rx' && isDataRow(e.text)))
    .slice(-800)
    .map(formatEntry)
    .join('\n');
  logOutputs.forEach((el) => { if (el) { el.textContent = tail ? tail + '\n' : ''; el.scrollTop = el.scrollHeight; } });
}

function saveLog() {
  if (!logBuffer.length) return;
  const text = logBuffer.map(formatEntry).join('\n');
  downloadText(text, `hmi-serial-log_${wibTimestamp()}.txt`);
}

function clearLog() {
  logBuffer.length = 0;
  pendingLogText = '';
  logFlushScheduled = false;
  logOutputs.forEach((el) => { if (el) el.textContent = ''; });
}

// Wire the log toolbar (dashboard Auxiliary panel).
const logHideData = document.getElementById('log-hide-data');
const btnLogSave = document.getElementById('btn-log-save');
const btnLogClear = document.getElementById('btn-log-clear');
if (logHideData) logHideData.addEventListener('change', () => { hideDataRows = logHideData.checked; rerenderLog(); });
if (btnLogSave) btnLogSave.addEventListener('click', saveLog);
if (btnLogClear) btnLogClear.addEventListener('click', clearLog);

// ============================================================
// Status screen
// ============================================================
const dotConnection = document.getElementById('dot-connection');
const detailConnection = document.getElementById('detail-connection');
const btnConnect = document.getElementById('btn-connect');
const dotAccel = document.getElementById('dot-accel');
const detailAccel = document.getElementById('detail-accel');
const btnCheckAccel = document.getElementById('btn-check-accel');
const btnEnterDashboard = document.getElementById('btn-enter-dashboard');

const dashDotConnection = document.getElementById('dash-dot-connection');
const dashConnectionText = document.getElementById('dash-connection-text');
const dashModePill = document.getElementById('dash-mode-pill');
dashModePill.textContent = client.mode;
setDot(dashDotConnection, 'fail');

// Device tab (dashboard) mirrors the status screen's connection/accel-check
// readouts in a condensed form, so they're checkable without leaving the
// dashboard -- see triggerAccelCheck() and the 'mode' listener below, which
// both update this pair and the status-screen pair together.
const deviceDotConnection = document.getElementById('device-dot-connection');
const deviceConnectionText = document.getElementById('device-connection-text');
const deviceDotAccel = document.getElementById('device-dot-accel');
const deviceDetailAccel = document.getElementById('device-detail-accel');
const btnDeviceCheckAccel = document.getElementById('btn-device-check-accel');

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  btnConnect.textContent = 'Connecting…';
  try {
    await client.connect();
    setDot(dotConnection, 'ok');
    detailConnection.textContent = 'Connected @ 115200 baud';
    btnConnect.textContent = 'Connected';
    btnCheckAccel.disabled = false;
    btnEnterDashboard.disabled = false;
  } catch (err) {
    setDot(dotConnection, 'fail');
    detailConnection.textContent = err.message;
    btnConnect.disabled = false;
    btnConnect.textContent = 'Retry Connect';
  }
});

async function triggerAccelCheck() {
  [dotAccel, deviceDotAccel].forEach((d) => setDot(d, 'pending'));
  [detailAccel, deviceDetailAccel].forEach((d) => { d.textContent = 'Running quick ADS1220 check…'; });
  btnCheckAccel.disabled = true;
  btnDeviceCheckAccel.disabled = true;
  try {
    await client.runAccelCheck();
  } catch (err) {
    [dotAccel, deviceDotAccel].forEach((d) => setDot(d, 'fail'));
    [detailAccel, deviceDetailAccel].forEach((d) => { d.textContent = err.message; });
    btnCheckAccel.disabled = false;
    btnDeviceCheckAccel.disabled = false;
  }
}
btnCheckAccel.addEventListener('click', triggerAccelCheck);
btnDeviceCheckAccel.addEventListener('click', triggerAccelCheck);

client.addEventListener('accel-check', (e) => {
  const r = e.detail;
  const detailText =
    `${r.meanV.toFixed(3)} V (${r.meanG.toFixed(2)} g), ${r.rateSps.toFixed(0)} SPS` +
    (r.ok ? '' : ` — expected ~1.95 V ± 0.15 V (check orientation/wiring)`);
  [dotAccel, deviceDotAccel].forEach((d) => setDot(d, r.ok ? 'ok' : 'warn'));
  [detailAccel, deviceDetailAccel].forEach((d) => { d.textContent = detailText; });
  btnCheckAccel.disabled = false;
  btnDeviceCheckAccel.disabled = false;
});

btnEnterDashboard.addEventListener('click', () => enterDashboard());

const btnSkipDemo = document.getElementById('btn-skip-demo');
btnSkipDemo.addEventListener('click', () => {
  client.enterDemoMode();
  enterDashboard();
});

// Charts are built while the dashboard screen is still display:none (so
// getBoundingClientRect() reads 0x0) -- re-measure them via showScreen's
// onShown hook, which fires once the dashboard is display:block (after the
// screen crossfade swaps it in).
function enterDashboard() {
  showScreen('screen-dashboard', () => {
    rpmChart.resize();
    dutyChart.resize();
    accelChart.resize();
  });
}

function setDot(el, state) {
  el.className = 'status-dot ' + state;
}

client.addEventListener('mode', (e) => {
  dashModePill.textContent = client.isDemo ? `${e.detail} (demo)` : e.detail;
  if (e.detail === 'disconnected') {
    setDot(dashDotConnection, 'fail');
    dashConnectionText.textContent = 'Disconnected';
    setDot(deviceDotConnection, 'fail');
    deviceConnectionText.textContent = 'Disconnected';
  } else if (client.isDemo) {
    setDot(dashDotConnection, 'warn');
    dashConnectionText.textContent = 'Demo Mode (simulated)';
    setDot(deviceDotConnection, 'warn');
    deviceConnectionText.textContent = 'Demo Mode (simulated)';
  } else {
    setDot(dashDotConnection, 'ok');
    dashConnectionText.textContent = 'Connected';
    setDot(deviceDotConnection, 'ok');
    deviceConnectionText.textContent = 'Connected';
    // A real connection succeeded -- demo mode no longer makes sense here.
    btnSkipDemo.disabled = true;
  }
});

// ============================================================
// Motor panel (HMI `live` -- shares the combined live session with the Accel
// panel, see PCB1Client). Two loops, one session:
//   - CLOSED: `t <rpm>`, PI+feedforward holds the target RPM.
//   - OPEN:   `d <duty>`, the commanded 0-255 PWM goes straight to the motor
//             and the resulting speed is whatever the load allows.
// Both are settings *within* PCB1's one `live` mode, not separate modes, so
// the selector can be flipped mid-run without stopping the shaft or the Accel
// panel -- which is the demonstration (open loop sags under load near
// resonance where closed loop holds).
// ============================================================
const rpmSlider = document.getElementById('rpm-target-slider');
const rpmNumber = document.getElementById('rpm-target-number');
const rpmInputLabel = document.getElementById('rpm-input-label');
const segRpmClosed = document.getElementById('rpm-mode-closed');
const segRpmOpen = document.getElementById('rpm-mode-open');
const btnRpmStart = document.getElementById('btn-rpm-start');
const btnRpmStop = document.getElementById('btn-rpm-stop');
const rpmTargetValue = document.getElementById('rpm-target-value');
const rpmMeasuredValue = document.getElementById('rpm-measured-value');
const rpmRawValue = document.getElementById('rpm-raw-value');
const rpmDutyValue = document.getElementById('rpm-duty-value');
// Live strip charts: MATLAB figures with tight x limits (the window scrolls
// smoothly instead of jumping between rounded tick limits). Target is MATLAB's
// second colour, dashed, so it reads as the setpoint under the measured trace.
const rpmChart = new RollingChart(document.getElementById('rpm-chart'), {
  title: 'RPM: Target vs. Measured',
  yLabel: 'RPM',
  series: [
    { label: 'Target RPM', color: MATLAB_COLORS[1], lineStyle: '--' },
    { label: 'Measured RPM', color: MATLAB_COLORS[0] },
  ],
  maxPoints: 400,
  xTight: true,
  legendLocation: 'northoutside',
  exportName: 'RPM target vs measured',
});
const dutyChart = new RollingChart(document.getElementById('duty-chart'), {
  title: 'Commanded Duty',
  yLabel: 'Duty (0-255)',
  series: [{ label: 'Duty', color: MATLAB_COLORS[0] }],
  yMin: 0, yMax: 255, autoScaleY: false,
  maxPoints: 400,
  xTight: true,
});

const RPM_MAX = 3400;
const DUTY_MAX = 255;
let openLoop = false;
// One slider serves both loops, but RPM and duty are different quantities on
// different scales -- so each keeps its own remembered value rather than
// carrying a number across that would mean nothing there (and 3400 "duty"
// would just clamp to full).
let lastTargetRpm = 0;
let lastDuty = 0;

function loopMax() { return openLoop ? DUTY_MAX : RPM_MAX; }
function loopValue() { return clamp(Number(rpmNumber.value), 0, loopMax()); }

function renderLoopMode() {
  segRpmClosed.classList.toggle('active', !openLoop);
  segRpmClosed.setAttribute('aria-pressed', String(!openLoop));
  segRpmOpen.classList.toggle('active', openLoop);
  segRpmOpen.setAttribute('aria-pressed', String(openLoop));

  const max = loopMax();
  rpmSlider.max = String(max);
  rpmNumber.max = String(max);
  rpmInputLabel.textContent = openLoop ? 'Duty (0-255)' : 'Target RPM';
  const v = clamp(openLoop ? lastDuty : lastTargetRpm, 0, max);
  rpmSlider.value = String(v);
  rpmNumber.value = String(v);
}
renderLoopMode();

// Open-loop duty is adjusted LIVE as the slider is dragged -- that's the point
// of the mode, so this is throttled rather than debounced. A debounce would
// send nothing until the drag stopped, which is exactly the feel to avoid;
// the trailing timer still guarantees the final position lands.
const DUTY_SEND_INTERVAL_MS = 80;
let dutySendAt = 0;
let dutySendTimer = null;
function sendDutyLive(duty) {
  clearTimeout(dutySendTimer);
  dutySendTimer = setTimeout(() => {
    dutySendAt = performance.now();
    client.setOpenLoopDuty(duty).catch((err) => appendLog('[error] ' + err.message));
  }, Math.max(0, DUTY_SEND_INTERVAL_MS - (performance.now() - dutySendAt)));
}

function onLoopValueInput() {
  const v = loopValue();
  if (openLoop) {
    lastDuty = v;
    if (client.rpmActive) sendDutyLive(v);
  } else {
    lastTargetRpm = v;   // closed loop retargets on 'change' instead -- see below
  }
}
rpmSlider.addEventListener('input', () => { rpmNumber.value = rpmSlider.value; onLoopValueInput(); });
rpmNumber.addEventListener('input', () => { rpmSlider.value = rpmNumber.value; onLoopValueInput(); });

// Switching loop while the motor is running hands the live session over to the
// other controller; the firmware makes that bumpless both ways (see
// runHmiLive), so the shaft keeps turning and the Accel panel sees no gap.
async function setLoopMode(next) {
  if (openLoop === next) return;
  openLoop = next;
  renderLoopMode();
  if (!client.rpmActive) return;
  try {
    if (openLoop) await client.setOpenLoopDuty(lastDuty);
    else await client.setTargetRpm(lastTargetRpm);
  } catch (err) {
    appendLog('[error] ' + err.message);
  }
}
segRpmClosed.addEventListener('click', () => setLoopMode(false));
segRpmOpen.addEventListener('click', () => setLoopMode(true));

btnRpmStart.addEventListener('click', async () => {
  const v = loopValue();
  btnRpmStart.disabled = true;
  try {
    if (openLoop) await client.startOpenLoopDuty(v);
    else await client.startTargetRpmControl(v);
    rpmChart.clear();
    dutyChart.clear();
  } catch (err) {
    appendLog('[error] ' + err.message);
    btnRpmStart.disabled = false;
  }
});

// Only stops the RPM panel's own data -- if the Accel panel is also
// streaming, the shared PCB1 session (mode l) keeps running for it; see
// PCB1Client.stopRpm(). Final button states are reconciled by the 'mode'
// listener below, since stopping RPM can also affect Accel's buttons.
btnRpmStop.addEventListener('click', async () => {
  btnRpmStop.disabled = true;
  await client.stopRpm();
});

// Closed loop retargets on 'change' (slider release), not 'input': each new
// setpoint is a step the controller then has to settle, so streaming them
// mid-drag would just chase the slider. Open loop is the opposite and is
// handled live in onLoopValueInput() above.
let targetDebounce = null;
[rpmSlider, rpmNumber].forEach((el) => {
  el.addEventListener('change', () => {
    if (openLoop || !client.rpmActive) return;
    clearTimeout(targetDebounce);
    targetDebounce = setTimeout(() => {
      client.setTargetRpm(clamp(Number(el.value), 0, RPM_MAX)).catch((err) => appendLog('[error] ' + err.message));
    }, 100);
  });
});

client.addEventListener('rpm-sample', (e) => {
  const s = e.detail;
  // Open loop has no setpoint, so the firmware reports target as `nan`. Show a
  // dash and let the chart's Target trace break rather than drawing a
  // fictitious flat line at 0.
  rpmTargetValue.textContent = Number.isFinite(s.target_rpm) ? s.target_rpm.toFixed(0) : '—';
  rpmMeasuredValue.textContent = s.rpm.toFixed(0);
  rpmRawValue.textContent = s.raw_rpm.toFixed(0);
  rpmDutyValue.textContent = s.duty.toFixed(0);
  rpmChart.push(s.time_ms, s.target_rpm, s.rpm);
  dutyChart.push(s.time_ms, s.duty);
});

// ============================================================
// Accel panel (HMI `live` -- decimated vibration stream, the other half
// of the shared combined session)
// ============================================================
const btnAccelStart = document.getElementById('btn-accel-start');
const btnAccelStop = document.getElementById('btn-accel-stop');
const accelRmsValue = document.getElementById('accel-rms-value');
const accelCrestValue = document.getElementById('accel-crest-value');
const accelStatus = document.getElementById('accel-status');
const ACCEL_WINDOW_S = 3;
const accelChart = new RollingChart(document.getElementById('accel-chart'), {
  title: 'Vibration (live)',
  yLabel: 'Accel (g)',
  series: [{ label: 'Accel (g)', color: MATLAB_COLORS[0] }],
  maxPoints: 500,
  windowSeconds: ACCEL_WINDOW_S,
  xTight: true,
});

btnAccelStart.addEventListener('click', async () => {
  btnAccelStart.disabled = true;
  accelStatus.textContent = 'Streaming…';
  accelChart.clear();
  try {
    await client.startVibrationLive();
  } catch (err) {
    appendLog('[error] ' + err.message);
    btnAccelStart.disabled = false;
    accelStatus.textContent = '';
  }
});

// Only stops the Accel panel's own data -- if the RPM panel is also
// running, the shared session (mode l) keeps going for it; see
// PCB1Client.stopVibrationLive(). Final button states are reconciled by
// the 'mode' listener below.
btnAccelStop.addEventListener('click', async () => {
  btnAccelStop.disabled = true;
  await client.stopVibrationLive();
  accelStatus.textContent = '';
});

client.addEventListener('vibration-live-sample', (e) => {
  const s = e.detail;
  accelChart.push(s.time_ms, s.accel_g);

  // Recomputed over the chart's rolling ACCEL_WINDOW_S-wide buffer (see
  // RollingChart's windowSeconds), so both figures continuously describe
  // "the last ACCEL_WINDOW_S", same idea as mode 6's own AC RMS stat but
  // over a short live-decimated window instead of a fixed high-rate capture.
  const windowVals = accelChart.data[0];
  const n = windowVals.length;
  const rms = n ? Math.sqrt(windowVals.reduce((sum, v) => sum + v * v, 0) / n) : 0;
  const peak = n ? Math.max(...windowVals.map(Math.abs)) : 0;
  const crest = rms > 0 ? peak / rms : 0;

  accelRmsValue.textContent = rms.toFixed(4);
  accelCrestValue.textContent = crest > 0 ? crest.toFixed(2) : '—';
});

// ============================================================
// Log Summary (`log`, issued mid-`live`) -- the teaching capture.
//
// Plots the whole shipped window (1 s of the 5 s capture, on the capture's own
// clock) as acceleration in m/s^2 against time in s, with the encoder pulses
// redrawn as the old rig's rectangular proximity-probe trace, in a MATLAB-style
// figure -- i.e. the Prak2.m "Detailed view" the practicum was taught with --
// plus the FFT of the same capture. The student reads pulse -> trough (Δt) and
// pulse -> pulse (T) with data tips and computes the phase themselves; the
// firmware's own answer stays behind the Reveal button so the reading gets
// attempted first.
// ============================================================
const btnLogsum = document.getElementById('btn-logsum');
const btnCloseLogsum = document.getElementById('btn-close-logsum');
const btnLogsumReveal = document.getElementById('btn-logsum-reveal');
const logsumAnswer = document.getElementById('logsum-answer');
const logsumAnswerRaw = document.getElementById('logsum-answer-raw');
const logsumAnswerNote = document.getElementById('logsum-answer-note');
const logsumRawNote = document.getElementById('logsum-raw-note');
const logsumStatus = document.getElementById('logsum-status');
const logsumRpm = document.getElementById('logsum-rpm');
const logsumAmp = document.getElementById('logsum-amp');
const logsumPeriod = document.getElementById('logsum-period');
const logsumPulses = document.getElementById('logsum-pulses');
const logsumHarmonics = document.getElementById('logsum-harmonics');
const logsumViewBtns = {
  raw:  document.getElementById('logsum-view-raw'),
  lp:   document.getElementById('logsum-view-lp'),
  sync: document.getElementById('logsum-view-sync'),
};

// x = time (s), y = acceleration (m/s²), drawn as a MATLAB figure (white axes,
// '-b' accel, '-r' proximity pulse, clickable data tips) on purpose: it stands in
// for Prak2.m's "Detailed view" --  plot(time,prox,'-r'); hold on;
// plot(time,coeff*filtered_accel2,'-b')  -- so students and assistants read it
// exactly the way they already read that figure. BodeChart rather than
// RollingChart: this is a static XY slice, and its wheel-zoom/drag-pan/data tips
// are what a student needs to zoom to 2-3 cycles and read an edge and a trough.
const logsumChart = new BodeChart(document.getElementById('logsum-chart'), {
  title: 'Acceleration and Proximity Pulse vs. Time',
  xLabel: 'Time (s)',
  yLabel: 'Acceleration (m/s²)',
  // Legend above the axes: inside, it would sit on the pulse train or the trace.
  legendLocation: 'northoutside',
  exportName: 'Log Summary - acceleration and proximity pulse',
});
// The same capture's spectrum -- Prak2.m's FFT figure (xlim([0 100])): the
// "is the response dominant at running speed?" check before trusting a phase.
const logsumFftChart = new BodeChart(document.getElementById('logsum-fft-chart'), {
  title: 'FFT Spectrum (raw signal)',
  xLabel: 'Frequency (Hz)',
  yLabel: 'Amplitude (m/s²)',
  resonanceFormat: (hz) => `1× running speed = ${hz.toFixed(1)} Hz`,
  exportName: 'Log Summary - FFT spectrum',
});
const btnLogsumClearTips = document.getElementById('btn-logsum-cleartips');
const logsumFftStatus = document.getElementById('logsum-fft-status');

let lastLogsum = null;      // last capture, kept so the view can be re-rendered
// 'raw' | 'lp' | 'sync'. Defaults to the low-pass: the raw ADXL trace carries
// broadband noise across the ADS1220's whole ~1165 Hz band, which makes picking
// a trough by eye genuinely hard, and every view here is phase-preserving so
// the smoothing can't distort the measurement. Raw stays one click away.
let logsumView = 'lp';
// Capture facts (sample count, rate, window) -- constant for a given capture.
// renderLogsumTrace() appends what the current view did to it.
let logsumBaseStatus = '';

// The drawing itself lives in logsum-plot.js, shared with the Figures tab so a
// capture looks identical in both places.
function renderLogsumTrace() {
  if (!lastLogsum) return;
  logsumHarmonics.disabled = logsumView === 'raw';
  const note = drawLogsumTrace(logsumChart, lastLogsum, { view: logsumView, harmonics: logsumHarmonics.value });
  logsumStatus.textContent = `${logsumBaseStatus} ${note}`.trim();
}

function renderLogsumFft(s) {
  logsumFftStatus.textContent = drawLogsumSpectrum(logsumFftChart, s);
}

function setLogsumView(view) {
  if (logsumView === view) return;
  logsumView = view;
  for (const [k, btn] of Object.entries(logsumViewBtns)) {
    btn.classList.toggle('active', k === view);
    btn.setAttribute('aria-pressed', String(k === view));
  }
  renderLogsumTrace();
}
for (const [k, btn] of Object.entries(logsumViewBtns)) {
  btn.addEventListener('click', () => setLogsumView(k));
}
// 'change' not 'input' -- re-filtering ~2330 samples per keystroke is wasted work.
// Applies to the sync view too: it band-limits before averaging.
logsumHarmonics.addEventListener('change', () => { if (logsumView !== 'raw') renderLogsumTrace(); });
btnLogsumClearTips.addEventListener('click', () => { logsumChart.clearTips(); logsumFftChart.clearTips(); });

btnLogsum.addEventListener('click', async () => {
  btnLogsum.disabled = true;
  beginFigure('logsum');
  openModal('modal-logsum');
  logsumChart.resize();
  logsumChart.clear();        // also drops any data tips from the last capture
  logsumChart.setVLines([]);
  logsumFftChart.resize();
  logsumFftChart.clear();
  logsumFftChart.setResonanceX(null);
  logsumFftStatus.textContent = '';
  lastLogsum = null;          // don't let a view switch re-render the previous capture
  logsumBaseStatus = '';
  logsumStatus.textContent = 'Recording 5 s at full rate…';
  logsumAnswer.textContent = '';
  logsumAnswerRaw.textContent = '';
  logsumAnswerNote.hidden = true;
  logsumRawNote.hidden = true;
  btnLogsumReveal.disabled = true;
  [logsumRpm, logsumAmp, logsumPeriod, logsumPulses].forEach((el) => { el.textContent = '—'; });
  try {
    await client.logSummary(5);
  } catch (err) {
    appendLog('[error] ' + err.message);
    logsumStatus.textContent = err.message;
    btnLogsum.disabled = false;
    dropFigure('logsum');
  }
});

btnCloseLogsum.addEventListener('click', () => closeModal('modal-logsum'));

client.addEventListener('logsum-result', (e) => {
  const s = e.detail;
  lastLogsum = s;

  const T_ms = s.rpmAvg > 0 ? 60000 / s.rpmAvg : NaN;
  logsumRpm.textContent = s.rpmAvg.toFixed(1);
  logsumAmp.textContent = (s.ampG * G_TO_MS2).toFixed(3);
  logsumPeriod.textContent = isFinite(T_ms) ? T_ms.toFixed(1) : '—';
  logsumPulses.textContent = String(s.pulses.length);

  logsumBaseStatus = logsumCaptureFacts(s);
  renderLogsumTrace();   // draws the trace and appends what it did to the status
  renderLogsumFft(s);

  btnLogsumReveal.disabled = !isFinite(s.phaseDeg);
  btnLogsum.disabled = client.mode !== 'live';
  finishFigure('logsum', s);
});

// The revealed number is the displacement-referenced phase (firmware raw phase
// minus the 180 deg accel-vs-displacement inversion) -- see logsum-plot.js.
btnLogsumReveal.addEventListener('click', () => {
  const r = logsumRevealText(lastLogsum);
  if (!r) return;
  logsumAnswer.textContent = r.main;
  // Shown smaller/dimmer: it's the provenance of the number above, not the
  // answer the student is checking against.
  logsumAnswerRaw.textContent = r.raw;

  logsumAnswerNote.hidden = false;
  logsumRawNote.hidden = false;
  btnLogsumReveal.disabled = true;
});

// ============================================================
// Strobo panel (HMI `strobe` -- closed-loop target RPM + strobe delta)
// ============================================================
const strobRpm = document.getElementById('strobo-rpm');
const strobDelta = document.getElementById('strobo-delta');
const btnStroboStart = document.getElementById('btn-strobo-start');
const btnStroboStop = document.getElementById('btn-strobo-stop');
const stroboRpmValue = document.getElementById('strobo-rpm-value');

btnStroboStart.addEventListener('click', async () => {
  btnStroboStart.disabled = true;
  try {
    // Target RPM, not duty: PCB1 holds it closed-loop (protocol v2). 3400 is
    // the firmware's own clamp -- see runHmiStrobe / runHmiLive.
    await client.startStrobe(clamp(Number(strobRpm.value), 0, 3400), Number(strobDelta.value));
    btnStroboStop.disabled = false;
  } catch (err) {
    appendLog('[error] ' + err.message);
    btnStroboStart.disabled = false;
  }
});

btnStroboStop.addEventListener('click', async () => {
  btnStroboStop.disabled = true;
  await client.stop();
  btnStroboStart.disabled = false;
});

client.addEventListener('strobe-sample', (e) => {
  stroboRpmValue.textContent = e.detail.raw_rpm.toFixed(0);
});

// ============================================================
// Auxiliary panel (HMI `relay <0|1>`)
// ============================================================
const relayToggle = document.getElementById('relay-toggle');

// PCB1's setup() drives PIN_RELAY HIGH, and relaySet() maps HIGH -> on, so the
// board boots with the relay (lighting LED) ALREADY ON. Start matching that:
// initialising to false made the panel disagree with the hardware from the
// moment of connect, and the first click then sent a redundant 'relay 1' that
// changed nothing physically while the label finally caught up -- i.e. the
// toggle was effectively off-by-one until it had been clicked once.
let relayOn = true;

function renderRelay() {
  relayToggle.textContent = relayOn ? 'ON' : 'OFF';
  relayToggle.classList.toggle('on', relayOn);
}
renderRelay();

relayToggle.addEventListener('click', async () => {
  relayToggle.disabled = true;
  try {
    // Don't update relayOn optimistically here: setRelay() waits for the
    // board's '# relay on/off' reply, which fires the 'relay-state' event
    // below and updates relayOn from the hardware (the authority). Flipping
    // it here too double-counted the change -- the event already set the
    // real state, so `relayOn = !relayOn` inverted it back to wrong, leaving
    // the toggle permanently stuck sending 'relay 0'.
    await client.setRelay(!relayOn);
  } catch (err) {
    appendLog('[error] ' + err.message);
  } finally {
    relayToggle.disabled = false;
  }
});

// The board is the authority on relay state: it reports '# relay on/off' for
// every change, including ones the panel didn't initiate (strobe mode turns
// the lamp off on entry and restores it on exit). Without this the toggle
// silently desyncs after any strobe run.
client.addEventListener('relay-state', (e) => {
  relayOn = e.detail.on;
  renderRelay();
});

// ============================================================
// Modals (Sweep/Bode, Bump Test). Closing one only hides it -- it does NOT
// stop whatever's running, same reasoning as the dashboard grid keeping
// RPM/Accel streaming regardless of which part of the page you're looking
// at (e.g. arm a bump test, close the modal, go tap the apparatus, reopen
// later to see whether it triggered).
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ============================================================
// RPM Sweep / Bode plot (HMI `sweep` command)
// ============================================================
const btnOpenSweep = document.getElementById('btn-open-sweep');
const btnCloseSweep = document.getElementById('btn-close-sweep');
const btnSweepStart = document.getElementById('btn-sweep-start');
const btnSweepStop = document.getElementById('btn-sweep-stop');
const btnSweepSave = document.getElementById('btn-sweep-save');
const inputSweepLoad = document.getElementById('input-sweep-load');
const btnSweepClearOverlays = document.getElementById('btn-sweep-clear-overlays');
const sweepStatus = document.getElementById('sweep-status');
const sweepResonanceHz = document.getElementById('sweep-resonance-hz');
const sweepGapLo = document.getElementById('sweep-gap-lo');
const sweepGapHi = document.getElementById('sweep-gap-hi');
const btnSweepGapSet = document.getElementById('btn-sweep-gap-set');
const sweepGapStatus = document.getElementById('sweep-gap-status');
const sweepChart = new BodeChart(document.getElementById('sweep-chart'), {
  title: 'Accel Amplitude vs. RPM',
  xLabel: 'RPM (measured)',
  yLabel: 'Accel Amplitude (g, 1×RPM)',
  resonanceX: Number(sweepResonanceHz.value) * 60, // Hz -> RPM (shaft speed), matches PCB1's ~22.1 Hz / 1326 RPM natural frequency
  exportName: 'Sweep - amplitude vs RPM',
});

// Phase plot, stacked under the amplitude Bode plot and sharing its RPM
// x-axis. Fixed 0-180 y-domain (with headroom for noise/overshoot) rather
// than auto-fit: phase is a physically bounded quantity, so a fixed frame
// keeps runs comparable and stops a flat pre-resonance trace being blown up
// into meaningless noise. refY marks the 90 deg resonance crossing.
const sweepPhaseChart = new BodeChart(document.getElementById('sweep-phase-chart'), {
  title: 'Response Phase vs. RPM',
  xLabel: 'RPM (measured)',
  yLabel: 'Phase lag (deg)',
  resonanceX: Number(sweepResonanceHz.value) * 60,
  yFixed: { min: -30, max: 210 },
  yTicks: [-30, 0, 30, 60, 90, 120, 150, 180, 210],
  refY: 90,
  exportName: 'Sweep - phase vs RPM',
});
// Same RPM axis on both plots: zooming/panning one moves the other (MATLAB linkaxes x).
sweepChart.linkX(sweepPhaseChart);

// Resonance line is user-adjustable (defaults to 22.1 Hz per PCB1's
// SYSTEM_OVERVIEW.md) since the true peak can shift as the apparatus is
// modified (added damping/mass, hardware wear, etc.).
sweepResonanceHz.addEventListener('input', () => {
  const hz = Number(sweepResonanceHz.value);
  const rpm = isFinite(hz) && hz > 0 ? hz * 60 : null;
  sweepChart.setResonanceX(rpm);
  sweepPhaseChart.setResonanceX(rpm);
});

const SWEEP_LIVE_COLOR = MATLAB_COLORS[0];
const SWEEP_OVERLAY_COLORS = MATLAB_COLORS.slice(1);
let sweepOverlayColorIdx = 0;
let currentSweepPoints = []; // full point objects (all CSV fields), for Save -- the chart only keeps {x,y}

// ---- Damping case: undamped (mode r) vs damped (mode r2) ----
// Selecting "Damped" doesn't switch straight away -- r2 only means anything
// with the damper physically fitted, so it first pops a reminder (with
// before/after photos) that must be confirmed. `sweepDamped` is what's sent to
// the firmware; `currentRunDamped` snapshots it when a run starts so the live
// trace's legend/label reflects the mode that was actually running even if the
// selector is changed afterwards.
const segUndamped = document.getElementById('sweep-mode-undamped');
const segDamped = document.getElementById('sweep-mode-damped');
const btnDamperConfirm = document.getElementById('btn-damper-confirm');
const btnDamperCancel = document.getElementById('btn-damper-cancel');
const btnDamperCancelX = document.getElementById('btn-damper-cancel-x');
let sweepDamped = false;
let currentRunDamped = false;

// ---- No-dwell gap (undamped sweep only -- mode r / `sweep 0`) ----
// Lets a particular setup's actual instability band be dialled in from the
// dashboard rather than re-flashing, when it differs from the firmware
// default (1325-1350) -- see `gap <lo> <hi>` in HMI_PROTOCOL.md. `lastKnownIdle`
// mirrors the 'mode' event's `idle` flag so the damping-case toggle (which
// fires with no 'mode' event of its own) can re-gate the row too. Declared
// (and initialised) before renderSweepMode()'s first call below, which reaches
// it via refreshGapControls() -- a `let` here only after that call would leave
// it in the temporal dead zone and throw on page load.
let lastKnownIdle = true;
function refreshGapControls() {
  const supported = client.supportsGapAdjust;
  const enabled = lastKnownIdle && !sweepDamped && supported;
  sweepGapLo.disabled = sweepGapHi.disabled = btnSweepGapSet.disabled = !enabled;
  if (!supported) sweepGapStatus.textContent = 'Firmware has no gap-adjust support — re-flash it.';
  else if (sweepDamped) sweepGapStatus.textContent = 'Gap only applies to the undamped (r) sweep.';
  else if (!lastKnownIdle) sweepGapStatus.textContent = '';
}

function renderSweepMode() {
  segUndamped.classList.toggle('active', !sweepDamped);
  segUndamped.setAttribute('aria-pressed', String(!sweepDamped));
  segDamped.classList.toggle('active', sweepDamped);
  segDamped.setAttribute('aria-pressed', String(sweepDamped));
  refreshGapControls();
}
renderSweepMode();

btnSweepGapSet.addEventListener('click', async () => {
  const lo = Number(sweepGapLo.value);
  const hi = Number(sweepGapHi.value);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    sweepGapStatus.textContent = 'Enter numeric RPM values.';
    return;
  }
  btnSweepGapSet.disabled = true;
  sweepGapStatus.textContent = 'Setting…';
  try {
    const applied = await client.setSweepGap(lo, hi);
    sweepGapLo.value = applied.lo;
    sweepGapHi.value = applied.hi;
    sweepGapStatus.textContent = `Gap set to ${applied.lo}-${applied.hi} RPM.`;
    appendLog(`[info] sweep no-dwell gap set to ${applied.lo}-${applied.hi} RPM`);
  } catch (err) {
    sweepGapStatus.textContent = `Rejected: ${err.message}`;
    appendLog('[error] gap set: ' + err.message);
  } finally {
    refreshGapControls();
  }
});

// The damper's added mass lowers the natural frequency to ~21.1 Hz (from the
// undamped ~22.1 Hz), so the Bode/phase resonance reference line follows the
// selected case. Applied on mode change; a manual edit to the field afterwards
// still sticks until the next mode switch. Kept in sync with the firmware's
// damped fine band (CRPMSWEEP_FULL_FINE_* in main.cpp, centred on 1266 RPM).
const UNDAMPED_RESONANCE_HZ = 22.1;
const DAMPED_RESONANCE_HZ = 21.1;
function applyModeResonanceHz() {
  sweepResonanceHz.value = sweepDamped ? DAMPED_RESONANCE_HZ : UNDAMPED_RESONANCE_HZ;
  sweepResonanceHz.dispatchEvent(new Event('input')); // reuses the listener that moves both charts' resonance line
}

segUndamped.addEventListener('click', () => {
  sweepDamped = false;
  renderSweepMode();
  applyModeResonanceHz();
});
// Ask before switching to damped; the mode only flips on confirm (below).
segDamped.addEventListener('click', () => {
  if (sweepDamped) return; // already selected
  openModal('modal-damper');
});
btnDamperConfirm.addEventListener('click', () => {
  sweepDamped = true;
  renderSweepMode();
  applyModeResonanceHz();
  closeModal('modal-damper');
});
// Cancel / dismiss leaves the current selection (undamped) untouched.
const cancelDamper = () => closeModal('modal-damper');
btnDamperCancel.addEventListener('click', cancelDamper);
btnDamperCancelX.addEventListener('click', cancelDamper);

btnOpenSweep.addEventListener('click', () => {
  openModal('modal-sweep');
  sweepChart.resize();
  sweepPhaseChart.resize();
});
btnCloseSweep.addEventListener('click', () => closeModal('modal-sweep'));

btnSweepStart.addEventListener('click', async () => {
  btnSweepStart.disabled = true;
  // Only reset the live trace -- loaded overlays are the whole point of
  // comparing a new run against previous ones (e.g. before/after adding
  // damping), so a new sweep shouldn't discard them.
  sweepChart.removeSeries('live');
  sweepPhaseChart.removeSeries('live');
  currentSweepPoints = [];
  currentRunDamped = sweepDamped;
  beginFigure('sweep', sweepFigureData());
  btnSweepSave.disabled = true;
  sweepStatus.textContent = `Sweeping ${currentRunDamped ? 'damped (r2)' : 'undamped (r)'}…`;
  try {
    await client.runRpmSweep(currentRunDamped);
  } catch (err) {
    appendLog('[error] ' + err.message);
    btnSweepStart.disabled = false;
    sweepStatus.textContent = '';
    dropFigure('sweep');
  }
});

btnSweepStop.addEventListener('click', async () => {
  btnSweepStop.disabled = true;
  await client.stop();
});

const SWEEP_RPM_STD_TOL = 8;   // RPM wander above this => rotor was hunting; amplitude isn't steady-state

client.addEventListener('sweep-point', (e) => {
  const s = e.detail;
  currentSweepPoints.push(s);
  // Plot the 1x-RPM lock-in amplitude (noise-rejecting -- decisive at low
  // RPM), not the broadband RMS. The full point (incl. accel_amplitude_g and
  // rpm_std) is kept in currentSweepPoints so Save Run exports them.
  const runLabel = `Current Run (${currentRunDamped ? 'Damped' : 'Undamped'})`;
  sweepChart.appendPoint('live', s.rpm_avg, s.accel_amp_1x_g, SWEEP_LIVE_COLOR, runLabel);
  // Phase: rebuild the whole series (not append) -- the low-RPM zero offset
  // refines as points come in and applies retroactively to the whole trace.
  sweepPhaseChart.setSeries('live', phaseSeriesFor(currentSweepPoints), SWEEP_LIVE_COLOR, runLabel);
  // Stationarity warning: near the gap the rotor can hunt (speed up/slow down)
  // so neither amplitude metric is a valid steady-state reading -- surface it.
  if (s.rpm_std > SWEEP_RPM_STD_TOL) {
    appendLog(`[warn] ${s.rpm_avg.toFixed(0)} RPM: rotor hunting (rpm_std ${s.rpm_std.toFixed(1)}) -- amplitude and phase not steady-state`);
  }
  updatePendingFigure('sweep', sweepFigureData());
});

client.addEventListener('sweep-done', (e) => {
  const { aborted } = e.detail;
  const base = aborted
    ? `Sweep aborted -- kept ${currentSweepPoints.length} point(s).`
    : `Sweep complete -- ${currentSweepPoints.length} point(s).`;
  const res = resonanceFromPhase(currentSweepPoints);
  let extra = '';
  if (res) {
    extra = ` Phase crosses 90° at ~${res.rpm.toFixed(0)} RPM (${(res.rpm / 60).toFixed(2)} Hz)`;
    extra += res.spanRpm > 10
      ? ` -- interpolated across a ${res.spanRpm.toFixed(0)} RPM gap, so treat it as approximate.`
      : '.';
  }
  sweepStatus.textContent = base + extra;
  btnSweepSave.disabled = currentSweepPoints.length === 0;
  // The figure has been filling in live; at the end it's only finalised (not
  // brought to the front), in case the Figures tab is showing something else.
  if (currentSweepPoints.length) finishFigure('sweep', sweepFigureData(aborted), { select: false });
  else dropFigure('sweep');
});

btnSweepSave.addEventListener('click', () => {
  if (!currentSweepPoints.length) return;
  const label = window.prompt('Label for this run (used in the legend when reloaded):', '');
  const payload = {
    kind: 'sweep-run',
    savedAt: new Date().toISOString(),
    label: label || null,
    mode: currentRunDamped ? 'damped' : 'undamped', // which firmware sweep (r2 vs r) produced this run
    points: currentSweepPoints,
  };
  downloadJson(payload, `${filenamePrefix(label)}Sweep_${wibTimestamp()}.json`);
});

inputSweepLoad.addEventListener('change', async () => {
  const files = [...inputSweepLoad.files];
  inputSweepLoad.value = ''; // allow re-selecting the same file(s) later
  for (const file of files) {
    try {
      const payload = JSON.parse(await file.text());
      if (!Array.isArray(payload.points)) throw new Error('missing "points" array');
      const color = SWEEP_OVERLAY_COLORS[sweepOverlayColorIdx++ % SWEEP_OVERLAY_COLORS.length];
      // Tag the auto-derived legend label with the run's damping case (when the
      // file recorded one) so undamped vs damped overlays are easy to tell apart.
      const label = payload.label ||
        `${file.name.replace(/\.json$/i, '')}${payload.mode ? ` [${payload.mode}]` : ''}`;
      const key = `overlay:${file.name}:${sweepOverlayColorIdx}`;
      // Plot 1x-RPM lock-in amplitude; fall back to broadband RMS for runs
      // saved before the lock-in column existed.
      const points = payload.points.map((p) => ({ x: p.rpm_avg, y: p.accel_amp_1x_g ?? p.accel_amplitude_g }));
      sweepChart.setSeries(key, points, color, label);
      // Phase overlay: each run is normalised against ITS OWN low-RPM points,
      // which is what makes runs comparable -- every run carries the same
      // mounting offset, but normalising per-run also absorbs any re-mount
      // between them. Runs saved before phase existed simply produce no
      // series here (their points have no phase_deg), leaving the amplitude
      // overlay working as before.
      const phasePoints = phaseSeriesFor(payload.points);
      if (phasePoints.length) {
        sweepPhaseChart.setSeries(key, phasePoints, color, label);
      } else {
        appendLog(`[info] "${file.name}" has no phase data (saved before phase was added) -- amplitude only.`);
      }
    } catch (err) {
      appendLog(`[error] Failed to load "${file.name}": ${err.message}`);
    }
  }
});

btnSweepClearOverlays.addEventListener('click', () => {
  sweepChart.clearExcept('live');
  sweepPhaseChart.clearExcept('live');
});

// ============================================================
// Bump Test (mode b)
// ============================================================
const btnOpenBump = document.getElementById('btn-open-bump');
const btnCloseBump = document.getElementById('btn-close-bump');
const bumpThreshold = document.getElementById('bump-threshold');
const bumpDuration = document.getElementById('bump-duration');
const btnBumpStart = document.getElementById('btn-bump-start');
const btnBumpStop = document.getElementById('btn-bump-stop');
const btnBumpSave = document.getElementById('btn-bump-save');
const bumpStatus = document.getElementById('bump-status');
const bumpTimeChart = new RollingChart(document.getElementById('bump-time-chart'), {
  title: 'Bump Test — Time Domain',
  yLabel: 'Accel (g)',
  series: [{ label: 'Accel (g)', color: MATLAB_COLORS[0] }],
  maxPoints: 40000, // one-shot bounded capture (<=15s @ ~2330 SPS), not a continuously-live feed
});
const bumpFftChart = new RollingChart(document.getElementById('bump-fft-chart'), {
  title: 'Bump Test — FFT Spectrum',
  xLabel: 'Frequency (Hz)',
  yLabel: 'Accel (g)',
  series: [{ label: 'FFT Amplitude', color: '#0000ff' }],   // Prak2.m: plot(freqB,MagnB,'-b')
  maxPoints: 10000,
  xScale: 1, // freq is already in Hz, not milliseconds
});
const BUMP_FFT_MAX_HZ = 300; // matches BumpTestESP32.m's xlim([0 300]) -- resonance content is well below this

let lastBumpResult = null;

btnOpenBump.addEventListener('click', () => { openModal('modal-bump'); bumpTimeChart.resize(); bumpFftChart.resize(); });
btnCloseBump.addEventListener('click', () => closeModal('modal-bump'));

btnBumpStart.addEventListener('click', async () => {
  const thresholdG = clamp(Number(bumpThreshold.value), 0.01, 10);
  const durationS = Math.round(clamp(Number(bumpDuration.value), 1, 15));
  btnBumpStart.disabled = true;
  beginFigure('bump', { thresholdG, durationS });
  btnBumpSave.disabled = true;
  bumpTimeChart.clear();
  bumpFftChart.clear();
  bumpStatus.textContent = 'Armed. Waiting for trigger…';
  try {
    await client.runBumpTest(thresholdG, durationS);
  } catch (err) {
    appendLog('[error] ' + err.message);
    btnBumpStart.disabled = false;
    bumpStatus.textContent = '';
    dropFigure('bump');
  }
});

btnBumpStop.addEventListener('click', async () => {
  btnBumpStop.disabled = true;
  await client.stop();
});

// True while the dump is streaming in. The per-frame preview below checks it so
// a frame that fires after bump-result can't overwrite the "Done" status with
// "Receiving data…" (the last rows and the result arrive in the same burst).
let bumpReceiving = false;

client.addEventListener('bump-triggered', (e) => {
  bumpReceiving = true;
  bumpStatus.textContent = `Triggered at ${e.detail.accelG.toFixed(3)} g -- capturing…`;
  progressFigure('bump', `Triggered at ${e.detail.accelG.toFixed(3)} g — receiving the capture…`, { force: true });
  // The ~11k-row dump is about to arrive: accumulate points without a redraw
  // per row (see RollingChart.beginBatch). A throttled preview redraw happens
  // in bump-sample; the final full-resolution draw is in bump-result.
  bumpTimeChart.beginBatch();
});

let bumpPreviewScheduled = false;
client.addEventListener('bump-sample', (e) => {
  const s = e.detail;
  bumpTimeChart.push(s.time_s * 1000, s.accel_g); // batched: no draw here
  progressFigure('bump', `Receiving data… (${bumpTimeChart.t.length} samples so far)`);
  // Coalesce the status text + live preview redraw to one per animation frame,
  // instead of once per row, so streaming the dump can't stall the read loop.
  if (!bumpPreviewScheduled) {
    bumpPreviewScheduled = true;
    requestAnimationFrame(() => {
      bumpPreviewScheduled = false;
      if (!bumpReceiving) return;
      bumpStatus.textContent = `Receiving data… (${bumpTimeChart.t.length} samples so far)`;
      bumpTimeChart.draw();
    });
  }
});

client.addEventListener('bump-result', (e) => {
  bumpReceiving = false;
  lastBumpResult = e.detail;
  const { raw, actualSps, peakG } = lastBumpResult;
  bumpTimeChart.endBatch(); // final full-resolution draw of the time domain
  const { freq, amplitude } = computeFFT(raw.map((r) => r.accel_g), actualSps);
  bumpFftChart.clear();
  bumpFftChart.beginBatch();
  const boundedFreq = [], boundedAmplitude = [];
  for (let i = 0; i < freq.length && freq[i] <= BUMP_FFT_MAX_HZ; i++) {
    bumpFftChart.push(freq[i], amplitude[i]);
    boundedFreq.push(freq[i]);
    boundedAmplitude.push(amplitude[i]);
  }
  bumpFftChart.endBatch();
  bumpFftChart.setPeaks(findPeaks(boundedFreq, boundedAmplitude));
  bumpStatus.textContent = `Done -- ${raw.length} samples, peak ${peakG.toFixed(3)} g.`;
  btnBumpSave.disabled = false;
  finishFigure('bump', {
    // Only what the figure plots (the full rows stay with Save Run): keeps a
    // 15 s capture's stored figure to a fraction of its raw size.
    raw: raw.map((r) => ({ time_s: r.time_s, accel_g: r.accel_g })),
    actualSps, peakG, thresholdG: lastBumpResult.thresholdG, biasV: lastBumpResult.biasV,
  });
});

btnBumpSave.addEventListener('click', () => {
  if (!lastBumpResult) return;
  const label = window.prompt('Label for this run (used in the saved filename):', '');
  const payload = {
    kind: 'bump-run',
    savedAt: new Date().toISOString(),
    label: label || null,
    thresholdG: lastBumpResult.thresholdG,
    peakG: lastBumpResult.peakG,
    actualSps: lastBumpResult.actualSps,
    biasV: lastBumpResult.biasV,
    raw: lastBumpResult.raw,
  };
  downloadJson(payload, `${filenamePrefix(label)}Bump_${wibTimestamp()}.json`);
});

// ============================================================
// Free Vibration (mode freevib) -- untriggered ring-down capture for natural
// frequency + logarithmic-decrement damping. Streams tagged F rows live as the
// beam rings down (~2.5 Hz), motor off. Mirrors the Bump Test's batched-live
// plotting, but with no trigger and its own peak-based analysis + reveal.
// ============================================================
const btnOpenFreeVib = document.getElementById('btn-open-freevib');
const btnCloseFreeVib = document.getElementById('btn-close-freevib');
const freevibDuration = document.getElementById('freevib-duration');
const btnFreeVibStart = document.getElementById('btn-freevib-start');
const btnFreeVibStop = document.getElementById('btn-freevib-stop');
const btnFreeVibSave = document.getElementById('btn-freevib-save');
const btnFreeVibReveal = document.getElementById('btn-freevib-reveal');
const freevibStatus = document.getElementById('freevib-status');
const freevibAnswer = document.getElementById('freevib-answer');
const freevibAnswerNote = document.getElementById('freevib-answer-note');
const freevibCutoff = document.getElementById('freevib-cutoff');
const freevibShowRaw = document.getElementById('freevib-show-raw');

const FREEVIB_FFT_MAX_HZ = 15;  // display/search ceiling -- the rig rings ~2.5 Hz

const freevibTimeChart = new RollingChart(document.getElementById('freevib-time-chart'), {
  title: 'Free Vibration — Ring-down',
  xLabel: 'Time (s)',
  yLabel: 'Accel (g)',
  series: [{ label: 'Accel (g)', color: MATLAB_COLORS[0] }],
  maxPoints: 20000, // 60 s max * 200 SPS = 12000 samples
  xScale: 1,        // x is already in seconds (F rows carry t_s directly)
});
const freevibFftChart = new RollingChart(document.getElementById('freevib-fft-chart'), {
  title: 'Free Vibration — FFT Spectrum',
  xLabel: 'Frequency (Hz)',
  yLabel: 'Accel (g)',
  series: [{ label: 'FFT Amplitude', color: '#0000ff' }],
  maxPoints: 20000,
  xScale: 1, // freq already in Hz
});

let freevibSamples = [];    // {time_s, accel_g} raw, accumulated over the current run (source of truth, saved as-is)
let freevibNominalSps = NaN;
let freevibEffSps = NaN;
let freevibFilteredG = null; // zero-phase low-pass of the raw accel -- the trace measured + analysed
let lastFreeVibAnalysis = null;
// True while F rows are streaming; see bumpReceiving for why the preview checks it.
let freevibRecording = false;
let freevibDurationS = NaN;  // requested record time of the current run (for the figure's progress text)

btnOpenFreeVib.addEventListener('click', () => {
  openModal('modal-freevib');
  freevibTimeChart.resize();
  freevibFftChart.resize();
});
btnCloseFreeVib.addEventListener('click', () => closeModal('modal-freevib'));

btnFreeVibStart.addEventListener('click', async () => {
  const durationS = Math.round(clamp(Number(freevibDuration.value), 2, 60));
  btnFreeVibStart.disabled = true;
  beginFigure('freevib', { durationS });
  btnFreeVibSave.disabled = true;
  btnFreeVibReveal.disabled = true;
  freevibAnswer.textContent = '';
  freevibAnswerNote.hidden = true;
  freevibSamples = [];
  freevibFilteredG = null;
  lastFreeVibAnalysis = null;
  freevibTimeChart.clear();
  freevibTimeChart.setPeaks([]);
  freevibFftChart.clear();
  freevibFftChart.setPeaks([]);
  freevibTimeChart.beginBatch();
  freevibRecording = true;   // also set on freevib-start; set here too in case the board never sends it
  freevibDurationS = durationS;
  freevibStatus.textContent = `Recording ${durationS} s — deflect the beam and let go now…`;
  try {
    await client.runFreeVib(durationS);
  } catch (err) {
    appendLog('[error] ' + err.message);
    freevibTimeChart.endBatch();
    freevibStatus.textContent = err.message;
    btnFreeVibStart.disabled = client.mode !== 'idle';
    dropFigure('freevib');
  }
});

btnFreeVibStop.addEventListener('click', async () => {
  btnFreeVibStop.disabled = true;
  await client.stop();
});

client.addEventListener('freevib-start', (e) => {
  freevibNominalSps = e.detail.sps;
  freevibRecording = true;
});

let freevibPreviewScheduled = false;
client.addEventListener('freevib-sample', (e) => {
  const s = e.detail;
  freevibSamples.push(s);
  freevibTimeChart.push(s.time_s, s.accel_g); // batched: no draw here
  progressFigure('freevib', `Recording… ${s.time_s.toFixed(1)}${isFinite(freevibDurationS) ? ` of ${freevibDurationS}` : ''} s` +
    (s.time_s < 1.5 ? ' — deflect the beam and let go.' : ''));
  if (!freevibPreviewScheduled) {
    freevibPreviewScheduled = true;
    requestAnimationFrame(() => {
      freevibPreviewScheduled = false;
      if (!freevibRecording) return;
      freevibStatus.textContent = `Recording… (${freevibSamples.length} samples, ${(freevibSamples.at(-1)?.time_s ?? 0).toFixed(1)} s)`;
      freevibTimeChart.draw();
    });
  }
});

client.addEventListener('freevib-done', (e) => {
  freevibRecording = false;
  freevibTimeChart.endBatch(); // flush the live (raw) preview
  const n = freevibSamples.length;
  if (n < 8) {
    freevibStatus.textContent = e.detail.aborted
      ? `Aborted — only ${n} samples, too few to analyse.`
      : `Done — only ${n} samples captured.`;
    btnFreeVibStart.disabled = client.mode !== 'idle';
    dropFigure('freevib');
    return;
  }
  const base = e.detail.aborted ? `Aborted — kept ${n} samples` : `Done — ${n} samples`;
  analyzeAndRenderFreeVib(base);
  btnFreeVibSave.disabled = false;
  btnFreeVibStart.disabled = client.mode !== 'idle';
  finishFigure('freevib', freevibFigureData(e.detail.aborted));
});

// Re-filter + re-analyse when the cutoff changes (only post-capture -- during a
// live capture the samples are still arriving). 'change' not 'input' so it
// fires on commit, not per keystroke.
freevibCutoff.addEventListener('change', () => {
  if (freevibSamples.length >= 8 && client.mode !== 'freevib') {
    analyzeAndRenderFreeVib(`${freevibSamples.length} samples`);
  }
});
// Toggle raw/filtered without recomputing the analysis (analysis always uses the
// filtered trace -- the toggle is a visual compare only).
freevibShowRaw.addEventListener('change', () => {
  if (client.mode !== 'freevib') redrawFreeVibTimeTrace();
});

// Zero-phase low-pass the raw ring-down at the current cutoff, then FFT +
// peak/log-dec analysis on the FILTERED trace (cleaner peaks). Updates the FFT
// chart, redraws the time trace, and sets the status + reveal state. Shared by
// capture completion and the cutoff control.
function analyzeAndRenderFreeVib(label) {
  const n = freevibSamples.length;
  const t = freevibSamples.map((p) => p.time_s);
  const rawG = freevibSamples.map((p) => p.accel_g);
  const tSpan = t[n - 1] - t[0];
  freevibEffSps = tSpan > 0 ? (n - 1) / tSpan : (freevibNominalSps || 200);

  const cutoff = clamp(Number(freevibCutoff.value), 1, 50);
  freevibFilteredG = lowpassFiltfilt(rawG, freevibEffSps, cutoff);

  // FFT of the filtered signal -- the noise the low-pass removes only muddied
  // the spectrum; the ~2.5 Hz mode sits well inside the passband.
  const { freq, amplitude } = computeFFT(freevibFilteredG, freevibEffSps);
  freevibFftChart.clear();
  freevibFftChart.beginBatch();
  const bandF = [], bandA = [];
  for (let i = 0; i < freq.length && freq[i] <= FREEVIB_FFT_MAX_HZ; i++) {
    freevibFftChart.push(freq[i], amplitude[i]);
    bandF.push(freq[i]); bandA.push(amplitude[i]);
  }
  freevibFftChart.endBatch();
  freevibFftChart.setPeaks(findPeaks(bandF, bandA, { minHeightRatio: 0.2, minDistance: 0.3 }));

  lastFreeVibAnalysis = analyzeFreeVibration(t, freevibFilteredG, freevibEffSps, bandF, bandA);
  redrawFreeVibTimeTrace();

  const a = lastFreeVibAnalysis;
  const prefix = `${label}, ~${tSpan.toFixed(1)} s at ${freevibEffSps.toFixed(0)} SPS`;
  freevibStatus.textContent = a.ok
    ? `${prefix}. Low-pass ${cutoff} Hz · FFT peak ≈ ${a.fftPeakHz.toFixed(2)} Hz. Read f and log-dec off the (filtered) plot with the cursor, then reveal.`
    : `${prefix}. ${a.reason} — read what you can off the plot with the cursor.`;
  btnFreeVibReveal.disabled = !a.ok;
  // Recomputing invalidates any prior reveal, so re-estimate against the new trace.
  freevibAnswer.textContent = '';
  freevibAnswerNote.hidden = true;
}

// Redraw the time chart with either the filtered trace (default) or the raw one
// (Show raw toggle). Analysis always uses the filtered data regardless.
function redrawFreeVibTimeTrace() {
  if (!freevibSamples.length) return;
  const t = freevibSamples.map((p) => p.time_s);
  const useRaw = freevibShowRaw.checked || !freevibFilteredG;
  const y = useRaw ? freevibSamples.map((p) => p.accel_g) : freevibFilteredG;
  freevibTimeChart.clear();
  freevibTimeChart.beginBatch();
  for (let i = 0; i < t.length; i++) freevibTimeChart.push(t[i], y[i]);
  freevibTimeChart.endBatch();
}

btnFreeVibReveal.addEventListener('click', () => {
  const a = lastFreeVibAnalysis;
  if (!a || !a.ok) return;
  freevibAnswer.textContent =
    `f_d ≈ ${a.fd.toFixed(3)} Hz · ζ ≈ ${a.zeta.toFixed(4)} (δ ≈ ${a.delta.toFixed(4)}/cycle) · ` +
    `fₙ ≈ ${a.fn.toFixed(3)} Hz  —  from ${a.nPeaks} peaks; FFT peak ${a.fftPeakHz.toFixed(2)} Hz`;
  freevibAnswerNote.hidden = false;
  btnFreeVibReveal.disabled = true;
});

btnFreeVibSave.addEventListener('click', () => {
  if (!freevibSamples.length) return;
  const label = window.prompt('Label for this run (used in the saved filename):', '');
  const payload = {
    kind: 'freevib-run',
    savedAt: new Date().toISOString(),
    label: label || null,
    nominalSps: freevibNominalSps,
    lowpassCutoffHz: clamp(Number(freevibCutoff.value), 1, 50), // filter used for the trace/analysis; samples below are RAW
    analysis: lastFreeVibAnalysis,
    samples: freevibSamples, // {time_s, accel_g} -- raw, unfiltered
  };
  downloadJson(payload, `${filenamePrefix(label)}FreeVib_${wibTimestamp()}.json`);
});


// Bandung/WIB is UTC+7 (no DST) -- computed explicitly rather than relying on
// the browser/OS timezone, so saved run filenames stay consistent regardless
// of what the laptop's system clock is set to. Formatted as
// YYYY-MM-DD_HH.MM.SS -- periods instead of colons since ':' isn't a legal
// Windows filename character.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
function wibTimestamp() {
  const d = new Date(Date.now() + WIB_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}.${pad(d.getUTCMinutes())}.${pad(d.getUTCSeconds())}`;
  return `${date}_${time}`;
}

function filenamePrefix(label) {
  if (!label) return '';
  const cleaned = label.trim().replace(/[<>:"/\\|?*\s]+/g, '_');
  return cleaned ? `${cleaned}_` : '';
}

function downloadJson(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), filename);
}

function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: 'text/plain' }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// Global mode-driven button enablement. PCB1 only runs one menu mode at a
// time, so non-RPM/Accel "start" controls are disabled unless idle -- but
// RPM and Accel share mode l (see PCB1Client's rpmActive/vibActive), so
// each can be independently started/stopped while the other is running,
// not just while fully idle. This listener fires both on real mode
// transitions and on rpmActive/vibActive changing without mode itself
// changing (PCB1Client._notifyMode()), since either can flip which
// buttons should be enabled.
// ============================================================
// During a sweep, PCB1 owns the motor and streams live RPM/accel to the
// RPM/Accel panels read-only (settle-phase live view). Their normal
// Start/Stop controls don't apply, so the Start button becomes a plain
// "Auto Mode" indicator instead -- so students can tell the panels are being
// driven automatically by the sweep, not by them. Original labels captured
// once here (they're the HTML defaults at load).
const RPM_START_LABEL = btnRpmStart.textContent;     // "Start"
const ACCEL_START_LABEL = btnAccelStart.textContent; // "Start Live Stream"
function setPanelsAutoMode(on) {
  btnRpmStart.classList.toggle('auto-mode', on);
  btnAccelStart.classList.toggle('auto-mode', on);
  btnRpmStart.textContent = on ? 'Auto Mode (sweep)' : RPM_START_LABEL;
  btnAccelStart.textContent = on ? 'Auto Mode (sweep)' : ACCEL_START_LABEL;
}

let wasSweepMode = false;
client.addEventListener('mode', (e) => {
  const idle = e.detail === 'idle';
  const live = e.detail === 'live';
  const sweep = e.detail === 'sweep';

  setApparatusDeployed(e.detail === 'strobe');

  setPanelsAutoMode(sweep);
  // Fresh live view when a sweep begins (the panels are idle beforehand --
  // runRpmSweep() ensures idle first -- so nothing live is being discarded).
  if (sweep && !wasSweepMode) { rpmChart.clear(); dutyChart.clear(); accelChart.clear(); }
  wasSweepMode = sweep;

  btnRpmStart.disabled = sweep || !(idle || (live && !client.rpmActive));
  btnRpmStop.disabled = sweep || !client.rpmActive;
  // The loop selector matters when idle (it picks what Start does) AND while
  // live (it hands the running session over) -- but a sweep owns the motor, so
  // it's locked there. Open loop is additionally gated on the board actually
  // supporting `d <duty>`: firmware that predates it drops the command
  // silently, so a live-looking slider that did nothing would be worse than a
  // disabled button that says why.
  segRpmClosed.disabled = sweep || !(idle || live);
  segRpmOpen.disabled = sweep || !(idle || live) || !client.supportsOpenLoop;
  segRpmOpen.title = client.supportsOpenLoop
    ? '' : 'This PCB1 firmware has no open-loop support — re-flash it.';
  btnAccelStart.disabled = sweep || !(idle || (live && !client.vibActive));
  btnAccelStop.disabled = sweep || !client.vibActive;
  // Log Summary runs *inside* the live session (that's what keeps the shaft at
  // the speed the student set), so it needs live -- not idle -- to be active.
  btnLogsum.disabled = !live;
  btnStroboStart.disabled = !idle;
  btnStroboStop.disabled = e.detail !== 'strobe';
  relayToggle.disabled = !idle;
  btnCheckAccel.disabled = !idle;
  btnDeviceCheckAccel.disabled = !idle;

  btnSweepStart.disabled = !idle;
  btnSweepStop.disabled = e.detail !== 'sweep';
  // Lock the damping-case selector mid-run so the label can't disagree with the
  // sweep actually executing (the firmware picked its grid/order at start).
  segUndamped.disabled = !idle;
  segDamped.disabled = !idle;
  lastKnownIdle = idle;
  refreshGapControls();

  btnBumpStart.disabled = !idle;
  // Abort only works while armed (waiting for a trigger) -- once
  // triggered/capturing, PCB1's capture loop doesn't check for it (see
  // runBumpTest()'s doc comment in main.cpp).
  btnBumpStop.disabled = e.detail !== 'bump-armed';

  // Free vibration: open the modal while idle (or reopen mid-capture); recording
  // needs idle (motor off); Stop aborts the running capture at any point (the
  // firmware checks for abort every loop iteration, unlike the bump capture).
  const freevib = e.detail === 'freevib';
  btnOpenFreeVib.disabled = !(idle || freevib);
  btnFreeVibStart.disabled = !idle;
  btnFreeVibStop.disabled = !freevib;
});

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, isFinite(v) ? v : lo)); }
