# Laptop HMI — Dynamics Lab Vibration Apparatus

A browser-based HMI for the vibration demo apparatus, talking to PCB1 over
Web Serial. Static site, no build step, no dependencies — plain HTML/CSS/JS
modules, so it can be hosted as-is on GitHub Pages later.

## Screen flow

1. **Splash** — Dynamics Lab logo (auto-advances after ~2 s).
2. **Apparatus Status** — connect to PCB1 over serial, run a quick
   accelerometer sanity check, then continue to the dashboard. Or click
   **Skip — Demo Mode** to go straight to the dashboard with simulated data
   and no board attached (useful for UI/layout iteration).
3. **Dashboard** — a persistent grid, not click-to-switch tabs: Apparatus
   (reference images + condensed status), Motor control (closed-loop RPM or
   open-loop PWM duty, switchable while running), and Vibration/
   Accel data fill row 1 side by side, Stroboscope control, an Auxiliary
   panel (relay + serial log), and an Advanced Tests panel fill row 2.
   Motor and Accel are deliberately kept visible at the same time, not
   hidden behind separate tabs — the point of the dashboard is to let a
   student watch the RPM↔vibration relationship (e.g. the amplitude spike
   near resonance) directly across two live charts, not rely on memory
   across a tab switch. Advanced Tests opens the bounded-measurement
   features (RPM Sweep/Bode Plot, Bump Test, and — from the Accel panel — Free
   Vibration; see below) as modal overlays
   on top of the dashboard, rather than as more always-visible grid panels,
   since they're occasional, longer-running operations with their own
   large plots rather than something to glance at continuously.

