"use strict";
/* Synesthesia.Color — parameter cyclers (a small modulation matrix) shared by all visuals.

   A CYCLER is a single scalar generator: name, mode, timing, speed, phase, source. Each
   frame it emits w in 0..1. You attach TARGETS to it — specific range-params of the visual —
   and each target maps w into its own [min,max]. So a cycler only affects the params you add
   to it; several params on one cycler move in lockstep. Anything unattached keeps its slider
   value. Colour is just ordinary params (e.g. orbs_h / orbs_s / orbs_v) you can attach.

   mode: sine | triangle | ramp | audio.  audio = w follows the cycler's `src` (bass/mid/
   treble/energy/beat), so "brighter as the song gets energetic" = attach orbs_v to an audio/
   energy cycler with min .3 max 1. `beat` is a decaying envelope maintained here.
   Audio mode extras: `gate` (ignore input below it, then renormalize) and `spring`+`damp`
   (the value chases its target on a damped spring — springy overshoot instead of snapping).
   The editor shows only the controls relevant to the current mode.

   Cycler: { id, name, mode, timing:"beat"|"time", spd, phase, src, gate, spring, damp,
             targets:[{key,min,max}] }
   Blob (lives inside the visual's params under `cyclers`, so it persists + saves in presets):
     { seq, list:[cycler,…] }

   API:
     Synesthesia.Color.defaultCyclers()                          -> fresh blob (1 empty cycler)
     Synesthesia.Color.resolve(store, baseParams, a)             -> effective params (base + driven)
     Synesthesia.Color.renderEditor(container, data, targets, onChange)  -> add/remove UI
     Synesthesia.Color.hsv(h,s,v)                                -> [r,g,b]
   `store` is a caller-owned {} (per-cycler phase carry + beat env). `a` is the audio frame.
   `targets` = [{key,label,min,max,step}] the params a cycler may drive.

   Load as a classic <script> BEFORE the visuals (alongside audio.js / gl.js).            */

