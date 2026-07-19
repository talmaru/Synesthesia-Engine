"use strict";
/* =============================================================================
   SYNESTHESIA GL — shared WebGL2 toolkit for visual scripts.   (classic <script>, no modules)

   Attaches `Synesthesia.GL`. Load order in player.html:
       <script src="js/core.js"></script>
       <script src="js/lib/gl.js"></script>     <-- before the VISUALS markers
       ...visuals...

   Two layers:
     1. mechanics  — Synesthesia.GL.createContext / compile / program / makeTarget / hsl
     2. Scene      — Synesthesia.GL.createScene(canvas, dpr): a trailed RGBA16F accumulation
                     buffer plus the draw passes most particle visuals reuse:
                       scene.fade(trail)                       acc *= (1-trail)
                       scene.lines(float32, count)             additive rounded capsules
                       scene.glow(items, opts)                 additive soft sprites
                       scene.metaballs(items, opts)            field splat + threshold
                       scene.composite(bg)                     acc + bg + dither -> screen

   The visual still runs its own frame(a): it does the physics, then issues these
   calls. The Scene owns buffers/blend/shaders; the visual owns what to draw and
   how it should look. Additive passes are order-free; for metaballs blend:"over",
   call it after the passes it should occlude. composite() is always last.

   Sprite items: array of {x, y, size, r, g, b, life}  (rgb in 0..1, life in 0..1),
   OR a pre-packed Float32Array (8 floats/instance) with opts.count.
   Sprite opts: { sizeScale, soft, alphaFromLife, count }.
   metaballs opts also: { threshold, edge, sheen, blend:"add"|"over" }.
   ========================================================================== */