Both the Status and Dashboard topbars carry a **☀ Light / 🌙 Dark** toggle and
a **▦ Figures** button (see [Figures tab](#figures-tab-figureshtml)); the
Dashboard's also has the **Auto-open** checkbox for it. Dark is the default
look; the choice persists in `localStorage` (`hmi-theme`). The DOM restyles
through CSS variables (`body.light` in `css/style.css`). The charts don't
follow the theme: every one is a white MATLAB figure in both (see
[Charts](#charts-jsmatlab-axesjs)), so `setChartTheme()` in `js/chart.js` only
repaints them. The Serial Log panels deliberately stay dark in both themes.

## Demo mode

`PCB1Client.enterDemoMode()` (in `js/pcb1-client.js`) makes the client fake
plausible responses to every command — an RPM ramp derived from PCB1's
deadband/slope, a synthetic sine-wave vibration capture, etc. — instead of
touching the serial link. It's the same object, same events (`mode`,
`rpm-sample`, `vibration-result`, ...), so `app.js` and the dashboard don't
know or care whether they're talking to real hardware or the simulation.
The dashboard header shows an amber "Demo Mode (simulated)" indicator
whenever it's active, and the demo entry point is disabled once a real
connection succeeds.

`_demoStartLive()` (the mode `l` simulation) intentionally ticks its RPM
and vibration channels at the **same rates the real firmware streams
them** — 50 Hz (`t % 20 === 0`, matching `CLOSEDLOOP_DT_US`) and ~100 Hz
respectively — specifically so demo mode's perceived responsiveness
matches real hardware. This was wrong for one session (RPM stuck at a
leftover 200 ms/5 Hz from when the demo was first written against mode
1's slower print rate), which made the RPM panel visibly choppier than
Accel even though real hardware wouldn't have shown that gap — if a
demo's cadence is ever copied from another mode again, double check the
source mode's actual print/tick rate in `main.cpp` rather than assuming
the old constant still applies.

**A too-clean demo is a misleading demo.** `_demoLogSummary()` originally
produced a pure sine with ±0.01 g of noise against a signal up to 0.9 g. That
implied a trough you can always just read straight off — which the real rig does
not give you — and it left the Log Summary's low-pass and sync-average views
with nothing visible to do. It now carries ~0.05 g RMS broadband noise (a light
fuzz at resonance, but enough to bury the ~0.06 g tone at low RPM, the same
asymmetry that makes the firmware's 1× lock-in necessary) plus rotation-locked
8×/11× harmonics — which are specifically what synchronous averaging *cannot*
remove, and therefore the reason the sync view band-limits first. When adding a
signal-conditioning feature, check the demo actually exercises it; a simulation
tuned for a clean-looking screenshot will quietly hide the problem the feature
exists to solve.

## Running locally

Web Serial requires a "secure context" — it will **not** work opening
`index.html` directly as a `file://` URL. Serve it over `http://localhost`
(or `https://`) instead, e.g.:

```
python -m http.server 8123
```

then open `http://localhost:8123` in **Chrome or Edge** (Web Serial isn't
implemented in Firefox or Safari).

## Hosting on GitHub Pages

Nothing project-specific is needed — GitHub Pages serves over `https://`,
which satisfies Web Serial's secure-context requirement. Push this folder
and point Pages at it (or the repo root, if this becomes its own repo).

## How it talks to PCB1

The client drives PCB1's **HMI mode** — a tagged, fully line-terminated
protocol with no blocking prompts. The authoritative spec is
`../../Embedded - fin/TA - PCB1/HMI_PROTOCOL.md`; this is the client side of it.

`js/serial.js` is a thin Web Serial wrapper that turns the incoming byte
stream into `line` events (one complete `\n`-terminated line each). Because
HMI mode has no unterminated `": "` prompts, there's no prompt-sniffing
anymore.

`js/pcb1-client.js` is the protocol adapter. On connect it sends a short
resync (`\n`, `x\n`, `hmi\n`) that lands on HMI idle from any prior board
state and waits for the `# HMI READY v2` banner — and **checks the version**,
refusing to continue on a mismatch (`HMI_PROTOCOL_VERSION`). That's a safety
gate, not pedantry: v1 read the `strobe` command's first argument as a PWM
duty and v2 sends it as a target RPM, same arity, so a v2 client against
un-reflashed v1 firmware would send `strobe 1200 -50`, which v1 clamps to duty
255 and runs the motor at full speed. See `HMI_PROTOCOL.md` §1.

After that it's **fire a
one-line command, demux tagged replies**: commands like `live 1200`,
`strobe 1200 -50`, `sweep 0`/`sweep 1`, `bump 0.3 5`, `accelcheck`, `relay 1`, `stop`; a
single line handler routes replies by their leading tag —
`R` (RPM row) → `rpm-sample`, `V` (decimated accel) → `vibration-live-sample`,
`K` (strobe RPM) → `strobe-sample`, `P` (sweep point) → `sweep-point`,
`A` (accel check) → `accel-check`, `#BEGIN/#END` framed bulk (bump dump) →
`bump-sample`/`bump-result`, and `#`-status lines (`# idle`, `# sweep
complete/aborted`, `# bump armed/triggered`) drive mode transitions. `app.js`
consumes those same events it always did, so it barely changed.

**Closed vs. open loop is a setting inside one session, not two modes.** The
Motor panel's Loop selector switches between `t <rpm>` (PI+feedforward holds a
target RPM) and `d <duty>` (the commanded 0-255 PWM goes straight to the
motor). Both ride PCB1's single `live` session, which is what lets the selector
be flipped **while the motor is running** — the shaft doesn't stop and the
Accel panel, which shares that same session, never sees a gap. That live switch
is the point: open loop sags under the reaction torque near resonance where the
closed loop holds. In open loop the `R` row's target field is `nan` (there is no
setpoint), so the panel shows a dash and the chart's Target trace breaks rather
than drawing a fictitious line. The duty slider sends on `input` (throttled
~80 ms) so dragging it is live; the RPM slider stays on `change`, since each new
setpoint is a step the controller then has to settle.

**Optional features are capability-gated, not version-gated.** Open loop is
advertised by the firmware's `I,...` line as `openloop=1`; `connect()` waits for
that line so `client.supportsOpenLoop` is settled before the UI configures
itself, and the Open (PWM) button is **disabled with an explanatory tooltip** on
firmware that predates it. A banner-version bump would have been too blunt here
— adding a command breaks nothing for an older client, and the reverse mistake
(new client, old board) just makes `live`'s digit-only retarget parser drop the
`d` line: harmless, but *silent*, which is precisely what a greyed-out button
fixes. Refusing the whole connection is reserved for changes like v1→v2's
`strobe`, where misreading an argument ran the motor to full duty.

**Relay state starts ON, and the board is the authority.** PCB1's `setup()`
drives `PIN_RELAY` HIGH and `relaySet()` maps HIGH → on, so the board **boots
with the relay (lighting LED) already on** — the Auxiliary panel's toggle
therefore initialises to **ON** (`relayOn = true` in `app.js`) to match the
hardware, not to OFF. Beyond that, the client doesn't track relay state
optimistically: the firmware prints `# relay on|off` for every change it
makes, including ones the panel didn't initiate (strobe mode kills the lamp on
entry and restores it on exit), and `pcb1-client.js` turns those into a
`relay-state` event that re-renders the toggle. Without that, the button
silently desynced after any strobe run.

*Known gap:* if a **prior** session left the relay off (e.g. someone used test
mode's mode `9`) and the board wasn't power-cycled, a fresh browser connect
still shows ON, since the firmware only reports the relay on *change*, not at
handshake. First connect after boot — the normal case — is correct.

**Self-heal after a mid-session board reset.** A USB/CDC blip can bounce the
firmware back to its `Select interface:` selector even though the port stayed
open, after which HMI commands are silently rejected and the UI looks frozen.
`pcb1-client.js` watches for that banner (or the test-menu header) while it
still believes it's connected and automatically re-sends `hmi` to re-assert
HMI mode. The firmware self-heals too (its selector auto-runs any recognized
HMI command — see `HMI_PROTOCOL.md` §1), so this is belt-and-suspenders and
also covers older firmware.

**Reliable bulk transfers.** The bump dump is ~11 k rows back-to-back and can
briefly outrun the read loop. If the per-row UI work (serial-log append, chart
redraw, console mirror) runs synchronously it stalls the read loop, the board's
USB TX buffer backs up, and lines get dropped (gappy captures; a lost `#END`
hangs the transfer). So the client (a) **batches** all of that — the serial log
flushes to the DOM once per animation frame (`renderAppend`/`flushLog`), and
the bump charts fill in `RollingChart` batch mode with a throttled live preview
— and (b) runs a **frame watchdog**: if a `#BEGIN…#END` frame goes quiet for
~3 s, it finalizes with the rows it received and returns to idle instead of
hanging. The firmware side raises its USB TX timeout to match (see
`HMI_PROTOCOL.md` §3, bump).

Only one PCB1 mode runs at a time, so every `start*()` stops whatever's active
first (`x` + newline) — except the RPM and Accel panels, which share the one
`live` mode so they can stream *simultaneously*: `pcb1-client.js` tracks which
panel(s) actually want data (`_rpmWanted`/`_vibWanted`) independently of the
shared session — whichever starts first launches `live`, the other joins it,
and each panel's Stop only tears the session down once *neither* wants it
(stopping RPM while Accel is still wanted idles the motor via `t 0` rather than
stopping the mode; stopping Accel while RPM is still wanted just stops
*listening* to `V` rows the firmware keeps sending).

**Opening that shared session goes through one funnel** (`_joinLiveSession()`),
and it has to. All three entry points — `startTargetRpmControl()`,
`startOpenLoopDuty()`, `startVibrationLive()` — used to test `_mode === 'live'`
and only *set* it after an `await`, so two panels starting in the same tick both
passed the test and both opened a session: the demo leaked a `setInterval` (two
timers racing the same events), hardware wrote two `live` commands, and in both
cases the second caller's `_vibWanted = false` (or `_rpmWanted = false`) cleared
the **first** panel's flag — that panel then went silent while the session
streamed happily for the other one, which is a nasty thing to debug because
nothing errors. The funnel stores the in-flight open as a promise, so a
concurrent caller awaits that one instead of racing a second up.

Two rules fall out of it, both load-bearing:
- **The session always opens at `live 0`**, and each caller applies its own
  intent afterwards (`t <rpm>`, `d <duty>`, or nothing for the Accel panel).
  That's what lets a joiner and an opener run the same path. Cost is one extra
  line on start — `live 0` + `t 1200` instead of `live 1200` — which the
  firmware treats identically since the controller ramps to target either way.
- **Panel flags are set *after* the join, never before**, because
  `_ensureIdle()` inside it runs `_resetStreams()`, which would wipe a flag set
  beforehand. Each entry point now only ever sets its **own** flag, so it can't
  clear the other panel's.

Wired up: `live` (RPM + Accel panels, concurrently), `strobe` (Stroboscope
panel), `accelcheck` (status screen's accelerometer check), `relay`
(Auxiliary panel), `sweep` (Sweep/Bode modal), `gap` (Sweep/Bode modal's
no-dwell gap field), `bump` (Bump Test modal), and `freevib` (Free Vibration
modal, Accel panel).

**Log Summary** (`btn-logsum` on the Accel panel → `modal-logsum`) is the
teaching half of the phase story. It sends `log 5` **while `live` is running**
— not as its own mode, so the shaft stays at the speed the student set, at
steady state (see `HMI_PROTOCOL.md` §3 for why that matters). PCB1 captures 5 s
at full rate, computes the statistics over all of it, and ships back the middle
1 s of raw waveform plus the encoder pulse times on the same clock. The modal
plots the two together the way the course's MATLAB script (`Prak2.m`, the old
NI-DAQ rig) did: **acceleration in m/s² against time in seconds** over the
*whole* shipped second (the capture's own clock, e.g. 2.00–3.00 s), with the
encoder pulses redrawn as the old **rectangular proximity-probe trace** (red,
dropping to 0 at each trigger instant) under the accel trace (blue), in a
white MATLAB-style figure with click-to-pin data tips. The student pins the
pulse's falling edge, the next trough and the next falling edge, and computes
360°×Δt/T themselves. **Reveal computed phase** then shows PCB1's own lock-in
answer to check against. Below it, the **FFT** of the same capture (raw, 0–100
Hz, `Prak2.m`'s `xlim([0 100])`) with the running speed marked is the
"is the response dominant at 1×?" check, and its peak reads the 1× amplitude.

**The exercise measures to the accel TROUGH, not the peak** — this is the one
thing to get right here. The encoder fires at maximum *displacement*, but the
ADXL335 measures *acceleration*, and `a = -ω²x` inverts the signal: max
displacement shows up as the accel trace's **minimum**. So pulse → trough is the
displacement-referenced phase, and it lands directly on the textbook 0° (below
resonance) → 90° (at fₙ) → 180° (above), with no normalisation needed.

Accordingly the firmware's raw `phase_deg` (which the lock-in measures pulse →
accel *peak*) is converted for display by `displacementPhaseDeg()` = `raw − 180`,
wrapped to `[-90, 270)` — that window keeps the physical 0-180 band contiguous,
so a reading a hair under zero shows as `-2°` rather than flipping to `358°`.
Reveal shows that number big, and the raw one small underneath as provenance.

Any offset remaining after the 180° is **sensor mounting angle**, which a single
capture cannot determine — which is exactly the motivation for the Bode plot's
low-RPM normalisation, and worth pointing students at. A few degrees of
disagreement against a hand reading is expected and worth saying out loud: a
trough is flattest exactly where you're trying to read its position.
`btn-logsum` is enabled only while `mode === 'live'`.

**Below ~0.8 fₙ, expect ≈ 0° give or take a degree or two — not a smooth
curve.** The phase is *measured* (encoder pulse → response); nothing in this
HMI computes it from fₙ, so a change of the beam's natural frequency (it is now
~22.1-22.3 Hz) doesn't affect the reading. With no damper fitted (structural
damping only, ζ ≈ 0.005-0.02) the true lag far from resonance is tiny —
φ = atan2(2ζr, 1−r²) gives 0.2-0.8° at r = 0.3 and 0.4-1.5° at r = 0.5 — which
is below what a single capture resolves: one sample is 0.43 ms ≈ 1° of a
revolution at 400 RPM, the 1× response is weak at low speed (the unbalance
force grows with ω²), and the mounting offset can't be removed from one capture.
So readings like 2° at r = 0.3 then −0.2° at r = 0.5 are scatter around zero.
The lag only becomes large, and steep, near resonance: ≈ 3-11° at 0.9 fₙ,
6-21° at 0.95 fₙ, 26-63° at 0.99 fₙ (ζ = 0.005-0.02) — so spend the captures
between ~0.9 and 1.1 fₙ in small RPM steps, and repeat each one; the Figures
tab keeps every capture to compare.

### The three trace views

The raw ADXL trace carries broadband noise across the ADS1220's whole ~1165 Hz
band, which makes picking a trough by eye genuinely hard. The **Trace** selector
offers three views of the same captured rows (all client-side — the firmware's
lock-in answer is computed independently of whatever is displayed):

- **Raw** — exactly what the board sent.
- **Low-pass** — zero-phase Butterworth (`js/filter.js`). Its cutoff is set in
  **harmonics of shaft speed, not Hz**, because the tone being measured moves
  with RPM: a fixed 25 Hz cutoff is right at 300 RPM but sits *below the
  fundamental* at 3400. The default 5 harmonics keeps the waveform's shape and
  discards the decade of pure-noise band above it. Below ~3 the filter starts
  attenuating the 1× response itself (timing stays exact; amplitude reads low),
  hence the minimum of 2.
- **Sync average** — time-synchronous averaging against the encoder pulses
  (`syncAverage`). Cut the record at every pulse, resample each revolution onto
  a common angular grid, average. Rotation-locked content adds coherently;
  noise falls as 1/√revolutions (~4.4× over a 1 s window at 1200 RPM) at no
  cost in bandwidth. Per-revolution normalisation makes it order tracking, so
  small speed variations realign rather than smear.

**Everything here is phase-preserving**, which is the only reason any of it is
allowed on this screen: the exercise is a *timing* measurement, so a causal
filter would silently corrupt the very quantity being taught. `filtfilt` is
zero-phase by construction, and every averaged segment starts on its own pulse,
so the output's t=0 *is* the trigger.

**Sync average band-limits first, and that isn't optional.** Synchronous
averaging rejects everything *not* locked to rotation — but an 8× harmonic is
exactly as synchronous as the 1×, so it survives at full strength. On hardware
that left a ripple which made the trough *harder* to find, not easier: measured
against a synthetic rotor, averaging the raw trace left 0.0053 g of residual
ripple, versus 0.0006 g when the same trace was low-passed first (8.7× cleaner),
and the trough reading improved from 198.8° to 188.1° against a true 180°. The
two stages remove different things — the filter kills harmonics, the averaging
kills noise — so the Harmonics control applies to both views.

**All three share one window: the whole shipped second, on absolute time.**
Raw and low-pass plot every sample. The sync view lays the averaged revolution
back onto *every real revolution* — stretched to each pulse-to-pulse interval,
plus the partial revolutions at both ends at the mean period — so it lines up
with the same pulse train and time axis as the other two (a missed pulse's
double-length gap gets two cycles, and `syncAverage` drops such out-of-length
"revolutions" from the average). Switching views therefore changes the trace and
nothing else — same span, same pulses, same origin. With only one revolution
available the status says there was nothing to average rather than advertising
a noise reduction it didn't perform. Filtering runs on the full record, so
`filtfilt`'s edge transients only touch the first/last few ms (tens of ms at a
very slow shaft) — read Δt away from the ends.

**The pulse trace is synthesised, and only its falling edge means anything.**
PCB1 sends one timestamp per revolution, not a probe voltage, so the rectangle
is drawn from those times: high, down to 0 *at* the timestamp, back up after 5%
of the (median) revolution — the width the old probe's dip had in `Prak2.m`
figures. The level is arbitrary (picked just above the trace so the y-axis
stays snug), the y-axis is labelled for the accel. Only the falling-edge
vertices are snappable, so the cursor and data tips can only ever report the
trigger time, never the cosmetic end of the dip.

Chart notes: the trace and the FFT are `BodeChart`s (x = time, y = accel) and,
like every chart in the HMI, MATLAB axes with the axes toolbar and data tips
(see [Charts](#charts-jsmatlab-axesjs)). For this exercise the useful tools are
**Zoom In with a horizontal line** (zooms time only — the quick way down to 2-3
cycles with the whole amplitude still in view), click-to-pin **data tips** (they
stay on their data point through zoom/pan and follow the trace across a
Raw/Low-pass/Sync switch; a double-click restores the view and pins nothing),
and the scroll wheel, which now zooms both axes about the cursor as in MATLAB
(it used to zoom time only). The pulse train is set with
`setSeries(..., { presorted, lineWidth, cursor: 'x' })` and per-point
`snap: false`, so a tip on it can only land on a falling edge — the trigger
time, never the cosmetic end of the dip. Tips print up to 6 significant digits
(`formatTipValue()`), so a few-ms Δt reads exactly (`2.36996 s`). The drawing
itself is in `js/logsum-plot.js`, shared by this modal and the Figures tab, so a
capture looks identical in both.

**The Stroboscope panel takes a target RPM, not a duty** (protocol v2). PCB1
holds that speed with the same PI+feedforward loop the Motor panel uses, so the
student dials in the speed they actually want and it holds against the reaction
torque near resonance instead of sagging the way a fixed open-loop duty would.
Test mode's own strobe (menu key `0`) still takes a duty and is untouched — the
two share the strobe engine (`strobeSchedulerStep`), differing only in how the
motor is driven. Note the panel's **Live RPM** readout is the *raw* measured
value the strobe locks to, not the target: the flash has to track the shaft's
instantaneous period, so it deliberately uses unfiltered RPM while the
controller feeds back the filtered one.
The firmware's other modes are test-mode-only and not exposed as HMI
commands: `1/2/3/4/6/7/8/c`, and the standalone `t`/`v` (whose combination
*is* exposed, as `live`). Mode `6` in particular stays the full ~2330 SPS
quality-capture tool in test mode, deliberately not reused for the Accel
panel's live view.

The HMI `sweep` is **not** a separate implementation — it runs the same
firmware sweeps as test mode, sharing the per-point core outright. `sweep 0`
(default) is the **undamped** test-mode `r` sweep; `sweep 1` is the **damped**
test-mode `r2` sweep. Both are exposed through the Sweep/Bode modal's
Undamped/Damped selector (see "Advanced Tests" below).

**Sweep "Auto Mode" live view.** During a `sweep`, PCB1 owns the motor and
streams decimated `R`/`V` rows through each grid point's *settle phase*
(silent during the 5 s measurement capture, so `actual_sps` stays clean).
The client forwards those to the RPM/Accel panels as a **read-only live
view**: the panels animate, but their Start buttons relabel to
**"Auto Mode (sweep)"** (amber, disabled) so it's clear the sweep is driving
them, not the student. They revert to normal Start/Stop when the sweep ends.

### Debugging the serial link

The **Serial Log** panel (dashboard, in the Auxiliary section) is the main
debugging surface for bench bring-up:

- Shows **both directions** with local-time timestamps — `>` = sent to the
  board, `<` = received. Seeing exactly what was sent (e.g. the `hmi`
  handshake, a `live 900`) is the fastest way to spot a command that gets no
  answer.
- **Save** exports the full session (both directions, every line, *including*
  filtered ones) to a `.txt`; **Clear** resets it; **Hide R/V/K** declutters
  the view by dropping the high-rate stream rows (they stay in the export).
- Everything except those high-rate rows is also mirrored to the browser
  **DevTools console** (F12) — a searchable copy that survives even if the
  connect handshake fails before you reach the dashboard.

If the handshake hangs, the log/console will show the `>` `hmi` line with no
following `< # HMI READY v2` — check that the board is in (or reachable to)
HMI mode. `PCB1Client.connect()` sends `\n` / `x` / `hmi` and waits up to 8 s
for the banner.

## Charts (`js/matlab-axes.js`)

Every plot in the HMI — the live RPM/Duty/Accel strips, the Log Summary trace
and FFT, the sweep's amplitude and phase, the bump and free-vibration traces and
spectra, and every figure in the Figures tab — is a MATLAB-style axes drawn by
one base class, `MatlabAxes` (`js/matlab-axes.js`). `RollingChart`
(`js/chart.js`: time series fed with `push()`) and `BodeChart`
(`js/bode-chart.js`: XY series set with `setSeries()`) only supply the data, the
automatic limits and the hit-testing.

**Look** — MATLAB's defaults: a white figure in both HMI themes; MATLAB's colour
order (`#0072bd`, `#d95319`, `#edb120`, …); a dark-grey box on all four sides
with inward ticks; a light grid; Helvetica/Arial; tick labels without trailing
zeros ("5", "5.1", not "5.00"); "nice" automatic limits that carry their own
ticks (a 0–0.06 axis is labelled 0, 0.01, … 0.06 — never 0, 0.05); a centred
bold title; a legend placed 'best', in a corner, or above the axes.

**Axes toolbar** — appears at the top-right of a plot while the pointer is over
it (and stays while a mode is on), like MATLAB's:

| Button | What it does |
|---|---|
| Export ▸ | **Save as PNG…** (2× resolution, named after the plot/figure) or **Copy as Image** |
| Data Tips | click points to pin X/Y tips; click a tipped point again to remove it |
| Pan | drag to move the view |
| Zoom In | drag a **box** to zoom to it; drag a (nearly) **horizontal line** to zoom x only, or a **vertical line** to zoom y only (MATLAB's constrained zoom); a click zooms 2× about the point, Shift-click zooms out |
| Zoom Out | click to zoom out 2× about the point — never past the original view |
| Restore View | back to the automatic limits |

With no mode on (the default): hovering shows the nearest point, a click pins a
data tip, a drag pans, the scroll wheel zooms both axes about the cursor, a
double-click restores the view, and right-click opens a menu (Restore View,
Delete All Data Tips, Save as PNG…, Copy as Image). Plots stacked on a shared x
axis — the sweep's amplitude and phase, in the modal and in the Figures tab — are
linked like `linkaxes(..., 'x')`: zooming, panning or restoring one moves both.
Dense traces are min/max-decimated per pixel column when drawn, so the 11 k-35 k
sample bump captures still pan smoothly.

`RollingChart.push(timeMs, ...values)` plots against real elapsed seconds (like
`plot(t, y)`), not sample index, so it stays correct regardless of the actual
sample rate of whichever panel is feeding it. `push()` redraws on every call,
which is fine for live streams (a few points per frame) but not for bulk loads —
`beginBatch()`/`endBatch()` wrap a large fill (e.g. the ~11 k-row bump dump, or
its FFT) so points accumulate and the canvas redraws **once** at the end,
instead of thousands of synchronous redraws blocking the main thread (which is
what let the serial transfer stall and drop data).

Two modes:
- **Unbounded scrolling** (default, e.g. the RPM/Duty charts): keeps the
  last `maxPoints` samples, x-axis autoscales to whatever's buffered.
- **Fixed-width sliding window** (`windowSeconds`, e.g. the Accel chart at
  3 s): every `push()` evicts samples older than `windowSeconds` behind the
  latest one, so the visible span continuously creeps forward one sample
  at a time (oscilloscope roll mode) instead of resetting/jumping back to
  0 every `windowSeconds` — deliberately chosen over a reset-and-refill
  sweep to avoid a jarring, sudden trace jump every few seconds.

The live strips use `xTight` (x limits exactly the buffered span, MATLAB's
`axis tight`), so a scrolling window doesn't jump between tick boundaries;
one-shot captures keep MATLAB's rounded-out limits (e.g. 0–5 s).

### Plot-frame geometry

The left margin is measured from the widest y tick label, but never narrower
than a fixed reserve (`-000.0`): sized to the live labels alone, an autoscaling
axis would shift the whole plot box a few pixels whenever its widest label
changed ("0.40" gaining a minus sign the first time the trace dips negative),
a constant squish/expand while streaming. The right margin leaves room for half
of the last x label.

`niceTicks` nudges by 1e-9 before rounding outward. Data whose extreme lands
*exactly* on a tick rarely divides exactly in floating point — `0.3 / 0.1` is
`3.0000000000000004`, so a bare `Math.ceil` jumped to 4 and the axis gained a
whole empty step (a 0–0.3 s trace drawn on a 0–0.4 s axis). The error is ~1e-16
relative, so the tolerance can't swallow a real data point.

`../Matlab/BumpTestESP32.m` was a MATLAB client for mode `b` (bump test),
built *before* `_parseBumpLine()`/`runBumpTest()` were added to
`pcb1-client.js` -- it was the working reference those were built against
(at the time, the same line/prompt protocol and the same raw-dump
markers/CSV shape as mode 6), not a from-scratch design. **It is now
retired** (never ran on hardware; broken by PCB1's interface selector and not
ported to HMI mode — see `../Matlab/README.md`). This client is the only live
bump-test path. The one thing that retires with it is the damping-ratio
nonlinear-sinusoid fit, which this client deliberately doesn't reproduce —
**Save Run** to JSON and fit offline if it's needed (see "Advanced Tests"
below).

## Figures tab (`figures.html`)

The HMI's answer to MATLAB's Figures window. Every capture — **Log Summary,
Bump Test, RPM Sweep, Free Vibration** — is saved as a numbered figure
("Figure 1", "Figure 2", …) in a separate browser tab, where it stays until it
is closed. So you can go back to the Motor panel, change the speed and take the
next capture without losing the previous plot — the point when stepping through
speeds near resonance. The HMI's own modals work exactly as before.

- **Opening it.** With **Auto-open** on (topbar checkbox, default on, remembered
  in `localStorage` as `hmi-figures-autoopen`), starting any capture brings the
  Figures tab to the front with a placeholder ("Recording 5 s at full rate…",
  "Armed — tap the beam…", live progress), which turns into the figure when the
  result arrives. The tab has to come forward *at the start*: browsers only let
  a page open or focus another tab in direct response to a click. The
  **▦ Figures** button opens it any time; with Auto-open off a capture is saved
  silently and a "Saved as Figure N" notice offers to open it. The same tab is
  reused (found by its window name), also after either tab is reloaded.
- **Each figure** is drawn with the same chart classes and analysis code as the
  modal (`js/figure-views.js`, `js/logsum-plot.js`, `js/sweep-analysis.js`,
  `js/freevib-analysis.js`) and keeps its controls: Raw/Low-pass/Sync average,
  harmonics, Reveal computed phase (Log Summary); cutoff, show-raw, Reveal f & ζ
  (Free Vibration); linked amplitude/phase axes (Sweep). A sweep's figure fills
  in live, point by point.
- **Numbering** follows MATLAB: a new figure takes the lowest free number, so
  after closing Figure 2 the next capture becomes Figure 2.
- **Closing**: × on the tab, middle-click, or Delete on a focused tab; **Close
  All** asks for a second click. Arrow keys move between figure tabs.
- **Storage**: IndexedDB (`dl1000-hmi-figures`), so figures survive reloading
  either tab and closing the Figures tab; they're per-browser and per-computer.
  If the browser blocks storage the figures are kept only while the HMI tab
  stays open, and the Figures tab says so. Use each plot's Export button (or the
  modals' **Save Run…**) for anything that must outlive the browser.
- **Unfinished captures**: a capture that ends with nothing to show (bump
  aborted while armed, too few samples, the cable pulled) removes its
  placeholder; a sweep stopped early keeps its points, marked aborted. If the
  HMI tab is closed or reloaded mid-capture, the Figures tab settles that figure
  within a few seconds (each HMI tab holds a Web Lock while open, which is how
  the Figures tab tells). A finished capture is always kept — if its placeholder
  was closed meanwhile, it comes back as a new figure.

Files: `figures.html`, `css/figures.css`, `js/figures.js` (the tab),
`js/figure-store.js` (storage, numbering, cross-tab messages over a
`BroadcastChannel`), `js/figure-views.js` (one view per capture type).

Demo-mode note: the simulated captures are paced by the wall clock, so they run
at the same speed while the Figures tab is in front (a background tab's timers
fire only about once a second).

## Advanced Tests: RPM Sweep/Bode Plot, Bump Test, and Free Vibration

Bounded, occasional measurement runs, each opened as a modal overlay
(`btn-open-sweep`/`btn-open-bump` in the Advanced Tests panel; `btn-open-freevib`
on the Accel panel) rather than a permanent grid panel — closing a modal only
hides it, it does **not** stop whatever's running (same reasoning as the
dashboard panels continuing to stream regardless of what's currently visible):
arm a bump test, close the modal, go tap the apparatus, reopen later to check
whether it triggered.

**RPM Sweep / Bode Plot** (`runRpmSweep(damped)`, HMI `sweep [0|1]` command)
streams one tagged `P` row per completed grid point (`rpm_avg,target_rpm,
accel_amplitude_mV,accel_amplitude_g,actual_sps,accel_amp_1x_g,rpm_std,
phase_deg`) as the sweep runs, plotted live as
amplitude vs. measured RPM on a `BodeChart` (`js/bode-chart.js`) — a
multi-series XY chart, not `RollingChart`, since a Bode plot's x-axis is
RPM (not time) and needs several independently-managed named series at
once (the live run plus however many saved runs are loaded for overlay
comparison), which `RollingChart`'s single rolling time-buffer can't
represent. **Save Run** exports the finished run's points (all CSV
fields, plus an optional label) as a downloadable JSON file; **Load
Run(s)** reads one or more of those files back in as additional overlay
series, each auto-assigned the next colour of MATLAB's colour order — this is the
mechanism for comparing, e.g., the effect of added damping across
separate sweep runs (potentially days apart). Starting a new sweep only
clears the *live* series, not loaded overlays, since the whole point is
comparing a new run against previous ones; **Clear Overlays** removes
just the loaded comparisons, keeping the live run.

**Undamped / Damped selector.** A segmented control in the modal picks which
firmware sweep runs, and `runRpmSweep(damped)` sends `sweep 0` or `sweep 1`
accordingly:

- **Undamped** (`sweep 0`, test-mode **`r`**) — the gapped sweep: identical
  `driveToRpmAndCaptureAdaptive` per-point core plus `buildSweepGrid` /
  `buildReverseSweepOrder` / `planSweepPoint`, so it gets the (by default
  1325-1350, see below) no-dwell gap, **reverse-cycle traversal** (ascend to
  the gap's lower edge, jump to max RPM, then descend the super-resonance
  grid to dodge Sommerfeld capture) **and** the fine-band early-exit disable.
- **Damped** (`sweep 1`, test-mode **`r2`**) — the full sweep: the
  `CRPMSWEEP_BANDS_FULL` grid swept straight low-to-high in one ascending pass
  (no gap, no reverse cycle) with adaptive early-exit allowed at every point. A
  damper broadens/stabilises the resonance, so there's nothing to dodge. Its
  grid is **centred on the damped natural frequency ~21.1 Hz (1266 RPM)** — the
  damper's added mass drops the resonance ~1 Hz from the undamped 22.1 Hz — and
  is **coarser with fewer points** (~44 vs ~70; a damped peak is broad and far
  less sensitive). It also waits longer per point before capturing (a higher
  firmware min-settle floor, `CRPMSWEEP_FULL_MIN_SETTLE_MS`) since the added
  mass slows the transient decay.

Both share the same per-point core and the same settle-phase `R`/`V` live
streaming + tagged `P` summary rows (the damped path keeps this I/O even though
the test-mode `r2` prints CSV instead), so tuning any sweep constant in the
firmware changes every path at once. The `# sweep start` line echoes
`mode=undamped|damped`. Selecting **Damped** first raises a reminder popup
(`#modal-damper`, before/after `assets/damper - *.png` photos) to physically
attach the damper — the mode only switches on confirm; Cancel leaves it
undamped. The chosen case is snapshotted when a run starts (`currentRunDamped`)
so the live trace's legend, the status line, and the Save Run JSON's `mode`
field all record which case actually ran; loaded overlays are tagged
`[undamped]`/`[damped]` so an undamped and a damped run can be compared on one
plot. The selector is locked while a sweep is running. Switching case also moves
the Bode/phase **resonance reference line** to that case's nominal natural
frequency (`UNDAMPED_RESONANCE_HZ` 22.1 / `DAMPED_RESONANCE_HZ` 21.1) — a manual
edit to the Resonance (Hz) field afterwards still sticks until the next switch.

The plotted amplitude is the **1×RPM lock-in** (`accel_amp_1x_g`,
noise-rejecting — decisive at low RPM); the broadband RMS is still parsed
and kept in the Save Run JSON as a cross-check, just not plotted. Because the sweep visits
setpoints out of RPM order, the `BodeChart` sorts each series by x before
drawing its connecting line (markers stay in arrival order) — see
`js/bode-chart.js`.

**No-dwell gap field (Undamped only).** Next to the Undamped/Damped selector,
a "No-dwell gap (RPM)" row (two number inputs + **Set Gap**) sends the
firmware's `gap <lo> <hi>` command (`client.setSweepGap()`,
`HMI_PROTOCOL.md` §3.1) before the next undamped run — for a setup where the
rig's actual instability band sits somewhere other than the bench-validated
1325-1350 default (a different unbalance mass or mount stiffness can shift
it). The row is
greyed out while a run is in progress, while **Damped** is selected (the
damped grid has no gap), or on firmware that predates the feature
(`client.supportsGapAdjust`, gated on the `I,...` line's `gapadj=1` — same
STRICT-when-unknown pattern as `supportsOpenLoop`). A rejected pair (outside
1285-1375 RPM, or `lo >= hi`) is reported inline and leaves the previous gap in
effect; on success the two fields are overwritten with the firmware's
confirmed edges. Not persisted on the firmware side — a reboot/reconnect
resets it to 1325-1350, so re-apply it after reconnecting if the setup still
needs it.

*(Mode-name trap when reading older material: the firmware's original `r` was
a fixed-settle push-through sweep, and the adaptive/reverse one was `r2`. The
push-through was retired and **`r` was reused** for the adaptive/reverse
sweep; `r2` now means the damped full sweep. Both are now reachable over HMI
via `sweep 0` / `sweep 1` — earlier notes saying `r2` "has no HMI command" are
stale.)*

**Phase plot** (`sweepPhaseChart`, stacked under the Bode plot, same RPM
x-axis). Plots `phase_deg` — the 1× response phase referenced to the encoder
pulse, i.e. how far after the trigger the accel peak lands as a fraction of a
revolution. It runs 0° well below resonance, crosses **90° at** the natural
frequency, and approaches 180° above it; `sweep-done` reports the interpolated
90° crossing, which locates resonance more sharply than the amplitude peak
(that peak sits slightly *above* fn and is noise-biased at low RPM). Three
things worth knowing about how it's rendered:

- **The firmware sends RAW phase**, still carrying the fixed mounting-angle and
  accel-vs-displacement (180°) offsets. `phaseSeriesFor()` removes them by
  circular-averaging the sub-`PHASE_ZERO_MAX_RPM` (1000 RPM) points to zero —
  self-calibrating, and it survives a re-mount. The series is **rebuilt** on
  every incoming point rather than appended to, because the offset itself
  sharpens as more low-RPM points arrive and applies retroactively to the whole
  trace. Save Run stores the **raw** values; each loaded overlay is normalised
  against its own low-RPM points.
- **Weak-tone points are faded, not dropped** (`dim` on the point, honoured by
  `BodeChart`). Where `accel_amp_1x_g / accel_amplitude_g` is under
  `PHASE_MIN_TONE_RATIO`, the 1× tone is buried and the lock-in's *angle* is
  meaningless even though it still returns a number.
- **The y-axis is fixed** (`yFixed`, -30…210) rather than auto-fit: phase is
  physically bounded, so a fixed frame keeps runs comparable and stops a flat
  pre-resonance trace being magnified into pure noise. `refY: 90` draws the
  crossing line. Zooming still overrides it; Restore View (or a double-click) returns here.

On the undamped beam the crossing usually lands inside the sweep's (default)
1325-1350 no-dwell gap, so it's interpolated across ~25 RPM — the status line says so
rather than quoting false precision. `PHASE_ZERO_MAX_RPM` /
`PHASE_MIN_TONE_RATIO` are mirrored as `RSWEEP_PHASE_*` in
`../../Embedded - fin/TA - PCB1/PlotVibrationLog.m` so both hosts normalise
identically — change one, change the other.

**Bump Test** (`runBumpTest(thresholdG, durationS)`, mode `b`) arms,
waits for a physical tap/bump exceeding the threshold, and streams the
post-trigger raw capture back exactly like mode 6's format. Two client-
visible phases beyond "armed": `bump-triggered` (the physical ~5-15 s
capture is happening on-device, but **silently** — same as mode 6, there's
zero serial output during that tight ADC loop, so no live data is
possible yet) and `bump-capturing` (the raw dump is now streaming in,
`bump-sample` fires per row for a live-filling time-domain plot — "live"
relative to the *serial transfer*, not the physical capture, which
already finished by this point; the plot fills in chart **batch mode** with a
redraw throttled to one per animation frame, and a frame watchdog recovers the
UI if `#END` is lost — see "Reliable bulk transfers" above). Once the dump +
results block finish, `bump-result` fires and the FFT (`js/fft.js`) is
computed client-side —
there's no MATLAB in a browser. That FFT is a radix-2 Cooley-Tukey
implementation, so unlike MATLAB's exact-N `fft()` it
zero-pads up to the next power of 2; this only changes bin
spacing/resolution (finer, not coarser), not where a real peak shows up.
**Save Run** exports the raw time-series + metadata as JSON (no plot
images). The damping-ratio nonlinear-sinusoid fit is intentionally *not*
reproduced client-side (time+FFT plots only, by design). With
`BumpTestESP32.m` retired, there is **no live-from-PCB1 path to that fit** —
the route is Save Run → JSON → fit offline, using `bump_ultra_gacor.m` (the
NI-DAQ original, in the sibling `TA - Bump Test` project) as the reference
implementation. Nothing currently reads this JSON into that script; it'd need
a small loader.

**Free Vibration** (`runFreeVib(durationS)`, `freevib` command; `btn-open-freevib`
on the Accel panel → `modal-freevib`) is an **untriggered, motor-off** capture
for the separate low-frequency free-vibration rig (~2.5 Hz). The student
deflects the beam and releases as they press **Start Record**; the firmware
streams accel **live** as tagged `F` rows (`freevib-sample` per
row) so the ring-down animates in real time — unlike Bump Test's buffer-then-
transfer, so "live" here means the *physical* decay, and unlike Log Summary
there's no encoder/phase. It fills the time plot in chart batch mode (rAF-
throttled redraw, same as Bump).

