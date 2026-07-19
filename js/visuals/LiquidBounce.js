"use strict";
/* Spectrum Bounce — full node-dataflow document. A mirrored frequency `spectrumFloor` heightfield
   feeds BOTH a `floor` renderer (gradient fill + crest, crisp on top) and a `floorBounce` integrator
   that bounces a `dropPool` of gravity-driven droplets off it (with the "punt": a rising column throws
   drops upward). The drops render as `metaballs` liquid; the scene node trails + composites. Ported
   from the hand-coded LiquidBounce.js — same heightfield/punt mechanic, now as composable nodes. */
Synesthesia.Graph.register({
  "id": "LiquidBounce",
  "label": "Spectrum Bounce",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "ballCount",   "def": 50000, "min": 1,     "max": 200000, "step": 1000 },
      { "name": "ballRadius",  "def": 0.003, "min": 0.001, "max": 0.03,   "step": 0.001 },
      { "name": "merge",       "def": 4,     "min": 1,     "max": 8,      "step": 0.5 },
      { "name": "threshold",   "def": 2,     "min": 0.2,   "max": 2,      "step": 0.05 },
      { "name": "edge",        "def": 0.5,   "min": 0.02,  "max": 0.6,    "step": 0.02 },
      { "name": "sheen",       "def": 0.5,   "min": 0,     "max": 1,      "step": 0.05 },
      { "name": "trail",       "def": 0.5,   "min": 0.08,  "max": 1,      "step": 0.02 },
      { "name": "floorHeight", "def": 0.3,   "min": 0.1,   "max": 0.5,    "step": 0.01 },
      { "name": "smoothing",   "def": 2,     "min": 0,     "max": 6,      "step": 1 },
      { "name": "gravity",     "def": 3,     "min": 0.5,   "max": 8,      "step": 0.1 },
      { "name": "restitution", "def": 0.1,   "min": 0.1,   "max": 0.95,   "step": 0.05 },
      { "name": "puntGain",    "def": 1.4,   "min": 0,     "max": 3,      "step": 0.1 },
      { "name": "hueSpread",   "def": 60,    "min": 0,     "max": 240,    "step": 5 },
      { "name": "drop_h",  "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "drop_s",  "def": 0.9, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "drop_v",  "def": 0.9, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "floor_h", "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "floor_s", "def": 0.9, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "floor_v", "def": 0.7, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "crest_h", "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "crest_s", "def": 0.7, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "crest_v", "def": 1,   "min": 0, "max": 1,   "step": 0.02 }
    ] } },

    { "id": "floorField", "type": "spectrumFloor", "cfg": { "cols": 200, "maxBin": 72 },
      "in": { "height": "params:floorHeight", "smoothing": "params:smoothing" } },
    { "id": "drops", "type": "dropPool",
      "in": { "count": "params:ballCount", "size": "params:ballRadius", "merge": "params:merge",
              "hueSpread": "params:hueSpread", "h": "params:drop_h", "s": "params:drop_s", "v": "params:drop_v" } },
    { "id": "phys", "type": "floorBounce",
      "in": { "pool": "drops", "floor": "floorField", "gravity": "params:gravity",
              "restitution": "params:restitution", "punt": "params:puntGain" } },
    { "id": "liquid", "type": "metaballs",
      "in": { "pool": "phys", "threshold": "params:threshold", "edge": "params:edge", "sheen": "params:sheen" } },
    { "id": "floorR", "type": "floor",
      "in": { "field": "floorField", "h": "params:floor_h", "s": "params:floor_s", "v": "params:floor_v",
              "crest_h": "params:crest_h", "crest_s": "params:crest_s", "crest_v": "params:crest_v", "width": { "const": 1 } } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0.0196078431372549 }, "g": { "const": 0.023529411764705882 }, "b": { "const": 0.0392156862745098 } },
      "cfg": { "layers": [
        { "node": "liquid", "blend": "add",  "crisp": false },
        { "node": "floorR", "blend": "add",  "crisp": true }
      ] } }
  ]
});
