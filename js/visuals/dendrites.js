"use strict";
/* Fractal Dendrites — branching trees that grow inward from the screen edges.

   Seeds are planted on a random edge, aimed roughly at the centre. Each seed bakes a recursive
   branch structure ONCE, then reveals it root→tip behind a growth front with a bright, widened
   tip. Rendered as glowing capsules into the GL scene (trail + bloom).

   LIFECYCLE — there is no lifespan slider:
     grow (1/growth seconds)  →  FULLY GROWN MEANS DEAD  →  dissolve over `retire` seconds
   `growth` is arc fraction PER SECOND and is INTEGRATED, not re-derived, so turning it down
   slows further advance instead of retracting trees that have already grown.
   Steady population settles near spawnRate * (1/growth + retire); `maxTrees` is a ceiling that
   retires the oldest early if spawning outruns dying.

   Nothing here is audio-reactive on its own — every param is a plain slider. Attach modulators
   in the player (⟳). Good ones to try: energy → growth, a beat envelope → tipGlow, bass →
   spawnRate, a cycler → hue. */
Synesthesia.register({
  id: "dendrites",
  label: "Fractal Dendrites",

  params: [
    { key: "spawnRate",   label: "Spawn rate",    type: "range", min: 0,    max: 30,   step: 1,    default: 6 },
    { key: "maxTrees",    label: "Max trees",     type: "range", min: 1,    max: 200,  step: 1,    default: 24 },
    { key: "growth",      label: "Growth rate",   type: "range", min: 0.05, max: 3,    step: 0.05, default: 0.5 },
    { key: "retire",      label: "Dissolve (s)",  type: "range", min: 0.2,  max: 6,    step: 0.1,  default: 1.5 },
    { key: "tipGlow",     label: "Tip glow",      type: "range", min: 0,    max: 3,    step: 0.05, default: 0.6 },
    { key: "depth",       label: "Depth",         type: "range", min: 1,    max: 8,    step: 1,    default: 5 },
    { key: "wobble",      label: "Wobble",        type: "range", min: 0,    max: 1,    step: 0.02, default: 0.2 },
    { key: "branch",      label: "Branchiness",   type: "range", min: 0,    max: 6,    step: 0.5,  default: 2.5 },
    { key: "spread",      label: "Branch angle",  type: "range", min: 0,    max: 1.5,  step: 0.05, default: 0.6 },
    { key: "decay",       label: "Length decay",  type: "range", min: 0.5,  max: 0.95, step: 0.01, default: 0.82 },
    { key: "inwardSpread",label: "Aim spread",    type: "range", min: 0,    max: 3.14, step: 0.05, default: 1 },
    { key: "trunkLen",    label: "Trunk length",  type: "range", min: 0.1,  max: 1,    step: 0.05, default: 0.5 },
    { key: "width",       label: "Line width",    type: "range", min: 0.5,  max: 5,    step: 0.5,  default: 1.5 },
    { key: "taper",       label: "Taper",         type: "range", min: 0,    max: 1,    step: 0.05, default: 0.7 },
    { key: "rainbow",     label: "Hue spread",    type: "range", min: 0,    max: 360,  step: 10,   default: 120 },
    { key: "hue",         label: "Hue",           type: "range", min: 0,    max: 360,  step: 1,    default: 200 },
    { key: "sat",         label: "Saturation",    type: "range", min: 0,    max: 1,    step: 0.02, default: 0.85 },
    { key: "val",         label: "Brightness",    type: "range", min: 0,    max: 1,    step: 0.02, default: 0.9 },
    { key: "trail",       label: "Trail",         type: "range", min: 0.05, max: 1,    step: 0.01, default: 0.4 },
    { key: "bloom",       label: "Bloom",         type: "range", min: 0,    max: 3,    step: 0.05, default: 0.7 },
    { key: "bloomThresh", label: "Bloom thresh",  type: "range", min: 0,    max: 1,    step: 0.02, default: 0.35 },
  ],

  C: {
    bg: [5 / 255, 6 / 255, 10 / 255],
    maxSegsPerTree: 3000,     // recursion guard inside a single tree
    frontWidth: 0.18,         // how far behind the front the tip glow reaches (arc fraction)
    edgeInset: 0.05,          // seeds are planted within this fraction of the short side
  },

  mount(host) {
    this.dpr = host.dpr;
    this.scene = Synesthesia.GL.createScene(host.canvas, host.dpr);
    if (!this.scene.gl) { console.error("Dendrites: WebGL2 unavailable in this browser."); return; }
    this.W = host.canvas.width; this.H = host.canvas.height;
    this.trees = [];
    this.acc = 0;             // spawn-rate accumulator
    this.pid = 0;
    this.buf = new Float32Array(4096 * 8);
  },
  resize(w, h) { this.W = w; this.H = h; if (this.scene) this.scene.resize(); },
  unmount() { if (this.scene) this.scene.dispose(); this.scene = null; this.trees = []; },

  // distance from (x,y) along unit (ux,uy) to the canvas edge
  edgeDist(x, y, ux, uy) {
    let d = 1e9;
    if (ux > 1e-6) d = Math.min(d, (this.W - x) / ux); else if (ux < -1e-6) d = Math.min(d, -x / ux);
    if (uy > 1e-6) d = Math.min(d, (this.H - y) / uy); else if (uy < -1e-6) d = Math.min(d, -y / uy);
    return Math.max(d, 0);
  },

  /* Recursive forward-walk from the origin. Each step wobbles the heading; side branches fire
     with probability `chance` and start at `len * decay`. Returns a flat sextuple list
     [ax,ay,bx,by,arcA,arcB] with arc normalized 0(root)..1(tip) so a growth front can reveal it. */
  buildBranch(rng, ux, uy, reach, depth, wobble, chance, spread, decay) {
    const segs = [], step = reach / Math.max(6, depth * 5), CAP = this.C.maxSegsPerTree;
    let maxArc = 1e-3, count = 0;
    const grow = (x, y, ang, len, dep, arc) => {
      if (dep <= 0 || len < step || count > CAP) return;
      const steps = Math.max(2, Math.floor(len / step));
      let cx = x, cy = y, a = ang, d = arc;
      for (let i = 0; i < steps && count <= CAP; i++) {
        a += (rng() - 0.5) * wobble;
        const nx = cx + Math.cos(a) * step, ny = cy + Math.sin(a) * step, d2 = d + step;
        segs.push(cx, cy, nx, ny, d, d2); count++;
        if (d2 > maxArc) maxArc = d2;
        cx = nx; cy = ny; d = d2;
        if (dep > 1 && rng() < chance)
          grow(cx, cy, a + (rng() < 0.5 ? 1 : -1) * spread * (0.6 + rng() * 0.7), len * decay, dep - 1, d);
      }
    };
    grow(0, 0, Math.atan2(uy, ux), reach, depth, 0);
    for (let i = 4; i < segs.length; i += 6) { segs[i] /= maxArc; segs[i + 1] /= maxArc; }
    return segs;
  },

  // plant one seed on a random edge, aimed inward
  plant() {
    const p = this.p, W = this.W, H = this.H, md = Math.min(W, H);
    const rng = Math.random;
    const inset = md * this.C.edgeInset;
    const edge = Math.floor(rng() * 4), along = rng();
    let x, y;
    if (edge === 0)      { x = along * W; y = rng() * inset; }
    else if (edge === 1) { x = along * W; y = H - rng() * inset; }
    else if (edge === 2) { x = rng() * inset; y = along * H; }
    else                 { x = W - rng() * inset; y = along * H; }
    const ca = Math.atan2(H * 0.5 - y, W * 0.5 - x);
    const ang = ca + (rng() - 0.5) * p.inwardSpread;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const reach = Math.min(this.edgeDist(x, y, ux, uy), md * (0.2 + 0.6 * p.trunkLen));
    this.trees.push({
      x, y, pid: this.pid++, grown: 0, retiring: 0, fade: 1,
      // geometry is BAKED ONCE — shape params only affect trees planted from now on
      segs: this.buildBranch(rng, ux, uy, reach, Math.round(p.depth), p.wobble,
                             Math.min(Math.max(p.branch * 0.06, 0.02), 0.6), p.spread, p.decay),
    });
  },

  frame(a) {
    const p = this.p, C = this.C, scene = this.scene;
    if (!scene) return;
    const dt = Math.min(a.dt / 1000, 0.05);
    const retire = Math.max(p.retire, 0.05);
    const growth = Math.max(p.growth, 0.01);

    // ---- spawn ----
    this.acc += p.spawnRate * dt;
    while (this.acc >= 1) { this.acc -= 1; this.plant(); }

    // ---- advance, retire, cull ----
    for (let i = this.trees.length - 1; i >= 0; i--) {
      const t = this.trees[i];
      if (!t.retiring) {
        t.grown = Math.min(t.grown + growth * dt, 1);   // INTEGRATED, never re-derived
        if (t.grown >= 1) t.retiring = retire;          // fully grown == dead
      } else {
        t.fade -= dt / retire;
        if (t.fade <= 0) { this.trees.splice(i, 1); continue; }
      }
    }
    // ceiling: if spawning outruns dying, retire the oldest still-growing trees
    let live = 0;
    for (let i = 0; i < this.trees.length; i++) if (!this.trees[i].retiring) live++;
    const cap = Math.max(Math.round(p.maxTrees), 1);
    while (live > cap) {
      let oldest = -1;
      for (let i = 0; i < this.trees.length; i++) {
        const t = this.trees[i];
        if (!t.retiring && (oldest < 0 || t.pid < this.trees[oldest].pid)) oldest = i;
      }
      if (oldest < 0) break;
      this.trees[oldest].retiring = retire;
      live--;
    }

    // ---- build the line batch ----
    const MAX = Synesthesia.GL.MAXLINES;
    const hw = p.width * this.dpr, base = Synesthesia.Color.hsv(p.hue, p.sat, p.val);
    let n = 0;
    for (const t of this.trees) {
      const s = t.segs, grown = t.grown, fade = t.fade;
      for (let i = 0; i + 5 < s.length && n < MAX; i += 6) {
        if (s[i + 4] > grown) continue;                             // not yet reached by the front
        const fmid = (s[i + 4] + s[i + 5]) * 0.5;                   // 0 root .. 1 tip
        const front = Math.max(0, Math.min(1, 1 - (grown - s[i + 5]) / C.frontWidth));
        const alpha = Math.min(fade * (0.65 + front * p.tipGlow), 1);
        // the front glow widens as well as brightens — alpha alone is invisible once `taper`
        // has thinned the tip and the trunk has saturated
        const wmul = Math.max(0.15, 1 - p.taper * fmid) * (1 + front * p.tipGlow * 1.5);
        const rgb = p.rainbow ? Synesthesia.Color.hsv(p.hue + p.rainbow * fmid, p.sat, p.val) : base;
        if (n * 8 + 8 > this.buf.length) {                          // grow the batch buffer
          const nb = new Float32Array(Math.min(MAX, this.buf.length / 8 * 2) * 8);
          nb.set(this.buf); this.buf = nb;
        }
        const o = n * 8;
        this.buf[o]     = t.x + s[i];     this.buf[o + 1] = t.y + s[i + 1];
        this.buf[o + 2] = t.x + s[i + 2]; this.buf[o + 3] = t.y + s[i + 3];
        this.buf[o + 4] = hw * wmul;
        this.buf[o + 5] = rgb[0] * alpha; this.buf[o + 6] = rgb[1] * alpha; this.buf[o + 7] = rgb[2] * alpha;
        n++;
      }
    }

    // ---- render ----
    scene.fade(Math.max(0, Math.min(p.trail, 1)));
    if (n) scene.lines(this.buf, n, { target: "acc", blend: "add" });
    scene.composite(C.bg);
    if (p.bloom > 0) scene.bloom(p.bloom, p.bloomThresh, 1);

    this.stat = this.trees.length + " trees · " + n + " segs";
  },
});