**Noise handling.** The raw ADXL trace is noisy enough that reading peaks by
hand is hard, so it's filtered in two places: the firmware **averages** each
decimation group (mean, not every-Nth) for ~3.5× less noise at source, and the
client applies a **zero-phase low-pass** (`js/filter.js` — a 2nd-order
Butterworth run forward+backward, so peaks keep their exact time and height;
default 8 Hz cutoff, tunable via the modal's *Low-pass cutoff* field, which
re-filters the last capture without re-recording). The displayed/measured trace
is the filtered one; *Show raw* toggles the unfiltered overlay for comparison,
and **Save Run** always writes the **raw** samples (the filter is a view, not a
mutation). The analysis runs on the filtered trace.

On `freevib-done` the FFT is computed (`js/fft.js`) and an
on-device-independent **analysis** runs: positive peaks are picked off the
ring-down, the mean peak-to-peak spacing gives the damped frequency f_d, and a
least-squares fit of `ln(peak amplitude)` vs. cycle index gives the logarithmic
decrement δ — from which ζ = δ/√(4π²+δ²) and the undamped
fₙ = f_d/√(1−ζ²). Those are held behind a **Reveal computed f & ζ** button
(`btn-freevib-reveal`), so students first measure with data tips (natural
frequency from peak spacing, damping from how fast peaks shrink) and then check
against the computed values — the same estimate-then-reveal pattern as Log
Summary's phase. **Stop** aborts at any point (the firmware's stream loop checks
every iteration, unlike the un-abortable Bump capture) and analyses whatever
streamed. **Save Run** exports the raw `{time_s, accel_g}` series + the analysis
as JSON. This recovers the **damping-ratio** measurement the retired MATLAB bump
client used to own — now client-side, for the free-vibration case.

