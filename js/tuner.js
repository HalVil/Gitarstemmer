(function () {
  "use strict";

  var PD = window.PitchDetector;
  var STRINGS = PD.STRINGS;

  var app = document.getElementById("app");
  var noteEl = document.getElementById("note");
  var octaveEl = document.getElementById("octave");
  var whichEl = document.getElementById("which");
  var centsEl = document.getElementById("cents");
  var statusEl = document.getElementById("status");
  var meter = document.getElementById("meter");
  var needle = document.getElementById("needle");
  var stringsEl = document.getElementById("strings");
  var hintEl = document.getElementById("hint");
  var messageEl = document.getElementById("message");
  var toneBtn = document.getElementById("tone");
  var lockBtn = document.getElementById("lock");
  var startBtn = document.getElementById("start");
  var liveEl = document.getElementById("live");

  var audioContext = null;
  var stream = null;
  var source = null;
  var analyser = null;
  var raf = 0;
  var listening = false;
  var starting = false;
  var referenceOn = false;
  var lockMode = false;
  var lockedIndex = null;
  var soundingIndex = null;
  var activeIndex = null;
  var lastFrequency = null;
  var heard = false;
  var lastLoop = 0;
  var toneOsc = null;
  var toneGain = null;
  var buffer = null;
  var byteBuffer = null;
  var announceKey = "";
  var tunedFor = [0, 0, 0, 0, 0, 0];
  var outFor = [0, 0, 0, 0, 0, 0];
  var done = [false, false, false, false, false, false];
  var lastTick = 0;
  var smoother = createSmoother();

  renderStrings();
  updateChrome();
  setIdleCopy();

  startBtn.addEventListener("click", function () {
    if (listening) {
      stopListening();
      return;
    }
    if (starting) return;
    begin();
  });

  toneBtn.addEventListener("click", function () {
    referenceOn = !referenceOn;
    if (referenceOn) {
      lockMode = false;
      lockedIndex = null;
      var ctx = getAudioContext();
      if (ctx) ctx.resume();
    } else {
      stopTone();
    }
    clearMessage();
    updateChrome();
  });

  lockBtn.addEventListener("click", function () {
    lockMode = !lockMode;
    if (lockMode) {
      referenceOn = false;
      stopTone();
    } else {
      lockedIndex = null;
    }
    clearMessage();
    updateChrome();
    if (listening && lastFrequency) renderPitch({ frequency: lastFrequency });
    else if (!listening) setIdleCopy();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    if (listening) resumeLoop();
  });

  document.body.addEventListener("pointerdown", function () {
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
  }, { passive: true });

  function stringName(string) {
    if (string.id === "E2") return "Lav E";
    if (string.id === "E4") return "Høy E";
    return string.name + "-streng";
  }

  function renderStrings() {
    STRINGS.forEach(function (string, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "string";
      button.dataset.index = String(index);
      button.innerHTML =
        '<span class="s-check" hidden>✓</span>' +
        '<span class="s-note">' + string.name + "<sup>" + string.octave + "</sup></span>" +
        '<span class="s-num">' + string.stringNumber + "</span>";
      button.addEventListener("click", function () {
        onString(index);
      });
      stringsEl.appendChild(button);
    });
  }

  function onString(index) {
    if (referenceOn) {
      soundString(index);
      return;
    }
    if (!lockMode) return;
    lockedIndex = lockedIndex === index ? null : index;
    clearMessage();
    updateChrome();
    if (listening && lastFrequency) renderPitch({ frequency: lastFrequency });
    else if (lockedIndex != null) {
      paintNote(STRINGS[lockedIndex]);
      whichEl.textContent = stringName(STRINGS[lockedIndex]);
    } else {
      paintDash();
      whichEl.textContent = "";
    }
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
      setStatus(referenceOn && soundingIndex != null ? "Referansetone" : "Lytter …");
      if (!(referenceOn && soundingIndex != null)) setAppState("listening");
      announce("lytter", "Lytter. Spill en streng.");
      updateChrome();
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

  function denied(err) {
    return err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
  }

  function rawMic(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  /* Exact false/1 constraints make some browsers throw and fall back to
     processed audio. ideal:false keeps echo cancellation, noise suppression
     and auto gain off without failing the request. */
  function getMic() {
    var clean = {
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 }
    };
    return rawMic({ audio: clean }).catch(function (err) {
      if (denied(err)) throw err;
      var retry = {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false }
      };
      return rawMic({ audio: retry });
    }).then(function (mic) {
      var track = mic.getAudioTracks()[0];
      if (!track || !track.applyConstraints) return mic;
      return track.applyConstraints({
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false }
      }).catch(function () { /* already as clean as the device allows */ }).then(function () {
        return mic;
      });
    });
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
    tunedFor = [0, 0, 0, 0, 0, 0];
    outFor = [0, 0, 0, 0, 0, 0];
    done = [false, false, false, false, false, false];
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
    if (timestamp - lastLoop < 40) return;
    lastLoop = timestamp;
    if (referenceOn && soundingIndex != null) return;
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
      lastTick = 0;
      centsEl.textContent = "\u00a0";
      setStatus(heard ? "Spill en streng" : "Lytter …");
      setAppState("listening");
      meter.setAttribute("aria-valuenow", "0");
      meter.setAttribute("aria-valuetext", "ingen tone");
      if (lockedIndex != null) {
        paintNote(STRINGS[lockedIndex]);
        whichEl.textContent = stringName(STRINGS[lockedIndex]);
        activeIndex = lockedIndex;
      } else {
        paintDash();
        whichEl.textContent = "";
        activeIndex = null;
      }
      updateChrome();
      announce(heard ? "vent" : "lytter", heard ? "Spill en streng" : "Lytter");
      return;
    }

    heard = true;
    lastFrequency = stable.frequency;
    var match = PD.closestString(stable.frequency);
    var index = lockedIndex != null ? lockedIndex : match.index;
    var target = STRINGS[index];
    var cents = PD.centsBetween(stable.frequency, target.freq);
    var word = PD.verdict(cents);
    activeIndex = index;
    trackTune(index, cents);

    paintNote(target);
    whichEl.textContent = stringName(target);
    centsEl.textContent = formatCents(cents);
    setStatus(word);
    setAppState(word === "stemt" ? "tuned" : word === "for lavt" ? "flat" : "sharp");
    moveNeedle(cents);
    updateChrome();

    var shown = Math.round(cents);
    var sentence = word === "stemt"
      ? stringName(target) + ", stemt"
      : stringName(target) + ", " + Math.abs(shown) + " cent " + word;
    announce(target.id + ":" + word + ":" + Math.round(shown / 3), sentence);
  }

  function trackTune(index, cents) {
    var now = performance.now();
    var dt = lastTick ? Math.min(160, now - lastTick) : 45;
    lastTick = now;
    var shown = Math.round(cents);
    if (Math.abs(shown) <= PD.IN_TUNE_CENTS) {
      tunedFor[index] += dt;
      outFor[index] = 0;
      if (!done[index] && tunedFor[index] >= 850) {
        done[index] = true;
        announce("ferdig-" + index, stringName(STRINGS[index]) + " er stemt");
      }
    } else if (Math.abs(shown) > 12) {
      tunedFor[index] = 0;
      outFor[index] += dt;
      if (outFor[index] > 400) done[index] = false;
    }
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
      var on = i === active && !(referenceOn && soundingIndex != null);
      var locked = lockMode && i === lockedIndex;
      var sounding = referenceOn && i === soundingIndex;
      buttons[i].classList.toggle("is-on", on || locked);
      buttons[i].classList.toggle("is-locked", locked);
      buttons[i].classList.toggle("is-tuned", on && tuned);
      buttons[i].classList.toggle("is-done", done[i]);
      buttons[i].classList.toggle("is-sounding", sounding);
      var mark = buttons[i].querySelector(".s-check");
      if (mark) mark.hidden = !done[i];
      var label = stringName(STRINGS[i]) + ", streng " + STRINGS[i].stringNumber;
      if (done[i]) label += ", stemt";
      if (sounding) label += ", spiller";
      else if (locked) label += ", låst";
      else if (on) label += ", valgt";
      buttons[i].setAttribute("aria-label", label);
      buttons[i].setAttribute("aria-pressed", locked || sounding ? "true" : "false");
    }
  }

  function updateChrome() {
    toneBtn.setAttribute("aria-pressed", referenceOn ? "true" : "false");
    toneBtn.classList.toggle("is-on", referenceOn);
    toneBtn.textContent = referenceOn ? "Referansetone på" : "Referansetone";
    lockBtn.setAttribute("aria-pressed", lockMode ? "true" : "false");
    lockBtn.classList.toggle("is-on", lockMode);
    lockBtn.textContent = lockMode ? "Lås på" : "Lås streng";
    stringsEl.classList.toggle("is-playable", referenceOn);
    stringsEl.classList.toggle("is-lockable", lockMode && !referenceOn);
    app.classList.toggle("is-reference", referenceOn);

    if (referenceOn) {
      hintEl.hidden = false;
      hintEl.textContent = soundingIndex == null
        ? "Trykk en streng"
        : "Spiller " + stringName(STRINGS[soundingIndex]);
      if (soundingIndex != null && !listening) {
        paintNote(STRINGS[soundingIndex]);
        whichEl.textContent = stringName(STRINGS[soundingIndex]);
        setStatus("Referansetone");
      }
    } else if (lockMode) {
      hintEl.hidden = false;
      hintEl.textContent = lockedIndex == null
        ? "Trykk strengen du vil stemme"
        : "Låst på " + stringName(STRINGS[lockedIndex]);
    } else {
      hintEl.hidden = true;
      hintEl.textContent = "";
    }

    var tuned = app.classList.contains("is-tuned");
    var shownActive = referenceOn && soundingIndex != null ? soundingIndex : activeIndex;
    updateStringStyles(shownActive == null ? -1 : shownActive, tuned);
  }

  function setIdleCopy() {
    setAppState("idle");
    centsEl.textContent = "\u00a0";
    meter.setAttribute("aria-valuenow", "0");
    meter.setAttribute("aria-valuetext", "ingen tone");
    needle.style.left = "50%";
    if (referenceOn && soundingIndex != null) {
      paintNote(STRINGS[soundingIndex]);
      whichEl.textContent = stringName(STRINGS[soundingIndex]);
      setStatus("Referansetone");
    } else if (lockedIndex != null) {
      paintNote(STRINGS[lockedIndex]);
      whichEl.textContent = stringName(STRINGS[lockedIndex]);
      setStatus("Trykk Start og spill strengene.");
    } else {
      paintDash();
      whichEl.textContent = "";
      setStatus("Trykk Start og spill strengene.");
    }
    updateChrome();
    announce("idle", "Trykk Start og spill strengene");
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

  function soundString(index) {
    var ctx = getAudioContext();
    if (!ctx) {
      showMessage("Kunne ikke spille lyd i denne nettleseren.");
      return;
    }
    ctx.resume();
    if (!toneOsc) {
      toneOsc = ctx.createOscillator();
      toneGain = ctx.createGain();
      toneOsc.type = "triangle";
      toneGain.gain.value = 0.0001;
      toneOsc.connect(toneGain);
      toneGain.connect(ctx.destination);
      toneOsc.start();
    }
    var now = ctx.currentTime;
    toneOsc.frequency.cancelScheduledValues(now);
    toneOsc.frequency.setTargetAtTime(STRINGS[index].freq, now, 0.012);
    toneGain.gain.cancelScheduledValues(now);
    toneGain.gain.setTargetAtTime(0.1, now, 0.02);
    soundingIndex = index;
    activeIndex = index;
    centsEl.textContent = "\u00a0";
    needle.style.left = "50%";
    paintNote(STRINGS[index]);
    whichEl.textContent = stringName(STRINGS[index]);
    setStatus("Referansetone");
    setAppState(listening ? "listening" : "idle");
    updateChrome();
  }

  function stopTone() {
    soundingIndex = null;
    if (!toneOsc) return;
    var now = audioContext ? audioContext.currentTime : 0;
    try {
      toneGain.gain.cancelScheduledValues(now);
      toneGain.gain.setTargetAtTime(0.0001, now, 0.015);
      var osc = toneOsc;
      osc.stop(now + 0.06);
    } catch (e) { /* already stopped */ }
    toneOsc = null;
    toneGain = null;
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
          if (misses >= 12) {
            history = [];
            return null;
          }
          var held = median();
          return held == null ? null : { frequency: held, held: true };
        }

        misses = 0;
        var freq = result.frequency;
        var current = median();
        if (current != null) {
          var jump = Math.abs(1200 * Math.log2(freq / current));
          if (jump > 70) {
            var needed = jump > 1000 ? 3 : 2;
            if (pending != null && Math.abs(1200 * Math.log2(freq / pending)) < 25) pendingCount += 1;
            else {
              pending = freq;
              pendingCount = 1;
            }
            if (pendingCount >= needed) {
              history = [freq];
              pending = null;
              pendingCount = 0;
              return { frequency: freq, clarity: result.clarity };
            }
            return { frequency: current, held: true };
          }
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
