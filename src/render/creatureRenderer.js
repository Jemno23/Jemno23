import { Vec2 } from '../core/vec2.js';
import { clamp, lerp } from '../core/mathx.js';
import { glowStroke, closedCurve, openCurve } from './darkfield.js';

/**
 * CreatureRenderer — draws a SeaMonkey.
 *
 * THE RULE THIS FILE OBEYS: it may read simulation state, and it may not create
 * any. Every limb angle, every body curve, every setal spread here is a number
 * the physics already integrated this frame. There is no decorative animation
 * anywhere in this file — no sin(t) that the simulation does not know about.
 *
 * That rule is not fussiness. The moment the picture contains motion the model
 * does not, the two drift out of phase, and the eye catches it as "the legs
 * aren't really pushing" long before the viewer can say why.
 *
 * Drawing order is back-to-front through the animal's own depth: the cephalic
 * lobes and the swimming legs sit behind the trunk, the gut and the eyes in
 * front of it. Eyes are the only part drawn in normal blend mode, because they
 * are the only genuinely opaque structure — everything else is transparent
 * tissue scattering light, which is an additive operation.
 */
export class CreatureRenderer {
  constructor(renderCfg) {
    this.cfg = renderCfg;
    this._t = new Vec2();
    this._n = new Vec2();
    this._speckle = null;
  }

  draw(p, m) {
    const chain = m.chain;
    const morph = m.morph;

    p.blendMode(p.ADD);

    this._drawLobes(p, m);
    this._drawLimbs(p, m);
    this._drawBody(p, chain, morph);
    this._drawSegments(p, m);
    this._drawGut(p, chain, morph);
    this._drawAntennae(p, m);
    this._drawFurca(p, m);

    this._drawEyes(p, m);

    p.blendMode(p.BLEND);
  }

  // ---------------------------------------------------------------------
  // Trunk
  // ---------------------------------------------------------------------

  /** Offset the spine by ±halfWidth along its local normal to get the silhouette. */
  _outline(chain, morph) {
    const left = [], right = [];
    for (let i = 0; i < chain.count; i++) {
      const n = chain.normal(i, this._n);
      const w = morph.halfWidth[i];
      const q = chain.pos[i];
      left.push(new Vec2(q.x + n.x * w, q.y + n.y * w));
      right.push(new Vec2(q.x - n.x * w, q.y - n.y * w));
    }
    return { left, right };
  }

  _drawBody(p, chain, morph) {
    const { left, right } = this._outline(chain, morph);
    // slice() before reverse() — `right` is reused below and reverse() mutates.
    const ring = left.concat(right.slice().reverse());
    const tint = this.cfg.bodyTint;

    // Dim interior — transparent tissue, so only a little light scatters through.
    p.noStroke();
    p.fill(tint[0] * 0.30, tint[1] * 0.34, tint[2] * 0.42, 74);
    closedCurve(p, ring);

    // Bright rim — the longest optical path through the specimen is at its edge.
    // Drawn in two passes so the line weight tracks the body's own width: a
    // constant-weight outline makes the slender abdomen read as a thick glowing
    // tube, which is the single thing that most made this look like a diagram
    // rather than a specimen.
    glowStroke(p, (pp) => closedCurve(pp, ring), tint, 0.75, 120, this.cfg.glowLayers);

    const heavy = Math.round(chain.count * 0.55);
    const anterior = (side) => (pp) => {
      pp.beginShape();
      for (let i = 0; i <= heavy; i++) pp.curveVertex(side[i].x, side[i].y);
      pp.endShape();
    };
    glowStroke(p, anterior(left), tint, 1.25, 150, 2);
    glowStroke(p, anterior(right), tint, 1.25, 150, 2);

    // A faint inner highlight just inside the dorsal margin gives the body
    // volume without any actual shading model.
    const inner = left.map((q, i) => {
      const n = chain.normal(i, this._n);
      const w = morph.halfWidth[i] * 0.42;
      return new Vec2(chain.pos[i].x + n.x * w, chain.pos[i].y + n.y * w);
    });
    p.stroke(tint[0], tint[1], tint[2], 32);
    p.strokeWeight(0.9);
    p.noFill();
    openCurve(p, inner);
  }

