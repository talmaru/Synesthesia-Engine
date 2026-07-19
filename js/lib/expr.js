"use strict";
/* =============================================================================
   SYNESTHESIA EXPR — a tiny, deterministic expression evaluator.   (classic <script>)

   The linchpin of the node-graph engine (docs/visual-graph-design.md §10). Modeled
   on Winamp AVS: you learn it by editing example expressions. It runs the "bake"
   scripts an emitter executes once per particle at spawn, and later the same
   evaluator drives force params (frame context) and user-authored forces (point
   context) — that's the "C" expansion. One evaluator, more contexts.

   DETERMINISM IS THE POINT. No wall clock (song time `t` is the only clock).
   rand() draws from a SEEDED stream you pass in — never Math.random internally.
   Same source + same namespace + same rng => same numbers, so preview == bake.

   ---- Usage --------------------------------------------------------------------
     const prog = Synesthesia.Expr.compile(source);   // parse ONCE (throws on syntax error)
     const rng  = Synesthesia.Expr.makeRng(seedInt);  // seeded 0..1 generator
     const out  = prog.run(namespace, params, rng);   // -> {all assigned vars, _:lastExpr}

   `namespace` = the context variables (audio + anchor + geometry, see below).
   `params`    = the visual's cycler-resolved params, read via @name in the script.
   `out`       = every assigned variable; a bare trailing expression lands in out._

   ---- A bake block is an ordered list of assignments (AVS per-point style) -------
   Each line may use variables set by earlier lines. Example (orbitscope's bolts):

     ang   = anchorAngle + rand(-0.5, 0.5) * PI * @arcSpread
     ux    = cos(ang)
     uy    = sin(ang)
     reach = edgedist(ax, ay, ux, uy) * clamp(energy * @arcPower, 0.08, 1)

   ---- Namespace (what the host provides; spawn context) -------------------------
     audio:    bass mid treble energy beat centroid   (0..1),  t (song seconds)
     anchor:   ax ay  (spawn position),  anx any (anchor facing),  anchorAngle,
               ai (anchor index), i (index in this burst), n (burst size)
     canvas:   W H    (used by edgedist)
     params:   @name  -> cycler-resolved doc param
     (the host may add more; anything in `namespace` is readable by bare name)

   ---- Functions (whitelist) ----------------------------------------------------
     + - * / %      ^ (right-assoc pow)      unary - !     comparisons < > <= >= == !=
     && ||          sin cos tan asin acos atan atan2 sqrt abs floor ceil round sign
     exp log pow    min max clamp(x,lo,hi) mix(a,b,t) step(edge,x) smoothstep(a,b,x)
     if(cond,a,b)   above(a,b) below(a,b) equal(a,b)      rand(), rand(hi), rand(lo,hi)
     edgedist(x,y,dx,dy)          constants: PI TAU E
   Comments: # ... or // ... to end of line.  Statements split on newline or ;.

   Load as a classic <script> alongside color.js / gl.js (before the visuals).       */

