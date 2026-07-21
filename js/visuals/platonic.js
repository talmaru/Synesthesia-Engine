"use strict";
/* Platonic Resonance — nested rings whose vertex counts are the five Platonic solids'
   (tetrahedron 4, octahedron 6, cube 8, icosahedron 12, dodecahedron 20), counter-rotating.
   When a vertex on one ring sweeps past a vertex on another, a bolt jumps the gap.

   THE MECHANIC — all of the structure comes out of the geometry, not the audio. For two rings
   with nA and nB vertices there are exactly lcm(nA,nB) alignment moments per relative
   revolution, and each one fires gcd(nA,nB) bolts AT ONCE. So:
       6 & 12  ->  12 moments/rev, SIX simultaneous bolts   (rare, symmetric, a crown)
       4 & 8   ->   8 moments/rev, four bolts
       6 & 8   ->  24 moments/rev, two bolts                (frequent, small)
   Using the Platonic vertex counts is what buys that: they share a lot of factors, so you get
   a real hierarchy of rare-big and frequent-small events. Coprime counts (3,5,7) would give a
   flat trickle of single bolts.

   The rings are drawn thin and dim on purpose — they are scaffolding. The bolts are the show.

   Nothing here is audio-reactive by itself. Attach modulators in the player (⟳). Good ones:
   energy -> spin, a beat envelope -> boltGlow, bass -> ringGap, or a cycler -> hue. Two cyclers
   at the same rate with a 0.5 phase offset on spin/ringGap play nicely against each other.

   HOW BUSY IT IS is set by geometry, not by `tolerance`. Because a bolt fires on the RISING
   EDGE of an alignment, one sweep-past makes exactly one bolt however wide the window is —
   `tolerance` only decides whether a pass is DETECTED. The real density knobs are `spin`
   (rate scales with it), `allPairs` (4 adjacent pairs vs all 10) and `eventChance`, which
   skips whole alignment events at random — whole, so a 6-bolt crown stays a 6-bolt crown. */
