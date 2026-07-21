"use strict";
/* =============================================================================
   PLAYER — core  (engine, host, player, UI, variable panel, FPS)
   Runs on LOCAL audio files (no server, no network). Open the page directly
   (file://) and add files with the picker. Visuals live in js/visuals/*.js and
   self-register via Synesthesia.register({...}); add one by dropping in a file AND
   adding a <script> tag in player.html / recorder.html (no auto-injection).
   ========================================================================== */

/* ============================== CONFIG ============================== */
const CONFIG = {
  volumeDefault: 0.75,
  gapDefault: 3,
  maxDpr: 1.5,   // canvas render scale cap (lower = faster on hi-DPI screens)
  // audio analysis constants now live in js/lib/audio.js (Synesthesia.Audio.CONFIG)
};
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const fmt = s => { s = Math.max(0, s | 0); return (s / 60 | 0) + ":" + String(s % 60).padStart(2, "0"); };


/* ============================== PLAYLIST ============================== */
// Session-only list of picked local files. Not persisted: a browser can't re-open
// a local file by path after a reload, so the list is rebuilt each launch. Each
// track is { id, name, url } where url is an object URL for the picked File.
let playlist = [];
function saveLibrary() {}                     // no-op; kept so call sites don't change
function activeList() { return playlist; }
function uid() { return "t" + Math.random().toString(36).slice(2, 9); }

/* ============================== AUDIO ENGINE ============================== */
/* Realtime plumbing only. The analysis DSP lives in js/lib/audio.js (Synesthesia.Audio),
   shared with the offline render baker. Engine grabs the Analyser spectrum each
   frame, normalizes to raw[0..1], and hands it to Synesthesia.Audio.analyze(). */
const Engine = {
  ctx: null, analyser: null, gain: null, src: null, freq: null, el: null,
  raw: null, state: null,
  streaming: false, stream: null, streamSrc: null, muteSink: null,   // desktop-audio capture

  // build the context + analyser + output gain ONCE (independent of any audio source, so desktop
  // capture can work even before a file is loaded). analyser → gain → destination is the file
  // playback path; the analyser is where every source is tapped for the spectrum.
  ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = Synesthesia.Audio.N * 2;
    this.analyser.smoothingTimeConstant = 0.6;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = Player.volume;
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.waveByte = new Uint8Array(this.analyser.fftSize);   // time-domain, 0..255 (128 = zero)
    this.wave = new Float32Array(this.analyser.fftSize);      // normalized to -1..1
  },
  attach(el) {
    this.el = el; this.ensureCtx();
    // a media element can only be wrapped once — do it lazily and keep it
    if (!this.src) { this.src = this.ctx.createMediaElementSource(el); this.src.connect(this.analyser); }
  },
  resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); },
  setVolume(v) { if (this.gain) this.gain.gain.value = v; },

  // Capture live desktop / tab audio via getDisplayMedia and route it into the analyser. We do NOT
  // send it to the speakers (it's already audible from its source app) — a zero-gain sink keeps the
  // graph pulled so analysis runs without echo. Requires a user gesture + a secure context.
  async desktopAudio() {
    this.ensureCtx(); await this.resume();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { const e = new Error("unsupported"); e.name = "Unsupported"; throw e; }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) { stream.getTracks().forEach(t => t.stop()); const e = new Error("no-audio"); e.name = "NoAudio"; throw e; }
    // KEEP the video track alive: on Chrome, stopping it ends system/screen-audio capture (tab audio
    // survives — which is why tabs worked but system audio didn't). We just never render the video.
    if (this.src) this.src.disconnect();                       // file input off
    this.analyser.disconnect();                                // remove file playback (no echo)
    if (!this.muteSink) { this.muteSink = this.ctx.createGain(); this.muteSink.gain.value = 0; this.muteSink.connect(this.ctx.destination); }
    this.streamSrc = this.ctx.createMediaStreamSource(stream);
    this.streamSrc.connect(this.analyser); this.analyser.connect(this.muteSink);
    this.stream = stream; this.streaming = true;
    audioTracks[0].addEventListener("ended", () => this.stopDesktop());   // user hit the browser's "Stop sharing"
  },
  // revert from desktop capture back to the file playback graph
  stopDesktop() {
    if (!this.streaming) return;
    this.streaming = false;
    if (this.streamSrc) { try { this.streamSrc.disconnect(); } catch (e) {} this.streamSrc = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    try { this.analyser.disconnect(); } catch (e) {}
    this.analyser.connect(this.gain);                          // restore playback
    if (this.src) { try { this.src.connect(this.analyser); } catch (e) {} }
    if (typeof this.onDesktopEnd === "function") this.onDesktopEnd();
  },

  frame(t, dt) {
    // lazy-init so script load order (audio.js vs core.js) can't bite us
    if (!this.state) { this.state = Synesthesia.Audio.createState(); this.raw = new Float32Array(Synesthesia.Audio.N); }
    if (!this.wave) this.wave = new Float32Array(256);   // before any attach()
    const N = Synesthesia.Audio.N, raw = this.raw, wave = this.wave, WN = wave.length;
    if (this.analyser && (this.streaming || (this.el && !this.el.paused))) {
      this.analyser.getByteFrequencyData(this.freq);
      for (let i = 0; i < N; i++) raw[i] = this.freq[i] / 255;
      this.analyser.getByteTimeDomainData(this.waveByte);
      for (let i = 0; i < WN; i++) wave[i] = (this.waveByte[i] - 128) / 128;
    } else {
      // paused/stopped: feed zeros so the sim eases to neutral instead of freezing
      for (let i = 0; i < N; i++) raw[i] = 0;
      for (let i = 0; i < WN; i++) wave[i] = 0;
    }
    return Synesthesia.Audio.analyze(raw, this.state, t, dt, wave);
  }
};

