import { Vec2 } from '../core/vec2.js';
import { TAU, clamp } from '../core/mathx.js';

/**
 * DebugOverlay — draws the mathematics on top of the creature.
 *
 * This is a deliverable, not a development aid. One of the stated success
 * criteria is that each system can be *explained visually*, so the overlay is
 * built to be filmed: every panel isolates one mechanism, each can be toggled
 * independently, and each reads the same numbers the simulation ran on rather
 * than recomputing anything of its own.
 *
 *   1  SPINE      the constrained chain, its nodes, tangents and rest curvature
 *   2  FORCES     per-limb thrust vectors, the steering yaw couple, velocity
 *   3  STEERING   wander / light / edge influence vectors and the desired heading
 *   4  WAVE       the metachronal phase wheel and the summed thrust trace
 *   5  STATE      arousal, beat frequency, speed, solver health
 */
export class DebugOverlay {
  constructor() {
    this.panels = { spine: true, forces: true, steering: true, wave: true, state: true };
    this.hist = { thrust: [], speed: [], arousal: [] };
    this.histLen = 260;
    this._v = new Vec2();
  }

  record(m) {
    const push = (arr, v) => { arr.push(v); if (arr.length > this.histLen) arr.shift(); };
    push(this.hist.thrust, m.drive.totalThrust);
    push(this.hist.speed, m.speed);
    push(this.hist.arousal, m.arousal.value);
  }

  draw(p, m, env) {
    p.blendMode(p.BLEND);
    p.push();
    if (this.panels.spine) this._spine(p, m);
    if (this.panels.forces) this._forces(p, m);
    if (this.panels.steering) this._steering(p, m, env);
    p.pop();

    // Screen-space panels are drawn by the caller after the world transform is
    // popped; see drawPanels().
  }

  /** World-space: the chain itself. */
  _spine(p, m) {
    const ch = m.chain;
    p.noFill();
    p.stroke(70, 200, 255, 150);
    p.strokeWeight(1);
    p.beginShape();
    for (const q of ch.pos) p.vertex(q.x, q.y);
    p.endShape();

    for (let i = 0; i < ch.count; i++) {
      const q = ch.pos[i];
      const r = 2 + 4 * (ch.mass[i] / m.cfg.body.massHead);
      p.noStroke();
      p.fill(70, 200, 255, 190);
      p.circle(q.x, q.y, r);

      // Rest curvature written by the steering system: the "muscle command".
      const rc = ch.restCurve[i];
      if (Math.abs(rc) > 1e-4) {
        const n = ch.normal(i, this._v);
        const s = rc * 900;
        p.stroke(255, 120, 190, 200);
        p.strokeWeight(1.4);
        p.line(q.x, q.y, q.x + n.x * s, q.y + n.y * s);
      }
    }

    // Local frames at a few nodes, so the anisotropic-drag axes are legible.
    for (let i = 0; i < ch.count; i += 5) {
      const t = ch.tangent(i, this._v).clone();
      const q = ch.pos[i];
      p.stroke(120, 255, 190, 110);
      p.strokeWeight(1);
      p.line(q.x, q.y, q.x + t.x * 16, q.y + t.y * 16);
      p.stroke(255, 210, 120, 80);
      p.line(q.x - t.y * 11, q.y + t.x * 11, q.x + t.y * 11, q.y - t.x * 11);
    }
  }

