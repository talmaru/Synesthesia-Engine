"use strict";
/* Fractal Dendrites — full node-dataflow document. A `rate` emitter plants seeds on the screen
   edges aimed inward (bake sets x/y at a random edge + ux/uy toward centre + reach via edgedist);
   the `fractal` node (shape "branch") bakes a recursive tree per seed ONCE and reveals it root→tip
   as the seed ages (growth front + tip glow + end-of-life fade); `lines` strokes it, the scene node
   trails+composites. Single-hue for now (per-segment rainbow/taper needs a wider segment payload). */
Synesthesia.Graph.register({
  "id": "dendrites",
  "label": "Fractal Dendrites",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "spawnRate",    "def": 6,   "min": 0,    "max": 30,   "step": 1 },
      { "name": "life",         "def": 4,   "min": 1,    "max": 12,   "step": 0.5 },
      { "name": "depth",        "def": 5,   "min": 1,    "max": 8,    "step": 1 },
      { "name": "wobble",       "def": 0.2, "min": 0,    "max": 1,    "step": 0.02 },
      { "name": "branch",       "def": 2.5, "min": 0,    "max": 6,    "step": 0.5 },
      { "name": "spread",       "def": 0.6, "min": 0,    "max": 1.5,  "step": 0.05 },
      { "name": "decay",        "def": 0.82,"min": 0.5,  "max": 0.95, "step": 0.01 },
      { "name": "inwardSpread", "def": 1.0, "min": 0,    "max": 3.14, "step": 0.05 },
      { "name": "trunkLen",     "def": 0.5, "min": 0.1,  "max": 1,    "step": 0.05 },
      { "name": "width",        "def": 1.5, "min": 0.5,  "max": 5,    "step": 0.5 },
      { "name": "taper",        "def": 0.7, "min": 0,    "max": 1,    "step": 0.05 },
      { "name": "rainbow",      "def": 120, "min": 0,    "max": 360,  "step": 10 },
      { "name": "trail",        "def": 0.4, "min": 0.05, "max": 1,    "step": 0.01 },
      { "name": "bloom",        "def": 0.7, "min": 0,    "max": 3,    "step": 0.05 },
      { "name": "bloomThresh",  "def": 0.35,"min": 0,    "max": 1,    "step": 0.02 },
      { "name": "dend_h", "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "dend_s", "def": 0.85,"min": 0, "max": 1,   "step": 0.02 },
      { "name": "dend_v", "def": 0.9, "min": 0, "max": 1,   "step": 0.02 }
    ] } },

    { "id": "seed", "type": "emitter",
      "cfg": { "trigger": "rate",
        "bake": "edge = floor(rand(0, 4))\nalong = rand(0, 1)\nmx = min(W, H) * 0.05\nx = if(edge < 2, along * W, if(edge == 2, rand(0, mx), W - rand(0, mx)))\ny = if(edge == 0, rand(0, mx), if(edge == 1, H - rand(0, mx), along * H))\nca = atan2(H * 0.5 - y, W * 0.5 - x)\nang = ca + rand(-0.5, 0.5) * @inwardSpread\nux = cos(ang)\nuy = sin(ang)\nmd = min(W, H)\nreach = min(edgedist(x, y, ux, uy), md * (0.2 + 0.6 * @trunkLen))\nlife = @life" },
      "in": { "rate": "params:spawnRate", "life": "params:life",
              "inwardSpread": "params:inwardSpread", "trunkLen": "params:trunkLen" } },
    { "id": "tree", "type": "fractal", "cfg": { "shape": "branch" },
      "in": { "pool": "seed", "detail": "params:depth", "rough": "params:wobble",
              "branch": "params:branch", "spread": "params:spread", "decay": "params:decay",
              "rainbow": "params:rainbow", "taper": "params:taper" } },
    { "id": "treeR", "type": "lines",
      "in": { "segs": "tree", "width": "params:width", "h": "params:dend_h", "s": "params:dend_s", "v": "params:dend_v" } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0.0196078431372549 }, "g": { "const": 0.023529411764705882 }, "b": { "const": 0.0392156862745098 },
              "bloom": "params:bloom", "bloomThresh": "params:bloomThresh" },
      "cfg": { "layers": [ { "node": "treeR", "blend": "add", "crisp": false } ] } }
  ]
});