/* ============================== VISUAL REGISTRY ============================== */
const VISUALS = [];
window.Synesthesia = { register(v) { VISUALS.push(v); } };

// per-visual parameter values, persisted
const VP_KEY = "synesthesiaVizParams";
let vizParams = (() => { try { return JSON.parse(localStorage.getItem(VP_KEY)) || {}; } catch (e) { return {}; } })();
function persistParams(v) { vizParams[v.id] = v.p; try { localStorage.setItem(VP_KEY, JSON.stringify(vizParams)); } catch (e) {} }

// per-visual MODULATORS (audio→param links), persisted separately from the static values
const VM_KEY = "synesthesiaVizMods";
let vizMods = (() => { try { return JSON.parse(localStorage.getItem(VM_KEY)) || {}; } catch (e) { return {}; } })();
function persistMods(v) {
  vizMods[v.id] = Synesthesia.Mod.serialize(v);
  try { localStorage.setItem(VM_KEY, JSON.stringify(vizMods)); } catch (e) {}
}

const Host = {
  wrap: null, canvas: null, dpr: 1, viz: null,
  init(wrap) { this.wrap = wrap; window.addEventListener("resize", () => this.resize()); },
  select(id) {
    const v = VISUALS.find(x => x.id === id) || VISUALS[0];
    if (!v) return;
    // init params (saved over defaults)
    v.p = {};
    const saved = vizParams[v.id] || {};
    (v.params || []).forEach(p => {
      if (!p.key) return;
      if (p.type === "cyclers") {
        v.p[p.key] = (saved[p.key] && saved[p.key].list)
          ? JSON.parse(JSON.stringify(saved[p.key]))                 // clone so it's instance-owned
          : Synesthesia.Color.defaultCyclers();
        return;
      }
      v.p[p.key] = (p.key in saved) ? saved[p.key] : p.default;
    });
    Synesthesia.Mod.hydrate(v, vizMods[v.id]);   // restore audio→param links
    if (this.viz && this.viz.unmount) this.viz.unmount();
    this.wrap.innerHTML = "";
    this.canvas = document.createElement("canvas");
    this.wrap.appendChild(this.canvas);
    this.resize();
    this.viz = v;
    v.mount({ canvas: this.canvas, dpr: this.dpr });
    renderPanel();
  },
  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
    this.canvas.width = Math.max(1, Math.floor(this.wrap.clientWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(this.wrap.clientHeight * this.dpr));
    if (this.viz && this.viz.resize) this.viz.resize(this.canvas.width, this.canvas.height);
  }
};

