import { Vec2 } from './vec2.js';
import { clamp, wrapAngle } from './mathx.js';

/**
 * Chain — the soft body: a particle chain with constraint-projected lengths,
 * impulse-corrected velocities, and an elastic bending beam.
 *
 * ---------------------------------------------------------------------------
 * WHY A CHAIN, AND WHY FORCES RATHER THAN KEYFRAMES
 * ---------------------------------------------------------------------------
 * The single biggest tell of a fake creature is a body that is *drawn* moving
 * rather than one that *is* moved. If you write the body as `y = sin(x - t)`
 * you get a wave that is perfect, endless, and identical on every turn — no
 * overshoot, no lag, no recoil. It reads as a flag, not an animal.
 *
 * So the body here is 28 point masses joined by constraints. Nothing pushes the
 * whole creature; the swimming limbs push their *own* attachment points, and
 * everything else — the head leading, the abdomen trailing, the body bowing
 * under thrust, the tail whipping through a turn — falls out of the solver.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PIECES OF MATHEMATICS
 * ---------------------------------------------------------------------------
 * 1. ANISOTROPIC DRAG (the important one).
 *    Water resists a slender body far more across its length than along it.
 *    Decomposing each node's velocity into tangential and normal components and
 *    damping them with different coefficients is what makes an undulating body
 *    go *forwards* instead of sliding sideways. Turn this off (set the two
 *    coefficients equal) and the creature instantly reads as a paper cutout
 *    skidding on ice. It is the cheapest, highest-value line in the project.
 *
 *    Drag has both a linear (viscous) and a quadratic (form) term:
 *
 *      dv/dt = -(k1 + k2*|v|) * v,  applied separately along and across
 *
 *    The quadratic term is not decoration. A drag-based paddle produces thrust
 *    proportional to the SQUARE of beat frequency, so against purely linear
 *    drag the swimming speed would also go as f^2 — a creature that beats
 *    3.5x faster in a burst would move 12x faster, which both looks absurd and
 *    tears the body apart. With form drag dominating, speed goes roughly as f,
 *    and glide / cruise / burst come out as three sane, distinct gaits. This is
 *    also simply the correct regime: at Re of a few hundred, form drag wins.
 *
 * 2. DISTANCE CONSTRAINTS — the body is inextensible. Enforced in two passes,
 *    and the split matters:
 *
 *      a) a POSITION pass that removes accumulated stretch, and
 *      b) a VELOCITY pass that cancels the relative velocity along each segment.
 *
 *    The obvious approach — plain PBD, where velocity is re-derived as
 *    (p - p_prev)/h after projecting positions — is a trap here, and an
 *    instructive one. It amplifies every positional correction by 1/h, so
 *    shortening the timestep to stabilise the stiff bending beam made the
 *    *distance* solver dramatically worse: sub-pixel corrections turned into
 *    thousands of px/s, the light abdomen cracked like a bullwhip, and the
 *    animal tore itself apart. Cancelling relative velocity with impulses
 *    instead is timestep-independent, so the two systems stop fighting.
 *
 * 3. BENDING AS A DAMPED ELASTIC TORQUE, with a writable rest curvature.
 *    Each interior node has a target turn angle; the body is an elastic beam
 *    that resists deviation from it. Rest curvature of zero means "the body
 *    wants to be straight". Crucially the rest angle is *writable*: the
 *    steering system sets a non-zero rest curvature to make the animal bend
 *    into a turn, exactly as a muscle contracting along one side would.
 *
 *    This is deliberately a FORCE, not a position projection, and that choice
 *    was arrived at the hard way. Bending as a PBD constraint blows the
 *    simulation up: the solver moves nodes by an appreciable fraction of a
 *    segment length in a single step, and because PBD derives velocity from
 *    the total positional correction, that shows up as hundreds of px/s of
 *    velocity out of nowhere, which feeds the next step. As an elastic beam
 *    with an explicit damping term it is well-behaved, and it is also the more
 *    honest model: real tissue has bending stiffness, not a bend constraint.
 *
 *    The fold limit is likewise a force — stiffness that ramps up sharply past
 *    maxBend — rather than a hard stop. Cuticle does not have a hinge stop; it
 *    just becomes much harder to bend. Keeping it a force also keeps large
 *    angular corrections out of the position solver, which is where they would
 *    do damage.
 *
 * Stiffness is specified as an angular frequency rather than a raw spring
 * constant so it can be reasoned about against the timestep: the explicitly
 * integrated beam is stable while bendOmega * (dt / substeps) stays well below
 * one, which is what the substepping below buys.
 */
