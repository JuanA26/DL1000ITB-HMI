// Adapter between the web UI and PCB1's HMI-mode protocol -- a tagged,
// fully line-terminated protocol with NO blocking prompts (see
// "Embedded - fin/TA - PCB1/HMI_PROTOCOL.md"). This replaces the earlier
// draft that drove PCB1's human serial menu by matching "...: " prompt tails
// and typing values; the firmware now offers a machine-oriented HMI mode
// alongside that human "test mode", and this file speaks it.
//
// Wire format (every line ends in '\n'):
//   Commands (client -> PCB1), one line each, at HMI idle:
//     live <rpm> | strobe <targetRpm> <delta> | sweep <0|1> | bump <thr> <dur> |
//     freevib <dur> | accelcheck | relay <0|1> | stop (x) | id
//   While a stream runs: `t <rpm>` (closed-loop retarget, live only),
//     `d <duty>` (open-loop PWM 0-255, live only), `stop` / `x`.
//   Responses (PCB1 -> client), tag is the first comma-field:
//     R,t_ms,target,measured,duty,raw        (RPM control row)
//     V,t_ms,accel_g                         (decimated vibration row)
//     K,t_ms,raw_rpm                          (strobe live RPM row)
//     P,rpm_avg,target,amp_mV,amp_g,sps,amp_1x_g,rpm_std,phase_deg
//                                             (sweep point; amp_1x_g = 1x-RPM lock-in,
//                                              rpm_std = RPM wander, phase_deg = raw 1x phase)
//     F,t_s,accel_g                           (free-vibration live stream row)
//     A,sps,mean_v,mean_g,std_v,pkpk_v       (accel-check result)
//     I,fw=...,...                            (capabilities/info)
//     !,code,detail                           (error)
//     #BEGIN <name> k=v ...  /  #END <name>  (bulk frame, e.g. bump dump)
//     # ...                                   (human-readable status/comment)
//
// Only one PCB1 mode runs at a time, so every start*() stops whatever's
// running first -- except startTargetRpmControl()/startVibrationLive(),
// which drive the SAME combined `live` mode so the RPM and Accel panels can
// stream concurrently (see startTargetRpmControl() below). During a `sweep`
// the firmware also streams R/V rows (settle-phase live view) which this
// client forwards to those same panels read-only -- see _onLine().
import { SerialLink } from './serial.js';

const ADXL_EXPECTED_BIAS_V = 1.95;
const ADXL_BIAS_TOL_V = 0.15;

// HMI protocol version this client speaks; must match PCB1's `# HMI READY vN`
// banner (HMI_BANNER in main.cpp). connect() refuses to run on a mismatch --
// see the check there for why that's a safety matter, not pedantry.
const HMI_PROTOCOL_VERSION = 2;

// Constant offset the demo bakes into its RAW phase, mimicking what real
// hardware reports. 180 deg is the PHYSICAL one: the ADXL335 measures
// acceleration and a = -w^2 * x, so the accel signal is inverted relative to
// displacement -- at max displacement (which is when the encoder fires, below
// resonance) the accel trace is at its TROUGH, not its peak.
//
// This used to be an arbitrary 137, which made demo mode teach a lie: the pulse
// landed near-but-not-on the trough at low RPM, which is physically impossible,
// and the revealed phase never matched the textbook 0/90/180 story. A real rig
// adds a further mounting-angle offset on top of this 180; that leftover is
// exactly what the Bode plot's low-RPM normalisation removes.
const DEMO_PHASE_OFFSET_DEG = 180;

export class PCB1Client extends EventTarget {
  constructor() {
    super();
    this.link = new SerialLink();
    // disconnected | idle | busy | live | strobe | sweep | freevib |
    // bump-armed | bump-triggered | bump-capturing
    this._mode = 'disconnected';
    // 'live' (combined) runs the RPM and Accel panels' data concurrently in
    // one PCB1 session -- these two flags track which panel(s) actually asked
    // for it, independent of the shared session's lifecycle. See
    // startTargetRpmControl/startVibrationLive/stopRpm/stopVibrationLive.
    this._rpmWanted = false;
    this._vibWanted = false;
    // In-progress bulk frame (e.g. bump dump), or null. See _onLine()'s frame
    // handling and _bump.
    this._frame = null;
    this._bump = null;
    // Parsed `I,k=v,...` capability line, or null until the board sends one.
    // Gates optional features the firmware may predate -- see supportsOpenLoop.
    this._caps = null;
    this._demo = false;
    this._demoTimer = null;
    this._demoTargetRpm = 0;
    // Demo mirror of the firmware's open-loop state (see runHmiLive in main.cpp).
    this._demoOpenLoop = false;
    this._demoOpenDuty = 0;

    this.link.addEventListener('line', (e) => this._onLine(e.detail));
    this.link.addEventListener('close', () => this._setMode('disconnected'));
  }

  get mode() { return this._mode; }
  get isDemo() { return this._demo; }
  // Whether the RPM/Accel panel's own data is actually flowing right now --
  // narrower than `mode === 'live'`, which is true whenever EITHER panel
  // started the shared session.
  get rpmActive() { return this._mode === 'live' && this._rpmWanted; }
  get vibActive() { return this._mode === 'live' && this._vibWanted; }

  // Whether this board's `live` accepts `d <duty>` (open-loop PWM). Advertised
  // by the firmware's `I,...` line as `openloop=1`. Deliberately STRICT when
  // unknown: firmware that predates the feature parses `d 120` as an unknown
  // line and drops it silently, so a permissive default would give a slider
  // that looks live and does nothing. Greying the control out says so instead.
  get supportsOpenLoop() { return this._demo || !!(this._caps && this._caps.openloop === '1'); }
  // Max PWM duty the board accepts (its `I,...` dutymax, 255 on every build so
  // far). Falls back to the canonical 255 rather than 0 so the UI stays usable.
  get dutyMax() { return Number(this._caps?.dutymax) || 255; }