/* ============================== PLAYER ============================== */
let audio = null;
const Player = {
  volume: CONFIG.volumeDefault, gap: CONFIG.gapDefault,
  advance: "auto", order: "loop",
  cur: -1, playOrder: [], pos: -1, gapTimer: null,

  setVolume(v) { this.volume = v; if (audio) audio.volume = v; Engine.setVolume(v); },
  status(msg) { $("status").textContent = msg; },

  buildShuffle() {
    const n = activeList().length;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]]; }
    if (n > 1 && order[0] === this.cur) [order[0], order[1]] = [order[1], order[0]];
    this.playOrder = order; this.pos = -1;
  },

  loadIndex(i, autoplay) {
    const list = activeList();
    if (i < 0 || i >= list.length) return;
    this.cur = i; renderList();
    const track = list[i];
    Engine.attach(audio); Engine.resume();
    audio.src = track.url; audio.load();
    track.status = "ready"; renderList();
    this.status("Playing: " + track.name);
    if (autoplay) { audio.play().catch(() => {}); }
    updateTransport();
  },

  play() {
    if (Engine.streaming) Engine.stopDesktop();   // switching to a file leaves desktop-capture mode (onDesktopEnd restores the bar)
    if (this.cur < 0 && activeList().length) { this.loadIndex(0, true); return; }
    Engine.attach(audio); Engine.resume();
    if (audio.ended) audio.currentTime = 0;
    audio.play().catch(() => {}); updateTransport();
  },
  pause() { audio.pause(); updateTransport(); },
  stop() { audio.pause(); audio.currentTime = 0; updateTransport(); },
  rewind() { audio.currentTime = 0; },

  onEnded() {
    if (this.advance === "manual") { updateTransport(); return; }
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => this.advanceAuto(), this.gap * 1000);
    this.status(`Next track in ${this.gap}s…`);
  },
  advanceAuto() {
    const list = activeList();
    if (!list.length) return;
    if (this.order === "shuffle") {
      this.pos++;
      if (this.pos >= this.playOrder.length || this.playOrder.length !== list.length) { this.buildShuffle(); this.pos = 0; }
      this.loadIndex(this.playOrder[this.pos], true);
    } else if (this.order === "loop") {
      this.loadIndex((this.cur + 1) % list.length, true);
    } else {
      if (this.cur < list.length - 1) this.loadIndex(this.cur + 1, true);
      else { this.stop(); this.status("Reached end of list."); }
    }
  }
};

/* ============================== UI: lists ============================== */
function renderNowPlaying() {
  const el = $("nowplaying"); if (!el) return;
  const tr = Player.cur >= 0 ? activeList()[Player.cur] : null;
  const nameEl = el.querySelector(".np-name"), artistEl = el.querySelector(".np-artist");
  if (!tr) { el.classList.remove("has"); nameEl.textContent = ""; artistEl.textContent = ""; return; }
  nameEl.textContent = tr.name || "—"; artistEl.textContent = "";
  el.classList.add("has");
}
function renderList() {
  const ul = $("list"); ul.innerHTML = "";
  const list = activeList();
  list.forEach((tr, i) => {
    const li = document.createElement("li");
    li.className = "track" + (i === Player.cur ? " active" : "");
    li.draggable = true; li.dataset.i = i;
     const esc = s => String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const title = esc(tr.name || "—");
    li.innerHTML = `<span class="tnum">${i + 1}</span><span class="dot ${tr.status || "ready"}"></span>` +
                   `<span class="tmeta"><span class="tname">${title}</span></span>` +
                   `<button class="x" title="Remove">✕</button>`;
    li.addEventListener("click", e => { if (!e.target.classList.contains("x")) Player.loadIndex(i, true); });
    li.querySelector(".x").addEventListener("click", () => { list.splice(i, 1); if (Player.cur === i) Player.cur = -1; saveLibrary(); renderList(); });
    li.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", i); });
    li.addEventListener("dragover", e => { e.preventDefault(); li.classList.add("dragover"); });
    li.addEventListener("dragleave", () => li.classList.remove("dragover"));
    li.addEventListener("drop", e => {
      e.preventDefault(); li.classList.remove("dragover");
      const from = +e.dataTransfer.getData("text/plain"), to = i;
      if (from === to) return;
      const [m] = list.splice(from, 1); list.splice(to, 0, m);
      if (Player.cur === from) Player.cur = to;
      else if (from < Player.cur && to >= Player.cur) Player.cur--;
      else if (from > Player.cur && to <= Player.cur) Player.cur++;
      saveLibrary(); renderList();
    });
    ul.appendChild(li);
	  });
	renderNowPlaying();
  }
