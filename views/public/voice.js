(() => {
  const socket = io();

  const startBtn = document.getElementById("startbtn");
  const stopBtn = document.getElementById("stopbtn");
  const modeSelect = document.getElementById("inputMode");
  const output = document.getElementById("output");
  const canvas = document.getElementById("audioVisualizer");
  const ctx = canvas.getContext("2d");

  const VISUAL = {
    barCount: 96,              // total bars (mirrored)
    maxBarHeightRatio: 0.48,   // smaller bars
    minBarHeight: 2,
    gap: 2,
    riseLerp: 0.24,            // fast rise
    fallLerp: 0.08,            // slow fall for smoothness
    peakDrop: 0.01,            // peak marker drop speed
  };

  const state = {
    running: false,
    audioContext: null,
    analyser: null,
    rafId: null,
    displayStream: null,
    micStream: null,
    sources: [],
    dataArray: null,
    smoothBars: null,
    peaks: null,
    gradient: null,
    glowGradient: null,
    recognition: null,
    hasSpeechApi: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  };

  function log(line) {
    output.textContent += `\n${line}`;
    output.scrollTop = output.scrollHeight;
  }

  function setUiRunning(running) {
    state.running = running;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    modeSelect.disabled = running;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.gradient = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
    state.gradient.addColorStop(0, "#ff2b72");
    state.gradient.addColorStop(0.5, "#ffd2e4");
    state.gradient.addColorStop(1, "#35e9ff");

    state.glowGradient = ctx.createRadialGradient(
      window.innerWidth / 2,
      window.innerHeight * 0.9,
      20,
      window.innerWidth / 2,
      window.innerHeight * 0.9,
      Math.max(window.innerWidth, window.innerHeight) * 0.7
    );
    state.glowGradient.addColorStop(0, "rgba(53,233,255,0.18)");
    state.glowGradient.addColorStop(1, "rgba(53,233,255,0)");
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  async function getStreams(mode) {
    let displayStream = null;
    let micStream = null;

    if (mode === "system" || mode === "both") {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      if (!displayStream.getAudioTracks().length) {
        throw new Error("No system audio track detected. Re-share and enable audio.");
      }
    }

    if (mode === "mic" || mode === "both") {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          latency: 0,
        },
      });
    }

    return { displayStream, micStream };
  }

  function setupAudioGraph(displayStream, micStream) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });

    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.82; // base smoothing at analyser-level

    state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);

    const half = Math.floor(VISUAL.barCount / 2);
    state.smoothBars = new Float32Array(half);
    state.peaks = new Float32Array(half);

    state.sources = [];

    if (displayStream?.getAudioTracks().length) {
      const src = state.audioContext.createMediaStreamSource(displayStream);
      src.connect(state.analyser);
      state.sources.push(src);
    }

    if (micStream?.getAudioTracks().length) {
      const src = state.audioContext.createMediaStreamSource(micStream);
      src.connect(state.analyser);
      state.sources.push(src);
    }
  }

  function drawRoundedRect(x, y, w, h, r = 3) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    state.rafId = requestAnimationFrame(draw);
    if (!state.analyser || !state.dataArray) return;

    state.analyser.getByteFrequencyData(state.dataArray);

    // soft fade for smoother motion trail
    ctx.fillStyle = "rgba(7, 11, 23, 0.28)";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    if (state.glowGradient) {
      ctx.fillStyle = state.glowGradient;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    const halfBars = Math.floor(VISUAL.barCount / 2);
    const centerX = window.innerWidth / 2;
    const barWidth = window.innerWidth / VISUAL.barCount;
    const drawWidth = Math.max(2, barWidth - VISUAL.gap);
    const maxBarHeight = window.innerHeight * VISUAL.maxBarHeightRatio;
    const baseY = window.innerHeight * 0.92;

    ctx.fillStyle = state.gradient;
    ctx.shadowBlur = 14;
    ctx.shadowColor = "rgba(53,233,255,0.35)";

    for (let i = 0; i < halfBars; i++) {
      // bias to low frequencies for better visual balance
      const t = i / Math.max(1, halfBars - 1);
      const idx = Math.floor((t * t) * (state.dataArray.length - 1));
      const raw = state.dataArray[idx] / 255;

      // gentle bass boost + gamma curve
      const boosted = Math.min(1, raw * (1.05 + (1 - t) * 0.28));
      const target = Math.pow(boosted, 1.25);

      const prev = state.smoothBars[i];
      const lerp = target > prev ? VISUAL.riseLerp : VISUAL.fallLerp;
      const smooth = prev + (target - prev) * lerp;
      state.smoothBars[i] = smooth;

      state.peaks[i] = Math.max(smooth, state.peaks[i] - VISUAL.peakDrop);

      const h = Math.max(VISUAL.minBarHeight, smooth * maxBarHeight);
      const y = baseY - h;
      const xL = centerX - (i + 1) * barWidth;
      const xR = centerX + i * barWidth;

      drawRoundedRect(xL, y, drawWidth, h, 3);
      drawRoundedRect(xR, y, drawWidth, h, 3);

      // tiny peak marker
      const peakY = baseY - Math.max(VISUAL.minBarHeight, state.peaks[i] * maxBarHeight) - 3;
      ctx.fillRect(xL, peakY, drawWidth, 2);
      ctx.fillRect(xR, peakY, drawWidth, 2);
    }

    ctx.shadowBlur = 0;
  }

  function setupRecognition() {
    if (!state.hasSpeechApi) {
      log("SpeechRecognition API not supported in this browser.");
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SR();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.lang = "en-US";

    state.recognition.onresult = (event) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += `${phrase} `;
      }
      finalText = finalText.trim();
      if (finalText) {
        log(`You: ${finalText}`);
        socket.emit("voiceCommand", finalText);
      }
    };

    state.recognition.onerror = (e) => {
      log(`Speech error: ${e.error}`);
    };
  }

  async function start() {
    if (state.running) return;

    try {
      output.textContent = "Starting...";
      const mode = modeSelect.value;

      const { displayStream, micStream } = await getStreams(mode);
      state.displayStream = displayStream;
      state.micStream = micStream;

      setupAudioGraph(displayStream, micStream);
      draw();
      setupRecognition();

      if (state.recognition && (mode === "mic" || mode === "both")) {
        state.recognition.start();
      }

      const displayVideoTrack = state.displayStream?.getVideoTracks()?.[0];
      if (displayVideoTrack) displayVideoTrack.onended = stop;

      output.textContent = "Running.";
      log(`Capture mode: ${mode}`);
      setUiRunning(true);
    } catch (err) {
      console.error(err);
      output.textContent = `Start failed: ${err.message || err}`;
      await stop();
    }
  }

  async function stop() {
    if (!state.running && !state.audioContext && !state.displayStream && !state.micStream) return;

    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;

    if (state.recognition) {
      try { state.recognition.stop(); } catch {}
    }

    for (const src of state.sources) {
      try { src.disconnect(); } catch {}
    }
    state.sources = [];

    if (state.displayStream) {
      state.displayStream.getTracks().forEach((t) => t.stop());
      state.displayStream = null;
    }

    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }

    if (state.audioContext) {
      await state.audioContext.close();
      state.audioContext = null;
    }

    state.analyser = null;
    state.dataArray = null;
    state.smoothBars = null;
    state.peaks = null;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    output.textContent = "Stopped.";
    setUiRunning(false);
  }

  socket.on("response", (message) => {
    log(`Assistant: ${message}`);
  });

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", stop);
})();