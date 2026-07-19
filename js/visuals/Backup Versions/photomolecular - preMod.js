"use strict";
/* Photomolecular Field — an audio-reactive artificial chemistry (GPU render via Synesthesia.GL).

   A FIXED pool of particles (conservation — nothing is created or destroyed, matter just
   changes form). Three species, each a "shape brick" defined by a valence + a preferred bond
   angle:
     CAP   (valence 1)          — terminates a chain
     LINK  (valence 2, 120°)    — chains that curl into rings
     HUB   (valence 3, 120°)    — branch points → hexagonal sheets

   Four coupled rules make the emergence:
     1. COLLISION   — a stiff short-range repulsion so particles can never merge (excluded volume).
     2. MATRIX      — a small ASYMMETRIC type×type attraction (non-reciprocal → chasing, never settles).
     3. BONDS       — valence-limited springs form when two compatible particles meet slowly; they
                      snap when overstretched. Bonds are drawn as glowing sticks.
     4. ANGLES      — a bonded particle pushes its bonds toward its preferred angle → real geometry.
   And the lifecycle that keeps it out of equilibrium:
     5. REACTION    — strain + the beat pump HEAT into a particle; past a threshold it DETONATES:
                      breaks its bonds, flings the fragments apart, dumps heat into neighbours (chain
                      reactions), and TRANSMUTES to the next species. build → react → release → rebuild.

   Music is the temperature: bass = cohesion, the beat = a heat pulse that melts/reacts, energy scales
   the release. The field breathes across the freeze↔melt line in time with the track. */