function renderVizSelect() {
  const sel = $("viz"); sel.innerHTML = "";
  VISUALS.forEach(v => { const o = document.createElement("option"); o.value = v.id; o.textContent = v.label; sel.appendChild(o); });
}

/* ============================== UI: variable panel ============================== */
// rows whose slider is (or may become) modulator-driven; the main loop refreshes
// their readout so you can watch a linked param move with the music.
let liveRows = [];
function renderPanel() {
  const v = Host.viz; const body = $("panelBody"); const title = $("panelTitle");
  if (!v) return;
  title.textContent = v.label;
  body.innerHTML = "";
  liveRows = [];
  const params = v.params || [];
  if (!params.length) { body.innerHTML = '<div class="empty">No adjustable variables.</div>'; return; }
  let container = body;   // group/cyclers headers redirect subsequent content into a collapsible section
  const collapsible = (label) => {
    const h = document.createElement("div");
    h.style.cssText = "cursor:pointer;font-weight:600;font-size:12px;color:var(--ink);padding:8px 2px 6px;border-top:1px solid var(--line);margin-top:6px;user-select:none;";
    const sec = document.createElement("div");   // open by default; click header to collapse
    const setLbl = () => { h.textContent = (sec.style.display === "none" ? "▸ " : "▾ ") + label; };
    h.addEventListener("click", () => { sec.style.display = sec.style.display === "none" ? "" : "none"; setLbl(); });
    setLbl(); body.appendChild(h); body.appendChild(sec); return sec;
  };
  params.forEach(p => {
    if (p.type === "cyclers") {
      const targets = (v.params || []).filter(q => q.type === "range")
        .map(q => ({ key: q.key, label: q.label || q.key, min: q.min, max: q.max, step: q.step }));
      Synesthesia.Color.renderEditor(collapsible("Cyclers"), v.p[p.key], targets, () => persistParams(v));
      container = body; return;
    }
    if (p.type === "group") { container = collapsible(p.label || ""); return; }
    const row = document.createElement("div"); row.className = "prow";
    const lab = document.createElement("label"); lab.textContent = p.label || p.key;
    row.appendChild(lab);
    if (p.type === "range") {
      const inp = document.createElement("input"); inp.type = "range";
      inp.min = p.min; inp.max = p.max; inp.step = p.step || 1; inp.value = v.p[p.key];
      const val = document.createElement("span"); val.className = "pval"; val.textContent = v.p[p.key];
      inp.addEventListener("input", e => { v.p[p.key] = +e.target.value; val.textContent = e.target.value; persistParams(v); });
      row.appendChild(inp); row.appendChild(val);

      // ⟳ toggles an audio→param modulator. Unlinked = plain manual slider (the default).
      const link = document.createElement("button");
      link.className = "mlink"; link.textContent = "⟳";
      link.title = "Link this parameter to the audio";
      const modHost = document.createElement("div"); modHost.className = "modhost";
      const syncLinked = () => {
        const on = !!(v.mods && v.mods[p.key]);
        link.classList.toggle("on", on);
        inp.disabled = on;                       // driven by the modulator now
        row.classList.toggle("linked", on);
        Synesthesia.Mod.renderParamMod(modHost, v, p, () => persistMods(v));
      };
      link.addEventListener("click", () => {
        v.mods = v.mods || {};
        if (v.mods[p.key]) { delete v.mods[p.key]; v.p[p.key] = p.default; inp.value = p.default; }
        else v.mods[p.key] = Synesthesia.Mod.create(p);
        if (v._modState) v._modState[p.key] = {};
        persistMods(v); syncLinked();
      });
      row.appendChild(link);
      row._live = { inp, val, key: p.key };      // main loop refreshes the readout while linked
      liveRows.push(row._live);
      container.appendChild(row); container.appendChild(modHost);
      syncLinked();
      return;
    } else if (p.type === "select") {
      const inp = document.createElement("select");
      p.options.forEach(o => { const op = document.createElement("option"); op.value = op.textContent = o; if (o === v.p[p.key]) op.selected = true; inp.appendChild(op); });
      inp.addEventListener("change", e => { v.p[p.key] = e.target.value; persistParams(v); });
      row.appendChild(inp);
    } else if (p.type === "checkbox") {
      const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!v.p[p.key];
      inp.addEventListener("change", e => { v.p[p.key] = e.target.checked; persistParams(v); });
      row.appendChild(inp);
    } else if (p.type === "color") {
      const inp = document.createElement("input"); inp.type = "color"; inp.value = v.p[p.key];
      inp.addEventListener("input", e => { v.p[p.key] = e.target.value; persistParams(v); });
      row.appendChild(inp);
    }
    container.appendChild(row);
  });
}

