import { Vec2 } from '../core/vec2.js';
import { TAU, lerp, clamp, smoothstep } from '../core/mathx.js';

/**
 * MetachronalDrive — the swimming engine.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS OBSERVED
 * ---------------------------------------------------------------------------
 * A brine shrimp does not flap. Its 11 pairs of leaf-shaped legs beat in a
 * travelling wave, each pair slightly out of phase with the one in front, so
 * that a ripple runs continuously along the body. The animal glides at an
 * almost constant speed with no visible lunge, even though every individual leg
 * is producing a violently intermittent force.
 *
 * ---------------------------------------------------------------------------
 * THE HYPOTHESIS
 * ---------------------------------------------------------------------------
 * That smoothness is not incidental — it is the *reason* for metachrony. If N
 * paddles each produce a pulse of thrust and their phases are spread evenly
 * around the cycle, the sum of the pulses is very nearly constant: the ripple
 * is a mechanism for turning a jerky force into a steady one. So the model
 * should not be "apply a forward force"; it should be "sum 11 phase-shifted
 * paddle forces" and let the smoothness emerge. If it emerges, the hypothesis
 * is supported and the residual ripple in the speed trace should sit at
 * N * beatFrequency, not at beatFrequency. It does, and it does.
 *
 * ---------------------------------------------------------------------------
 * THE MATHEMATICS
 * ---------------------------------------------------------------------------
 * Phase of limb pair i:                phi_i = 2*pi*f*t - i*dPhi
 * Stroke asymmetry (phase warp):       psi_i = phi_i + k*sin(phi_i)
 * Limb angle about its hinge:          theta_i = A*sin(psi_i)
 * Angular velocity:                    theta'_i = A*cos(psi_i) * omega*(1 + k*cos(phi_i))
 * Blade area (feathered on recovery):  S_i = theta'_i > 0 ? 1 : featherFactor
 * Thrust, quadratic paddle drag:       F_i = c * S_i * (r_i * theta'_i) * |r_i * theta'_i|
 *
 * Two details do a lot of work:
 *
 *  - The PHASE WARP. A pure sine sweeps out and back at the same speed, so a
 *    paddle of fixed area nets zero thrust. Real limbs snap back fast and
 *    recover slowly. Warping the phase with psi = phi + k*sin(phi) (the same
 *    trick as the Kepler equation) skews the sinusoid in time without adding
 *    any harmonic ugliness, and costs one sine.
 *
 *  - FEATHERING. The limb spreads its setae on the power stroke and folds them
 *    on the recovery, so blade area is phase-dependent. This is where the net
 *    thrust actually comes from; asymmetric *speed* alone is not enough,
 *    because drag is quadratic and would cancel.
 *
 * Thrust is applied AT EACH LIMB'S OWN ATTACHMENT NODE, along that node's local
 * body axis. Not at the centre of mass. This is the second decision that makes
 * the creature look real: force applied to the middle of a flexible body with a
 * heavy head and a light trailing abdomen makes the body bow under load, and
 * makes a curved body swim a curved path, for free.
 */
/**
 * Normalised load-sharing kernel for a limb's thrust (Gaussian, sigma ~2 nodes).
 * Wide, because the thorax is a stiff box: a limb's force is reacted by the
 * whole segment block it is attached to, not by one point on a flexible rod.
 */
const LOAD_KERNEL = (() => {
  const sigma = 2.0, half = 4;
  const k = [];
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(w);
    sum += w;
  }
  return k.map((w) => w / sum);
})();

export class MetachronalDrive {
  constructor(cfg, bodyLength) {
    this.cfg = cfg;
    this.bodyLength = bodyLength;

    this.n = cfg.count;
    this.dPhi = TAU / cfg.limbsPerWave;

    this.phase = 0;          // master phase, radians
    this.freq = cfg.beatHzRest;

    /** Which spine node each limb pair hangs from. */
    this.nodeOf = new Int32Array(this.n);
    /** Limb length, tapered: the middle pairs are the longest, as in the animal. */
    this.lengthOf = new Float32Array(this.n);

    for (let i = 0; i < this.n; i++) {
      const t = this.n === 1 ? 0.5 : i / (this.n - 1);
      this.nodeOf[i] = Math.round(lerp(cfg.firstNode, cfg.lastNode, t));
      const taper = 0.55 + 0.45 * Math.sin(Math.PI * (i + 0.5) / this.n);
      this.lengthOf[i] = bodyLength * cfg.lengthFrac * taper;
    }

    // Per-limb state, exposed so the renderer and the debug overlay can read the
    // *same* numbers the physics used. The picture must never disagree with the
    // simulation; that mismatch is instantly legible as fakeness.
    this.angle = new Float32Array(this.n);
    this.angVel = new Float32Array(this.n);
    this.area = new Float32Array(this.n);
    this.thrust = new Float32Array(this.n);

    this.totalThrust = 0;
    this._t = new Vec2();
  }