  /** World-space: where force enters the body. */
  _forces(p, m) {
    const ch = m.chain;
    const d = m.drive;

    // Thrust spans two orders of magnitude between a glide and an escape burst,
    // so the arrows are normalised against a slowly-decaying running peak. That
    // keeps them readable in every gait while still showing the *relative*
    // magnitudes within a frame, which is the thing worth seeing.
    let peak = 0;
    for (let i = 0; i < d.n; i++) peak = Math.max(peak, Math.abs(d.thrust[i]));
    this._peak = Math.max(peak, (this._peak ?? peak) * 0.985);
    const scale = 62 / (this._peak + 1e-6);

    // Per-limb thrust, drawn at its own attachment node.
    for (let i = 0; i < d.n; i++) {
      const node = d.nodeOf[i];
      const q = ch.pos[node];
      const t = ch.tangent(node, this._v).clone();
      const f = d.thrust[i] * scale;
      const col = f >= 0 ? [120, 255, 150] : [255, 110, 110];
      p.stroke(col[0], col[1], col[2], 220);
      p.strokeWeight(2);
      p.line(q.x, q.y, q.x - t.x * f, q.y - t.y * f);
    }

    // Whole-body velocity.
    const v = ch.centerVelocity(this._v);
    const c = ch.centroid(new Vec2());
    p.stroke(255, 255, 255, 200);
    p.strokeWeight(2);
    p.line(c.x, c.y, c.x + v.x * 0.35, c.y + v.y * 0.35);

    // The steering couple: equal and opposite, hence pure torque.
    const err = m.steering.headingError;
    if (Math.abs(err) > 1e-3) {
      const drive = clamp(err / m.cfg.steering.maxTurnRate, -1, 1);
      const couple = -drive * m.cfg.steering.yawThrustFraction * Math.abs(d.totalThrust) * scale;
      const n0 = ch.normal(0, new Vec2());
      const rearA = Math.min(ch.count - 1, Math.round(ch.count * 0.45));
      const nr = ch.normal(rearA, new Vec2());
      p.stroke(255, 150, 60, 230);
      p.strokeWeight(2.5);
      p.line(ch.pos[0].x, ch.pos[0].y, ch.pos[0].x + n0.x * couple, ch.pos[0].y + n0.y * couple);
      p.line(ch.pos[rearA].x, ch.pos[rearA].y,
             ch.pos[rearA].x - nr.x * couple, ch.pos[rearA].y - nr.y * couple);
    }
  }

  /** World-space: the influence vectors that produced the desired heading. */
  _steering(p, m, env) {
    const s = m.steering;
    const h = m.chain.pos[0];
    const R = 110;

    p.noFill();
    p.stroke(255, 255, 255, 40);
    p.circle(h.x, h.y, R * 2);

    const arrow = (dir, w, col, label) => {
      if (w <= 1e-3) return;
      const L = R * clamp(w, 0, 1.4);
      p.stroke(col[0], col[1], col[2], 220);
      p.strokeWeight(2);
      p.line(h.x, h.y, h.x + dir.x * L, h.y + dir.y * L);
      p.noStroke();
      p.fill(col[0], col[1], col[2], 230);
      p.circle(h.x + dir.x * L, h.y + dir.y * L, 5);
      if (label) {
        p.textSize(10);
        p.text(label, h.x + dir.x * (L + 8), h.y + dir.y * (L + 8));
      }
    };

    arrow(s.dirWander, 1, [120, 200, 255], 'wander');
    arrow(s.dirLight, s.lightWeight, [255, 235, 130], 'light');
    arrow(s.dirEdge, s.edgeWeight * 0.5, [255, 120, 120], 'edge');

    // Desired vs actual heading — the gap is what the body has to work off.
    p.stroke(255, 255, 255, 240);
    p.strokeWeight(3);
    p.line(h.x, h.y, h.x + s.dirDesired.x * R * 1.25, h.y + s.dirDesired.y * R * 1.25);
    const hd = m.heading();
    p.stroke(90, 255, 200, 240);
    p.strokeWeight(2);
    p.line(h.x, h.y, h.x + Math.cos(hd) * R * 1.25, h.y + Math.sin(hd) * R * 1.25);

    if (env.light && env.light.active) {
      p.noFill();
      p.stroke(255, 240, 150, 90);
      p.strokeWeight(1);
      p.circle(env.light.pos.x, env.light.pos.y, m.cfg.steering.phototaxisComfort * 2);
    }
  }

  // -------------------------------------------------------------------
  // Screen-space panels
  // -------------------------------------------------------------------

  drawPanels(p, m) {
    p.blendMode(p.BLEND);
    p.push();
    p.textFont('monospace');
    if (this.panels.wave) this._wavePanel(p, m, 18, p.height - 190);
    if (this.panels.state) this._statePanel(p, m, p.width - 246, 18);
    p.pop();
  }

