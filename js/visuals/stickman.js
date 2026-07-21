"use strict";
/* Stickman — a figure that dances.

   THE TRICK: the core is PROCEDURAL, the limbs are PHYSICAL.

   The hips, spine and shoulders are driven directly from a tempo-locked groove — a bob, a
   weight-shift, a shoulder counter-rotation. That part is a function of the beat clock, so it
   is always exactly in time and can never drift or fall over.

   Everything hanging off it — head, arms, hands, knees, feet — is a Verlet chain with gravity,
   damping and distance constraints. It is never animated; it just follows, overshoots, trails
   and settles. That is where the life comes from: rhythm from the groove, motion from physics.

   Feet are planted on the ground and STEP on their own: when a foot gets stretched too far
   from the hips it releases, swings, and re-plants where it lands. So walking and weight
   transfer are emergent, not choreographed — nothing here knows what a step is.

   PARAMETERS split the same way the body does.

   DRIVEN parts (hips, torso, shoulders, neck) get MOTIONS. Every motion is the same two
   numbers — an AMOUNT and a RATE in cycles per beat — so the rhythm is yours, not baked in:
       hips      bob (up/down) . sway (side/side) . twist
       torso     lean
       shoulders twist, offset from the hips by `counterPhase` (0.5 = exactly opposing)
       neck      nod, with `nodSnap` shaping smooth-sine vs sharp-snap-and-hang
   `groove` scales every amount at once, `tempo` scales every rate at once.

   PASSIVE parts (head, arms, hands, knees, feet) are never posed, so they have no motions —
   only PROPERTIES: looseness, gravity, arm lift, beat impulse, stance, step reach. They move
   because something above them moved, and that lag IS the character.

   Nothing is audio-reactive by itself; attach modulators in the player (⟳). The knobs that
   change its CHARACTER rather than its intensity: `looseness` (rigid robot -> rubbery drunk),
   the per-motion rates (a 1/beat sway is a completely different dance from a 1/4-beat one),
   and `bones` (drop to 0 for a point-light figure — just the joints, which still reads as a
   body from motion alone). */