**The structured protocol now exists.** The single-char blocking-prompt menu
this client used to drive was the documented stopgap; PCB1's **HMI mode**
(`HMI_PROTOCOL.md`) replaced it, and — as predicted — `pcb1-client.js` was the
one file rewritten for it, while `app.js`'s event contract stayed put. This now
runs end-to-end against the real board (connect/handshake, strobe, and the bump
dump all validated on hardware — see `HMI_PROTOCOL.md` §7); the client is also
verified in demo mode.

## Known limitations of this draft

- Recovery covers the board falling back to its interface selector mid-session
  (auto re-asserts HMI — see "Self-heal" above), but **not a full serial drop**:
  if the cable is unplugged or the port actually closes, reload the page and
  reconnect.
- No StroboESP link — the strobe panel only controls PCB1's own
  `RPM + strobe` GPIO output (mode 0). The separate stepper deploy/retract
  unit (`TA - StroboESP`) is triggered autonomously by that pulse train on
  its own hardware state machine, not addressed directly from here.
- The `sweep`'s abort (`x`) is only checked during each point's settle
  phase, not mid-capture — worst case (the post-gap point's 15 s settle + 5 s
  capture) is ~20 s before PCB1 actually stops and emits `# sweep aborted` /
  `# idle`. `PCB1Client.stop()` waits up to 25 s for `# idle` when
  `mode === 'sweep'` specifically (5 s for every other mode); if a future
  settle time is ever raised past that, bump this timeout too.