/* ---------------------------- audio-state indicator ----------------------------
   Silence is indistinguishable from a broken setup: a modulator with no signal pins
   its param to `min` and looks like it isn't working. So say so out loud — and say it
   louder when modulators are actually linked, since that's when it misleads. */
let silentMs = 0, audioStateKey = "";
function updateAudioState(frame) {
  const el = $("audioState"); if (!el) return;
  const lvl = Math.max(frame.energy || 0, frame.bass || 0, frame.mid || 0, frame.treble || 0);
  silentMs = lvl > 0.002 ? 0 : silentMs + (frame.dt || 16);
  const silent = silentMs > 500;                       // debounce: ignore momentary gaps
  const v = Host.viz;
  const nMods = (v && v.mods) ? Object.keys(v.mods).length : 0;
  const key = silent ? (nMods ? "warn" + nMods : "quiet") : "ok";
  if (key === audioStateKey) return;                   // only touch the DOM on a change
  audioStateKey = key;
  if (!silent) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle("warn", nMods > 0);
  if (nMods) {
    el.textContent = "no audio — " + nMods + " modulator" + (nMods > 1 ? "s" : "") + " idle";
    el.title = "No signal is reaching the analyser, so every linked parameter is being held at "
             + "its modulator's minimum. Start a track, or pick a desktop source.";
  } else {
    el.textContent = "no audio";
    el.title = "No signal is reaching the analyser.";
  }
}

// Live readout for modulator-driven sliders (only while the panel is visible).
function panelOpen() { const p = $("panel"); return p && p.classList.contains("open"); }
function refreshLiveRows() {
  const v = Host.viz; if (!v || !v.mods) return;
  for (let i = 0; i < liveRows.length; i++) {
    const r = liveRows[i];
    if (!v.mods[r.key]) continue;
    const cur = v.p[r.key];
    if (cur == null) continue;
    r.inp.value = cur;
    r.val.textContent = Math.abs(cur) >= 100 ? cur.toFixed(0) : cur.toFixed(2);
  }
}

