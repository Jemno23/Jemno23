import { Vec2 } from '../core/vec2.js';
import { Chain, Filament } from '../core/chain.js';
import { NoiseField } from '../core/noise.js';
import { Morphology } from './morphology.js';
import { MetachronalDrive } from './locomotion.js';
import { Steering } from './steering.js';
import { Arousal } from './arousal.js';

/**
 * SeaMonkey — assembles the systems into one organism.
 *
 * This file deliberately contains almost no mathematics of its own. Its job is
 * wiring and force bookkeeping: run the behaviour systems, let each of them
 * write forces into the spine, integrate once, and expose readable state.
 *
 * The per-step order matters and is worth stating explicitly, because it is the
 * causal chain the whole illusion rests on:
 *
 *   1. arousal   -> how hard am I swimming right now?
 *   2. steering  -> where do I want to point? (reads the body's *actual* heading)
 *   3. drive     -> what are my 11 limb pairs doing this instant?
 *   4. forces    -> thrust at each limb's own node, yaw couple, ambient flow
 *   5. chain     -> integrate, then project constraints
 *   6. filaments -> passive parts follow whatever the body just did
 *
 * Nothing at step 6 can influence step 1. Everything visible is downstream of
 * the physics; nothing is animated back into it.
 */
export class SeaMonkey {
  constructor(config, opts = {}) {
    this.cfg = config;
    const b = config.body;
    const seed = opts.seed ?? 1;

    this.noise = new NoiseField(1000 + seed * 7919);
    this.morph = new Morphology(b.length, b.nodes);

    const segLen = b.length / (b.nodes - 1);
    this.chain = new Chain({
      count: b.nodes,
      segLen,
      dragTangent: b.dragTangent,
      dragNormal: b.dragNormal,
      dragTangentQuad: b.dragTangentQuad,
      dragNormalQuad: b.dragNormalQuad,
      bendOmega: b.bendOmega,
      bendDamping: b.bendDamping,
      maxBend: b.maxBend,
      iterations: b.solverIterations,
      substeps: b.substeps,
      bendProfile: this.morph.bendProfile(b.thoraxStiffness, b.abdomenStiffness),
      massProfile: this.morph.massProfile(b.massHead, b.massTail),
    });

    this.drive = new MetachronalDrive(config.limbs, b.length);
    this.steering = new Steering(config.steering, this.noise, seed);
    this.arousal = new Arousal(config.arousal, config.limbs, this.noise, seed);

    // Passive appendages. They have no say in where the creature goes; they only
    // report on where it has been, which is precisely their value.
    const a = this.morph.antenna;
    this.antennae = [new Filament(a.segments, a.segLen, a.maxKink),
                     new Filament(a.segments, a.segLen, a.maxKink)];

    this.age = 0;
    this.speed = 0;
    this._v = new Vec2();
    this._t = new Vec2();
    this._n = new Vec2();

    /** System toggles, for isolating one behaviour at a time on camera. */
    this.enabled = { wander: true, light: true, edges: true, thrust: true, bend: true };

    const pos = opts.position ?? new Vec2(0, 0);
    const dir = opts.direction ?? new Vec2(-1, 0);
    this.reset(pos, dir);
  }

  reset(pos, dir) {
    // The chain runs head -> tail, so lay it out *opposite* the facing direction.
    this.chain.init(pos, dir.clone().mult(-1));
    const head = this.chain.pos[0];
    const fwd = dir.clone().normalize();
    for (const f of this.antennae) f.init(head, fwd);
    this.age = 0;
  }

  get head() { return this.chain.pos[0]; }
  get tail() { return this.chain.pos[this.chain.count - 1]; }
  heading() { return this.chain.heading(4); }

  /**
   * @param {number} dt   seconds (fixed)
   * @param {object} env  { light, bounds, medium }
   */
  update(dt, env) {
    this.age += dt;
    const cfg = this.cfg;
    const chain = this.chain;

    // 1. AROUSAL — the slow motor drive.
    this.arousal.update(dt, env.light?.speed ?? 0);

    // 2. STEERING — desire, then a commanded heading the body must earn.
    this.steering.update(dt, chain, env, this.arousal.turnGain(), this.enabled);

    // 3. LOCOMOTION — advance the metachronal wave.
    this.drive.update(dt, this.arousal.beatHz(), this.arousal.effort());

    // 4. FORCES.
    if (this.enabled.thrust) this.drive.applyTo(chain);
    if (this.enabled.bend) {
      this.steering.applyTo(chain, this.arousal.turnGain(), this.drive.totalThrust);
    } else {
      chain.restCurve.fill(0);
    }

    // The water. A gliding animal is carried by the local flow and slowly
    // reoriented by the shear across its own length; a swimming one overpowers
    // it. Both the creature and the suspended debris read the same field, so
    // they visibly share a fluid.
    if (env.medium) env.medium.applyTo(chain, cfg.medium.coupling);

    // Tank walls, as a soft field. Steering already turns the animal away well
    // before this fires; this is the backstop for when it is not listening.
    if (env.bounds) {
      const b = env.bounds;
      chain.containForce(b.minX, b.minY, b.maxX, b.maxY, b.margin * 0.8, cfg.world.containStrength);
    }

    // 5. INTEGRATE.
    chain.step(dt);

    if (env.bounds) {
      const b = env.bounds;
      const s = cfg.body.length;
      chain.hardClamp(b.minX - s, b.minY - s, b.maxX + s, b.maxY + s);
    }

    this.speed = chain.centerVelocity(this._v).mag();

    // 6. PASSIVE PARTS — follow, never lead.
    this._stepAntennae(dt);

    return this;
  }

  _stepAntennae(dt) {
    const chain = this.chain;
    const a = this.morph.antenna;
    const base = chain.pos[a.node];
    const t = chain.tangent(a.node, this._t);
    const fwd = this._n.set(-t.x, -t.y);

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      // Rest pose: splayed forward-and-out. The filament's own inertia then
      // sweeps it back when the animal accelerates, which is the tell that the
      // antennae are being dragged through water rather than drawn on.
      const bias = fwd.clone().rotate(sign * a.splay);
      this.antennae[i].step(base, bias, dt, 30, 13, 0);
    }
  }

  /** A hard startle — used by the click interaction and by looming light. */
  startle(strength = 1) { this.arousal.spike(strength); }

  /** Snapshot for the HUD and debug overlay. */
  readout() {
    return {
      speed: this.speed,
      arousal: this.arousal.value,
      startle: this.arousal.startle,
      beatHz: this.drive.freq,
      effort: this.drive.effort ?? 0,
      thrust: this.drive.totalThrust,
      heading: this.heading(),
      desired: this.steering.desired,
      headingError: this.steering.headingError,
      curvature: this.meanCurvature(),
      arcLength: this.chain.arcLength(),
    };
  }

  meanCurvature() {
    let s = 0;
    for (let i = 1; i < this.chain.count - 1; i++) s += this.chain.curvatureAt(i);
    return s / (this.chain.count - 2);
  }
}