export class Chain {
  /**
   * @param {object} o
   * @param {number} o.count            number of nodes (node 0 = anterior tip)
   * @param {number} o.segLen           rest length between adjacent nodes
   * @param {number} o.dragTangent        s^-1, linear damping along the body axis
   * @param {number} o.dragNormal         s^-1, linear damping across it (>> tangent)
   * @param {number} [o.dragTangentQuad]  px^-1, quadratic (form) drag along
   * @param {number} [o.dragNormalQuad]   px^-1, quadratic (form) drag across
   * @param {number} o.bendOmega          rad/s, stiffness of the bending beam
   * @param {number} [o.bendDamping]      damping ratio; 1 = critical
   * @param {number} [o.bendProfile]      per-node stiffness multipliers
   * @param {number} o.maxBend            rad, turn angle past which folding stiffens
   * @param {number} [o.foldStiffness]    stiffness multiplier beyond maxBend
   * @param {number} [o.iterations]       distance solver iterations per substep
   * @param {number} [o.substeps]         internal physics substeps per step()
   * @param {number[]} [o.massProfile]    per-node mass; defaults to uniform
   */
  constructor(o) {
    const n = o.count;
    this.count = n;
    this.segLen = o.segLen;
    this.dragTangent = o.dragTangent;
    this.dragNormal = o.dragNormal;
    this.dragTangentQuad = o.dragTangentQuad ?? 0;
    this.dragNormalQuad = o.dragNormalQuad ?? 0;
    this.bendOmega = o.bendOmega;
    this.bendDamping = o.bendDamping ?? 1;
    /**
     * Per-node stiffness multiplier. Real bodies are not uniformly flexible,
     * and here it is load-bearing in both senses: the thorax has to carry the
     * thrust of eleven limb pairs in compression without buckling, while the
     * abdomen has to be free to trail.
     */
    this.bendProfile = o.bendProfile ?? new Float32Array(n).fill(1);
    this.maxBend = o.maxBend;
    /** Multiplier on bending stiffness once maxBend is exceeded. */
    this.foldStiffness = o.foldStiffness ?? 10;
    this.iterations = o.iterations ?? 4;
    /** Hard ceiling on node speed (px/s). Purely a stability guard. */
    this.maxSpeed = o.maxSpeed ?? 4000;

    /**
     * Internal substeps per call to step(). The bending beam is stiff, and the
     * stability limit of an explicitly integrated spring is set by omega*h, not
     * by omega alone. Rather than soften the body until it is stable at the
     * outer timestep — which produces a wet noodle — we take several small
     * steps. This is the same trade modern XPBD solvers make: many cheap
     * substeps beat few expensive iterations. 28 nodes makes it nearly free.
     */
    this.substeps = o.substeps ?? 6;

    this.pos = Array.from({ length: n }, () => new Vec2());
    this.prevPos = Array.from({ length: n }, () => new Vec2());
    this.vel = Array.from({ length: n }, () => new Vec2());
    /** Forces from outside (thrust, steering, ambient flow), held across substeps. */
    this.extForce = Array.from({ length: n }, () => new Vec2());
    /** Working accumulator: external forces plus this substep's bend forces. */
    this.force = Array.from({ length: n }, () => new Vec2());

    this.mass = new Float32Array(n);
    this.invMass = new Float32Array(n);
    for (let i = 0; i < n; i++) this.setMass(i, o.massProfile ? o.massProfile[i] : 1);

    /** Target turn angle at each interior node, in radians. Written by steering. */
    this.restCurve = new Float32Array(n);

    // Scratch, reused each frame to keep the solver allocation-free.
    this._t = new Vec2();
    this._d = new Vec2();
  }

