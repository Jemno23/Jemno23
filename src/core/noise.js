/**
 * Perlin gradient noise, 1D and 2D, with a seedable permutation table.
 *
 * WHY THIS EXISTS
 * Random numbers are not a model of animal behaviour. A creature that picks a
 * new random heading each frame jitters; a creature that picks one every second
 * twitches. Neither reads as alive, because real motor output is *continuous* —
 * it has a derivative. Perlin noise gives a signal that is smooth, bounded,
 * band-limited and non-repeating, which is exactly the shape of an animal's
 * slow motor drift. Nearly every "decision" in this simulation is a read from a
 * noise field at a different frequency: heading wander (fast), arousal (slow),
 * beat asymmetry (very slow).
 *
 * We implement it ourselves rather than using p5.noise() so that the behaviour
 * layer has no dependency on the renderer, and so the field is reproducible
 * from a seed.
 */

/** Small deterministic PRNG (mulberry32) — used only to build the permutation table. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 6t^5-15t^4+10t^3 — Perlin's quintic fade. C2 continuous, so the noise has no visible creases. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

export class NoiseField {
  constructor(seed = 1337) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {           // Fisher-Yates
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];

    // 2D gradients on the unit circle, one per permutation value.
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** 1D Perlin in roughly [-1, 1]. */
  n1(x) {
    const xi = Math.floor(x) & 255;
    const xf = x - Math.floor(x);
    const u = fade(xf);
    // 1D gradients are just ±1 scaled — use the x-component of the gradient table.
    const g0 = this.gx[this.perm[xi]];
    const g1 = this.gx[this.perm[xi + 1]];
    return lerp(g0 * xf, g1 * (xf - 1), u) * 2.0;
  }

  /** 2D Perlin in roughly [-1, 1]. */
  n2(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const dot = (hash, dx, dy) => this.gx[hash] * dx + this.gy[hash] * dy;

    const aa = this.perm[this.perm[X] + Y];
    const ab = this.perm[this.perm[X] + Y + 1];
    const ba = this.perm[this.perm[X + 1] + Y];
    const bb = this.perm[this.perm[X + 1] + Y + 1];

    const x1 = lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u);
    const x2 = lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 1.4;
  }

  /**
   * Fractal (fBm) 1D noise: several octaves at doubling frequency and halving
   * amplitude. Gives a signal with structure at multiple timescales, which is
   * what a real motor drift looks like — a slow trend with fine tremor on top.
   */
  fbm1(x, octaves = 3, gain = 0.5, lacunarity = 2.0) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.n1(x * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
