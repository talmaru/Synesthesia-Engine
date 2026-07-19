"use strict";
/* Orbit Scope — orbiting bodies, an oscilloscope trace strung between them, and fractal
   bolts that fire on the beat.

   The mechanics (orbits, wave trace, bolt recursion) are hand-coded here and fixed.
   Nothing below is audio-reactive by itself: every param is a plain slider that just
   sits where you leave it. Reactivity is added in the player — hit ⟳ next to any
   parameter to attach a modulator (source → ops → range), and save it as a preset.

   Good ones to try here: energy → radius (the orbit breathes), a beat envelope →
   glowAlpha (flash on the kick), a cycler → hue (slow colour drift). */
Synesthesia.register({
  id: "orbitscope",
  label: "Orbit Scope",

  params: [
    { key: "orbs",       label: "Bodies",        type: "range", min: 2,    max: 6,   step: 1,    default: 2 },
    { key: "radius",     label: "Orbit radius",  type: "range", min: 0.05, max: 0.45, step: 0.01, default: 0.18 },
    { key: "spin",       label: "Orbit speed",   type: "range", min: -3,   max: 3,   step: 0.05, default: 0.4 },
    { key: "glowSize",   label: "Body glow",     type: "range", min: 4,    max: 60,  step: 1,    default: 22 },
    { key: "glowAlpha",  label: "Body bright",   type: "range", min: 0.1,  max: 2,   step: 0.05, default: 1 },
    { key: "waveAmp",    label: "Wave amp",      type: "range", min: 0,    max: 0.6, step: 0.01, default: 0.2 },
    { key: "waveWidth",  label: "Wave width",    type: "range", min: 0.5,  max: 6,   step: 0.5,  default: 2 },
    { key: "jitter",     label: "Wave jitter",   type: "range", min: 0,    max: 1,   step: 0.02, default: 0.25 },
    { key: "arcRate",    label: "Bolts / beat",  type: "range", min: 0,    max: 8,   step: 1,    default: 3 },
    { key: "arcPower",   label: "Bolt reach",    type: "range", min: 0.05, max: 2,   step: 0.05, default: 0.5 },
    { key: "arcSpread",  label: "Bolt spread",   type: "range", min: 0.1,  max: 1,   step: 0.05, default: 0.9 },
    { key: "arcLife",    label: "Bolt life (s)", type: "range", min: 0.1,  max: 1.5, step: 0.05, default: 0.5 },
    { key: "arcWidth",   label: "Bolt width",    type: "range", min: 0.5,  max: 5,   step: 0.5,  default: 1.5 },
    { key: "arcDetail",  label: "Bolt detail",   type: "range", min: 1,    max: 6,   step: 1,    default: 4 },
    { key: "arcRough",   label: "Bolt rough",    type: "range", min: 0,    max: 0.8, step: 0.05, default: 0.4 },
    { key: "hue",        label: "Base hue",      type: "range", min: 0,    max: 360, step: 1,    default: 200 },
    { key: "hueSpread",  label: "Hue spread",    type: "range", min: 0,    max: 180, step: 5,    default: 100 },
    { key: "saturation", label: "Saturation",    type: "range", min: 0,    max: 100, step: 1,    default: 90 },
    { key: "trail",      label: "Trail",         type: "range", min: 0.05, max: 1,   step: 0.01, default: 0.5 },
  ],

  // fixed constants (mechanics, not knobs)
  C: { bg: [10, 12, 18], waveSteps: 220, maxBolts: 64 },

  mount(host) {
    this.cv = host.canvas;
    this.ctx = host.canvas.getContext("2d", { alpha: false });
    this.dpr = host.dpr;
    this.W = this.cv.width; this.H = this.cv.height;
    this.phase = 0;
    this.bolts = [];
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.W, this.H);
  },

  resize(w, h) { this.W = w; this.H = h; },
  unmount() { this.bolts = []; },

  // distance from (x,y) along unit (ux,uy) to the canvas edge — keeps bolts on screen
  edgeDist(x, y, ux, uy) {
    let d = 1e9;
    if (ux > 1e-6) d = Math.min(d, (this.W - x) / ux); else if (ux < -1e-6) d = Math.min(d, -x / ux);
    if (uy > 1e-6) d = Math.min(d, (this.H - y) / uy); else if (uy < -1e-6) d = Math.min(d, -y / uy);
    return Math.max(d, 0);
  },

  /* Midpoint-displacement bolt: a polyline from (x,y) toward (ux,uy) for `reach` px,
     subdivided `detail` times with perpendicular jitter. Returns flat [x0,y0,x1,y1,...]. */
  buildBolt(x, y, ux, uy, reach, detail, rough) {
    let pts = [x, y, x + ux * reach, y + uy * reach];
    for (let d = 0; d < detail; d++) {
      const next = [pts[0], pts[1]];
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        const off = (Math.random() * 2 - 1) * len * rough * 0.5;
        next.push(mx - (dy / (len || 1)) * off, my + (dx / (len || 1)) * off, bx, by);
      }
      pts = next;
    }
    return pts;
  },

  frame(a) {
    const p = this.p, C = this.C, ctx = this.ctx;
    const W = this.W, H = this.H, dt = Math.min(a.dt / 1000, 0.033);
    const cx = W / 2, cy = H / 2, md = Math.min(W, H);
    const sat = p.saturation, wrap = h => { h %= 360; return h < 0 ? h + 360 : h; };

    // ---- orbit bodies ----
    this.phase += p.spin * dt;
    const n = Math.max(2, Math.round(p.orbs));
    const rad = md * p.radius;
    const orb = [];
    for (let i = 0; i < n; i++) {
      const th = this.phase + (i / n) * Math.PI * 2;
      orb.push({ x: cx + Math.cos(th) * rad, y: cy + Math.sin(th) * rad, th });
    }

    // ---- trail ----
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(${C.bg[0]},${C.bg[1]},${C.bg[2]},${p.trail})`;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // ---- oscilloscope trace strung between consecutive bodies ----
    const wave = a.wave, WN = wave ? wave.length : 0;
    if (WN > 1 && p.waveAmp > 0.001) {
      const steps = C.waveSteps;
      ctx.strokeStyle = `hsla(${wrap(p.hue)},${sat}%,65%,0.9)`;
      ctx.lineWidth = p.waveWidth * this.dpr;
      // with 2 bodies the ring closes on itself — one span, not two overlapping draws
      const spans = n === 2 ? 1 : n;
      for (let k = 0; k < spans; k++) {
        const A = orb[k], B = orb[(k + 1) % n];
        const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;               // perpendicular
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const w = wave[Math.floor(t * (WN - 1))];
          // taper to zero at the endpoints so the trace meets each body cleanly
          const env = Math.sin(t * Math.PI);
          const j = (Math.random() * 2 - 1) * p.jitter * 4 * this.dpr;
          const off = w * p.waveAmp * md * 0.5 * env + j * env;
          const px = A.x + dx * t + nx * off, py = A.y + dy * t + ny * off;
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // ---- spawn bolts on the beat ----
    if (a.beat && p.arcRate >= 1) {
      const count = Math.round(p.arcRate);
      for (let i = 0; i < count && this.bolts.length < C.maxBolts; i++) {
        const src = orb[Math.floor(Math.random() * n)];
        // fire outward from the centre, scattered by arcSpread
        const base = Math.atan2(src.y - cy, src.x - cx);
        const ang = base + (Math.random() - 0.5) * Math.PI * p.arcSpread;
        const ux = Math.cos(ang), uy = Math.sin(ang);
        const reach = Math.min(this.edgeDist(src.x, src.y, ux, uy), md * p.arcPower);
        this.bolts.push({
          pts: this.buildBolt(src.x, src.y, ux, uy, reach, Math.round(p.arcDetail), p.arcRough),
          life: 1,
          hue: wrap(p.hue + (Math.random() * 2 - 1) * p.hueSpread),
        });
      }
    }

    // ---- draw + age bolts ----
    const decay = dt / Math.max(p.arcLife, 0.05);
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= decay;
      if (b.life <= 0) { this.bolts.splice(i, 1); continue; }
      const pts = b.pts, al = b.life * b.life;
      // wide faint glow, then a thin bright core
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = `hsla(${b.hue},${sat}%,${pass ? 85 : 60}%,${al * (pass ? 1 : 0.22)})`;
        ctx.lineWidth = p.arcWidth * this.dpr * (pass ? 1 : 3.5);
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let k = 2; k + 1 < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
        ctx.stroke();
      }
    }

    // ---- body glows (drawn last so they sit on top) ----
    const gr = p.glowSize * this.dpr;
    for (let i = 0; i < n; i++) {
      const o = orb[i];
      const h = wrap(p.hue + p.hueSpread * (i / n));
      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, gr);
      g.addColorStop(0, `hsla(${h},${sat}%,88%,${Math.min(p.glowAlpha, 1)})`);
      g.addColorStop(0.35, `hsla(${h},${sat}%,62%,${Math.min(p.glowAlpha, 1) * 0.35})`);
      g.addColorStop(1, `hsla(${h},${sat}%,50%,0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(o.x, o.y, gr, 0, Math.PI * 2); ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
  }
});
