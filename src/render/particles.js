import { Vec2 } from '../core/vec2.js';
import { clamp } from '../core/mathx.js';

/**
 * Suspended debris.
 *
 * Two jobs, both of which turn out to matter more than they look:
 *
 *  1. SCALE AND DEPTH. Motes at different apparent sizes and brightnesses give
 *     the empty black field a z-axis, and tell the eye how big the creature is.
 *     Without them the animal appears to swim in a vacuum at no particular
 *     magnification.
 *
 *  2. THE WAKE. Each mote is advected by the creature's own velocity field, so
 *     the water visibly moves when the animal does. This is the cheapest
 *     available proof that the creature is *interacting with a medium* rather
 *     than sliding over a backdrop — and it comes for free, because the spine
 *     nodes already carry the velocities we need.
 *
 * The velocity field is a crude sum of Gaussian-weighted node velocities:
 *
 *     u(x) = sum_i  v_i * exp(-|x - p_i|^2 / (2*sigma^2)) * z
 *
 * which is not a solution to anything, but has the right qualitative shape: the
 * water is dragged along near the body and undisturbed a body-length away.
 * A real Stokeslet field would be more defensible and about ten times the cost,
 * and at this magnification the difference is not visible.
 */
export class ParticleField {
  constructor(count, noise, bounds) {
    this.noise = noise;
    this.n = count;
    this.pos = Array.from({ length: count }, () => new Vec2());
    this.vel = Array.from({ length: count }, () => new Vec2());
    this.z = new Float32Array(count);          // apparent depth 0.2..1
    this.size = new Float32Array(count);
    this.elong = new Float32Array(count);      // 0 = mote, 1 = fibre
    this.seed = new Float32Array(count);

    this.reseed(bounds);
    this._u = new Vec2();
  }

  reseed(b) {
    for (let i = 0; i < this.n; i++) {
      this.pos[i].set(b.minX + Math.random() * (b.maxX - b.minX),
                      b.minY + Math.random() * (b.maxY - b.minY));
      this.vel[i].zero();
      this.z[i] = 0.2 + Math.random() * 0.8;
      this.size[i] = (0.6 + Math.random() * 2.6) * this.z[i];
      this.elong[i] = Math.random() < 0.22 ? 0.5 + Math.random() * 2.5 : 0;
      this.seed[i] = Math.random() * 1000;
    }
  }

  /**
   * @param {number} dt
   * @param {object} bounds
   * @param {SeaMonkey[]} creatures  advection sources
   * @param {number} advection       gain on the wake term
   * @param {Medium} medium          the shared ambient flow field
   */
  update(dt, bounds, creatures, advection, medium) {
    const sigma = 90;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const flow = this._flow ?? (this._flow = new Vec2());

    for (let i = 0; i < this.n; i++) {
      const p = this.pos[i], v = this.vel[i];

      // Bulk drift: the SAME field the creature is coupled to. Sharing it is
      // what makes the animal and the debris read as being in one fluid rather
      // than two independent screensavers.
      medium.sample(p.x, p.y, flow);
      v.x += (flow.x * this.z[i] - v.x) * 1.1 * dt;
      v.y += (flow.y * this.z[i] - v.y) * 1.1 * dt;

      // Wake advection: sample every third spine node to keep this O(n * 10).
      const u = this._u.zero();
      for (const c of creatures) {
        const ch = c.chain;
        for (let k = 0; k < ch.count; k += 3) {
          const dx = p.x - ch.pos[k].x;
          const dy = p.y - ch.pos[k].y;
          const w = Math.exp(-(dx * dx + dy * dy) * inv2s2);
          if (w > 0.01) u.addScaled(ch.vel[k], w);
        }
      }
      v.addScaled(u, advection * this.z[i] * dt * 8);

      v.mult(Math.exp(-1.6 * dt));           // viscous settling
      p.addScaled(v, dt);

      // Toroidal wrap keeps the field statistically uniform without respawn pops.
      const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
      if (p.x < bounds.minX) p.x += w; else if (p.x > bounds.maxX) p.x -= w;
      if (p.y < bounds.minY) p.y += h; else if (p.y > bounds.maxY) p.y -= h;
    }
  }

  draw(p) {
    p.blendMode(p.ADD);
    p.noStroke();
    for (let i = 0; i < this.n; i++) {
      const z = this.z[i];
      const a = clamp(18 + z * 130, 0, 255);
      p.fill(198, 214, 232, a);
      const q = this.pos[i];
      if (this.elong[i] > 0) {
        // Fibres orient along their own drift, like real suspended detritus.
        const ang = this.vel[i].magSq() > 1 ? this.vel[i].heading() : this.seed[i];
        p.push();
        p.translate(q.x, q.y);
        p.rotate(ang);
        p.ellipse(0, 0, this.size[i] * (1 + this.elong[i]), this.size[i] * 0.55);
        p.pop();
      } else {
        p.circle(q.x, q.y, this.size[i]);
      }
    }
  }
}
