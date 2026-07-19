"use strict";
/* =============================================================================
   SYNESTHESIA GRAPH — the node-graph interpreter.   (classic <script>)

   Eats a visual *document* (docs/visual-graph-design.md) and turns it into an
   ordinary registered visual: same mount/frame/resize/unmount contract as the
   hand-coded ones, so the player panel, cyclers, and the recorder/baker all work
   unchanged. A document is data; this file is the runtime that runs it.

     Synesthesia.Graph.build(doc)     -> visual spec { id,label,params,mount,frame,... }
     Synesthesia.Graph.register(doc)  -> Synesthesia.register(build(doc))
     Synesthesia.Graph.NODES          -> the node catalog (extend by adding entries)

   Load order: after core.js / color.js / gl.js / expr.js, before the doc files.

   ---- document shape (see the design doc for the full spec) --------------------
     { id, label, seed, background:[r,g,b], trail:<ref>, params:[…], nodes:[…] }
   A node: { id, type, in:{port:<ref>}, cfg:{…} }.  A <ref> is one of:
     "nodeId"  "nodeId:port"  "nodeId[i]"  {param:"k"}  {const:v}  {audio:"f"}  number

   Wire payloads: pointset {kind,points:[{x,y,…}]}, segments {kind,flat:[…],n},
   or a plain scalar/point. Renderers draw into the shared GL scene and return null.
   ========================================================================== */

