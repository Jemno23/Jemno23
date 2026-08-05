import { CONFIG } from './config.js';
import { Vec2 } from './core/vec2.js';
import { NoiseField } from './core/noise.js';
import { Medium } from './core/medium.js';
import { clamp } from './core/mathx.js';
import { SeaMonkey } from './creature/seaMonkey.js';
import { CreatureRenderer } from './render/creatureRenderer.js';
import { ParticleField } from './render/particles.js';
import { DebugOverlay } from './render/debugOverlay.js';
import { clearField, vignette } from './render/darkfield.js';
import { LightSource, bindKeys } from './interaction.js';

/**
 * Application shell: canvas, fixed-timestep loop, and wiring.
 *
 * THE FIXED TIMESTEP IS NOT A DETAIL. The creature is a constrained particle
 * system with stiff-ish constraints and an oscillator running at up to 9 Hz.
 * Feeding it the display's frame delta makes its behaviour a function of the
 * viewer's monitor: the same seed swims differently at 60 and 144 Hz, and a
 * single long frame can throw the solver. So physics advances in fixed 1/120 s
 * steps and rendering interpolates nothing — it simply draws the latest state.
 */
class App {
  constructor(p) {
    this.p = p;
    this.paused = false;
    this.stepOnce = false;
    this.timeScale = 1;
    this.showDebug = false;
    this.showHud = true;
    this.showParticles = true;
    this.accumulator = 0;
    this.time = 0;

    this.light = new LightSource();
    this.debug = new DebugOverlay();
    this.noise = new NoiseField(24601);
    this.medium = new Medium(this.noise, CONFIG.medium);
    this.handleKey = bindKeys(this);
  }

  setup() {
    const p = this.p;
    p.pixelDensity(Math.min(2, p.displayDensity()));

    // Scale the animal to the viewport so it reads well on a phone and on a
    // desktop without changing any of the behaviour constants.
    this.cfg = structuredClone(CONFIG);
    this.cfg.body.length = clamp(Math.min(p.width, p.height) * 0.42, 170, 400);

    this.renderer = new CreatureRenderer(this.cfg.render);
    this.vignetteCache = {};

    this.monkey = new SeaMonkey(this.cfg, {
      seed: 3,
      position: new Vec2(p.width * 0.62, p.height * 0.5),
      direction: new Vec2(-1, -0.15),
    });

    this.particles = new ParticleField(
      this.cfg.render.particleCount, this.noise, this.bounds()
    );
  }

  bounds() {
    const p = this.p;
    const m = Math.min(p.width, p.height) * this.cfg.world.marginFrac;
    return { minX: 0, minY: 0, maxX: p.width, maxY: p.height, margin: m + this.cfg.body.length * 0.25 };
  }

  reset() {
    const p = this.p;
    this.monkey.reset(
      new Vec2(p.width * 0.5, p.height * 0.5),
      Vec2.fromAngle(Math.random() * Math.PI * 2)
    );
    this.particles.reseed(this.bounds());
  }

  toggleSystem(name) {
    this.monkey.enabled[name] = !this.monkey.enabled[name];
  }

  /** Advance the world by `frameDt` real seconds, in fixed physics steps. */
  step(frameDt) {
    const w = this.cfg.world;
    this.accumulator += Math.min(frameDt, 0.25) * this.timeScale;

    let steps = 0;
    const env = { light: this.light, bounds: this.bounds(), medium: this.medium };

    while (this.accumulator >= w.fixedDt && steps < w.maxSubSteps) {
      const dt = w.fixedDt;
      this.light.update(dt);
      this.medium.update(dt);
      this.monkey.update(dt, env);
      this.particles.update(dt, env.bounds, [this.monkey],
                            this.cfg.render.particleAdvection, this.medium);
      this.time += dt;
      this.accumulator -= dt;
      steps++;
    }
    // If we fell far behind (tab was backgrounded), drop the backlog rather than
    // spiral-of-deathing through it.
    if (steps === w.maxSubSteps) this.accumulator = 0;

    this.debug.record(this.monkey);
  }

  draw() {
    const p = this.p;
    const dt = Math.min(p.deltaTime / 1000, 0.25);

    if (!this.paused || this.stepOnce) {
      this.step(this.stepOnce ? this.cfg.world.fixedDt : dt);
      this.stepOnce = false;
    }

    clearField(p, this.cfg.render.bg, this.cfg.render.persistence);
    vignette(p, this.vignetteCache);

    this.light.draw(p);
    if (this.showParticles) this.particles.draw(p);

    this.renderer.draw(p, this.monkey);

    if (this.showDebug) {
      this.debug.draw(p, this.monkey, { light: this.light });
      this.debug.drawPanels(p, this.monkey);
      this.debug.drawLegend(p, {
        ...this.monkey.enabled,
        particles: this.showParticles,
        paused: this.paused,
      });
    } else if (this.showHud) {
      this.hud(p);
    }
  }

  hud(p) {
    const r = this.monkey.readout();
    p.blendMode(p.BLEND);
    p.push();
    p.textFont('monospace');
    p.textSize(11);
    p.noStroke();
    p.fill(255, 255, 255, 105);
    p.text('computational sea-monkey', 18, 26);
    p.fill(255, 255, 255, 62);
    p.text(`${r.beatHz.toFixed(1)} Hz   arousal ${r.arousal.toFixed(2)}   ${r.speed.toFixed(0)} px/s`, 18, 44);
    p.text('move to lead with light  ·  click to startle  ·  D for the mathematics', 18, 62);
    p.pop();
  }

  resize() {
    const p = this.p;
    this.cfg.body.length = clamp(Math.min(p.width, p.height) * 0.42, 170, 400);
    this.vignetteCache = {};
  }
}

const sketch = (p) => {
  const app = new App(p);

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.noSmooth();
    app.setup();
  };

  p.draw = () => app.draw();

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    app.resize();
  };

  p.mouseMoved = () => app.light.setPosition(p.mouseX, p.mouseY);
  p.mouseDragged = () => app.light.setPosition(p.mouseX, p.mouseY);
  p.touchMoved = () => { app.light.setPosition(p.mouseX, p.mouseY); return false; };

  p.mousePressed = () => {
    app.light.setPosition(p.mouseX, p.mouseY);
    app.monkey.startle(1);
  };

  p.keyPressed = () => {
    if (app.handleKey(p.key === ' ' ? ' ' : p.key)) return false;
    return true;
  };

  // Expose for console tinkering — the config is meant to be played with.
  window.seaMonkeyApp = app;
};

new window.p5(sketch);