/* ============================== UI: transport ============================== */
let seeking = false;
function updateTransport() { $("play").textContent = (audio.paused || audio.ended) ? "▶" : "⏸"; }
function updateSeekUI() {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $("time").textContent = fmt(c) + " / " + fmt(d);
  if (!seeking) $("seek").value = d ? (c / d * 1000) | 0 : 0;
}
function syncModeEnabled() {
  const manual = Player.advance === "manual";
  $("order").disabled = manual; $("gap").disabled = manual;
}
function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(f.name));
  if (!files.length) return;
  const wasEmpty = activeList().length === 0;
  files.forEach(f => activeList().push({ id: uid(), name: f.name, url: URL.createObjectURL(f), status: "ready" }));
  renderList();
  Player.status(`Added ${files.length} file${files.length > 1 ? "s" : ""}.`);
  if (wasEmpty) Player.loadIndex(0, false);   // cue the first track (don't autoplay)
}

/* ============================== FPS ============================== */
let fps = 60, fpsOn = false;

/* ============================== VISUAL PRESETS ============================== */
// Save/load the CURRENT visual's params (incl. cyclers) as a JSON file. Save
// downloads the file; Load reads one back via the file picker. Same {visual,label,
// params} format as the recorder, so presets interchange between the two.
function persistVizParams() { try { localStorage.setItem(VP_KEY, JSON.stringify(vizParams)); } catch (e) {} }
function persistVizMods() { try { localStorage.setItem(VM_KEY, JSON.stringify(vizMods)); } catch (e) {} }

function savePreset() {
  const v = Host.viz; if (!v) return;
  const stem = (v.label || v.id).replace(/[^\w.-]+/g, "") + "-preset";
  const name = prompt("Save preset as:", stem);
  if (name === null) return;
  const fn = /\.json$/i.test(name) ? name : name + ".json";
  // params = the static slider values; mods = the audio→param links. Both travel together.
  const data = JSON.stringify({ visual: v.id, label: v.label || v.id,
                                params: v.p, mods: Synesthesia.Mod.serialize(v) }, null, 2);
  const blob = new Blob([data], { type: "application/json" }), url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = fn; a.click(); URL.revokeObjectURL(url);
  Player.status("Downloaded " + fn);
}

function applyPresetObj(o, src) {
  const params = o && o.params ? o.params : (o && typeof o === "object" && !Array.isArray(o) ? o : null);
  if (!params) { Player.status("Load failed — not a valid preset."); return; }
  const id = (o.visual && VISUALS.find(x => x.id === o.visual)) ? o.visual : (Host.viz && Host.viz.id);
  if (!id) { Player.status("Preset's visual isn't available here."); return; }
  vizParams[id] = params; persistVizParams();           // Host.select rebuilds v.p from this
  vizMods[id] = (o && o.mods) || {}; persistVizMods();  // …and v.mods from this
  $("viz").value = id; Host.select(id);
  Player.status("Loaded preset" + (src ? " (" + src + ")" : "") + ".");
}

