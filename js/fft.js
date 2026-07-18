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
