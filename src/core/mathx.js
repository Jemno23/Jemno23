/**
 * Scalar helpers: interpolation, easing, angle arithmetic, damped springs.
 *
 * The two that matter most for the illusion of life:
 *
 *  - expSmooth()   — framerate-independent exponential smoothing. Used wherever
 *                    a quantity must *approach* a target rather than jump to it.
 *                    Almost every discontinuity that reads as "computery" can be
 *                    fixed by routing the value through here.
 *
 *  - Spring        — a critically damped second-order system. Unlike exponential
 *                    smoothing it has momentum, so it accelerates *into* a change
 *                    and decelerates out of it. Animals do this; low-pass filters
 *                    do not. Used for turn rate, so turns bank rather than snap.
 */

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function map(v, a, b, c, d) { return c + ((v - a) / (b - a)) * (d - c); }

/** Hermite smoothstep — zero derivative at both ends, so blends have no corners. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle into (-PI, PI]. Every angular difference must go through this. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed rotation from angle `a` to angle `b`. */
export function angleDelta(a, b) { return wrapAngle(b - a); }

/** Interpolate between angles along the short arc. */
export function lerpAngle(a, b, t) { return a + angleDelta(a, b) * t; }

/**
 * Framerate-independent exponential approach.
 * `halfLife` is the time in seconds for the gap to close by half — a physical
 * quantity you can reason about, unlike a raw per-frame lerp factor.
 */
export function expSmooth(current, target, halfLife, dt) {
  if (halfLife <= 0) return target;
  const k = Math.pow(0.5, dt / halfLife);
  return target + (current - target) * k;
}

/** Same, for angles (takes the short way round). */
export function expSmoothAngle(current, target, halfLife, dt) {
  const d = angleDelta(current, target);
  const k = halfLife <= 0 ? 0 : Math.pow(0.5, dt / halfLife);
  return current + d * (1 - k);
}

/**
 * Critically damped spring: x'' = -2*omega*x' - omega^2*(x - target).
 * Critical damping is the fastest approach with no overshoot, which is what a
 * controlled muscle does. `omega` is the natural frequency in rad/s.
 */
export class Spring {
  constructor(value = 0, omega = 8) {
    this.value = value;
    this.vel = 0;
    this.omega = omega;
  }
  step(target, dt) {
    const w = this.omega;
    // Implicit (backward Euler) solve of the critically damped system. Solving
    // implicitly rather than explicitly is what makes this unconditionally
    // stable: an explicit step with w*dt near 1 diverges.
    const f = 1 + 2 * dt * w;
    const oo = w * w;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * this.value + dt * this.vel + hhoo * target;
    const detV = this.vel + hoo * (target - this.value);
    this.value = detX * detInv;
    this.vel = detV * detInv;
    return this.value;
  }
}

/**
 * Angular version. The spring runs on an *unwrapped* internal angle so it keeps
 * its velocity state across frames; only the target is unwrapped to the nearest
 * equivalent angle, so the spring never takes the long way round the circle.
 */
export class AngleSpring {
  constructor(value = 0, omega = 8) { this.s = new Spring(value, omega); }
  set omega(w) { this.s.omega = w; }
  get omega() { return this.s.omega; }
  get vel() { return this.s.vel; }
  /** Current angle, wrapped to (-PI, PI]. */
  get value() { return wrapAngle(this.s.value); }
  step(target, dt) {
    const unwrapped = this.s.value + angleDelta(this.s.value, target);
    this.s.step(unwrapped, dt);
    return this.value;
  }
}
