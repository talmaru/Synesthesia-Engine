# Synesthesia

A local, dependency-free WebGL audio visualizer. Point it at your own music, then decide
for yourself how that music drives what you see.

No build step, no install, no server, no network. Two HTML files and some JavaScript.

## Run it

**Double-click `player.html`.** That's it — it opens straight from `file://`.

Nothing ships with audio. Click **＋ Add files** and pick some local music (mp3, wav, m4a,
flac, ogg, opus). The playlist is session-only: browsers can't reopen a local file by path
after a reload, so you re-add files each launch.

Chrome or Edge recommended. There's also a **🖥 Desktop** button that visualizes whatever
your system or another tab is playing, instead of a file (pick a source and tick "share
audio" in the picker).

## The idea

Most visualizers hard-code their reactions: the developer decided bass makes it bigger, and
that's what it does forever.

Here the two halves are separate:

- **The simulation** is fixed, hand-written code. A Chladni plate, a 4D hypercube, an
  artificial chemistry. It has parameters, and out of the box **none of them react to
  anything** — every slider just sits where you leave it.
- **The reactivity is yours.** Open the panel (⚙, top right) and hit the **⟳** button next
  to any slider. That attaches a *modulator*, and now the music drives that parameter.

So the interesting behaviour is authored in code, and how the music moves it is authored by
you, per parameter, to your taste. Two people can run the same visual off the same track and
get completely different results.

## Modulators

A modulator is one chain:

```
source  →  [optional ops]  →  range
```

**Source** — what listens to the music. One of:

| Source | What it gives you |
|---|---|
| Bass / Mid / Treble | that frequency band, 0–1 |
| Energy | overall loudness |
| Centroid | spectral brightness — high when the mix is bright, low when it's dark |
| Beat (envelope) | fires on each detected beat and decays; set the decay in seconds |
| Cycler (LFO) | ignores the audio entirely — a free-running sine/triangle/ramp, either locked to the tempo or to wall-clock seconds |

Bass/Mid/Treble/Energy/Centroid can also **blend** in a second band, with a mix slider.

**Ops** — optional, applied in order. Most modulators need none:

- **Gate** — anything below the threshold reads as zero, and the rest is stretched back out
  to fill the range. This is how you ignore the noise floor so a parameter only responds to
  real hits.
- **Curve** — an exponent. Above 1, the parameter only wakes up near the top of the range;
  below 1, it's most sensitive at the bottom.
- **Spring** — a damped follow. Turns a jumpy band into a swell with a little overshoot. If
  something driven by raw bass looks like it's flickering, this is the fix.

**Range** — the two numbers the 0–1 signal maps onto. Always there, pre-filled with the
parameter's own limits. Inverting them (high → low) is a legitimate and useful move.

Some starting points worth trying on **Orbit Scope**:

- `energy → Orbit radius`, range 0.12 → 0.30 — the orbit breathes with the track
- `beat envelope → Body bright`, decay 0.3 — flashes on the kick
- `cycler (ramp, per-beat, rate 0.03125) → Base hue`, range 0 → 360 — one full colour cycle
  every 32 beats
- `treble → Bolt reach` with a Gate at 0.25 — only real highs throw long lightning

## Presets

**Save preset** downloads a `.json` holding both the slider values and every modulator.
**Load preset…** reads one back. They're plain readable JSON, so they're easy to share, diff,
or hand-edit. There's an example in `js/visuals/Presets/`.

Settings also persist in `localStorage`, so your last setup is still there when you reopen
the page.

## Recording

`recorder.html` renders a visual against a track offline and encodes it to video — frame by
frame, faster or slower than realtime, so the output isn't affected by dropped frames. It
uses WebCodecs, so it's **Chrome/Edge only**. Presets carry over from the player, modulators
included.

## The visuals

| Visual | |
|---|---|
| Orbit Scope | orbiting bodies, an oscilloscope trace strung between them, fractal bolts on the beat |
| Chladni Plate | sand grains migrating to the nodal lines of a vibrating plate |
| Tesseract Drive | a 4D hypercube; audio bands drive rotation in the w-planes |
| Photomolecular Field | an artificial chemistry — atoms with valence bond, form angles, and detonate |
| Spectrum Pulsar | spectrum bars with embers emitted where the loud bins are |
| Vortex | curl-noise particle flow rendered as metaballs |
| Spectrum Iris | a fragment-shader iris driven by the spectrum |
| Fractal Dendrites | branching trees that grow inward from the screen edges |
| Aurora | procedural aurora curtains over a starfield |
| Spectrum Bounce | droplets bouncing on a floor shaped by the spectrum |
| Diagnostics | a debug readout of the analysis frame — useful when tuning modulators |

## Adding your own visual

Two steps, and **the second one is easy to forget**:

1. Drop a file in `js/visuals/`
2. Add a `<script>` tag for it in `player.html` (and `recorder.html` if you want to record
   it), between the `VISUALS_START` / `VISUALS_END` markers

There's no auto-discovery — a `file://` page can't list a directory. If your visual doesn't
show up in the dropdown, it's almost always the missing script tag.

A visual is a plain object:

```js
Synesthesia.register({
  id: "myvisual",
  label: "My Visual",
  params: [
    { key: "size", label: "Size", type: "range", min: 1, max: 50, step: 1, default: 10 },
  ],
  mount(host) { /* host.canvas, host.dpr */ },
  resize(w, h) {},
  unmount() {},
  frame(a) { /* a.bass, a.mid, a.treble, a.energy, a.beat, a.bpm, a.bins, a.wave, a.dt */
             /* read your params from this.p — e.g. this.p.size */ },
});
```

Every `type: "range"` param automatically gets a `⟳` button in the panel. You don't write any
audio-reactive code — declare the parameter and let the user wire it up.

## Two systems in here

Five visuals (Orbit Scope, Chladni, Tesseract, Photomolecular, Diagnostics) are plain
hand-written code as described above.

The other six are built on an older experiment: a node-graph engine (`js/lib/graph.js`) where
a whole visual was described as a document of wired nodes. It worked, but it turned out more
complex than it was worth, and it's no longer the direction. Those six still run on it, and
modulators work on them exactly the same way, so as a user you won't notice. It's kept purely
so they keep working — don't build anything new on it.

## Layout

```
player.html          the player — start here
recorder.html        offline render to video (Chrome/Edge)
js/core.js           engine, host, player, panel, presets
js/lib/audio.js      FFT analysis: bands, energy, beat detection, BPM
js/lib/mod.js        modulators — sources, ops, evaluation, the ⟳ editor
js/lib/gl.js         WebGL scene: accumulation, glow, lines, metaballs, bloom
js/lib/color.js      colour helpers
js/lib/expr.js       expression evaluator  ─┐
js/lib/graph.js      node-graph engine      ─┴ legacy, supports the six graph visuals
js/lib/baker.js      offline audio analysis for the recorder
js/visuals/          one file per visual
```

## License

MIT — see [LICENSE](LICENSE).
