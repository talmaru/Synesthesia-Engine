"use strict";
/* Synesthesia.Baker — OFFLINE audio analysis for the render pipeline.

   The live player gets `raw` from a Web Audio AnalyserNode. Offline there's no
   AnalyserNode, so the baker reproduces that chain itself over decoded PCM:

       256-sample window -> Blackman -> FFT -> |mag|/N -> smooth(tau)
                         -> dB over [minDb,maxDb] -> byte/255  =  raw[0..128]

   then hands raw to the SAME Synesthesia.Audio.analyze(). So the only thing that differs
   between live and rendered is who fills `raw`; the DSP (bins, flux, beat, bands)
   is identical. Load AFTER audio.js.

   Pure except for two browser-only helpers (decode/toMono) clearly marked below.
   Everything the headless test exercises (FFT, rawAt, bake) takes plain PCM in. */

(function () {
  const A = (window.Synesthesia = window.Synesthesia || {});
  const N = 128;          // output bins (must match Synesthesia.Audio.N)
  const FS = N * 2;       // fftSize — same as live (analyser.fftSize = N*2 = 256)

  // --- Blackman window (Blink convention: 2*pi*n/FS), precomputed once ---
  const WIN = new Float32Array(FS);
  for (let n = 0; n < FS; n++) {
    WIN[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / FS) + 0.08 * Math.cos((4 * Math.PI * n) / FS);
  }

  // --- iterative radix-2 Cooley-Tukey FFT, in place (re/im length FS, power of 2) ---
  // precompute bit-reversal + twiddles for FS
  const REV = new Uint16Array(FS);
  for (let i = 0; i < FS; i++) {
    let x = i, r = 0;
    for (let b = 1; b < FS; b <<= 1) { r = (r << 1) | (x & 1); x >>= 1; }
    REV[i] = r;
  }
  function fft(re, im) {
    for (let i = 0; i < FS; i++) {
      const j = REV[i];
      if (j > i) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= FS; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < FS; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // --- baker state: holds PCM, timing, and the per-bin smoothing carry ---
  // opts: { fps, sampleRate, minDb=-100, maxDb=-30, smoothing=0.6, gain=1 }
  function create(pcm, sampleRate, opts) {
    opts = opts || {};
    return {
      pcm, sampleRate,
      fps: opts.fps || 60,
      minDb: opts.minDb != null ? opts.minDb : -100,
      maxDb: opts.maxDb != null ? opts.maxDb : -30,
      smoothing: opts.smoothing != null ? opts.smoothing : 0.6,
      gain: opts.gain != null ? opts.gain : 1,
      smooth: new Float32Array(N),   // temporal magnitude carry (the AnalyserNode's smoothing)
      _re: new Float32Array(FS),
      _im: new Float32Array(FS),
      _raw: new Float32Array(N),
      _wave: new Float32Array(FS),   // time-domain window (matches live analyser.fftSize = FS)
      totalFrames: Math.floor((pcm.length / sampleRate) * (opts.fps || 60)),
    };
  }

  // produce raw[0..1] for output frame f (causal: window ENDS at f's audio time, like live).
  // mutates state.smooth; must be called in increasing f for the smoothing to match live.
  function rawAt(state, f) {
    const re = state._re, im = state._im, raw = state._raw, pcm = state.pcm;
    const sampleEnd = Math.round((f * state.sampleRate) / state.fps);
    const start = sampleEnd - FS;
    for (let n = 0; n < FS; n++) {
      const idx = start + n;
      const s = (idx >= 0 && idx < pcm.length) ? pcm[idx] : 0;
      re[n] = s * WIN[n]; im[n] = 0;
    }
    fft(re, im);
    const range = state.maxDb - state.minDb, tau = state.smoothing, g = state.gain;
    for (let k = 0; k < N; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / FS;
      state.smooth[k] = tau * state.smooth[k] + (1 - tau) * mag;
      const db = 20 * Math.log10((state.smooth[k] * g) || 1e-12);
      let v = (db - state.minDb) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const byte = Math.floor(255 * v);          // match getByteFrequencyData quantization
      raw[k] = (byte > 255 ? 255 : byte) / 255;
    }
    return raw;
  }

  // produce the raw time-domain window for output frame f (causal, same window end as rawAt,
  // UN-windowed). Mirrors the live AnalyserNode's getByteTimeDomainData for oscilloscope visuals.
  function waveAt(state, f) {
    const wave = state._wave, pcm = state.pcm;
    const sampleEnd = Math.round((f * state.sampleRate) / state.fps);
    const start = sampleEnd - FS;
    for (let n = 0; n < FS; n++) {
      const idx = start + n;
      wave[n] = (idx >= 0 && idx < pcm.length) ? pcm[idx] : 0;
    }
    return wave;
  }

  // bake a full control track: array of cloned `a` frames (raw/bins cloned so they don't
  // all alias analyze()'s scratch). Streaming render can skip this and call rawAt+analyze
  // per frame instead; this is for testing, lookahead, or caching.
  function bake(pcm, sampleRate, opts) {
    const Audio = A.Audio;
    if (!Audio) throw new Error("Synesthesia.Audio not loaded — load audio.js before baker.js");
    const st = create(pcm, sampleRate, opts);
    const aState = Audio.createState();
    const dt = 1000 / st.fps;
    const frames = [];
    for (let f = 0; f < st.totalFrames; f++) {
      const raw = rawAt(st, f);
      const wave = waveAt(st, f);
      const a = Audio.analyze(raw, aState, f * dt, dt, wave);
      frames.push({
        raw: Float32Array.from(a.raw), wave: Float32Array.from(a.wave), bins: Float32Array.from(a.bins),
        bass: a.bass, mid: a.mid, treble: a.treble, energy: a.energy,
        beat: a.beat, flux: a.flux, bpm: a.bpm, dt: a.dt,
      });
    }
    return { frames, totalFrames: st.totalFrames, fps: st.fps };
  }

  // ---- browser-only helpers (not headless-tested; need real Web Audio) ----

  // decode a File/ArrayBuffer to an AudioBuffer
  async function decode(arrayBuffer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try { return await ctx.decodeAudioData(arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer); }
    finally { if (ctx.close) ctx.close(); }
  }

  // mix an AudioBuffer down to a single mono Float32Array
  function toMono(audioBuffer) {
    const ch = audioBuffer.numberOfChannels, len = audioBuffer.length;
    if (ch === 1) return audioBuffer.getChannelData(0).slice();
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i];
    }
    const inv = 1 / ch;
    for (let i = 0; i < len; i++) out[i] *= inv;
    return out;
  }

  A.Baker = { N, FS, create, rawAt, waveAt, bake, decode, toMono, fft, WIN };
})();
