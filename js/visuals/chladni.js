"use strict";
/*
   AUDIO:
     bass  -> global scatter (frees grains from shared nodes), AND (smoothed)
              pumps plate-glow brightness + plate hue speed. Both capped so a
              heavy low end flares without flash-banging.
     mid   -> mode switching (onset detector). A fraction of switches become a
              "fake mode": migration off + strong random walk disperses every
              grain to a formless cloud, then it reforms on a real mode.
     treble-> drives a separate hue clock for the sand grains.
   Plate glow rides a bass colour clock; grains ride a treble colour clock. */
/* The plate simulation is fixed; nothing here is audio-reactive on its own. Every param is a
   plain slider — attach modulators in the player (⟳) to decide what the music drives.
   Good ones to try: bass → hueRate, treble → grainHueRate, mid → switchSens (mode changes). */
Synesthesia.register({
  id: "chladni",
  label: "Chladni Plate",

  params: [
    { key: "particles",  label: "Sand grains", type: "range", min: 500, max: 32000, step: 100,  default: 16000 },
    { key: "grainSize",  label: "Grain size",  type: "range", min: 0.5, max: 3,    step: 0.1,  default: 3 },
    { key: "migration",  label: "Settle rate", type: "range", min: 0.1, max: 4,    step: 0.1,  default: 0.2 },
    { key: "scatter",    label: "Bass scatter", type: "range", min: 0,  max: 3,    step: 0.1,  default: 0.3 },
    { key: "shake",      label: "Antinode shake", type: "range", min: 0, max: 2,   step: 0.1,  default: 0.1 },
    { key: "maxMode",    label: "Max mode",    type: "range", min: 3,   max: 12,   step: 1,    default: 12 },
    { key: "switchSens", label: "Mid switch",  type: "range", min: 0,   max: 1,    step: 0.05, default: 0.5 },
    { key: "fakeChance", label: "Fake chance", type: "range", min: 0,   max: 1,    step: 0.05, default: 0 },
    { key: "morphMs",    label: "Morph time",  type: "range", min: 100, max: 5000, step: 50,   default: 2500 },
    { key: "bassPump",   label: "Bass pump",   type: "range", min: 0,   max: 3,    step: 0.1,  default: 1 },
    { key: "hueRate",    label: "Plate hue rate", type: "range", min: 0, max: 130,  step: 1,    default: 40 },
    { key: "grainHueRate", label: "Grain hue rate", type: "range", min: 0, max: 140, step: 1,  default: 30 },
    { key: "field",      label: "Plate glow",  type: "range", min: 0,   max: 1,    step: 0.05, default: 1 },
    { key: "saturation", label: "Saturation",  type: "range", min: 0,   max: 100,  step: 1,    default: 100 },
    { key: "trail",      label: "Trail",       type: "range", min: 0.1, max: 1,    step: 0.02, default: 0.55 },
  ],

  C: { bg: [6, 7, 11], plateFrac: 0.92, fieldN: 64 },

  mount(host) {
    this.cv = host.canvas;
    this.ctx = host.canvas.getContext("2d", { alpha: false });
    this.dpr = host.dpr;
    this.W = this.cv.width; this.H = this.cv.height;
    this.n = 3; this.m = 2; this.n2 = 3; this.m2 = 2; this.mt = 1;
    this.midBase = 0; this.midRef = 0;
    this.hue = 0; this.grainHue = 120; this.bassEnv = 0;   // colour clocks + bass envelope
    this.fake = false; this.fakeT = 0;
    this.parts = [];
    const FN = this.C.fieldN;
    this.fc = document.createElement("canvas"); this.fc.width = this.fc.height = FN;
    this.fctx = this.fc.getContext("2d");
    this.fimg = this.fctx.createImageData(FN, FN);
    this.ctx.fillStyle = "#000"; this.ctx.fillRect(0, 0, this.W, this.H);
  },

  resize(w, h) { this.W = w; this.H = h; },
  unmount() { this.parts = []; },

  reconcile(target) {
    const a = this.parts;
    while (a.length < target) a.push({ x: Math.random(), y: Math.random() });
    if (a.length > target) a.length = target;
  },

  pickMode(centroid) {
    const mx = Math.round(this.p.maxMode);
    const target = 1 + Math.round(centroid * (mx - 1));
    const ri = (s) => Math.max(1, Math.min(mx, target + (Math.floor(Math.random() * (2 * s + 1)) - s)));
    for (let tries = 0; tries < 8; tries++) {
      let n = ri(1), m = ri(2);
      if (n === m) m = Math.max(1, Math.min(mx, m + 1));
      if (n === m) m = n === 1 ? 2 : n - 1;
      if (n !== this.n || m !== this.m) { this.n2 = n; this.m2 = m; return; }
    }
    this.n2 = this.m; this.m2 = this.n;
  },

  hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  },

  frame(a) {
    const p = this.p, C = this.C, ctx = this.ctx;
    const W = this.W, H = this.H, sat = p.saturation;
    const dt = Math.min(a.dt / 1000, 0.033), fstep = dt * 60;
    const wrap = h => { h %= 360; return h < 0 ? h + 360 : h; };
    const PI = Math.PI;

    const side = Math.min(W, H) * C.plateFrac;
    const ox = (W - side) / 2, oy = (H - side) / 2;

    // ---- colour clocks + bass envelope (smoothed = no strobe) ----
    const bnRaw = a.bass * a.bass;
    this.bassEnv += (bnRaw - this.bassEnv) * (bnRaw > this.bassEnv ? 0.3 : 0.06);
    const be = this.bassEnv;
    const plateRate = p.hueRate;      // deg/s — the graph decides what drives it (was hardcoded bass→rate)
    const grainRate = p.grainHueRate; // deg/s — likewise (was hardcoded treble→rate)
    this.hue = (this.hue + plateRate * dt) % 360;
    this.grainHue = (this.grainHue + grainRate * dt) % 360;
    const glowA = Math.min(p.field * (1 + be * p.bassPump * 1.5), 0.85) * (this.fake ? 0.4 : 1);

    // spectral centroid -> complexity
    let sum = 0, wsum = 0;
    for (let i = 0; i < 128; i++) { sum += a.bins[i]; wsum += i * a.bins[i]; }
    const centroid = sum > 0.0001 ? (wsum / sum) / 128 : 0.3;

    // mid-range onset -> switch (real mode, or a fake-mode scatter)
    this.midBase += (a.mid - this.midBase) * 0.08;
    this.midRef -= a.dt;
    const thr = 1.6 - p.switchSens * 0.9;
    if (this.mt >= 1 && !this.fake && a.mid > this.midBase * thr && a.mid > 0.06 && this.midRef <= 0) {
      if (Math.random() < p.fakeChance) { this.fake = true; this.fakeT = p.morphMs; }
      else { this.n = this.n2; this.m = this.m2; this.pickMode(centroid); this.mt = 0; }
      this.midRef = 180;
    }
    if (this.fake) {
      this.fakeT -= a.dt;
      if (this.fakeT <= 0) {
        this.fake = false;
        this.pickMode(centroid);
        this.n = this.n2; this.m = this.m2; this.mt = 1; this.midRef = 180;
      }
    }
    if (this.mt < 1) {
      this.mt = Math.min(1, this.mt + dt / (p.morphMs / 1000));
      if (this.mt >= 1) { this.n = this.n2; this.m = this.m2; }
    }
    const morphing = this.mt < 1;
    const tb = morphing ? this.mt * this.mt * (3 - 2 * this.mt) : 1;
    const ti = 1 - tb;

    const gScat = 0.03 * p.scatter * bnRaw;
    const lShakeC = 0.012 * p.shake;
    const N1 = this.n * PI, M1 = this.m * PI, N2 = this.n2 * PI, M2 = this.m2 * PI;
    const k2 = 2 * (0.004 * p.migration);

    // ---- move the sand ----
    this.reconcile(Math.round(p.particles));
    const fakeMag = (0.045 + gScat) * fstep;
    for (const o of this.parts) {
      if (this.fake) {
        // chaos: no migration, strong uniform dispersal
        o.x += (Math.random() * 2 - 1) * fakeMag;
        o.y += (Math.random() * 2 - 1) * fakeMag;
      } else {
        let cnx = Math.cos(N2 * o.x), snx = Math.sin(N2 * o.x);
        let cmx = Math.cos(M2 * o.x), smx = Math.sin(M2 * o.x);
        let cny = Math.cos(N2 * o.y), sny = Math.sin(N2 * o.y);
        let cmy = Math.cos(M2 * o.y), smy = Math.sin(M2 * o.y);
        let Wv = cnx * cmy - cmx * cny;
        let Wx = -N2 * snx * cmy + M2 * smx * cny;
        let Wy = -M2 * cnx * smy + N2 * cmx * sny;
        if (morphing) {
          cnx = Math.cos(N1 * o.x); snx = Math.sin(N1 * o.x);
          cmx = Math.cos(M1 * o.x); smx = Math.sin(M1 * o.x);
          cny = Math.cos(N1 * o.y); sny = Math.sin(N1 * o.y);
          cmy = Math.cos(M1 * o.y); smy = Math.sin(M1 * o.y);
          const Wv1 = cnx * cmy - cmx * cny;
          const Wx1 = -N1 * snx * cmy + M1 * smx * cny;
          const Wy1 = -M1 * cnx * smy + N1 * cmx * sny;
          Wv = ti * Wv1 + tb * Wv; Wx = ti * Wx1 + tb * Wx; Wy = ti * Wy1 + tb * Wy;
        }
        const g = Wv * Wv;
        o.x -= k2 * Wv * Wx * fstep;
        o.y -= k2 * Wv * Wy * fstep;
        const mag = (gScat + g * lShakeC) * fstep;
        o.x += (Math.random() * 2 - 1) * mag;
        o.y += (Math.random() * 2 - 1) * mag;
      }
      if (o.x < 0) o.x = -o.x; else if (o.x > 1) o.x = 2 - o.x;
      if (o.y < 0) o.y = -o.y; else if (o.y > 1) o.y = 2 - o.y;
      if (o.x < 0 || o.x > 1) o.x = Math.random();
      if (o.y < 0 || o.y > 1) o.y = Math.random();
    }

    // ---- render ----
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(${C.bg[0]},${C.bg[1]},${C.bg[2]},${p.trail})`;
    ctx.fillRect(0, 0, W, H);

    if (glowA > 0.002) {
      const FN = C.fieldN, d = this.fimg.data;
      const [tr, tg, tb2] = this.hslToRgb(wrap(this.hue), sat, 50);
      let idx = 0;
      for (let yy = 0; yy < FN; yy++) {
        const fy = yy / (FN - 1);
        const c2ny = Math.cos(N2 * fy), c2my = Math.cos(M2 * fy);
        const c1ny = morphing ? Math.cos(N1 * fy) : 0, c1my = morphing ? Math.cos(M1 * fy) : 0;
        for (let xx = 0; xx < FN; xx++) {
          const fx = xx / (FN - 1);
          let Wv = Math.cos(N2 * fx) * c2my - Math.cos(M2 * fx) * c2ny;
          if (morphing) {
            const Wv1 = Math.cos(N1 * fx) * c1my - Math.cos(M1 * fx) * c1ny;
            Wv = ti * Wv1 + tb * Wv;
          }
          const inten = Math.min(Wv * Wv / 4, 1);
          d[idx++] = tr * inten; d[idx++] = tg * inten; d[idx++] = tb2 * inten; d[idx++] = 255;
        }
      }
      this.fctx.putImageData(this.fimg, 0, 0);
      ctx.globalAlpha = glowA;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fc, ox, oy, side, side);
      ctx.globalAlpha = 1;
    }

    const gs = Math.max(1, p.grainSize * this.dpr);
    ctx.fillStyle = `hsl(${wrap(this.grainHue)},${Math.min(sat, 80)}%,78%)`;
    for (const o of this.parts) {
      ctx.fillRect(ox + o.x * side - gs * 0.5, oy + o.y * side - gs * 0.5, gs, gs);
    }
  }
});
