import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pitch = require("../js/pitch.js");

const { STRINGS, detectPitch, closestString, centsBetween, verdict } = pitch;

let failed = 0;
let passed = 0;

function assert(cond, message) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", message);
  }
}

function sine(freq, sampleRate, length, amp = 0.6) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function saw(freq, sampleRate, length, amp = 0.6) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const phase = ((freq * i) / sampleRate) % 1;
    out[i] = amp * (2 * phase - 1);
  }
  return out;
}

function harmonics(freq, sampleRate, length, amps, amp = 0.45) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let s = 0;
    for (let h = 0; h < amps.length; h++) {
      s += amps[h] * Math.sin((2 * Math.PI * freq * (h + 1) * i) / sampleRate);
    }
    out[i] = amp * s;
  }
  return out;
}

function noise(length, amp) {
  const out = new Float32Array(length);
  let seed = 1234567;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * (seed / 0x7fffffff * 2 - 1);
  }
  return out;
}

function detune(freq, cents) {
  return freq * Math.pow(2, cents / 1200);
}

function checkFreq(label, samples, sampleRate, expected, toleranceCents) {
  const result = detectPitch(samples, sampleRate);
  if (!result) {
    assert(false, label + " → no pitch (expected " + expected.toFixed(2) + " Hz)");
    return;
  }
  const cents = centsBetween(result.frequency, expected);
  const ok = Math.abs(cents) <= toleranceCents;
  assert(
    ok,
    label +
      " → " +
      result.frequency.toFixed(2) +
      " Hz (" +
      cents.toFixed(2) +
      " cent, clarity " +
      result.clarity.toFixed(3) +
      ", limit ±" +
      toleranceCents +
      ")"
  );
  if (ok) {
    console.log(
      "ok  " +
        label.padEnd(42) +
        result.frequency.toFixed(2).padStart(8) +
        " Hz  " +
        (cents >= 0 ? "+" : "") +
        cents.toFixed(2).padStart(6) +
        " cent"
    );
  }
}

const rates = [44100, 48000];
const length = 4096;
const detunes = [-35, -20, -10, -5, 0, 5, 10, 20, 35];

for (const sampleRate of rates) {
  for (const string of STRINGS) {
    checkFreq(
      "sine " + string.id + " @" + sampleRate,
      sine(string.freq, sampleRate, length),
      sampleRate,
      string.freq,
      1
    );
    checkFreq(
      "saw " + string.id + " @" + sampleRate,
      saw(string.freq, sampleRate, length),
      sampleRate,
      string.freq,
      2
    );
    for (const cents of detunes) {
      const freq = detune(string.freq, cents);
      const result = detectPitch(sine(freq, sampleRate, length), sampleRate);
      const label = "sine " + string.id + " " + (cents >= 0 ? "+" : "") + cents + " cent @" + sampleRate;
      if (!result) {
        assert(false, label + " → no pitch");
        continue;
      }
      const got = centsBetween(result.frequency, string.freq);
      const err = got - cents;
      const ok = Math.abs(err) <= 1.5;
      assert(ok, label + " → " + got.toFixed(2) + " cent (error " + err.toFixed(2) + ")");
      const match = closestString(result.frequency);
      assert(match.string.id === string.id, label + " mapped to " + match.string.id);
    }
    for (const cents of [-25, -10, 10, 25]) {
      const freq = detune(string.freq, cents);
      const result = detectPitch(saw(freq, sampleRate, length), sampleRate);
      const label = "saw " + string.id + " " + (cents >= 0 ? "+" : "") + cents + " cent @" + sampleRate;
      if (!result) {
        assert(false, label + " → no pitch");
        continue;
      }
      const got = centsBetween(result.frequency, string.freq);
      const err = got - cents;
      assert(Math.abs(err) <= 3, label + " → " + got.toFixed(2) + " cent (error " + err.toFixed(2) + ")");
      const match = closestString(result.frequency);
      assert(match.string.id === string.id, label + " mapped to " + match.string.id);
    }
  }

  for (const string of STRINGS) {
    checkFreq(
      "pluck " + string.id + " @" + sampleRate,
      harmonics(string.freq, sampleRate, length, [1, 0.55, 0.32, 0.2, 0.12, 0.08, 0.05]),
      sampleRate,
      string.freq,
      2
    );
    checkFreq(
      "no-fund " + string.id + " @" + sampleRate,
      harmonics(string.freq, sampleRate, length, [0, 1, 0.6, 0.35, 0.2]),
      sampleRate,
      string.freq,
      5
    );
    checkFreq(
      "weak-fund " + string.id + " @" + sampleRate,
      harmonics(string.freq, sampleRate, length, [0.18, 1, 0.55, 0.3, 0.18]),
      sampleRate,
      string.freq,
      4
    );
  }
}