  /** The metachronal phase wheel + the thrust each limb is producing right now. */
  _wavePanel(p, m, x, y) {
    const d = m.drive;
    const w = 300, h = 172;
    panelBg(p, x, y, w, h, 'METACHRONAL WAVE');

    const cx = x + 62, cy = y + 96, R = 42;
    p.noFill();
    p.stroke(255, 255, 255, 55);
    p.circle(cx, cy, R * 2);

    // Each limb as a dot on the phase circle. Evenly spread dots = evenly spread
    // power strokes = the near-constant thrust the whole design is for.
    for (let i = 0; i < d.n; i++) {
      const a = d.phaseOf(i) * TAU - Math.PI / 2;
      const px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R;
      const power = d.angVel[i] > 0;
      p.noStroke();
      p.fill(power ? 130 : 110, power ? 255 : 150, power ? 170 : 210, power ? 240 : 190);
      p.circle(px, py, power ? 9 : 6);
    }
    p.noStroke();
    p.fill(255, 255, 255, 130);
    p.textSize(9);
    p.textAlign(p.CENTER);
    p.text('power', cx, cy - 2);
    p.text('stroke', cx, cy + 9);
    p.textAlign(p.LEFT);

    // Summed thrust over time. Ripples at n*f, not f — that is the point.
    const gx = x + 122, gy = y + 40, gw = 162, gh = 118;
    p.stroke(255, 255, 255, 40);
    p.noFill();
    p.rect(gx, gy, gw, gh);
    const hist = this.hist.thrust;
    let hi = 1e-6;
    for (const v of hist) hi = Math.max(hi, Math.abs(v));
    p.stroke(140, 255, 190, 220);
    p.strokeWeight(1.2);
    p.beginShape();
    for (let i = 0; i < hist.length; i++) {
      const px = gx + (i / (this.histLen - 1)) * gw;
      const py = gy + gh - (hist[i] / hi) * gh * 0.92;
      p.vertex(px, py);
    }
    p.endShape();
    p.noStroke();
    p.fill(255, 255, 255, 120);
    p.textSize(9);
    p.text('sum of 11 limb thrusts', gx + 4, gy + 12);
  }

  _statePanel(p, m, x, y) {
    const r = m.readout();
    const w = 228, h = 196;
    panelBg(p, x, y, w, h, 'STATE');

    const bar = (label, v, max, col, row) => {
      const by = y + 34 + row * 26;
      p.noStroke();
      p.fill(255, 255, 255, 150);
      p.textSize(10);
      p.text(label, x + 10, by + 8);
      p.fill(255, 255, 255, 26);
      p.rect(x + 84, by, 132, 9, 2);
      p.fill(col[0], col[1], col[2], 220);
      p.rect(x + 84, by, 132 * clamp(v / max, 0, 1), 9, 2);
      p.fill(255, 255, 255, 170);
      p.textAlign(p.RIGHT);
      p.text(v.toFixed(2), x + w - 10, by + 22);
      p.textAlign(p.LEFT);
    };

    bar('arousal', r.arousal, 1, [255, 200, 90], 0);
    bar('startle', r.startle, 1, [255, 110, 110], 1);
    bar('beat Hz', r.beatHz, m.cfg.limbs.beatHzBurst, [140, 255, 190], 2);
    bar('speed', r.speed, 420, [130, 200, 255], 3);
    bar('|curve|', Math.abs(r.curvature), m.cfg.body.maxBend, [255, 150, 220], 4);

    // Solver health: arc length should be constant. If this drifts, the
    // constraint solver is losing, and the body will visibly stretch.
    const nominal = m.cfg.body.length;
    p.noStroke();
    p.fill(255, 255, 255, 110);
    p.textSize(9);
    p.text(`arc ${r.arcLength.toFixed(1)} / ${nominal.toFixed(0)} px`, x + 10, y + h - 12);
  }

  /** Compact key legend, always visible when the overlay is on. */
  drawLegend(p, flags) {
    const lines = [
      ['D', 'debug overlay', true],
      ['1-5', 'spine·forces·steering·wave·state', true],
      ['W', 'wander', flags.wander],
      ['L', 'phototaxis', flags.light],
      ['B', 'active bend', flags.bend],
      ['T', 'thrust', flags.thrust],
      ['P', 'particles', flags.particles],
      ['SPACE', 'pause', !flags.paused],
      ['R', 'reset', true],
    ];
    p.blendMode(p.BLEND);
    p.push();
    p.textFont('monospace');
    p.textSize(10);
    const h = 26 + lines.length * 15;
    const w = 262;
    const x = p.width - w - 18, y = p.height - h - 18;
    panelBg(p, x, y, w, h, 'CONTROLS');
    lines.forEach((l, i) => {
      const ly = y + 34 + i * 15;
      p.noStroke();
      p.fill(255, 255, 255, l[2] ? 200 : 70);
      p.text(l[0], x + 10, ly);
      p.fill(255, 255, 255, l[2] ? 150 : 55);
      p.text(l[1], x + 60, ly);
    });
    p.pop();
  }
}

function panelBg(p, x, y, w, h, title) {
  p.noStroke();
  p.fill(6, 10, 18, 205);
  p.rect(x, y, w, h, 4);
  p.stroke(255, 255, 255, 30);
  p.noFill();
  p.rect(x, y, w, h, 4);
  p.noStroke();
  p.fill(255, 255, 255, 190);
  p.textSize(10);
  p.text(title, x + 10, y + 16);
}
