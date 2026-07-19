"use strict";
/* Spectrum Pulsar — full node-dataflow document. All sliders in one `params` table
   (params:name); spectrumBars feeds both the bar renderer and the weighted emitter; spawn
   `bake` stays as text; the scene node composites (bars are a crisp additive top layer). */
Synesthesia.Graph.register({
  "id": "pulsar",
  "label": "Spectrum Pulsar",
  "seed": 1,
  "nodes": [
    { "id": "params", "type": "params", "cfg": { "rows": [
      { "name": "barGain",        "def": 1,     "min": 0.05,  "max": 3,      "step": 0.1 },
      { "name": "barWidth",       "def": 2,     "min": 1,     "max": 8,      "step": 0.5 },
      { "name": "innerRatio",     "def": 0.06,  "min": 0.005, "max": 1,      "step": 0.005 },
      { "name": "spin",           "def": 0.005, "min": -0.02, "max": 0.02,   "step": 0.001 },
      { "name": "trail",          "def": 0.12,  "min": 0.05,  "max": 1,      "step": 0.01 },
      { "name": "emberMax",       "def": 40000, "min": 0,     "max": 120000, "step": 5000 },
      { "name": "burstPct",       "def": 0.02,  "min": 0.001, "max": 0.05,   "step": 0.0005 },
      { "name": "emberOnBeat",    "def": 0.15,  "min": 0,     "max": 1,      "step": 0.01 },
      { "name": "emberIntensity", "def": 0.8,   "min": 0.2,   "max": 3,      "step": 0.1 },
      { "name": "emberSizeMin",   "def": 0.4,   "min": 0.2,   "max": 6,      "step": 0.1 },
      { "name": "emberSizeMax",   "def": 1.2,   "min": 0.2,   "max": 8,      "step": 0.1 },
      { "name": "emberLifeMin",   "def": 8,     "min": 1,     "max": 60,     "step": 1 },
      { "name": "emberLifeMax",   "def": 14,    "min": 1,     "max": 120,    "step": 1 },
      { "name": "core",           "def": 0.1,   "min": 0,     "max": 1,      "step": 0.05 },
      { "name": "coreSize",       "def": 0.05,  "min": 0.01,  "max": 0.6,    "step": 0.01 },
      { "name": "hueSpread",      "def": 40,    "min": 0,     "max": 180,    "step": 5 },
      { "name": "ember_h", "def": 30,  "min": 0, "max": 360, "step": 1 },
      { "name": "ember_s", "def": 0.92,"min": 0, "max": 1,   "step": 0.02 },
      { "name": "ember_v", "def": 0.85,"min": 0, "max": 1,   "step": 0.02 },
      { "name": "bar_h",   "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "bar_s",   "def": 0.92,"min": 0, "max": 1,   "step": 0.02 },
      { "name": "bar_v",   "def": 0.9, "min": 0, "max": 1,   "step": 0.02 },
      { "name": "core_h",  "def": 200, "min": 0, "max": 360, "step": 1 },
      { "name": "core_s",  "def": 0.92,"min": 0, "max": 1,   "step": 0.02 },
      { "name": "core_v",  "def": 0.8, "min": 0, "max": 1,   "step": 0.02 }
    ] } },

    { "id": "bars", "type": "spectrumBars",
      "in": { "gain": "params:barGain", "inner": "params:innerRatio", "spin": "params:spin", "hueSpread": "params:hueSpread", "h": "params:bar_h", "s": "params:bar_s", "v": "params:bar_v" } },
    { "id": "barsR", "type": "radialBars", "in": { "points": "bars", "width": "params:barWidth" } },
    { "id": "emit", "type": "emitter",
      "cfg": { "trigger": "beat", "gateSrc": "energy", "anchorMode": "weighted",
        "count": "floor(@emberMax * @burstPct * energy)",
        "bake": "rad = r0 + (r1 - r0) * (0.7 + rand(0, 0.3))\na = ang + rand(-0.5, 0.5) * dang + if(rand(0, 1) < 0.5, PI, 0)\nspd = (1 + rand(0, 3)) * dpr * 60\nx = cx + cos(a) * rad\ny = cy + sin(a) * rad\nvx = cos(a) * spd\nvy = sin(a) * spd\nsize = (@emberSizeMin + rand(0,1) * max(0, @emberSizeMax - @emberSizeMin)) * dpr * 4\nlife = @emberLifeMin + rand(0,1) * max(0, @emberLifeMax - @emberLifeMin)\nh = @ember_h + @hueSpread * min(val, 1)\ns = @ember_s\nv = @ember_v" },
      "in": { "anchors": "bars", "gate": "params:emberOnBeat", "emberMax": "params:emberMax", "burstPct": "params:burstPct", "hueSpread": "params:hueSpread",
              "emberSizeMin": "params:emberSizeMin", "emberSizeMax": "params:emberSizeMax", "emberLifeMin": "params:emberLifeMin", "emberLifeMax": "params:emberLifeMax",
              "ember_h": "params:ember_h", "ember_s": "params:ember_s", "ember_v": "params:ember_v" } },
    { "id": "embersMove", "type": "move", "in": { "pool": "emit" } },
    { "id": "embersR", "type": "glow", "cfg": { "soft": 1.5 }, "in": { "points": "embersMove", "alpha": "params:emberIntensity" } },
    { "id": "core", "type": "point", "in": { "radius": "params:coreSize" } },
    { "id": "coreR", "type": "glow", "cfg": { "soft": 1.5 },
      "in": { "points": "core", "alpha": "params:core", "h": "params:core_h", "s": "params:core_s", "v": "params:core_v" } },

    { "id": "out", "type": "scene",
      "in": { "trail": "params:trail", "r": { "const": 0.03137254901960784 }, "g": { "const": 0.03529411764705882 }, "b": { "const": 0.054901960784313725 } },
      "cfg": { "layers": [
        { "node": "coreR",   "blend": "add", "crisp": false },
        { "node": "embersR", "blend": "add", "crisp": false },
        { "node": "barsR",   "blend": "add", "crisp": true }
      ] } }
  ]
});
