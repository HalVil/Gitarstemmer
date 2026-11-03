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

assert(detectPitch(new Float32Array(4096), 48000) === null, "silence should be null");
assert(detectPitch(noise(4096, 0.02), 48000) === null, "noise should be null");
assert(detectPitch(sine(110, 48000, 4096, 0.004), 48000) === null, "very quiet sine should be null");

const quiet = detectPitch(sine(110, 48000, 4096, 0.02), 48000);
assert(quiet && Math.abs(centsBetween(quiet.frequency, 110)) < 1.5, "quiet but audible A should detect");

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
