"use strict";
/* Aurora — full node-dataflow document. The whole visual is ONE `shader` node (the ported
   aurora fragment shader: fBm flow-field curtains over a procedural night sky) whose float
   uniforms are wired from a `params` table; the scene node clears each frame (trail 1, a
   full-frame shader) and applies the graph's `bloom` post. Ported from the hand-coded
   aurora.js: FRAG converted WebGL1→GLSL3 (gl_FragColor→out), bloom moved to the scene node,
   uTime drives all motion (no JS accumulation needed). */
Synesthesia.Graph.register({
  "id": "aurora",
  "label": "Aurora",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "curtains",   "def": 4,    "min": 1,     "max": 6,    "step": 1 },
      { "name": "sharpness",  "def": 4,    "min": 0.2,   "max": 4,    "step": 0.1 },
      { "name": "height",     "def": 0.4,  "min": 0.2,   "max": 1.2,  "step": 0.05 },
      { "name": "baseY",      "def": 0,    "min": -0.2,  "max": 0.6,  "step": 0.05 },
      { "name": "flowScale",  "def": 2,    "min": 0.5,   "max": 6,    "step": 0.1 },
      { "name": "flowStr",    "def": 0.5,  "min": 0,     "max": 1.5,  "step": 0.05 },
      { "name": "flowSpeed",  "def": 0.4,  "min": 0,     "max": 1,    "step": 0.02 },
      { "name": "turbulence", "def": 4,    "min": 1,     "max": 6,    "step": 1 },
      { "name": "drift",      "def": 0.02, "min": -0.5,  "max": 0.5,  "step": 0.02 },
      { "name": "shimmer",    "def": 0,    "min": 0,     "max": 1,    "step": 0.05 },
      { "name": "edgeGlow",   "def": 0,    "min": 0,     "max": 3,    "step": 0.1 },
      { "name": "milkyway",   "def": 0.9,  "min": 0,     "max": 4,    "step": 0.05 },
      { "name": "starDens",   "def": 1,    "min": 0,     "max": 1.5,  "step": 0.05 },
      { "name": "mwAngle",    "def": -0.13,"min": -1.57, "max": 1.57, "step": 0.02 },
      { "name": "skyDrift",   "def": 0.2,  "min": 0,     "max": 0.2,  "step": 0.005 },
      { "name": "natural",    "def": 1,    "min": 0,     "max": 1,    "step": 0.05 },
      { "name": "bright",     "def": 0.7,  "min": 0.2,   "max": 2.5,  "step": 0.1 },
      { "name": "aur_h",      "def": 140,  "min": 0,     "max": 360,  "step": 1 },
      { "name": "aur_s",      "def": 1,    "min": 0,     "max": 1,    "step": 0.05 },
      { "name": "aur_v",      "def": 0.55, "min": 0,     "max": 1,    "step": 0.05 },
      { "name": "trail",      "def": 1,    "min": 0.05,  "max": 1,    "step": 0.01 },
      { "name": "bloom",      "def": 0.6,  "min": 0,     "max": 3,    "step": 0.05 },
      { "name": "bloomThresh","def": 0.2,  "min": 0,     "max": 1,    "step": 0.02 }
    ] } },

    { "id": "aur", "type": "shader",
      "cfg": { "frag": `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2  uRes;
uniform float uTime, uHue;
uniform float uCurtains, uSharp, uHeight, uBaseY;
uniform float uFlowScale, uFlowStr, uFlowSpeed, uTurb;
uniform float uDrift, uShimmer, uNatural, uBright, uSatur, uVal;
uniform float uStarDens, uMilkyway, uMwAngle, uSkyDrift;
uniform float uEdgeGlow;
out vec4 fragColor;

float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i), b = hash21(i+vec2(1,0));
  float c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p, int oct){
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; v += amp * vnoise(p); p *= 2.0; amp *= 0.5; }
  return v;
}
vec3 hsv(float h, float s, float v){
  h = mod(h,360.0)/60.0;
  float c=v*s, x=c*(1.0-abs(mod(h,2.0)-1.0)), m=v-c;
  vec3 r=(h<1.0)?vec3(c,x,0):(h<2.0)?vec3(x,c,0):(h<3.0)?vec3(0,c,x):
         (h<4.0)?vec3(0,x,c):(h<5.0)?vec3(x,0,c):vec3(c,0,x);
  return r+m;
}
vec3 starColorTemp(float t){
  vec3 amber=vec3(1.0,0.86,0.72), white=vec3(1.0), blue=vec3(0.75,0.85,1.0);
  return t<0.5 ? mix(amber,white,t*2.0) : mix(white,blue,(t-0.5)*2.0);
}
vec3 starLayer(vec2 P, float scale, float drift, float dens, float falloff, float size, float band, float clusterAmt, float imul){
  vec2 g = P*scale; g.x += drift;
  vec2 cell = floor(g);
  float h = hash21(cell);
  float d = clamp(dens * (0.4 + band*clusterAmt), 0.0, 1.0);
  if (h >= d) return vec3(0.0);
  vec2 sub = fract(g)-0.5 - (vec2(hash21(cell+1.0),hash21(cell+2.0))-0.5)*0.6;
  float sd = length(sub);
  float mag = pow(hash21(cell+3.0), falloff) * imul;
  float twSpd = 0.6;
  float tw = 1.0 - 0.5*(1.0+sin(uTime*twSpd*(1.0+hash21(cell+5.0)*2.0)+h*30.0));
  float s = smoothstep(size, 0.0, sd) * mag * tw;
  return s * starColorTemp(hash21(cell+4.0)) * 2.0;
}
vec3 sky(vec2 uvN){
  float aspect = uRes.x/uRes.y;
  vec2 p = vec2((uvN.x-0.5)*aspect, uvN.y);
  vec3 col = vec3(0.0);
  vec2 c = vec2(0.0, 0.5), dd = p - c;
  float cs=cos(uMwAngle), sn=sin(uMwAngle);
  vec2 r = vec2(dd.x*cs - dd.y*sn, dd.x*sn + dd.y*cs) + c;
  float centerline = 0.5 - 0.15 * r.x * r.x;
  float bandDist = r.y - centerline;
  float band = exp(-(bandDist*bandDist)/(0.04*0.04));
  float clouds = pow(fbm(p*24.0 + 10.0, 6), 3.3);
  col += band * clouds * uMilkyway * vec3(0.67, 0.744, 0.94);
  float drift = uTime * uSkyDrift;
  col += starLayer(p, 320.0, drift,     0.34*uStarDens,  7.0, 0.20, band, 3.0, 1.0);
  col += starLayer(p, 140.0, drift*2.8, 0.48*uStarDens, 10.0, 0.18, band, 1.2, 1.6);
  return col;
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  uv.y = 1.0 - (gl_FragCoord.y / uRes.y);
  vec3 col = sky(gl_FragCoord.xy / uRes);
  float flowStr = uFlowStr;
  float top = uBaseY + uHeight;
  float bright = uBright;
  float t = uTime;
  float aur = 0.0, eglow = 0.0;
  float colorH = 0.0, wsum = 0.0;
  for (int i = 0; i < 6; i++){
    if (float(i) >= uCurtains) break;
    float fi = float(i);
    float depth = 0.6 + fi*0.18;
    float fx = uv.x*uFlowScale + t*uDrift*depth + fi*3.7;
    float flow = (fbm(vec2(fx, t*uFlowSpeed + fi*2.0), int(uTurb)) - 0.5) * 2.0 * flowStr;
    float shim = uShimmer * 0.08 * sin(uv.x*30.0 + t*4.0 + fi);
    float cx = flow + shim;
    float vert = smoothstep(uBaseY, uBaseY+0.05, uv.y) * smoothstep(top*depth, uBaseY, uv.y);
    float streak = fbm(vec2((uv.x - cx)*uFlowScale*1.5 + fi*9.0, uv.y*2.0 - t*0.3), 3);
    float hpres = pow(clamp(streak,0.0,1.0), uSharp);
    float band = hpres * vert;
    float aa = band / depth;
    aur += aa;
    colorH += aa * uv.y;
    wsum += aa;
    float edgeBand = exp(-pow((uv.y - uBaseY - 0.025)/0.03, 2.0));
    eglow += hpres * edgeBand / depth;
  }
  float heightMix = wsum > 0.0 ? colorH/wsum : 0.0;
  vec3 natural = mix(vec3(0.1,1.0,0.45), vec3(0.8,0.2,0.9), smoothstep(0.25,0.9,heightMix));
  float hh = uHue + heightMix*120.0;
  vec3 hued = hsv(hh, uSatur, uVal);
  vec3 aurCol = mix(natural, hued, uNatural);
  aurCol = mix(vec3(dot(aurCol, vec3(0.33))), aurCol, uSatur);
  col += aurCol * aur * bright;
  vec3 glowCol = mix(aurCol, vec3(1.0), 0.5);
  col += glowCol * eglow * uEdgeGlow;
  col = col / (col + 0.7);
  col = pow(col, vec3(0.85));
  fragColor = vec4(col, 1.0);
}
` },
      "in": { "uHue": "params:aur_h", "uCurtains": "params:curtains", "uSharp": "params:sharpness",
              "uHeight": "params:height", "uBaseY": "params:baseY", "uFlowScale": "params:flowScale",
              "uFlowStr": "params:flowStr", "uFlowSpeed": "params:flowSpeed", "uTurb": "params:turbulence",
              "uDrift": "params:drift", "uShimmer": "params:shimmer", "uNatural": "params:natural",
              "uBright": "params:bright", "uSatur": "params:aur_s", "uVal": "params:aur_v",
              "uStarDens": "params:starDens", "uMilkyway": "params:milkyway", "uMwAngle": "params:mwAngle",
              "uSkyDrift": "params:skyDrift", "uEdgeGlow": "params:edgeGlow" } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0 }, "g": { "const": 0 }, "b": { "const": 0 },
              "bloom": "params:bloom", "bloomThresh": "params:bloomThresh" },
      "cfg": { "layers": [ { "node": "aur", "blend": "add", "crisp": false } ] } }
  ]
});
