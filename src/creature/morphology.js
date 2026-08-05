import { clamp, lerp, smoothstep } from '../core/mathx.js';

/**
 * Morphology — the creature's *shape*, kept strictly separate from its physics
 * and its drawing.
 *
 * The spine knows nothing about what it looks like: it is 28 points on a
 * constrained chain. This module is the only place that says "node 6 is inside
 * the thorax and the body is 0.055 L wide there". Everything downstream — the
 * outline, the limb anchors, the gut, the eyes — reads from here.
 *
 * That separation is what makes the framework reusable. A different organism
 * needs a different Morphology and a different renderer; the chain, the
 * metachronal drive and the steering are unchanged.
 *
 * The proportions are measured off the reference darkfield photograph:
 *   head + cephalic lobes  0.00 - 0.17 L
 *   thorax, 11 limb pairs  0.17 - 0.52 L
 *   abdomen (naked)        0.52 - 0.95 L
 *   furca / cercopods      0.95 - 1.00 L
 */

/**
 * Half-width profile as a fraction of body length, keyed by arc position s.
 * Piecewise-smooth: an eased interpolation through measured control points.
 * Smoothstep rather than linear between points, so the silhouette has no
 * corners — a corner in the outline is read instantly as "polygon".
 */
const WIDTH_POINTS = [
  [0.000, 0.011],   // rostrum — blunt, not a needle
  [0.025, 0.038],
  [0.060, 0.052],   // widest part of the cephalic shield
  [0.115, 0.048],
  [0.165, 0.041],   // neck
  [0.235, 0.048],   // thoracic shoulder
  [0.370, 0.045],
  [0.480, 0.037],
  [0.560, 0.027],   // thorax / abdomen junction
  [0.680, 0.020],
  [0.820, 0.014],
  [0.930, 0.010],
  [0.975, 0.014],   // slight flare before the furca
  [1.000, 0.006],
];

export class Morphology {
  constructor(bodyLength, nodeCount) {
    this.L = bodyLength;
    this.n = nodeCount;

    /** Arc position s in [0,1] for each spine node. */
    this.s = new Float32Array(nodeCount);
    /** Half-width in px for each spine node. */
    this.halfWidth = new Float32Array(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      const s = i / (nodeCount - 1);
      this.s[i] = s;
      this.halfWidth[i] = this.widthAt(s) * bodyLength;
    }

    // Landmarks, in node indices.
    this.headNode = 0;
    this.thoraxStart = 5;
    this.thoraxEnd = 15;
    this.abdomenStart = 16;
    this.furcaNode = nodeCount - 1;

    /**
     * Cephalic lobes: the two large translucent paddles flanking the head — the
     * most visually prominent feature of the head in the reference photograph,
     * and the thing that stops the animal reading as a worm with eyes.
     */
    this.lobe = {
      node: 3,
      length: bodyLength * 0.150,
      width: bodyLength * 0.098,
      angle: 0.34,       // rad, splay from the body axis
    };

    this.eye = {
      node: 3,
      medianNode: 2,
      offset: bodyLength * 0.042,   // lateral offset of the eye stalk
      radius: bodyLength * 0.0140,
      stalk: bodyLength * 0.013,
    };

    this.antenna = {
      node: 1,
      segments: 11,
      segLen: bodyLength * 0.017,
      splay: 0.95,       // rad from the forward axis
    };

    this.furca = {
      rami: 2,
      setaeCount: 9,
      length: bodyLength * 0.045,
      splay: 0.40,
    };

    /** The gut: the warm ochre stripe running the length of the animal. */
    this.gut = { from: 0.050, to: 0.950, halfWidth: bodyLength * 0.0035 };
  }

  /** Eased interpolation through the measured half-width table. */
  widthAt(s) {
    s = clamp(s, 0, 1);
    const P = WIDTH_POINTS;
    for (let i = 1; i < P.length; i++) {
      if (s <= P[i][0]) {
        const t = smoothstep(P[i - 1][0], P[i][0], s);
        return lerp(P[i - 1][1], P[i][1], t);
      }
    }
    return P[P.length - 1][1];
  }

  /**
   * Per-node bending stiffness multiplier.
   *
   * The thorax is a segmented box carrying the reaction of eleven pairs of
   * beating limbs; it is in compression whenever the animal swims, and a
   * uniformly flexible body simply buckles under that load — the simulation
   * folds into an S-kink at the shoulder and tears itself apart. The abdomen
   * carries no thrust at all and must stay soft, because its passive trailing
   * whip is the most recognisable thing about how Artemia moves.
   *
   * So: stiff forward, soft aft, with a smooth transition rather than a step
   * (a stiffness discontinuity shows up as a visible hinge).
   */
  bendProfile(thoraxScale = 2.2, abdomenScale = 0.5) {
    const b = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const t = smoothstep(this.s[this.thoraxEnd], this.s[this.abdomenStart + 5], this.s[i]);
      b[i] = lerp(thoraxScale, abdomenScale, t);
    }
    return b;
  }

  /**
   * Per-node mass profile: heavy anterior (head, gut, thorax musculature),
   * light trailing abdomen. The ratio is what makes the abdomen behave as a
   * whip that lags and overshoots rather than as a rigid rudder — arguably the
   * most recognisable single feature of Artemia motion.
   */
  massProfile(massHead, massTail) {
    const m = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      // Follow the width profile: mass tracks cross-sectional area.
      const w = this.halfWidth[i] / (this.L * 0.048);
      m[i] = lerp(massTail, massHead, clamp(w * w, 0, 1));
    }
    return m;
  }
}