- The Sweep/Bode overlay comparison and Bump Test's Save Run both write
  plain JSON files via the browser's normal download mechanism (no picker
  for *where* — whatever the browser's default download folder is) and
  read them back via a `<input type="file">` picker — there's no
  auto-discovery of previously-saved runs, the user has to know where
  they downloaded them.
- **Open-loop motor control has not run on hardware.** It is compile-clean and
  demo-verified only; the board must be re-flashed for it to appear at all
  (until then the Open (PWM) button stays greyed out — that's the capability
  flag working, not a fault). The specific thing to check on the bench is the
  *bumpless* handover: at a steady open-loop speed, switch to closed loop at
  the same RPM and confirm the duty doesn't jump or dip, then the reverse.
- The Log Summary's Sync average draws one averaged revolution onto every
  revolution, so every cycle is identical by construction. That's what makes
  the trough easy to read, but it also means revolution-to-revolution
  variability — which is real information, e.g. a rotor that hunts — is
  invisible in that view. Raw is one click away and shows it.
- The Log Summary shows the **1 s** PCB1 ships, not the whole 5 s it captures
  (the statistics and the revealed phase do use all 5 s). Showing more would
  need the firmware's `log` dump to ship a longer window — a firmware change,
  not an HMI one.
- The FFT pane's amplitudes are true peak amplitudes (`computeAmplitudeSpectrum`:
  zero-padded, Hann, scaled by the real sample count). The Bump Test and Free
  Vibration FFTs still use `computeFFT`, which scales by the *padded* length, so
  their peak heights read low by N/N_padded (between 0.5× and 1×, depending on
  the record length) — harmless there (only the peak's frequency is used), but
  don't read amplitudes off them.
- Log Summary has no **Save Run** (JSON), unlike the Sweep, Bump and Free
  Vibration modals. The Figures tab keeps every capture in this browser and each
  plot exports as a PNG, but there's no data file to re-examine offline.
- Figures live in this browser's storage on this computer (IndexedDB): another
  browser or computer won't see them, and clearing the site's data deletes them.
