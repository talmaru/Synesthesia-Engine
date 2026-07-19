"use strict";
/* Diagnostics — shows the raw analysis frame the visuals "see".
   Pure canvas. Applies NO gain or smoothing of its own: every number is `a`
   exactly as the engine hands it over. Layout:
     header   — BPM (big), a decaying BEAT flash, energy / dt / fps, hue swatch
     spectrum — 128 bins: smoothed bars + raw ghost line + peak-hold line
     bands    — bass / mid / treble / energy meters with values + peak marks
     history  — bass / mid / treble / energy scrolled over ~6s, with beat ticks */
Synesthesia.register({
  id: "diagnostics",
  label: "Diagnostics",

  params: [
    { key: "peakFall", label: "Peak fall", type: "range", min: 0.001, max: 0.04, step: 0.001, default: 0.006 },
  ],

  C: {
    bg: "#0a0c12", panel: "#0e121c", line: "#1d2333",
    ink: "#dfe7f5", dim: "#8893ab",
    bass: "#ff6b4a", mid: "#4adf8a", treble: "#4a9cff", energy: "#e8edf8",
    beat: "#ff466e", accent: "#4a6cff",
    histN: 360,
    headPad: 64,   // left inset so the ☰ playlist button doesn't cover BPM
  },

  mount(host) {
    this.cv = host.canvas;
    this.ctx = host.canvas.getContext("2d", { alpha: false });
    this.dpr = host.dpr;
    this.specPeak = new Float32Array(128);
    this.bandPeak = new Float32Array(4);
    const N = this.C.histN;
    this.hBass = new Float32Array(N);
    this.hMid = new Float32Array(N);
    this.hTreble = new Float32Array(N);
    this.hEnergy = new Float32Array(N);
    this.hBeat = new Float32Array(N);
    this.hIdx = 0;
    this.beatFlash = 0;
  },

  resize() {},
  unmount() {},

  frame(a) {
    const C = this.C, ctx = this.ctx, dpr = this.dpr;
    const W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);     // draw in logical px (crisp text)
    const w = W / dpr, h = H / dpr;

    // ---- state updates (no smoothing applied to displayed values) ----
    if (a.beat) this.beatFlash = 1; else this.beatFlash *= 0.9;
    const fall = this.p.peakFall;
    for (let i = 0; i < 128; i++) this.specPeak[i] = Math.max(a.bins[i], this.specPeak[i] - fall);
    const bandVals = [a.bass, a.mid, a.treble, a.energy];
    for (let i = 0; i < 4; i++) this.bandPeak[i] = Math.max(bandVals[i], this.bandPeak[i] - fall);
    this.hBass[this.hIdx] = a.bass; this.hMid[this.hIdx] = a.mid;
    this.hTreble[this.hIdx] = a.treble; this.hEnergy[this.hIdx] = a.energy;
    this.hBeat[this.hIdx] = a.beat ? 1 : 0;
    this.hIdx = (this.hIdx + 1) % C.histN;

    const m = 14, font = (s, wt) => ctx.font = `${wt || 400} ${s}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const label = (t, x, y) => { font(10); ctx.fillStyle = C.dim; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.fillText(t.toUpperCase(), x, y); };

    // ============ HEADER ============
    const hH = 58;
    let hy = m;
    ctx.fillStyle = C.panel; this.rr(ctx, m, hy, w - m * 2, hH, 8); ctx.fill();
    const hcy = hy + hH / 2;

    // content starts past the ☰ button (top-left of the app)
    let x = m + C.headPad;
    label("bpm", x, hy + 16);
    font(30, 700); ctx.fillStyle = C.ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(String(Math.round(a.bpm || 0)), x, hcy + 8);

    // BEAT flash light
    const bx = x + 96, br = 13;
    const f = this.beatFlash;
    ctx.beginPath(); ctx.arc(bx, hcy + 4, br, 0, Math.PI * 2);
    ctx.fillStyle = this.mix(C.line, C.beat, f); ctx.fill();
    if (f > 0.01) { ctx.shadowColor = C.beat; ctx.shadowBlur = 18 * f; ctx.fill(); ctx.shadowBlur = 0; }
    label("beat", bx - 14, hy + 16);

    const stat = (lab, val, sx) => {
      label(lab, sx, hy + 16);
      font(16, 600); ctx.fillStyle = C.ink; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillText(val, sx, hcy + 6);
    };
    const fps = a.dt > 0 ? Math.round(1000 / a.dt) : 0;
    stat("energy", a.energy.toFixed(3), bx + 40);
    stat("dt ms", (a.dt || 0).toFixed(1), bx + 140);
    stat("fps", String(fps), bx + 220);
    const hux = bx + 290;
    const phDeg = (Synesthesia.GL && Synesthesia.GL.tempoPhase ? Synesthesia.GL.tempoPhase(this, a, { beats: 16 }) : 0) * 360;
    label("phase", hux, hy + 16);   // bpm-derived, not from the frame
    ctx.fillStyle = `hsl(${phDeg},85%,58%)`; this.rr(ctx, hux, hcy - 6, 26, 16, 4); ctx.fill();
    font(13); ctx.fillStyle = C.dim; ctx.textBaseline = "middle";
    ctx.fillText(Math.round(phDeg) + "\u00b0", hux + 34, hcy + 2);

    // ============ regions ============
    const top = hy + hH + 14;
    const R = h - top - m;
    const specH = R * 0.44, bandsH = R * 0.28, histH = R * 0.28 - 14;
    const gx = m, gw = w - m * 2, pad = 12;

    // ============ SPECTRUM ============
    let sy = top, sh = specH;
    ctx.fillStyle = C.panel; this.rr(ctx, gx, sy, gw, sh, 8); ctx.fill();
    const ix = gx + pad, iw = gw - pad * 2, iy = sy + 22, ih = sh - pad - 22;
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; font(9); ctx.fillStyle = C.dim;
    ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (const g of [0.25, 0.5, 0.75, 1]) {
      const yg = iy + ih - g * ih;
      ctx.beginPath(); ctx.moveTo(ix, yg); ctx.lineTo(ix + iw, yg); ctx.stroke();
      ctx.fillText(g.toFixed(2), ix - 4, yg);
    }
    label("spectrum  \u2014  bars = bins (smoothed)   line = raw   tick = peak", gx + pad, sy + 14);
    const bw = iw / 128;
    for (let i = 0; i < 128; i++) {
      const v = Math.min(a.bins[i], 1), bh = v * ih;
      ctx.fillStyle = `hsl(${200 + (i / 128) * 130},80%,58%)`;
      ctx.fillRect(ix + i * bw, iy + ih - bh, Math.max(bw - 0.5, 0.5), bh);
    }
    ctx.strokeStyle = "rgba(232,237,248,0.45)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 128; i++) {
      const v = Math.min(a.raw ? a.raw[i] : a.bins[i], 1);
      const px = ix + i * bw + bw / 2, py = iy + ih - v * ih;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 128; i++) {
      const px = ix + i * bw + bw / 2, py = iy + ih - Math.min(this.specPeak[i], 1) * ih;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();

    // ============ BANDS ============
    let by = sy + sh + 14;
    ctx.fillStyle = C.panel; this.rr(ctx, gx, by, gw, bandsH, 8); ctx.fill();
    label("bands", gx + pad, by + 14);
    const names = ["bass", "mid", "treble", "energy"];
    const cols = [C.bass, C.mid, C.treble, C.energy];
    const rowTop = by + 24, rowH = (bandsH - 30) / 4;
    const trackX = gx + pad + 64, trackW = gw - pad * 2 - 64 - 56;
    for (let i = 0; i < 4; i++) {
      const cy = rowTop + i * rowH + rowH / 2;
      font(12, 600); ctx.fillStyle = C.dim; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(names[i], gx + pad, cy);
      const v = Math.min(bandVals[i], 1);
      ctx.fillStyle = C.line; this.rr(ctx, trackX, cy - 5, trackW, 10, 5); ctx.fill();
      ctx.fillStyle = cols[i]; this.rr(ctx, trackX, cy - 5, Math.max(trackW * v, 2), 10, 5); ctx.fill();
      const px = trackX + trackW * Math.min(this.bandPeak[i], 1);
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, cy - 7); ctx.lineTo(px, cy + 7); ctx.stroke();
      font(13, 600); ctx.fillStyle = C.ink; ctx.textAlign = "right";
      ctx.fillText(bandVals[i].toFixed(3), gx + gw - pad, cy);
    }

    // ============ HISTORY ============
    let yy = by + bandsH + 14;
    ctx.fillStyle = C.panel; this.rr(ctx, gx, yy, gw, histH, 8); ctx.fill();
    // title + non-overlapping colour legend
    label("history ~6s", gx + pad, yy + 14);
    font(10, 600); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    let lx = gx + pad + 92;
    for (const [name, col] of [["bass", C.bass], ["mid", C.mid], ["treble", C.treble], ["energy", C.energy]]) {
      ctx.fillStyle = col; ctx.fillRect(lx, yy + 7, 9, 9);
      ctx.fillStyle = C.dim; ctx.fillText(name, lx + 13, yy + 15);
      lx += 13 + ctx.measureText(name).width + 16;
    }
    const hix = gx + pad, hiw = gw - pad * 2, hiy = yy + 22, hih = histH - pad - 22;
    const N = C.histN;
    ctx.strokeStyle = "rgba(255,70,110,0.30)"; ctx.lineWidth = 1;
    for (let k = 0; k < N; k++) {
      const idx = (this.hIdx + k) % N;
      if (this.hBeat[idx]) {
        const px = hix + (k / (N - 1)) * hiw;
        ctx.beginPath(); ctx.moveTo(px, hiy); ctx.lineTo(px, hiy + hih); ctx.stroke();
      }
    }
    const series = (arr, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.5; ctx.beginPath();
      for (let k = 0; k < N; k++) {
        const idx = (this.hIdx + k) % N;
        const px = hix + (k / (N - 1)) * hiw, py = hiy + hih - Math.min(arr[idx], 1) * hih;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    };
    series(this.hTreble, C.treble, 1);
    series(this.hMid, C.mid, 1);
    series(this.hEnergy, C.energy, 1);
    series(this.hBass, C.bass, 1.5);
  },

  rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * t);
    const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
    const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
    return `rgb(${r},${g},${bl})`;
  }
});
