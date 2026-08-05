import { Vec2 } from '../core/vec2.js';
import { AngleSpring, angleDelta, clamp, smoothstep } from '../core/mathx.js';

/**
 * Steering — decides where the creature *wants* to point, and then makes the
 * body physically get there.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISION THAT MATTERS
 * ---------------------------------------------------------------------------
 * The controller never touches velocity or position. It produces one number —
 * a desired heading — and every actual change in direction has to be earned by
 * forces acting on the spine. This costs some tracking accuracy, and buys the
 * two things that make turns read as animal rather than vehicular:
 *
 *   - The creature *overshoots and settles*, because it has rotational inertia.
 *   - The abdomen swings wide through the turn, because it is only connected to
 *     the thorax by constraints and has to catch up.
 *
 * ---------------------------------------------------------------------------
 * DESIRE: three influences, blended as vectors
 * ---------------------------------------------------------------------------
 *  WANDER      A Perlin walk, not a random one. The distinction is the whole
 *              trick: rand() gives jitter, and re-rolling every N seconds gives
 *              twitch. Perlin gives a heading that drifts with a continuous
 *              derivative, so the path curves the way a searching animal's does.
 *
 *  PHOTOTAXIS  Artemia are strongly positively phototactic. Modelled as a pull
 *              toward the light with a smoothstep falloff, and — importantly —
 *              a *comfort radius* inside which the pull switches off. Without
 *              it the creature parks on the cursor and looks magnetic. With it,
 *              it arrives, overshoots, mills around and drifts off, which is
 *              what the animals actually do.
 *
 *  EDGES       A soft repulsion that ramps up inside a margin. Turning away
 *              before the wall is reached is what a creature does; bouncing off
 *              it is what a ball does.
 *
 * ---------------------------------------------------------------------------
 * EXECUTION: two actuators, because one is not enough
 * ---------------------------------------------------------------------------
 *  YAW COUPLE      Equal and opposite lateral forces at the head and at a
 *                  posterior node. A force couple produces rotation with no net
 *                  translation, which is the correct model for turning by
 *                  beating the limbs harder on one side. Applying a single
 *                  sideways force at the head instead would make the animal
 *                  crab sideways, which looks immediately wrong.
 *
 *  ACTIVE BEND     The heading error is also written into the spine's rest
 *                  curvature over the anterior nodes, so the animal bends into
 *                  the turn like a muscle contracting on one side. Combined
 *                  with the anisotropic drag in Chain, the curved body then
 *                  redirects its own thrust — the turn becomes partly
 *                  self-sustaining, exactly as in the animal.
 */
export class Steering {
  constructor(cfg, noise, seed = 0) {
    this.cfg = cfg;
    this.noise = noise;
    this.seed = seed * 37.3 + 11.1;

    this.t = 0;
    this.wanderAngle = 0;
    this.desired = 0;
    this.headingError = 0;

    /** Turn controller. Critically damped: accelerates in, eases out, no ringing. */
    this.turnSpring = new AngleSpring(0, cfg.turnOmega);

    // Exposed for the debug overlay.
    this.dirWander = new Vec2(1, 0);
    this.dirLight = new Vec2();
    this.dirEdge = new Vec2();
    this.dirDesired = new Vec2(1, 0);
    this.lightWeight = 0;
    this.edgeWeight = 0;

    this._acc = new Vec2();
    this._tmp = new Vec2();
    this._n0 = new Vec2();
    this._n1 = new Vec2();
    this._n2 = new Vec2();
  }

