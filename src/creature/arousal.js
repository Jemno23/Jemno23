import { clamp, lerp, smoothstep, expSmooth } from '../core/mathx.js';

/**
 * Arousal — one scalar in [0,1] standing in for the animal's motor drive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Of everything in this project, this is the system whose *absence* is most
 * obvious. A creature swimming with a constant beat frequency reads as a toy
 * within about two seconds, no matter how good the body physics are, because
 * nothing alive holds a rhythm that steadily. Real Artemia alternate without
 * any obvious pattern between:
 *
 *   - a near-glide, limbs barely ticking over, slowly sinking and rotating
 *   - a steady cruise
 *   - short bursts, usually after being disturbed
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 * A single very-low-frequency fBm noise walk supplies the spontaneous mood; a
 * separate exponentially-decaying "startle" channel supplies the reactive one,
 * and the two are combined with a saturating max rather than a sum so that a
 * startle always reads clearly regardless of the current mood.
 *
 *   spontaneous = baseline + range * fbm(t * noiseRate)
 *   startle    *= 0.5^(dt / halfLife)
 *   arousal     = clamp(max(spontaneous, startle), 0, 1)
 *
 * Beat frequency is then a piecewise map through rest -> cruise -> burst, and
 * stroke effort a smoothstep on top, so low arousal both slows the beat *and*
 * shortens it — the animal idles rather than merely swimming slowly.
 *
 * Note the asymmetric time constants: arousal rises fast and falls slowly. An
 * animal commits to fleeing instantly and calms down over seconds; the reverse
 * looks broken.
 */
export class Arousal {
  constructor(cfg, limbCfg, noise, seed = 0) {
    this.cfg = cfg;
    this.limbCfg = limbCfg;
    this.noise = noise;
    this.seed = seed * 91.7;

    this.t = 0;
    this.value = cfg.baseline;
    this.startle = 0;
    this.spontaneous = cfg.baseline;
  }

  /** Trigger a startle. `strength` 0..1. */
  spike(strength = 1) {
    this.startle = clamp(Math.max(this.startle, strength * this.cfg.startleGain), 0, 1.2);
  }

  update(dt, lightSpeed = 0) {
    const c = this.cfg;
    this.t += dt;

    // Spontaneous drive: slow fBm mapped into [baseline - range/2, baseline + range/2].
    const n = this.noise.fbm1(this.t * c.noiseRate + this.seed, 3);
    this.spontaneous = clamp(c.baseline + n * c.range, 0, 1);

    // A light that jerks across the tank is a looming stimulus.
    if (lightSpeed > c.startleLightSpeed) {
      this.spike(smoothstep(c.startleLightSpeed, c.startleLightSpeed * 3, lightSpeed));
    }

    this.startle *= Math.pow(0.5, dt / c.startleHalfLife);

    const target = clamp(Math.max(this.spontaneous, this.startle), 0, 1);
    // Rise fast (0.06 s), fall slow (0.9 s).
    const halfLife = target > this.value ? 0.06 : 0.9;
    this.value = expSmooth(this.value, target, halfLife, dt);
    return this.value;
  }

  /** Commanded beat frequency, Hz. Piecewise so "burst" is a distinct gear. */
  beatHz() {
    const l = this.limbCfg;
    const a = this.value;
    return a < 0.6
      ? lerp(l.beatHzRest, l.beatHzCruise, smoothstep(0, 0.6, a))
      : lerp(l.beatHzCruise, l.beatHzBurst, smoothstep(0.6, 1, a));
  }

  /** Stroke amplitude scale. Never quite zero — the limbs always tick over. */
  effort() { return lerp(0.42, 1.0, smoothstep(0.05, 0.85, this.value)); }

  /** Willingness to turn sharply. A startled animal turns hard; a drifting one does not. */
  turnGain() { return lerp(0.55, 1.35, this.value); }
}