  _setMode(m) {
    if (this._mode === m) { this._notifyMode(); return; }
    this._mode = m;
    this._notifyMode();
  }
  // Separate from _setMode's dedup guard: rpmActive/vibActive can change
  // (e.g. one panel stops while the other keeps the shared session running)
  // without `mode` itself changing, and listeners need to re-evaluate
  // button state for that too.
  _notifyMode() {
    this.dispatchEvent(new CustomEvent('mode', { detail: this._mode }));
  }

  // Clears all per-run stream state -- called whenever we return to idle.
  _resetStreams() {
    this._rpmWanted = false;
    this._vibWanted = false;
    this._frame = null;
    this._bump = null;
    clearTimeout(this._frameWatchdog);
  }

  // Bulk frames (e.g. the bump dump) end with a '#END' line. If that line is
  // lost -- USB backpressure can drop lines under load -- the frame would stay
  // open forever and the UI would hang in "Receiving data...". Guard it: while
  // a frame is streaming, (re)arm a watchdog on every row; if the stream goes
  // quiet for FRAME_IDLE_TIMEOUT_MS, finalize with whatever we received and
  // recover to idle instead of hanging. Rows normally arrive ~0.5 ms apart, so
  // this only fires on a genuine stall. (Not armed until #BEGIN, so the silent
  // on-device capture phase before the dump doesn't trip it.)
  _kickFrameWatchdog() {
    clearTimeout(this._frameWatchdog);
    this._frameWatchdog = setTimeout(() => this._onFrameTimeout(), 3000);
  }

  _onFrameTimeout() {
    if (!this._frame) return;
    this.dispatchEvent(new CustomEvent('log', {
      detail: '# [client] bulk transfer stalled (likely a dropped line) -- finalizing partial capture',
    }));
    this._onFrameEnd();       // emit a result from the rows we did get
    this._resetStreams();
    this._setMode('idle');
  }

  // Skips the real serial link entirely and simulates PCB1's responses, so
  // the dashboard can be exercised (charts, panels, mode transitions) with
  // no board attached. Every public method below branches into a _demo*
  // counterpart when this is active.
  enterDemoMode() {
    this._demo = true;
    this._setMode('idle');
  }

