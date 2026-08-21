/**
 * Every tunable number in the simulation, in one place.
 *
 * Grouped by the system that consumes it, and annotated with the *behaviour*
 * each number controls rather than its units alone — the point of the project
 * is to be able to reason about "what makes this look alive", and that requires
 * knowing which knob does what.
 *
 * Lengths are expressed as fractions of body length L wherever possible, so the
 * creature scales cleanly and a second organism can reuse the framework with a
 * different L.
 */

export const BODY_LENGTH = 300;      // px, nose to furca tip at scale 1

export const CONFIG = {
  world: {
    /** Fixed physics timestep. Behaviour must not depend on display refresh rate. */
    fixedDt: 1 / 120,
    maxSubSteps: 6,
    /** How far inside the canvas edge the creature starts turning away. */
    marginFrac: 0.10,
    /** Backstop repulsion at the tank wall, px/s^2 at one margin of penetration. */
    containStrength: 9000,
  },

  body: {
    length: BODY_LENGTH,
    nodes: 28,

    /**
     * The ratio that makes the body swim.
     * dragNormal / dragTangent ~ 8 is roughly right for a slender flexible body
     * at the Reynolds numbers a 10 mm brine shrimp lives at (Re ~ 100-500):
     * high enough that lateral motion is strongly resisted, low enough that the
     * creature still coasts when it stops beating.
     */
    dragTangent: 1.2,
    dragNormal: 9.0,
    /**
     * Quadratic (form) drag. Dominant at cruise, and the reason beat frequency
     * maps to speed roughly linearly instead of quadratically. Also gives the
     * right *feel* to a coast: fast at first, then a long slow drift.
     */
    dragTangentQuad: 0.004,
    dragNormalQuad: 0.030,

    /**
     * The body as an elastic beam. bendOmega is the stiffness expressed as an
     * angular frequency, so it can be checked against the timestep: the
     * explicit damping term needs bendOmega * fixedDt well under 1.
     * Higher = the animal holds a straighter line and recovers faster from a
     * turn; too high and it becomes a rigid rod with a hinge at the neck.
     */
    bendOmega: 40,
    bendDamping: 1.15,       // slightly over-damped: no ringing in the body
    /** Stiffness multipliers: rigid thoracic box, soft trailing abdomen. */
    thoraxStiffness: 2.2,
    abdomenStiffness: 0.5,
    maxBend: 0.30,           // rad per node; ~17 deg -> total possible fold ~ 220 deg
    solverIterations: 6,
    /** Internal physics substeps per fixed step; see Chain.substeps. */
    substeps: 16,

    /** Anterior end is heavier (cephalothorax + gut); the abdomen is a light whip. */
    massHead: 2.4,
    massTail: 0.45,
  },

  /**
   * The metachronal swimming apparatus. 11 pairs of phyllopodia, as in Artemia.
   */
  limbs: {
    count: 11,
    firstNode: 7,            // spine node the first (anterior-most) limb pair sits on
    lastNode: 17,           // measured off the reference: limbs span 0.26-0.68 L

    /**
     * Phase lag between adjacent limb pairs. This is the whole idea of
     * metachrony: the limbs do not beat together, they beat in a travelling
     * wave. wavelength = 2*PI / lagPerLimb, expressed in limbs.
     * 5.5 is not an arbitrary choice — it is very close to the value that
     * minimises the ripple in total thrust, and it sits inside the range
     * reported for Artemia. Measured ripple in the summed thrust of 11 limbs:
     *
     *     all limbs in phase (no wave)   673 %
     *     2.0 limbs per wave             341 %
     *     4.5                             26 %
     *     5.5                             19 %
     *     8.5                             20 %   <-- here
     *     11.0 (one wave over the body)   95 %
     *
     * Two things fall out of that table. First, metachrony really is a
     * smoothing device: it buys a 35-fold reduction over beating in unison.
     * Second, even phase spacing is NOT sufficient — 5.5 and 11.0 produce the
     * same set of phases, but at 11.0 the phases are assigned in body order, so
     * the long powerful middle limbs all fire together. What matters is that
     * the STRONG limbs are spread around the cycle. Run
     * `node tools/measure.mjs metachrony` to reproduce.
     *
     * 8.5 is chosen over the marginally smoother 5.5 because the difference in
     * ripple is within noise (20 % vs 19 %) while the difference in appearance
     * is not: at 5.5 the phase spread across eleven limbs exceeds a full cycle,
     * so adjacent limbs point in opposite directions and cross each other. In
     * the reference photograph the limbs lie in a smooth monotonic progression,
     * overlapping like roof tiles, which needs the longer wave.
     */
    limbsPerWave: 8.5,

    beatHzRest: 2.6,         // glide
    beatHzCruise: 5.4,       // steady swimming
    beatHzBurst: 9.0,        // escape

    sweepAmplitude: 0.80,    // rad, half-angle of the stroke arc
    /**
     * Posterior bias of the stroke arc. The limbs do not sweep about a line
     * perpendicular to the body; the whole arc is tilted backwards, which is
     * why a swimming Artemia looks like it is combing water toward its tail.
     * Purely geometric — it offsets the angle without touching angular
     * velocity, so thrust is unaffected.
     *
     * KEEP bias + amplitude + render.limbRecurve COMFORTABLY UNDER pi/2. Past
     * that the limb tip rotates beyond straight-posterior and folds back along
     * the trunk, where it is hidden — which is what made eleven limbs read as
     * five or six.
     */
    sweepBias: 0.15,
    /**
     * Phase warp k in psi = phase + k*sin(phase). Skews the sinusoid so the
     * power stroke is fast and the recovery stroke slow, which is what a paddle
     * that only works in one direction must do. k = 0 gives a symmetric,
     * mechanical-looking flutter with no net thrust asymmetry to speak of.
     */
    strokeAsymmetry: 0.45,

    /** Effective blade area during recovery, relative to the power stroke. */
    featherFactor: 0.18,
    /**
     * Width of the setal opening/closing transition, as a fraction of peak limb
     * angular velocity. Non-zero because setae take real time to fan and fold;
     * zero would put a step discontinuity in the thrust at every reversal.
     */
    featherTransition: 0.22,

    /** Thrust coefficient: F = k * area * (r*omega)^2, quadratic drag on a paddle. */
    thrustGain: 0.0214,

    /**
     * Limb length as a fraction of L, before the along-body taper. Measured off
     * the reference: blade plus setal fringe reaches ~0.24 L from the midline,
     * roughly four times the trunk's half-width.
     */
    lengthFrac: 0.175,
  },

  /**
   * Steering. Note there is no "set velocity" anywhere: the controller only ever
   * produces a *desired heading*, and the body has to physically achieve it.
   */
  steering: {
    wanderHalfLife: 0.55,    // s, smoothing on the wander target
    wanderRate: 0.16,        // how fast we walk through the noise field
    wanderAmplitude: 1.0,    // rad, peak deviation of the wander heading

    /** Turn controller: a critically damped spring, so turns accelerate and ease out. */
    turnOmega: 2.6,
    maxTurnRate: 1.1,        // rad/s ceiling

    /**
     * Steering is applied two ways at once, because that is how the animal does
     * it: a yaw couple from asymmetric limb beating (translation-free rotation),
     * and an active bend of the anterior body.
     */
    /**
     * Fraction of the animal's own thrust redirected into a turning couple —
     * i.e. how asymmetrically it can beat its limbs. Scaling with thrust rather
     * than using an absolute force is what makes this actuator matter at all.
     */
    yawThrustFraction: 0.34,
    /** How much of the (normalised) heading error becomes rest curvature. */
    bodyCurveGain: 0.42,
    curveNodes: 12,          // how far back the active bend extends

    phototaxisWeight: 2.4,
    phototaxisRange: 900,    // px; beyond this the light is ignored
    /** Below this distance the creature stops closing in and mills around. */
    phototaxisComfort: 110,

    /**
     * Edge avoidance. Deliberately strong: turning away from the glass well
     * before reaching it is behaviour, whereas being stopped by it is collision
     * handling, and the two look completely different.
     */
    edgeWeight: 3.5,
  },

  /**
   * Arousal — the slow state variable that stops the creature looking like a
   * metronome. Drives beat frequency, stroke amplitude and turn willingness.
   */
  arousal: {
    noiseRate: 0.055,        // very slow: the mood changes over ~10-20 s
    baseline: 0.42,
    range: 0.62,
    /** A startle decays with this half-life once triggered. */
    startleHalfLife: 0.75,
    startleGain: 1.0,
    /** How fast a light moves before it startles the creature (px/s). */
    startleLightSpeed: 1400,
  },

  /**
   * The water. Replaces an earlier (wrong) buoyancy model — see core/medium.js
   * for why a top-down microscope view must not have gravity in it.
   */
  medium: {
    scale: 0.0016,           // 1/px, eddy size ~ 600 px
    rate: 0.045,             // how fast the flow pattern evolves
    strength: 26,            // px/s peak flow
    /** How strongly the body is dragged along by the local flow. */
    coupling: 0.9,
  },

  render: {
    bg: [4, 6, 11],
    glowLayers: 3,
    /**
     * Constant posterior hook of each thoracopod, radians from base to tip.
     * Purely geometric — it does not enter the thrust calculation, which uses
     * angular velocity only — but it is what gives the limb row the recurved,
     * roof-tiled look of the reference.
     */
    limbRecurve: 0.35,
    /**
     * Fraction of the previous frame retained each draw. Imitates the sensor
     * smear of a real microscopy camera and gives fast limb strokes a faint
     * comet trail. Too much and the whole field turns to streaks.
     */
    persistence: 0.18,
    /**
     * Tissue colour, measured off the reference rather than chosen. Sampling
     * the specimen gives R-B = -20: a near-neutral white with only a slight
     * cool cast. The old [186,214,236] was R-B = -50, which rendered the animal
     * distinctly blue where the photograph is silver-white.
     */
    bodyTint: [220, 230, 236],
    gutTint: [200, 188, 150],
    eyeTint: [74, 12, 16],
    particleCount: 320,
    particleAdvection: 0.55,
  },
};
