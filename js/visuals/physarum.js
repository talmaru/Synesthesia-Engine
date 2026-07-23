"use strict";
/* Physarum — slime mould. Agents and a field that feed each other.

   Everything else in this project is EITHER a particle system OR a field simulation. This is the
   one where they are coupled: agents write into an environment, then read that same environment
   back as their only input. That indirect coordination — stigmergy — is the entire mechanism.

   Each agent does something trivial:
       sense the trail slightly ahead-left, ahead, and ahead-right
       turn toward whichever is strongest
       step forward, and deposit a little trail behind it
   The trail map blurs and decays. That is the whole rule set.

   What emerges is nothing like what the rules say: veins appear, thicken wherever traffic
   reinforces them, compete for territory, starve each other out, and reorganise into networks
   that look like an organism solving a problem. Nothing here knows what a "vein" is.

   WHY IT HOLDS ATTENTION (the Ripples principle): the randomness lives in the INPUT (per-agent
   jitter, beat scatters) while the rules stay perfectly lawful — and the TRAIL MAP IS MEMORY.
   It is a literal accumulating record of everywhere anything has been, so the current frame is
   a history, not a snapshot. That is why structure can build over tens of seconds.

   SPECIES (1-3) share the space. Each deposits into its own channel and senses its own trail,
   optionally repelled by the others (`rivalry`). Drive the three `mix` weights from different
   frequency bands and a bass network and a treble network fight over territory, ground changing
   hands as the mix shifts. DEFAULT IS 1: splitting a fixed agent budget three ways leaves each
   species too sparse to organise, and three weak diffuse fields summed together is exactly the
   grey mush this algorithm fails into. Raise `agents` with `species` if you want the contest —
   measured: 1 species reached variation 4.3 with 59% open space, 3 species only 1.4 and 1%.

   AGENT DENSITY IS THE MAIN DIAL. A cell fed every frame settles at deposit/(1-decay), so if
   agents approach cell count the whole field saturates and there is no darkness for veins to
   stand against. Keep agents well under the grid size.

   COST: about 7.5ms/frame at the defaults. Species 3 roughly TRIPLES it (three trail layers to
   blur, and `rivalry` makes every agent sample every rival channel) — measured 22ms with 54k
   agents. Treat the contest as an opt-in experiment, not a default.

   TUNING WARNING: the good behaviour lives in a narrow band. Too little decay and it saturates
   to a smear; too much and it never forms structure. `sensorAngle` alone swings it between long
   straight highways and a dense fuzzy mesh. Expect to hunt for the sweet spot.

   Nothing is audio-reactive by itself; attach modulators in the player (⟳). */
