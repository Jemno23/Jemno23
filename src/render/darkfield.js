/**
 * Darkfield presentation helpers.
 *
 * In darkfield microscopy nothing is lit directly: you only see light that the
 * specimen has *scattered*, against an otherwise black field. That gives the
 * three properties this renderer imitates, and imitating them is most of what
 * makes the creature read as biological rather than as a game sprite:
 *
 *   1. Everything is emissive. There is no shading, no shadow, no ambient
 *      occlusion — so we composite additively and never draw anything dark
 *      except genuinely opaque structures (the eyes, the gut wall).
 *   2. Thin edges are the brightest part of a transparent object, because that
 *      is where the light path through it is longest and where refraction is
 *      strongest. Hence: dim fill, bright rim.
 *   3. The medium itself is full of scatterers — the suspended debris that
 *      gives every real microscopy clip its texture and its sense of depth.
 *
 * The glow is a manual multi-pass rather than a blur filter: three strokes of
 * decreasing weight and increasing alpha approximate a Gaussian falloff around
 * the outline, at a fraction of the cost, and stay crisp at any canvas scale.
 */

/**
 * Stroke a path several times at decreasing weight to fake an emissive bloom.
 * @param {p5} p
 * @param {(p:p5)=>void} pathFn  issues beginShape/vertex/endShape
 * @param {number[]} rgb
 * @param {number} weight        weight of the innermost (brightest) pass
 * @param {number} alpha         alpha of the innermost pass
 * @param {number} layers
 */
export function glowStroke(p, pathFn, rgb, weight, alpha, layers = 3) {
  p.noFill();
  for (let i = layers - 1; i >= 0; i--) {
    const spread = 1 + i * 2.2;
    // Wide passes are much fainter, so total deposited light stays roughly
    // constant while the visible halo grows.
    p.stroke(rgb[0], rgb[1], rgb[2], alpha / (1 + i * 2.6));
    p.strokeWeight(weight * spread);
    pathFn(p);
  }
}

/** Emit a smooth closed loop through `pts` using Catmull-Rom (p5's curveVertex). */
export function closedCurve(p, pts) {
  if (pts.length < 3) return;
  p.beginShape();
  p.curveVertex(pts[pts.length - 1].x, pts[pts.length - 1].y);
  for (const q of pts) p.curveVertex(q.x, q.y);
  p.curveVertex(pts[0].x, pts[0].y);
  p.curveVertex(pts[1].x, pts[1].y);
  p.endShape(p.CLOSE);
}

/** Emit a smooth open curve through `pts`, duplicating the ends as tangent hints. */
export function openCurve(p, pts) {
  if (pts.length < 2) return;
  p.beginShape();
  p.curveVertex(pts[0].x, pts[0].y);
  for (const q of pts) p.curveVertex(q.x, q.y);
  p.curveVertex(pts[pts.length - 1].x, pts[pts.length - 1].y);
  p.endShape();
}

/**
 * Clear the frame. `persistence` in [0,1) leaves a fraction of the previous
 * frame behind, which reproduces the sensor smear of a real microscopy camera
 * and gives fast limb strokes a faint comet trail. 0 = hard clear.
 */
export function clearField(p, bg, persistence = 0) {
  p.blendMode(p.BLEND);
  if (persistence <= 0) {
    p.background(bg[0], bg[1], bg[2]);
  } else {
    p.noStroke();
    p.fill(bg[0], bg[1], bg[2], 255 * (1 - persistence));
    p.rect(0, 0, p.width, p.height);
  }
}

/**
 * A very faint cone of illumination and an edge vignette. Purely atmospheric,
 * but it is what stops the black background reading as "empty canvas" rather
 * than "a tank under a microscope".
 */
export function vignette(p, cache) {
  if (!cache.layer || cache.w !== p.width || cache.h !== p.height) {
    const g = p.createGraphics(p.width, p.height);
    g.noStroke();
    const cx = p.width * 0.5, cy = p.height * 0.5;
    const maxR = Math.hypot(cx, cy);
    for (let r = maxR; r > 0; r -= maxR / 48) {
      const t = r / maxR;                    // 1 at the corners, 0 at the centre
      g.fill(10, 22, 38, 5 * (1 - t) * (1 - t));
      g.ellipse(cx, cy, r * 2, r * 2);
    }
    cache.layer = g;
    cache.w = p.width;
    cache.h = p.height;
  }
  p.blendMode(p.ADD);
  p.image(cache.layer, 0, 0);
}