  setMass(i, m) {
    this.mass[i] = m;
    this.invMass[i] = m > 0 ? 1 / m : 0;
  }

  /** Lay the chain out straight from `origin` along `dir`. */
  init(origin, dir) {
    const d = dir.clone().normalize();
    for (let i = 0; i < this.count; i++) {
      this.pos[i].set(origin.x + d.x * this.segLen * i, origin.y + d.y * this.segLen * i);
      this.prevPos[i].copyFrom(this.pos[i]);
      this.vel[i].zero();
    }
  }

  /** External force for the current step. Held constant across all substeps. */
  addForce(i, fx, fy) {
    this.extForce[i].x += fx;
    this.extForce[i].y += fy;
  }

  addForceV(i, v) { this.extForce[i].add(v); }

  /**
   * Local body axis at node i, pointing posteriorly (head -> tail).
   * Central difference in the interior so the tangent is smooth; one-sided at
   * the ends. Used for anisotropic drag, limb attachment, and body outline.
   */
  tangent(i, out = new Vec2()) {
    const a = this.pos[Math.max(0, i - 1)];
    const b = this.pos[Math.min(this.count - 1, i + 1)];
    return out.set(b.x - a.x, b.y - a.y).normalize();
  }

  /** Lateral axis at node i (tangent rotated +90°). */
  normal(i, out = new Vec2()) {
    this.tangent(i, out);
    const x = out.x;
    out.x = -out.y;
    out.y = x;
    return out;
  }

  /** Signed turn angle at interior node i: the angle from segment (i-1,i) to (i,i+1). */
  curvatureAt(i) {
    if (i <= 0 || i >= this.count - 1) return 0;
    const a = this.pos[i - 1], b = this.pos[i], c = this.pos[i + 1];
    return wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
  }

  /**
   * Heading of the anterior end, averaged over the first `k` segments so that a
   * single wobbling node cannot make the whole creature appear to swerve. This
   * is the value the steering controller closes its loop on.
   */
  heading(k = 4) {
    const j = Math.min(k, this.count - 1);
    // The chain runs head -> tail, so forward is the reverse of the tangent.
    return Math.atan2(this.pos[0].y - this.pos[j].y, this.pos[0].x - this.pos[j].x);
  }