Synesthesia.register({
  id: "physarum",
  label: "Physarum",

  params: [
    // ---- the colony ----
    { key: "agents",     label: "Agents",         type: "range", min: 2000, max: 120000, step: 1000, default: 18000 },
    { key: "resolution", label: "Resolution",     type: "range", min: 96,   max: 320, step: 8,    default: 176 },
    { key: "species",    label: "Species",        type: "range", min: 1,    max: 3,   step: 1,    default: 1 },
    { key: "mixA",       label: "· share A",      type: "range", min: 0,    max: 1,   step: 0.02, default: 1 },
    { key: "mixB",       label: "· share B",      type: "range", min: 0,    max: 1,   step: 0.02, default: 1 },
    { key: "mixC",       label: "· share C",      type: "range", min: 0,    max: 1,   step: 0.02, default: 1 },
    // ---- behaviour: this is where the character lives ----
    { key: "sensorAngle",label: "Sensor angle°",  type: "range", min: 5,    max: 90,  step: 1,    default: 26 },
    { key: "sensorDist", label: "Sensor dist",    type: "range", min: 1,    max: 30,  step: 0.5,  default: 9 },
    { key: "turnSpeed",  label: "Turn speed°",    type: "range", min: 1,    max: 90,  step: 1,    default: 32 },
    { key: "jitter",     label: "Wander",         type: "range", min: 0,    max: 40,  step: 0.5,  default: 6 },
    { key: "speed",      label: "Speed",          type: "range", min: 0.2,  max: 3,   step: 0.05, default: 1 },
    { key: "rivalry",    label: "Rivalry",        type: "range", min: 0,    max: 2,   step: 0.05, default: 0.6 },
    // ---- the trail ----
    { key: "deposit",    label: "Deposit",        type: "range", min: 0.05, max: 2,   step: 0.05, default: 0.7 },
    { key: "decay",      label: "Trail memory",   type: "range", min: 0.80, max: 0.995, step: 0.005, default: 0.955 },
    { key: "blur",       label: "Diffusion",      type: "range", min: 0,    max: 1,   step: 0.02, default: 0.42 },
    { key: "beatScatter",label: "Beat scatter %", type: "range", min: 0,    max: 20,  step: 0.5,  default: 0 },
    // ---- look ----
    { key: "gain",       label: "Gain",           type: "range", min: 0.02, max: 1.5, step: 0.01, default: 0.18 },
    { key: "coreWhite",  label: "Hot core",       type: "range", min: 0,    max: 1,   step: 0.02, default: 0 },
    { key: "hueA",       label: "Hue A",          type: "range", min: 0,    max: 360, step: 1,    default: 190 },
    { key: "hueB",       label: "Hue B",          type: "range", min: 0,    max: 360, step: 1,    default: 305 },
    { key: "hueC",       label: "Hue C",          type: "range", min: 0,    max: 360, step: 1,    default: 45 },
    { key: "sat",        label: "Saturation",     type: "range", min: 0,    max: 1,   step: 0.02, default: 0.8 },
    { key: "brightness", label: "Brightness",     type: "range", min: 0.2,  max: 3,   step: 0.05, default: 1 },
  ],

  C: { maxCells: 160000, D2R: Math.PI / 180 },

  mount(host) {
    this.cv = host.canvas;
    this.ctx = host.canvas.getContext("2d", { alpha: false });
    this.W = this.cv.width; this.H = this.cv.height;
    this.grid = null; this.nAgents = 0;
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.W, this.H);
  },
  resize(w, h) { this.W = w; this.H = h; this.grid = null; },
  unmount() { this.trail = null; this.tmp = null; this.ax = null; },

  build(res) {
    const aspect = this.W / Math.max(this.H, 1);
    let ny = Math.max(48, Math.round(res)), nx = Math.max(48, Math.round(res * aspect));
    if (nx * ny > this.C.maxCells) {
      const k = Math.sqrt(this.C.maxCells / (nx * ny));
      nx = Math.max(48, Math.round(nx * k)); ny = Math.max(48, Math.round(ny * k));
    }
    this.nx = nx; this.ny = ny;
    const n = nx * ny;
    // one trail layer per species, plus a scratch layer for the blur
    this.trail = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.tmp = new Float32Array(n);
    this.field = document.createElement("canvas");
    this.field.width = nx; this.field.height = ny;
    this.fctx = this.field.getContext("2d");
    this.img = this.fctx.createImageData(nx, ny);
    this.grid = res;
  },

  spawn(count) {
    const nx = this.nx, ny = this.ny;
    const old = this.nAgents || 0;
    const ax = new Float32Array(count), ay = new Float32Array(count);
    const aa = new Float32Array(count), asp = new Uint8Array(count);
    if (this.ax) {   // keep the colony we already have; only fill the new tail
      const keep = Math.min(old, count);
      ax.set(this.ax.subarray(0, keep)); ay.set(this.ay.subarray(0, keep));
      aa.set(this.aa.subarray(0, keep)); asp.set(this.asp.subarray(0, keep));
      for (let i = keep; i < count; i++) {
        ax[i] = Math.random() * nx; ay[i] = Math.random() * ny;
        aa[i] = Math.random() * Math.PI * 2;
      }
    } else {
      for (let i = 0; i < count; i++) {
        ax[i] = Math.random() * nx; ay[i] = Math.random() * ny;
        aa[i] = Math.random() * Math.PI * 2;
      }
    }
    this.ax = ax; this.ay = ay; this.aa = aa; this.asp = asp;
    this.nAgents = count;
  },

  frame(a) {
    const p = this.p, C = this.C;
    const res = Math.round(p.resolution);
    if (!this.grid || this.grid !== res) { this.build(res); this.ax = null; this.nAgents = 0; }
    const want = Math.round(p.agents);
    if (this.nAgents !== want) this.spawn(want);

    const nx = this.nx, ny = this.ny, N = this.nAgents;
    const trail = this.trail, ax = this.ax, ay = this.ay, aa = this.aa, asp = this.asp;
    const nSp = Math.max(1, Math.min(3, Math.round(p.species)));

    // species shares -> cumulative index thresholds. Agents are assigned by INDEX, so shifting
    // the weights converts territory rather than teleporting anything: an agent keeps its place
    // and simply changes allegiance, which is exactly what a contested boundary should look like.
    const w = [nSp > 0 ? Math.max(p.mixA, 0) : 0, nSp > 1 ? Math.max(p.mixB, 0) : 0, nSp > 2 ? Math.max(p.mixC, 0) : 0];
    const wsum = (w[0] + w[1] + w[2]) || 1;
    const cut0 = (w[0] / wsum) * N, cut1 = cut0 + (w[1] / wsum) * N;

    const sa = p.sensorAngle * C.D2R, sd = p.sensorDist;
    const turn = p.turnSpeed * C.D2R, jit = p.jitter * C.D2R;
    const spd = p.speed, dep = p.deposit, riv = p.rivalry;

    // ---- agents: sense, steer, move, deposit ----
    for (let i = 0; i < N; i++) {
      const sp = i < cut0 ? 0 : (i < cut1 ? 1 : 2);
      asp[i] = sp;
      const own = trail[sp];
      const x = ax[i], y = ay[i], ang = aa[i];

      // three samples: ahead-left, ahead, ahead-right. Nearest-neighbour on purpose — bilinear
      // costs 4x here and the blur already smooths the field far more than sampling error does.
      let best = -1e30, bestK = 0;
      for (let k = -1; k <= 1; k++) {
        const t = ang + k * sa;
        let sx = (x + Math.cos(t) * sd) | 0, sy = (y + Math.sin(t) * sd) | 0;
        sx %= nx; if (sx < 0) sx += nx;
        sy %= ny; if (sy < 0) sy += ny;
        const idx = sy * nx + sx;
        let v = own[idx];
        if (riv > 0 && nSp > 1) {            // rivals make a cell less attractive
          for (let o = 0; o < nSp; o++) if (o !== sp) v -= trail[o][idx] * riv;
        }
        if (v > best) { best = v; bestK = k; }
      }

      let na = ang + bestK * turn + (Math.random() - 0.5) * jit;
      let nxp = x + Math.cos(na) * spd, nyp = y + Math.sin(na) * spd;
      // wrap: a torus keeps networks continuous and avoids an edge crust
      nxp %= nx; if (nxp < 0) nxp += nx;
      nyp %= ny; if (nyp < 0) nyp += ny;
      ax[i] = nxp; ay[i] = nyp; aa[i] = na;
      own[((nyp | 0) * nx + (nxp | 0))] += dep;
    }

    // ---- beat scatter: fling a slice of the colony somewhere new ----
    if (a.beat && p.beatScatter > 0) {
      const n = Math.round(N * p.beatScatter * 0.01);
      for (let j = 0; j < n; j++) {
        const i = (Math.random() * N) | 0;
        ax[i] = Math.random() * nx; ay[i] = Math.random() * ny;
        aa[i] = Math.random() * Math.PI * 2;
      }
    }

    // ---- diffuse + decay ----
    // 5-tap cross rather than a full 3x3: a third of the samples, and after decay the visual
    // difference is nil. `blur` mixes between "no spreading" and "fully averaged with neighbours".
    const b = p.blur, keep = 1 - b, dec = p.decay, tmp = this.tmp;
    for (let s = 0; s < nSp; s++) {
      const t = trail[s];
      for (let y = 0; y < ny; y++) {
        const row = y * nx;
        const up = (y > 0 ? row - nx : (ny - 1) * nx);
        const dn = (y < ny - 1 ? row + nx : 0);
        for (let x = 0; x < nx; x++) {
          const i = row + x;
          const l = x > 0 ? i - 1 : row + nx - 1;
          const r = x < nx - 1 ? i + 1 : row;
          const avg = (t[i] + t[l] + t[r] + t[up + x] + t[dn + x]) * 0.2;
          tmp[i] = (t[i] * keep + avg * b) * dec;
        }
      }
      t.set(tmp);
    }

    // ---- render ----
    // BRIGHTNESS and COLOUR are separated on purpose. The obvious approach — tone-map each RGB
    // channel of the summed hue-weighted trail — blows out to WHITE at high density: even a hue's
    // small channel eventually saturates, so the densest (most interesting) veins lose their
    // colour exactly where you most want it. Instead: tone-map the DENSITY to a brightness, and
    // carry the hue through unchanged. A dense vein is then a bright SATURATED colour, never
    // white — unless `coreWhite` is dialled up to deliberately re-introduce a hot core.
    const hsv = Synesthesia.Color.hsv;
    const cols = [hsv(p.hueA, p.sat, 1), hsv(p.hueB, p.sat, 1), hsv(p.hueC, p.sat, 1)];
    const img = this.img, d = img.data, gain = p.gain, bright = p.brightness, core = p.coreWhite;
    const n = nx * ny;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let T = 0, r = 0, g = 0, bl = 0;
      for (let s = 0; s < nSp; s++) {
        const v = trail[s][i]; if (v <= 0) continue;
        if (v > peak) peak = v;
        const c = cols[s];
        T += v; r += c[0] * v; g += c[1] * v; bl += c[2] * v;   // r/g/bl accumulate hue*density
      }
      const o = i * 4;
      if (T <= 0) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; continue; }
      // hue = density-weighted blend of the present species (contested cells mix colours, not white)
      const inv = 1 / T; r *= inv; g *= inv; bl *= inv;
      // brightness from the TOTAL density, tone-mapped so hubs compress instead of clipping
      let inten = 1 - Math.exp(-T * gain);
      // optional hot core: lift toward white only at high intensity, only if asked for
      const wl = core > 0 ? core * inten * inten : 0;
      const ib = inten * bright;
      d[o]     = Math.min(255, (r * ib + wl) * 255);
      d[o + 1] = Math.min(255, (g * ib + wl) * 255);
      d[o + 2] = Math.min(255, (bl * ib + wl) * 255);
      d[o + 3] = 255;
    }
    this.fctx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.field, 0, 0, nx, ny, 0, 0, this.W, this.H);

    this.stat = nx + "x" + ny + " · " + (N / 1000).toFixed(0) + "k agents · peak " + peak.toFixed(2);
  },
});