  /**
   * @param {number} dt
   * @param {number} beatHz     commanded beat frequency (from arousal)
   * @param {number} effort     0..1 stroke amplitude scale (from arousal)
   */
  update(dt, beatHz, effort) {
    const c = this.cfg;
    this.freq = beatHz;
    this.effort = effort;

    const omega = TAU * beatHz;
    this.phase = (this.phase + omega * dt) % TAU;

    const A = c.sweepAmplitude * effort;
    const k = c.strokeAsymmetry;
    /** Angular-velocity width of the setal opening/closing transition. */
    const vSwitch = Math.max(1e-3, A * omega * c.featherTransition);

    let total = 0;
    for (let i = 0; i < this.n; i++) {
      const phi = this.phase - i * this.dPhi;
      const psi = phi + k * Math.sin(phi);

      this.angle[i] = c.sweepBias + A * Math.sin(psi);
      // d(psi)/dt = omega * (1 + k*cos(phi)), so by the chain rule:
      this.angVel[i] = A * Math.cos(psi) * omega * (1 + k * Math.cos(phi));

      // Positive angular velocity = sweeping posteriorly = the power stroke.
      // The setae open and close over a finite part of the cycle rather than
      // switching instantaneously, so blade area is a smooth function of
      // angular velocity. A hard switch puts a step discontinuity into the
      // force at every stroke reversal, which is both unphysical and unkind to
      // the integrator.
      const sw = smoothstep(-vSwitch, vSwitch, this.angVel[i]);
      this.area[i] = c.featherFactor + (1 - c.featherFactor) * sw;

      const bladeSpeed = this.lengthOf[i] * 0.6 * this.angVel[i];  // speed at the centre of pressure
      this.thrust[i] = c.thrustGain * this.area[i] * bladeSpeed * Math.abs(bladeSpeed);
      total += this.thrust[i];
    }
    this.totalThrust = total;
  }

  /**
   * Push each limb's thrust into the spine near its own attachment node,
   * directed along that node's local body axis (anteriorly = -tangent).
   *
   * The load is spread over a small kernel of nodes rather than dumped on one.
   * Two reasons, and both matter:
   *
   *  - Physically, a limb does not pull on a point. The force enters through a
   *    joint and is carried by the surrounding cuticle and muscle, so the
   *    neighbouring segments share it.
   *  - Numerically, a single node cannot absorb the peak. Blade speed at the
   *    centre of pressure runs to well over a thousand px/s, and with a
   *    quadratic drag law the instantaneous force is large enough that
   *    concentrating it on one node out-runs the distance solver and visibly
   *    stretches the body. Spreading it keeps the segment lengths honest.
   */
  applyTo(chain) {
    const K = LOAD_KERNEL;
    const half = (K.length - 1) / 2;
    for (let i = 0; i < this.n; i++) {
      const node = this.nodeOf[i];
      const f = this.thrust[i];
      for (let k = 0; k < K.length; k++) {
        const j = node + k - half;
        if (j < 0 || j >= chain.count) continue;
        const t = chain.tangent(j, this._t);
        const w = K[k] * f;
        chain.addForce(j, -t.x * w, -t.y * w);
      }
    }
  }

  /** Fraction of the stroke cycle limb i is through, 0..1 — for the debug phase wheel. */
  phaseOf(i) {
    let p = (this.phase - i * this.dPhi) % TAU;
    if (p < 0) p += TAU;
    return p / TAU;
  }

  /**
   * Normalised blade "spread" 0..1 for rendering: the setae fan out on the power
   * stroke and fold on the recovery. Derived from the same `area` the physics
   * used, so what you see is what was integrated.
   */
  spreadOf(i) {
    return clamp((this.area[i] - this.cfg.featherFactor) / (1 - this.cfg.featherFactor), 0, 1);
  }
}