  /**
   * @param {number} dt
   * @param {Chain}  chain
   * @param {object} env    { light: {pos, active}, bounds: {minX,minY,maxX,maxY} }
   * @param {number} turnGain  scale from arousal
   * @param {object} enabled   per-influence toggles for the teaching overlay
   */
  update(dt, chain, env, turnGain = 1, enabled = {}) {
    const c = this.cfg;
    this.t += dt;

    const heading = chain.heading(4);
    const head = chain.pos[0];

    // ---- WANDER ---------------------------------------------------------
    // Perlin walk on the heading offset, then smoothed once more so that even
    // the noise's own octaves cannot introduce a visible kink.
    const target = this.noise.fbm1(this.t * c.wanderRate + this.seed, 3) * c.wanderAmplitude;
    const k = Math.pow(0.5, dt / c.wanderHalfLife);
    this.wanderAngle = target + (this.wanderAngle - target) * k;
    const wanderHeading = heading + this.wanderAngle;
    this.dirWander.set(Math.cos(wanderHeading), Math.sin(wanderHeading));

    const acc = this._acc.zero();
    if (enabled.wander !== false) acc.addScaled(this.dirWander, 1);

    // ---- PHOTOTAXIS -----------------------------------------------------
    this.lightWeight = 0;
    this.dirLight.zero();
    if (env.light && env.light.active && enabled.light !== false) {
      const to = this._tmp.set(env.light.pos.x - head.x, env.light.pos.y - head.y);
      const d = to.mag();
      if (d > 1e-3) {
        this.dirLight.copyFrom(to).div(d);
        // Falls off with distance, and switches OFF inside the comfort radius so
        // the creature does not dock onto the cursor.
        const far = 1 - smoothstep(c.phototaxisRange * 0.4, c.phototaxisRange, d);
        const near = smoothstep(c.phototaxisComfort * 0.6, c.phototaxisComfort * 1.6, d);
        this.lightWeight = c.phototaxisWeight * far * near;
        acc.addScaled(this.dirLight, this.lightWeight);
      }
    }

    // ---- EDGE AVOIDANCE -------------------------------------------------
    this.dirEdge.zero();
    this.edgeWeight = 0;
    if (env.bounds && enabled.edges !== false) {
      const b = env.bounds;
      const m = b.margin;
      let ex = 0, ey = 0;
      if (head.x < b.minX + m) ex += 1 - (head.x - b.minX) / m;
      if (head.x > b.maxX - m) ex -= 1 - (b.maxX - head.x) / m;
      if (head.y < b.minY + m) ey += 1 - (head.y - b.minY) / m;
      if (head.y > b.maxY - m) ey -= 1 - (b.maxY - head.y) / m;
      if (ex || ey) {
        this.dirEdge.set(ex, ey);
        this.edgeWeight = clamp(this.dirEdge.mag(), 0, 1) * c.edgeWeight;
        this.dirEdge.normalize();
        acc.addScaled(this.dirEdge, this.edgeWeight);
      }
    }

    if (acc.magSq() < 1e-8) acc.set(Math.cos(heading), Math.sin(heading));
    this.dirDesired.copyFrom(acc).normalize();
    this.desired = this.dirDesired.heading();

    // ---- TRACKING -------------------------------------------------------
    // The spring holds the *commanded* heading; it lags the desire, then the
    // body lags the command. Two stages of lag is what gives the motion weight.
    this.turnSpring.omega = c.turnOmega * turnGain;
    const commanded = this.turnSpring.step(this.desired, dt);

    this.headingError = clamp(
      angleDelta(heading, commanded),
      -c.maxTurnRate, c.maxTurnRate
    );

    return this.headingError;
  }

  /**
   * Write the two actuators into the spine.
   *
   * @param {number} totalThrust  the drive's current total thrust — the couple
   *   is expressed as a FRACTION of it, not as an absolute force.
   *
   * That scaling was a correction, and an important one. With the couple as a
   * fixed force it was measurably inert: sweeping it from 0 to 120 changed the
   * turn rate by 0.5%, because a hundred-odd units of lateral force is nothing
   * against tens of thousands of units of thrust, and anisotropic drag resists
   * sideways motion anyway. Making it proportional to thrust also makes it
   * behave correctly without any extra machinery: the couple *is* differential
   * limb beating, so an animal that is barely beating cannot turn sharply, and
   * one in an escape burst can spin on the spot.
   */
  applyTo(chain, turnGain = 1, totalThrust = 0) {
    const c = this.cfg;
    const err = this.headingError;
    /** Heading error normalised to [-1, 1] by the turn-rate ceiling. */
    const drive = clamp(err / c.maxTurnRate, -1, 1);

    // SIGN CONVENTION. Chain tangents point head -> tail, so forward = -tangent
    // and chain.normal() = perp(tangent) = -perp(forward). A positive heading
    // error therefore needs a force along -normal at the head. Both actuators
    // below carry that minus sign for the same reason.
    const n = chain.count;
    const rearA = Math.min(n - 1, Math.round(n * 0.45));
    const rearB = Math.min(n - 1, Math.round(n * 0.60));

    // -- Yaw couple: +F at the head, -F split over two posterior nodes. Equal
    //    and opposite, so it is pure torque: the creature pivots without being
    //    shoved sideways.
    const f = -drive * c.yawThrustFraction * turnGain * Math.abs(totalThrust);

    const n0 = chain.normal(0, this._n0);
    chain.addForce(0, n0.x * f, n0.y * f);

    const n1 = chain.normal(rearA, this._n1);
    chain.addForce(rearA, -n1.x * f * 0.5, -n1.y * f * 0.5);

    const n2 = chain.normal(rearB, this._n2);
    chain.addForce(rearB, -n2.x * f * 0.5, -n2.y * f * 0.5);

    // -- Active bend: bias the rest curvature of the anterior spine so the body
    //    arcs into the turn, concave side inward. Tapered to zero along the body
    //    so the result is a smooth arc rather than a hinge.
    const span = Math.min(c.curveNodes, n - 2);
    const perNode = -drive * c.bodyCurveGain * chain.maxBend;
    for (let i = 1; i < n - 1; i++) {
      const taper = i <= span ? 1 - smoothstep(0, span, i) : 0;
      chain.restCurve[i] = perNode * taper;
    }
  }
}