  /** Transverse banding across the thorax: the segment boundaries in the photo. */
  _drawSegments(p, m) {
    const { chain, morph, drive } = m;
    const tint = this.cfg.bodyTint;
    p.noFill();
    p.strokeWeight(0.8);
    for (let i = 0; i < drive.n; i++) {
      const node = drive.nodeOf[i];
      const n = chain.normal(node, this._n);
      const w = morph.halfWidth[node] * 0.92;
      const q = chain.pos[node];
      p.stroke(tint[0], tint[1], tint[2], 34);
      p.line(q.x - n.x * w, q.y - n.y * w, q.x + n.x * w, q.y + n.y * w);
    }
  }

  /**
   * The gut: a warm ochre tube running nose to furca. It is by some distance
   * the strongest single realism cue in the reference photograph — a translucent
   * animal with no visible viscera reads as glass.
   */
  _drawGut(p, chain, morph) {
    const g = morph.gut;
    const pts = [];
    for (let i = 0; i < chain.count; i++) {
      const s = morph.s[i];
      if (s < g.from || s > g.to) continue;
      pts.push(chain.pos[i]);
    }
    if (pts.length < 3) return;
    const c = this.cfg.gutTint;
    glowStroke(p, (pp) => openCurve(pp, pts), c, g.halfWidth * 2, 78, 2);
  }

  // ---------------------------------------------------------------------
  // Swimming legs
  // ---------------------------------------------------------------------

  /**
   * Each phyllopod is drawn as an arc swept from the limb's own instantaneous
   * angle, with a curl proportional to its angular velocity (the blade loads up
   * and bends against the water) and a setal fringe whose spread is the *same*
   * `area` term the thrust calculation used. So the legs visibly fan on the
   * power stroke and feather on the recovery — you can read the propulsion
   * model straight off the picture, because it is the propulsion model.
   */
  _drawLimbs(p, m) {
    const { chain, drive } = m;
    const tint = this.cfg.bodyTint;

    for (let i = 0; i < drive.n; i++) {
      const node = drive.nodeOf[i];
      const anchor = chain.pos[node];
      const t = chain.tangent(node, this._t).clone();
      const n = chain.normal(node, this._n).clone();

      const theta = drive.angle[i];
      const len = drive.lengthOf[i];
      const spread = drive.spreadOf(i);
      // Blade lag: the leaf trails its own hinge, scaled by tip speed.
      const curl = clamp(-drive.angVel[i] * 0.045, -0.9, 0.9);

      for (const side of [1, -1]) {
        this._drawBlade(p, anchor, t, n, side, theta, curl, len, spread, tint);
      }
    }
  }