Synesthesia.register({
  id: "stickman",
  label: "Stickman",

  params: [
    // ---- master: scales every amount / every rate ----
    { key: "groove",    label: "Groove",         type: "range", min: 0,    max: 2.5,  step: 0.05, default: 1 },
    { key: "tempo",     label: "Tempo mult",     type: "range", min: 0.25, max: 4,    step: 0.05, default: 1 },
    // ---- hips: the root, everything else rides on these ----
    { key: "bob",       label: "Hip bounce",     type: "range", min: 0,     max: 2,   step: 0.05,  default: 1 },
    { key: "bobRate",   label: "\u00b7 rate /beat", type: "range", min: 0.125, max: 4, step: 0.125, default: 1 },
    { key: "sway",      label: "Hip sway",       type: "range", min: 0,     max: 2,   step: 0.05,  default: 1 },
    { key: "swayRate",  label: "\u00b7 rate /beat", type: "range", min: 0.125, max: 4, step: 0.125, default: 0.25 },
    { key: "hipTwist",  label: "Hip twist",      type: "range", min: 0,     max: 2,   step: 0.05,  default: 1 },
    // ---- torso ----
    { key: "lean",      label: "Torso lean",     type: "range", min: 0,     max: 1.5, step: 0.05,  default: 0.6 },
    { key: "leanRate",  label: "\u00b7 rate /beat", type: "range", min: 0.125, max: 4, step: 0.125, default: 0.25 },
    // ---- shoulders: twist rides the sway rate; phase sets the counter-rotation ----
    { key: "shoulderTwist", label: "Shoulder twist",  type: "range", min: 0, max: 2, step: 0.05, default: 1 },
    { key: "counterPhase",  label: "\u00b7 counter-phase", type: "range", min: 0, max: 1, step: 0.02, default: 0.5 },
    // ---- head ----
    { key: "headNod",   label: "Head nod",       type: "range", min: 0,     max: 2,   step: 0.05,  default: 1 },
    { key: "nodRate",   label: "\u00b7 rate /beat", type: "range", min: 0.125, max: 4, step: 0.125, default: 1 },
    { key: "nodSnap",   label: "\u00b7 snap",      type: "range", min: 1,   max: 6,   step: 0.5,   default: 2.5 },
    { key: "headSway",  label: "\u00b7 sway limit\u00b0", type: "range", min: 0, max: 60, step: 1, default: 26 },
    // ---- passive parts: PROPERTIES, not motions (these limbs are never posed) ----
    { key: "looseness", label: "Looseness",      type: "range", min: 0.02, max: 1,    step: 0.02, default: 0.42 },
    { key: "impulse",   label: "Beat impulse",   type: "range", min: 0,    max: 3,    step: 0.05, default: 1 },
    { key: "gravity",   label: "Gravity",        type: "range", min: 0,    max: 3,    step: 0.05, default: 1 },
    { key: "armLift",   label: "Arm lift",       type: "range", min: 0,    max: 2,    step: 0.05, default: 0.55 },
    { key: "stance",    label: "Stance width",   type: "range", min: 0.2,  max: 2,    step: 0.05, default: 1 },
    { key: "stepReach", label: "Step reach",     type: "range", min: 0.7,  max: 1,    step: 0.01, default: 0.98 },
    // ---- style ----
    { key: "size",      label: "Size",           type: "range", min: 0.2,  max: 0.9,  step: 0.02, default: 0.52 },
    { key: "bones",     label: "Bones",          type: "range", min: 0,    max: 1,    step: 1,    default: 1 },
    { key: "boneWidth", label: "Bone width",     type: "range", min: 0.5,  max: 6,    step: 0.1,  default: 2.2 },
    { key: "jointGlow", label: "Joint glow",     type: "range", min: 0,    max: 40,   step: 0.5,  default: 13 },
    { key: "hue",       label: "Hue",            type: "range", min: 0,    max: 360,  step: 1,    default: 195 },
    { key: "hueSpread", label: "Hue spread",     type: "range", min: 0,    max: 180,  step: 5,    default: 55 },
    { key: "sat",       label: "Saturation",     type: "range", min: 0,    max: 1,    step: 0.02, default: 0.75 },
    { key: "showGround",label: "Ground line",    type: "range", min: 0,    max: 1,    step: 1,    default: 1 },
    { key: "trail",     label: "Trail",          type: "range", min: 0.05, max: 1,    step: 0.01, default: 0.42 },
    { key: "bloom",     label: "Bloom",          type: "range", min: 0,    max: 3,    step: 0.05, default: 0.7 },
    { key: "bloomThresh", label: "Bloom thresh", type: "range", min: 0,    max: 1,    step: 0.02, default: 0.35 },
  ],

  C: {
    bg: [4 / 255, 5 / 255, 9 / 255],
    // proportions as a fraction of total figure height
    L: { torso: 0.30, neck: 0.07, headR: 0.062, shoulder: 0.105, hipW: 0.055,
         upperArm: 0.155, foreArm: 0.150, thigh: 0.205, shin: 0.195 },
    groundFrac: 0.86,      // ground line as a fraction of canvas height
    // Hips ride at this fraction of full leg length above the floor, and this one number sets
    // TWO things that pull against each other:
    //   low  -> legs fold more -> the knee has to bow further sideways (bow-legged in front view)
    //   high -> legs near full extension -> no slack left, so any sway rips a foot loose
    // The gap between this and `stepReach` is the whole step budget. 0.92/0.98 keeps the knees
    // close in while still leaving a normal groove planted and letting a big one step.
    hipHeight: 0.985,
    headLift: 1750,        // constant upward pull on the head — sets its NEUTRAL posture.
                           // Deliberately not much above gravity: pin it harder and the head
                           // rides the neck rigidly instead of trailing behind the bang.
    headStiff: 0.35,       // neck->head tether stiffness relative to the other bones (soft = whip)
    stepLift: 7,           // upward kick (px @ dpr 1) when a foot releases
    minAirTime: 0.10,      // seconds a foot must be off the floor before it may re-plant
    iterations: 14,        // constraint relaxation passes per frame (14 points, so this is cheap;
                           // too few and a deep squat leaves the legs visibly stretched)
  },

  // point indices
  I: { HIP:0, CHEST:1, NECK:2, HEAD:3, SHL:4, ELL:5, HAL:6, SHR:7, ELR:8, HAR:9,
       KNL:10, FTL:11, KNR:12, FTR:13, HIPL:14, HIPR:15 },

  mount(host) {
    this.dpr = host.dpr;
    this.scene = Synesthesia.GL.createScene(host.canvas, host.dpr);
    if (!this.scene.gl) { console.error("Stickman: WebGL2 unavailable."); return; }
    this.W = host.canvas.width; this.H = host.canvas.height;
    this.beatPhase = 0;
    this.pts = [];
    for (let i = 0; i < 16; i++) this.pts.push({ x: 0, y: 0, px: 0, py: 0, driven: false });
    this.plant = [null, null];     // per foot: {x, y} while planted, else null
    this.air = [0, 0];             // seconds since this foot released
    this.lineBuf = new Float32Array(256 * 8);
    this._init = false;
  },
  resize(w, h) { this.W = w; this.H = h; this._init = false; if (this.scene) this.scene.resize(); },
  unmount() { if (this.scene) this.scene.dispose(); this.scene = null; },

  scale() { return Math.min(this.W, this.H) * this.p.size; },

  // drop the whole figure into a sane standing pose (also used on resize)
  reset() {
    const I = this.I, L = this.C.L, s = this.scale();
    const cx = this.W / 2, ground = this.H * this.C.groundFrac;
    const hipY = ground - (L.thigh + L.shin) * s * this.C.hipHeight;   // knees carry slack
    const set = (i, x, y) => { const q = this.pts[i]; q.x = q.px = x; q.y = q.py = y; };
    set(I.HIP, cx, hipY);
    set(I.CHEST, cx, hipY - L.torso * s * 0.55);
    set(I.NECK, cx, hipY - L.torso * s);
    set(I.HEAD, cx, hipY - (L.torso + L.neck) * s);
    set(I.SHL, cx - L.shoulder * s, hipY - L.torso * s);
    set(I.SHR, cx + L.shoulder * s, hipY - L.torso * s);
    set(I.ELL, cx - L.shoulder * s, hipY - L.torso * s + L.upperArm * s);
    set(I.ELR, cx + L.shoulder * s, hipY - L.torso * s + L.upperArm * s);
    set(I.HAL, cx - L.shoulder * s, hipY - L.torso * s + (L.upperArm + L.foreArm) * s);
    set(I.HAR, cx + L.shoulder * s, hipY - L.torso * s + (L.upperArm + L.foreArm) * s);
    const hw = L.hipW * s;
    set(I.HIPL, cx - hw, hipY);
    set(I.HIPR, cx + hw, hipY);
    // knees pushed slightly outward so the constraint solver has a direction to bend them in
    set(I.KNL, cx - hw * 1.05, hipY + L.thigh * s * 0.92);
    set(I.KNR, cx + hw * 1.05, hipY + L.thigh * s * 0.92);
    // feet start where a STEP would put them, so the rest pose and the step target agree
    const st = L.hipW * s * 1.5 * this.p.stance;
    set(I.FTL, cx - st, ground);
    set(I.FTR, cx + st, ground);
    this.plant = [{ x: cx - st, y: ground }, { x: cx + st, y: ground }];
    this.air = [0, 0];
    this._init = true;
  },

  // one distance constraint; driven points don't move, so the chain resolves against them
  link(ia, ib, len, stiff) {
    const a = this.pts[ia], b = this.pts[ib];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const diff = (d - len) / d * stiff;
    const wa = a.driven ? 0 : (b.driven ? 1 : 0.5);
    const wb = b.driven ? 0 : (a.driven ? 1 : 0.5);
    a.x += dx * diff * wa; a.y += dy * diff * wa;
    b.x -= dx * diff * wb; b.y -= dy * diff * wb;
  },

  frame(a) {
    const p = this.p, C = this.C, I = this.I, L = C.L, scene = this.scene;
    if (!scene) return;
    if (!this._init) this.reset();
    const dt = Math.min(a.dt / 1000, 0.033);
    const s = this.scale(), cx = this.W / 2, ground = this.H * C.groundFrac;
    const P = this.pts;

    // ---- tempo-locked groove clock ----
    const bpm = a.bpm || 120;
    this.beatPhase += dt * (bpm / 60) * p.tempo;
    const bp = this.beatPhase, TAU = Math.PI * 2;
    const g = p.groove;
    /* Every driven motion is AMOUNT x RATE, rate in cycles per beat, with the master `groove`
       and `tempo` scaling all amounts / all rates together. `wave` is a full sine cycle (side to
       side, twist); `hump` is one-sided, a dip per cycle — a bounce lands, it does not rise. */
    const wave = (rate, phase) => Math.sin(TAU * (bp * rate + (phase || 0)));
    const hump = (rate) => Math.abs(Math.sin(Math.PI * bp * rate));
    // Dip ON the beat, rise between: a bounce, not a sine. POSITIVE is downward here — lifting
    // the hips instead would stretch the legs past their own length and tear both feet off the
    // floor, which is exactly what a sign error here used to do. Clamped so a huge `bob` can
    // squat the figure without pushing the hips through the ground.
    const maxDip = (L.thigh + L.shin) * s * (C.hipHeight - 0.34);
    const bounce = Math.min(hump(p.bobRate) * 0.075 * p.bob * g * s, maxDip);
    const shift  = wave(p.swayRate) * 0.085 * p.sway * g * s;
    const tilt   = -wave(p.leanRate) * 0.18 * p.lean * g;

    // ---- drive the core: hips, spine, shoulders ----
    const legLen = (L.thigh + L.shin) * s;
    const hipX = cx + shift;
    let hipY = ground - legLen * C.hipHeight + bounce;
    /* ADAPTIVE CROUCH. Standing tall keeps the legs near full extension, which keeps the knees
       tucked in — a folded leg has to bow its knee sideways, and in a front view that reads as
       bow-legged. But standing tall also leaves no slack, so any sway rips a foot off the floor.
       Rather than pick one, crouch ONLY as far as reaching the planted feet actually demands:
       stand tall in the middle of a sway, dip at the extremes. Costs nothing when nothing is
       stretched, and it is what a person does anyway. */
    for (let f = 0; f < 2; f++) {
      const pl = this.plant[f]; if (!pl) continue;
      const hx = hipX + (f ? 1 : -1) * L.hipW * s;
      // 0.96 safety margin: this estimate ignores the hip twist's foreshortening, and against a
      // tight stepReach that error alone is enough to release a foot that did not need to move.
      const dx = pl.x - hx, reach = legLen * p.stepReach * 0.96;
      if (Math.abs(dx) >= reach) continue;                    // unreachable anyway; let it step
      const maxAbove = Math.sqrt(reach * reach - dx * dx);    // highest the hips can be and still reach
      hipY = Math.max(hipY, ground - maxAbove);               // (y grows downward, so max = lower)
    }
    const drive = (i, x, y) => { const q = P[i]; q.px = q.x; q.py = q.y; q.x = x; q.y = y; q.driven = true; };
    drive(I.HIP, hipX, hipY);
    const ct = Math.cos(tilt - Math.PI / 2), st = Math.sin(tilt - Math.PI / 2);
    const chestX = hipX + ct * L.torso * s * 0.55, chestY = hipY + st * L.torso * s * 0.55;
    let neckX = hipX + ct * L.torso * s, neckY = hipY + st * L.torso * s;
    /* HEAD NOD. Peaks exactly ON the beat and recovers between; `nodSnap` is the exponent, so
       higher = a sharper snap with a longer hang rather than a smooth sine nod. Applied to the
       NECK, not the head: the whole upper body pitches, the shoulders come with it, and the head
       — which is a free point on a 22px tether — gets dragged down late and overshoots on the way
       back. That lag is the whip, and it is why this is driven here instead of posed directly. */
    const bang = Math.pow((1 + Math.cos(TAU * bp * p.nodRate)) * 0.5, p.nodSnap) * p.headNod * g;
    /* Vertical ONLY — a sideways component turns a nod into a lurch. CLAMPED to a fraction of the
       chest->neck segment: unclamped, a big nod drops the neck further than the chest and the
       spine INVERTS, so "up along the spine" points down and the head obediently follows it
       below the shoulders. The cone cannot save you from a spine that is upside down. */
    const bangDrop = Math.min(bang * 0.105 * s, L.torso * s * 0.64);
    neckY += bangDrop;
    // Chest follows at 0.55 rather than sitting still. The DIFFERENCE is the nod (head drops
    // further than the shoulders); the shared part just carries the upper body down with it.
    // A smaller factor makes a sharper nod but closes the chest->neck gap faster, and once that
    // gap hits zero the spine flips. 0.55 closes it at less than half the drop, which leaves
    // room for a nod roughly 3x the size the safe-but-invisible 0.30 clamp allowed.
    drive(I.CHEST, chestX, chestY + bangDrop * 0.55);
    drive(I.NECK, neckX, neckY);
    // shoulders counter-rotate against the hips — the thing that makes it read as groove
    // shoulders ride the sway rate, offset by `counterPhase` (0.5 = exactly opposing the hips)
    const twist = wave(p.swayRate, p.counterPhase) * 0.5 * p.shoulderTwist * g;
    const sdx = Math.cos(tilt + twist) * L.shoulder * s, sdy = Math.sin(tilt + twist) * L.shoulder * s * 0.35;
    drive(I.SHL, neckX - sdx, neckY - sdy);
    drive(I.SHR, neckX + sdx, neckY + sdy);
    // Pelvis counter-rotates AGAINST the shoulders — opposite sign, smaller amplitude. This is
    // the single thing that most makes the motion read as dancing rather than swaying.
    const hipTwist = wave(p.swayRate) * 0.34 * p.hipTwist * g;
    const hdx = Math.cos(tilt + hipTwist) * L.hipW * s;
    const hdy = Math.sin(tilt + hipTwist) * L.hipW * s * 0.35;
    drive(I.HIPL, hipX - hdx, hipY - hdy);
    drive(I.HIPR, hipX + hdx, hipY + hdy);
    [I.HEAD, I.ELL, I.HAL, I.ELR, I.HAR, I.KNL, I.FTL, I.KNR, I.FTR].forEach(i => P[i].driven = false);

    // ---- integrate the free points (Verlet) ----
    const damp = 1 - (1 - p.looseness) * 0.14;          // looser = keeps more of its velocity
    const gy = p.gravity * 2200 * this.dpr * dt * dt;
    const lift = -p.armLift * 900 * this.dpr * dt * dt;  // arms want to float, so they don't just dangle
    for (let i = 0; i < P.length; i++) {
      const q = P[i]; if (q.driven) continue;
      const vx = (q.x - q.px) * damp, vy = (q.y - q.py) * damp;
      q.px = q.x; q.py = q.y;
      let ay = gy;
      if (i === I.ELL || i === I.HAL || i === I.ELR || i === I.HAR) ay += lift;
      // Constant, so the head has a stable upright neutral. The BANG is applied to the neck
      // below, not here — the head is dragged along by it and lags, which is the whip.
      if (i === I.HEAD) ay += -C.headLift * this.dpr * dt * dt;
      q.x += vx; q.y += vy + ay;
    }

    // ---- beat impulse: kick the extremities, let the chain carry it ----
    if (a.beat && p.impulse > 0) {
      const k = p.impulse * 6 * this.dpr;
      const kick = (i, dx, dy) => { P[i].px -= dx * k; P[i].py -= dy * k; };
      kick(I.HAL, -0.7 - Math.random() * 0.5, -1.1 - Math.random() * 0.6);
      kick(I.HAR,  0.7 + Math.random() * 0.5, -1.1 - Math.random() * 0.6);
      kick(I.HEAD, (Math.random() - 0.5) * 0.6, -0.55);
      kick(I.ELL, -0.35, -0.4); kick(I.ELR, 0.35, -0.4);
    }

    // ---- feet: plant, stretch, release, swing, re-plant ----
    const stanceX = L.hipW * s * 1.5 * p.stance;
    for (let f = 0; f < 2; f++) {
      const fi = f ? I.FTR : I.FTL, side = f ? 1 : -1;
      const hipPt = P[f ? I.HIPR : I.HIPL];      // each leg answers to its own hip now
      const foot = P[fi], pl = this.plant[f];
      if (pl) {
        // pinned — until the hips walk away far enough to pull it off the floor
        foot.x = pl.x; foot.y = pl.y; foot.px = pl.x; foot.py = pl.y;
        if (Math.hypot(foot.x - hipPt.x, foot.y - hipPt.y) > legLen * p.stepReach) {
          this.plant[f] = null;
          this.air[f] = 0;
          foot.py = foot.y + C.stepLift * this.dpr;   // kick it upward so it ARCS to the new spot
        }
      } else {
        // swinging: pulled toward where this leg wants to stand, slightly ahead of the hips
        this.air[f] += dt;
        // Step toward the body's HOME x, not the hips' current x. The hips sway a full 2x
        // amplitude; a foot planted where the hips happened to be is over-stretched the moment
        // they swing back, which is what makes it thrash. Feet stay under the centre and the
        // hips travel over them — which is what a dancer actually does.
        const tx = cx + side * stanceX + (hipPt.x - hipPt.px) * 3;
        foot.x += (tx - foot.x) * 0.14;
        // must have actually been airborne — otherwise it re-plants on the frame it released
        if (this.air[f] > C.minAirTime && foot.y >= ground) {
          foot.y = ground; foot.py = ground;
          this.plant[f] = { x: foot.x, y: ground };
        }
      }
    }

    // ---- constraints ----
    const stiff = 1 - p.looseness * 0.55;
    for (let it = 0; it < C.iterations; it++) {
      this.link(I.HIP, I.CHEST, L.torso * s * 0.55, 1);
      this.link(I.CHEST, I.NECK, L.torso * s * 0.45, 1);
      this.link(I.NECK, I.HEAD, L.neck * s, stiff * C.headStiff);
      this.link(I.NECK, I.SHL, L.shoulder * s, 1);
      this.link(I.NECK, I.SHR, L.shoulder * s, 1);
      this.link(I.SHL, I.ELL, L.upperArm * s, stiff);
      this.link(I.ELL, I.HAL, L.foreArm * s, stiff);
      this.link(I.SHR, I.ELR, L.upperArm * s, stiff);
      this.link(I.ELR, I.HAR, L.foreArm * s, stiff);
      this.link(I.HIP, I.HIPL, L.hipW * s, 1);
      this.link(I.HIP, I.HIPR, L.hipW * s, 1);
      this.link(I.HIPL, I.KNL, L.thigh * s, 1);
      this.link(I.KNL, I.FTL, L.shin * s, 1);
      this.link(I.HIPR, I.KNR, L.thigh * s, 1);
      this.link(I.KNR, I.FTR, L.shin * s, 1);
      for (const ki of [I.KNL, I.KNR]) if (P[ki].y > ground) P[ki].y = ground;
      for (const fi of [I.FTL, I.FTR]) if (P[fi].y > ground) { P[fi].y = ground; P[fi].py = ground; }
    }

    /* KNEES BEND OUTWARD — enforced geometrically, not by pushing.
       A folded leg has two mirror-image solutions and the solver will happily pick either, so
       the knee crosses to the wrong side and the legs read as broken. A per-frame nudge cannot
       fix this: too weak and the knee still crosses, strong enough and it compounds into a real
       force that bows the legs out. Instead: if the knee is on the wrong side of the hip->foot
       line, REFLECT it across that line. Reflection preserves its distance to both the hip and
       the foot, so it costs the constraint solver nothing. */
    const fixKnee = (hi, ki, fi, want) => {
      const h = P[hi], k = P[ki], ft = P[fi];
      const dx = ft.x - h.x, dy = ft.y - h.y, len = Math.hypot(dx, dy) || 1e-6;
      const nx = -dy / len, ny = dx / len;                     // perpendicular to the leg
      const d = (k.x - h.x) * nx + (k.y - h.y) * ny;           // signed offset from that line
      if (d * want < 0) { k.x -= 2 * d * nx; k.y -= 2 * d * ny; }
    };
    fixKnee(I.HIPL, I.KNL, I.FTL,  1);
    fixKnee(I.HIPR, I.KNR, I.FTR, -1);

    /* HEAD CONTAINMENT. The head is a free point on a soft tether, which makes it a pendulum —
       left alone it swings to any angle, including down beside or under the shoulders, which
       looks ridiculous. Two clamps, applied after the solver:
         LENGTH  generous stretch allowed (that stretch IS the whip), but never separation and
                 never collapse into the neck.
         CONE    the head must sit within `headSway` degrees of the SPINE direction — not world
                 vertical, so it stays over the shoulders even when the torso leans. This is what
                 keeps a side-to-side wobble reading as a wobble instead of a dislocation.
       Clamping position in Verlet also kills the velocity pushing into the limit, so the head
       settles against the cone instead of juddering along it. */
    {
      const nk = P[I.NECK], hd = P[I.HEAD], ch = P[I.CHEST], rest = L.neck * s;
      let dx = hd.x - nk.x, dy = hd.y - nk.y;
      let d = Math.hypot(dx, dy) || 1e-6;
      const maxD = rest * 1.25, minD = rest * 0.55;
      if (d > maxD)      { const k = maxD / d; dx *= k; dy *= k; d = maxD; }
      else if (d < minD) { const k = minD / d; dx *= k; dy *= k; d = minD; }
      let ux = nk.x - ch.x, uy = nk.y - ch.y;                 // spine direction = "up"
      const ul = Math.hypot(ux, uy) || 1e-6; ux /= ul; uy /= ul;
      const along = dx * ux + dy * uy, perp = dx * -uy + dy * ux;
      const ang = Math.atan2(perp, along), lim = p.headSway * Math.PI / 180;
      if (ang > lim || ang < -lim || along < 0) {
        const a2 = Math.max(-lim, Math.min(lim, ang));
        const ca = Math.cos(a2) * d, sa = Math.sin(a2) * d;
        dx = ca * ux + sa * -uy;
        dy = ca * uy + sa * ux;
      }
      hd.x = nk.x + dx; hd.y = nk.y + dy;
    }

    // ---- draw ----
    const hsv = Synesthesia.Color.hsv;
    let n = 0;
    /* COORDINATE FLIP. The simulation above runs in canvas convention — y grows DOWNWARD,
       gravity is +y, the floor is a large y. The GL scene is the opposite: its vertex shader
       does pos/uRes*2-1, so y=0 is the BOTTOM of the screen. Rendering sim coords straight
       into it draws the figure upside down. Everything below therefore goes through fy(). */
    const fy = y => this.H - y;
    const push = (x0, y0, x1, y1, hw, r, gg, b) => {
      if ((n + 1) * 8 > this.lineBuf.length) {
        const nb = new Float32Array(this.lineBuf.length * 2); nb.set(this.lineBuf); this.lineBuf = nb;
      }
      const o = n * 8;
      this.lineBuf[o] = x0; this.lineBuf[o+1] = fy(y0); this.lineBuf[o+2] = x1; this.lineBuf[o+3] = fy(y1);
      this.lineBuf[o+4] = hw; this.lineBuf[o+5] = r; this.lineBuf[o+6] = gg; this.lineBuf[o+7] = b;
      n++;
    };

    const BONES = [
      [I.HIP, I.CHEST, 0], [I.CHEST, I.NECK, 0], [I.NECK, I.HEAD, 0.1],
      [I.NECK, I.SHL, 0.2], [I.SHL, I.ELL, 0.3], [I.ELL, I.HAL, 0.45],
      [I.NECK, I.SHR, 0.2], [I.SHR, I.ELR, 0.3], [I.ELR, I.HAR, 0.45],
      [I.HIPL, I.HIPR, 0.6],
      [I.HIPL, I.KNL, 0.65], [I.KNL, I.FTL, 0.85],
      [I.HIPR, I.KNR, 0.65], [I.KNR, I.FTR, 0.85],
    ];
    if (p.bones > 0.5) {
      const bw = p.boneWidth * this.dpr;
      for (const [ia, ib, t] of BONES) {
        const c = hsv(p.hue + p.hueSpread * t, p.sat, 1);
        push(P[ia].x, P[ia].y, P[ib].x, P[ib].y, bw, c[0], c[1], c[2]);
      }
      // head as a small ring of segments
      const hr = L.headR * s, hc = hsv(p.hue + p.hueSpread * 0.1, p.sat, 1);
      const hx = P[I.HEAD].x, hy = P[I.HEAD].y - hr * 0.5;
      for (let k = 0; k < 12; k++) {
        const a0 = TAU * k / 12, a1 = TAU * (k + 1) / 12;
        push(hx + Math.cos(a0) * hr, hy + Math.sin(a0) * hr,
             hx + Math.cos(a1) * hr, hy + Math.sin(a1) * hr, bw * 0.8, hc[0], hc[1], hc[2]);
      }
    }
    if (p.showGround > 0.5) {
      const gc = hsv(p.hue + 180, p.sat * 0.5, 1);
      push(0, ground, this.W, ground, 1 * this.dpr, gc[0] * 0.18, gc[1] * 0.18, gc[2] * 0.18);
    }

    // joints — in point-light mode (bones 0) these alone still read as a body
    const verts = [];
    if (p.jointGlow > 0) {
      const big = { [I.HEAD]: 1.5, [I.HAL]: 1.2, [I.HAR]: 1.2, [I.FTL]: 1.1, [I.FTR]: 1.1 };
      for (let i = 0; i < P.length; i++) {
        const t = i / P.length;
        const c = hsv(p.hue + p.hueSpread * t, p.sat, 1);
        verts.push({ x: P[i].x, y: fy(P[i].y), size: p.jointGlow * this.dpr * (big[i] || 1),
                     r: c[0], g: c[1], b: c[2], life: 0.9 });
      }
    }

    scene.fade(Math.max(0, Math.min(p.trail, 1)));
    if (n) scene.lines(this.lineBuf, n, { target: "acc", blend: "add" });
    if (verts.length) scene.glow(verts, { soft: 2.4, target: "acc", blend: "add" });
    scene.composite(C.bg, 1.1);
    if (p.bloom > 0) scene.bloom(p.bloom, p.bloomThresh, 1);

    this.stat = "planted " + (this.plant[0] ? "L" : "-") + (this.plant[1] ? "R" : "-");
  },
});