(function () {
  const CAP = 0, LINK = 1, HUB = 2;
  const D2R = Math.PI / 180;

  // species: valence (max bonds), preferred angle between bonds, and draw size
  const SPECIES = [
    { valence: 1, angle: 0,          size: 2.3 },   // CAP
    { valence: 2, angle: 120 * D2R,  size: 2.9 },   // LINK
    { valence: 3, angle: 120 * D2R,  size: 3.5 },   // HUB
  ];
  // MATRIX[a][b] = long-range acceleration on species a FROM species b (+ attract, − repel). Asymmetric.
  const MATRIX = [
    [ 0.02,  0.10,  0.12 ],   // CAP  seeks LINK/HUB
    [ 0.06, -0.04,  0.08 ],   // LINK mild self-spacing, seeks caps/hubs
    [ 0.05,  0.10, -0.10 ],   // HUB  repels other hubs (spread the branch points)
  ];
  const CORE_K = 0.6, SPRING_H = 8, ANGLE_H = 3;   // heat gains from collision-free spacing / strain / angle
  const TARGET = [0.35, 0.45, 0.20];               // desired CAP/LINK/HUB share (reactions steer the mix here)
  const CLUSTER_N = 5, BEAT_BOOST = 0.5;           // on the beat, crowded (nbr>5) atoms get a big heat kick → clusters detonate on the beat
  const BLAST_F = 4.5;                             // detonation shockwave impulse (shoves ALL nearby particles out)
  const RING_SEGS = 22;

  function hex2rgb(hex) {
    const n = parseInt((hex || "#ffffff").slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  // do segments A-B and C-D properly cross? (strict; shared or collinear endpoints don't count)
  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 &&
           o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
  }

  // Registered as a WRAPPABLE core: the `photomolecular` graph doc wraps it and exposes its knobs
  // (fieldStrength, beatHeat, clusterBlast, reactivity, glowScale…) to the node graph, so the
  // audio-reactive links live in the editor while the chemistry sim itself is untouched.
  Synesthesia.Graph.registerWrappable({
    id: "photomolecularCore",
    label: "Photomolecular Field",

    params: [
      { key: "fieldStrength", label: "Field strength",      type: "range", min: 0.2, max: 3,   step: 0.05, default: 1 },
      { key: "bondForm",      label: "Bond formation",      type: "range", min: 0,   max: 1,   step: 0.02, default: 0.5 },
      { key: "bondStiff",     label: "Bond stiffness",      type: "range", min: 0.02, max: 0.4, step: 0.02, default: 0.16 },
      { key: "angleStiff",    label: "Angle stiffness",     type: "range", min: 0,   max: 1,   step: 0.05, default: 0.5 },
      { key: "reactivity",    label: "Reactivity",          type: "range", min: 0.3, max: 2.5, step: 0.05, default: 1 },
      { key: "beatHeat",      label: "Beat heat",           type: "range", min: 0,   max: 3,   step: 0.1,  default: 1 },
      { key: "clusterBlast",  label: "Cluster blast",       type: "range", min: 0,   max: 2,   step: 0.05, default: 1 },
      { key: "density",       label: "Population",          type: "range", min: 0.3, max: 2,   step: 0.05, default: 1 },
      { key: "interactRadius",label: "Interaction radius",  type: "range", min: 40,  max: 160, step: 5,    default: 95 },
      { key: "trail",         label: "Trail",               type: "range", min: 0.05, max: 1,  step: 0.01, default: 0.18 },
      { key: "glowScale",     label: "Glow size",           type: "range", min: 0.5, max: 3,   step: 0.1,  default: 1 },
      { key: "softness",      label: "Glow softness",       type: "range", min: 0.5, max: 4,   step: 0.1,  default: 1.6 },
      { key: "capColor",      label: "Cap color",           type: "color", default: "#ff8b5e" },
      { key: "linkColor",     label: "Link color",          type: "color", default: "#5eead4" },
      { key: "hubColor",      label: "Hub color",           type: "color", default: "#a78bfa" },
      { key: "bondColor",     label: "Bond color",          type: "color", default: "#cfe3ff" },
      { key: "ringColor",     label: "Beat ring color",     type: "color", default: "#ffe066" },
    ],

    mount(host) {
      this.dpr = host.dpr;
      this.scene = Synesthesia.GL.createScene(host.canvas, host.dpr);
      if (!this.scene.gl) { console.error("Photomolecular: WebGL2 unavailable in this browser."); return; }
      this.particles = [];
      this.flashRings = [];
      this._ringScratch = new Float32Array(1024 * 8);
      this._bondScratch = new Float32Array(4096 * 8);
      const W = host.canvas.width, H = host.canvas.height;
      const n = Math.round(260 * (this.p.density || 1));
      for (let i = 0; i < n; i++) this._add(W, H);
    },
    resize() { if (this.scene) this.scene.resize(); },
    unmount() { if (this.scene) this.scene.dispose(); this.scene = null; this.particles = []; this.flashRings = []; },

    // --- pool management (conservation: fixed indices so bonds can reference by index) ---
    _add(W, H) {
      const dpr = this.dpr, r = Math.random();
      const type = r < 0.35 ? CAP : r < 0.8 ? LINK : HUB;
      this.particles.push({
        type, x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.6 * dpr, vy: (Math.random() - 0.5) * 0.6 * dpr,
        fx: 0, fy: 0, heat: 0, nbr: 0, bonds: [],
      });
    },
    _sever(i) {                          // remove particle i from all its partners' bond lists
      const ps = this.particles, b = ps[i].bonds;
      for (let k = 0; k < b.length; k++) { const arr = ps[b[k]].bonds, ix = arr.indexOf(i); if (ix >= 0) arr.splice(ix, 1); }
      b.length = 0;
    },
    _bond(i, j) {                        // form a symmetric bond if both have free valence
      const ps = this.particles;
      if (ps[i].bonds.length >= SPECIES[ps[i].type].valence) return;
      if (ps[j].bonds.length >= SPECIES[ps[j].type].valence) return;
      if (ps[i].bonds.indexOf(j) >= 0) return;
      ps[i].bonds.push(j); ps[j].bonds.push(i);
    },
    _break(i, j) {
      const ps = this.particles, a = ps[i].bonds, bx = a.indexOf(j); if (bx >= 0) a.splice(bx, 1);
      const c = ps[j].bonds, cx = c.indexOf(i); if (cx >= 0) c.splice(cx, 1);
    },
    // label each particle with its molecule (connected component) id — O(N + bonds)
    _components(N) {
      const ps = this.particles, comp = new Int32Array(N).fill(-1); let cid = 0; const st = [];
      for (let i = 0; i < N; i++) {
        if (comp[i] >= 0) continue; comp[i] = cid; st.length = 0; st.push(i);
        while (st.length) { const x = st.pop(), bx = ps[x].bonds; for (let k = 0; k < bx.length; k++) { const y = bx[k]; if (comp[y] < 0) { comp[y] = cid; st.push(y); } } }
        cid++;
      }
      return comp;
    },
    // would a new bond i-j cross a DIFFERENT molecule's bond? (stops two molecules stitching through each
    // other, but lets a molecule grow its own bonds freely even when another drifts nearby). 3×3 block scan.
    _crosses(i, j, grid, cell, comp) {
      const ps = this.particles, A = ps[i], B = ps[j];
      const cx = Math.floor(A.x / cell), cy = Math.floor(A.y / cell);
      for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
        const arr = grid.get((cx + gx) + "," + (cy + gy)); if (!arr) continue;
        for (let m = 0; m < arr.length; m++) {
          const a = arr[m]; if (comp[a] === comp[i] || comp[a] === comp[j]) continue;   // i's or j's own molecule → not a stitch
          const bl = ps[a].bonds;
          for (let k = 0; k < bl.length; k++) {
            const b = bl[k]; if (b <= a) continue;                         // each bond once
            if (a === i || a === j || b === i || b === j) continue;         // shares an endpoint → adjacent, not crossing
            if (segCross(A.x, A.y, B.x, B.y, ps[a].x, ps[a].y, ps[b].x, ps[b].y)) return true;
          }
        }
      }
      return false;
    },

    _buildGrid(cell) {
      const grid = new Map(), ps = this.particles;
      for (let i = 0; i < ps.length; i++) {
        const key = Math.floor(ps[i].x / cell) + "," + Math.floor(ps[i].y / cell);
        let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); } arr.push(i);
      }
      return grid;
    },

    // push a bonded pair's angle toward the centre particle's preferred angle (3-body term)
    _angleForce(i, a, b, target, k) {
      const ps = this.particles, q = ps[i];
      let iax = ps[a].x - q.x, iay = ps[a].y - q.y, ibx = ps[b].x - q.x, iby = ps[b].y - q.y;
      const la = Math.hypot(iax, iay) || 1e-3, lb = Math.hypot(ibx, iby) || 1e-3;
      iax /= la; iay /= la; ibx /= lb; iby /= lb;
      let cs = iax * ibx + iay * iby; cs = cs < -1 ? -1 : cs > 1 ? 1 : cs;
      const ang = Math.acos(cs), diff = target - ang;
      let tax = -iay, tay = iax; if (tax * ibx + tay * iby > 0) { tax = -tax; tay = -tay; }   // tangent away from b
      let tbx = -iby, tby = ibx; if (tbx * iax + tby * iay > 0) { tbx = -tbx; tby = -tby; }   // tangent away from a
      const f = k * diff;
      ps[a].fx += tax * f; ps[a].fy += tay * f;
      ps[b].fx += tbx * f; ps[b].fy += tby * f;
      q.fx -= (tax + tbx) * f; q.fy -= (tay + tby) * f;
      return Math.abs(diff);
    },

    _buildRingData() {
      const rings = this.flashRings, data = this._ringScratch, dpr = this.dpr, [rr, gg, bb] = this.ringRGB;
      let o = 0, count = 0;
      for (let ri = 0; ri < rings.length && count < 1024; ri++) {
        const ring = rings[ri], al = ring.alpha; if (al <= 0) continue;
        for (let s = 0; s < RING_SEGS && count < 1024; s++) {
          const t0 = (s / RING_SEGS) * Math.PI * 2, t1 = ((s + 1) / RING_SEGS) * Math.PI * 2;
          data[o++] = ring.x + Math.cos(t0) * ring.r; data[o++] = ring.y + Math.sin(t0) * ring.r;
          data[o++] = ring.x + Math.cos(t1) * ring.r; data[o++] = ring.y + Math.sin(t1) * ring.r;
          data[o++] = 0.7 * dpr; data[o++] = rr * al; data[o++] = gg * al; data[o++] = bb * al; count++;
        }
      }
      return count;
    },

    frame(a) {
      const scene = this.scene; if (!scene || !scene.gl) return;
      const p = this.p, dpr = this.dpr, ps = this.particles;
      const W = scene.canvas.width, H = scene.canvas.height;
      const dt = Math.min(0.05, (a.dt || 16.7) / 1000);
      const bass = a.bass || 0, energy = a.energy != null ? a.energy : (a.bass + a.mid + a.treble) / 3;

      const COL = [hex2rgb(p.capColor), hex2rgb(p.linkColor), hex2rgb(p.hubColor)];
      const bondRGB = hex2rgb(p.bondColor); this.ringRGB = hex2rgb(p.ringColor);

      const REST = 16 * dpr, CORE = 11 * dpr, FORM_D = REST * 1.35, BREAK_D = REST * 2.3;
      const CROWD_R = REST * 1.2, BLAST_R = 48 * dpr;   // counts cluster membership (bonded + close neighbours)
      const INTERACT = p.interactRadius * dpr, cell = INTERACT;
      const fieldK = p.fieldStrength * (0.5 + bass * 1.4);      // bass = cohesion
      const reactThresh = 6 / p.reactivity;

      // conservation: nudge population toward the density target (safe: only touch the last index)
      const targetN = Math.round(260 * p.density);
      if (ps.length < targetN) this._add(W, H);
      else if (ps.length > targetN) { this._sever(ps.length - 1); ps.pop(); }
      const N = ps.length;

      for (let i = 0; i < N; i++) { ps[i].fx = 0; ps[i].fy = 0; ps[i].nbr = 0; }
      const comp0 = this._components(N);   // molecule labels (this frame's start) for the bond-formation guard

      // ---- 1+2: collision + asymmetric matrix, each unordered pair once (via grid neighbours) ----
      const grid = this._buildGrid(cell);
      for (let i = 0; i < N; i++) {
        const q = ps[i], cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
        for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
          const arr = grid.get((cx + gx) + "," + (cy + gy)); if (!arr) continue;
          for (let m = 0; m < arr.length; m++) {
            const j = arr[m]; if (j <= i) continue;
            const o = ps[j], dx = o.x - q.x, dy = o.y - q.y, d = Math.hypot(dx, dy) || 1e-3;
            if (d > INTERACT) continue;
            if (d < CROWD_R) { q.nbr++; o.nbr++; }                // local packing → crowding pressure
            const ux = dx / d, uy = dy / d;
            if (d < CORE) {                                       // stiff excluded volume (no merging)
              const rep = (CORE - d) / CORE * CORE_K;
              q.fx -= ux * rep; q.fy -= uy * rep; o.fx += ux * rep; o.fy += uy * rep;
            } else {                                              // non-reciprocal attraction
              const fall = 1 - d / INTERACT;
              const fi = MATRIX[q.type][o.type] * fieldK * fall, fj = MATRIX[o.type][q.type] * fieldK * fall;
              q.fx += ux * fi; q.fy += uy * fi; o.fx -= ux * fj; o.fy -= uy * fj;
            }
            // ---- 3: bond formation — compatible, both free valence, meeting slowly, and cool ----
            if (d < FORM_D && !(q.type === CAP && o.type === CAP)) {
              const rel = Math.hypot(q.vx - o.vx, q.vy - o.vy), cool = Math.max(0, 1 - rel / (2 * dpr));
              if (cool > 0 && Math.random() < p.bondForm * cool * 0.4 && !this._crosses(i, j, grid, cell, comp0)) this._bond(i, j);
            }
          }
        }
      }

      // ---- 3: bond springs (+ strain heat, + collect overstretched breaks) ----
      const breaks = [];
      for (let i = 0; i < N; i++) {
        const q = ps[i], bl = q.bonds;
        for (let k = 0; k < bl.length; k++) {
          const j = bl[k]; if (j <= i) continue;
          const o = ps[j], dx = o.x - q.x, dy = o.y - q.y, d = Math.hypot(dx, dy) || 1e-3, ux = dx / d, uy = dy / d;
          if (d > BREAK_D) { breaks.push(i, j); continue; }
          const f = p.bondStiff * (d - REST);                   // spring toward rest length
          q.fx += ux * f; q.fy += uy * f; o.fx -= ux * f; o.fy -= uy * f;
          const strain = Math.abs(d - REST) / REST; q.heat += strain * dt * SPRING_H; o.heat += strain * dt * SPRING_H;
        }
      }

      // ---- 4: bond angles → geometry (+ angle-strain heat) ----
      for (let i = 0; i < N; i++) {
        const q = ps[i], bl = q.bonds; if (bl.length < 2) continue;
        const target = SPECIES[q.type].angle;
        for (let x = 0; x < bl.length; x++) for (let y = x + 1; y < bl.length; y++) {
          const strain = this._angleForce(i, bl[x], bl[y], target, p.angleStiff);
          q.heat += strain * dt * ANGLE_H;
        }
      }

      // ---- 4b: crossing-snap heal — dissolve INTER-molecular tangles (two molecules threaded through each
      // other). Label connected components, then break the longer of any crossing bond pair whose bonds
      // belong to DIFFERENT molecules. (Intra-molecular self-crossings are left for the angle forces to fix,
      // so a flexing molecule isn't torn apart.)
      const comp = this._components(N);   // fresh labels (bonds changed this frame)
      const xBreaks = [];
      for (let i = 0; i < N; i++) {
        const A = ps[i], bl = A.bonds;
        for (let k = 0; k < bl.length; k++) {
          const j = bl[k]; if (j <= i) continue;
          const B = ps[j], cx = Math.floor(A.x / cell), cy = Math.floor(A.y / cell);
          for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
            const arr = grid.get((cx + gx) + "," + (cy + gy)); if (!arr) continue;
            for (let m = 0; m < arr.length; m++) {
              const a2 = arr[m]; if (comp[a2] === comp[i]) continue;         // same molecule → leave it (angle forces handle it)
              const bl2 = ps[a2].bonds;
              for (let n = 0; n < bl2.length; n++) {
                const b2 = bl2[n]; if (b2 <= a2) continue;
                if (a2 === i || a2 === j || b2 === i || b2 === j) continue;   // adjacent/self
                if (segCross(A.x, A.y, B.x, B.y, ps[a2].x, ps[a2].y, ps[b2].x, ps[b2].y)) {
                  const l1 = Math.hypot(B.x - A.x, B.y - A.y), l2 = Math.hypot(ps[b2].x - ps[a2].x, ps[b2].y - ps[a2].y);
                  if (l1 >= l2) xBreaks.push(i, j); else xBreaks.push(a2, b2);
                }
              }
            }
          }
        }
      }
      for (let k = 0; k < xBreaks.length; k += 2) this._break(xBreaks[k], xBreaks[k + 1]);

      // ---- 5: the beat pumps heat (melt), hitting CROWDED clusters hardest so they detonate & spray apart ----
      if (a.beat) {
        const pulse = p.beatHeat * (0.5 + energy) * 1.6;
        for (let i = 0; i < N; i++) { const boost = 1 + Math.max(0, ps[i].nbr - CLUSTER_N) * BEAT_BOOST * p.clusterBlast; ps[i].heat += pulse * (0.6 + Math.random() * 0.5) * boost; }
      }

      // ---- 5: reactions — detonate over-heated particles (break, transmute, release, chain) ----
      const detonators = [], count = [0, 0, 0];
      for (let i = 0; i < N; i++) { count[ps[i].type]++; if (ps[i].heat > reactThresh) detonators.push(i); }
      for (let di = 0; di < detonators.length; di++) {
        const i = detonators[di], q = ps[i];
        this.flashRings.push({ x: q.x, y: q.y, r: 2 * dpr, alpha: 0.55 });
        const bl = q.bonds.slice();
        for (let k = 0; k < bl.length; k++) {
          const j = bl[k], o = ps[j];
          let ex = o.x - q.x, ey = o.y - q.y, dd = Math.hypot(ex, ey) || 1; ex /= dd; ey /= dd;
          const boost = (2.4 + Math.random() * 2.2) * dpr;      // fling the fragments apart
          o.vx += ex * boost; o.vy += ey * boost; q.vx -= ex * boost * 0.5; q.vy -= ey * boost * 0.5;
          o.heat += reactThresh * 0.3;                           // chain along the molecule's OWN bonds (unravels it)
          this._break(i, j);
        }
        // SHOCKWAVE: shove EVERY nearby particle radially outward (not just bonded ones) so a jammed,
        // mostly-unbonded cluster actually disperses; carries a little heat to cascade through the clump.
        const bx = Math.floor(q.x / cell), by = Math.floor(q.y / cell);
        for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) {
          const arr = grid.get((bx + gx) + "," + (by + gy)); if (!arr) continue;
          for (let m = 0; m < arr.length; m++) {
            const jj = arr[m]; if (jj === i) continue;
            const o = ps[jj]; let ex = o.x - q.x, ey = o.y - q.y, dd = Math.hypot(ex, ey);
            if (dd > BLAST_R || dd < 1e-3) continue; ex /= dd; ey /= dd;
            const k2 = (1 - dd / BLAST_R) * BLAST_F * p.clusterBlast * dpr;
            o.vx += ex * k2; o.vy += ey * k2;   // pure kinetic push — does NOT ignite neighbours (no field-wide cascade)
          }
        }
        // TRANSMUTE homeostatically toward a TARGET species mix: become whichever other species is most
        // under its target share. Reactions thus recycle matter into what the field is short on — this
        // counters the fact that hubs (most bonds) react fastest, keeping all three species in play.
        let best = -1, bestDef = -Infinity;
        for (let t = 0; t < SPECIES.length; t++) { if (t === q.type) continue; const def = TARGET[t] * N - count[t]; if (def > bestDef) { bestDef = def; best = t; } }
        count[q.type]--; count[best]++; q.type = best; q.heat = 0;
      }

      // ---- integrate + thermal decay + hard walls (particles locked in the window) ----
      for (let i = 0; i < N; i++) {
        const q = ps[i];
        q.vx = (q.vx + q.fx * dpr * dt * 60) * 0.965; q.vy = (q.vy + q.fy * dpr * dt * 60) * 0.965;
        q.x += q.vx; q.y += q.vy; q.heat *= 0.94;
        const wr = SPECIES[q.type].size * dpr, e = 0.9;
        if (q.x < wr) { q.x = wr; q.vx = Math.abs(q.vx) * e; } else if (q.x > W - wr) { q.x = W - wr; q.vx = -Math.abs(q.vx) * e; }
        if (q.y < wr) { q.y = wr; q.vy = Math.abs(q.vy) * e; } else if (q.y > H - wr) { q.y = H - wr; q.vy = -Math.abs(q.vy) * e; }
      }
      for (let k = 0; k < breaks.length; k += 2) this._break(breaks[k], breaks[k + 1]);

      // ---- beat-flash rings ----
      for (let i = this.flashRings.length - 1; i >= 0; i--) { const ring = this.flashRings[i]; ring.r += 5.5 * dpr; ring.alpha *= 0.93; if (ring.alpha < 0.02) this.flashRings.splice(i, 1); }

      // ---- render: trail → bonds → particles → rings → composite ----
      scene.fade(p.trail);
      // bonds as glowing sticks (colour blends the two endpoints, brightens with heat)
      const bd = this._bondScratch; let bo = 0, bc = 0;
      for (let i = 0; i < N && bc < 4096; i++) {
        const q = ps[i], bl = q.bonds, cq = COL[q.type];
        for (let k = 0; k < bl.length; k++) {
          const j = bl[k]; if (j <= i || bc >= 4096) continue;
          // dim species-coloured thread (hue from the two endpoints) that flares only when genuinely
          // hot — additive blending sums overlapping bonds, so keeping the base dim stops dense
          // structure washing out to white. bondColor is only a faint tint now.
          const o = ps[j], co = COL[o.type], hot = Math.min(1, (q.heat + o.heat) * 0.05), br = 0.26 + hot * 0.6;
          const rr = ((cq[0] + co[0]) * 0.42 + bondRGB[0] * 0.12) * br;
          const gg = ((cq[1] + co[1]) * 0.42 + bondRGB[1] * 0.12) * br;
          const bb = ((cq[2] + co[2]) * 0.42 + bondRGB[2] * 0.12) * br;
          bd[bo++] = q.x; bd[bo++] = q.y; bd[bo++] = o.x; bd[bo++] = o.y;
          bd[bo++] = 1.0 * dpr; bd[bo++] = rr; bd[bo++] = gg; bd[bo++] = bb; bc++;
        }
      }
      if (bc) scene.lines(bd, bc);
      const items = ps.map(q => {
        const c = COL[q.type], hot = Math.min(0.6, q.heat * 0.07);   // species hue stays dominant; only near-reaction atoms flare
        return { x: q.x, y: q.y, size: SPECIES[q.type].size * 3 * dpr * p.glowScale, r: c[0] + hot, g: c[1] + hot * 0.4, b: c[2] + hot * 0.1, life: 0.62 + hot * 0.38 };
      });
      scene.glow(items, { soft: p.softness });
      const rc = this._buildRingData(); if (rc) scene.lines(this._ringScratch, rc);
      scene.composite([5 / 255, 7 / 255, 10 / 255], 1.25);   // highlight rolloff: dense clusters stay coloured, not white

      // small HUD: species mix + bond count
      let nb = 0; for (let i = 0; i < N; i++) nb += ps[i].bonds.length; this.stat = N + " atoms · " + (nb >> 1) + " bonds";
    },
  });
})();

/* Player-facing entry: wraps the core; the graph drives its params. Demo link: treble → glow size
   (atoms flare with the highs). Edit in the node editor — e.g. `energy → beatHeat` for hotter reactions
   on loud sections, or an `lfo` on `clusterBlast`. Unwired knobs stay as panel sliders. */
Synesthesia.Graph.register({
  id: "photomolecular",
  label: "Photomolecular Field",
  nodes: [
    { id: "aud", type: "audio" },
    { id: "glow", type: "map", in: { x: "aud:treble", outMin: { const: 0.8 }, outMax: { const: 2 } } },
    { id: "viz", type: "visual", cfg: { ref: "photomolecularCore" }, in: { glowScale: "glow" } }
  ]
});