  /** Mass-weighted mean velocity — the whole organism's velocity. */
  centerVelocity(out = new Vec2()) {
    out.zero();
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      out.addScaled(this.vel[i], this.mass[i]);
      m += this.mass[i];
    }
    return out.div(m || 1);
  }

  centroid(out = new Vec2()) {
    out.zero();
    for (let i = 0; i < this.count; i++) out.add(this.pos[i]);
    return out.div(this.count);
  }

  /** Sum of segment lengths — should stay ~constant; a useful solver health check. */
  arcLength() {
    let s = 0;
    for (let i = 1; i < this.count; i++) s += Vec2.dist(this.pos[i - 1], this.pos[i]);
    return s;
  }

  /**
   * Advance one step: integrate -> project constraints -> re-derive velocity.
   * Re-deriving velocity from the positions the solver actually produced (rather
   * than keeping the integrated velocity) is what makes PBD stable: energy the
   * constraints removed does not come back next frame.
   */
  step(dt) {
    const h = dt / this.substeps;
    for (let s = 0; s < this.substeps; s++) this._substep(h);
    for (let i = 0; i < this.count; i++) this.extForce[i].zero();
  }

  _substep(h) {
    const n = this.count;

    for (let i = 0; i < n; i++) this.force[i].copyFrom(this.extForce[i]);
    this._applyBendForces();

    for (let i = 0; i < n; i++) {
      const p = this.pos[i], v = this.vel[i];
      this.prevPos[i].copyFrom(p);

      if (this.invMass[i] > 0) v.addScaled(this.force[i], this.invMass[i] * h);

      this._applyAnisotropicDrag(i, v, h);

      p.addScaled(v, h);
    }

    // (a) Remove positional drift, (b) then cancel along-segment relative
    // velocity with impulses. Never re-derive velocity from (a); see the class
    // comment for why that particular shortcut is fatal here.
    for (let k = 0; k < this.iterations; k++) this._solveDistance();
    for (let k = 0; k < this.iterations; k++) this._solveDistanceVelocity();

    // Safety net. A bad parameter should degrade the motion, never destroy the
    // simulation: if a node has gone non-finite, fall back to its last known
    // good position rather than letting NaN propagate through the whole chain.
    for (let i = 0; i < n; i++) {
      const p = this.pos[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        p.copyFrom(this.prevPos[i]);
        this.vel[i].zero();
      }
      this.vel[i].limit(this.maxSpeed);
    }
  }

  /**
   * Velocity-level inextensibility: for each segment, cancel the component of
   * relative velocity along the segment axis with an equal-and-opposite
   * impulse, weighted by inverse mass. Momentum-conserving, and — the whole
   * point — independent of the timestep.
   */
  _solveDistanceVelocity() {
    for (let i = 0; i < this.count - 1; i++) {
      const pa = this.pos[i], pb = this.pos[i + 1];
      const va = this.vel[i], vb = this.vel[i + 1];
      const wa = this.invMass[i], wb = this.invMass[i + 1];
      const w = wa + wb;
      if (w === 0) continue;

      let nx = pb.x - pa.x, ny = pb.y - pa.y;
      const d = Math.hypot(nx, ny);
      if (d < 1e-9) continue;
      nx /= d; ny /= d;

      const vrel = (vb.x - va.x) * nx + (vb.y - va.y) * ny;
      const j = -vrel / w;

      vb.x += nx * j * wb; vb.y += ny * j * wb;
      va.x -= nx * j * wa; va.y -= ny * j * wa;
    }
  }

  /** See note 1 in the class comment — this is the line that makes it swim. */
  _applyAnisotropicDrag(i, v, dt) {
    const t = this.tangent(i, this._t);
    const vt = v.x * t.x + v.y * t.y;         // scalar component along the body
    const nx = v.x - vt * t.x;                // remainder is the normal component
    const ny = v.y - vt * t.y;
    const nMag = Math.hypot(nx, ny);

    // Linear term solved exactly; quadratic term solved semi-implicitly, which
    // is unconditionally stable and cannot reverse the velocity however large
    // the timestep or the speed.
    const kt = Math.exp(-this.dragTangent * dt) / (1 + this.dragTangentQuad * Math.abs(vt) * dt);
    const kn = Math.exp(-this.dragNormal * dt) / (1 + this.dragNormalQuad * nMag * dt);

    v.x = vt * t.x * kt + nx * kn;
    v.y = vt * t.y * kt + ny * kn;
  }

  _solveDistance() {
    const L = this.segLen;
    for (let i = 0; i < this.count - 1; i++) {
      const a = this.pos[i], b = this.pos[i + 1];
      const wa = this.invMass[i], wb = this.invMass[i + 1];
      const w = wa + wb;
      if (w === 0) continue;

      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) continue;

      const corr = (d - L) / d / w;
      a.x += dx * corr * wa; a.y += dy * corr * wa;
      b.x -= dx * corr * wb; b.y -= dy * corr * wb;
    }
  }

  /**
   * The body as an elastic beam: a damped angular spring at every interior node
   * pulling its turn angle toward restCurve[i].
   *
   * For the triple (a, b, c) with arms e1 = b - a and e2 = c - b, the turn
   * angle is theta = angle(e2) - angle(e1). Reducing theta means rotating e2
   * clockwise and e1 anticlockwise, which corresponds to moving a and c along
   * the *same* signed perpendicular of their own arm. The reaction is applied
   * to b, so the triple exerts no net force on the chain — it is pure torque,
   * and the creature cannot bootstrap itself across the tank by wiggling.
   *
   *   theta_dot ~ (v_c - v_b).perp(e2)/|e2| - (v_b - v_a).perp(e1)/|e1|
   *   F = -m_eff * L * (omega^2 * theta_err + 2*zeta*omega * theta_dot)
   *
   * The damping term is what makes an explicit integration of a stiff spring
   * behave; without it the beam rings at its own natural frequency and the
   * whole animal buzzes.
   */
  _applyBendForces() {
    const L = this.segLen;

    for (let i = 1; i < this.count - 1; i++) {
      const w = this.bendOmega * this.bendProfile[i];
      const kS = w * w * L;
      const kD = 2 * this.bendDamping * w * L;

      const a = this.pos[i - 1], b = this.pos[i], c = this.pos[i + 1];
      const e1x = b.x - a.x, e1y = b.y - a.y;
      const e2x = c.x - b.x, e2y = c.y - b.y;
      const l1 = Math.hypot(e1x, e1y) || 1e-9;
      const l2 = Math.hypot(e2x, e2y) || 1e-9;

      const theta = wrapAngle(Math.atan2(e2y, e2x) - Math.atan2(e1y, e1x));
      const err = wrapAngle(theta - this.restCurve[i]);

      // Unit perpendiculars of each arm.
      const p1x = -e1y / l1, p1y = e1x / l1;
      const p2x = -e2y / l2, p2y = e2x / l2;

      const va = this.vel[i - 1], vb = this.vel[i], vc = this.vel[i + 1];
      const thetaDot =
        ((vc.x - vb.x) * p2x + (vc.y - vb.y) * p2y) / l2 -
        ((vb.x - va.x) * p1x + (vb.y - va.y) * p1y) / l1;

      // Fold limit as a rapidly stiffening term rather than a hard clamp.
      // Cuticle does not have a hinge stop; it just gets much harder to bend.
      // Keeping it a force also keeps it out of the position solver, where a
      // large angular correction would be the very thing that destabilises the
      // chain.
      let fold = 0;
      const over = Math.abs(theta) - this.maxBend;
      if (over > 0) fold = this.foldStiffness * over * Math.sign(theta);

      const mEff = (this.mass[i - 1] + this.mass[i] + this.mass[i + 1]) / 3;
      const s = -mEff * (kS * (err + fold) + kD * thetaDot);

      const fax = p1x * s, fay = p1y * s;
      const fcx = p2x * s, fcy = p2y * s;

      this.force[i - 1].x += fax; this.force[i - 1].y += fay;
      this.force[i + 1].x += fcx; this.force[i + 1].y += fcy;
      this.force[i].x -= fax + fcx; this.force[i].y -= fay + fcy;
    }
  }

  /**
   * Keep the creature in the tank with a soft repulsion field rather than a
   * clamp. Added as a FORCE, before integration, for the same reason bending is
   * a force: a positional clamp applied after the solver has run compresses the
   * segments against the wall, and the distance constraints then convert that
   * compression into a burst of velocity on the following step. A creature that
   * is gently pushed back also *looks* right — it turns away from the glass
   * rather than sticking to it.
   *
   * The ramp is quadratic in penetration depth, so it is imperceptible at the
   * edge of the margin and firm at the wall.
   */
  containForce(minX, minY, maxX, maxY, margin, strength = 900) {
    for (let i = 0; i < this.count; i++) {
      const p = this.pos[i];
      const m = this.mass[i];
      let fx = 0, fy = 0;
      let d;
      if ((d = (minX + margin) - p.x) > 0) fx += strength * m * (d / margin) ** 2;
      if ((d = p.x - (maxX - margin)) > 0) fx -= strength * m * (d / margin) ** 2;
      if ((d = (minY + margin) - p.y) > 0) fy += strength * m * (d / margin) ** 2;
      if ((d = p.y - (maxY - margin)) > 0) fy -= strength * m * (d / margin) ** 2;
      if (fx || fy) this.addForce(i, fx, fy);
    }
  }

  /**
   * Absolute backstop, far outside the visible area. Should never fire in
   * normal operation; it exists only so that a pathological parameter set
   * cannot send the creature to infinity.
   */
  hardClamp(minX, minY, maxX, maxY) {
    for (let i = 0; i < this.count; i++) {
      const p = this.pos[i];
      p.x = clamp(p.x, minX, maxX);
      p.y = clamp(p.y, minY, maxY);
    }
  }
}