(function () {
  const C = (window.Synesthesia = window.Synesthesia || {});
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const MODES = ["sine", "triangle", "ramp", "audio"];
  const SRCS  = ["none", "bass", "mid", "treble", "energy", "beat"];
  const SPRING_K = 300;   // max spring stiffness (spring param 0..1 scales this)

  function hsv(h, s, v) {
    h = (((h % 360) + 360) % 360) / 60;
    const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
    let r, g, b;
    if (h < 1)      { r = c; g = x; b = 0; }
    else if (h < 2) { r = x; g = c; b = 0; }
    else if (h < 3) { r = 0; g = c; b = x; }
    else if (h < 4) { r = 0; g = x; b = c; }
    else if (h < 5) { r = x; g = 0; b = c; }
    else            { r = c; g = 0; b = x; }
    return [r + m, g + m, b + m];
  }

  function defaultCycler(id, name) {
    return { id, name, mode: "sine", timing: "beat", spd: 0.1, phase: 0, src: "none",
             gate: 0, spring: 0, damp: 0.7, targets: [] };
  }
  function defaultCyclers() { return { seq: 1, list: [defaultCycler("c1", "Cycler 1")] }; }

  function wave(mode, ph) {
    const fr = ph - Math.floor(ph);
    if (mode === "ramp") return fr;
    if (mode === "triangle") return fr < 0.5 ? fr * 2 : 2 - fr * 2;
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);   // sine
  }

  // one cycler's output w in 0..1 this frame (advances phase carry in `store`)
  function cyclerW(store, cyc, audio, dt, bpm) {
    if (cyc.mode === "audio") {
      let a = clamp((cyc.src && audio[cyc.src]) || 0, 0, 1);
      const g = cyc.gate || 0;
      if (g > 0) a = clamp((a - g) / Math.max(1e-3, 1 - g), 0, 1);   // lower gate, then renormalize
      const s = cyc.spring || 0;
      if (s > 0) {                                                    // springy chase toward the gated value
        const k = s * SPRING_K, c = 2 * (cyc.damp != null ? cyc.damp : 0.7) * Math.sqrt(k);
        const pk = cyc.id + "_sp", vk = cyc.id + "_sv";
        let pos = store[pk] != null ? store[pk] : a, vel = store[vk] || 0;
        vel += (k * (a - pos) - c * vel) * dt;                        // semi-implicit Euler (stable)
        pos = clamp(pos + vel * dt, -0.5, 1.5);
        store[pk] = pos; store[vk] = vel;
        return pos;
      }
      return a;
    }
    const dCyc = cyc.timing === "time" ? cyc.spd * dt : cyc.spd * dt * (bpm / 60);
    const raw = (store[cyc.id] || 0) + dCyc; store[cyc.id] = raw;
    return wave(cyc.mode, raw + (cyc.phase || 0));
  }

  // effective params for this frame: a shallow copy of base with each cycler's targets driven.
  // Returns base unchanged if the visual has no cyclers blob.
  function resolve(store, base, a) {
    const data = base && base.cyclers;
    const dt = Math.min((a.dt || 16.7) / 1000, 0.05), bpm = a.bpm || 120;
    store._beat = Math.max(a.beat ? 1 : 0, (store._beat || 0) * Math.exp(-dt * 6));
    const audio = { bass: a.bass, mid: a.mid, treble: a.treble, energy: a.energy, beat: store._beat };
    if (!data || !data.list || !data.list.length) return base;
    const eff = Object.assign({}, base);
    data.list.forEach(cyc => {
      const w = cyclerW(store, cyc, audio, dt, bpm);
      (cyc.targets || []).forEach(t => { eff[t.key] = t.min + (t.max - t.min) * w; });
    });
    return eff;
  }

  /* ------------------------------ editor ------------------------------ */
  const HEAD = "display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;color:var(--ink,#dfe7f5);padding:8px 2px 6px;border-top:1px solid var(--line,#1d2333);margin-top:6px;user-select:none";
  const SUB  = "font-size:11px;color:var(--dim,#8893ab);margin:6px 0 2px";

  function row(label) {
    const r = document.createElement("div"); r.className = "prow";
    const l = document.createElement("label"); l.textContent = label; r.appendChild(l);
    return r;
  }
  function rangeRow(label, obj, key, mn, mx, st, cb) {
    const r = row(label), i = document.createElement("input"); i.type = "range";
    i.min = mn; i.max = mx; i.step = st || (mx - mn) / 100 || 0.01; i.value = obj[key];
    const val = document.createElement("span"); val.className = "pval"; val.textContent = obj[key];
    i.addEventListener("input", e => { obj[key] = +e.target.value; val.textContent = e.target.value; cb && cb(); });
    r.appendChild(i); r.appendChild(val); return r;
  }
  function selRow(label, obj, key, opts, cb) {
    const r = row(label), s = document.createElement("select");
    opts.forEach(o => { const op = document.createElement("option"); op.value = op.textContent = o; if (o === String(obj[key])) op.selected = true; s.appendChild(op); });
    s.addEventListener("change", e => { obj[key] = e.target.value; cb && cb(); });
    r.appendChild(s); return r;
  }
  function textRow(label, obj, key, cb) {
    const r = row(label), i = document.createElement("input"); i.type = "text"; i.value = obj[key]; i.style.flex = "1";
    i.addEventListener("change", e => { obj[key] = e.target.value; cb && cb(); });
    r.appendChild(i); return r;
  }

  function renderEditor(container, data, targets, onChange) {
    const tmap = {}; (targets || []).forEach(t => { tmap[t.key] = t; });
    const open = new Set();
    const commit = (rebuild) => { onChange && onChange(); if (rebuild) build(); };

    function build() {
      container.innerHTML = "";
      data.list.forEach(cyc => {
        const head = document.createElement("div"); head.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 2px";
        const tog = document.createElement("span"); tog.style.cssText = "flex:1;cursor:pointer;font-size:12px";
        tog.textContent = (open.has(cyc.id) ? "▾ " : "▸ ") + cyc.name;
        tog.onclick = () => { open.has(cyc.id) ? open.delete(cyc.id) : open.add(cyc.id); build(); };
        head.appendChild(tog);
        if (data.list.length > 1) {
          const rm = document.createElement("button"); rm.className = "x"; rm.textContent = "✕"; rm.title = "Remove cycler";
          rm.onclick = () => { data.list.splice(data.list.indexOf(cyc), 1); commit(true); };
          head.appendChild(rm);
        }
        container.appendChild(head);

        if (open.has(cyc.id)) {
          const body = document.createElement("div"); body.style.paddingLeft = "6px";
          body.appendChild(textRow("Name", cyc, "name", () => commit(true)));
          body.appendChild(selRow("Mode", cyc, "mode", MODES, () => commit(true)));   // rebuild to swap controls
          if (cyc.mode === "audio") {
            body.appendChild(selRow("Source", cyc, "src", SRCS, () => commit(false)));
            body.appendChild(rangeRow("Gate", cyc, "gate", 0, 0.95, 0.02, () => commit(false)));
            body.appendChild(rangeRow("Spring", cyc, "spring", 0, 1, 0.02, () => commit(false)));
            body.appendChild(rangeRow("Damping", cyc, "damp", 0, 1, 0.02, () => commit(false)));
          } else {
            body.appendChild(selRow("Timing", cyc, "timing", ["beat", "time"], () => commit(false)));
            body.appendChild(rangeRow("Speed", cyc, "spd", 0, 2, 0.005, () => commit(false)));
            body.appendChild(rangeRow("Phase", cyc, "phase", 0, 1, 0.01, () => commit(false)));
          }

          const tl = document.createElement("div"); tl.textContent = "Targets"; tl.style.cssText = SUB; body.appendChild(tl);
          (cyc.targets || []).forEach((tg, idx) => {
            const info = tmap[tg.key] || { label: tg.key, min: 0, max: 1, step: 0.01 };
            const hr = document.createElement("div"); hr.style.cssText = "display:flex;align-items:center;gap:6px;margin:6px 0 2px";
            const nm = document.createElement("span"); nm.textContent = info.label; nm.style.cssText = "flex:1;font-size:12px";
            const rm = document.createElement("button"); rm.className = "x"; rm.textContent = "✕"; rm.title = "Detach";
            rm.onclick = () => { cyc.targets.splice(idx, 1); commit(true); };
            hr.appendChild(nm); hr.appendChild(rm); body.appendChild(hr);
            body.appendChild(rangeRow("min", tg, "min", info.min, info.max, info.step, () => commit(false)));
            body.appendChild(rangeRow("max", tg, "max", info.min, info.max, info.step, () => commit(false)));
          });

          if (targets && targets.length) {
            const ar = document.createElement("div"); ar.className = "prow";
            const sel = document.createElement("select");
            targets.forEach(t => { const o = document.createElement("option"); o.value = t.key; o.textContent = t.label; sel.appendChild(o); });
            const add = document.createElement("button"); add.textContent = "+ target";
            add.onclick = () => { const info = tmap[sel.value]; if (!info) return; (cyc.targets = cyc.targets || []).push({ key: sel.value, min: info.min, max: info.max }); commit(true); };
            ar.appendChild(sel); ar.appendChild(add); body.appendChild(ar);
          }
          container.appendChild(body);
        }
      });

      const add = document.createElement("button"); add.textContent = "+ Add cycler"; add.style.marginTop = "6px";
      add.onclick = () => { data.seq = (data.seq || data.list.length) + 1; const id = "c" + data.seq; data.list.push(defaultCycler(id, "Cycler " + data.seq)); open.add(id); commit(true); };
      container.appendChild(add);
    }
    build();
  }

  C.Color = { hsv, MODES, SRCS, defaultCyclers, resolve, renderEditor };
})();
