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
 * The proportions below are not eyeballed. The reference darkfield photograph
 * was measured column by column — for each x, the longest contiguous run of
 * pixels above a brightness threshold — which separates the dense trunk from
 * the translucent limbs and gives a real half-width profile to fit:
 *
 *   head + cephalic lobes  0.00 - 0.22 L
 *   thorax, 11 limb pairs  0.26 - 0.68 L
 *   abdomen (naked)        0.68 - 0.97 L
 *   furca / cercopods      0.97 - 1.00 L
 *
 * That exercise corrected two errors that had been invisible by eye. The
 * abdomen was drawn at roughly half its true width — the real one is a
 * substantial, almost parallel-sided tube holding ~0.030 L half-width from
 * s = 0.75 to s = 0.87, not the thread it had been. And the limb field sat
 * about 6 % of body length too far forward.
 */

/**
 * Half-width profile as a fraction of body length, keyed by arc position s.
 * Piecewise-smooth: an eased interpolation through measured control points.
 * Smoothstep rather than linear between points, so the silhouette has no
 * corners — a corner in the outline is read instantly as "polygon".
 */
const WIDTH_POINTS = [
  [0.000, 0.008],   // rostrum — blunt, not a needle
  [0.030, 0.035],
  [0.070, 0.048],   // cephalic shield
  [0.130, 0.050],
  [0.200, 0.040],   // neck
  [0.260, 0.045],   // thoracic shoulder — first limb pair
  [0.400, 0.053],
  [0.500, 0.055],   // widest point of the thorax
  [0.600, 0.053],
  [0.685, 0.040],   // thorax / abdomen junction — last limb pair
  [0.750, 0.033],
  [0.850, 0.030],   // the abdomen stays surprisingly parallel-sided
  [0.900, 0.024],
  [0.945, 0.018],
  [0.975, 0.013],
  [1.000, 0.007],
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
    this.thoraxStart = 7;
    this.thoraxEnd = 17;
    this.abdomenStart = 18;
    this.furcaNode = nodeCount - 1;

    /**
     * Cephalic lobes: the two large translucent paddles flanking the head — the
     * most visually prominent feature of the head in the reference photograph,
     * and the thing that stops the animal reading as a worm with eyes.
     */
    this.lobe = {
      node: 3,
      // Measured: the lobe pair reaches ~0.19 L either side of the midline,
      // roughly three and a half times the width of the trunk behind it.
      length: bodyLength * 0.200,
      width: bodyLength * 0.160,
      offset: 0.60,      // lateral placement of the lobe centre, in widths
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
      segments: 8,
      segLen: bodyLength * 0.017,   // ~0.13 L overall, as measured
      splay: 0.95,       // rad from the forward axis
      maxKink: 0.20,     // rad; keeps the filament from folding on itself
    };

    this.furca = {
      rami: 2,
      setaeCount: 9,
      length: bodyLength * 0.045,
      splay: 0.40,
    };

    /** The gut: the warm ochre stripe running the length of the animal. */
    // Measured off the reference by colour: a steady ~0.007 L half-width.
    this.gut = { from: 0.045, to: 0.955, halfWidth: bodyLength * 0.0070 };
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
      // Cross-sectional area, times a density that falls off posteriorly.
      const w = this.halfWidth[i] / (this.L * 0.055);
      m[i] = lerp(massTail, massHead, clamp(w * w * this.densityAt(this.s[i]), 0, 1));
    }
    return m;
  }

  /**
   * Relative density along the body, 0..1.
   *
   * Mass cannot simply track cross-sectional area. Measuring the reference
   * photograph showed the abdomen is about twice as wide as it had been drawn,
   * and taking mass from width alone would have doubled its weight and killed
   * the trailing whip — which is the most recognisable thing about how Artemia
   * moves. It would also be wrong: the thorax is packed with muscle, gut and
   * gonad, whereas the abdomen is a thin-walled tube that is mostly water.
   *
   * Separating the two lets the silhouette be corrected against the photograph
   * without the dynamics silently changing underneath it.
   */
  densityAt(s) {
    return lerp(1.0, 0.34, smoothstep(0.60, 0.88, s));
  }
}
