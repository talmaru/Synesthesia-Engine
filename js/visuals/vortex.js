"use strict";
/* Vortex — full node-dataflow document. All sliders in one `params` table (params:name);
   the flow field is a stack of force nodes; the spawn `bake` stays as text; the scene node
   composites (metaballs layer, `over` blend = liquid). */
Synesthesia.Graph.register({
  "id": "vortex",
  "label": "Vortex",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "dot",         "def": 5,     "min": 1,     "max": 20,     "step": 0.5 },
      { "name": "dropOpacity", "def": 0.5,   "min": 0.1,   "max": 1.5,    "step": 0.05 },
      { "name": "threshold",   "def": 0.2,   "min": 0.2,   "max": 2,      "step": 0.05 },
      { "name": "edge",        "def": 0.6,   "min": 0.02,  "max": 0.6,    "step": 0.02 },
      { "name": "sheen",       "def": 0.5,   "min": 0,     "max": 1,      "step": 0.05 },
      { "name": "trail",       "def": 0.5,   "min": 0.05,  "max": 1,      "step": 0.01 },
      { "name": "inflow",      "def": 0,     "min": -4,    "max": 4,      "step": 0.05 },
      { "name": "curl",        "def": 0.3,   "min": -8,    "max": 8,      "step": 0.1 },
      { "name": "turbAmp",     "def": 250,   "min": 0,     "max": 1200,   "step": 10 },
      { "name": "turbScale",   "def": 8,     "min": 0.5,   "max": 8,      "step": 0.25 },
      { "name": "turbSpeed",   "def": 0.6,   "min": 0,     "max": 3,      "step": 0.05 },
      { "name": "response",    "def": 1,     "min": 0.05,  "max": 1,      "step": 0.05 },
      { "name": "lifespan",    "def": 12,    "min": 1,     "max": 30,     "step": 0.5 },
      { "name": "maxParticles","def": 40000, "min": 0,     "max": 120000, "step": 1000 },
      { "name": "burstPct",    "def": 0.03,  "min": 0.001, "max": 0.03,   "step": 0.0005 },
      { "name": "minDrops",    "def": 400,   "min": 0,     "max": 3000,   "step": 50 },
      { "name": "beatGate",    "def": 0.05,  "min": 0,     "max": 1,      "step": 0.01 },
      { "name": "density",     "def": 2,     "min": 0.5,   "max": 4,      "step": 0.1 },
      { "name": "drop_h",  "def": 200, "min": 0,    "max": 360, "step": 1 },
      { "name": "drop_s",  "def": 0.9, "min": 0,    "max": 1,   "step": 0.02 },
      { "name": "drop_v",  "def": 0.7, "min": 0,    "max": 1,   "step": 0.02 },
      { "name": "hueSpan", "def": 90,  "min": -180, "max": 180, "step": 2 }
    ] } },

    { "id": "drops", "type": "emitter",
      "cfg": { "trigger": "beat", "gateSrc": "energy",
        "count": "max(@minDrops, floor(@maxParticles * @burstPct * energy))",
        "burstBake": "size = @dot * dpr\nc = size / @density\nR = c * sqrt(count)\nmargin = R + 6 * dpr\nedge = floor(rand(0, 4))\nex = margin + rand(0, 1) * (W - 2 * margin)\ney = margin + rand(0, 1) * (H - 2 * margin)\nbx = if(edge == 0, margin, if(edge == 1, W - margin, ex))\nby = if(edge == 2, margin, if(edge == 3, H - margin, ey))",
        "bake": "rr = c * sqrt(i + 0.5)\nang = i * 2.399963229728653\nsdf = rr / R\nx = bx + cos(ang) * rr\ny = by + sin(ang) * rr\nop = 1 - 0.7 * sdf\nh = @drop_h + @hueSpan * sdf + rand(-4, 4)\ns = @drop_s\nv = @drop_v\nlife = @lifespan * (0.7 + rand(0, 0.3))" },
      "in": { "gate": "params:beatGate", "minDrops": "params:minDrops", "maxParticles": "params:maxParticles", "burstPct": "params:burstPct",
              "dot": "params:dot", "density": "params:density", "lifespan": "params:lifespan",
              "drop_h": "params:drop_h", "drop_s": "params:drop_s", "drop_v": "params:drop_v", "hueSpan": "params:hueSpan" } },
    { "id": "fInflow", "type": "inflow",     "in": { "pool": "drops",   "strength": "params:inflow" } },
    { "id": "fCurl",   "type": "curl",       "in": { "pool": "fInflow", "strength": "params:curl" } },
    { "id": "fTurb",   "type": "turbulence", "in": { "pool": "fCurl", "amp": "params:turbAmp", "scale": "params:turbScale", "speed": "params:turbSpeed" } },
    { "id": "fMove",   "type": "advect",     "in": { "pool": "fTurb", "response": "params:response" } },
    { "id": "render",  "type": "metaballs",
      "in": { "pool": "fMove", "size": "params:dot", "opacity": "params:dropOpacity", "threshold": "params:threshold",
              "edge": "params:edge", "sheen": "params:sheen" } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0.0392156862745098 }, "g": { "const": 0.047058823529411764 }, "b": { "const": 0.07058823529411765 } },
      "cfg": { "layers": [ { "node": "render", "blend": "over", "crisp": false } ] } }
  ]
});