(function () {
  const C = (window.Synesthesia = window.Synesthesia || {});

  const CONSTS = { PI: Math.PI, TAU: Math.PI * 2, E: Math.E };

  const BIN = {
    "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b,
    "/": (a, b) => a / b, "%": (a, b) => a % b,
    "<": (a, b) => (a < b ? 1 : 0), ">": (a, b) => (a > b ? 1 : 0),
    "<=": (a, b) => (a <= b ? 1 : 0), ">=": (a, b) => (a >= b ? 1 : 0),
    "==": (a, b) => (a === b ? 1 : 0), "!=": (a, b) => (a !== b ? 1 : 0),
    "&&": (a, b) => (a !== 0 && b !== 0 ? 1 : 0), "||": (a, b) => (a !== 0 || b !== 0 ? 1 : 0),
  };
  const PREC = { "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, ">": 5, "<=": 5, ">=": 5,
                 "+": 6, "-": 6, "*": 7, "/": 7, "%": 7 };

  const FUNCS = {
    sin: a => Math.sin(a[0]), cos: a => Math.cos(a[0]), tan: a => Math.tan(a[0]),
    asin: a => Math.asin(a[0]), acos: a => Math.acos(a[0]), atan: a => Math.atan(a[0]),
    atan2: a => Math.atan2(a[0], a[1]),
    sqrt: a => Math.sqrt(a[0]), abs: a => Math.abs(a[0]),
    floor: a => Math.floor(a[0]), ceil: a => Math.ceil(a[0]), round: a => Math.round(a[0]),
    sign: a => Math.sign(a[0]), exp: a => Math.exp(a[0]), log: a => Math.log(a[0]),
    pow: a => Math.pow(a[0], a[1]),
    min: a => Math.min.apply(null, a), max: a => Math.max.apply(null, a),
    clamp: a => Math.max(a[1], Math.min(a[2], a[0])),
    mix: a => a[0] + (a[1] - a[0]) * a[2], lerp: a => a[0] + (a[1] - a[0]) * a[2],
    step: a => (a[1] < a[0] ? 0 : 1),
    smoothstep: a => { let t = (a[2] - a[0]) / ((a[1] - a[0]) || 1e-9); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); },
    if: a => (a[0] !== 0 ? a[1] : a[2]),
    above: a => (a[0] > a[1] ? 1 : 0), below: a => (a[0] < a[1] ? 1 : 0), equal: a => (a[0] === a[1] ? 1 : 0),
    rand: (a, ctx) => { const r = ctx.rng(); return a.length === 0 ? r : a.length === 1 ? r * a[0] : a[0] + (a[1] - a[0]) * r; },
    edgedist: (a, ctx) => {
      const x = a[0], y = a[1], dx = a[2], dy = a[3], W = ctx.v.W || 0, H = ctx.v.H || 0;
      let t = Infinity;
      if (dx > 1e-6) t = Math.min(t, (W - x) / dx); else if (dx < -1e-6) t = Math.min(t, -x / dx);
      if (dy > 1e-6) t = Math.min(t, (H - y) / dy); else if (dy < -1e-6) t = Math.min(t, -y / dy);
      return isFinite(t) && t > 0 ? t : Math.max(W, H);
    },
  };

  /* ------------------------------ tokenizer ------------------------------ */
  // NB: whitespace group excludes \n on purpose — newlines are statement separators (group 3).
  const TOK = /([ \t\r]+)|(\/\/[^\n]*|#[^\n]*)|(;|\n)|(\d*\.\d+(?:[eE][+\-]?\d+)?|\d+(?:[eE][+\-]?\d+)?)|(@?[A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|==|!=|&&|\|\||[-+*/%^(),<>=!])/g;

  function tokenize(src) {
    const toks = []; let last = 0; TOK.lastIndex = 0; let m;
    while ((m = TOK.exec(src))) {
      if (m.index !== last) throw new Error("Expr: unexpected character '" + src[last] + "' at " + last);
      last = TOK.lastIndex;
      if (m[1] || m[2]) continue;                     // whitespace / comment
      if (m[3]) { toks.push({ type: "sep" }); continue; }
      if (m[4] != null) { toks.push({ type: "num", v: parseFloat(m[4]) }); continue; }
      if (m[5] != null) {
        if (m[5][0] === "@") toks.push({ type: "param", name: m[5].slice(1) });
        else toks.push({ type: "name", v: m[5] });
        continue;
      }
      if (m[6] != null) { toks.push({ type: "op", v: m[6] }); }
    }
    if (last !== src.length) throw new Error("Expr: unexpected character '" + src[last] + "' at " + last);
    return toks;
  }

  /* ------------------------------- parser -------------------------------- */
  // Parses a single expression from a token slice into a closure ctx -> number.
  function compileExpr(toks) {
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    const isOp = (t, v) => t && t.type === "op" && t.v === v;
    const expect = v => { const t = next(); if (!isOp(t, v)) throw new Error("Expr: expected '" + v + "'"); };

    function parseExpr(min) {
      let left = parseUnary();
      for (;;) {
        const t = peek();
        if (!t || t.type !== "op" || !(t.v in PREC) || PREC[t.v] < min) break;
        next();
        const right = parseExpr(PREC[t.v] + 1);   // all binops left-assoc
        const fn = BIN[t.v], l = left, r = right;
        left = ctx => fn(l(ctx), r(ctx));
      }
      return left;
    }
    function parseUnary() {
      const t = peek();
      if (isOp(t, "-")) { next(); const e = parseUnary(); return ctx => -e(ctx); }
      if (isOp(t, "!")) { next(); const e = parseUnary(); return ctx => (e(ctx) === 0 ? 1 : 0); }
      if (isOp(t, "+")) { next(); return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parsePrimary();
      if (isOp(peek(), "^")) { next(); const e = parseUnary(); return ctx => Math.pow(base(ctx), e(ctx)); } // right-assoc
      return base;
    }
    function parsePrimary() {
      const t = next();
      if (!t) throw new Error("Expr: unexpected end of expression");
      if (t.type === "num") { const v = t.v; return () => v; }
      if (t.type === "param") { const name = t.name; return ctx => { if (!(name in ctx.p)) throw new Error("Expr: unknown param @" + name); return ctx.p[name]; }; }
      if (t.type === "name") {
        if (isOp(peek(), "(")) {                     // function call
          next(); const args = [];
          if (!isOp(peek(), ")")) { do { args.push(parseExpr(0)); } while (isOp(peek(), ",") && next()); }
          expect(")");
          const fn = FUNCS[t.v]; if (!fn) throw new Error("Expr: unknown function " + t.v + "()");
          return ctx => { const vals = new Array(args.length); for (let i = 0; i < args.length; i++) vals[i] = args[i](ctx); return fn(vals, ctx); };
        }
        if (t.v in CONSTS) { const c = CONSTS[t.v]; return () => c; }
        const name = t.v;
        return ctx => { if (name in ctx.v) return ctx.v[name]; throw new Error("Expr: unknown name '" + name + "'"); };
      }
      if (isOp(t, "(")) { const e = parseExpr(0); expect(")"); return e; }
      throw new Error("Expr: unexpected token '" + (t.v != null ? t.v : t.type) + "'");
    }

    const fn = parseExpr(0);
    if (pos !== toks.length) throw new Error("Expr: unexpected trailing token '" + (peek().v != null ? peek().v : peek().type) + "'");
    return fn;
  }

  /* --------------------------- program (block) --------------------------- */
  // A program is an ordered list of statements. Each is `name = expr` or a bare
  // expression (its value lands in out._). Returns every assigned var.
  function compile(source) {
    const toks = tokenize(source);
    const groups = [[]];
    toks.forEach(t => { if (t.type === "sep") { if (groups[groups.length - 1].length) groups.push([]); } else groups[groups.length - 1].push(t); });

    const stmts = [], assigned = [];
    groups.forEach(g => {
      if (!g.length) return;
      if (g[0].type === "name" && g[1] && g[1].type === "op" && g[1].v === "=") {
        const name = g[0].v, fn = compileExpr(g.slice(2));
        assigned.push(name);
        stmts.push(ctx => { ctx.v[name] = fn(ctx); });
      } else {
        const fn = compileExpr(g);
        stmts.push(ctx => { ctx.v._ = fn(ctx); });
      }
    });

    return {
      assigned,                                     // for the editor: names this block defines
      run(namespace, params, rng) {
        const ctx = { v: namespace ? Object.assign({}, namespace) : {}, p: params || {}, rng: rng || Math.random };
        for (let i = 0; i < stmts.length; i++) stmts[i](ctx);
        return ctx.v;
      },
    };
  }

  /* ------------------------- seeded RNG (mulberry32) --------------------- */
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Deterministic seed from a list of integers (e.g. doc seed + node id hash + particle id).
  function keySeed() {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < arguments.length; i++) {
      let x = arguments[i] | 0;
      h ^= x & 0xff; h = Math.imul(h, 16777619);
      h ^= (x >>> 8) & 0xff; h = Math.imul(h, 16777619);
      h ^= (x >>> 16) & 0xff; h = Math.imul(h, 16777619);
      h ^= (x >>> 24) & 0xff; h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  // Cheap string hash (for turning a nodeId into an int for keySeed).
  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  C.Expr = { compile, makeRng, keySeed, hashStr, FUNCS };
})();
