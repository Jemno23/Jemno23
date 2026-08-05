import { Vec2 } from './vec2.js';

/**
 * Medium — the water itself, as a slow divergence-free-ish flow field.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED BUOYANCY
 * ---------------------------------------------------------------------------
 * The first version of this project had the creature sink gently when it
 * stopped beating, and generate lift when it swam. It was a nice idea and it
 * was wrong, for a reason worth recording: this is a *darkfield microscope*
 * view. We are looking down through a water column at a specimen, so gravity
 * points into the screen, not down it. A creature that drifts toward the bottom
 * of the frame is being pulled by a force with no representation in this
 * projection. It also barely worked — the lift term saturated almost
 * immediately, so the whole system contributed nothing but a bug.
 *
 * What a real sample *does* have is bulk motion: convection, the residue of
 * being pipetted, the drift you see in every microscopy clip when the
 * suspended debris all slides the same way for a few seconds. That is a
 * horizontal flow, it is in the image plane, and it is shared by everything in
 * the frame.
 *
 * So: one field, sampled by both the creature and the particles. That sharing
 * is the point. When the motes near the animal drift the same way the animal
 * does, the eye reads "these things are in the same fluid" — which no amount
 * of per-object noise can fake.
 *
 * ---------------------------------------------------------------------------
 * THE MATHEMATICS
 * ---------------------------------------------------------------------------
 * The field is the curl of a scalar Perlin potential:
 *
 *      u = ( dP/dy, -dP/dx )
 *
 * Taking the curl of a potential guarantees div(u) = 0, so the flow neither
 * creates nor destroys fluid: motes swirl and shear but never pile up in a
 * corner or drain out of a region, which is exactly the failure mode of
 * sampling a noise field directly as a velocity.
 */
export class Medium {
  /**
   * @param {NoiseField} noise
   * @param {object} o
   * @param {number} o.scale     spatial frequency of the eddies (1/px)
   * @param {number} o.rate      how fast the field evolves (1/s)
   * @param {number} o.strength  peak flow speed, px/s
   */
  constructor(noise, o = {}) {
    this.noise = noise;
    this.scale = o.scale ?? 0.0016;
    this.rate = o.rate ?? 0.045;
    this.strength = o.strength ?? 26;
    this.t = 0;
    this._u = new Vec2();
  }

  update(dt) { this.t += dt * this.rate; }

  /** Flow velocity at a world position. */
  sample(x, y, out = this._u) {
    const s = this.scale;
    const e = 1.2;   // finite-difference step, in field units
    // Central differences of the potential give the curl.
    const dPdy = this.noise.n2(x * s, y * s + e + this.t) - this.noise.n2(x * s, y * s - e + this.t);
    const dPdx = this.noise.n2(x * s + e, y * s + this.t) - this.noise.n2(x * s - e, y * s + this.t);
    return out.set(dPdy, -dPdx).mult(this.strength);
  }

  /**
   * Viscous coupling of a body to the flow: the water drags whatever is in it
   * toward the local flow velocity. Applied to every node, so a long body
   * straddling two eddies feels a genuine shear and slowly rotates — which is
   * a very cheap source of the small, unwilled reorientations that make a
   * drifting animal look adrift rather than parked.
   */
  applyTo(chain, coupling) {
    const u = this._u;
    for (let i = 0; i < chain.count; i++) {
      const p = chain.pos[i];
      this.sample(p.x, p.y, u);
      const m = chain.mass[i];
      chain.addForce(i, (u.x - chain.vel[i].x) * coupling * m,
                        (u.y - chain.vel[i].y) * coupling * m);
    }
  }
}
