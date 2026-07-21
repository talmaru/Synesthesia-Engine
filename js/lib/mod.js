"use strict";
/* =============================================================================
   MODULATORS — the audio-reactive control layer.

   A visual declares plain params (registerWrappable-style `params: [{key,min,max,…}]`).
   By default every param is an ordinary slider: unlinked, manual, static.

   Attaching a modulator to a param makes it audio-reactive. A modulator is:

       source  →  [optional ops]  →  range

   `source`  one audio band (optionally blended with a second), a beat envelope,
             or a free-running cycler. Always produces 0..1.
   `ops`     an ordered stack applied to that 0..1 signal. Usually empty.
   `range`   min..max — the param values the 0..1 signal maps onto. Always present.

   Presets are just {params, mods} JSON — see Mod.serialize / Mod.hydrate.
   ========================================================================== */
(function () {
  const S = (window.Synesthesia = window.Synesthesia || {});
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  /* ---------------------------------------------------------------- sources */
  // Each returns 0..1. `st` is the per-param scratch state, `a` the audio frame,
  // `dt` seconds. Bands come straight off the analysis frame.
  const SOURCES = {
    none:     { label: "— none —" },
    bass:     { label: "Bass",     read: (m, st, a) => a.bass || 0 },
    mid:      { label: "Mid",      read: (m, st, a) => a.mid || 0 },
    treble:   { label: "Treble",   read: (m, st, a) => a.treble || 0 },
    energy:   { label: "Energy",   read: (m, st, a) => a.energy || 0 },
    centroid: { label: "Centroid", read: (m, st, a) => {
      // spectral centroid — "brightness" of the mix, 0..1 across the 128 bins
      if (!a.bins) return 0;
      let sum = 0, wsum = 0;
      for (let i = 0; i < 128; i++) { sum += a.bins[i]; wsum += i * a.bins[i]; }
      return sum > 1e-4 ? (wsum / sum) / 128 : 0;
    } },
    // beat is a boolean impulse — turn it into a decaying envelope so it can drive
    // a continuous param ("flash on the beat"). decay = seconds to fall to zero.
    beat: { label: "Beat (envelope)", decay: true, read: (m, st, a, dt) => {
      if (a.beat) st.env = 1;
      const d = Math.max(m.decay != null ? m.decay : 0.35, 0.02);
      st.env = Math.max(0, (st.env || 0) - dt / d);
      return st.env;
    } },
    // Free-running oscillator. Two cyclers at the same speed stay LOCKED to each other because
    // the phase is SEEDED from a clock shared by the whole visual — so one you attach later is
    // already in step with one that has been running for a minute, and `phase` (0..1 of a cycle)
    // is a meaningful, stable offset between them. After seeding it accumulates locally, so
    // changing `speed` alters the rate from now on instead of rewriting where the cycle is.
    cycler: { label: "Cycler (LFO)", cycler: true, phase: true, read: (m, st, a, dt, clocks) => {
      const spd = m.speed != null ? m.speed : 0.25;
      const beats = m.timing !== "time";
      if (st.ph == null) {
        const master = clocks ? (beats ? clocks.beats : clocks.time) : 0;
        st.ph = master * spd;                      // join the shared clock, already in phase
      } else {
        st.ph += spd * dt * (beats ? (a.bpm || 120) / 60 : 1);
      }
      const ph = st.ph + (m.phase || 0);
      const fr = ph - Math.floor(ph);
      return m.mode === "ramp" ? fr
           : m.mode === "triangle" ? (fr < 0.5 ? fr * 2 : 2 - fr * 2)
           : 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
    } },
  };
  // sources that can be blended as a second input (bands only — not beat/cycler)
  const BLENDABLE = ["bass", "mid", "treble", "energy", "centroid"];

  /* -------------------------------------------------------------------- ops */
  // Each maps 0..1 → 0..1. `amount` is the single knob; spring carries two.
  const OPS = {
    // below `amount` → 0; [amount..1] rescaled to 0..1. Ignores the noise floor.
    gate: { label: "Gate", knob: { key: "amount", label: "threshold", min: 0, max: 0.95, step: 0.01, def: 0.25 },
      run: (o, st, x) => { const g = o.amount || 0; return g > 0 ? clamp((x - g) / Math.max(1e-3, 1 - g), 0, 1) : x; } },
    // exponent — >1 makes the param respond only near the top of the range, <1 the bottom
    curve: { label: "Curve", knob: { key: "amount", label: "exponent", min: 0.2, max: 5, step: 0.1, def: 2 },
      run: (o, st, x) => Math.pow(clamp(x, 0, 1), o.amount || 1) },
    // damped-spring follow — smooths a jumpy band into a swell, with a little overshoot
    spring: { label: "Spring", knob: { key: "amount", label: "stiffness", min: 0.02, max: 1, step: 0.02, def: 0.15 },
      knob2: { key: "damping", label: "damping", min: 0.1, max: 1.5, step: 0.05, def: 0.6 },
      run: (o, st, x, dt) => {
        if (!st.init) { st.pos = x; st.vel = 0; st.init = true; }
        const k = (o.amount || 0.15) * 300, c = 2 * (o.damping != null ? o.damping : 0.6) * Math.sqrt(k);
        st.vel += (k * (x - st.pos) - c * st.vel) * dt;
        st.pos += st.vel * dt;
        return st.pos;   // deliberately NOT clamped — overshoot is the point
      } },
  };

  /* --------------------------------------------------------------- evaluate */
  // mod + scratch state + audio frame → the param value. Returns null if unlinked.
  function evaluate(mod, st, a, dt, clocks) {
    if (!mod || !mod.src || mod.src === "none") return null;
    const src = SOURCES[mod.src];
    if (!src || !src.read) return null;

    let x = src.read(mod, st, a, dt, clocks);
    // optional second band, blended in
    if (mod.src2 && SOURCES[mod.src2] && SOURCES[mod.src2].read) {
      const y = SOURCES[mod.src2].read(mod, st, a, dt, clocks);
      const b = mod.blend != null ? mod.blend : 0.5;
      x = x + (y - x) * b;
    }
    // op stack, in order; each op gets its own slot of scratch state
    const ops = mod.ops || [];
    if (!st.ops) st.ops = [];
    for (let i = 0; i < ops.length; i++) {
      const def = OPS[ops[i].op];
      if (!def) continue;
      if (!st.ops[i]) st.ops[i] = {};
      x = def.run(ops[i], st.ops[i], x, dt);
    }
    const lo = mod.min != null ? mod.min : 0, hi = mod.max != null ? mod.max : 1;
    return lo + (hi - lo) * x;
  }

  // Apply every modulator on `v` into `v.p` for this frame. Call before v.frame(a).
  function apply(v, a, dt) {
    const mods = v.mods;
    if (!mods) return;
    if (!v._modState) v._modState = {};
    // Clocks shared by every modulator on this visual. Cyclers seed their phase from these, so
    // same-speed cyclers agree no matter when each one was attached (and harmonically related
    // speeds stay locked too). Advanced once per frame, before anything reads them.
    const ck = v._modClocks || (v._modClocks = { time: 0, beats: 0 });
    ck.time += dt;
    ck.beats += dt * ((a.bpm || 120) / 60);
    for (const key in mods) {
      const st = v._modState[key] || (v._modState[key] = {});
      const val = evaluate(mods[key], st, a, dt, ck);
      if (val != null) v.p[key] = val;
    }
  }

  /* ------------------------------------------------------- (de)serialization */
  function create(param) {
    // a fresh modulator spans the param's own declared range — a sane starting point
    return { src: "energy", ops: [],
             min: param && param.min != null ? param.min : 0,
             max: param && param.max != null ? param.max : 1 };
  }
  function serialize(v) { return v.mods ? JSON.parse(JSON.stringify(v.mods)) : {}; }
  function hydrate(v, saved) {
    v.mods = {}; v._modState = {}; v._modClocks = { time: 0, beats: 0 };
    if (!saved) return;
    (v.params || []).forEach(p => {
      if (p.key && saved[p.key] && saved[p.key].src) v.mods[p.key] = JSON.parse(JSON.stringify(saved[p.key]));
    });
  }

  /* ------------------------------------------------------------------- UI */
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const opt = (sel, val, label, cur) => { const o = document.createElement("option"); o.value = val; o.textContent = label; if (val === cur) o.selected = true; sel.appendChild(o); };
  const numIn = (val, step, oninput) => {
    const i = el("input"); i.type = "number"; i.value = val; i.step = step != null ? step : 0.01;
    i.className = "mnum"; i.addEventListener("input", () => oninput(+i.value));
    return i;
  };

  /* Build the modulator editor for ONE param, into `host`.
     `param` is the visual's param spec, `v` the visual, `onChange` persists. */
  function renderParamMod(host, v, param, onChange) {
    host.innerHTML = "";
    const mod = v.mods && v.mods[param.key];
    if (!mod) return;

    const box = el("div", "modbox");

    // ---- row 1: source (+ optional blend partner) ----
    const r1 = el("div", "modrow");
    r1.appendChild(el("span", "mlab", "source"));
    const sSel = el("select");
    for (const k in SOURCES) opt(sSel, k, SOURCES[k].label, mod.src);
    sSel.addEventListener("change", () => {
      mod.src = sSel.value;
      if (mod.src === "cycler") { mod.mode = mod.mode || "ramp"; mod.timing = mod.timing || "beat"; mod.speed = mod.speed != null ? mod.speed : 0.25; }
      if (mod.src === "beat") mod.decay = mod.decay != null ? mod.decay : 0.35;
      if (mod.src === "cycler" || mod.src === "beat") mod.src2 = null;
      if (v._modState) v._modState[param.key] = {};
      onChange(); renderParamMod(host, v, param, onChange);
    });
    r1.appendChild(sSel);
    box.appendChild(r1);

    const srcDef = SOURCES[mod.src] || {};

    // cycler settings
    if (srcDef.cycler) {
      const r = el("div", "modrow");
      r.appendChild(el("span", "mlab", "shape"));
      const mSel = el("select");
      ["sine", "triangle", "ramp"].forEach(m => opt(mSel, m, m, mod.mode));
      mSel.addEventListener("change", () => { mod.mode = mSel.value; onChange(); });
      r.appendChild(mSel);
      const tSel = el("select");
      opt(tSel, "beat", "per beat", mod.timing); opt(tSel, "time", "per sec", mod.timing);
      tSel.addEventListener("change", () => { mod.timing = tSel.value; onChange(); });
      r.appendChild(tSel);
      r.appendChild(el("span", "mlab", "rate"));
      r.appendChild(numIn(mod.speed, 0.01, x => { mod.speed = x; onChange(); }));
      box.appendChild(r);

      // Phase offset, in cycles. Cyclers share a clock, so this is a stable relationship
      // between them: 0.5 = exactly opposite, 0.25 = a quarter cycle behind.
      const r2 = el("div", "modrow");
      r2.appendChild(el("span", "mlab", "offset"));
      const ph = el("input"); ph.type = "range"; ph.min = 0; ph.max = 1; ph.step = 0.01;
      ph.value = mod.phase || 0;
      const phv = el("span", "mval", (mod.phase || 0).toFixed(2));
      ph.addEventListener("input", () => { mod.phase = +ph.value; phv.textContent = (+ph.value).toFixed(2); onChange(); });
      r2.appendChild(ph); r2.appendChild(phv);
      const half = el("button", "mx", "½");
      half.title = "Opposite phase (0.5)";
      half.addEventListener("click", () => { mod.phase = 0.5; onChange(); renderParamMod(host, v, param, onChange); });
      r2.appendChild(half);
      box.appendChild(r2);
    }
    // beat envelope decay
    if (srcDef.decay) {
      const r = el("div", "modrow");
      r.appendChild(el("span", "mlab", "decay"));
      r.appendChild(numIn(mod.decay, 0.05, x => { mod.decay = x; onChange(); }));
      r.appendChild(el("span", "mlab", "sec"));
      box.appendChild(r);
    }
    // blend a second band in
    if (BLENDABLE.indexOf(mod.src) >= 0) {
      const r = el("div", "modrow");
      r.appendChild(el("span", "mlab", "blend"));
      const b2 = el("select");
      opt(b2, "", "— none —", mod.src2 || "");
      BLENDABLE.forEach(k => { if (k !== mod.src) opt(b2, k, SOURCES[k].label, mod.src2 || ""); });
      b2.addEventListener("change", () => {
        mod.src2 = b2.value || null;
        if (mod.src2 && mod.blend == null) mod.blend = 0.5;
        onChange(); renderParamMod(host, v, param, onChange);
      });
      r.appendChild(b2);
      if (mod.src2) {
        const mix = el("input"); mix.type = "range"; mix.min = 0; mix.max = 1; mix.step = 0.05;
        mix.value = mod.blend != null ? mod.blend : 0.5; mix.className = "mmix";
        mix.addEventListener("input", () => { mod.blend = +mix.value; onChange(); });
        r.appendChild(mix);
      }
      box.appendChild(r);
    }

    // ---- op stack ----
    (mod.ops || []).forEach((o, i) => {
      const def = OPS[o.op]; if (!def) return;
      const r = el("div", "modrow op");
      r.appendChild(el("span", "mlab", def.label.toLowerCase()));
      [def.knob, def.knob2].forEach(kn => {
        if (!kn) return;
        r.appendChild(el("span", "mlab dim", kn.label));
        const sl = el("input"); sl.type = "range"; sl.min = kn.min; sl.max = kn.max; sl.step = kn.step;
        sl.value = o[kn.key] != null ? o[kn.key] : kn.def;
        const rd = el("span", "mval", (+sl.value).toFixed(2));
        sl.addEventListener("input", () => { o[kn.key] = +sl.value; rd.textContent = (+sl.value).toFixed(2); onChange(); });
        r.appendChild(sl); r.appendChild(rd);
      });
      const del = el("button", "mx", "✕");
      del.title = "Remove op";
      del.addEventListener("click", () => {
        mod.ops.splice(i, 1);
        if (v._modState) v._modState[param.key] = {};
        onChange(); renderParamMod(host, v, param, onChange);
      });
      r.appendChild(del);
      box.appendChild(r);
    });

    // ---- range + add-op ----
    const r3 = el("div", "modrow");
    r3.appendChild(el("span", "mlab", "range"));
    r3.appendChild(numIn(mod.min, param.step, x => { mod.min = x; onChange(); }));
    r3.appendChild(el("span", "mlab", "→"));
    r3.appendChild(numIn(mod.max, param.step, x => { mod.max = x; onChange(); }));
    const addSel = el("select"); addSel.className = "maddop";
    opt(addSel, "", "+ op");
    for (const k in OPS) opt(addSel, k, OPS[k].label);
    addSel.addEventListener("change", () => {
      const k = addSel.value; addSel.value = "";
      if (!OPS[k]) return;
      const o = { op: k };
      o[OPS[k].knob.key] = OPS[k].knob.def;
      if (OPS[k].knob2) o[OPS[k].knob2.key] = OPS[k].knob2.def;
      (mod.ops = mod.ops || []).push(o);
      onChange(); renderParamMod(host, v, param, onChange);
    });
    r3.appendChild(addSel);
    box.appendChild(r3);

    host.appendChild(box);
  }

  S.Mod = { SOURCES, OPS, BLENDABLE, evaluate, apply, create, serialize, hydrate, renderParamMod };
})();
