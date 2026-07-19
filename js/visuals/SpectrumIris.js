"use strict";
/* Spectrum Iris — full node-dataflow document. A single `shader` node runs the 2D SDF
   iris fragment shader as a full-screen layer; all sliders live in one `params` table and
   feed the shader's `uniform float u…` inputs. The old JS-accumulated spin is now derived
   in-shader from uTime * uSpinRate (self-contained, wireable). The scene node clears each
   frame (trail 1) and composites the layer — proof that GPU shader visuals fit the graph. */
Synesthesia.Graph.register({
  "id": "SpectrumIris",
  "label": "Spectrum Iris",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "radius",   "def": 0.55, "min": 0.2, "max": 1.0, "step": 0.02 },
      { "name": "waveAmt",  "def": 0.35, "min": 0,   "max": 0.7, "step": 0.02 },
      { "name": "spinRate", "def": 1.2,  "min": -4,  "max": 4,   "step": 0.1 },
      { "name": "glow",     "def": 0.8,  "min": 0,   "max": 2,   "step": 0.05 },
      { "name": "falloff",  "def": 3,    "min": 0.5, "max": 8,   "step": 0.1 },
      { "name": "iris_h",   "def": 200,  "min": 0,   "max": 360, "step": 1 },
      { "name": "iris_s",   "def": 0.85, "min": 0,   "max": 1,   "step": 0.02 },
      { "name": "iris_v",   "def": 0.6,  "min": 0,   "max": 1,   "step": 0.02 },
      { "name": "hueSpan",  "def": 140,  "min": 0,   "max": 360, "step": 5 },
      { "name": "trail",    "def": 1,    "min": 0.05,"max": 1,   "step": 0.01 }
    ] } },

    { "id": "aud", "type": "audio" },

    { "id": "iris", "type": "shader",
      "cfg": { "frag": "#version 300 es\nprecision highp float;\n#define PI 3.14159265\nin vec2 vUV;\nuniform vec2 uRes;\nuniform float uTime;\nuniform float uHue, uSat, uVal, uHueSpan;\nuniform float uRadius, uWaveAmt, uGlow, uFalloff, uSpinRate;\nuniform sampler2D uSpec;\nout vec4 fragColor;\nvec3 hsv(float h, float s, float v){\n  h = mod(h,360.0)/60.0;\n  float c=v*s, x=c*(1.0-abs(mod(h,2.0)-1.0)), m=v-c;\n  vec3 r=(h<1.0)?vec3(c,x,0):(h<2.0)?vec3(x,c,0):(h<3.0)?vec3(0,c,x):\n         (h<4.0)?vec3(0,x,c):(h<5.0)?vec3(x,0,c):vec3(c,0,x);\n  return r+m;\n}\nfloat spectrum(float t){ return texture(uSpec, vec2(clamp(t,0.0,1.0),0.5)).r; }\nvoid main(){\n  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;\n  vec2 p  = uv * 2.2;\n  float sp = uTime * uSpinRate;\n  float cs = cos(sp), sn = sin(sp);\n  p = mat2(cs,-sn,sn,cs) * p;\n  float r = length(p);\n  float a = atan(p.x, p.y) / PI;\n  float fold = a >= 0.0 ? a : (1.0 + a);\n  fold = 1.0 - abs(2.0*fold - 1.0);\n  float wave = spectrum(fold);\n  float R = uRadius + (wave - 0.3) * uWaveAmt;\n  float d = r - R;\n  float distEdge = abs(d);\n  float bright = exp(-distEdge * uFalloff);\n  vec3 base = hsv(uHue + fold*uHueSpan, uSat, uVal);\n  vec3 invert = vec3(1.0) - base;\n  vec3 col = (d < 0.0 ? invert : base) * bright;\n  col += base * smoothstep(0.05, 0.0, distEdge) * uGlow;\n  fragColor = vec4(col, 1.0);\n}\n" },
      "in": { "spectrum": "aud:bins",
              "uRadius": "params:radius", "uWaveAmt": "params:waveAmt", "uSpinRate": "params:spinRate",
              "uGlow": "params:glow", "uFalloff": "params:falloff", "uHue": "params:iris_h",
              "uSat": "params:iris_s", "uVal": "params:iris_v", "uHueSpan": "params:hueSpan" } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0 }, "g": { "const": 0 }, "b": { "const": 0 } },
      "cfg": { "layers": [ { "node": "iris", "blend": "add", "crisp": false } ] } }
  ]
});
