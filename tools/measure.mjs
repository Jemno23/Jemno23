/**
 * Headless measurement harness.
 *
 *   node tools/measure.mjs            all suites
 *   node tools/measure.mjs gaits      one suite
 *   node tools/measure.mjs sweep limbs.thrustGain 0.012,0.022,0.03
 *
 * This exists because the behaviour layer imports nothing from p5, so the whole
 * organism runs in Node with no canvas. Every number quoted in docs/MODEL.md
 * came from here. Tuning a creature by eye converges slowly and lies; tuning it
 * against `align`, `arcErr` and speed-in-body-lengths does not.
 */
import { CONFIG } from '../src/config.js';
import { Vec2 } from '../src/core/vec2.js';
import { NoiseField } from '../src/core/noise.js';
import { Medium } from '../src/core/medium.js';
import { SeaMonkey } from '../src/creature/seaMonkey.js';
import { MetachronalDrive } from '../src/creature/locomotion.js';

const TANK = { minX: 0, minY: 0, maxX: 1400, maxY: 850 };
const L = 357;

function configure(overrides = {}) {
  const cfg = structuredClone(CONFIG);
  cfg.body.length = L;
  for (const [path, v] of Object.entries(overrides)) {
    const keys = path.split('.');
    let o = cfg;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys.at(-1)] = v;
  }
  return cfg;
}

function world(cfg, opts = {}) {
  const monkey = new SeaMonkey(cfg, {
    seed: opts.seed ?? 3,
    position: new Vec2(opts.x ?? 700, opts.y ?? 425),
    direction: new Vec2(-1, opts.dy ?? 0),
  });
  const medium = new Medium(new NoiseField(24601), cfg.medium);
  const bounds = { ...TANK, margin: cfg.world.marginFrac * TANK.maxY + L * 0.25 };
  const light = opts.light ?? { active: false, pos: new Vec2(0, 0), speed: 0 };
  return { monkey, medium, env: { light, bounds, medium }, dt: cfg.world.fixedDt };
}

