(function () {
  "use strict";

  var PD = window.PitchDetector;
  var STRINGS = PD.STRINGS;

  var app = document.getElementById("app");
  var noteEl = document.getElementById("note");
  var octaveEl = document.getElementById("octave");
  var centsEl = document.getElementById("cents");
  var statusEl = document.getElementById("status");
  var meter = document.getElementById("meter");
  var needle = document.getElementById("needle");
  var stringsEl = document.getElementById("strings");
  var hintEl = document.getElementById("hint");
  var messageEl = document.getElementById("message");
  var toneBtn = document.getElementById("tone");
  var startBtn = document.getElementById("start");
  var liveEl = document.getElementById("live");

  var audioContext = null;
  var stream = null;
  var source = null;
  var analyser = null;
  var raf = 0;
  var listening = false;
  var starting = false;
  var lockedIndex = null;
  var activeIndex = null;
  var lastFrequency = null;
  var heard = false;
  var suspendUntil = 0;
  var lastLoop = 0;
  var toneTimer = 0;
  var toneNode = null;
  var buffer = null;
  var byteBuffer = null;
  var announceKey = "";
  var smoother = createSmoother();

  renderStrings();
  setIdleCopy();

  startBtn.addEventListener("click", function () {
    if (listening) {
      stopListening();
      return;
    }
    if (starting) return;
    begin();
  });

  toneBtn.addEventListener("click", playReference);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (listening) resumeLoop();
  });

  document.body.addEventListener("pointerdown", function () {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
    }
  }, { passive: true });

  function renderStrings() {
    STRINGS.forEach(function (string, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "string";
      button.dataset.index = String(index);
      button.innerHTML =
        '<span class="s-note">' + string.name + "<sup>" + string.octave + "</sup></span>" +
        '<span class="s-num">' + string.stringNumber + "</span>";
      button.addEventListener("click", function () {
        toggleLock(index);
      });
      stringsEl.appendChild(button);
      labelString(button, string, false, false);
    });
  }

  function labelString(button, string, locked, active) {
    var label = string.name + "-streng, streng " + string.stringNumber;
    if (locked) label += ", låst";
    else if (active) label += ", valgt";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", locked ? "true" : "false");
  }

  function toggleLock(index) {
    lockedIndex = lockedIndex === index ? null : index;
    clearMessage();
    updateHint();
    if (listening && lastFrequency) {
      renderPitch({ frequency: lastFrequency });
      return;
    }
    centsEl.textContent = "\u00a0";
    if (lockedIndex != null) {
      paintNote(STRINGS[lockedIndex]);
      updateStringStyles(lockedIndex, false);
    } else {
      paintDash();
      updateStringStyles(-1, false);
      activeIndex = null;
    }
  }

  function updateHint() {
    if (lockedIndex != null) {
      hintEl.hidden = false;
      hintEl.textContent = "Låst på " + STRINGS[lockedIndex].name + " · trykk igjen for auto";
      return;
    }
    hintEl.hidden = true;
    hintEl.textContent = "";
  }

  function begin() {
    if (!window.isSecureContext) {
      showMessage("Mikrofonen krever en sikker tilkobling (HTTPS).");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !getAudioContext()) {
      showMessage("Denne nettleseren støtter ikke mikrofon. Prøv Chrome, Safari eller Firefox.");
      return;
    }

    var ctx = getAudioContext();
    ctx.resume();
    starting = true;
    startBtn.disabled = true;
    startBtn.textContent = "Venter …";
    clearMessage();

    getMic().then(function (mic) {
      stream = mic;
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);
      listening = true;
      starting = false;
      heard = false;
      lastFrequency = null;
      smoother.reset();
      startBtn.disabled = false;
      startBtn.textContent = "Stopp";
      startBtn.classList.add("is-live");
      startBtn.setAttribute("aria-pressed", "true");
      if (lockedIndex == null) {
        hintEl.hidden = true;
        hintEl.textContent = "";
      }
      setStatus("Lytter …");
      setAppState("listening");
      announce("lytter", "Lytter");
      resumeLoop();
    }).catch(function (err) {
      starting = false;
      startBtn.disabled = false;
      startBtn.textContent = "Start";
      startBtn.classList.remove("is-live");
      startBtn.setAttribute("aria-pressed", "false");
      showMessage(micErrorMessage(err));
    });
  }

  function getMic() {
    var attempts = [
      {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      },
      { audio: true }
    ];
    var chain = Promise.reject({ name: "Start" });
    attempts.forEach(function (constraints) {
      chain = chain.catch(function (err) {
        if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
          throw err;
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });
    });
    return chain;
  }

  function stopListening() {
    listening = false;
    starting = false;
    cancelAnimationFrame(raf);
    raf = 0;
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      stream = null;
    }
    if (source) {
      try { source.disconnect(); } catch (e) { /* already stopped */ }
      source = null;
    }
    analyser = null;
    buffer = null;
    smoother.reset();
    lastFrequency = null;
    heard = false;
    activeIndex = lockedIndex;
    startBtn.disabled = false;
    startBtn.textContent = "Start";
    startBtn.classList.remove("is-live");
    startBtn.setAttribute("aria-pressed", "false");
    setIdleCopy();
  }

  function resumeLoop() {
    if (!listening) return;
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
    lastLoop = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function loop(timestamp) {
    raf = requestAnimationFrame(loop);
    if (!listening || !analyser) return;
    if (timestamp - lastLoop < 48) return;
    lastLoop = timestamp;
    if (performance.now() < suspendUntil) return;
    var result = PD.detectPitch(readSamples(), audioContext.sampleRate);
    renderPitch(smoother.push(result));
  }

  function readSamples() {
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buffer);
      return buffer;
    }
    if (!byteBuffer || byteBuffer.length !== analyser.fftSize) {
      byteBuffer = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(byteBuffer);
    for (var i = 0; i < byteBuffer.length; i++) {
      buffer[i] = (byteBuffer[i] - 128) / 128;
    }
    return buffer;
  }

  function renderPitch(stable) {
    if (!stable) {
      lastFrequency = null;
      centsEl.textContent = "\u00a0";
      setStatus(heard ? "Spill en streng" : "Lytter …");
      setAppState("listening");
      meter.setAttribute("aria-valuenow", "0");
      meter.setAttribute("aria-valuetext", "ingen tone");
      if (lockedIndex != null) {
        paintNote(STRINGS[lockedIndex]);
        updateStringStyles(lockedIndex, false);
      } else {
        paintDash();
        activeIndex = null;
        updateStringStyles(-1, false);
      }
      announce(heard ? "vent" : "lytter", heard ? "Spill en streng" : "Lytter");
      return;
    }

    heard = true;
    lastFrequency = stable.frequency;
    updateHint();
    var match = PD.closestString(stable.frequency);
    var index = lockedIndex != null ? lockedIndex : match.index;
    var target = STRINGS[index];
    var cents = PD.centsBetween(stable.frequency, target.freq);
    var word = PD.verdict(cents);
    activeIndex = index;

    paintNote(target);
    centsEl.textContent = formatCents(cents);
    setStatus(word);
    setAppState(word === "stemt" ? "tuned" : word === "for lavt" ? "flat" : "sharp");
    moveNeedle(cents);
    updateStringStyles(index, word === "stemt");

    var shown = Math.round(cents);
    var sentence = word === "stemt"
      ? target.name + "-streng, stemt"
      : target.name + "-streng, " + Math.abs(shown) + " cent " + word;
    announce(target.id + ":" + word + ":" + Math.round(shown / 3), sentence);
  }

  function paintNote(string) {
    noteEl.textContent = string.name;
    noteEl.classList.add("has-note");
    octaveEl.hidden = false;
    octaveEl.textContent = String(string.octave);
  }

  function paintDash() {
    noteEl.textContent = "–";
    noteEl.classList.remove("has-note");
    octaveEl.hidden = true;
    octaveEl.textContent = "";
  }

  function moveNeedle(cents) {
    var span = PD.METER_CENTS;
    var clamped = Math.max(-span, Math.min(span, cents));
    var percent = ((clamped + span) / (span * 2)) * 100;
    needle.style.left = percent + "%";
    meter.setAttribute("aria-valuenow", String(Math.round(clamped)));
    meter.setAttribute("aria-valuetext", formatCents(cents));
  }

  function updateStringStyles(active, tuned) {
    var buttons = stringsEl.querySelectorAll(".string");
    for (var i = 0; i < buttons.length; i++) {
      var on = i === active;
      var locked = i === lockedIndex;
      buttons[i].classList.toggle("is-on", on || locked);
      buttons[i].classList.toggle("is-locked", locked);
      buttons[i].classList.toggle("is-tuned", on && tuned);
      labelString(buttons[i], STRINGS[i], locked, on && !locked);
    }
  }

  function setIdleCopy() {
    setAppState("idle");
    setStatus("Trykk Start og spill en streng.");
    centsEl.textContent = "\u00a0";
    meter.setAttribute("aria-valuenow", "0");
    meter.setAttribute("aria-valuetext", "ingen tone");
    needle.style.left = "50%";
    if (lockedIndex != null) {
      paintNote(STRINGS[lockedIndex]);
      updateStringStyles(lockedIndex, false);
    } else {
      paintDash();
      updateStringStyles(-1, false);
    }
    announce("idle", "Trykk Start og spill en streng");
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setAppState(name) {
    app.classList.remove("is-idle", "is-listening", "is-flat", "is-sharp", "is-tuned");
    app.classList.add("is-" + name);
  }

  function formatCents(cents) {
    var shown = Math.round(cents);
    if (shown === 0) return "0 cent";
    return (shown > 0 ? "+" : "−") + Math.abs(shown) + " cent";
  }

  function playReference() {
    var index = lockedIndex != null ? lockedIndex : activeIndex;
    if (index == null) {
      hintEl.hidden = false;
      hintEl.textContent = "Trykk på en streng først.";
      return;
    }
    var ctx = getAudioContext();
    if (!ctx) {
      showMessage("Kunne ikke spille lyd i denne nettleseren.");
      return;
    }
    ctx.resume();
    if (lockedIndex == null) updateHint();
    var string = STRINGS[index];
    suspendUntil = performance.now() + 1700;
    if (toneNode) {
      try { toneNode.stop(); } catch (e) { /* already ended */ }
    }
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = string.freq;
    var now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.3);
    toneNode = osc;
    toneBtn.textContent = "Spiller " + string.name + " …";
    clearTimeout(toneTimer);
    toneTimer = setTimeout(function () {
      toneBtn.textContent = "Spill tone";
    }, 1300);
  }

  function getAudioContext() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioContext) audioContext = new AudioCtx();
    return audioContext;
  }

  function showMessage(text) {
    messageEl.hidden = false;
    messageEl.textContent = text;
  }

  function clearMessage() {
    messageEl.hidden = true;
    messageEl.textContent = "";
  }

  function micErrorMessage(err) {
    var name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      return "Fikk ikke tilgang til mikrofonen. Tillat mikrofon i nettleseren og prøv igjen.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "Fant ingen mikrofon.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "Mikrofonen er opptatt eller utilgjengelig.";
    }
    return "Kunne ikke starte mikrofonen. Prøv igjen.";
  }

  function announce(key, text) {
    if (key === announceKey) return;
    announceKey = key;
    liveEl.textContent = text;
  }

  function createSmoother() {
    var history = [];
    var misses = 0;
    var pending = null;
    var pendingCount = 0;

    function median() {
      if (!history.length) return null;
      var sorted = history.slice().sort(function (a, b) { return a - b; });
      return sorted[sorted.length >> 1];
    }

    return {
      reset: function () {
        history = [];
        misses = 0;
        pending = null;
        pendingCount = 0;
      },
      push: function (result) {
        if (!result || !(result.frequency > 0)) {
          misses += 1;
          pending = null;
          pendingCount = 0;
          if (misses >= 8) {
            history = [];
            return null;
          }
          var held = median();
          return held == null ? null : { frequency: held, held: true };
        }

        misses = 0;
        var freq = result.frequency;
        var current = median();
        if (current != null && Math.abs(1200 * Math.log2(freq / current)) > 70) {
          if (pending != null && Math.abs(1200 * Math.log2(freq / pending)) < 25) {
            pendingCount += 1;
          } else {
            pending = freq;
            pendingCount = 1;
          }
          if (pendingCount >= 2) {
            history = [freq];
            pending = null;
            pendingCount = 0;
            return { frequency: freq, clarity: result.clarity };
          }
          return { frequency: current, held: true };
        }

        pending = null;
        pendingCount = 0;
        history.push(freq);
        if (history.length > 5) history.shift();
        return { frequency: median(), clarity: result.clarity };
      }
    };
  }
})();