  async connect() {
    await this.link.connect(115200);
    this._setMode('busy');
    // Robust resync to HMI idle from ANY board state (boot selector, human
    // test menu, HMI idle, or a running HMI mode):
    //   '\n'    flushes any partial line the board had buffered
    //   'x\n'   stops a running HMI mode (harmless "unknown" elsewhere)
    //   'hmi\n' selects/re-asserts HMI mode from the selector, the test
    //           menu, or HMI idle -- the firmware answers with the banner.
    await this.link.write('\n');
    await this.link.write('x\n');
    await this.link.write('hmi\n');
    try {
      // Match the banner loosely, THEN check the version, so a mismatch gives a
      // precise error instead of an 8 s mystery timeout.
      const banner = await this._waitForLine(/^# HMI READY/, 8000);
      const m = banner.match(/^# HMI READY v(\d+)/);
      const ver = m ? Number(m[1]) : 0;
      if (ver !== HMI_PROTOCOL_VERSION) {
        // Refusing is the safe move, not pedantry. v1 -> v2 changed `strobe`'s
        // first arg from duty to target RPM with the SAME arity, so a v2 client
        // talking to v1 firmware would send `strobe 1200 -50`, which v1 parses
        // as duty 1200 -> clamped to 255 -> motor at FULL SPEED. Nothing would
        // error; the rig would just take off. Fail at the handshake instead.
        throw new Error(
          `PCB1 is running HMI protocol v${ver || '?'}, but this client speaks ` +
          `v${HMI_PROTOCOL_VERSION}. Re-flash PCB1 (or hard-reload this page if ` +
          `the firmware is newer). Refusing to continue: v1 read the strobe ` +
          `command's first argument as a PWM duty, and this client sends it as ` +
          `a target RPM, which v1 would clamp to full duty.`
        );
      }
      // The firmware prints its `I,...` capability line immediately after the
      // banner. Waiting for it here (rather than letting it land whenever)
      // means supportsOpenLoop is already settled by the time connect()
      // resolves and the UI configures itself. Absent on older firmware, hence
      // the swallowed timeout -- _caps just stays null and the optional
      // controls stay disabled.
      await this._waitForLine(/^I,/, 1500).catch(() => {});
    } finally {
      this._resetStreams();
      this._setMode('idle');
    }
  }

  async disconnect() {
    await this.link.disconnect();
    this._setMode('disconnected');
  }

  async stop() {
    if (this._mode === 'idle' || this._mode === 'disconnected') return;
    this._rpmWanted = false;
    this._vibWanted = false;
    if (this._demo) {
      clearInterval(this._demoTimer);
      clearTimeout(this._demoTimer);
      this._demoTimer = null;
      // Real hardware prints "# sweep aborted"/"# freevib aborted" then "# idle"
      // before returning -- demo has no such lines, so synthesize the matching
      // done-event here when a demo run is stopped early by the user.
      if (this._mode === 'sweep') {
        this.dispatchEvent(new CustomEvent('sweep-done', { detail: { aborted: true } }));
      } else if (this._mode === 'freevib') {
        this.dispatchEvent(new CustomEvent('freevib-done', { detail: { aborted: true } }));
      }
      this._setMode('idle');
      return;
    }
    const wasSweep = this._mode === 'sweep';
    this._setMode('busy');
    await this.link.write('x\n');
    // A sweep only checks for abort BETWEEN grid points (see main.cpp) --
    // worst case is the post-gap point's 15 s settle + 5 s capture, so 'x'
    // can take ~20 s to be noticed there; every other mode stops within a
    // loop iteration. If it times out anyway, force idle regardless.
    const stopTimeoutMs = wasSweep ? 25000 : 5000;
    try { await this._waitForLine(/^# idle/, stopTimeoutMs); } catch { /* force idle below */ }
    this._resetStreams();
    this._setMode('idle');
  }

  async _ensureIdle() {
    if (this._mode !== 'idle') await this.stop();
  }

  // ---- `live` mode: target-RPM control + decimated vibration, concurrently ----
  // startTargetRpmControl() and startVibrationLive() both drive this SAME
  // underlying PCB1 mode, so the RPM and Accel panels can stream at the same
  // time: whichever starts it first launches the shared session, the other
  // just joins it. Each panel's Stop only tears down the session once NEITHER
  // panel wants it -- see stopRpm()/stopVibrationLive().
  async startTargetRpmControl(initialTargetRpm) {
    if (this._mode === 'live') {
      this._rpmWanted = true;
      this._notifyMode();
      return this.setTargetRpm(initialTargetRpm);
    }
    await this._ensureIdle();
    this._rpmWanted = true;
    this._vibWanted = false;
    if (this._demo) return this._demoStartLive(initialTargetRpm);
    await this.link.write(`live ${initialTargetRpm}\n`);
    this._setMode('live');
  }

  async setTargetRpm(targetRpm) {
    if (this._mode !== 'live') throw new Error('Not running target RPM control.');
    // Also the switch back to closed loop if the session is currently open-loop
    // (the firmware treats a retarget that way -- see runHmiLive).
    if (this._demo) { this._demoTargetRpm = targetRpm; this._demoOpenLoop = false; return; }
    await this.link.write(`t ${targetRpm}\n`);
  }

  // ---- Open loop: drive the PWM duty (0-255) directly, no controller ----
  // Same `live` session as startTargetRpmControl() -- open vs closed loop is a
  // setting WITHIN the session, not a separate mode, so the Accel panel keeps
  // streaming across a switch and the shaft doesn't stop. Starting here just
  // opens the session with the motor idle, then sends the duty.
  async startOpenLoopDuty(initialDuty) {
    if (this._mode === 'live') {
      this._rpmWanted = true;
      this._notifyMode();
      return this.setOpenLoopDuty(initialDuty);
    }
    await this._ensureIdle();
    this._rpmWanted = true;
    this._vibWanted = false;
    if (this._demo) return this._demoStartLive(0, initialDuty);
    await this.link.write('live 0\n');
    this._setMode('live');
    await this.link.write(`d ${initialDuty}\n`);
  }

  // Live duty adjustment (the slider drags through this). Throttling is the
  // caller's job -- see app.js's sendDutyThrottled.
  async setOpenLoopDuty(duty) {
    if (this._mode !== 'live') throw new Error('Not running the motor.');
    if (!this.supportsOpenLoop) throw new Error('This PCB1 firmware has no open-loop support -- re-flash it.');
    if (this._demo) { this._demoOpenLoop = true; this._demoOpenDuty = duty; return; }
    await this.link.write(`d ${duty}\n`);
  }

  // Stops the RPM panel's own data. If the Accel panel still wants the shared
  // session, this can't literally "half-stop" PCB1's one mode -- instead it
  // idles the motor (target 0) and leaves the session running for vibration.
  // Only tears the session down (sends 'x') once neither panel wants it.
  async stopRpm() {
    if (this._mode !== 'live') return;
    this._rpmWanted = false;
    if (this._vibWanted) {
      if (this._demo) { this._demoTargetRpm = 0; this._demoOpenLoop = false; this._notifyMode(); return; }
      await this.setTargetRpm(0);
      this._notifyMode();
      return;
    }
    await this.stop();
  }

  // ---- `log [s]`: teaching capture, issued mid-`live` ----
  // Not a mode of its own: it runs inside the live session so the shaft stays
  // at the speed the student already set (no stop/spin-up/re-settle). The
  // firmware blocks for the capture + dump, then live streaming resumes on its
  // own -- so this doesn't touch _setMode and there's no '# idle' to wait for.
  async logSummary(durationS = 5) {
    if (this._mode !== 'live') throw new Error('Log Summary needs the live stream running (start the RPM or Accel panel first).');
    if (this._demo) return this._demoLogSummary(durationS);
    await this.link.write(`log ${durationS}\n`);
  }

  // ---- `strobe` mode: closed-loop target RPM + strobe (rate = live RPM + delta) ----
  async startStrobe(targetRpm, deltaRpm) {
    await this._ensureIdle();
    if (this._demo) return this._demoStartStrobe(targetRpm, deltaRpm);
    await this.link.write(`strobe ${targetRpm} ${deltaRpm}\n`);
    this._setMode('strobe');
  }

  // ---- `sweep` mode: RPM-controlled resonance sweep (closed-loop, bounded) ----
  // One summary row per completed grid point (`sweep-point`), plus decimated
  // R/V rows during each point's SETTLE phase (forwarded to the RPM/Accel
  // panels as a read-only "Auto Mode" live view -- see _onLine()), until the
  // grid finishes or 'x'+Enter aborts. Already-collected points are kept
  // either way.
  // `damped` picks the firmware sweep variant: false -> mode `r` (undamped,
  // reverse-cycle with the no-dwell resonance gap), true -> mode `r2` (damped,
  // plain low-to-high pass). Both stream the same P/R/V rows, so nothing else
  // in this client differs between them.
  async runRpmSweep(damped = false) {
    await this._ensureIdle();
    if (this._demo) return this._demoRunRpmSweep();
    this._setMode('sweep');
    await this.link.write(`sweep ${damped ? 1 : 0}\n`);
  }

  // ---- `bump` mode: bump test (triggered acquisition) ----
  // Arms and waits for a physical tap/bump exceeding thresholdG -- 'x'+Enter
  // aborts *while armed only*; once triggered the capture can't be aborted.
  // Emits 'bump-triggered' on trigger, one 'bump-sample' per raw row as the
  // (framed) capture streams in, then 'bump-result' with the full array.
  async runBumpTest(thresholdG, durationS) {
    await this._ensureIdle();
    if (this._demo) return this._demoRunBumpTest(thresholdG, durationS);
    this._bump = { raw: [], thresholdG };
    this._setMode('bump-armed');
    await this.link.write(`bump ${thresholdG} ${durationS}\n`);
  }

  // ---- `freevib` mode: untriggered free-vibration capture ----
  // Motor off; records raw accel for durationS seconds and streams it live as
  // tagged `F` rows (no threshold, no encoder/phase -- see runHmiFreeVib() in
  // main.cpp). Emits 'freevib-start' (with the nominal SPS/bias), one
  // 'freevib-sample' per streamed row as the beam rings down, then
  // 'freevib-done' when the firmware reports complete/aborted. 'x'+Enter (stop)
  // aborts early and keeps whatever streamed.
  async runFreeVib(durationS) {
    await this._ensureIdle();
    if (this._demo) return this._demoRunFreeVib(durationS);
    this._setMode('freevib');
    await this.link.write(`freevib ${durationS}\n`);
  }

  // ---- `live` mode (see startTargetRpmControl above): the vibration side. ----
  // Defaults the motor's target to 0 (off) when it launches the session.
  async startVibrationLive() {
    if (this._mode === 'live') {
      this._vibWanted = true;
      this._notifyMode();
      return;
    }
    await this._ensureIdle();
    this._rpmWanted = false;
    this._vibWanted = true;
    if (this._demo) return this._demoStartLive(0);
    await this.link.write('live 0\n');
    this._setMode('live');
  }

  // Stops the Accel panel's own data. If the RPM panel still wants the
  // session, there's nothing to send -- the firmware keeps streaming
  // vibration alongside RPM control; _onLine() just stops dispatching
  // vibration-live-sample once _vibWanted is false.
  async stopVibrationLive() {
    if (this._mode !== 'live') return;
    this._vibWanted = false;
    if (this._rpmWanted) { this._notifyMode(); return; }
    await this.stop();
  }

  // ---- `accelcheck`: quick ADS1220 check (no motor) ----
  async runAccelCheck() {
    await this._ensureIdle();
    if (this._demo) return this._demoRunAccelCheck();
    this._setMode('busy');
    await this.link.write('accelcheck\n');
    // 'A,...' row -> 'accel-check' event; '# idle' returns us to idle.
  }

  // ---- `relay <0|1>` ----
  async setRelay(on) {
    await this._ensureIdle();
    if (this._demo) return this._demoSetRelay();
    this._setMode('busy');
    await this.link.write(`relay ${on ? 1 : 0}\n`);
    try { await this._waitForLine(/^# relay /, 3000); } catch { /* fall through */ }
    this._setMode('idle');
  }

  // ============================================================
  // Line demux: route each incoming line by its leading tag / frame state.
  // ============================================================
  _onLine(line) {
    this.dispatchEvent(new CustomEvent('log', { detail: line }));

    // --- Self-heal from a mid-session fallback to the firmware's interface
    // selector. A USB/CDC blip can bounce PCB1 back to its "Select interface"
    // prompt (or human test menu) even though the port stayed open, after
    // which our HMI commands are silently rejected and the UI looks frozen.
    // If we see that banner while we still believe we're connected, just
    // re-assert HMI mode so the session recovers on its own. (Current firmware
    // also self-heals on the next command; this covers older firmware and
    // recovers a touch faster.)
    if (this._mode !== 'disconnected' &&
        (/^Select interface:/.test(line) || /Integrated Test \/ Control/.test(line))) {
      this.link.write('hmi\n').catch(() => {});
      return;
    }

    // --- Inside a bulk frame (e.g. bump dump): rows are bare CSV until #END ---
    if (this._frame) {
      if (line.startsWith('#END')) { clearTimeout(this._frameWatchdog); this._onFrameEnd(); return; }
      this._kickFrameWatchdog();
      this._onFrameRow(line);
      return;
    }
    if (line.startsWith('#BEGIN')) { this._onFrameBegin(line); this._kickFrameWatchdog(); return; }

    // --- Status comments / errors ---
    if (line.startsWith('#')) { this._onStatus(line); return; }
    if (line.startsWith('!')) { return; } // error already surfaced via 'log'

    // --- Tagged data rows ---
    const comma = line.indexOf(',');
    if (comma < 0) return;
    const tag = line.slice(0, comma);
    const p = line.slice(comma + 1).split(',');

    switch (tag) {
      case 'R': {
        const s = { time_ms: +p[0], target_rpm: +p[1], rpm: +p[2], duty: +p[3], raw_rpm: +p[4] };
        // Forwarded to the RPM panel when the panel wants it (live), OR always
        // during a sweep (read-only Auto Mode live view).
        if (this._mode === 'sweep' || (this._mode === 'live' && this._rpmWanted)) {
          this.dispatchEvent(new CustomEvent('rpm-sample', { detail: s }));
        }
        break;
      }
      case 'V': {
        const s = { time_ms: +p[0], accel_g: +p[1] };
        if (this._mode === 'sweep' || (this._mode === 'live' && this._vibWanted)) {
          this.dispatchEvent(new CustomEvent('vibration-live-sample', { detail: s }));
        }
        break;
      }
      case 'K': {
        this.dispatchEvent(new CustomEvent('strobe-sample', { detail: { time_ms: +p[0], raw_rpm: +p[1] } }));
        break;
      }
      case 'P': {
        this.dispatchEvent(new CustomEvent('sweep-point', {
          detail: {
            rpm_avg: +p[0], target_rpm: +p[1],
            accel_amplitude_mV: +p[2], accel_amplitude_g: +p[3], actual_sps: +p[4],
            accel_amp_1x_g: +p[5],   // 1x-RPM lock-in amplitude (noise-rejecting; the plotted value)
            rpm_std: +p[6],          // RPM wander over the capture; high => rotor hunting, distrust amplitude
            // 1x phase vs the encoder pulse, deg [0,360). RAW -- still carries the
            // fixed mounting/accel-vs-displacement offset, which app.js removes by
            // normalising the far-below-resonance points to 0. Firmware prints
            // 'nan' when there was no tone or too few pulses; +'nan' -> NaN, which
            // the plot skips. Older firmware omits the field -> p[7] undefined -> NaN.
            phase_deg: p.length > 7 ? +p[7] : NaN,
          },
        }));
        break;
      }
      case 'A': {
        const c = { rateSps: +p[0], meanV: +p[1], meanG: +p[2], stdV: +p[3], pkpkV: +p[4] };
        c.ok = Math.abs(c.meanV - ADXL_EXPECTED_BIAS_V) <= ADXL_BIAS_TOL_V;
        this.dispatchEvent(new CustomEvent('accel-check', { detail: c }));
        break;
      }
      case 'F': {
        // Free-vibration stream row: F,<t_s>,<accel_g>. Streamed live during a
        // `freevib` capture (not framed -- see runHmiFreeVib()).
        if (this._mode === 'freevib') {
          this.dispatchEvent(new CustomEvent('freevib-sample', { detail: { time_s: +p[0], accel_g: +p[1] } }));
        }
        break;
      }
      case 'I': {
        // `I,fw=pcb1,vibsps=...,openloop=1` -- capability/info line, emitted
        // right after the ready banner (and on every `id`). Parsed into a plain
        // k->v map; unknown keys are kept, so a firmware that adds a capability
        // needs no change here (see supportsOpenLoop).
        this._caps = Object.fromEntries(
          p.map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; })
        );
        this.dispatchEvent(new CustomEvent('capabilities', { detail: { ...this._caps } }));
        break;
      }
      default:
        break; // unknown tag -- already logged
    }
  }

  _onStatus(line) {
    if (/^# HMI READY/.test(line)) return; // handshake -- consumed by connect()'s _waitForLine
    if (/^# idle\b/.test(line)) { this._resetStreams(); this._setMode('idle'); return; }

    const sweepDone = line.match(/^# sweep (complete|aborted)/);
    if (sweepDone) {
      this.dispatchEvent(new CustomEvent('sweep-done', { detail: { aborted: sweepDone[1] === 'aborted' } }));
      return; // firmware sends '# idle' next, which resets us
    }

    if (/^# bump armed/.test(line)) { this._setMode('bump-armed'); return; }

    const freevibStart = line.match(/^# freevib start\b(?:.*\bsps=([\d.]+))?(?:.*\bbias=([-\d.]+))?/);
    if (freevibStart) {
      this._setMode('freevib');
      this.dispatchEvent(new CustomEvent('freevib-start', {
        detail: { sps: freevibStart[1] ? +freevibStart[1] : NaN, biasV: freevibStart[2] ? +freevibStart[2] : NaN },
      }));
      return;
    }
    const freevibDone = line.match(/^# freevib (complete|aborted)/);
    if (freevibDone) {
      this.dispatchEvent(new CustomEvent('freevib-done', { detail: { aborted: freevibDone[1] === 'aborted' } }));
      return; // firmware sends '# idle' next, which resets us to idle
    }

    const trig = line.match(/^# bump triggered g=([\d.]+)/);
    if (trig) {
      this._setMode('bump-triggered');
      this.dispatchEvent(new CustomEvent('bump-triggered', { detail: { accelG: parseFloat(trig[1]) } }));
      return;
    }

    // The firmware emits '# relay on/off' for every relay change it makes --
    // including ones we didn't ask for: strobe mode kills the lighting LED on
    // entry and restores it on exit, printing '# relay on' specifically so we
    // can stay in sync (see runHmiStrobe() in main.cpp). Treat the board as the
    // authority on relay state rather than tracking it optimistically here.
    const relay = line.match(/^# relay (on|off)\b/);
    if (relay) {
      this.dispatchEvent(new CustomEvent('relay-state', { detail: { on: relay[1] === 'on' } }));
      return;
    }
    // '# sweep start ...', misc -- surfaced via 'log' only.
  }

  _onFrameBegin(line) {
    // e.g. "#BEGIN bump n=11650 sps=2330.4 bias=1.9531"
    const nameMatch = line.match(/^#BEGIN\s+(\S+)/);
    const name = nameMatch ? nameMatch[1] : '';
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=([^\s]+)/g)) attrs[m[1]] = m[2];
    this._frame = { name, attrs };

    if (name === 'bump') {
      this._bump = this._bump || { raw: [] };
      this._bump.raw = [];
      if (attrs.bias !== undefined) this._bump.biasV = +attrs.bias;
      if (attrs.sps !== undefined) this._bump.actualSps = +attrs.sps;
      // Rows are now actually arriving (the physical capture already finished
      // silently on-device, same as before) -- mark the transfer phase so the
      // UI can distinguish it from the armed/triggered waits.
      this._setMode('bump-capturing');
    }

    // Log Summary arrives as TWO frames back to back: `logsum` (the accel
    // waveform slice) then `logpulse` (the encoder pulse times in the same
    // window, on the same clock). Stats for the whole 5 s capture ride in
    // logsum's attrs -- only the middle 1 s of samples is actually shipped.
    if (name === 'logsum') {
      this._logsum = {
        samples: [],
        pulses: [],
        rpmAvg: +attrs.rpm,
        ampG: +attrs.amp_g,
        amp1xG: +attrs.amp1x_g,
        phaseDeg: +attrs.phase_deg,   // RAW (encoder-referenced) -- see below
        actualSps: +attrs.sps,
        biasV: +attrs.bias,
        durationS: +attrs.dur,
        nPulsesTotal: +attrs.npulse,
        windowStartS: +attrs.twin,
      };
    }
  }

  _onFrameRow(line) {
    if (this._frame.name === 'bump' && this._bump) {
      const p = line.split(',');
      if (p.length === 5) {
        const sample = { index: +p[0], time_s: +p[1], raw_code: +p[2], voltage_V: +p[3], accel_g: +p[4] };
        this._bump.raw.push(sample);
        // Per-row event so the UI can fill the time-domain plot live as the
        // dump streams in (live relative to the serial transfer, not the
        // physical capture, which already finished).
        this.dispatchEvent(new CustomEvent('bump-sample', { detail: sample }));
      }
      return;
    }
    if (this._frame.name === 'logsum' && this._logsum) {
      const p = line.split(',');
      if (p.length === 3) this._logsum.samples.push({ time_s: +p[1], accel_g: +p[2] });
      return;
    }
    if (this._frame.name === 'logpulse' && this._logsum) {
      const p = line.split(',');
      if (p.length === 2) this._logsum.pulses.push(+p[1]);
    }
  }

  _onFrameEnd() {
    const frame = this._frame;
    this._frame = null;
    if (frame.name === 'bump' && this._bump) {
      const raw = this._bump.raw;
      // Peak |accel| over the captured window -- the firmware doesn't pre-scan
      // for this anymore (the framed dump carries n/sps/bias only), so it's
      // computed here from the same samples the old "Peak accel (g)" line did.
      let peakG = 0;
      for (const r of raw) { const a = Math.abs(r.accel_g); if (a > peakG) peakG = a; }
      this._bump.peakG = peakG;
      this.dispatchEvent(new CustomEvent('bump-result', { detail: { ...this._bump } }));
      // firmware sends '# idle' next, which resets us to idle.
    }
    // `logpulse` is the SECOND of the Log Summary's two frames, so it's the one
    // that means "everything has arrived". Firing on `logsum` instead would
    // hand the UI a result with no pulse markers -- the entire point of the
    // screen. Note live streaming resumes after this (log runs inside `live`),
    // so there's no '# idle' here.
    if (frame.name === 'logpulse' && this._logsum) {
      this.dispatchEvent(new CustomEvent('logsum-result', { detail: { ...this._logsum } }));
      this._logsum = null;
    }
  }

  _waitForLine(regex, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const onLine = (e) => { if (regex.test(e.detail)) { cleanup(); resolve(e.detail); } };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for PCB1 line matching ${regex}`));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.link.removeEventListener('line', onLine); };
      this.link.addEventListener('line', onLine);
    });
  }

  // ============================================================
  // Demo-mode simulations (no serial link involved). These dispatch the same
  // events the real tag demux does, so app.js can't tell the difference.
  // ============================================================
  _demoRpmForDuty(duty) {
    return duty <= 35 ? 0 : (duty - 35) * 13.5;
  }
  _demoDutyForRpm(rpm) {
    return rpm <= 0 ? 0 : Math.min(255, 35 + rpm / 13.5);
  }

  // openLoopDuty !== null starts the session in open loop (see
  // startOpenLoopDuty); otherwise it's closed-loop on initialTargetRpm.
  _demoStartLive(initialTargetRpm, openLoopDuty = null) {
    this._demoTargetRpm = initialTargetRpm;
    this._demoOpenLoop = openLoopDuty !== null;
    this._demoOpenDuty = openLoopDuty ?? 0;
    this._setMode('live');
    let t = 0;
    let simRpm = 0;
    const freqHz = 22.6;
    const amplitudeG = 0.35;
    this._demoTimer = setInterval(() => {
      t += 10; // ~100 SPS tick, matching the firmware's decimated vibration rate
      if (this._vibWanted) {
        const g = amplitudeG * Math.sin(2 * Math.PI * freqHz * (t / 1000)) + (Math.random() - 0.5) * 0.03;
        this.dispatchEvent(new CustomEvent('vibration-live-sample', { detail: { time_ms: t, accel_g: g } }));
      }
      if (this._rpmWanted && t % 20 === 0) {
        // Open loop: the duty is what's commanded and the speed is whatever the
        // motor curve gives for it (no setpoint, hence the NaN target -- same
        // convention the firmware's R row uses). Closed loop: the speed chases
        // the target and the duty is whatever it takes.
        const open = this._demoOpenLoop;
        const settling = open ? this._demoRpmForDuty(this._demoOpenDuty) : this._demoTargetRpm;
        simRpm += (settling - simRpm) * 0.25;
        const raw = Math.max(0, simRpm + (Math.random() - 0.5) * 40);
        const filtered = Math.max(0, simRpm + (Math.random() - 0.5) * 8);
        this.dispatchEvent(new CustomEvent('rpm-sample', {
          detail: {
            time_ms: t, target_rpm: open ? NaN : this._demoTargetRpm, rpm: filtered,
            duty: open ? this._demoOpenDuty : this._demoDutyForRpm(filtered), raw_rpm: raw,
          },
        }));
      }
    }, 10);
  }

  // Demo Log Summary: synthesises the same shape the firmware sends -- a 1 s
  // accel slice at ~2330 SPS plus the encoder pulse times inside it, with a
  // deliberate phase lag baked in so the manual reading exercise actually has
  // an answer to find. Mirrors the firmware in emitting RAW phase (the lag
  // plus a constant pretend mounting offset).
  _demoLogSummary(durationS) {
    const rpm = (this._demoOpenLoop ? this._demoRpmForDuty(this._demoOpenDuty) : this._demoTargetRpm) || 1200;
    const f = rpm / 60;
    const sps = 2330;
    const showS = 1.0;
    const n = Math.round(sps * showS);
    const t0 = (durationS - showS) / 2;      // middle slice, as the firmware does

    // Textbook rotating-unbalance lag at this speed, + the physical
    // accel-vs-displacement offset (see DEMO_PHASE_OFFSET_DEG). At low RPM this
    // puts the encoder pulse right on the accel TROUGH, exactly as the real rig
    // does -- max displacement is where the pulse fires, and accel = -w^2*x.
    const fn = 1326 / 60, zeta = 1 / 36, r = f / fn;
    const trueLag = Math.atan2(2 * zeta * r, 1 - r * r);
    const rawPhase = ((trueLag * 180 / Math.PI + DEMO_PHASE_OFFSET_DEG) % 360 + 360) % 360;
    const amp = Math.max(0.02, 0.06 + 0.9 / Math.sqrt(1 + Math.pow(18 * (rpm - 1326) / 1326, 2)));

    // Pulses at t_k; the accel peak sits rawPhase degrees (of one rev) later.
    const lagS = (rawPhase / 360) * (1 / f);
    // Broadband sensor noise. Sized (~0.05 g RMS) to match what makes the real
    // rig's raw trace hard to read by hand -- it's a light fuzz next to the ~0.9 g
    // response at resonance but buries the ~0.06 g tone at low RPM, which is the
    // same asymmetry that makes the firmware's 1x lock-in necessary in the first
    // place. The old +/-0.01 here was clean enough to be misleading: it implied a
    // trough you can always just read off, and left the Log Summary's low-pass /
    // sync-average views with nothing visible to do.
    const NOISE_PP_G = 0.18;
    // Rotation-locked higher harmonics, as a real rotor has. These matter for
    // more than realism: they are exactly what SYNCHRONOUS AVERAGING cannot
    // remove (an 8x component is as synchronous as the 1x, so it averages
    // coherently and survives), which is why the Log Summary band-limits before
    // averaging. A pure-sine demo would hide that entirely and make the
    // harmonics control look inert.
    const harmonic = (k, relAmp, phase) => (t) => amp * relAmp * Math.cos(2 * Math.PI * k * f * (t - lagS) + phase);
    const harmonics = [harmonic(8, 0.12, 0.7), harmonic(11, 0.09, 2.1)];
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + i / sps;
      const g = amp * Math.cos(2 * Math.PI * f * (t - lagS))
              + harmonics.reduce((s, h) => s + h(t), 0)
              + (Math.random() - 0.5) * NOISE_PP_G;
      samples.push({ time_s: t, accel_g: g });
    }
    const pulses = [];
    for (let k = Math.ceil(t0 * f); k / f <= t0 + showS; k++) {
      const tp = k / f;
      if (tp >= t0) pulses.push(tp);
    }

    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('logsum-result', {
        detail: {
          samples, pulses,
          rpmAvg: rpm + (Math.random() - 0.5) * 2,
          ampG: amp * 1.02, amp1xG: amp,
          phaseDeg: rawPhase,
          actualSps: sps, biasV: 1.95,
          durationS, nPulsesTotal: Math.round(f * durationS),
          windowStartS: t0,
        },
      }));
    }, 600);   // pretend the capture + dump took a moment
  }

  _demoStartStrobe(targetRpm, deltaRpm) {
    this._setMode('strobe');
    let t = 0;
    // Closed-loop now (protocol v2): the commanded RPM *is* the steady-state
    // speed, so unlike the old duty-based demo there's no deadband/slope curve
    // to map through -- just the target plus measurement noise.
    this._demoTimer = setInterval(() => {
      t += 10;
      const raw = Math.max(0, targetRpm + (Math.random() - 0.5) * 30);
      this.dispatchEvent(new CustomEvent('strobe-sample', { detail: { time_ms: t, raw_rpm: raw } }));
    }, 10);
  }

  // Fast-forwarded demo sweep (a real one takes minutes) over the same
  // 500-3000 RPM range the firmware sweep covers, shaped as a resonance peak near the
  // apparatus's documented ~1326 RPM (22.1 Hz) natural frequency. Also emits
  // live R/V rows each step so the Auto Mode panels animate, mirroring the
  // real sweep's settle-phase live stream.
  _demoRunRpmSweep() {
    this._setMode('sweep');
    const grid = [];
    for (let rpm = 500; rpm <= 3000; rpm += (rpm >= 1200 && rpm <= 1500) ? 15 : 100) grid.push(Math.round(rpm));
    const fn = 1326, q = 18;
    let i = 0;
    let t = 0;
    this._demoTimer = setInterval(() => {
      if (i >= grid.length) {
        clearInterval(this._demoTimer);
        this._demoTimer = null;
        this.dispatchEvent(new CustomEvent('sweep-done', { detail: { aborted: false } }));
        this._setMode('idle');
        return;
      }
      const targetRpm = grid[i++];
      const ratio = q * (targetRpm - fn) / fn;
      // amp1x = the clean Lorentzian (what a lock-in recovers); ampG = the same
      // plus broadband noise (what RMS reports) -- mirrors the real firmware,
      // where the two diverge most at low RPM.
      const amp1x = Math.max(0.02, 0.06 + 0.9 / Math.sqrt(1 + ratio * ratio));
      const ampG = Math.max(0.02, amp1x + (Math.random() - 0.5) * 0.015);
      const rpmAvg = targetRpm + (Math.random() - 0.5) * 2;

      // Textbook rotating-unbalance phase: atan2(2*zeta*r, 1-r^2), r = f/fn.
      // 0 well below resonance -> 90 at r=1 -> 180 above. zeta from the same q
      // the amplitude curve uses, so the two demo traces stay consistent.
      const r = targetRpm / fn;
      const zeta = 1 / (2 * q);
      const truePhase = Math.atan2(2 * zeta * r, 1 - r * r) * 180 / Math.PI;
      // Emit RAW phase like the firmware does: the true lag plus the physical
      // accel-vs-displacement offset, so demo mode still exercises app.js's
      // low-RPM normalisation instead of getting a pre-zeroed curve for free.
      // Scatter grows as the tone gets weak at low RPM, mirroring the real
      // lock-in's phase noise at poor SNR.
      const phaseNoise = (Math.random() - 0.5) * (2 + 10 * Math.min(1, 0.12 / amp1x));
      const phaseDeg = ((truePhase + DEMO_PHASE_OFFSET_DEG + phaseNoise) % 360 + 360) % 360;

      // Settle-phase live view: a few RPM/accel rows before the point lands.
      for (let k = 0; k < 4; k++) {
        t += 25;
        const measured = rpmAvg + (Math.random() - 0.5) * 12;
        this.dispatchEvent(new CustomEvent('rpm-sample', {
          detail: {
            time_ms: t, target_rpm: targetRpm, rpm: measured,
            duty: this._demoDutyForRpm(measured), raw_rpm: measured + (Math.random() - 0.5) * 30,
          },
        }));
        const g = ampG * Math.sin(2 * Math.PI * 22.6 * (t / 1000)) + (Math.random() - 0.5) * 0.02;
        this.dispatchEvent(new CustomEvent('vibration-live-sample', { detail: { time_ms: t, accel_g: g } }));
      }

      this.dispatchEvent(new CustomEvent('sweep-point', {
        detail: {
          rpm_avg: rpmAvg, target_rpm: targetRpm,
          accel_amplitude_mV: ampG * 354.2, accel_amplitude_g: ampG, actual_sps: 2330,
          accel_amp_1x_g: amp1x,
          rpm_std: 2 + 20 / (1 + ratio * ratio),   // demo: small when off-resonance, spikes near the peak
          phase_deg: phaseDeg,
        },
      }));
    }, 120);
  }

  // Fast-forwarded demo bump test: arm (short simulated wait for a "tap"),
  // trigger, then a decaying-sinusoid capture near the same ~22.1 Hz mode.
  _demoRunBumpTest(thresholdG, durationS) {
    this._bump = { raw: [], thresholdG };
    this._setMode('bump-armed');
    this._demoTimer = setTimeout(() => {
      const peakG = thresholdG + 0.4 + Math.random() * 0.3;
      this._setMode('bump-triggered');
      this.dispatchEvent(new CustomEvent('bump-triggered', { detail: { accelG: peakG } }));

      this._demoTimer = setTimeout(() => {
        this._setMode('bump-capturing');
        const sps = 2330;
        const n = Math.max(2, Math.round(sps * durationS));
        const fn = 22.1, zeta = 0.02;
        const wn = 2 * Math.PI * fn;
        const wd = wn * Math.sqrt(Math.max(0, 1 - zeta * zeta));
        let idx = 0;
        const chunk = 400;
        this._demoTimer = setInterval(() => {
          const end = Math.min(n, idx + chunk);
          for (; idx < end; idx++) {
            const tt = idx / sps;
            const g = peakG * Math.exp(-zeta * wn * tt) * Math.cos(wd * tt) + (Math.random() - 0.5) * 0.008;
            const sample = { index: idx, time_s: tt, raw_code: 0, voltage_V: 0, accel_g: g };
            this._bump.raw.push(sample);
            this.dispatchEvent(new CustomEvent('bump-sample', { detail: sample }));
          }
          if (idx >= n) {
            clearInterval(this._demoTimer);
            this._demoTimer = null;
            this.dispatchEvent(new CustomEvent('bump-result', {
              detail: { raw: this._bump.raw, biasV: 1.953, actualSps: sps, thresholdG, peakG },
            }));
            this._setMode('idle');
          }
        }, 30);
      }, 500);
    }, 1200);
  }

  // Fast-forwarded demo free-vibration: a decaying ~2.5 Hz sinusoid streamed as
  // `freevib-sample` events, so the live decay view + the log-decrement analysis
  // can be exercised without hardware. Streams faster than real time.
  _demoRunFreeVib(durationS) {
    this._setMode('freevib');
    const sps = 200;
    const n = Math.max(2, Math.round(sps * durationS));
    const fd = 2.5, zeta = 0.03;                       // demo: ~2.5 Hz, light damping
    const wd = 2 * Math.PI * fd;
    const wn = wd / Math.sqrt(1 - zeta * zeta);
    const a0 = 0.6;
    this.dispatchEvent(new CustomEvent('freevib-start', { detail: { sps, biasV: 1.953 } }));
    let idx = 0;
    const chunk = 60;
    this._demoTimer = setInterval(() => {
      const end = Math.min(n, idx + chunk);
      for (; idx < end; idx++) {
        const tt = idx / sps;
        const g = a0 * Math.exp(-zeta * wn * tt) * Math.cos(wd * tt) + (Math.random() - 0.5) * 0.004;
        this.dispatchEvent(new CustomEvent('freevib-sample', { detail: { time_s: tt, accel_g: g } }));
      }
      if (idx >= n) {
        clearInterval(this._demoTimer);
        this._demoTimer = null;
        this.dispatchEvent(new CustomEvent('freevib-done', { detail: { aborted: false } }));
        this._setMode('idle');
      }
    }, 40);
  }

  _demoRunAccelCheck() {
    this._setMode('busy');
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('accel-check', {
        detail: { rateSps: 2328, meanV: 1.952, meanG: 0.85, stdV: 0.004, pkpkV: 0.031, ok: true },
      }));
      this._setMode('idle');
    }, 500);
  }

  _demoSetRelay() {
    this._setMode('busy');
    return new Promise((resolve) => {
      setTimeout(() => { this._setMode('idle'); resolve(); }, 150);
    });
  }
}
