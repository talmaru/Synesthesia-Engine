"use strict";
/* Tesseract Drive — audio-reactive 4D hypercube.
   Ported to the Synesthesia Player visual system: consumes the shared analysis
   frame (bass/mid/treble/energy/beat/bpm/dt) from core.js instead of
   running its own spectrum, tempo, audio hook, and synth fallback. Hue is
   self-owned via Synesthesia.GL.tempoPhase (core no longer provides a.hue).

   Rotation model (6 planes; w-planes are the "inside-out" inversions):
     BASE spin (tempo-locked, isoclinic):  xy + zw
     bass   -> xw   (w-plane / inversion)  + pulls the 4D camera inward
     mid    -> yw   (w-plane / inversion)
     treble -> yz   (spatial / tumble)
   energy -> overall scale.  beat -> brightness flash. */
/* The 4D rotation mechanics are fixed; nothing here is audio-reactive on its own. Every param is
   a plain slider — attach modulators in the player (⟳) to decide what the music drives.
   Good ones to try: energy → saturation, a beat envelope → pulseFlash, bass → view4Bass. */
Synesthesia.register({
  id: "tesseract",
  label: "Tesseract Drive",

  params: [
    { key: "trail",           label: "Trail",        type: "range", min: 0.05, max: 1,     step: 0.01,   default: 0.5 },
    { key: "saturation",      label: "Saturation",   type: "range", min: 0,    max: 100,   step: 1,      default: 100 },
    { key: "hueWSpread",      label: "4D hue tint",  type: "range", min: 0,    max: 120,   step: 5,      default: 120 },
    { key: "cycleBeats",      label: "Hue cycle (beats)", type: "range", min: 2, max: 96, step: 1,    default: 16 },
    { key: "scaleFrac",       label: "Size",         type: "range", min: 0.05, max: 0.30,  step: 0.005,  default: 0.08 },
    { key: "view4",           label: "4D cam dist",  type: "range", min: 2.2,  max: 6,     step: 0.1,    default: 3.0 },
    { key: "view4Bass",       label: "Bass invert",  type: "range", min: 0,    max: 1.5,   step: 0.05,   default: 0.8 },
    { key: "baseBeatsPerRev", label: "Base spin",    type: "range", min: 4,    max: 64,    step: 1,      default: 32 },
    { key: "bassSpin",        label: "Bass \u2192 xw", type: "range", min: 0,  max: 0.008, step: 0.0002, default: 0.002 },
    { key: "midSpin",         label: "Mid \u2192 yw",  type: "range", min: 0,  max: 0.008, step: 0.0002, default: 0.002 },
    { key: "trebleSpin",      label: "Treble \u2192 yz", type: "range", min: 0, max: 0.008, step: 0.0002, default: 0.002 },
    { key: "bassGain",        label: "Bass gain",    type: "range", min: 0.5,  max: 4,     step: 0.1,    default: 1 },
    { key: "midGain",         label: "Mid gain",     type: "range", min: 0.5,  max: 4,     step: 0.1,    default: 2 },
    { key: "trebleGain",      label: "Treble gain",  type: "range", min: 0.5,  max: 6,     step: 0.1,    default: 3 },
    { key: "pulseFlash",      label: "Beat flash",   type: "range", min: 0,    max: 1,     step: 0.05,   default: 0.4 },
    { key: "scalePump",       label: "Energy swell", type: "range", min: 0,    max: 0.6,   step: 0.02,   default: 0.18 },
  ],

  // fixed constants (not exposed in the panel)
  C: {
    view3: 4.5,
    bandAttack: 0.40, bandRelease: 0.08,
    bassRange: [0, 9], midRange: [10, 39], trebleRange: [40, 100],
    edgeWidth: 1.6, wBright: 0.6, vertexGlow: true,
    hardClearEvery: 1200,
  },

  mount(host) {
    this.cv = host.canvas;
    this.ctx = host.canvas.getContext("2d", { alpha: false });
    this.dpr = host.dpr;
    this.W = this.cv.width; this.H = this.cv.height;
    this.cx = this.W / 2;   this.cy = this.H / 2;

    this.ang = { xy: 0, zw: 0, xw: 0, yw: 0, yz: 0 };
    this.bass = 0; this.mid = 0; this.treble = 0;
    this.beatFlash = 0; this.clearCounter = 0;
    this.proj = new Array(16);
    this.buildGeo();

    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.W, this.H);
  },

  resize(w, h) { this.W = w; this.H = h; this.cx = w / 2; this.cy = h / 2; },
  unmount() {},

  buildGeo() {
    // 16 vertices: each coord +1/-1 in (x,y,z,w)
    this.VERTS = [];
    for (let v = 0; v < 16; v++)
      this.VERTS.push([ (v & 1) ? 1 : -1, (v & 2) ? 1 : -1, (v & 4) ? 1 : -1, (v & 8) ? 1 : -1 ]);
    // 32 edges: vertices differing in exactly one bit
    this.EDGES = [];
    for (let i = 0; i < 16; i++)
      for (let j = i + 1; j < 16; j++) {
        let d = i ^ j, bits = 0; while (d) { bits += d & 1; d >>= 1; }
        if (bits === 1) this.EDGES.push([i, j]);
      }
  },

  rot(p, i, j, a) {
    const c = Math.cos(a), s = Math.sin(a), x = p[i], y = p[j];
    p[i] = x * c - y * s; p[j] = x * s + y * c;
  },

  project(view4, scale) {
    const ang = this.ang, C = this.C;
    for (let v = 0; v < 16; v++) {
      const p = this.VERTS[v].slice();
      this.rot(p, 0, 1, ang.xy);   // xy  base / spatial
      this.rot(p, 1, 2, ang.yz);   // yz  treble / tumble
      this.rot(p, 0, 3, ang.xw);   // xw  bass / inversion
      this.rot(p, 1, 3, ang.yw);   // yw  mid / inversion
      this.rot(p, 2, 3, ang.zw);   // zw  base / inversion
      const w = p[3];
      const k4 = view4 / Math.max(view4 - w, 0.4);              // 4D perspective
      const X = p[0] * k4, Y = p[1] * k4, Z = p[2] * k4;
      const k3 = C.view3 / Math.max(C.view3 - Z, 0.6);          // 3D perspective
      this.proj[v] = { sx: this.cx + X * k3 * scale, sy: this.cy + Y * k3 * scale, wNorm: (w + 2) / 4 };
    }
  },

  frame(a) {
    const p = this.p, C = this.C, ctx = this.ctx;
    const W = this.W, H = this.H, dt = a.dt;

    // bands from the shared smoothed spectrum, using this visual's own gains/ranges
    const bandAvg = (r, g) => {
      let s = 0; for (let i = r[0]; i <= r[1]; i++) s += a.bins[i];
      return Math.min(s / (r[1] - r[0] + 1) * g, 1);
    };
    const ease = (cur, tv) => cur + (tv - cur) * (tv > cur ? C.bandAttack : C.bandRelease);
    this.bass   = ease(this.bass,   bandAvg(C.bassRange,   p.bassGain));
    this.mid    = ease(this.mid,    bandAvg(C.midRange,    p.midGain));
    this.treble = ease(this.treble, bandAvg(C.trebleRange, p.trebleGain));

    if (a.beat) this.beatFlash = 1;

    // tempo-locked base isoclinic spin (xy + zw, equal)
    const beatMs = 60000 / a.bpm;
    const baseRate = (Math.PI * 2) / (p.baseBeatsPerRev * beatMs);
    this.ang.xy += baseRate * dt;
    this.ang.zw += baseRate * dt;
    // bands drive plane velocities
    this.ang.xw += this.bass   * p.bassSpin   * dt;
    this.ang.yw += this.mid    * p.midSpin    * dt;
    this.ang.yz += this.treble * p.trebleSpin * dt;

    const view4 = Math.max(p.view4 - this.bass * p.view4Bass, 2.2);
    const scale = Math.min(W, H) * p.scaleFrac * (1 + a.energy * p.scalePump);
    this.project(view4, scale);

    // trail fade toward pure black; periodic hard reset kills rounding residue
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(0,0,0,${p.trail})`;
    ctx.fillRect(0, 0, W, H);
    if (++this.clearCounter >= C.hardClearEvery) {
      this.clearCounter = 0;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    }

    const wrap = h => { h %= 360; return h < 0 ? h + 360 : h; };
    // hue clock owned here now (core no longer ships a.hue); tempo-locked rainbow
    const hueBase = Synesthesia.GL.tempoPhase(this, a, { beats: p.cycleBeats }) * 360;

    // edges: wide faint glow + thin bright core
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const [ia, ib] of this.EDGES) {
      const pa = this.proj[ia], pb = this.proj[ib];
      const wMid = (pa.wNorm + pb.wNorm) / 2;
      const hue = wrap(hueBase + wMid * p.hueWSpread);
      const bright = Math.min(0.25 + wMid * C.wBright + this.beatFlash * p.pulseFlash, 1);
      const lw = C.edgeWidth * (0.6 + wMid * 0.9) * this.dpr;

      ctx.strokeStyle = `hsla(${hue},${p.saturation}%,55%,${bright * 0.18})`;
      ctx.lineWidth = lw * 3;
      ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy); ctx.lineTo(pb.sx, pb.sy); ctx.stroke();

      ctx.strokeStyle = `hsla(${hue},${p.saturation}%,${60 + wMid * 20}%,${bright})`;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy); ctx.lineTo(pb.sx, pb.sy); ctx.stroke();
    }

    // vertex glows
    if (C.vertexGlow) {
      for (let v = 0; v < 16; v++) {
        const pt = this.proj[v];
        const hue = wrap(hueBase + pt.wNorm * p.hueWSpread);
        const r = (1.5 + pt.wNorm * 3) * this.dpr;
        const g = ctx.createRadialGradient(pt.sx, pt.sy, 0, pt.sx, pt.sy, r * 3);
        g.addColorStop(0, `hsla(${hue},${p.saturation}%,75%,${0.5 + pt.wNorm * 0.4})`);
        g.addColorStop(1, `hsla(${hue},${p.saturation}%,55%,0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(pt.sx, pt.sy, r * 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    ctx.globalCompositeOperation = "source-over";
    this.beatFlash *= 0.90;
  }
});