(function () {
  const GL = {};

  GL.hsl = function (h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hk = t => { t = (t % 1 + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p; };
    return [hk(h + 1 / 3), hk(h), hk(h - 1 / 3)];
  };

  // Beat-locked phase, 0..1 over `beats` beats (default 16), tracked per visual.
  // Replaces the engine's old global `a.hue`: call once per frame, then map the
  // returned phase to colour however the visual likes (e.g. hsl(phase*360, ...)).
  //   const ph = Synesthesia.GL.tempoPhase(this, a, { beats: 16 });
  // Pass a distinct `key` for more than one independent cycle on the same visual.
  GL.tempoPhase = function (state, a, opts) {
    opts = opts || {};
    const beats = opts.beats || 16, key = opts.key || "_phase";
    const bpm = a.bpm || 120, dt = a.dt || 16.7;
    let ph = (state[key] || 0) + dt / (beats * (60000 / bpm));   // +cycles this frame
    ph -= Math.floor(ph);
    state[key] = ph;
    return ph;
  };

  /* ----------------------------- mechanics ------------------------------ */
  GL.createContext = function (canvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return { gl: null, floatOK: false };
    const floatOK = !!gl.getExtension("EXT_color_buffer_float");
    if (!floatOK) console.warn("Synesthesia.GL: no float render target; 8-bit fallback (banding likely).");
    return { gl, floatOK };
  };
  GL.compile = function (gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error("Synesthesia.GL shader:", gl.getShaderInfoLog(s), src);
    return s;
  };
  GL.program = function (gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, GL.compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, GL.compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error("Synesthesia.GL link:", gl.getProgramInfoLog(p));
    return p;
  };
  GL.makeTarget = function (gl, floatOK, W, H) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    const intf = floatOK ? gl.RGBA16F : gl.RGBA8, type = floatOK ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, intf, W, H, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, floatOK ? 0 : 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  };

  /* ------------------------------ shaders ------------------------------- */
  const VS_FS = `#version 300 es
    precision highp float; layout(location=0) in vec2 aPos; out vec2 vUV;
    void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

  const FS_FADE = `#version 300 es
    precision highp float; out vec4 o; void main(){ o = vec4(0.0); }`;  // src ignored (ZERO factor)

  const FS_COMP = `#version 300 es
    precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec3 uBg; uniform float uTone; out vec4 o;
    float hash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }
    void main(){
      vec3 c = texture(uTex,vUV).rgb + uBg;
      if (uTone > 0.0) c = 1.0 - exp(-c * uTone);        // per-channel highlight rolloff: dense additive colour compresses toward — not clips to — white
      float d = (hash(gl_FragCoord.xy) - 0.5) / 255.0;   // 1-LSB dither vs 8-bit banding
      o = vec4(c + d, 1.0);
    }`;

  const VS_LINE = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 aCorner;   // x in [-1,1], y in [0,1]
    layout(location=1) in vec2 aSegA;
    layout(location=2) in vec2 aSegB;
    layout(location=3) in float aHalfW;
    layout(location=4) in vec3 aColor;
    uniform vec2 uRes;
    out vec2 vPix; out vec2 vA; out vec2 vB; out float vHW; out vec3 vColor;
    void main(){
      vec2 d = aSegB - aSegA; float L = max(length(d), 1e-4);
      vec2 al = d / L; vec2 pe = vec2(-al.y, al.x);
      vec2 A2 = aSegA - al*aHalfW; vec2 B2 = aSegB + al*aHalfW;   // round-cap extension
      vec2 mid = mix(A2, B2, aCorner.y);
      vec2 pos = mid + pe*(aCorner.x*aHalfW);
      vPix = pos; vA = aSegA; vB = aSegB; vHW = aHalfW; vColor = aColor;
      gl_Position = vec4(pos/uRes*2.0 - 1.0, 0.0, 1.0);
    }`;

  const FS_LINE = `#version 300 es
    precision highp float;
    in vec2 vPix; in vec2 vA; in vec2 vB; in float vHW; in vec3 vColor;
    out vec4 o;
    void main(){
      vec2 pa = vPix - vA, ba = vB - vA;
      float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-4), 0.0, 1.0);
      float dist = length(pa - ba*h);
      float cov = clamp(vHW - dist + 0.5, 0.0, 1.0);
      o = vec4(vColor*cov, cov);
    }`;

  const VS_SPRITE = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 aCorner;   // [-1,1]^2
    layout(location=1) in vec2 aPos;
    layout(location=2) in float aSize;
    layout(location=3) in vec3 aColor;
    layout(location=4) in float aAlpha;
    layout(location=5) in float aSoft;
    uniform vec2 uRes;
    out vec2 vLocal; out vec3 vColor; out float vAlpha; out float vSoft;
    void main(){
      vec2 pos = aPos + aCorner*aSize;
      vLocal = aCorner; vColor = aColor; vAlpha = aAlpha; vSoft = aSoft;
      gl_Position = vec4(pos/uRes*2.0 - 1.0, 0.0, 1.0);
    }`;

  const FS_GLOW = `#version 300 es
    precision highp float;
    in vec2 vLocal; in vec3 vColor; in float vAlpha; in float vSoft;
    out vec4 o;
    void main(){
      float r = length(vLocal);
      if (r > 1.0) discard;
      float g = pow(clamp(1.0 - r, 0.0, 1.0), vSoft);  // soft=1 wide, >1 tight
      o = vec4(vColor*g*vAlpha, g*vAlpha);
    }`;

  const FS_FIELD = `#version 300 es
    precision highp float;
    in vec2 vLocal; in vec3 vColor; in float vAlpha; in float vSoft;
    out vec4 o;
    void main(){
      float r2 = dot(vLocal, vLocal);
      if (r2 > 1.0) discard;
      float b = 1.0 - r2; float w = b*b*vAlpha;   // (1-r^2)^2 metaball kernel
      o = vec4(vColor*w, w);
    }`;

  const FS_RESOLVE = `#version 300 es
    precision highp float;
    in vec2 vUV; uniform sampler2D uField;
    uniform float uThr; uniform float uEdge; uniform float uSheen;
    out vec4 o;
    void main(){
      vec4 f = texture(uField, vUV);
      float A = f.a;
      if (A <= 1e-5) { o = vec4(0.0); return; }
      vec3 col = f.rgb / A;                                   // merged droplets blend hue
      float cov  = smoothstep(uThr - uEdge, uThr + uEdge, A);
      float band = exp(-pow((A - uThr) / max(uEdge, 1e-3), 2.0));
      vec3 body = col * cov + band * uSheen * cov;
      o = vec4(body, cov);                                    // premultiplied
    }`;

  // bloom: highpass bright pixels (soft knee, keeps hue), 5-tap separable gaussian, additive add-back
  const FS_BLOOM_PRE = `#version 300 es
    precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform float uThr; out vec4 o;
    void main(){ vec3 c = texture(uTex,vUV).rgb; float br = max(c.r,max(c.g,c.b));
      o = vec4(c * (max(br-uThr,0.0)/max(br,1e-4)), 1.0); }`;
  const FS_BLOOM_BLUR = `#version 300 es
    precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
    void main(){ vec3 c = texture(uTex,vUV).rgb * 0.2270270270;
      c += texture(uTex,vUV + uDir*1.3846153846).rgb * 0.3162162162;
      c += texture(uTex,vUV - uDir*1.3846153846).rgb * 0.3162162162;
      c += texture(uTex,vUV + uDir*3.2307692308).rgb * 0.0702702703;
      c += texture(uTex,vUV - uDir*3.2307692308).rgb * 0.0702702703;
      o = vec4(c, 1.0); }`;
  const FS_BLOOM_ADD = `#version 300 es
    precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform float uStr; out vec4 o;
    void main(){ o = vec4(texture(uTex,vUV).rgb * uStr, 1.0); }`;

  // heightfield floor: a gradient triangle-strip (base→crest), dithered vs banding
  const VS_FLOOR = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 aPos; layout(location=1) in float aV;
    uniform vec2 uRes; out float vV;
    void main(){ vV = aV; gl_Position = vec4(aPos/uRes*2.0 - 1.0, 0.0, 1.0); }`;
  const FS_FLOOR = `#version 300 es
    precision highp float; in float vV; uniform vec3 uTop; uniform vec3 uBot; out vec4 o;
    float hash(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }
    void main(){ vec3 c = mix(uBot, uTop, clamp(vV,0.0,1.0)); o = vec4(c + (hash(gl_FragCoord.xy)-0.5)/255.0, 1.0); }`;

  /* ------------------------------- Scene -------------------------------- */
  const STRIDE = 8;          // floats per instance, both line and sprite layouts
  const MAXLINES = 16384;   // a single dendrite tree is thousands of capsules
  const MAXSPRITE = 3000000;  // per-batch sprite cap; buffers below pre-allocate to this

  function Scene(canvas, dpr) {
    this.canvas = canvas; this.dpr = dpr || 1;
    const ctx = GL.createContext(canvas);
    this.gl = ctx.gl; this.floatOK = ctx.floatOK;
    if (!this.gl) return;
    const gl = this.gl;

    this.pFade    = GL.program(gl, VS_FS, FS_FADE);
    this.pComp    = GL.program(gl, VS_FS, FS_COMP);
    this.pLine    = GL.program(gl, VS_LINE, FS_LINE);
    this.pGlow    = GL.program(gl, VS_SPRITE, FS_GLOW);
    this.pField   = GL.program(gl, VS_SPRITE, FS_FIELD);
    this.pResolve = GL.program(gl, VS_FS, FS_RESOLVE);
    this.uCompTex  = gl.getUniformLocation(this.pComp, "uTex");
    this.uCompBg   = gl.getUniformLocation(this.pComp, "uBg");
    this.uCompTone = gl.getUniformLocation(this.pComp, "uTone");
    this.uLineRes  = gl.getUniformLocation(this.pLine, "uRes");
    this.uGlowRes  = gl.getUniformLocation(this.pGlow, "uRes");
    this.uFieldRes = gl.getUniformLocation(this.pField, "uRes");
    this.uResField = gl.getUniformLocation(this.pResolve, "uField");
    this.uResThr   = gl.getUniformLocation(this.pResolve, "uThr");
    this.uResEdge  = gl.getUniformLocation(this.pResolve, "uEdge");
    this.uResSheen = gl.getUniformLocation(this.pResolve, "uSheen");
    this.pPre      = GL.program(gl, VS_FS, FS_BLOOM_PRE);
    this.pBlur     = GL.program(gl, VS_FS, FS_BLOOM_BLUR);
    this.pBloomAdd = GL.program(gl, VS_FS, FS_BLOOM_ADD);
    this.uPreTex = gl.getUniformLocation(this.pPre, "uTex"); this.uPreThr = gl.getUniformLocation(this.pPre, "uThr");
    this.uBlurTex = gl.getUniformLocation(this.pBlur, "uTex"); this.uBlurDir = gl.getUniformLocation(this.pBlur, "uDir");
    this.uAddTex = gl.getUniformLocation(this.pBloomAdd, "uTex"); this.uAddStr = gl.getUniformLocation(this.pBloomAdd, "uStr");
    this.bloomA = this.bloomB = null; this.bloomW = this.bloomH = 0;

    const mk = data => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    this.fsBuf      = mk(new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.lineQuad   = mk(new Float32Array([-1, 0, 1, 0, -1, 1, -1, 1, 1, 0, 1, 1]));
    this.spriteQuad = mk(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));

    const mkInst = floats => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, floats * 4, gl.DYNAMIC_DRAW); return b; };
    this.lineInst  = mkInst(MAXLINES * STRIDE);
    this.glowInst  = mkInst(MAXSPRITE * STRIDE);
    this.fieldInst = mkInst(MAXSPRITE * STRIDE);
    this._scratch  = new Float32Array(MAXSPRITE * STRIDE);

    this.fsVAO = gl.createVertexArray(); gl.bindVertexArray(this.fsVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.lineVAO = gl.createVertexArray(); gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineInst);
    const S = STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 16); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, S, 20); gl.vertexAttribDivisor(4, 1);

    this.glowVAO  = this._spriteVAO(this.glowInst);
    this.fieldVAO = this._spriteVAO(this.fieldInst);
    gl.bindVertexArray(null);

    this.W = 0; this.H = 0; this.acc = null; this.field = null;
    this._resize(canvas.width, canvas.height);
  }

  Scene.prototype._spriteVAO = function (instBuf) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteQuad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const S = STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 12); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, S, 24); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, S, 28); gl.vertexAttribDivisor(5, 1);
    return vao;
  };

  Scene.prototype._resize = function (W, H) {
    const gl = this.gl; this.W = W; this.H = H;
    if (this.acc)   { gl.deleteTexture(this.acc.tex);   gl.deleteFramebuffer(this.acc.fbo); }
    if (this.field) { gl.deleteTexture(this.field.tex); gl.deleteFramebuffer(this.field.fbo); }
    this.acc   = GL.makeTarget(gl, this.floatOK, W, H);
    this.field = GL.makeTarget(gl, this.floatOK, W, H);
  };
  Scene.prototype._sync = function () {
    if (!this.gl) return;
    const W = this.canvas.width, H = this.canvas.height;
    if (W !== this.W || H !== this.H) this._resize(W, H);
  };
  Scene.prototype.resize = function () { this._sync(); };

  Scene.prototype.dispose = function () {
    const gl = this.gl; if (!gl) return;
    [this.pFade, this.pComp, this.pLine, this.pGlow, this.pField, this.pResolve, this.pPre, this.pBlur, this.pBloomAdd, this._floorProg].forEach(p => p && gl.deleteProgram(p));
    [this.fsBuf, this.lineQuad, this.spriteQuad, this.lineInst, this.glowInst, this.fieldInst, this._floorBuf].forEach(b => b && gl.deleteBuffer(b));
    [this.fsVAO, this.lineVAO, this.glowVAO, this.fieldVAO, this._floorVAO].forEach(v => v && gl.deleteVertexArray(v));
    [this.acc, this.field, this.bloomA, this.bloomB].forEach(t => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } });
    if (this._specTex) gl.deleteTexture(this._specTex);
    const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    this.gl = null;
  };

  // returns { data:Float32Array, count }. Pass a Float32Array to skip packing.
  Scene.prototype._packSprites = function (items, opts) {
    opts = opts || {};
    if (items instanceof Float32Array) return { data: items, count: opts.count || 0 };
    const n = Math.min(items.length, MAXSPRITE), arr = this._scratch;
    const sizeScale = opts.sizeScale != null ? opts.sizeScale : 1;
    const soft = opts.soft != null ? opts.soft : 1.5;
    const fromLife = opts.alphaFromLife !== false;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const o = items[i];
      arr[j++] = o.x; arr[j++] = o.y; arr[j++] = (o.size != null ? o.size : 1) * sizeScale;
      arr[j++] = o.r != null ? o.r : 1; arr[j++] = o.g != null ? o.g : 1; arr[j++] = o.b != null ? o.b : 1;
      arr[j++] = fromLife ? (o.life > 1 ? 1 : o.life) : (o.alpha != null ? o.alpha : 1);
      arr[j++] = soft;
    }
    return { data: arr, count: n };
  };

  Scene.prototype.fade = function (trail) {
    this._sync(); const gl = this.gl; if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fbo); gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
    const k = 1 - trail; gl.blendColor(k, k, k, k); gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
    gl.useProgram(this.pFade); gl.bindVertexArray(this.fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // bind the target framebuffer + blend for a layer draw. target: "acc" (trailed accumulation,
  // default) or "screen" (crisp, straight to the display AFTER composite). blend: "add" (ONE,ONE)
  // or "over" (ONE, 1-src.a — premultiplied, so it OCCLUDES what's beneath).
  Scene.prototype._begin = function (target, blend) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target === "screen" ? null : this.acc.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, blend === "over" ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
  };

  Scene.prototype.lines = function (data, count, opts) {
    this._sync(); const gl = this.gl; if (!gl || !count) return;
    opts = opts || {};
    count = Math.min(count, MAXLINES);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineInst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * STRIDE));
    this._begin(opts.target, opts.blend);
    gl.useProgram(this.pLine); gl.uniform2f(this.uLineRes, this.W, this.H);
    gl.bindVertexArray(this.lineVAO); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  };

  // Same capsules, but drawn straight to the screen ON TOP of composite() and
  // OUTSIDE the trail buffer — so they stay crisp while acc-drawn layers smear.
  // Additive over the composited image; the sum matches lines() minus the trail.
  // Must be called AFTER composite().
  Scene.prototype.linesScreen = function (data, count) {
    this._sync(); const gl = this.gl; if (!gl || !count) return;
    count = Math.min(count, MAXLINES);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineInst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * STRIDE));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pLine); gl.uniform2f(this.uLineRes, this.W, this.H);
    gl.bindVertexArray(this.lineVAO); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  };

  Scene.prototype.glow = function (items, opts) {
    this._sync(); const gl = this.gl; if (!gl) return;
    opts = opts || {};
    const packed = this._packSprites(items, opts);
    const n = Math.min(packed.count, MAXSPRITE); if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glowInst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.data.subarray(0, n * STRIDE));
    this._begin(opts.target, opts.blend);
    gl.useProgram(this.pGlow); gl.uniform2f(this.uGlowRes, this.W, this.H);
    gl.bindVertexArray(this.glowVAO); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  };

  Scene.prototype.metaballs = function (items, opts) {
    this._sync(); const gl = this.gl; if (!gl) return;
    opts = opts || {};
    const packed = this._packSprites(items, { sizeScale: opts.sizeScale, soft: 0, alphaFromLife: opts.alphaFromLife, count: opts.count });
    const n = Math.min(packed.count, MAXSPRITE); if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fieldInst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.data.subarray(0, n * STRIDE));
    // splat the field
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.field.fbo); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pField); gl.uniform2f(this.uFieldRes, this.W, this.H);
    gl.bindVertexArray(this.fieldVAO); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    // resolve thresholded surface into the layer's target (acc/screen) with its blend
    this._begin(opts.target, opts.blend);
    gl.useProgram(this.pResolve);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.field.tex);
    gl.uniform1i(this.uResField, 0);
    gl.uniform1f(this.uResThr, opts.threshold != null ? opts.threshold : 0.8);
    gl.uniform1f(this.uResEdge, opts.edge != null ? opts.edge : 0.25);
    gl.uniform1f(this.uResSheen, opts.sheen != null ? opts.sheen : 0.35);
    gl.bindVertexArray(this.fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Run a user program as a full-screen layer pass (the graph `shader` node uses this).
  // The program's vertex shader must take `layout(location=0) in vec2 aPos` (the shared
  // fullscreen triangle). setup(gl) sets its uniforms/textures after useProgram. target/blend
  // as _begin: "acc" (trailed) or "screen" (crisp), "add" or "over".
  Scene.prototype.shaderLayer = function (prog, setup, opts) {
    this._sync(); const gl = this.gl; if (!gl || !prog) return;
    opts = opts || {};
    this._begin(opts.target, opts.blend);
    gl.useProgram(prog);
    if (setup) setup(gl);
    gl.bindVertexArray(this.fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  // A shared 128×1 R8 spectrum texture (LINEAR-filtered) for shader layers to sample as a
  // frequency LUT. Pass the audio `bins` (0..1) to upload this frame; returns the texture.
  Scene.prototype.spectrum = function (bins) {
    const gl = this.gl; if (!gl) return null;
    if (!this._specTex) {
      this._specTex = gl.createTexture(); this._specBuf = new Uint8Array(128);
      gl.bindTexture(gl.TEXTURE_2D, this._specTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this._specBuf);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (bins) {
      const b = this._specBuf;
      for (let i = 0; i < 128; i++) { const v = bins[i] || 0; b[i] = v > 1 ? 255 : v < 0 ? 0 : v * 255; }
      gl.bindTexture(gl.TEXTURE_2D, this._specTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, this._specBuf);
    }
    return this._specTex;
  };

  // composite acc + bg → screen. Optional `tone` (exposure > 0) applies a per-channel highlight
  // rolloff (1 − e^−c·tone) so heavy additive stacking stays coloured instead of clipping to white.
  Scene.prototype.composite = function (bg, tone) {
    this._sync(); const gl = this.gl; if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pComp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.acc.tex);
    gl.uniform1i(this.uCompTex, 0);
    gl.uniform1f(this.uCompTone, tone > 0 ? tone : 0);
    const b = bg || [0, 0, 0]; gl.uniform3f(this.uCompBg, b[0], b[1], b[2]);
    gl.bindVertexArray(this.fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  // half-res ping-pong targets for the bloom blur (LINEAR-filtered so the taps interpolate)
  Scene.prototype._ensureBloom = function () {
    const gl = this.gl, hw = Math.max(1, this.W >> 1), hh = Math.max(1, this.H >> 1);
    if (this.bloomA && this.bloomW === hw && this.bloomH === hh) return;
    [this.bloomA, this.bloomB].forEach(t => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } });
    const mk = () => { const t = GL.makeTarget(gl, this.floatOK, hw, hh);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); return t; };
    this.bloomA = mk(); this.bloomB = mk(); this.bloomW = hw; this.bloomH = hh;
  };

  // Soft bloom, added to the screen additively. Highpass the accumulation buffer (the composited
  // non-crisp layers) above `threshold`, blur it (separable gaussian, half-res, 2 passes), scale by
  // `strength`, add on top. Call AFTER composite() so it glows the scene; crisp layers drawn after
  // stay sharp on top. `spread` widens the blur.
  Scene.prototype.bloom = function (strength, threshold, spread) {
    this._sync(); const gl = this.gl; if (!gl || !(strength > 0)) return;
    this._ensureBloom();
    const A = this.bloomA, B = this.bloomB, W = this.bloomW, H = this.bloomH;
    gl.disable(gl.BLEND); gl.bindVertexArray(this.fsVAO);
    // 1) prefilter acc → A (half-res, bright-only)
    gl.useProgram(this.pPre);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.acc.tex); gl.uniform1i(this.uPreTex, 0);
    gl.uniform1f(this.uPreThr, threshold != null ? threshold : 0.5);
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo); gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 2) separable gaussian, A→B→A→B→A (ends in A)
    gl.useProgram(this.pBlur); gl.uniform1i(this.uBlurTex, 0);
    const sp = spread != null ? spread : 1, sx = sp / W, sy = sp / H;
    const passes = [[B, A, sx, 0], [A, B, 0, sy], [B, A, sx, 0], [A, B, 0, sy]];
    for (const p of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, p[0].fbo); gl.viewport(0, 0, W, H);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p[1].tex);
      gl.uniform2f(this.uBlurDir, p[2], p[3]); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // 3) add the blurred glow to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pBloomAdd);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, A.tex); gl.uniform1i(this.uAddTex, 0);
    gl.uniform1f(this.uAddStr, strength); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  // Draw a heightfield floor: a gradient triangle-strip from the bottom (y=0) up to each column's
  // crest (colH[i]*maxH), coloured bot→top. Opaque, straight to the screen (crisp). Program +
  // vertex buffer are created lazily on first use.
  Scene.prototype.heightFloor = function (colH, cols, maxH, top, bot) {
    this._sync(); const gl = this.gl; if (!gl || !cols || cols < 2) return;
    if (!this._floorProg) {
      this._floorProg = GL.program(gl, VS_FLOOR, FS_FLOOR);
      this._uFloorRes = gl.getUniformLocation(this._floorProg, "uRes");
      this._uFloorTop = gl.getUniformLocation(this._floorProg, "uTop");
      this._uFloorBot = gl.getUniformLocation(this._floorProg, "uBot");
      this._floorBuf = gl.createBuffer();
      this._floorVAO = gl.createVertexArray(); gl.bindVertexArray(this._floorVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._floorBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
      gl.bindVertexArray(null);
    }
    const need = cols * 2 * 3;
    if (!this._floorVerts || this._floorVerts.length < need) this._floorVerts = new Float32Array(need);
    const V = this._floorVerts, W = this.W; let k = 0;
    for (let i = 0; i < cols; i++) { const x = i / (cols - 1) * W, h = colH[i] * maxH;
      V[k++] = x; V[k++] = 0; V[k++] = 0; V[k++] = x; V[k++] = h; V[k++] = colH[i]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._floorBuf); gl.bufferData(gl.ARRAY_BUFFER, V.subarray(0, need), gl.DYNAMIC_DRAW);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H); gl.disable(gl.BLEND);
    gl.useProgram(this._floorProg);
    gl.uniform2f(this._uFloorRes, this.W, this.H);
    gl.uniform3f(this._uFloorTop, top[0], top[1], top[2]);
    gl.uniform3f(this._uFloorBot, bot[0], bot[1], bot[2]);
    gl.bindVertexArray(this._floorVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, cols * 2); gl.bindVertexArray(null);
  };

  GL.createScene = function (canvas, dpr) { return new Scene(canvas, dpr); };
  GL.Scene = Scene;

  (window.Synesthesia = window.Synesthesia || {}).GL = GL;
})();