(function () {
  const S = (window.Synesthesia = window.Synesthesia || {});
  const Color = S.Color, Expr = S.Expr, GL = S.GL;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const WHITE = [1, 1, 1];
  const SEGF = 7;   // floats per segment in a `segments` payload: x1,y1,x2,y2,alpha,hueOff(deg),widthMul

  // full-screen vertex shader for `shader` nodes (matches the Scene's fullscreen triangle);
  // fragment shaders declare `in vec2 vUV` + any of the built-in uniforms below.
  const SHADER_VS = `#version 300 es
    precision highp float; layout(location=0) in vec2 aPos; out vec2 vUV;
    void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;
  const SHADER_BUILTINS = ["uRes", "uTime", "uBass", "uMid", "uTreble", "uEnergy", "uBeat", "uCentroid", "uSpec"];
  // `uniform float uName;` declarations in a shader's source that aren't built-ins → wireable ports.
  function shaderUniformNames(node) {
    const src = node.cfg && node.cfg.frag; if (typeof src !== "string") return [];
    const out = []; let m; const re = /uniform\s+float\s+([^;]+);/g;   // handles `uniform float a, b, c;`
    while ((m = re.exec(src))) m[1].split(",").forEach(tok => {
      const nm = tok.trim().match(/^([A-Za-z_]\w*)/);
      if (nm && SHADER_BUILTINS.indexOf(nm[1]) < 0 && out.indexOf(nm[1]) < 0) out.push(nm[1]);
    });
    return out;
  }

  /* ------------------------------ ref resolve --------------------------- */
  // The nodeId a string ref depends on (for the topo sort); null for literals.
  function refDep(ref) {
    if (typeof ref === "string") { const m = ref.match(/^([A-Za-z0-9_]+)/); return m ? m[1] : null; }
    return null;
  }
  function resolveRef(ref, ctx) {
    if (ref == null) return undefined;
    if (typeof ref === "number") return ref;
    if (typeof ref === "object") {
      if ("const" in ref) return ref.const;
      if ("param" in ref) return ctx.p[ref.param];
      if ("audio" in ref) return ctx.a[ref.audio];
      return undefined;
    }
    let m;
    if ((m = ref.match(/^([A-Za-z0-9_]+)\[(\d+)\]$/))) { const o = ctx.out[m[1]]; return o && o.points ? o.points[+m[2]] : undefined; }
    if ((m = ref.match(/^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/))) { const o = ctx.out[m[1]]; return o ? (o.ports ? o.ports[m[2]] : o[m[2]]) : undefined; }
    return ctx.out[ref];
  }
  const inRef = (node, port) => node.in && node.in[port];
  const num = (node, port, ctx, dflt) => { const v = resolveRef(inRef(node, port), ctx); return typeof v === "number" ? v : dflt; };
  // an `origin` point input (wire a `point`/indexed point) → [cx,cy]; defaults to screen centre.
  const originXY = (node, ctx) => { const o = resolveRef(inRef(node, "origin"), ctx); return [o && typeof o.x === "number" ? o.x : ctx.W / 2, o && typeof o.y === "number" ? o.y : ctx.H / 2]; };

  /* --------------------------- geometry helpers ------------------------- */
  function edgeDist(x, y, dx, dy, W, H) {
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - x) / dx); else if (dx < -1e-6) t = Math.min(t, -x / dx);
    if (dy > 1e-6) t = Math.min(t, (H - y) / dy); else if (dy < -1e-6) t = Math.min(t, -y / dy);
    return isFinite(t) && t > 0 ? t : Math.max(W, H);
  }
  // midpoint-displacement fractal path -> flat [x,y,x,y,…], using a SEEDED rng
  function fractal(rng, x0, y0, x1, y1, detail, rough) {
    let pts = [x0, y0, x1, y1];
    for (let d = 0; d < detail; d++) {
      const np = [];
      for (let i = 0; i < pts.length - 2; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        const ddx = bx - ax, ddy = by - ay, len = Math.hypot(ddx, ddy) || 1;
        const disp = (rng() - 0.5) * len * rough;
        np.push(ax, ay, (ax + bx) / 2 - ddy / len * disp, (ay + by) / 2 + ddx / len * disp);
      }
      np.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = np;
    }
    return pts;
  }
  // one forked bolt, centre-relative: [ax,ay,bx,by,fa,fb] (f = outward fraction 0..1)
  function buildBolt(rng, ux, uy, reach, detail, rough, branch) {
    const out = [], invReach = reach > 0 ? 1 / reach : 0;
    const push = pts => {
      for (let i = 0; i < pts.length - 2; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
        out.push(ax, ay, bx, by,
          clamp((ax * ux + ay * uy) * invReach, 0, 1),
          clamp((bx * ux + by * uy) * invReach, 0, 1));
      }
    };
    const trunk = fractal(rng, 0, 0, ux * reach, uy * reach, detail, rough);
    push(trunk);
    const nT = trunk.length / 2, tAng = Math.atan2(uy, ux);
    for (let b = 0; b < branch; b++) {
      const jv = 1 + ((rng() * (nT - 2)) | 0);
      const sx = trunk[jv * 2], sy = trunk[jv * 2 + 1];
      const bAng = tAng + (rng() - 0.5) * 1.4;
      const bux = Math.cos(bAng), buy = Math.sin(bAng);
      const along = sx * ux + sy * uy;
      const blen = (reach - along) * (0.3 + rng() * 0.4);
      if (blen < reach * 0.1) continue;
      push(fractal(rng, sx, sy, sx + bux * blen, sy + buy * blen, Math.max(1, detail - 1), rough));
    }
    return out;
  }
  // one dendrite tree, centre-relative: flat [ax,ay,bx,by,fa,fb] where f = arc-length fraction
  // 0..1 from the root (so a growth front can reveal it root→tip). Recursive forward-walk with
  // per-step angular wobble and probabilistic side branches (len decays by `decay` each level).
  function buildBranch(rng, ux, uy, reach, depth, wobble, chance, spread, decay) {
    const segs = [], step = reach / Math.max(6, depth * 5);
    let maxArc = 1e-3, count = 0;
    const grow = (x, y, ang, len, dep, arc) => {
      if (dep <= 0 || len < step || count > 3000) return;
      const steps = Math.max(2, Math.floor(len / step));
      let cx = x, cy = y, a = ang, d = arc;
      for (let i = 0; i < steps && count <= 3000; i++) {
        a += (rng() - 0.5) * wobble;
        const nx = cx + Math.cos(a) * step, ny = cy + Math.sin(a) * step, d2 = d + step;
        segs.push(cx, cy, nx, ny, d, d2); count++;
        if (d2 > maxArc) maxArc = d2;
        cx = nx; cy = ny; d = d2;
        if (dep > 1 && rng() < chance) grow(cx, cy, a + (rng() < 0.5 ? 1 : -1) * spread * (0.6 + rng() * 0.7), len * decay, dep - 1, d);
      }
    };
    grow(0, 0, Math.atan2(uy, ux), reach, depth, 0);
    for (let i = 4; i < segs.length; i += 6) { segs[i] /= maxArc; segs[i + 1] /= maxArc; }   // arc → 0..1
    return segs;
  }

  /* --------------------- curl-noise flow field (turbulence) ------------- */
  const FRES = 64, VMAX = 3000;   // flow-grid resolution; velocity step clamp (device-px/s)
  function hash3(i, j, k) {
    let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi), c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1), c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u, x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }
  // rebuild a divergence-free velocity grid from a curl-noise potential (once per frame)
  function buildField(st, W, H, minDim, t, scale, amp) {
    const Phi = st.Phi, U = st.U, V = st.V, R = FRES, sc = scale / minDim;
    for (let j = 0; j < R; j++) { const ny = (j / (R - 1) * H) * sc; for (let i = 0; i < R; i++) Phi[j * R + i] = vnoise3((i / (R - 1) * W) * sc, ny, t); }
    const hx = (W / (R - 1)) * sc, hy = (H / (R - 1)) * sc;
    for (let j = 0; j < R; j++) {
      const jm = j > 0 ? j - 1 : 0, jp = j < R - 1 ? j + 1 : R - 1;
      for (let i = 0; i < R; i++) {
        const im = i > 0 ? i - 1 : 0, ip = i < R - 1 ? i + 1 : R - 1;
        U[j * R + i] = ((Phi[jp * R + i] - Phi[jm * R + i]) / ((jp - jm) * hy)) * amp;   // curl of potential
        V[j * R + i] = -((Phi[j * R + ip] - Phi[j * R + im]) / ((ip - im) * hx)) * amp;
      }
    }
  }

  /* ------------------------------ node catalog -------------------------- */
  // Each entry: eval(node, ctx) -> output. Stateful nodes stash under ctx.state[id].
  const NODES = {
    // GENERATOR: N points on a ring, 360/N apart; phase integrates `spin`.
    orbit(node, ctx) {
      const st = ctx.state[node.id] || (ctx.state[node.id] = { phase: 0 });
      st.phase += num(node, "spin", ctx, 0) * ctx.dt;
      const count = (node.cfg && node.cfg.count) || 2;
      const dist = ctx.minDim * num(node, "radius", ctx, 0.18);
      const o = originXY(node, ctx), cx = o[0], cy = o[1], points = [];
      for (let k = 0; k < count; k++) {
        const ang = st.phase + k * (Math.PI * 2 / count);
        const nx = Math.cos(ang), ny = Math.sin(ang);
        points.push({ x: cx + nx * dist, y: cy + ny * dist, nx, ny, ang, idx: k });
      }
      return { kind: "pointset", points };
    },

    // RENDERER: soft additive sprites. Per-point rgb/size/life are honored when present
    // (baked particles: colour from rgb, size from size, alpha faded by life/life0); else
    // falls back to h/s/v + size/alpha params. cfg.halo adds a broad halo pass; cfg.soft
    // sets the falloff (default 2.4; embers ~1.5).
    glow(node, ctx) {
      const set = resolveRef(inRef(node, "points"), ctx);
      if (!set || !set.points || !set.points.length) return null;
      const base = Color.hsv(num(node, "h", ctx, 0), num(node, "s", ctx, 1), num(node, "v", ctx, 1));
      const sizeP = num(node, "size", ctx, 20) * ctx.dpr, alphaP = num(node, "alpha", ctx, 1);
      const soft = node.cfg && node.cfg.soft != null ? node.cfg.soft : 2.4;
      const item = p => {
        const rgb = p.rgb || base, lf = p.life != null ? p.life / p.life0 : 1;
        return { x: p.x, y: p.y, size: p.size != null ? p.size : sizeP, r: rgb[0], g: rgb[1], b: rgb[2], alpha: lf * alphaP };
      };
      const core = set.points.map(item);
      const halo = (node.cfg && node.cfg.halo) ? set.points.map(p => { const it = item(p); it.size *= 2.6; it.alpha = alphaP * 0.4; return it; }) : null;
      return { kind: "layer", draw(scene, target, blend) {
        if (halo) scene.glow(halo, { soft: 0.8, alphaFromLife: false, target, blend });
        scene.glow(core, { soft, alphaFromLife: false, target, blend });
      } };
    },

    // GEOMETRY: waveform strip between two anchor points, displaced by a signal.
    waveTrace(node, ctx) {
      const a = resolveRef(inRef(node, "a"), ctx), b = resolveRef(inRef(node, "b"), ctx);
      const sig = resolveRef(inRef(node, "signal"), ctx);
      if (!a || !b || !sig || !sig.length) return { kind: "segments", flat: [], n: 0 };
      const dab = Math.hypot(b.x - a.x, b.y - a.y);
      const amp = num(node, "amp", ctx, 0.2) * dab, jitter = num(node, "jitter", ctx, 0);
      const dx = (b.x - a.x), dy = (b.y - a.y), L = Math.hypot(dx, dy) || 1;
      const px = -dy / L, py = dx / L;                    // unit perpendicular
      const rng = ctx.rngFor(node.id, ctx.frame);         // per-frame seeded jitter
      const M = sig.length, flat = []; let n = 0, prevx = 0, prevy = 0;
      for (let i = 0; i < M; i++) {
        const t = i / (M - 1), env = Math.sin(Math.PI * t);
        const off = (sig[i] + (rng() - 0.5) * jitter) * amp * env;
        const x = a.x + dx * t + px * off, y = a.y + dy * t + py * off;
        if (i > 0) { flat.push(prevx, prevy, x, y, 1, 0, 1); n++; }
        prevx = x; prevy = y;
      }
      return { kind: "segments", flat, n };
    },

    // SOURCE (emitter): on a trigger, spawn particles. Modes: no anchors → one free burst;
    // anchors (default "each") → one burst of `count` per anchor; anchors + cfg.anchorMode
    // "weighted" → `count` total, each drop samples an anchor ~ its .weight (spectrum spawn).
    // Per burst: optional `count` expr + `burstBake` (shared vars); per particle: `bake`
    // (i, n, anchor fields, burst vars, params in scope). A bake that sets h/s/v gets rgb;
    // x/y/vx/vy/size/op/life are honored if the bake sets them.
    emitter(node, ctx) {
      const st = ctx.state[node.id] || (ctx.state[node.id] = { pool: [], pid: 0, burst: 0, acc: 0, _cum: null });
      const pool = st.pool, cfg = node.cfg || {}, trig = cfg.trigger || "beat", C = ctx.compiled[node.id] || {};
      for (let i = pool.length - 1; i >= 0; i--) { const q = pool[i]; q.life -= ctx.dt; if (q.life <= 0) { pool[i] = pool[pool.length - 1]; pool.pop(); } }
      let bursts = 0;
      if (trig === "beat") { const gate = num(node, "gate", ctx, 0); if (ctx.a.beat && (ctx.a[cfg.gateSrc || "energy"] || 0) > gate) bursts = 1; }
      else if (trig === "rate") { st.acc += num(node, "rate", ctx, 0) * ctx.dt; bursts = Math.floor(st.acc); st.acc -= bursts; }
      if (!bursts) return { kind: "pool", points: pool };

      // resolve this emitter's expression inputs (the @name DYNAMIC ports) over the param
      // table: a bake's @foo reads its wired value (param/lfo/…) if `foo` is connected, else
      // the panel param foo. This is what makes @refs real, wireable inputs on the node.
      const bp = Object.assign({}, ctx.p);
      exprRefNames(node).forEach(name => {
        if (node.in && node.in[name] != null) { const v = resolveRef(node.in[name], ctx); if (typeof v === "number") bp[name] = v; }
        else if (bp[name] == null) bp[name] = 0;
      });

      const anchorFields = anc => !anc ? {} : Object.assign(
        { ax: anc.x, ay: anc.y, anx: anc.nx || 0, any: anc.ny || 0, anchorAngle: Math.atan2(anc.ny || 0, anc.nx || 0) },
        anc.ang != null ? { ang: anc.ang, r0: anc.r0, r1: anc.r1, val: anc.val, dang: anc.dang } : {});
      const clampCount = c => (c < 0 ? 0 : c > 200000 ? 200000 : c);
      const spawn = (anc, ai, j, n, bvars) => {
        const drng = ctx.rngFor(node.id, st.pid);
        const dns = Object.assign({}, ctx.ns, anchorFields(anc), { ai }, bvars || {}, { i: j, n });
        const data = C.bake ? C.bake.run(dns, bp, drng) : {};
        const life0 = data.life != null ? data.life : num(node, "life", ctx, 0.5);
        pool.push({
          x: data.x != null ? data.x : (anc ? anc.x : ctx.W / 2),
          y: data.y != null ? data.y : (anc ? anc.y : ctx.H / 2),
          vx: data.vx != null ? data.vx : 0, vy: data.vy != null ? data.vy : 0, fx: 0, fy: 0,
          size: data.size != null ? data.size : (bvars && bvars.size != null ? bvars.size : 1),
          op: data.op != null ? data.op : 1,
          rgb: data.h != null ? Color.hsv(data.h, data.s != null ? data.s : 1, data.v != null ? data.v : 1) : null,
          anchorIdx: ai, pid: st.pid++, data, life: life0, life0,
        });
      };

      for (let bi = 0; bi < bursts; bi++) {
        const anchors = resolveRef(inRef(node, "anchors"), ctx);
        if (cfg.anchorMode === "weighted" && anchors && anchors.points && anchors.points.length) {
          const pts = anchors.points, Nc = pts.length;
          const cum = st._cum && st._cum.length >= Nc ? st._cum : (st._cum = new Float32Array(Nc));
          let total = 0; for (let i = 0; i < Nc; i++) { total += pts[i].weight || 0; cum[i] = total; }
          const brng = ctx.rngFor(node.id, 0x40000000 ^ st.burst++);
          const count = clampCount(C.count ? Math.round(C.count.run(Object.assign({}, ctx.ns), bp, brng)._) : Math.round(num(node, "count", ctx, 1)));
          if (total > 1e-6) for (let j = 0; j < count; j++) {
            const target = brng() * total; let lo = 0, hi = Nc - 1;
            while (lo < hi) { const mm = (lo + hi) >> 1; if (cum[mm] < target) lo = mm + 1; else hi = mm; }
            spawn(pts[lo], lo, j, count, null);
          }
        } else {
          const list = anchors && anchors.points ? anchors.points : [null];
          list.forEach((anc, ai) => {
            const brng = ctx.rngFor(node.id, 0x40000000 ^ st.burst++);
            const bns = Object.assign({}, ctx.ns, anchorFields(anc), { ai });
            const count = clampCount(C.count ? Math.round(C.count.run(bns, bp, brng)._) : Math.round(num(node, "count", ctx, 1)));
            const bvars = C.burstBake ? C.burstBake.run(Object.assign({ count }, bns), bp, brng) : null;
            for (let j = 0; j < count; j++) spawn(anc, ai, j, count, bvars);
          });
        }
      }
      return { kind: "pool", points: pool };
    },

    // FORCE: radial sink/source added to the field. strength>0 pulls toward centre, <0 pushes out.
    inflow(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const s = num(node, "strength", ctx, 0), o = originXY(node, ctx), cx = o[0], cy = o[1];
      for (const q of pool.points) { q.fx += -s * (q.x - cx); q.fy += -s * (q.y - cy); }
      return pool;
    },
    // FORCE: tangential rotation added to the field. sign sets spin direction.
    curl(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const s = num(node, "strength", ctx, 0), o = originXY(node, ctx), cx = o[0], cy = o[1];
      for (const q of pool.points) { q.fx += -s * (q.y - cy); q.fy += s * (q.x - cx); }
      return pool;
    },
    // FORCE: divergence-free curl-noise turbulence, sampled from a per-frame grid whose
    // cost is independent of particle count. amp in device-px/s.
    turbulence(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const st = ctx.state[node.id] || (ctx.state[node.id] = { U: new Float32Array(FRES * FRES), V: new Float32Array(FRES * FRES), Phi: new Float32Array(FRES * FRES), tFlow: 0, frame: -1 });
      const amp = num(node, "amp", ctx, 250) * ctx.dpr, scale = num(node, "scale", ctx, 8), speed = num(node, "speed", ctx, 0.6);
      if (st.frame !== ctx.frame) { st.tFlow += ctx.dt * speed; buildField(st, ctx.W, ctx.H, ctx.minDim, st.tFlow, scale, amp); st.frame = ctx.frame; }
      const U = st.U, V = st.V, R = FRES, sx = (R - 1) / ctx.W, sy = (R - 1) / ctx.H;
      for (const q of pool.points) {
        let gx = q.x * sx; gx = gx < 0 ? 0 : gx > R - 1 ? R - 1 : gx;
        let gy = q.y * sy; gy = gy < 0 ? 0 : gy > R - 1 ? R - 1 : gy;
        const ix = gx | 0, iy = gy | 0, ix1 = ix < R - 1 ? ix + 1 : ix, iy1 = iy < R - 1 ? iy + 1 : iy, fxc = gx - ix, fyc = gy - iy;
        const w00 = (1 - fxc) * (1 - fyc), w10 = fxc * (1 - fyc), w01 = (1 - fxc) * fyc, w11 = fxc * fyc;
        const c00 = iy * R + ix, c10 = iy * R + ix1, c01 = iy1 * R + ix, c11 = iy1 * R + ix1;
        q.fx += U[c00] * w00 + U[c10] * w10 + U[c01] * w01 + U[c11] * w11;
        q.fy += V[c00] * w00 + V[c10] * w10 + V[c01] * w01 + V[c11] * w11;
      }
      return pool;
    },
    // INTEGRATOR: lerp velocity toward the accumulated field (response), step position,
    // cull off-screen, then zero the field for next frame. Put LAST in a force chain.
    advect(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const resp = num(node, "response", ctx, 1), pts = pool.points, W = ctx.W, H = ctx.H, dt = ctx.dt, VMAX2 = VMAX * VMAX;
      for (let i = 0; i < pts.length;) {
        const q = pts[i];
        let nvx = q.vx + (q.fx - q.vx) * resp, nvy = q.vy + (q.fy - q.vy) * resp;
        const sp2 = nvx * nvx + nvy * nvy; if (sp2 > VMAX2) { const sc = VMAX / Math.sqrt(sp2); nvx *= sc; nvy *= sc; }
        q.vx = nvx; q.vy = nvy; q.x += nvx * dt; q.y += nvy * dt; q.fx = 0; q.fy = 0;
        if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) { pts[i] = pts[pts.length - 1]; pts.pop(); } else i++;
      }
      return pool;
    },
    // RENDERER: metaball liquid. Per-particle alpha = baked op × life-fade × opacity.
    metaballs(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return null;
      const pts = pool.points, nP = pts.length; if (!nP) return null;
      const st = ctx.state[node.id] || (ctx.state[node.id] = { buf: new Float32Array(0) });
      if (st.buf.length < nP * 8) st.buf = new Float32Array(nP * 8 * 2);
      const buf = st.buf, size = num(node, "size", ctx, 5) * ctx.dpr, op = num(node, "opacity", ctx, 1), FADE_MAX = 1.5;
      for (let i = 0; i < nP; i++) {
        const q = pts[i], o = i * 8, fadeW = Math.min(FADE_MAX, q.life0 * 0.5), lf = q.life < fadeW ? q.life / fadeW : 1, rgb = q.rgb || WHITE;
        buf[o] = q.x; buf[o + 1] = q.y; buf[o + 2] = q.size != null ? q.size : size; buf[o + 3] = rgb[0]; buf[o + 4] = rgb[1]; buf[o + 5] = rgb[2];
        buf[o + 6] = (q.op != null ? q.op : 1) * lf * op; buf[o + 7] = 0;
      }
      const threshold = num(node, "threshold", ctx, 0.8), edge = num(node, "edge", ctx, 0.25), sheen = num(node, "sheen", ctx, 0.35);
      return { kind: "layer", draw(scene, target, blend) { scene.metaballs(buf, { count: nP, threshold, edge, sheen, target, blend }); } };   // blend is the LAYER's (over→liquid)
    },

    // GENERATOR: one point per FFT bin on a half-circle (mirrored when drawn). Each point
    // carries its bar geometry (ang, r0, r1), loudness (val/weight) and colour — so it can
    // be BOTH drawn (radialBars) AND emitted from (emitter, weighted mode). spin integrates.
    spectrumBars(node, ctx) {
      const bins = ctx.a.bins; if (!bins) return { kind: "pointset", points: [] };
      const st = ctx.state[node.id] || (ctx.state[node.id] = { rot: 0 });
      st.rot += num(node, "spin", ctx, 0) * Math.min(ctx.dt * 60, 3);
      const N = bins.length, gain = num(node, "gain", ctx, 1);
      const innerR = ctx.minDim * num(node, "inner", ctx, 0.005), maxBar = ctx.minDim * 0.2 * gain;
      const hueSpread = num(node, "hueSpread", ctx, 0), bh = num(node, "h", ctx, 200), bs = num(node, "s", ctx, 0.9), bv = num(node, "v", ctx, 0.9);
      const oo = originXY(node, ctx), cx = oo[0], cy = oo[1], dang = Math.PI / N, points = new Array(N);
      for (let i = 0; i < N; i++) {
        let v = bins[i] * gain; if (v > 1.6) v = 1.6;
        const vc = v > 1 ? 1 : v, ang = (i / N) * Math.PI + st.rot, r1 = innerR + v * maxBar;
        points[i] = { x: cx + Math.cos(ang) * r1, y: cy + Math.sin(ang) * r1, ang, r0: innerR, r1, val: v,
                      weight: v < 0.01 ? 0 : v, dang, idx: i, rgb: Color.hsv(bh + hueSpread * vc, bs, bv * (0.7 + 0.3 * vc)) };
      }
      return { kind: "pointset", points, cx, cy };   // cx/cy so radialBars draws from the same origin
    },
    // GENERATOR: a single placeable point. x/y are fractions of the canvas (0.5,0.5 = centre);
    // `radius` (fraction of minDim) becomes its size. Wire its output into an `origin` input to
    // position an orbit / force / spectrum, or use it as an anchor.
    point(node, ctx) {
      return { kind: "pointset", points: [{ x: num(node, "x", ctx, 0.5) * ctx.W, y: num(node, "y", ctx, 0.5) * ctx.H, size: ctx.minDim * num(node, "radius", ctx, 0.02) }] };
    },

    /* ---- scalar dataflow (per-frame values that ride wires into any input) ---- */
    // VALUE: a named, tweakable parameter. Its live value lives in the visual's param
    // table (ctx.p[name]); build() synthesizes the player's slider panel from these nodes.
    param(node, ctx) { const c = node.cfg || {}, v = ctx.p[c.name]; return v != null ? v : (c.def != null ? c.def : 0); },
    // VALUE: a params TABLE — many named params in one node (collapses N separate `param` nodes).
    // Each row is a slider (build() synthesizes the panel from the rows); each row is an output,
    // wired as "paramsNode:name". Values live in the shared param table (ctx.p[name]).
    params(node, ctx) {
      const rows = (node.cfg && node.cfg.rows) || [], out = {};
      for (const r of rows) if (r.name) {
        let v = ctx.p[r.name]; if (v == null) v = r.def;
        out[r.name] = r.type === "bool" ? (v ? 1 : 0) : (v != null ? v : 0);   // bool → 0/1 (wireable); select → its string
      }
      return out;
    },
    // VALUE: the live audio frame as a multi-output bundle. Wire "audioNode:bass" etc.
    audio(node, ctx) { const n = ctx.ns; return { bass: n.bass, mid: n.mid, treble: n.treble, energy: n.energy, beat: n.beat, centroid: n.centroid, wave: ctx.a.wave, bins: ctx.a.bins }; },
    // VALUE: low-frequency oscillator → 0..1 (the old cyclers, as a node). speed/phase wireable.
    lfo(node, ctx) {
      const st = ctx.state[node.id] || (ctx.state[node.id] = { ph: 0 });
      const cfg = node.cfg || {}, mode = cfg.mode || "sine", timing = cfg.timing || "beat";
      const spd = num(node, "speed", ctx, 0.5), phase = num(node, "phase", ctx, 0), bpm = ctx.a.bpm || 120;
      st.ph += timing === "time" ? spd * ctx.dt : spd * ctx.dt * (bpm / 60);
      const ph = st.ph + phase, fr = ph - Math.floor(ph);
      return mode === "ramp" ? fr : mode === "triangle" ? (fr < 0.5 ? fr * 2 : 2 - fr * 2) : 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
    },
    // VALUE: math on scalars. op picks the operation (binary, or ternary for mix/clamp).
    math(node, ctx) {
      const a = num(node, "a", ctx, 0), b = num(node, "b", ctx, 0), c = num(node, "c", ctx, 0), op = (node.cfg && node.cfg.op) || "add";
      switch (op) {
        case "sub": return a - b; case "mul": return a * b; case "div": return b ? a / b : 0;
        case "min": return Math.min(a, b); case "max": return Math.max(a, b);
        case "mix": return a + (b - a) * c; case "clamp": return Math.max(b, Math.min(c, a));
        case "abs": return Math.abs(a); case "sin": return Math.sin(a);
        default: return a + b;
      }
    },
    // VALUE: remap x from [inMin,inMax] to [outMin,outMax] (e.g. lfo 0..1 → hue 200..260).
    map(node, ctx) {
      const x = num(node, "x", ctx, 0), i0 = num(node, "inMin", ctx, 0), i1 = num(node, "inMax", ctx, 1), o0 = num(node, "outMin", ctx, 0), o1 = num(node, "outMax", ctx, 1);
      return o0 + (o1 - o0) * ((x - i0) / ((i1 - i0) || 1e-9));
    },
    // VALUE: damped-spring follow — chases `target` with springy overshoot (smoothing / inertia).
    // stiffness 0..1 = how hard it pulls; damping 0..1 (low = bouncy overshoot, high = smooth).
    // Ported from the old cyclers' audio-spring. Stateful (position + velocity carried per frame).
    spring(node, ctx) {
      const st = ctx.state[node.id] || (ctx.state[node.id] = { pos: 0, vel: 0, init: false });
      const target = num(node, "target", ctx, 0), s = num(node, "stiffness", ctx, 0.5), d = num(node, "damping", ctx, 0.7);
      if (!st.init) { st.pos = target; st.init = true; }   // start at target (no first-frame jump)
      const k = s * 300, c = 2 * d * Math.sqrt(k);          // critical-ish damping at d≈1
      st.vel += (k * (target - st.pos) - c * st.vel) * ctx.dt;   // semi-implicit Euler (stable)
      st.pos += st.vel * ctx.dt;
      return st.pos;
    },
    // VALUE: lower gate + renormalize (for 0..1 signals like audio). `x` below `gate` → 0;
    // [gate..1] is rescaled to 0..1 — so a param reacts only above the threshold, but still
    // reaches full range. Ported from the old cyclers' audio gate.
    gate(node, ctx) {
      const x = clamp(num(node, "x", ctx, 0), 0, 1), g = num(node, "gate", ctx, 0);
      return g > 0 ? clamp((x - g) / Math.max(1e-3, 1 - g), 0, 1) : x;
    },
    // RENDERER (mark cfg.overlay:true so it draws crisp ON TOP after composite): each
    // spectrum point as a radial capsule (mirrored) from r0→r1, coloured by the point.
    radialBars(node, ctx) {
      const set = resolveRef(inRef(node, "points"), ctx); if (!set || !set.points) return null;
      const pts = set.points, cx = set.cx != null ? set.cx : ctx.W / 2, cy = set.cy != null ? set.cy : ctx.H / 2, hw = num(node, "width", ctx, 1) * ctx.dpr;
      const st = ctx.state[node.id] || (ctx.state[node.id] = { buf: new Float32Array(0) });
      if (st.buf.length < pts.length * 2 * 8) st.buf = new Float32Array(pts.length * 2 * 8);
      const buf = st.buf; let seg = 0;
      for (const p of pts) {
        if (p.val < 0.01) continue;
        const rgb = p.rgb || WHITE;
        for (let m = 0; m < 2; m++) {
          const a = p.ang + m * Math.PI, c = Math.cos(a), s = Math.sin(a), o = seg * 8;
          buf[o] = cx + c * p.r0; buf[o + 1] = cy + s * p.r0; buf[o + 2] = cx + c * p.r1; buf[o + 3] = cy + s * p.r1;
          buf[o + 4] = hw; buf[o + 5] = rgb[0] * 0.85; buf[o + 6] = rgb[1] * 0.85; buf[o + 7] = rgb[2] * 0.85; seg++;
        }
      }
      return { kind: "layer", draw(scene, target, blend) { scene.lines(buf, seg, { target, blend }); } };
    },

    // OUTPUT: the frame compositor. Owns `trail` + background (r,g,b) and an ORDERED layer
    // stack (cfg.layers = [{node, blend, crisp}], bottom→top). Fades the trailed buffer, draws
    // non-crisp layers into it, composites the background, then draws crisp layers straight to
    // the screen on top. blend "add" sums (glow); "over" occludes. Terminal sink; runs last.
    scene(node, ctx) {
      const s = ctx.scene, layers = (node.cfg && node.cfg.layers) || [];
      s.fade(clamp(num(node, "trail", ctx, 0.5), 0, 1));
      for (const L of layers) { if (L.crisp) continue; const lay = ctx.out[L.node]; if (lay && lay.draw) lay.draw(s, "acc", L.blend || "add"); }
      s.composite([num(node, "r", ctx, 0), num(node, "g", ctx, 0), num(node, "b", ctx, 0)]);
      const bloom = num(node, "bloom", ctx, 0);
      if (bloom > 0) s.bloom(bloom, num(node, "bloomThresh", ctx, 0.5), num(node, "bloomSpread", ctx, 1));
      for (const L of layers) { if (!L.crisp) continue; const lay = ctx.out[L.node]; if (lay && lay.draw) lay.draw(s, "screen", L.blend || "add"); }
      return null;
    },

    // INTEGRATOR: ballistic constant-velocity motion + off-screen cull (no force field).
    move(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const pts = pool.points, W = ctx.W, H = ctx.H, dt = ctx.dt, m = ctx.minDim * 0.5;
      for (let i = 0; i < pts.length;) {
        const q = pts[i]; q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.x < -m || q.x > W + m || q.y < -m || q.y > H + m) { pts[i] = pts[pts.length - 1]; pts.pop(); } else i++;
      }
      return pool;
    },

    // GENERATOR (heightfield): a mirrored FFT floor across the screen width — bass at the edges,
    // treble at the centre — smoothed, plus each column's vertical velocity (diff vs last frame,
    // for the "punt"). Output kind "heightfield": { cols, colH(0..1), colV(px/s), maxH, floorHeight }.
    spectrumFloor(node, ctx) {
      const cols = Math.max(2, Math.round((node.cfg && node.cfg.cols) || 200));
      const maxBin = (node.cfg && node.cfg.maxBin) || 72;
      const st = ctx.state[node.id] || (ctx.state[node.id] = {});
      if (!st.colH || st.colH.length !== cols) { st.colH = new Float32Array(cols); st.colHprev = new Float32Array(cols); st.colV = new Float32Array(cols); st.tmp = new Float32Array(cols); }
      const bins = ctx.a.bins, floorHeight = num(node, "height", ctx, 0.3), smoothing = Math.round(num(node, "smoothing", ctx, 2));
      const maxH = ctx.H * floorHeight, colH = st.colH, colHprev = st.colHprev, colV = st.colV, tmp = st.tmp;
      for (let i = 0; i < cols; i++) {
        const cd = Math.abs(i / (cols - 1) - 0.5) * 2, bf0 = (1 - cd) * maxBin, bi = Math.floor(bf0), bf = bf0 - bi;
        const v0 = (bins && bins[bi]) || 0, v1 = (bins && bins[Math.min(127, bi + 1)]) || 0; tmp[i] = v0 + (v1 - v0) * bf;
      }
      colH.set(tmp);
      for (let pass = 0; pass < smoothing; pass++) { let prev = colH[0]; for (let i = 1; i < cols - 1; i++) { const cur = colH[i]; colH[i] = (prev + cur + colH[i + 1]) / 3; prev = cur; } }
      if (ctx.dt > 0) for (let i = 0; i < cols; i++) colV[i] = (colH[i] - colHprev[i]) * maxH / ctx.dt;
      colHprev.set(colH);
      return { kind: "heightfield", cols, colH, colV, maxH, floorHeight };
    },
    // SOURCE: a persistent droplet pool reconciled to `count` (spawns at the top with random x/vx;
    // never culled — the floor + walls contain them). Bakes a per-drop hue offset + render size.
    dropPool(node, ctx) {
      const st = ctx.state[node.id] || (ctx.state[node.id] = { pool: [], pid: 0 });
      const pool = st.pool, target = clamp(Math.round(num(node, "count", ctx, 20000)), 0, 200000);
      const W = ctx.W, H = ctx.H, minDim = ctx.minDim;
      const radius = num(node, "size", ctx, 0.006), merge = num(node, "merge", ctx, 4), hueSpread = num(node, "hueSpread", ctx, 60);
      const h = num(node, "h", ctx, 200), s = num(node, "s", ctx, 0.9), v = num(node, "v", ctx, 0.9);
      while (pool.length < target) {
        const rng = ctx.rngFor(node.id, st.pid++);
        pool.push({ x: W * (0.1 + rng() * 0.8), y: H * (0.6 + rng() * 0.4), vx: (rng() - 0.5) * W * 0.3, vy: 0, fx: 0, fy: 0,
          svar: 0.7 + rng() * 0.6, dh: (rng() - 0.5) * hueSpread, life: 1, life0: 1 });
      }
      if (pool.length > target) pool.length = target;
      for (const q of pool) { q.rgb = Color.hsv(h + q.dh, s, v); q.size = q.svar * radius * minDim * merge; }
      return { kind: "pool", points: pool };
    },
    // INTEGRATOR: ballistic gravity + wall bounces + collision against a heightfield `floor`, with the
    // "punt" (a rising column throws the drop upward) and a slope-normal reflection. y is render-up.
    floorBounce(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx); if (!pool || !pool.points) return pool;
      const hf = resolveRef(inRef(node, "floor"), ctx);
      const pts = pool.points, W = ctx.W, H = ctx.H, dt = ctx.dt;
      const g = num(node, "gravity", ctx, 3) * H, e = clamp(num(node, "restitution", ctx, 0.1), 0, 0.99), wallE = e * 0.9, punt = num(node, "punt", ctx, 1.4), maxV = 20 * H;
      const cols = hf ? hf.cols : 0, colH = hf && hf.colH, colV = hf && hf.colV, maxH = hf ? hf.maxH : 0;
      const eps = cols > 1 ? (W / cols) * 1.5 : W * 0.01;
      const sample = (arr, sc) => x => { if (!arr) return 0; let c = x / W * (cols - 1); if (c < 0) c = 0; else if (c > cols - 1) c = cols - 1; const i = Math.floor(c), f = c - i; return (arr[i] + (arr[Math.min(cols - 1, i + 1)] - arr[i]) * f) * sc; };
      const heightAt = sample(colH, maxH), velAt = sample(colV, 1);
      for (const q of pts) {
        const r = q.size != null ? q.size : ctx.minDim * 0.005;
        q.vy -= g * dt;
        let x = q.x + q.vx * dt, y = q.y + q.vy * dt;
        if (x < r) { x = r; q.vx = -q.vx * wallE; } if (x > W - r) { x = W - r; q.vx = -q.vx * wallE; }
        if (y > H - r) { y = H - r; q.vy = -q.vy * wallE; }                      // ceiling
        const surf = heightAt(x);
        if (y - r < surf) {                                                       // hit the floor
          const dhx = heightAt(x + eps) - heightAt(x - eps);
          let nx = -dhx / (2 * eps), ny = 1; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;   // up-ish slope normal
          const platVy = velAt(x) * punt;                                         // a rising column punts upward
          y = surf + r;
          let ux = q.vx, uy = q.vy - platVy; const un = ux * nx + uy * ny;
          if (un < 0) { ux -= (1 + e) * un * nx; uy -= (1 + e) * un * ny; }
          q.vx = ux * 0.98; q.vy = uy + platVy;
        }
        const sp = Math.hypot(q.vx, q.vy); if (sp > maxV) { const k = maxV / sp; q.vx *= k; q.vy *= k; }
        q.x = x; q.y = y;
      }
      return pool;
    },
    // RENDERER (crisp): draw a heightfield `field` as a gradient floor fill (bot→top) with a bright
    // crest line on top. Put it as a crisp layer so it occludes the liquid it sits over.
    floor(node, ctx) {
      const hf = resolveRef(inRef(node, "field"), ctx); if (!hf || !hf.colH) return null;
      const colH = hf.colH, cols = hf.cols, maxH = hf.maxH, W = ctx.W;
      const top = Color.hsv(num(node, "h", ctx, 200), num(node, "s", ctx, 0.9), num(node, "v", ctx, 0.7));
      const bot = Color.hsv(num(node, "h", ctx, 200) + 40, num(node, "s", ctx, 0.9), num(node, "v", ctx, 0.7) * 0.42);
      const crest = Color.hsv(num(node, "crest_h", ctx, 200), num(node, "crest_s", ctx, 0.7), num(node, "crest_v", ctx, 1)), hw = num(node, "width", ctx, 1) * ctx.dpr;
      const st = ctx.state[node.id] || (ctx.state[node.id] = { buf: new Float32Array(0) });
      const nSeg = cols - 1; if (st.buf.length < nSeg * 8) st.buf = new Float32Array(nSeg * 8);
      const buf = st.buf;
      for (let i = 0; i < nSeg; i++) { const o = i * 8, x0 = i / (cols - 1) * W, y0 = colH[i] * maxH, x1 = (i + 1) / (cols - 1) * W, y1 = colH[i + 1] * maxH;
        buf[o] = x0; buf[o + 1] = y0; buf[o + 2] = x1; buf[o + 3] = y1; buf[o + 4] = hw; buf[o + 5] = crest[0] * 0.9; buf[o + 6] = crest[1] * 0.9; buf[o + 7] = crest[2] * 0.9; }
      return { kind: "layer", draw(scene) { scene.heightFloor(colH, cols, maxH, top, bot); scene.lines(buf, nSeg, { target: "screen", blend: "add" }); } };
    },

    // GEOMETRY: fractal geometry per particle. Bakes the shape ONCE (D1: store), then each frame
    // re-pins the base to the (moving) anchor. shape "bolt" = midpoint-displacement lightning,
    // revealed by tip-drift (travel*(1-life)); shape "branch" = dendrite tree, revealed root→tip
    // by a growth front that advances as the particle ages, with a bright tip and end-of-life fade.
    fractal(node, ctx) {
      const pool = resolveRef(inRef(node, "pool"), ctx);
      const anchors = resolveRef(inRef(node, "anchors"), ctx);
      if (!pool || !pool.points) return { kind: "segments", flat: [], n: 0 };
      const shape = (node.cfg && node.cfg.shape) || "bolt";
      const detail = Math.round(num(node, "detail", ctx, 4)), rough = num(node, "rough", ctx, 0.4);
      const branch = num(node, "branch", ctx, 2), travel = num(node, "travel", ctx, 0.4);
      const spread = num(node, "spread", ctx, 0.5), decay = clamp(num(node, "decay", ctx, 0.8), 0.5, 0.98);
      const rainbow = num(node, "rainbow", ctx, 0), taper = clamp(num(node, "taper", ctx, 0), 0, 1);
      const flat = []; let n = 0;
      for (const q of pool.points) {
        const dd = q.data || {}, ux = dd.ux || 0, uy = dd.uy || 0, reach = dd.reach || 0;
        if (!q._bolt) q._bolt = shape === "branch"
          ? buildBranch(ctx.rngFor(node.id, q.pid), ux, uy, reach, detail, rough, clamp(branch * 0.06, 0.02, 0.6), spread, decay)
          : buildBolt(ctx.rngFor(node.id, q.pid), ux, uy, reach, detail, rough, Math.round(branch));
        const s = q._bolt, life = q.life0 > 0 ? q.life / q.life0 : 0;
        const anc = anchors && anchors.points ? anchors.points[q.anchorIdx] : q;
        const cx = anc ? anc.x : q.x, cy = anc ? anc.y : q.y;
        if (shape === "branch") {
          const grown = clamp((1 - life) / 0.5, 0, 1), fade = clamp(life / 0.4, 0, 1);   // grow over first half, fade over last 40%
          for (let i = 0; i + 5 < s.length; i += 6) {
            if (s[i + 4] > grown) continue;                                  // segment not yet reached by the front
            const fmid = (s[i + 4] + s[i + 5]) * 0.5;                        // arc fraction 0(root)..1(tip)
            const front = clamp(1 - (grown - s[i + 5]) / 0.18, 0, 1);        // brighten just behind the front (tip glow)
            flat.push(cx + s[i], cy + s[i + 1], cx + s[i + 2], cy + s[i + 3],
                      clamp(fade * (0.65 + front * 0.6), 0, 1), rainbow * fmid, Math.max(0.15, 1 - taper * fmid)); n++;
          }
        } else {
          const tr = (1 - life) * travel * reach;
          for (let i = 0; i + 5 < s.length; i += 6) {
            flat.push(cx + s[i] + ux * tr * s[i + 4], cy + s[i + 1] + uy * tr * s[i + 4],
                      cx + s[i + 2] + ux * tr * s[i + 5], cy + s[i + 3] + uy * tr * s[i + 5], life, 0, 1); n++;
          }
        }
      }
      return { kind: "segments", flat, n };
    },

    // RENDERER: additive rounded capsules; per-segment alpha fades the colour.
    lines(node, ctx) {
      const segs = resolveRef(inRef(node, "segs"), ctx);
      if (!segs || !segs.n) return null;
      const baseH = num(node, "h", ctx, 0), sat = num(node, "s", ctx, 1), val = num(node, "v", ctx, 1);
      const rgb0 = Color.hsv(baseH, sat, val);
      const hw = num(node, "width", ctx, 2) * ctx.dpr;
      const st = ctx.state[node.id] || (ctx.state[node.id] = { buf: new Float32Array(0) });
      const cap = Math.min(segs.n, 16384);   // matches gl.js MAXLINES; a dendrite tree is thousands of segs
      if (st.buf.length < cap * 8) st.buf = new Float32Array(cap * 8);
      const buf = st.buf, f = segs.flat;
      for (let i = 0; i < cap; i++) {
        const s = i * SEGF, o = i * 8, a = f[s + 4], hueOff = f[s + 5], wmul = f[s + 6];
        const rgb = hueOff ? Color.hsv(baseH + hueOff, sat, val) : rgb0;   // per-segment rainbow when set
        buf[o] = f[s]; buf[o + 1] = f[s + 1]; buf[o + 2] = f[s + 2]; buf[o + 3] = f[s + 3];
        buf[o + 4] = hw * wmul; buf[o + 5] = rgb[0] * a; buf[o + 6] = rgb[1] * a; buf[o + 7] = rgb[2] * a;
      }
      return { kind: "layer", draw(scene, target, blend) { scene.lines(buf, cap, { target, blend }); } };
    },

    // RENDERER: a user fragment shader as a full-screen layer. Compiles once (recompiles when the
    // source changes), caches uniform locations, uploads the spectrum LUT, and reads its custom
    // `uniform float uName;` inputs from wired scalars. The scene compositor blends it like any layer.
    shader(node, ctx) {
      const gl = ctx.scene.gl, src = (node.cfg && node.cfg.frag) || "";
      if (!gl || !src.trim()) return null;
      let st = ctx.state[node.id];
      if (!st || st.src !== src) {
        if (st && st.prog) gl.deleteProgram(st.prog);
        const prog = GL.program(gl, SHADER_VS, src), u = {};
        SHADER_BUILTINS.concat(shaderUniformNames(node)).forEach(nm => { u[nm] = gl.getUniformLocation(prog, nm); });
        st = ctx.state[node.id] = { src, prog, u };
      }
      // resolve everything NOW (the draw thunk runs later, inside the scene's layer pass)
      const sig = resolveRef(inRef(node, "spectrum"), ctx);   // a wired audio `bins` (or `wave`) signal; else the live spectrum
      const specTex = st.u.uSpec ? ctx.scene.spectrum(sig && sig.length ? sig : ctx.a.bins) : null;
      const customs = shaderUniformNames(node).map(nm => [st.u[nm], num(node, nm, ctx, 0)]);
      const u = st.u, ns = ctx.ns, W = ctx.W, H = ctx.H, prog = st.prog;
      return { kind: "layer", draw(scene, target, blend) {
        scene.shaderLayer(prog, g => {
          if (u.uRes) g.uniform2f(u.uRes, W, H);
          if (u.uTime) g.uniform1f(u.uTime, ns.t);
          if (u.uBass) g.uniform1f(u.uBass, ns.bass);
          if (u.uMid) g.uniform1f(u.uMid, ns.mid);
          if (u.uTreble) g.uniform1f(u.uTreble, ns.treble);
          if (u.uEnergy) g.uniform1f(u.uEnergy, ns.energy);
          if (u.uBeat) g.uniform1f(u.uBeat, ns.beat);
          if (u.uCentroid) g.uniform1f(u.uCentroid, ns.centroid);
          if (u.uSpec && specTex) { g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, specTex); g.uniform1i(u.uSpec, 0); }
          for (const c of customs) if (c[0]) g.uniform1f(c[0], c[1]);
        }, { target, blend });
      } };
    },
  };

  /* ------------------------------- build -------------------------------- */
  function topoSort(nodes) {
    const map = {}; nodes.forEach(n => { map[n.id] = n; });
    const deps = {}, indeg = {};
    nodes.forEach(n => {
      deps[n.id] = new Set();
      Object.keys(n.in || {}).forEach(port => { const d = refDep(n.in[port]); if (d && map[d]) deps[n.id].add(d); });
      // a scene node also depends on every layer it draws (cfg.layers[].node)
      if (n.type === "scene" && n.cfg && n.cfg.layers) n.cfg.layers.forEach(L => { if (L.node && map[L.node]) deps[n.id].add(L.node); });
    });
    nodes.forEach(n => { indeg[n.id] = deps[n.id].size; });
    const q = nodes.filter(n => indeg[n.id] === 0).map(n => n.id), order = [];
    while (q.length) {
      const id = q.shift(); order.push(id);
      nodes.forEach(n => { if (deps[n.id].has(id)) { deps[n.id].delete(id); if (--indeg[n.id] === 0) q.push(n.id); } });
    }
    if (order.length !== nodes.length) throw new Error("Synesthesia.Graph: cycle detected in node graph (doc " + JSON.stringify(order) + ")");
    return order;
  }

  // A doc with a `visual` node is a WRAPPER: it delegates rendering to a hand-coded visual (registered
  // via registerWrappable) and uses the graph purely as the audio-reactive control layer — value nodes
  // (audio/lfo/spring/math/map/gate) compute params that override the wrapped visual's each frame.
  function buildWrapper(doc, nodes, map, vnode) {
    const order = topoSort(nodes), ref = (vnode.cfg && vnode.cfg.ref) || "";
    const params = (WRAPS[ref] && WRAPS[ref].params) || doc.params || [];
    const seed = doc.seed || 1, hc = {}, hashOf = id => hc[id] != null ? hc[id] : (hc[id] = Expr.hashStr(id));
    return {
      id: doc.id, label: doc.label || doc.id, params, wraps: ref,
      mount(host) {
        this.dpr = host.dpr; this.canvas = host.canvas;
        const core = WRAPS[ref];
        if (!core) { console.error("Synesthesia.Graph: `visual` node references unknown visual '" + ref + "' (registerWrappable first)"); return; }
        this.core = Object.create(core);   // fresh instance; shares the core's methods
        this.core.p = this.p;              // panel edits AND graph overrides land on the same param object
        this.core.mount(host);
        this._state = {}; this._time = 0; this._frame = 0;
      },
      resize(w, h) { if (this.core && this.core.resize) this.core.resize(w, h); },
      unmount() { if (this.core && this.core.unmount) this.core.unmount(); this.core = null; },
      frame(a) {
        if (!this.core) return;
        const p = this.p, W = this.canvas.width, H = this.canvas.height;
        const dt = Math.min((a.dt || 16.7) / 1000, 0.05); this._time += dt;
        let centroid = 0; if (a.bins) { let sm = 0, ws = 0; for (let i = 0; i < 128; i++) { sm += a.bins[i]; ws += i * a.bins[i]; } centroid = sm > 1e-4 ? (ws / sm) / 128 : 0; }
        const ns = { bass: a.bass || 0, mid: a.mid || 0, treble: a.treble || 0, energy: a.energy || 0, beat: a.beat ? 1 : 0, centroid, t: a.t != null ? a.t : this._time, W, H, dt, dpr: this.dpr, cx: W / 2, cy: H / 2 };
        const ctx = { p, a, W, H, dpr: this.dpr, dt, minDim: Math.min(W, H), out: {}, state: this._state, frame: this._frame, ns, compiled: {}, rngFor: (id, pid) => Expr.makeRng(Expr.keySeed(seed, hashOf(id), pid | 0)) };
        for (let i = 0; i < order.length; i++) { const n = map[order[i]]; if (n.type === "visual") continue; ctx.out[order[i]] = NODES[n.type](n, ctx); }   // value nodes only (no Scene needed)
        if (vnode.in) for (const port in vnode.in) { const v = resolveRef(vnode.in[port], ctx); if (typeof v === "number") p[port] = v; }   // drive the wrapped visual's params
        this.core.frame(a); this._frame++;
      },
    };
  }

  function build(doc) {
    const nodes = doc.nodes || [], map = {}; nodes.forEach(n => { map[n.id] = n; });
    const vnode = nodes.find(n => n.type === "visual");
    if (vnode) return buildWrapper(doc, nodes, map, vnode);
    const order = topoSort(nodes);
    // precompile emitter expression scripts once, INTO A SIDE MAP (never onto the doc
    // nodes) so the document stays pure, serializable data the editor can round-trip.
    const compiled = {};
    nodes.forEach(n => {
      if (!n.cfg) return;
      const c = {};
      if (n.cfg.count && typeof n.cfg.count === "string") c.count = Expr.compile(n.cfg.count);
      if (n.cfg.burstBake) c.burstBake = Expr.compile(n.cfg.burstBake);
      if (n.cfg.bake) c.bake = Expr.compile(n.cfg.bake);
      compiled[n.id] = c;
    });
    const seed = doc.seed || 1;
    // synthesize the tweakable params (player slider panel) from `param` nodes AND the rows of
    // any `params` table node. A migrated doc has no doc.params — its params ARE these nodes.
    // Falls back to the legacy doc.params array for hand-written / not-yet-migrated docs.
    const mkParam = r => {
      const key = r.name || r.key, t = r.type || "range";
      if (t === "select") return { key, label: key, type: "select", options: r.options || [], default: r.def != null ? r.def : (r.options && r.options[0]) };
      if (t === "bool") return { key, label: key, type: "checkbox", default: !!r.def };
      return { key, label: key, type: "range", min: r.min != null ? r.min : 0, max: r.max != null ? r.max : 1, step: r.step != null ? r.step : 0.01, default: r.def != null ? r.def : 0 };
    };
    const synthParams = [];
    nodes.forEach(n => {
      if (n.type === "param" && n.cfg && n.cfg.name) synthParams.push(mkParam(n.cfg));
      if (n.type === "params" && n.cfg && n.cfg.rows) n.cfg.rows.forEach(r => { if (r.name) synthParams.push(mkParam(r)); });
    });
    const params = synthParams.length ? synthParams : (doc.params || []);
    const hashCache = {};
    const hashOf = id => (hashCache[id] != null ? hashCache[id] : (hashCache[id] = Expr.hashStr(id)));

    return {
      id: doc.id, label: doc.label || doc.id, params,
      mount(host) {
        this.dpr = host.dpr;
        // reuse a caller-provided scene (editor live-preview: one context across rebuilds)
        // or create+own one (normal player/recorder use).
        this._ownScene = !host.scene;
        this.scene = host.scene || GL.createScene(host.canvas, host.dpr);
        if (!this.scene.gl) { console.error("Synesthesia.Graph: WebGL2 unavailable."); return; }
        this._cyc = {}; this._state = {}; this._frame = 0; this._time = 0;
      },
      resize() { if (this.scene) this.scene.resize(); },
      unmount() { if (this.scene && this._ownScene) this.scene.dispose(); this.scene = null; },
      frame(a) {
        const scene = this.scene; if (!scene || !scene.gl) return;
        const p = this.p;   // params come straight from `param` nodes now (no cyclers layer)
        const W = scene.canvas.width, H = scene.canvas.height;
        const dt = Math.min((a.dt || 16.7) / 1000, 0.05);
        this._time += dt;
        let centroid = 0;
        if (a.bins) { let sm = 0, ws = 0; for (let i = 0; i < 128; i++) { sm += a.bins[i]; ws += i * a.bins[i]; } centroid = sm > 1e-4 ? (ws / sm) / 128 : 0; }
        const ns = { bass: a.bass || 0, mid: a.mid || 0, treble: a.treble || 0, energy: a.energy || 0,
                     beat: a.beat ? 1 : 0, centroid, t: a.t != null ? a.t : this._time,
                     W, H, dt, dpr: this.dpr, cx: W / 2, cy: H / 2 };
        const ctx = {
          p, a, W, H, dpr: this.dpr, dt, minDim: Math.min(W, H), scene,
          out: {}, state: this._state, frame: this._frame, ns, compiled,
          rngFor: (id, pid) => Expr.makeRng(Expr.keySeed(seed, hashOf(id), pid | 0)),
        };
        // Evaluate every node in topo order. Renderers just build layer thunks (no GL); the
        // terminal `scene` node runs last and does fade → layers → composite → crisp layers.
        for (let i = 0; i < order.length; i++) { const id = order[i]; ctx.out[id] = NODES[map[id].type](map[id], ctx); }
        this._frame++;
      },
    };
  }

  // keep the raw document keyed by id so the editor can load it back for editing
  const DOCS = {};
  function register(doc) { DOCS[doc.id] = doc; S.register(build(doc)); return doc; }
  // hand-coded visuals a `visual` node can wrap (id → spec). NOT added to the player list — a wrapper
  // doc registers the player-facing entry; the core just renders + exposes its params.
  const WRAPS = {};
  function registerWrappable(spec) { WRAPS[spec.id] = spec; return spec; }

  /* ------------------------------ node manifest ------------------------- */
  // Machine-readable description of every catalog node for the editor: category, output
  // kind, input ports (name + kind + optional flag), and cfg fields. Wire kinds:
  //   points   = a pointset/pool output (generators, emitter, forces, integrators)
  //   point    = a single indexed point (e.g. "orbit[0]") — for waveTrace a/b
  //   segments = line segments (geometry) → the `lines` renderer
  //   signal   = an audio array ({audio:"wave"|"bins"})
  //   scalar   = a number: {param}/{const}/{audio:<band>} or a node… (none emit scalars yet)
  // A port with kind "points"/"point"/"segments"/"signal" connects to a node/ref of that
  // kind; "scalar" ports take param/const/audio literals (the panel already edits those).
  const P = (name, kind, opt) => ({ name, kind, opt: !!opt });
  const MANIFEST = {
    orbit:       { cat: "generator", out: "points", desc: "N points on a ring; phase integrates spin",
                   ports: [P("spin", "scalar"), P("radius", "scalar"), P("origin", "point", true)], cfg: [{ name: "count", type: "number", default: 2 }] },
    spectrumBars:{ cat: "generator", out: "points", desc: "One point per FFT bin (bar geometry + loudness + colour)",
                   ports: [P("gain", "scalar"), P("inner", "scalar"), P("spin", "scalar"), P("hueSpread", "scalar"), P("h", "scalar"), P("s", "scalar"), P("v", "scalar"), P("origin", "point", true)], cfg: [] },
    point:       { cat: "generator", out: "points", desc: "A single placeable point (x/y are canvas fractions, 0.5=centre); radius→size",
                   ports: [P("x", "scalar", true), P("y", "scalar", true), P("radius", "scalar", true)], cfg: [] },
    emitter:     { cat: "source", out: "points", desc: "Spawn particles on a trigger; bake per-particle state",
                   ports: [P("anchors", "points", true), P("gate", "scalar", true), P("count", "scalar", true), P("rate", "scalar", true), P("life", "scalar", true)],
                   cfg: [{ name: "trigger", type: "enum", options: ["beat", "rate"], default: "beat" },
                         { name: "gateSrc", type: "enum", options: ["bass", "mid", "treble", "energy"], default: "energy" },
                         { name: "anchorMode", type: "enum", options: ["each", "weighted"], default: "each" },
                         { name: "count", type: "expr" }, { name: "burstBake", type: "expr" }, { name: "bake", type: "expr" }] },
    inflow:      { cat: "force", out: "points", desc: "Radial sink/source (+ pulls in, − pushes out)",
                   ports: [P("pool", "points"), P("strength", "scalar"), P("origin", "point", true)], cfg: [] },
    curl:        { cat: "force", out: "points", desc: "Tangential rotation (sign = spin direction)",
                   ports: [P("pool", "points"), P("strength", "scalar"), P("origin", "point", true)], cfg: [] },
    turbulence:  { cat: "force", out: "points", desc: "Divergence-free curl-noise turbulence",
                   ports: [P("pool", "points"), P("amp", "scalar"), P("scale", "scalar"), P("speed", "scalar")], cfg: [] },
    advect:      { cat: "integrator", out: "points", desc: "Lerp velocity→field, step, cull off-screen (put last)",
                   ports: [P("pool", "points"), P("response", "scalar")], cfg: [] },
    move:        { cat: "integrator", out: "points", desc: "Ballistic constant-velocity motion + cull",
                   ports: [P("pool", "points")], cfg: [] },
    waveTrace:   { cat: "geometry", out: "segments", desc: "Waveform strip between two points, displaced by a signal",
                   ports: [P("a", "point"), P("b", "point"), P("signal", "signal"), P("amp", "scalar"), P("jitter", "scalar")], cfg: [] },
    fractal:     { cat: "geometry", out: "segments", desc: "Fractal geometry per particle (baked once, re-pinned to anchor). shape 'bolt' = lightning (tip-drift reveal via travel); 'branch' = dendrite tree (root→tip growth reveal as the particle ages). spread/decay tune the branching.",
                   ports: [P("pool", "points"), P("anchors", "points", true), P("detail", "scalar"), P("rough", "scalar"), P("branch", "scalar"), P("travel", "scalar", true), P("spread", "scalar", true), P("decay", "scalar", true), P("rainbow", "scalar", true), P("taper", "scalar", true)],
                   cfg: [{ name: "shape", type: "enum", options: ["bolt", "branch"], default: "bolt" }] },
    glow:        { cat: "renderer", out: "layer", desc: "Soft additive sprites (per-particle rgb/size/life honored; size/colour ports are fallbacks)",
                   ports: [P("points", "points"), P("size", "scalar", true), P("alpha", "scalar", true), P("h", "scalar", true), P("s", "scalar", true), P("v", "scalar", true)],
                   cfg: [{ name: "halo", type: "bool" }, { name: "soft", type: "number", default: 2.4 }] },
    lines:       { cat: "renderer", out: "layer", desc: "Rounded capsules (per-segment alpha)",
                   ports: [P("segs", "segments"), P("width", "scalar"), P("h", "scalar"), P("s", "scalar"), P("v", "scalar")], cfg: [] },
    metaballs:   { cat: "renderer", out: "layer", desc: "Metaball liquid surface (blend is set by the scene layer: over = liquid)",
                   ports: [P("pool", "points"), P("size", "scalar"), P("opacity", "scalar"), P("threshold", "scalar"), P("edge", "scalar"), P("sheen", "scalar")], cfg: [] },
    radialBars:  { cat: "renderer", out: "layer", desc: "Radial capsules from spectrum points (add a crisp layer in the scene)",
                   ports: [P("points", "points"), P("width", "scalar")], cfg: [] },
    shader:      { cat: "renderer", out: "layer", desc: "Fragment shader as a full-screen layer. Built-ins: uRes, uTime, uBass/uMid/uTreble/uEnergy/uBeat/uCentroid, uSpec (128×1 spectrum, sample .r) — wire an audio `bins`/`wave` signal into `spectrum` to drive uSpec (else the live audio). Declare `uniform float uName;` for a wireable input.",
                   ports: [P("spectrum", "signal", true)], cfg: [{ name: "frag", type: "glsl" }] },
    spectrumFloor:{ cat: "generator", out: "heightfield", desc: "Mirrored FFT floor across the screen (bass at edges, treble centre) + per-column velocity — for a `floor` renderer and a `floorBounce` integrator.",
                   ports: [P("height", "scalar"), P("smoothing", "scalar", true)], cfg: [{ name: "cols", type: "number", default: 200 }, { name: "maxBin", type: "number", default: 72 }] },
    dropPool:    { cat: "source", out: "points", desc: "A persistent droplet pool reconciled to `count` (spawns at the top; walls+floor contain them). Bakes per-drop hue + render size.",
                   ports: [P("count", "scalar"), P("size", "scalar", true), P("merge", "scalar", true), P("hueSpread", "scalar", true), P("h", "scalar", true), P("s", "scalar", true), P("v", "scalar", true)], cfg: [] },
    floorBounce: { cat: "integrator", out: "points", desc: "Gravity + wall bounces + collision against a `floor` heightfield, with the punt (rising column throws drops up) and slope reflection.",
                   ports: [P("pool", "points"), P("floor", "heightfield"), P("gravity", "scalar"), P("restitution", "scalar", true), P("punt", "scalar", true)], cfg: [] },
    floor:       { cat: "renderer", out: "layer", desc: "Draw a heightfield `field` as a gradient floor + crest line (add as a crisp layer so it occludes the liquid).",
                   ports: [P("field", "heightfield"), P("h", "scalar"), P("s", "scalar"), P("v", "scalar"), P("crest_h", "scalar", true), P("crest_s", "scalar", true), P("crest_v", "scalar", true), P("width", "scalar", true)], cfg: [] },
    scene:       { cat: "output", out: null, desc: "Frame compositor: trail + background + an ordered layer stack (add/over, crisp) + optional bloom (soft glow of the bright non-crisp layers).",
                   ports: [P("trail", "scalar"), P("r", "scalar"), P("g", "scalar"), P("b", "scalar"), P("layers", "layer"), P("bloom", "scalar", true), P("bloomThresh", "scalar", true), P("bloomSpread", "scalar", true)], cfg: [] },
    visual:      { cat: "output", out: null, desc: "Wrap a hand-coded visual: it renders itself, and wiring value nodes into its params makes them audio-reactive. cfg.ref = the visual's id (a registerWrappable core). Its params appear as inputs.",
                   ports: [], cfg: [{ name: "ref", type: "visualref" }] },
    // ---- value nodes: per-frame scalars on wires (replace {param}/{audio}/cyclers) ----
    param:       { cat: "value", out: "scalar", desc: "A named, tweakable slider (generates the player panel)",
                   ports: [], cfg: [{ name: "name", type: "string" }, { name: "min", type: "number", default: 0 }, { name: "max", type: "number", default: 1 }, { name: "def", type: "number", default: 0 }, { name: "step", type: "number", default: 0.01 }] },
    params:      { cat: "value", out: "scalar", desc: "A params TABLE: many named sliders in one node; each row is an output (wire params:name)",
                   ports: [], cfg: [{ name: "rows", type: "paramrows" }] },   // outputs are dynamic (one per row) — see effectiveOuts
    audio:       { cat: "value", out: "scalar", outs: [P("bass", "scalar"), P("mid", "scalar"), P("treble", "scalar"), P("energy", "scalar"), P("beat", "scalar"), P("centroid", "scalar"), P("wave", "signal"), P("bins", "signal")],
                   desc: "The live audio frame (multi-output: wire audio:bass etc.)", ports: [], cfg: [] },
    lfo:         { cat: "value", out: "scalar", desc: "Low-frequency oscillator → 0..1 (sine/triangle/ramp)",
                   ports: [P("speed", "scalar"), P("phase", "scalar")], cfg: [{ name: "mode", type: "enum", options: ["sine", "triangle", "ramp"], default: "sine" }, { name: "timing", type: "enum", options: ["beat", "time"], default: "beat" }] },
    math:        { cat: "value", out: "scalar", desc: "Math on scalars (op: add/sub/mul/div/min/max/mix/clamp/abs/sin)",
                   ports: [P("a", "scalar"), P("b", "scalar"), P("c", "scalar", true)], cfg: [{ name: "op", type: "enum", options: ["add", "sub", "mul", "div", "min", "max", "mix", "clamp", "abs", "sin"], default: "add" }] },
    map:         { cat: "value", out: "scalar", desc: "Remap x from [inMin,inMax] to [outMin,outMax]",
                   ports: [P("x", "scalar"), P("inMin", "scalar"), P("inMax", "scalar"), P("outMin", "scalar"), P("outMax", "scalar")], cfg: [] },
    spring:      { cat: "value", out: "scalar", desc: "Damped-spring follow of `target` (smoothing + springy overshoot)",
                   ports: [P("target", "scalar"), P("stiffness", "scalar", true), P("damping", "scalar", true)], cfg: [] },
    gate:        { cat: "value", out: "scalar", desc: "Lower gate + renormalize a 0..1 signal: below `gate`→0, [gate..1]→0..1",
                   ports: [P("x", "scalar"), P("gate", "scalar", true)], cfg: [] },
  };

  // @param names referenced inside a node's expression cfgs (bake / count / burstBake).
  function exprRefNames(node) {
    const c = node.cfg; if (!c) return [];
    const src = [c.bake, c.count, c.burstBake].filter(s => typeof s === "string").join("\n");
    const set = []; let m; const re = /@([A-Za-z_]\w*)/g;
    while ((m = re.exec(src))) if (set.indexOf(m[1]) < 0) set.push(m[1]);
    return set;
  }
  // Effective input ports = the manifest's static ports PLUS one dynamic scalar port per
  // expression @ref (so a bake's @foo shows up as a wireable input `foo` on the node).
  function effectivePorts(node) {
    const man = MANIFEST[node.type], base = man ? man.ports.slice() : [];
    const have = {}; base.forEach(p => have[p.name] = 1);
    exprRefNames(node).forEach(name => { if (!have[name]) { base.push({ name, kind: "scalar", opt: true, expr: true }); have[name] = 1; } });
    if (node.type === "shader") shaderUniformNames(node).forEach(name => { if (!have[name]) { base.push({ name, kind: "scalar", opt: true, shader: true }); have[name] = 1; } });
    if (node.type === "visual") { const core = WRAPS[node.cfg && node.cfg.ref]; if (core) (core.params || []).forEach(pp => { if (pp.key && pp.type === "range" && !have[pp.key]) { base.push({ name: pp.key, kind: "scalar", opt: true }); have[pp.key] = 1; } }); }
    return base;
  }
  // Effective OUTPUT ports. Most nodes are static (manifest out/outs); a `params` table's
  // outputs are DYNAMIC — one scalar output per row.
  function effectiveOuts(node) {
    if (node.type === "params") return ((node.cfg && node.cfg.rows) || []).filter(r => r.name).map(r => ({ name: r.name, kind: "scalar" }));
    const man = MANIFEST[node.type]; if (!man) return [];
    return man.outs ? man.outs : (man.out ? [{ name: null, kind: man.out }] : []);
  }

  S.Graph = { build, register, registerWrappable, wraps: WRAPS, NODES, MANIFEST, docs: DOCS, resolveRef, refDep, exprRefNames, effectivePorts, effectiveOuts };
})();