/* ============================== BOOT ============================== */
function boot() {
  audio = $("audio");
  Host.init($("vizwrap"));

  // transport
  $("play").addEventListener("click", () => (audio.paused || audio.ended) ? Player.play() : Player.pause());
  $("stop").addEventListener("click", () => Player.stop());
  $("prev").addEventListener("click", () => Player.rewind());

  // desktop / system audio capture (getDisplayMedia) → analyser
  const dab = $("desktopAudio");
  // entering/leaving desktop capture also swaps the transport out: with a live stream as the
  // source there is nothing to seek, pause or advance, so those controls just mislead.
  const setDesktopMode = on => { $("bar").classList.toggle("desktop", on); };
  Engine.onDesktopEnd = () => {
    dab.classList.remove("active"); dab.textContent = "🖥 Desktop";
    setDesktopMode(false); Player.status("Desktop audio stopped.");
  };
  if (dab) dab.addEventListener("click", async () => {
    if (Engine.streaming) { Engine.stopDesktop(); return; }
    try {
      Player.status("Requesting desktop audio — pick a source and tick 'Share audio'…");
      await Engine.desktopAudio();
      if (audio && !audio.paused) audio.pause();   // don't double up with a playing file
      dab.classList.add("active"); dab.textContent = "◉ Desktop";
      setDesktopMode(true);
      Player.status("Listening to desktop audio. Click again to stop.");
    } catch (e) {
      const n = e && e.name;
      Player.status(
        n === "NotAllowedError" ? "Desktop audio cancelled." :
        n === "NoAudio" ? "No audio was shared — re-open and tick 'Share system/tab audio' in the picker." :
        n === "NotReadableError" ? "Windows couldn't start the capture (another app may hold the screen/audio, or a driver won't share it). Try closing other screen-recorders/meeting apps, or share a single tab's audio instead." :
        n === "Unsupported" ? "This browser can't capture desktop audio (try Chrome or Edge)." :
        "Desktop audio failed (" + (n || (e && e.message)) + ").");
    }
  });
  $("vol").addEventListener("input", e => Player.setVolume(e.target.value / 100));
  $("seek").addEventListener("input", () => { seeking = true; });
  $("seek").addEventListener("change", e => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; seeking = false; });
  $("advance").addEventListener("change", e => { Player.advance = e.target.value; syncModeEnabled(); });
  $("order").addEventListener("change", e => { Player.order = e.target.value; if (Player.order === "shuffle") Player.buildShuffle(); });
  $("gap").addEventListener("change", e => { Player.gap = clamp(+e.target.value || 0, 0, 60); });
  $("viz").addEventListener("change", e => Host.select(e.target.value));

  // playlist — add local audio files
  $("addBtn").addEventListener("click", () => $("addFiles").click());
  $("addFiles").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });

  // panel + fps
  $("panelToggle").addEventListener("click", () => $("panel").classList.toggle("open"));
  $("panelClose").addEventListener("click", () => $("panel").classList.remove("open"));
  $("fpsToggle").addEventListener("change", e => { fpsOn = e.target.checked; $("fps").style.display = fpsOn ? "block" : "none"; });

  // visual presets — Save downloads a .json; Load reads one via the file picker
  $("presetSave").addEventListener("click", savePreset);
  $("presetFileBtn").addEventListener("click", () => $("presetFile").click());
  $("presetFile").addEventListener("change", e => {
    const f = e.target.files[0]; if (f) { const r = new FileReader(); r.onload = () => { try { applyPresetObj(JSON.parse(r.result), f.name); } catch (err) { Player.status("Import failed — not valid preset JSON."); } }; r.readAsText(f); }
    e.target.value = "";
  });

  // playlist show/hide — single gear toggle (overlay; canvas does not resize)
  $("sideToggle").addEventListener("click", () => $("side").classList.toggle("open"));

  // audio events
  audio.addEventListener("ended", () => Player.onEnded());
  audio.addEventListener("play", updateTransport);
  audio.addEventListener("pause", updateTransport);

  // initial render
  renderVizSelect(); renderList(); syncModeEnabled();
  $("vol").value = CONFIG.volumeDefault * 100; audio.volume = CONFIG.volumeDefault; Player.volume = CONFIG.volumeDefault;
  if (VISUALS.length) Host.select(VISUALS[0].id);

  // main loop
  let lastT = 0;
  function loop(t) {
    const dt = lastT ? Math.min(t - lastT, 100) : 16; lastT = t;
    const frame = Engine.frame(t, dt);
    if (Host.viz) {
      // modulators write into viz.p BEFORE the visual reads it — this is the whole
      // audio-reactive layer; the visual itself just sees plain param values.
      Synesthesia.Mod.apply(Host.viz, frame, Math.min(dt / 1000, 0.05));
      Host.viz.frame(frame);
      if (panelOpen()) refreshLiveRows();
    }
    updateAudioState(frame);
    updateSeekUI();
      if (fpsOn) {
      fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
      const stat = Host.viz && Host.viz.stat ? "  ·  " + Host.viz.stat : "";
      $("fps").textContent = fps.toFixed(0) + " fps" + stat;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