/** Run for `seconds` and return the standard metric bundle. */
function run(overrides = {}, seconds = 60, opts = {}) {
  const cfg = configure(overrides);
  const { monkey: m, medium, env, dt } = world(cfg, opts);
  const settle = Math.round(2 / dt);
  const steps = Math.round(seconds / dt);

  let arcErr = 0, sumSpeed = 0, sumAlign = 0, sumBend = 0, maxBend = 0, n = 0;
  const speeds = [];
  const v = new Vec2();
  let blown = false;

  for (let i = 0; i < steps; i++) {
    medium.update(dt);
    m.update(dt, env);

    const arc = m.chain.arcLength();
    if (!Number.isFinite(arc) || arc > L * 1.5) { blown = true; break; }
    if (i < settle) continue;

    arcErr = Math.max(arcErr, Math.abs(arc - L) / L);
    sumSpeed += m.speed;
    speeds.push(m.speed);

    m.chain.centerVelocity(v);
    if (v.mag() > 1) {
      const h = m.heading();
      sumAlign += (v.x * Math.cos(h) + v.y * Math.sin(h)) / v.mag();
    }

    let bend = 0;
    for (let k = 1; k < m.chain.count - 1; k++) bend += m.chain.curvatureAt(k);
    const deg = Math.abs(bend) * 180 / Math.PI;
    sumBend += deg;
    maxBend = Math.max(maxBend, deg);
    n++;
  }

  const mean = sumSpeed / (n || 1);
  const variance = speeds.reduce((a, s) => a + (s - mean) ** 2, 0) / (speeds.length || 1);

  return {
    blown,
    BLs: +(mean / L).toFixed(3),                          // body lengths per second
    px: Math.round(mean),
    ripplePct: +(100 * Math.sqrt(variance) / (mean || 1)).toFixed(1),
    align: +(sumAlign / (n || 1)).toFixed(3),             // 1 = moves where it points
    arcErrPct: +(arcErr * 100).toFixed(3),                // solver health
    bendDeg: Math.round(sumBend / (n || 1)),
    bendMaxDeg: Math.round(maxBend),
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

const suites = {
  /** Gaits should be distinct, and land near published Artemia speeds (~1 BL/s cruise). */
  gaits() {
    console.log('\nGAITS  (arousal held fixed)');
    for (const a of [0.02, 0.25, 0.5, 0.75, 1.0]) {
      const r = run({ 'arousal.range': 0, 'arousal.baseline': a }, 40);
      console.log(`  arousal ${a.toFixed(2)}   ${String(r.BLs).padStart(6)} BL/s  ` +
                  `${String(r.px).padStart(4)} px/s   align ${r.align}   arcErr ${r.arcErrPct}%`);
    }
  },

  /**
   * The central hypothesis: eleven individually intermittent limb forces should
   * sum to a nearly constant total. If this ripple is large, metachrony is not
   * doing the job it exists to do.
   */
  metachrony() {
    console.log('\nMETACHRONY  (thrust summed over 11 limbs)');
    const cfg = configure();
    const d = new MetachronalDrive(cfg.limbs, L);
    for (const [hz, eff, label] of [[2.6, 0.42, 'glide '], [5.4, 0.80, 'cruise'], [9.0, 1.0, 'burst ']]) {
      let sum = 0, hi = -Infinity, lo = Infinity, peakLimb = 0, n = 0;
      for (let i = 0; i < 4000; i++) {
        d.update(1 / 480, hz, eff);
        for (let k = 0; k < d.n; k++) peakLimb = Math.max(peakLimb, d.thrust[k]);
        if (i > 500) { sum += d.totalThrust; hi = Math.max(hi, d.totalThrust); lo = Math.min(lo, d.totalThrust); n++; }
      }
      const mean = sum / n;
      console.log(`  ${label} ${hz} Hz   mean ${mean.toFixed(0).padStart(6)}   ` +
                  `ripple ${((hi - lo) / mean * 100).toFixed(0)}%   ` +
                  `peak single limb ${peakLimb.toFixed(0)}`);
    }
  },

  /** Body bend, attributed to its actual source. */
  bending() {
    console.log('\nBENDING  (open water, no walls)');
    const cases = [
      ['all systems on          ', {}],
      ['steering off            ', { wander: false, light: false, edges: false }],
      ['steering + actuators off', { wander: false, light: false, edges: false, bend: false }],
    ];
    for (const [label, flags] of cases) {
      const cfg = configure();
      const { monkey: m, medium, env, dt } = world(cfg);
      Object.assign(m.enabled, flags);
      env.bounds = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5, margin: 1 };
      let sum = 0, mx = 0, n = 0;
      for (let i = 0; i < 60 / dt; i++) {
        medium.update(dt); m.update(dt, env);
        if (i < 600) continue;
        let b = 0;
        for (let k = 1; k < m.chain.count - 1; k++) b += m.chain.curvatureAt(k);
        const deg = Math.abs(b) * 180 / Math.PI;
        sum += deg; mx = Math.max(mx, deg); n++;
      }
      console.log(`  ${label}  mean ${(sum / n).toFixed(1)}°   max ${mx.toFixed(0)}°`);
    }
  },

  /** Phototaxis, startle and drift should all be measurable, not just plausible. */
  behaviour() {
    console.log('\nBEHAVIOUR');
    for (const on of [true, false]) {
      const cfg = configure();
      const light = { active: on, pos: new Vec2(250, 425), speed: 0 };
      const { monkey: m, medium, env, dt } = world(cfg, { x: 1150, light, seed: 5 });
      let sum = 0, n = 0;
      for (let i = 0; i < 90 / dt; i++) {
        medium.update(dt); m.update(dt, env);
        if (i > 600) { sum += Vec2.dist(m.head, light.pos); n++; }
      }
      console.log(`  light ${on ? 'ON ' : 'OFF'}   mean distance to light ${(sum / n).toFixed(0)} px`);
    }

    const cfg = configure();
    const { monkey: m, medium, env, dt } = world(cfg);
    for (let i = 0; i < 600; i++) { medium.update(dt); m.update(dt, env); }
    const before = m.speed;
    m.startle(1);
    let peak = 0;
    for (let i = 0; i < 150; i++) { medium.update(dt); m.update(dt, env); peak = Math.max(peak, m.speed); }
    for (let i = 0; i < 360; i++) { medium.update(dt); m.update(dt, env); }
    console.log(`  startle   ${before.toFixed(0)} -> peak ${peak.toFixed(0)} -> settled ${m.speed.toFixed(0)} px/s`);
  },

  /** Long soak: the solver must not drift or destabilise over time. */
  soak() {
    console.log('\nSOAK  (5 minutes of simulated time)');
    const r = run({}, 300);
    console.log(`  ${JSON.stringify(r)}`);
    console.log(`  ${r.blown ? 'FAILED — simulation destabilised' : 'stable'}`);
  },
};

// ---------------------------------------------------------------------------

const [which, path, values] = process.argv.slice(2);

if (which === 'sweep') {
  console.log(`\nSWEEP  ${path}`);
  for (const raw of values.split(',')) {
    const v = Number(raw);
    console.log(`  ${String(v).padStart(8)}  ${JSON.stringify(run({ [path]: v }, 40))}`);
  }
} else if (which && suites[which]) {
  suites[which]();
} else {
  for (const s of Object.values(suites)) s();
}
console.log('');