Synesthesia.register({
  id: "platonic",
  label: "Platonic Resonance",

  params: [
    { key: "rings",     label: "Rings",          type: "range", min: 2,    max: 5,    step: 1,    default: 5 },
    { key: "innerR",    label: "Inner radius",   type: "range", min: 0.05, max: 0.3,  step: 0.01, default: 0.11 },
    { key: "ringGap",   label: "Ring spacing",   type: "range", min: 0.03, max: 0.16, step: 0.005, default: 0.075 },
    { key: "spin",      label: "Spin",           type: "range", min: 0,    max: 2,    step: 0.02, default: 0.28 },
    { key: "spinSpread",label: "Spin spread",    type: "range", min: 0,    max: 1,    step: 0.02, default: 0.35 },
    { key: "tolerance", label: "Align window",   type: "range", min: 0.2,  max: 8,    step: 0.1,  default: 2.2 },
    { key: "eventChance", label: "Event chance", type: "range", min: 0.02, max: 1,    step: 0.02, default: 0.45 },
    { key: "allPairs",  label: "All ring pairs", type: "range", min: 0,    max: 1,    step: 1,    default: 0 },
    { key: "boltLife",  label: "Bolt life (s)",  type: "range", min: 0.1,  max: 1.5,  step: 0.05, default: 0.4 },
    { key: "boltGlow",  label: "Bolt glow",      type: "range", min: 0.2,  max: 4,    step: 0.1,  default: 1.4 },
    { key: "boltWidth", label: "Bolt width",     type: "range", min: 0.5,  max: 4,    step: 0.1,  default: 1.4 },
    { key: "boltJag",   label: "Bolt jaggedness",type: "range", min: 0,    max: 1,    step: 0.02, default: 0.34 },
    { key: "boltDetail",label: "Bolt detail",    type: "range", min: 1,    max: 5,    step: 1,    default: 3 },
    { key: "edgeBright",label: "Ring brightness",type: "range", min: 0,    max: 1,    step: 0.02, default: 0.22 },
    { key: "edgeWidth", label: "Ring width",     type: "range", min: 0.3,  max: 3,    step: 0.1,  default: 0.8 },
    { key: "vertGlow",  label: "Vertex glow",    type: "range", min: 0,    max: 30,   step: 0.5,  default: 9 },
    { key: "hue",       label: "Hue",            type: "range", min: 0,    max: 360,  step: 1,    default: 190 },
    { key: "hueSpread", label: "Hue per ring",   type: "range", min: 0,    max: 180,  step: 5,    default: 42 },
    { key: "boltHue",   label: "Bolt hue shift", type: "range", min: -180, max: 180,  step: 5,    default: 55 },
    { key: "sat",       label: "Saturation",     type: "range", min: 0,    max: 1,    step: 0.02, default: 0.8 },
    { key: "trail",     label: "Trail",          type: "range", min: 0.05, max: 1,    step: 0.01, default: 0.32 },
    { key: "bloom",     label: "Bloom",          type: "range", min: 0,    max: 3,    step: 0.05, default: 0.85 },
    { key: "bloomThresh", label: "Bloom thresh", type: "range", min: 0,    max: 1,    step: 0.02, default: 0.3 },
  ],

  C: {
    // the five Platonic solids' vertex counts, innermost -> outermost
    SIDES: [4, 6, 8, 12, 20],
    NAMES: ["tetra", "octa", "cube", "icosa", "dodeca"],
    bg: [4 / 255, 5 / 255, 9 / 255],
    maxBolts: 220,
  },

  mount(host) {
    this.dpr = host.dpr;
    this.scene = Synesthesia.GL.createScene(host.canvas, host.dpr);
    if (!this.scene.gl) { console.error("Platonic: WebGL2 unavailable in this browser."); return; }
    this.W = host.canvas.width; this.H = host.canvas.height;
    this.phase = this.C.SIDES.map(() => 0);
    this.bolts = [];
    this.wasNear = {};        // "pairKey:vertexIndex" -> was inside the align window last frame
    this.lineBuf = new Float32Array(2048 * 8);
    this.alignCount = 0;
  },
  resize(w, h) { this.W = w; this.H = h; if (this.scene) this.scene.resize(); },
  unmount() { if (this.scene) this.scene.dispose(); this.scene = null; this.bolts = []; },

  // shortest signed angular difference, in (-PI, PI]
  angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2; else if (d <= -Math.PI) d += Math.PI * 2;
    return d;
  },

  /* midpoint-displacement polyline from A to B, perpendicular jitter, `detail` subdivisions */
  buildBolt(ax, ay, bx, by, detail, jag) {
    let pts = [ax, ay, bx, by];
    for (let d = 0; d < detail; d++) {
      const next = [pts[0], pts[1]];
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
        const off = (Math.random() * 2 - 1) * len * jag * 0.5;
        next.push(mx - (dy / len) * off, my + (dx / len) * off, x1, y1);
      }
      pts = next;
    }
    return pts;
  },

  frame(a) {
    const p = this.p, C = this.C, scene = this.scene;
    if (!scene) return;
    const dt = Math.min(a.dt / 1000, 0.05);
    const W = this.W, H = this.H, cx = W / 2, cy = H / 2, md = Math.min(W, H);
    const TAU = Math.PI * 2;
    const nRings = Math.max(2, Math.min(Math.round(p.rings), C.SIDES.length));
    const tol = p.tolerance * Math.PI / 180;    // slider is in DEGREES

    // ---- advance each ring: alternating direction, spread rates so every pair drifts ----
    for (let i = 0; i < nRings; i++) {
      const dir = (i % 2) ? -1 : 1;
      this.phase[i] += p.spin * dir * (1 + i * p.spinSpread) * dt;
    }

    const radius = i => md * (p.innerR + i * p.ringGap);

    // ---- alignment detection -> bolts ----
    // For each ring pair, walk ring A's vertices and find the NEAREST vertex on ring B
    // (O(nA) instead of O(nA*nB)). Fire on the RISING EDGE of entering the window so one
    // sweep-past produces exactly one bolt rather than one per frame.
    const life = Math.max(p.boltLife, 0.05);
    const detail = Math.round(p.boltDetail);
    let aligned = 0;
    for (let iA = 0; iA < nRings; iA++) {
      for (let iB = iA + 1; iB < nRings; iB++) {
        if (!p.allPairs && iB !== iA + 1) continue;          // adjacent rings only by default
        const nA = C.SIDES[iA], nB = C.SIDES[iB];
        const stepB = TAU / nB, rA = radius(iA), rB = radius(iB);
        // Collect the vertices that ENTER the window this frame. By symmetry all gcd(nA,nB)
        // of them enter together, so we decide ONCE per event whether it fires — gating each
        // vertex separately would fire 3 of a 6-bolt crown and destroy the symmetry that
        // makes the big alignments worth watching.
        const fresh = [];
        for (let k = 0; k < nA; k++) {
          const angA = this.phase[iA] + TAU * k / nA;
          // nearest ring-B vertex to this angle
          const j = Math.round((angA - this.phase[iB]) / stepB);
          const angB = this.phase[iB] + j * stepB;
          const near = Math.abs(this.angDiff(angA, angB)) < tol;
          const key = iA + "_" + iB + "_" + k;
          if (near) {
            aligned++;
            if (!this.wasNear[key]) fresh.push(angA, angB);
          }
          this.wasNear[key] = near;
        }
        if (fresh.length && Math.random() < p.eventChance) {
          for (let m = 0; m + 1 < fresh.length && this.bolts.length < C.maxBolts; m += 2) {
            const angA = fresh[m], angB = fresh[m + 1];
            const x0 = cx + Math.cos(angA) * rA, y0 = cy + Math.sin(angA) * rA;
            const x1 = cx + Math.cos(angB) * rB, y1 = cy + Math.sin(angB) * rB;
            this.bolts.push({
              pts: this.buildBolt(x0, y0, x1, y1, detail, p.boltJag),
              t: 1,
              hue: p.hue + p.hueSpread * ((iA + iB) * 0.5) + p.boltHue,
            });
          }
        }
      }
    }
    this.alignCount = aligned;

    // ---- age bolts ----
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t -= dt / life;
      if (b.t <= 0) this.bolts.splice(i, 1);
    }

    // ---- build the line batch: ring edges first (dim), then bolts (bright) ----
    const MAX = Synesthesia.GL.MAXLINES;
    let n = 0;
    const need = c => {
      if (c * 8 <= this.lineBuf.length) return;
      const nb = new Float32Array(Math.min(MAX, Math.max(c, this.lineBuf.length / 8 * 2)) * 8);
      nb.set(this.lineBuf); this.lineBuf = nb;
    };
    const push = (x0, y0, x1, y1, hw, r, g, bl) => {
      if (n >= MAX) return;
      need(n + 1);
      const o = n * 8;
      this.lineBuf[o] = x0; this.lineBuf[o + 1] = y0;
      this.lineBuf[o + 2] = x1; this.lineBuf[o + 3] = y1;
      this.lineBuf[o + 4] = hw;
      this.lineBuf[o + 5] = r; this.lineBuf[o + 6] = g; this.lineBuf[o + 7] = bl;
      n++;
    };

    const verts = [];
    for (let i = 0; i < nRings; i++) {
      const sides = C.SIDES[i], r = radius(i), ph = this.phase[i];
      const rgb = Synesthesia.Color.hsv(p.hue + p.hueSpread * i, p.sat, 1);
      const eb = p.edgeBright;
      for (let k = 0; k < sides; k++) {
        const a0 = ph + TAU * k / sides, a1 = ph + TAU * (k + 1) / sides;
        const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        push(x0, y0, x1, y1, p.edgeWidth * this.dpr, rgb[0] * eb, rgb[1] * eb, rgb[2] * eb);
        if (p.vertGlow > 0)
          verts.push({ x: x0, y: y0, size: p.vertGlow * this.dpr,
                       r: rgb[0], g: rgb[1], b: rgb[2], life: 0.85 });
      }
    }

    for (const b of this.bolts) {
      const fade = b.t * b.t, rgb = Synesthesia.Color.hsv(b.hue, p.sat, 1);
      const gl_ = p.boltGlow * fade;
      const pts = b.pts;
      // wide soft pass then a thin bright core
      for (let pass = 0; pass < 2; pass++) {
        const hw = p.boltWidth * this.dpr * (pass ? 1 : 3.2);
        const amp = (pass ? 1 : 0.22) * gl_;
        for (let i = 0; i + 3 < pts.length; i += 2)
          push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], hw, rgb[0] * amp, rgb[1] * amp, rgb[2] * amp);
      }
    }

    // ---- render ----
    scene.fade(Math.max(0, Math.min(p.trail, 1)));
    if (n) scene.lines(this.lineBuf, n, { target: "acc", blend: "add" });
    if (verts.length) scene.glow(verts, { soft: 2.2, target: "acc", blend: "add" });
    scene.composite(C.bg, 1.15);
    if (p.bloom > 0) scene.bloom(p.bloom, p.bloomThresh, 1);

    this.stat = this.bolts.length + " bolts · " + this.alignCount + " aligned";
  },
});
