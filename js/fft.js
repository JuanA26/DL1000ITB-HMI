// Minimal radix-2 Cooley-Tukey FFT, used to reproduce (client-side, no
// MATLAB available in the browser) the frequency-domain plot from
// "Laptop HMI/Matlab/BumpTestESP32.m":
//   N = length(acc); Fs = 1/mean(diff(time)); df = Fs/N;
//   freq = (0:N-1)*df;  ACC = 2/N * abs(fft(acc));
//
// One real difference from that script: radix-2 requires a power-of-2
// length, so the input here is zero-padded up to the next power of 2
// instead of using the raw sample count N directly (MATLAB's fft() takes
// arbitrary N via a mixed-radix/Bluestein algorithm internally). Padding
// only changes the frequency bin spacing (finer/interpolated, not
// coarser) -- it does not shift where a real peak shows up, just how
// precisely it's resolved between bins.

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// In-place iterative radix-2 FFT (bit-reversal permutation + butterfly
// stages). re/im must both have a power-of-2 length.
function fftInPlace(re, im) {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len / 2;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

// samples: array of real values (e.g. bump test's bias-corrected accel_g
// column), sampleRateHz: the capture's actual measured SPS. Returns
// { freq, amplitude } for bins [0, Nyquist), using the same 2/N * |FFT|
// scaling convention as the MATLAB script (N = the padded length here).
export function computeFFT(samples, sampleRateHz) {
  const n = nextPow2(samples.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Zero-mean first, like the MATLAB script's `acc = acc - mean(acc)` --
  // otherwise a DC offset would dump most of the spectrum's energy into
  // bin 0 and swamp the actual vibration content.
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  for (let i = 0; i < samples.length; i++) re[i] = samples[i] - mean;
  // re[samples.length..n) and all of im[] are already 0 (zero-padding).

  fftInPlace(re, im);

  const half = n / 2;
  const freq = new Float64Array(half);
  const amplitude = new Float64Array(half);
  const df = sampleRateHz / n;
  for (let k = 0; k < half; k++) {
    freq[k] = k * df;
    amplitude[k] = (2 / n) * Math.hypot(re[k], im[k]);
  }
  return { freq, amplitude };
}

// Simple local-maxima peak picker for a computeFFT() spectrum (or any
// x/y arrays), similar in spirit to MATLAB's findpeaks(): a bin counts as
// a peak only if it's a strict local max AND at least minHeightRatio of
// the spectrum's tallest bin (screens out noise-floor wiggle), then the
// tallest candidates win when two peaks fall within minDistance of each
// other (keeps a real peak's own FFT leakage into adjacent bins from
// being reported as a second, separate peak).
export function findPeaks(xs, ys, { minHeightRatio = 0.15, minDistance = 1, maxPeaks = 5 } = {}) {
  if (xs.length < 3) return [];
  let maxY = 0;
  for (let i = 0; i < ys.length; i++) if (ys[i] > maxY) maxY = ys[i];
  if (maxY <= 0) return [];
  const minHeight = maxY * minHeightRatio;

  const candidates = [];
  for (let i = 1; i < ys.length - 1; i++) {
    if (ys[i] >= minHeight && ys[i] > ys[i - 1] && ys[i] >= ys[i + 1]) {
      candidates.push({ x: xs[i], y: ys[i] });
    }
  }
  candidates.sort((a, b) => b.y - a.y);

  const picked = [];
  for (const c of candidates) {
    if (picked.some((p) => Math.abs(p.x - c.x) < minDistance)) continue;
    picked.push(c);
    if (picked.length >= maxPeaks) break;
  }
  picked.sort((a, b) => a.x - b.x);
  return picked;
}

// Amplitude spectrum for READING A PEAK HEIGHT off the plot (the Log Summary's
// "is the response dominant at running speed, and how big is it" check).
//
// computeFFT() above is fine for locating a peak but under-reads its height:
// it scales by the PADDED length, so a 2330-sample capture padded to 4096
// shows a sinusoid at ~57% of its true amplitude, and a tone falling between
// its coarse bins loses up to another ~36% (scalloping). Both matter once a
// student copies the number into a table. Here:
//   - the record is zero-padded >= padFactor x (default 8x), which samples the
//     spectrum finely enough that the plotted peak sits within ~0.6% of the
//     true maximum wherever the tone falls between the 1/T bins, and
//   - amplitude is 2/N * |X| with N = the TRUE sample count (zero-padding adds
//     no signal energy), i.e. MATLAB's  2/N*abs(fft(acc))  convention.
// So a pure  A*sin(2*pi*f*t)  reads A at f. Frequency RESOLUTION is still 1/T
// (1 Hz for a 1 s record) -- padding only interpolates between bins.
//
// window: 'hann' (default) or 'rect'. A 1 s record rarely holds a whole number
// of cycles, and with a rectangular window (what plain fft() does) the finely
// sampled spectrum then shows the sinc's side lobes -- a comb of smaller peaks
// either side of the real one, ~22% of its height, which a student can easily
// take for real frequency content. Hann pushes them below ~3% at the cost of a
// main lobe twice as wide (+/-2 Hz at 1 s); its coherent gain (sum(w)/N, ~0.5)
// is divided back out so the peak still reads the true amplitude.
// Returns { freq, amplitude } for bins up to min(maxHz, Nyquist).
export function computeAmplitudeSpectrum(samples, sampleRateHz, { padFactor = 8, maxHz = Infinity, window = 'hann' } = {}) {
  const N = samples.length;
  if (N < 2 || !(sampleRateHz > 0)) return { freq: new Float64Array(0), amplitude: new Float64Array(0) };
  const n = nextPow2(N * Math.max(1, padFactor));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += samples[i];
  mean /= N;
  let gainSum = 0;
  for (let i = 0; i < N; i++) {
    const w = window === 'hann' ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) : 1;
    re[i] = (samples[i] - mean) * w;
    gainSum += w;
  }

  fftInPlace(re, im);

  const df = sampleRateHz / n;
  const kMax = Math.min(n / 2 - 1, Math.floor(maxHz / df));
  const freq = new Float64Array(kMax + 1);
  const amplitude = new Float64Array(kMax + 1);
  const scale = 2 / gainSum;   // = 2/N for the rectangular window
  for (let k = 0; k <= kMax; k++) {
    freq[k] = k * df;
    amplitude[k] = scale * Math.hypot(re[k], im[k]);
  }
  return { freq, amplitude };
}
