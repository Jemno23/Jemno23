import { Vec2 } from './core/vec2.js';

/**
 * Interaction — the only place the outside world touches the simulation.
 *
 * There are exactly two channels in, and both are *stimuli*, not commands:
 *
 *   - the pointer is a light source, which the creature is free to approach,
 *     ignore, overshoot or be startled by depending on its internal state;
 *   - a click is a mechanical disturbance, which raises arousal.
 *
 * Nothing here can move the creature. That constraint is deliberate: an
 * organism you can drag is a puppet, and the moment the viewer can drag it the
 * illusion is gone. Being able to *influence* something that then makes its own
 * decisions is far more convincing than being able to control it.
 *
 * The tracker also differentiates pointer position to get a speed, which feeds
 * the looming-stimulus startle in Arousal — a light that sweeps past fast is
 * threatening in a way that a slowly drifting one is not.
 */
export class LightSource {
  constructor() {
    this.pos = new Vec2(0, 0);
    this.prev = new Vec2(0, 0);
    this.speed = 0;
    this.active = false;
  }

  setPosition(x, y) {
    this.pos.set(x, y);
    this.active = true;
  }

  deactivate() { this.active = false; }

  update(dt) {
    if (!this.active) { this.speed = 0; this.prev.copyFrom(this.pos); return; }
    const d = Vec2.dist(this.pos, this.prev);
    // Smoothed so that a single stuttering pointer sample cannot trigger a startle.
    this.speed = this.speed * 0.85 + (d / Math.max(dt, 1e-4)) * 0.15;
    this.prev.copyFrom(this.pos);
  }

  /** Soft halo, drawn under everything else. */
  draw(p) {
    if (!this.active) return;
    p.blendMode(p.ADD);
    p.noStroke();
    for (let i = 5; i >= 1; i--) {
      const r = i * 26;
      p.fill(120, 150, 200, 7);
      p.circle(this.pos.x, this.pos.y, r * 2);
    }
    p.fill(200, 225, 255, 40);
    p.circle(this.pos.x, this.pos.y, 8);
  }
}

/**
 * Keyboard bindings. Kept as a plain table so the control scheme is data, and
 * the debug legend can render it without a second source of truth.
 */
export function bindKeys(app) {
  return (key) => {
    const k = key.toLowerCase();
    switch (k) {
      case 'd': app.showDebug = !app.showDebug; break;
      case '1': app.debug.panels.spine = !app.debug.panels.spine; break;
      case '2': app.debug.panels.forces = !app.debug.panels.forces; break;
      case '3': app.debug.panels.steering = !app.debug.panels.steering; break;
      case '4': app.debug.panels.wave = !app.debug.panels.wave; break;
      case '5': app.debug.panels.state = !app.debug.panels.state; break;

      case 'w': app.toggleSystem('wander'); break;
      case 'l': app.toggleSystem('light'); break;
      case 'b': app.toggleSystem('bend'); break;
      case 't': app.toggleSystem('thrust'); break;

      case 'p': app.showParticles = !app.showParticles; break;
      case 'h': app.showHud = !app.showHud; break;
      case ' ': app.paused = !app.paused; break;
      case 'n': app.stepOnce = true; break;
      case 'r': app.reset(); break;
      case '[': app.timeScale = Math.max(0.1, app.timeScale - 0.1); break;
      case ']': app.timeScale = Math.min(3, app.timeScale + 0.1); break;
      default: return false;
    }
    return true;
  };
}
