"use strict";
/* Synesthesia.Audio — the analysis DSP, extracted from core.js so the live player and the
   offline render baker share ONE analyzer (no drift between what you see and what
   you render). Mirrors Synesthesia.GL: a classic-script global, load it BEFORE core.js.

   This module is pure: no AudioContext, no AnalyserNode, no DOM. It turns a
   normalized magnitude spectrum into the per-frame `a` object the visuals consume.

   THE SEAM is `raw`: a Float32Array of N bins in 0..1.
     - live  (core.js):  analyser.getByteFrequencyData(freq) -> freq[i]/255
     - offline (baker):  its own FFT over PCM windows, normalized the same way
   Both call the same analyze(); the only difference is who fills `raw`.

   STATE is explicit and caller-owned (createState()). Live keeps one; the baker
   keeps its own. That's the whole reason this can run offline: nothing hides in
   engine instance variables anymore. */

(function () {
  const A = (window.Synesthesia = window.Synesthesia || {});

  const CONFIG = {
    N: 128,
    bassBins: 12, midBins: [12, 40], trebleBins: [40, 128],
    attack: 0.45, release: 0.10, gain: 1.0,
    bpmDefault: 120,
    beatThreshold: 1.8, beatFloor: 0.006, beatRefractory: 100, bpmSmoothing: 0.04,
    fluxWindow: 60,   // frames of spectral-flux history for the adaptive (median) threshold
  };
  const N = CONFIG.N;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // a fresh, isolated analysis state. Live owns one; the baker owns its own.
  function createState() {
    return {
      bins: new Float32Array(N),     // smoothed spectrum (attack/release)
      prevSpec: new Float32Array(N), // previous raw, for spectral flux
      fluxHist: [],                  // recent flux for the median threshold
      lastBeat: -1e9,
      iois: [],                      // inter-onset intervals -> bpm
      bpm: CONFIG.bpmDefault,
      beatThresh: 0,                 // current adaptive threshold (diagnostics)
    };
  }

  // adaptive median-flux beat/tempo detector. Mutates state; returns whether `now` is a beat.
  // The median (not mean) threshold is robust to loud sections: a running mean gets dragged
  // up so soft hits afterward fall under it; the median ignores those outliers.
  function updateTempo(state, flux, now) {
    state.fluxHist.push(flux);
    if (state.fluxHist.length > CONFIG.fluxWindow) state.fluxHist.shift();
    const sorted = state.fluxHist.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] || 0;
    state.beatThresh = median * CONFIG.beatThreshold;

    const isBeat = flux > state.beatThresh &&
                   flux > CONFIG.beatFloor && (now - state.lastBeat) > CONFIG.beatRefractory;
    if (!isBeat) return false;
    const ioi = now - state.lastBeat; state.lastBeat = now;
    if (ioi > 300 && ioi < 1500) {
      state.iois.push(ioi); if (state.iois.length > 12) state.iois.shift();
      const s = state.iois.slice().sort((a, b) => a - b);
      let c = 60000 / s[s.length >> 1];
      while (c < 70) c *= 2; while (c > 180) c /= 2;
      state.bpm += (c - state.bpm) * CONFIG.bpmSmoothing;
    }
    return true;
  }

  // PURE analysis. `raw` = normalized magnitude spectrum (Float32Array N, 0..1), caller-owned.
  // `state` from createState(). `t` = monotonic ms (live: rAF time; offline: frameIndex*1000/fps).
  // Returns the frame object the visuals read — identical shape to the old Engine.frame().
  // `wave` (optional): time-domain samples in ~[-1,1] for oscilloscope-style visuals.
  // Live fills it from the AnalyserNode; the baker from its PCM window; forwarded as-is.
  function analyze(raw, state, t, dt, wave) {
    const bins = state.bins, prevSpec = state.prevSpec;

    // attack/release smoothing toward the incoming spectrum
    for (let i = 0; i < N; i++) {
      const tv = raw[i];
      bins[i] += (tv - bins[i]) * (tv > bins[i] ? CONFIG.attack : CONFIG.release);
    }

    // spectral flux: total positive frame-to-frame change (band-agnostic onset). Decays ignored.
    let flux = 0;
    for (let i = 0; i < N; i++) {
      const d = raw[i] - prevSpec[i];
      if (d > 0) flux += d;
      prevSpec[i] = raw[i];
    }
    flux /= N;
    const beat = updateTempo(state, flux, t);

    const avg = (lo, hi) => { let s = 0; for (let i = lo; i < hi; i++) s += bins[i]; return s / (hi - lo); };
    const bass = clamp(avg(0, CONFIG.bassBins) * CONFIG.gain, 0, 1);
    const mid = clamp(avg(CONFIG.midBins[0], CONFIG.midBins[1]) * CONFIG.gain, 0, 1);
    const treble = clamp(avg(CONFIG.trebleBins[0], CONFIG.trebleBins[1]) * CONFIG.gain, 0, 1);
    let energy = 0; for (let i = 0; i < N; i++) energy += bins[i];
    energy = clamp(energy / N * CONFIG.gain * 2.2, 0, 1);

    return { raw, wave: wave || null, bins, bass, mid, treble, energy, beat, flux, bpm: state.bpm, dt };
  }

  A.Audio = { CONFIG, N, createState, analyze, updateTempo };
})();