  _drawBlade(p, anchor, t, n, side, theta, curl, len, spread, tint) {
    const STEPS = 6;
    const spine = [];
    let x = anchor.x, y = anchor.y;
    spine.push(new Vec2(x, y));
    for (let k = 1; k <= STEPS; k++) {
      const u = k / STEPS;
      // Integrating a turning direction along the blade gives a natural arc.
      const a = theta + curl * u * u;
      const dx = (n.x * side * Math.cos(a) + t.x * Math.sin(a));
      const dy = (n.y * side * Math.cos(a) + t.y * Math.sin(a));
      x += dx * (len / STEPS);
      y += dy * (len / STEPS);
      spine.push(new Vec2(x, y));
    }

    // Leaf outline: widest around 55% of the blade, tapering to a point.
    const wMax = len * 0.185 * lerp(0.60, 1, spread);
    const left = [], right = [];
    for (let k = 0; k <= STEPS; k++) {
      const u = k / STEPS;
      const w = wMax * Math.sin(Math.PI * Math.pow(u, 0.55));
      const a = spine[Math.max(0, k - 1)], b = spine[Math.min(STEPS, k + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const px = -dy / d, py = dx / d;
      left.push(new Vec2(spine[k].x + px * w, spine[k].y + py * w));
      right.push(new Vec2(spine[k].x - px * w, spine[k].y - py * w));
    }

    const alpha = lerp(15, 38, spread);
    p.noStroke();
    p.fill(tint[0] * 0.42, tint[1] * 0.48, tint[2] * 0.58, alpha);
    closedCurve(p, left.concat(right.slice().reverse()));

    p.stroke(tint[0], tint[1], tint[2], lerp(44, 88, spread));
    p.strokeWeight(0.65);
    p.noFill();
    openCurve(p, left);
    openCurve(p, right);

    // Setal fringe: many fine, near-parallel hairs along BOTH margins, as in
    // the reference. Two mistakes to avoid, both of which read instantly as
    // wrong — too few hairs (the limb looks like a comb) and too much fan
    // angle (it looks like a starburst instead of a feather). Real setae are
    // dense, short relative to the blade, and only slightly splayed.
    const nSet = 14;
    const setaLen = len * lerp(0.07, 0.26, spread);
    p.strokeWeight(0.45);
    p.stroke(tint[0], tint[1], tint[2], lerp(20, 62, spread));
    for (const margin of [left, right]) {
      for (let s = 0; s < nSet; s++) {
        const u = 0.20 + 0.78 * (s / (nSet - 1));
        const k = u * STEPS;
        const k0 = Math.min(STEPS - 1, Math.floor(k));
        const f = k - k0;
        const bx = lerp(margin[k0].x, margin[k0 + 1].x, f);
        const by = lerp(margin[k0].y, margin[k0 + 1].y, f);
        const ax = lerp(spine[k0].x, spine[k0 + 1].x, f);
        const ay = lerp(spine[k0].y, spine[k0 + 1].y, f);
        let dx = bx - ax, dy = by - ay;
        const d = Math.hypot(dx, dy) || 1;
        dx /= d; dy /= d;
        // Slight fan, biased distally so the fringe sweeps toward the tip.
        const fan = lerp(0.06, 0.30, spread) * (u - 0.6);
        const c = Math.cos(fan), sn = Math.sin(fan);
        const ex = dx * c - dy * sn, ey = dx * sn + dy * c;
        const L = setaLen * (0.65 + 0.55 * Math.sin(Math.PI * u));
        p.line(bx, by, bx + ex * L, by + ey * L);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Head structures
  // ---------------------------------------------------------------------

  /** The two large translucent cephalic paddles flanking the head. */
  _drawLobes(p, m) {
    const { chain, morph } = m;
    const L = morph.lobe;
    const node = L.node;
    const anchor = chain.pos[node];
    const t = chain.tangent(node, this._t).clone();
    const n = chain.normal(node, this._n).clone();
    const tint = this.cfg.bodyTint;

    if (!this._speckle) this._speckle = makeSpeckle(46);

    for (const side of [1, -1]) {
      // Lobe frame: an ellipse swung out and back from the head axis.
      const ang = L.angle * side;
      const ux = (-t.x) * Math.cos(ang) - (-t.y) * Math.sin(ang);
      const uy = (-t.x) * Math.sin(ang) + (-t.y) * Math.cos(ang);
      const cx = anchor.x + n.x * side * L.width * 0.52 - ux * L.length * 0.18;
      const cy = anchor.y + n.y * side * L.width * 0.52 - uy * L.length * 0.18;

      const pts = [];
      const SEG = 22;
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        // Slight asymmetry so the lobe is leaf-shaped rather than a perfect oval.
        const rx = L.length * 0.5 * (1 + 0.10 * Math.cos(a));
        const ry = L.width * 0.5 * (1 + 0.06 * Math.sin(a * 2));
        const lx = Math.cos(a) * rx, ly = Math.sin(a) * ry;
        pts.push(new Vec2(cx + lx * ux - ly * uy, cy + lx * uy + ly * ux));
      }

      p.noStroke();
      p.fill(tint[0] * 0.34, tint[1] * 0.38, tint[2] * 0.46, 34);
      closedCurve(p, pts);
      glowStroke(p, (pp) => closedCurve(pp, pts), tint, 0.9, 96, 2);

      // Granular texture, as in the photograph. Fixed in the lobe's own frame so
      // it travels with the tissue instead of crawling across it.
      p.noStroke();
      p.fill(tint[0], tint[1], tint[2], 44);
      for (const s of this._speckle) {
        const lx = s.x * L.length * 0.42, ly = s.y * L.width * 0.42;
        p.circle(cx + lx * ux - ly * uy, cy + lx * uy + ly * ux, s.r);
      }
    }
  }

  _drawAntennae(p, m) {
    const tint = this.cfg.bodyTint;
    for (const f of m.antennae) {
      const pts = f.pos;
      p.noFill();
      for (let i = 1; i < pts.length; i++) {
        const u = i / (pts.length - 1);
        p.stroke(tint[0], tint[1], tint[2], 190 * (1 - u * 0.55));
        p.strokeWeight(lerp(1.7, 0.45, u));
        p.line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
      }
    }
  }

  /**
   * Eyes. The one opaque structure on the animal, so the only thing drawn in
   * normal blend mode — under additive compositing a dark object is invisible.
   */
  _drawEyes(p, m) {
    const { chain, morph } = m;
    const e = morph.eye;
    const anchor = chain.pos[e.node];
    const n = chain.normal(e.node, this._n).clone();
    const t = chain.tangent(e.node, this._t).clone();
    const tint = this.cfg.bodyTint;
    const eye = this.cfg.eyeTint;

    for (const side of [1, -1]) {
      const sx = anchor.x + n.x * side * e.offset * 0.45;
      const sy = anchor.y + n.y * side * e.offset * 0.45;
      const ex = anchor.x + n.x * side * e.offset - t.x * e.stalk;
      const ey = anchor.y + n.y * side * e.offset - t.y * e.stalk;

      p.blendMode(p.ADD);
      p.stroke(tint[0], tint[1], tint[2], 70);
      p.strokeWeight(e.radius * 0.8);
      p.line(sx, sy, ex, ey);

      p.blendMode(p.BLEND);
      p.noStroke();
      p.fill(eye[0], eye[1], eye[2], 245);
      p.circle(ex, ey, e.radius * 2);

      p.blendMode(p.ADD);
      p.fill(235, 245, 255, 150);
      p.circle(ex - t.x * e.radius * 0.35, ey - t.y * e.radius * 0.35, e.radius * 0.7);
    }

    // Median (naupliar) eye on the midline, small and dark.
    const mn = e.medianNode ?? 2;
    const mx = chain.pos[mn].x, my = chain.pos[mn].y;
    p.blendMode(p.BLEND);
    p.noStroke();
    p.fill(eye[0] * 0.7, eye[1] * 0.7, eye[2] * 0.7, 190);
    p.circle(mx, my, e.radius * 0.85);
    p.blendMode(p.ADD);
  }

  /** Forked tail: two cercopods, each carrying a fan of long setae. */
  _drawFurca(p, m) {
    const { chain, morph } = m;
    const f = morph.furca;
    const last = chain.count - 1;
    const anchor = chain.pos[last];
    const t = chain.tangent(last, this._t).clone();
    const tint = this.cfg.bodyTint;

    for (const side of [1, -1]) {
      const a = f.splay * side;
      const dx = t.x * Math.cos(a) - t.y * Math.sin(a);
      const dy = t.x * Math.sin(a) + t.y * Math.cos(a);
      const tx = anchor.x + dx * f.length, ty = anchor.y + dy * f.length;

      p.stroke(tint[0], tint[1], tint[2], 130);
      p.strokeWeight(1.4);
      p.line(anchor.x, anchor.y, tx, ty);

      p.strokeWeight(0.6);
      for (let s = 0; s < f.setaeCount; s++) {
        const u = s / (f.setaeCount - 1) - 0.5;
        const fan = u * 0.70;
        const c = Math.cos(fan), sn = Math.sin(fan);
        const ex = dx * c - dy * sn, ey = dx * sn + dy * c;
        const L = f.length * (1.9 - Math.abs(u) * 1.0);
        p.stroke(tint[0], tint[1], tint[2], 105 - Math.abs(u) * 60);
        p.line(tx, ty, tx + ex * L, ty + ey * L);
      }
    }
  }
}

/** Deterministic blue-noise-ish speckle inside the unit disc, generated once. */
function makeSpeckle(count) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const a = i * golden;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: 1.1 + (i % 3) * 0.7 });
  }
  return pts;
}