function rotateAbout(p, pivot, a) {
  const s = Math.sin(a), c = Math.cos(a);
  const dx = p.x - pivot.x, dy = p.y - pivot.y;
  p.x = pivot.x + dx * c - dy * s;
  p.y = pivot.y + dx * s + dy * c;
}

/**
 * A short passive appendage (antenna, seta bundle) that hangs off a chain node
 * and simply follows it. Same follow-the-leader idea as Chain but far cheaper,
 * because these only need to *look* passive — nothing depends on their physics.
 */
export class Filament {
  constructor(count, segLen, maxKink = 0.35) {
    this.count = count;
    this.segLen = segLen;
    /** Maximum turn between consecutive segments, radians. Prevents buckling. */
    this.maxKink = maxKink;
    this.pos = Array.from({ length: count }, () => new Vec2());
    this.vel = Array.from({ length: count }, () => new Vec2());
  }

  init(base, dir) {
    const d = dir.clone().normalize();
    for (let i = 0; i < this.count; i++) {
      this.pos[i].set(base.x + d.x * this.segLen * i, base.y + d.y * this.segLen * i);
    }
  }

  /**
   * `bias` is the preferred direction of the rest pose. `omega` is the stiffness
   * of the restoring spring in rad/s and `damping` its decay rate in s^-1.
   *
   * Getting the balance here wrong is instructive: with the spring too weak the
   * filament simply streams backwards in the wake, and both antennae collapse
   * onto the same line behind the head — which looks like a rendering bug even
   * though it is "correct" passive physics. A real antenna is held out by its
   * own cuticle. So it needs enough stiffness to hold the pose, and enough
   * inertia and lag that it still visibly sweeps back when the animal
   * accelerates. That lag is the entire point of drawing them.
   *
   * `curl` rotates the rest direction progressively along the filament so it
   * arcs rather than sticking out as a straight bristle.
   */
  step(base, bias, dt, omega = 18, damping = 10, curl = 0.06) {
    this.pos[0].copyFrom(base);
    const rest = this._d ?? (this._d = new Vec2());
    const k = omega * omega;

    for (let i = 1; i < this.count; i++) {
      const p = this.pos[i], prev = this.pos[i - 1], v = this.vel[i];

      rest.copyFrom(bias).normalize().rotate(curl * i).mult(this.segLen);

      v.x += ((prev.x + rest.x) - p.x) * k * dt;
      v.y += ((prev.y + rest.y) - p.y) * k * dt;
      v.mult(Math.exp(-damping * dt));
      p.addScaled(v, dt);

      // Inextensibility, applied to the outboard node only (follow-the-leader).
      let dx = p.x - prev.x, dy = p.y - prev.y;
      const d = Math.hypot(dx, dy) || 1e-9;
      dx /= d; dy /= d;

      // Kink limit. Follow-the-leader constrains length but nothing else, so a
      // segment can fold back on itself for free — which showed up as one
      // antenna buckling into a hook while its mirror stayed straight. Limiting
      // the turn between consecutive segments keeps the filament a filament.
      if (i > 1) {
        const px = prev.x - this.pos[i - 2].x, py = prev.y - this.pos[i - 2].y;
        const pd = Math.hypot(px, py) || 1e-9;
        const ux = px / pd, uy = py / pd;
        const cos = clamp(ux * dx + uy * dy, -1, 1);
        const turn = Math.acos(cos);
        if (turn > this.maxKink) {
          const sign = Math.sign(ux * dy - uy * dx) || 1;
          const a = Math.atan2(uy, ux) + sign * this.maxKink;
          dx = Math.cos(a); dy = Math.sin(a);
        }
      }

      p.x = prev.x + dx * this.segLen;
      p.y = prev.y + dy * this.segLen;
    }
  }
}

export { rotateAbout };
