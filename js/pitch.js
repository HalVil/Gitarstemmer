/* Guitar pitch detection.
   McLeod Pitch Method (normalized square difference) on a downsampled
   buffer, then a short full-rate refinement around the chosen period.
   Quiet or unclear audio returns null so the needle does not jitter. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.PitchDetector = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var A4 = 440;
  var IN_TUNE_CENTS = 5;
  var METER_CENTS = 50;

  function midiToFreq(midi) {
    return A4 * Math.pow(2, (midi - 69) / 12);
  }

  var STRINGS = [
    { id: "E2", name: "E", octave: 2, stringNumber: 6, midi: 40 },
    { id: "A2", name: "A", octave: 2, stringNumber: 5, midi: 45 },
    { id: "D3", name: "D", octave: 3, stringNumber: 4, midi: 50 },
    { id: "G3", name: "G", octave: 3, stringNumber: 3, midi: 55 },
    { id: "B3", name: "B", octave: 3, stringNumber: 2, midi: 59 },
    { id: "E4", name: "E", octave: 4, stringNumber: 1, midi: 64 }
  ].map(function (s) {
    return {
      id: s.id,
      name: s.name,
      octave: s.octave,
      stringNumber: s.stringNumber,
      midi: s.midi,
      freq: midiToFreq(s.midi)
    };
  });

  function centsBetween(freq, reference) {
    return 1200 * Math.log2(freq / reference);
  }

  function closestString(freq) {
    var best = null;
    var bestAbs = Infinity;
    for (var i = 0; i < STRINGS.length; i++) {
      var cents = centsBetween(freq, STRINGS[i].freq);
      var abs = Math.abs(cents);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = { index: i, string: STRINGS[i], cents: cents };
      }
    }
    return best;
  }

  function verdict(cents) {
    var shown = Math.round(cents);
    if (Math.abs(shown) <= IN_TUNE_CENTS) return "stemt";
    return shown < 0 ? "for lavt" : "for høyt";
  }

  function parabolicPeak(y0, ym1, yp1) {
    var denom = ym1 - 2 * y0 + yp1;
    if (denom === 0) return 0;
    var delta = (0.5 * (ym1 - yp1)) / denom;
    if (delta > 1 || delta < -1) return 0;
    return delta;
  }

  function decimate(samples, length, factor, mean) {
    var outLen = Math.floor(length / factor);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var sum = 0;
      var base = i * factor;
      for (var k = 0; k < factor; k++) sum += samples[base + k] - mean;
      out[i] = sum / factor;
    }
    return out;
  }

  /* NSDF over lags [0, maxTau]. Fixed correlation length keeps the
     estimate stable as the lag grows. */
  function computeNsdf(samples, maxTau) {
    var length = samples.length;
    var window = length - maxTau;
    var nsdf = new Float32Array(maxTau + 1);
    if (window < 32) return nsdf;
    for (var tau = 0; tau <= maxTau; tau++) {
      var ac = 0;
      var energy = 0;
      for (var j = 0; j < window; j++) {
        var a = samples[j];
        var b = samples[j + tau];
        ac += a * b;
        energy += a * a + b * b;
      }
      nsdf[tau] = energy > 0 ? (2 * ac) / energy : 0;
    }
    return nsdf;
  }

  function keyMaxima(nsdf, minTau, maxTau) {
    var peaks = [];
    var i = 1;
    var n = nsdf.length;
    while (i < n && i <= maxTau) {
      if (nsdf[i - 1] <= 0 && nsdf[i] > 0) {
        var maxIdx = i;
        var maxVal = nsdf[i];
        i++;
        while (i < n && i <= maxTau && nsdf[i] > 0) {
          if (nsdf[i] > maxVal) {
            maxVal = nsdf[i];
            maxIdx = i;
          }
          i++;
        }
        if (maxIdx >= minTau) peaks.push({ tau: maxIdx, value: maxVal });
      } else {
        i++;
      }
    }
    if (peaks.length === 0) {
      for (var t = minTau; t < maxTau && t + 1 < n; t++) {
        if (nsdf[t] > 0 && nsdf[t] >= nsdf[t - 1] && nsdf[t] >= nsdf[t + 1]) {
          peaks.push({ tau: t, value: nsdf[t] });
        }
      }
    }
    return peaks;
  }

  function pickPeak(peaks, cutoff) {
    var maxValue = 0;
    for (var i = 0; i < peaks.length; i++) {
      if (peaks[i].value > maxValue) maxValue = peaks[i].value;
    }
    var limit = maxValue * cutoff;
    for (var k = 0; k < peaks.length; k++) {
      if (peaks[k].value >= limit) return { peak: peaks[k], maxValue: maxValue };
    }
    return { peak: null, maxValue: maxValue };
  }

  /* If an early harmonic peak barely cleared the cutoff, prefer the
     later period when it is clearly a better match. A pure tone has
     nearly equal peaks at every multiple, so a small margin keeps it. */
  function preferFundamental(peaks, chosen) {
    var current = chosen;
    var moved = true;
    while (moved) {
      moved = false;
      for (var mult = 2; mult <= 3; mult++) {
        var target = current.tau * mult;
        var tolerance = Math.max(3, current.tau * 0.04);
        var alt = null;
        for (var i = 0; i < peaks.length; i++) {
          if (Math.abs(peaks[i].tau - target) <= tolerance) {
            if (!alt || peaks[i].value > alt.value) alt = peaks[i];
          }
        }
        if (alt && alt.value > current.value * 1.04) {
          current = alt;
          moved = true;
          break;
        }
      }
    }
    return current;
  }

  function refineFrequency(samples, length, mean, coarseFreq, sampleRate) {
    var tau0 = sampleRate / coarseFreq;
    var center = Math.round(tau0);
    var radius = 6;
    var start = Math.max(2, center - radius);
    var end = Math.min(length - 3, center + radius);
    if (end - start < 4) return coarseFreq;
    var window = Math.min(2048, length - end);
    if (window < 128) return coarseFreq;

    var bestTau = center;
    var bestVal = -Infinity;
    var values = new Float32Array(end + 2);
    for (var tau = start; tau <= end; tau++) {
      var ac = 0;
      var energy = 0;
      for (var j = 0; j < window; j++) {
        var a = samples[j] - mean;
        var b = samples[j + tau] - mean;
        ac += a * b;
        energy += a * a + b * b;
      }
      var nsdf = energy > 0 ? (2 * ac) / energy : 0;
      values[tau] = nsdf;
      if (nsdf > bestVal) {
        bestVal = nsdf;
        bestTau = tau;
      }
    }
    if (bestVal < 0.5) return coarseFreq;
    if (bestTau <= start || bestTau >= end) return sampleRate / bestTau;
    var better = bestTau + parabolicPeak(values[bestTau], values[bestTau - 1], values[bestTau + 1]);
    if (!(better > 1)) return coarseFreq;
    return sampleRate / better;
  }

  function detectPitch(samples, sampleRate, options) {
    options = options || {};
    if (!samples || samples.length < 512 || !(sampleRate > 0)) return null;

    var length = samples.length;
    var mean = 0;
    for (var i = 0; i < length; i++) mean += samples[i];
    mean /= length;

    var energy = 0;
    for (var n = 0; n < length; n++) {
      var d = samples[n] - mean;
      energy += d * d;
    }
    var rms = Math.sqrt(energy / length);
    var rmsThreshold = options.rmsThreshold != null ? options.rmsThreshold : 0.008;
    if (rms < rmsThreshold) return null;

    var minFreq = options.minFreq || 60;
    var maxFreq = options.maxFreq || 480;
    var clarityThreshold = options.clarityThreshold != null ? options.clarityThreshold : 0.78;
    var cutoff = options.cutoff != null ? options.cutoff : 0.9;

    var factor = options.factor != null ? options.factor : Math.max(1, Math.round(sampleRate / 16000));
    var decimated = factor > 1 ? decimate(samples, length, factor, mean) : null;
    var work;
    var rate;
    if (decimated) {
      work = decimated;
      rate = sampleRate / factor;
    } else {
      work = new Float32Array(length);
      for (var c = 0; c < length; c++) work[c] = samples[c] - mean;
      rate = sampleRate;
    }

    var maxTau = Math.min(work.length - 33, Math.ceil(rate / minFreq));
    var minTau = Math.max(2, Math.floor(rate / maxFreq));
    if (maxTau <= minTau + 2) return null;

    var nsdf = computeNsdf(work, maxTau);
    var peaks = keyMaxima(nsdf, minTau, maxTau);
    if (!peaks.length) return null;

    var picked = pickPeak(peaks, cutoff);
    if (!picked.peak || picked.maxValue < clarityThreshold) return null;

    /* A tone above the guitar range is still periodic at several of its
       cycles. Those longer lags fall inside the search window and look
       like a low note. A real guitar period is the shortest strong one,
       so a strong peak below minTau means the fundamental is too high. */
    var early = keyMaxima(nsdf, 2, minTau - 1);
    for (var e = 0; e < early.length; e++) {
      if (early[e].value >= picked.maxValue * 0.92) return null;
    }

    var chosen = preferFundamental(peaks, picked.peak);

    var y0 = nsdf[chosen.tau];
    var ym1 = nsdf[chosen.tau - 1];
    var yp1 = nsdf[chosen.tau + 1];
    var tau = chosen.tau + parabolicPeak(y0, ym1, yp1);
    var coarse = rate / tau;
    if (!(coarse > 0) || !isFinite(coarse)) return null;

    var frequency = refineFrequency(samples, length, mean, coarse, sampleRate);
    if (!(frequency >= minFreq && frequency <= maxFreq) || !isFinite(frequency)) return null;

    return {
      frequency: frequency,
      clarity: y0,
      rms: rms
    };
  }

  return {
    A4: A4,
    IN_TUNE_CENTS: IN_TUNE_CENTS,
    METER_CENTS: METER_CENTS,
    STRINGS: STRINGS,
    midiToFreq: midiToFreq,
    centsBetween: centsBetween,
    closestString: closestString,
    verdict: verdict,
    detectPitch: detectPitch
  };
});