function highpass(input, sampleRate, cutoff) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.SQRT1_2);
  let b0 = (1 + cos) / 2;
  let b1 = -(1 + cos);
  let b2 = (1 + cos) / 2;
  let a0 = 1 + alpha;
  let a1 = -2 * cos;
  let a2 = 1 - alpha;
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function pluckedString(freq, sampleRate, seconds, opts = {}) {
  const length = Math.floor(sampleRate * seconds);
  const out = new Float32Array(length);
  const B = opts.B ?? 0.0002;
  const nHarm = opts.nHarm ?? 24;
  const fund = opts.fund ?? 0.2;
  const slope = opts.slope ?? 0.8;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let n = 1; n <= nHarm; n++) {
      const fn = n * freq * Math.sqrt(1 + B * n * n);
      const amp = (n === 1 ? fund : 1) / Math.pow(n, slope);
      const env = Math.exp(-t * (opts.decay ?? 1.2) * (1 + (n - 1) * 0.4));
      s += amp * env * Math.sin((2 * Math.PI * fn * t));
    }
    out[i] = s;
  }
  return out;
}

function sliceAt(signal, sampleRate, startSec, size) {
  const start = Math.floor(startSec * sampleRate);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = signal[start + i] || 0;
  return out;
}

function scaleRms(input, rms) {
  let energy = 0;
  for (let i = 0; i < input.length; i++) energy += input[i] * input[i];
  const gain = rms / (Math.sqrt(energy / input.length) || 1);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * gain;
  return out;
}

for (const sampleRate of [48000]) {
  for (const string of STRINGS) {
    const stiff = string.midi <= 40 ? 0.00042 : string.midi <= 45 ? 0.0002 : string.midi <= 50 ? 0.00009 : 0.00003;
    let signal = pluckedString(string.freq, sampleRate, 1.4, {
      B: stiff,
      fund: string.midi < 50 ? 0.1 : 0.55,
      nHarm: string.midi < 52 ? 32 : 12,
      slope: string.midi < 50 ? 0.75 : 0.9
    });
    if (string.midi < 56) signal = highpass(highpass(signal, sampleRate, 120), sampleRate, 120);
    for (const when of [0.05, 0.35]) {
      checkFreq(
        "guitar " + string.id + " t=" + when,
        sliceAt(signal, sampleRate, when, length),
        sampleRate,
        string.freq,
        8
      );
      const heard = detectPitch(sliceAt(signal, sampleRate, when, length), sampleRate);
      assert(heard && closestString(heard.frequency).string.id === string.id, "guitar " + string.id + " string id");
    }
    const quietNote = scaleRms(sliceAt(signal, sampleRate, 0.45, length), 0.002);
    const quietHeard = detectPitch(quietNote, sampleRate);
    assert(
      quietHeard && Math.abs(centsBetween(quietHeard.frequency, string.freq)) < 12,
      "quiet guitar " + string.id + " should still register"
    );
  }
}

const harshHighE = pluckedString(STRINGS[5].freq, 48000, 0.8, {
  B: 0.00004,
  fund: 1,
  nHarm: 16,
  slope: 0.35,
  decay: 0.5
});
const harshSlice = sliceAt(harshHighE, 48000, 0.03, length);
const harsh = detectPitch(harshSlice, 48000);
assert(
  harsh && closestString(harsh.frequency).string.id === "E4" && Math.abs(centsBetween(harsh.frequency, STRINGS[5].freq)) < 8,
  "bright high E attack stays on E4 (" + (harsh ? harsh.frequency.toFixed(1) : "null") + ")"
);

const flatLowE = STRINGS[0].freq * Math.pow(2, -25 / 1200);
const flatSignal = highpass(pluckedString(flatLowE, 48000, 1, { B: 0.0004, fund: 0.15, nHarm: 30, slope: 0.75 }), 48000, 120);
const flatHeard = detectPitch(sliceAt(flatSignal, 48000, 0.08, length), 48000);
assert(
  flatHeard && Math.abs(centsBetween(flatHeard.frequency, flatLowE)) < 8 && closestString(flatHeard.frequency).string.id === "E2",
  "detuned low E stays on the low E string"
);

assert(detectPitch(new Float32Array(4096), 48000) === null, "silence should be null");
assert(detectPitch(noise(4096, 0.02), 48000) === null, "noise should be null");
assert(detectPitch(sine(110, 48000, 4096, 0.0007), 48000) === null, "very quiet sine should be null");

const quiet = detectPitch(sine(110, 48000, 4096, 0.004), 48000);
assert(quiet && Math.abs(centsBetween(quiet.frequency, 110)) < 2, "quiet mic-level A should detect");

const high = detectPitch(sine(1000, 48000, 4096), 48000);
assert(high === null, "1 kHz is outside guitar range");

assert(verdict(0) === "stemt", "0 cent is stemt");
assert(verdict(4.6) === "stemt", "rounding to 5 is stemt");
assert(verdict(-5) === "stemt", "-5 is stemt");
assert(verdict(5.6) === "for høyt", "rounding to 6 is for høyt");
assert(verdict(-6.4) === "for lavt", "rounding to -6 is for lavt");

const e2 = STRINGS[0].freq;
const match = closestString(e2);
assert(match.string.id === "E2" && Math.abs(match.cents) < 0.001, "E2 matches itself");

const t0 = process.hrtime.bigint();
const buffer = saw(82.41, 48000, 4096);
for (let i = 0; i < 30; i++) detectPitch(buffer, 48000);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 30;
console.log("\nAverage detectPitch: " + ms.toFixed(2) + " ms");
assert(ms < 25, "detection should stay interactive (" + ms.toFixed(2) + " ms)");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
