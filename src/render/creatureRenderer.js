import { Vec2 } from '../core/vec2.js';
import { clamp, lerp } from '../core/mathx.js';
import { glowStroke, closedCurve, openCurve, closedPoly, openPoly } from './darkfield.js';

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

  /**
   * Offset the spine by ±halfWidth along its local normal to get the silhouette.
   *
   * The spine is resampled at SUBDIV times the physics resolution first, with
   * the width evaluated continuously from the measured profile rather than at
   * the nodes. Twenty-eight nodes is plenty for the dynamics but far too coarse
   * for the shape: the head occupies six of them, so the rounded cephalic
   * shield came out as a visible kink at the rostrum. Resampling is purely a
   * rendering concern and belongs here — it would be wrong to add nodes to the
   * simulation to fix a drawing problem, and it would change the dynamics.
   */
  _outline(chain, morph) {
    const SUBDIV = 3;
    const left = [], right = [];
    const n = chain.count;
    const p0 = new Vec2(), p1 = new Vec2();

    for (let i = 0; i < n - 1; i++) {
      const steps = i === n - 2 ? SUBDIV : SUBDIV - 1;
      for (let k = 0; k <= steps; k++) {
        const t = k / SUBDIV;
        catmullRom(chain.pos, i, t, p0);
        // Tangent by finite difference along the same spline.
        catmullRom(chain.pos, i, Math.min(1, t + 0.02), p1);
        let dx = p1.x - p0.x, dy = p1.y - p0.y;
        if (Math.hypot(dx, dy) < 1e-6) { dx = chain.pos[i + 1].x - chain.pos[i].x; dy = chain.pos[i + 1].y - chain.pos[i].y; }
        const d = Math.hypot(dx, dy) || 1;
        const nx = -dy / d, ny = dx / d;

        const s = (i + t) / (n - 1);
        const w = morph.widthAt(s) * morph.L;
        left.push(new Vec2(p0.x + nx * w, p0.y + ny * w));
        right.push(new Vec2(p0.x - nx * w, p0.y - ny * w));
      }
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
    p.fill(tint[0] * 0.34, tint[1] * 0.38, tint[2] * 0.46, 92);
    closedPoly(p, ring);

    // Bright rim — the longest optical path through the specimen is at its edge.
    // Drawn in two passes so the line weight tracks the body's own width: a
    // constant-weight outline makes the slender abdomen read as a thick glowing
    // tube, which is the single thing that most made this look like a diagram
    // rather than a specimen.
    glowStroke(p, (pp) => closedPoly(pp, ring), tint, 0.75, 120, this.cfg.glowLayers);

    const heavy = Math.round(left.length * 0.62);
    const anterior = (side) => (pp) => {
      pp.beginShape();
      for (let i = 0; i <= heavy; i++) pp.vertex(side[i].x, side[i].y);
      pp.endShape();
    };
    glowStroke(p, anterior(left), tint, 1.25, 150, 2);
    glowStroke(p, anterior(right), tint, 1.25, 150, 2);

    // A faint inner highlight just inside the dorsal margin gives the body
    // volume without any actual shading model. Built from the physics nodes,
    // not the resampled outline — those two arrays have different lengths.
    const inner = [];
    for (let i = 0; i < chain.count; i++) {
      const nrm = chain.normal(i, this._n);
      const w = morph.halfWidth[i] * 0.42;
      inner.push(new Vec2(chain.pos[i].x + nrm.x * w, chain.pos[i].y + nrm.y * w));
    }
    p.stroke(tint[0], tint[1], tint[2], 32);
    p.strokeWeight(0.9);
    p.noFill();
    openCurve(p, inner);
  }

  /**
   * Transverse banding — the segment boundaries. Runs the length of the trunk,
   * not just the thorax: the reference photograph shows the abdomen is clearly
   * segmented too, and a smooth featureless abdomen is what makes a rendering
   * of an arthropod read as a worm.
   */
  _drawSegments(p, m) {
    const { chain, morph } = m;
    const tint = this.cfg.bodyTint;
    p.noFill();
    p.strokeWeight(0.8);
    for (let i = morph.thoraxStart - 2; i < chain.count - 1; i++) {
      if (i < 1) continue;
      const n = chain.normal(i, this._n);
      const w = morph.halfWidth[i] * 0.92;
      const q = chain.pos[i];
      // Fainter down the abdomen, where the cuticle is thinner.
      p.stroke(tint[0], tint[1], tint[2], i <= morph.thoraxEnd ? 26 : 14);
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
    // Drawn as one crisp stroke at the measured width plus a single faint halo.
    // The usual multi-pass glow blooms a 0.014 L stripe into a fat ochre bar.
    p.noFill();
    p.stroke(c[0], c[1], c[2], 16);
    p.strokeWeight(g.halfWidth * 3.8);
    openCurve(p, pts);
    p.stroke(c[0], c[1], c[2], 56);
    p.strokeWeight(g.halfWidth * 2);
    openCurve(p, pts);
  }

  // ---------------------------------------------------------------------
  // Swimming legs
  // ---------------------------------------------------------------------

  /**
   * The thoracopods, rebuilt from a close reading of the reference photograph.
   *
   * The first version drew each limb as a translucent leaf with a setal fringe
   * down both margins, composited additively like the rest of the animal.
   * Enlarging the photograph and putting the two side by side showed two
   * separate errors.
   *
   * STRUCTURE. A phyllopod is not a leaf. Each one is an elongated, recurved
   * PADDLE carrying a dark, densely granular EPIPODITE SAC (the gill) over
   * roughly its middle half — by far its most conspicuous feature — with a
   * bright rib along its axis and a tuft of fine SETAE springing from the
   * outer quarter of the distal margin, not a fringe running down the sides.
   *
   * COMPOSITING, which mattered more. The limbs are the one part of this
   * animal that must NOT be drawn additively. Everything else is thin
   * translucent tissue scattering light, and adding is right; but a limb row
   * is thick, packed, mutually overlapping flesh, and drawn additively it came
   * out as a transparent wireframe lattice where the reference shows solid
   * mass. Compositing them normally, back to front, means a near limb hides
   * the one behind it — which is what makes eleven overlapping paddles read as
   * a dense fan instead of a moiré pattern. It also lets the gill sacs read at
   * all: on a black field a dark shape is only visible as light it removes.
   */
  _drawLimbs(p, m) {
    const { chain, drive } = m;
    const tint = this.cfg.bodyTint;
    const geo = [];

    for (let i = 0; i < drive.n; i++) {
      const node = drive.nodeOf[i];
      const anchor = chain.pos[node];
      const t = chain.tangent(node, this._t).clone();
      const n = chain.normal(node, this._n).clone();

      const theta = drive.angle[i];
      const len = drive.lengthOf[i];
      const spread = drive.spreadOf(i);
      // Blade lag: the paddle trails its own hinge, scaled by tip speed.
      const curl = clamp(-drive.angVel[i] * 0.040, -0.8, 0.8);

      const hw = m.morph.halfWidth[node];
      for (const side of [1, -1]) {
        geo.push(this._limbGeometry(anchor, t, n, side, theta, curl, len, spread, i, hw));
      }
    }

    // Anterior first, so each limb is overlapped by the one behind it, as in
    // the photograph. Opaque compositing throughout — see the note above.
    p.blendMode(p.BLEND);
    if (!this._speckle) this._speckle = makeSpeckle(46);
    for (const g of geo) this._drawLimb(p, g, tint);
    p.blendMode(p.ADD);
  }

  _drawLimb(p, g, tint) {
    const sp = g.spread;

    // Setae first: fine and behind the membrane, so a limb in front of them
    // cleanly cuts them off rather than showing through.
    this._setalTuft(p, g, tint);

    // Membrane — solid pale tissue.
    p.noStroke();
    p.fill(tint[0] * 0.62, tint[1] * 0.68, tint[2] * 0.76, lerp(190, 228, sp));
    closedPoly(p, g.left.concat(g.right.slice().reverse()));

    // Gill sac — the one dark structure on the limb.
    p.fill(9, 13, 21, lerp(215, 245, sp));
    closedPoly(p, g.sac);

    // Granules: fine bright scatterers on the dark ground.
    p.fill(tint[0], tint[1], tint[2], lerp(120, 175, sp));
    // Every other station, five granules each. Denser than this looks no
    // different at any realistic zoom and costs ~1500 circles a frame.
    for (let ci = 0; ci < g.sacCentres.length; ci += 2) {
      const q = g.sacCentres[ci];
      for (let k = 0; k < 5; k++) {
        const s = this._speckle[(k * 5 + ci * 3 + g.index * 7) % this._speckle.length];
        p.circle(q.mid.x + (s.x * 0.85) * q.w * q.px + (s.y * 0.9) * q.w * -q.py,
                 q.mid.y + (s.x * 0.85) * q.w * q.py + (s.y * 0.9) * q.w * q.px,
                 0.9 + (k % 2) * 0.4);
      }
    }

    // Bright margins and the rib along the limb axis.
    p.noFill();
    p.strokeWeight(0.6);
    p.stroke(tint[0], tint[1], tint[2], lerp(70, 110, sp));
    openPoly(p, g.left);
    openPoly(p, g.right);
    // One prominent rib per limb, as in the photograph — not a bright outline
    // on every edge, which turns the row into a lattice of intersecting lines.
    p.strokeWeight(1.0);
    p.stroke(tint[0], tint[1], tint[2], lerp(135, 180, sp));
    openPoly(p, g.spine.slice(2));
  }

  /**
   * Distal setal tuft. Roots walk along the outer quarter of the blade MARGIN
   * rather than all springing from the tip — radiating everything from one
   * point produced starbursts that read as detached feather dusters. Real setae
   * are near-parallel, close-packed and only gently splayed.
   */
  _setalTuft(p, g, tint) {
    const nSet = 9;
    const L = g.len * lerp(0.30, 0.54, g.spread);
    const fanMax = lerp(0.05, 0.17, g.spread);
    const margin = g.side > 0 ? g.left : g.right;
    const last = margin.length - 1;
    p.noFill();
    p.strokeWeight(0.5);
    p.stroke(tint[0] * 0.50, tint[1] * 0.56, tint[2] * 0.66, lerp(70, 120, g.spread));
    const baseA = Math.atan2(g.tipDir.y, g.tipDir.x);
    for (let s = 0; s < nSet; s++) {
      const f = s / (nSet - 1);
      const kf = (0.66 + 0.34 * f) * last;
      const k0 = Math.min(last - 1, Math.floor(kf));
      const fr = kf - k0;
      let px = lerp(margin[k0].x, margin[k0 + 1].x, fr);
      let py = lerp(margin[k0].y, margin[k0 + 1].y, fr);
      const a0 = baseA + (f - 0.5) * 2 * fanMax;
      p.beginShape();
      p.vertex(px, py);
      const SEG = 2;
      for (let k = 1; k <= SEG; k++) {
        const a = a0 - (k / SEG) * 0.34 * g.side;
        px += Math.cos(a) * (L / SEG);
        py += Math.sin(a) * (L / SEG);
        p.vertex(px, py);
      }
      p.endShape();
    }
  }

  /** Integrate a turning direction along the limb to get its curved axis. */
  _limbGeometry(anchor, t, n, side, theta, curl, len, spread, index, halfWidth = 0) {
    const STEPS = 7;
    const recurve = this.cfg.limbRecurve ?? 0.55;
    // Limbs articulate at the BODY WALL, not the midline. Anchoring them on the
    // spine made every base converge to one point, which drew a row of bright
    // chevrons down the animal's axis and buried the proximal blade inside the
    // trunk. Offsetting to the margin also matches where they actually attach.
    const spine = [];
    let x = anchor.x + n.x * side * halfWidth * 0.85;
    let y = anchor.y + n.y * side * halfWidth * 0.85;
    spine.push(new Vec2(x, y));
    for (let k = 1; k <= STEPS; k++) {
      const u = k / STEPS;
      // Constant recurve gives the characteristic hook; the angular-velocity
      // term adds the extra bend of a blade loaded against the water.
      const a = theta + recurve * u + curl * u * u;
      const dx = (n.x * side * Math.cos(a) + t.x * Math.sin(a));
      const dy = (n.y * side * Math.cos(a) + t.y * Math.sin(a));
      x += dx * (len / STEPS);
      y += dy * (len / STEPS);
      spine.push(new Vec2(x, y));
    }

    // Paddle outline — a long tapering blade, not a pointed leaf.
    const wMax = len * 0.26 * lerp(0.66, 1, spread);
    const left = [], right = [];
    for (let k = 0; k <= STEPS; k++) {
      const u = k / STEPS;
      const w = wMax * Math.sin(Math.PI * Math.pow(u, 0.42)) ** 0.75;
      const a = spine[Math.max(0, k - 1)], b = spine[Math.min(STEPS, k + 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const px = -dy / d, py = dx / d;
      left.push(new Vec2(spine[k].x + px * w, spine[k].y + py * w));
      right.push(new Vec2(spine[k].x - px * w, spine[k].y - py * w));
    }

    // Gill sac: an oval over the middle third, biased to one margin.
    const sac = [];
    const a0 = 0.20, a1 = 0.78;
    for (let k = 0; k <= STEPS; k++) {
      const u = k / STEPS;
      if (u < a0 || u > a1) continue;
      const v = (u - a0) / (a1 - a0);
      const w = wMax * 0.66 * Math.sin(Math.PI * v) ** 0.5;
      const mid = Vec2.lerp(spine[k], side > 0 ? left[k] : right[k], 0.22);
      const a = spine[Math.max(0, k - 1)], b = spine[Math.min(STEPS, k + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const px = -dy / d, py = dx / d;
      sac.push({ mid, px, py, w });
    }
    const sacRing = sac.map((q) => new Vec2(q.mid.x + q.px * q.w, q.mid.y + q.py * q.w))
      .concat(sac.slice().reverse().map((q) => new Vec2(q.mid.x - q.px * q.w, q.mid.y - q.py * q.w)));

    // Tip direction, for the distal setal tuft.
    const tipA = spine[STEPS - 1], tipB = spine[STEPS];
    const tdx = tipB.x - tipA.x, tdy = tipB.y - tipA.y;
    const td = Math.hypot(tdx, tdy) || 1;

    return {
      spine, left, right, sac: sacRing, spread, len, side, index,
      tip: tipB, tipDir: new Vec2(tdx / td, tdy / td),
      sacCentres: sac,
    };
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
      const off = L.offset ?? 0.52;
      const cx = anchor.x + n.x * side * L.width * off - ux * L.length * 0.18;
      const cy = anchor.y + n.y * side * L.width * off - uy * L.length * 0.18;

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

/**
 * Catmull-Rom interpolation of `pts` on segment i at parameter t in [0,1].
 * Endpoints are clamped, so the curve passes through every node and does not
 * fly off at the head or the furca.
 */
function catmullRom(pts, i, t, out) {
  const n = pts.length;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[Math.min(n - 1, i + 1)];
  const p3 = pts[Math.min(n - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  const a = -0.5 * t3 + t2 - 0.5 * t;
  const b = 1.5 * t3 - 2.5 * t2 + 1;
  const c = -1.5 * t3 + 2 * t2 + 0.5 * t;
  const d = 0.5 * t3 - 0.5 * t2;
  return out.set(
    p0.x * a + p1.x * b + p2.x * c + p3.x * d,
    p0.y * a + p1.y * b + p2.y * c + p3.y * d,
  );
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
