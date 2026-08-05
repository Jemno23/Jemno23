/**
 * Vec2 — minimal 2D vector.
 *
 * Deliberately independent of p5. The whole point of this project is that the
 * behaviour is mathematics, and the renderer is a separate concern that merely
 * *reports* on that mathematics. Nothing in core/ or creature/ may import p5.
 *
 * Mutating methods (add, mult, ...) return `this` so they chain without
 * allocating. Allocation matters here: the spine solver runs a few thousand
 * vector ops per frame.
 */
export class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static of(x, y) { return new Vec2(x, y); }

  /** Unit vector at `a` radians. Angles are measured from +x, y-down (screen space). */
  static fromAngle(a, len = 1) { return new Vec2(Math.cos(a) * len, Math.sin(a) * len); }

  static sub(a, b) { return new Vec2(a.x - b.x, a.y - b.y); }
  static add(a, b) { return new Vec2(a.x + b.x, a.y + b.y); }
  static dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  static dot(a, b) { return a.x * b.x + a.y * b.y; }
  /** 2D "cross product" — the z of the 3D cross. Sign tells you which way to turn. */
  static cross(a, b) { return a.x * b.y - a.y * b.x; }

  static lerp(a, b, t) { return new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }

  clone() { return new Vec2(this.x, this.y); }
  set(x, y) { this.x = x; this.y = y; return this; }
  copyFrom(v) { this.x = v.x; this.y = v.y; return this; }
  zero() { this.x = 0; this.y = 0; return this; }

  add(v) { this.x += v.x; this.y += v.y; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  mult(s) { this.x *= s; this.y *= s; return this; }
  div(s) { this.x /= s; this.y /= s; return this; }

  /** this += v * s — the workhorse of every integrator below. */
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; return this; }

  mag() { return Math.hypot(this.x, this.y); }
  magSq() { return this.x * this.x + this.y * this.y; }

  normalize() {
    const m = this.mag();
    if (m > 1e-9) { this.x /= m; this.y /= m; }
    return this;
  }

  setMag(m) { return this.normalize().mult(m); }

  limit(max) {
    const m2 = this.magSq();
    if (m2 > max * max && m2 > 1e-18) this.mult(max / Math.sqrt(m2));
    return this;
  }

  heading() { return Math.atan2(this.y, this.x); }

  rotate(a) {
    const c = Math.cos(a), s = Math.sin(a);
    const x = this.x * c - this.y * s;
    this.y = this.x * s + this.y * c;
    this.x = x;
    return this;
  }

  /** Left-hand normal (rotate +90°). Used for the body's lateral axis. */
  perp() { return new Vec2(-this.y, this.x); }
}
