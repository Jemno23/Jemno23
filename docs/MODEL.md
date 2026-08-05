# The model

A record of the experiment: what was observed, what was hypothesised, what was
implemented, what the measurements said, and what is still wrong.

The guiding question was not "how do I draw a brine shrimp" but:

> What is the simplest mathematical model capable of producing movement that
> feels convincingly alive?

Everything below is organised around that. Where a simpler model was found to be
sufficient it was kept; where a simpler model was found to be *insufficient*,
the measurement that showed it is recorded, because those are the interesting
results.

---

## 0. Method

Behaviour was developed headless. `src/core` and `src/creature` import nothing
from p5, so the whole organism runs in Node with no canvas, which made it
possible to sweep parameters and measure outcomes instead of eyeballing them.
The metrics used throughout:

| metric | what it detects |
|---|---|
| `arcLength` drift vs nominal | constraint solver losing; body visibly stretching |
| `align` = v̂ · ĥ | whether the animal moves *forwards* or slides sideways |
| speed in body lengths/s | comparability with published Artemia figures |
| speed ripple | surging vs gliding |
| total body bend, degrees | over-flexing; buckling |
| max node speed | instability, before it becomes visible |

Several of the conclusions below reversed an earlier belief. Those are marked
**correction**, because they are the parts that were actually learned rather
than assumed.

---

## 1. The body

### Observed
The animal is a slender, flexible, strongly tapered tube. The head is heavy and
leads. The abdomen carries no propulsion at all and *trails* — through a turn it
swings wide and settles afterwards. Nothing about the body is rigid, and nothing
about it is floppy.

### Hypothesis
If the body is modelled as a chain of point masses with realistic mass
distribution and realistic drag, then the head-leads/abdomen-trails behaviour
does not need to be authored. It should fall out.

It does. `enabled.thrust` and the steering toggles can all be switched off and
the body still behaves like a body.

### Implementation — `core/chain.js`

Three pieces of mathematics, in descending order of how much they matter.

**1. Anisotropic drag.** The single highest-value line in the project.

```
v = v_t·exp(−k_t·dt)/(1 + q_t·|v_t|·dt) + v_n·exp(−k_n·dt)/(1 + q_n·|v_n|·dt)
```

where `v_t` is the component of a node's velocity along the local body axis and
`v_n` the component across it, with `k_n ≫ k_t`. Water resists a slender body
far more across its length than along it. This is what makes an undulating body
go *forwards* rather than skid. Set the two coefficients equal and the creature
instantly reads as a paper cutout sliding on ice — it is worth doing once just
to see how completely the illusion depends on it.

**2. Inextensibility, in two passes.** A position pass removes accumulated
stretch; a velocity pass cancels relative velocity along each segment with an
equal-and-opposite impulse.

**3. Bending as a damped elastic beam** with a *writable* rest curvature:

```
F = −m_eff · L · (ω²·(θ − θ_rest) + 2ζω·θ̇)
```

applied to the two neighbours and reacted on the centre node, so it is pure
torque. The rest curvature is what the steering system writes to when the animal
bends into a turn.

### Corrections found by measurement

**Correction 1 — bending must not be a position constraint.** The first version
solved bending the way Position-Based Dynamics solves everything: project
positions, then re-derive velocity as `(p − p_prev)/h`. It exploded within three
timesteps. The reason is that the bend solver moves nodes by an appreciable
fraction of a segment length, and the velocity re-derivation turns that into
hundreds of px/s out of nowhere, which feeds the next step.

**Correction 2 — and this is the one worth remembering — shortening the
timestep made it worse.** Substepping is the standard cure for a stiff spring,
and it did stabilise the *bending*. But `(p − p_prev)/h` amplifies every
positional correction by `1/h`, so at `h = 1/1920` the *distance* solver's
sub-pixel corrections became thousands of px/s. The light abdomen cracked like a
bullwhip and the animal tore itself apart at 23 seconds. Two systems that were
each individually fine were fighting through the velocity update.

The fix was to stop deriving velocity from positions at all, and cancel relative
velocity with impulses instead — which is timestep-independent, so the two
systems stopped interacting. Measured segment-length error after the change: **0.02 %**, holding over a
five-minute soak, at any substep count.

**Correction 3 — uniform stiffness buckles.** The thorax carries the reaction of
eleven pairs of beating limbs and is in compression the whole time the animal is
swimming. With uniform bending stiffness it buckled into an S-kink at the
shoulder. A stiffness profile — stiff thoracic box, soft abdomen — is both the
fix and the anatomically correct model. It is also what lets the abdomen stay
whippy, which is the most recognisable thing about how Artemia moves.

---

## 2. Propulsion — the metachronal wave

### Observed
The animal does not flap. Eleven pairs of leaf-shaped legs beat in a travelling
wave, each pair slightly out of phase with the one ahead. The animal glides at a
near-constant speed with no visible lunge, even though every individual leg is
producing a violently intermittent force.

### Hypothesis
**That smoothness is the reason metachrony exists.** If N paddles each produce a
pulse of thrust and their phases are spread evenly around the cycle, the sum is
nearly constant: the ripple is a mechanism for converting a jerky force into a
steady one. So the model should not be "apply a forward force" — it should be
"sum eleven phase-shifted paddle forces" and let the smoothness emerge.

### Implementation — `creature/locomotion.js`

```
φ_i = 2πft − i·Δφ                          phase of limb pair i
ψ_i = φ_i + k·sin(φ_i)                     stroke asymmetry (phase warp)
θ_i = bias + A·sin(ψ_i)                    limb angle
θ̇_i = A·cos(ψ_i)·ω·(1 + k·cos(φ_i))       chain rule
S_i = feather + (1−feather)·smoothstep(θ̇_i) blade area
F_i = c·S_i·(r_i θ̇_i)·|r_i θ̇_i|           quadratic drag on a paddle
```

Two details carry the model:

- **The phase warp.** A pure sine sweeps out and back at the same speed. Warping
  the phase with `ψ = φ + k·sin(φ)` — the same trick as the Kepler equation —
  skews the sinusoid in time without introducing harmonics, giving a fast power
  stroke and a slow recovery for the cost of one extra sine.
- **Feathering.** Blade area is phase-dependent: setae fan on the power stroke
  and fold on the recovery. This is where the net thrust actually comes from.
  Asymmetric *speed* alone is not enough, because drag is quadratic and would
  very nearly cancel.

Thrust is applied **at each limb's own attachment region**, along the local body
axis — not at the centre of mass. A curved body therefore swims a curved path
without anything being told to do so.

### Measurement

Sweeping beat frequency and integrating over many cycles:

| | mean total thrust | peak from one limb | ripple in the sum |
|---|---|---|---|
| glide, 2.6 Hz | 2 299 | 1 894 | 19 % |
| cruise, 5.4 Hz | 36 001 | 29 648 | 19 % |
| burst, 9.0 Hz | 156 244 | 128 658 | 19 % |

**The hypothesis holds, and more strongly than expected.** A single limb's
thrust is fully intermittent, and at its peak it delivers ~82 % of the whole
animal's mean thrust on its own — yet the sum of eleven ripples by only 19 %,
and that residual sits at N·f rather than f.

Sweeping the wavelength makes the case directly (`node tools/measure.mjs`,
and see the table in `config.js`):

| limbs per wave | ripple in summed thrust |
|---|---|
| ∞ — all limbs in phase, no wave | **673 %** |
| 2.0 | 341 % |
| 4.0 | 122 % |
| 4.5 | 26 % |
| **5.5** (used here) | **19 %** |
| 8.5 | 20 % |
| 11.0 — exactly one wave over the body | 95 % |

Beating in unison surges by 673 %; the right travelling wave brings that to
19 %. **Metachrony buys a 35-fold reduction in thrust ripple**, and that is
emergent here — nothing in the model was told to smooth anything.

The 11.0 row is the interesting one. 5.5 and 11.0 produce the *same set* of
eleven phases, evenly spaced around the cycle — yet one ripples five times more
than the other. The difference is which limb gets which phase. The limbs are
tapered, so the long middle pairs are far more powerful than the end ones; at
11.0 the phases are assigned in body order, so those powerful middle limbs all
fire together. **Even phase spacing is not sufficient — the strong limbs have to
be spread around the cycle.** That was not anticipated, and it is a claim about
the animal that could be checked against real limb-length and phase data.

### Corrections found by measurement

**Correction 4 — quadratic thrust needs quadratic drag.** A drag-based paddle
produces thrust proportional to *f²*. Against purely linear body drag, swimming
speed also goes as *f²*, so an animal beating 3.5× faster in a burst moved 12×
faster. That both looked absurd and physically tore the body apart. Adding a
quadratic (form) drag term — which is simply the correct regime at Re of a few
hundred — makes speed go roughly as *f*, and produces three sane, distinct
gaits:

| arousal | gait | speed | align |
|---|---|---|---|
| 0.02 | glide | 0.05 BL/s | 0.45 |
| 0.25 | slow swim | 0.18 BL/s | 0.96 |
| 0.50 | cruise | 0.65 BL/s | 0.97 |
| 0.75 | fast | 1.24 BL/s | 0.97 |
| 1.00 | escape burst | 1.92 BL/s | 0.96 |

Published Artemia cruising speeds are around 1 BL/s with bursts several times
that, so this is in the right range without having been fitted to it. The low
`align` in the glide row is not a defect: a barely-beating animal is mostly
being carried by the ambient current, so its velocity is no longer the direction
it is pointing — which is exactly what drifting means.

**Correction 5 — a limb's force cannot be applied to one node.** Blade speed at
the centre of pressure runs well over 1000 px/s, and with a quadratic law the
instantaneous force is large enough to out-run the distance solver. The load is
spread over a Gaussian kernel of nine nodes, which is also the more honest
model: a limb pulls on a joint and the surrounding cuticle carries the load.

---

## 3. Steering

### Observed
Artemia turn by flexing the anterior body and by beating the limbs harder on one
side. They do not pivot on the spot, they do not slide sideways, and they
overshoot slightly and settle.

### Implementation — `creature/steering.js`

The controller **never touches velocity or position.** It produces one number, a
desired heading, and every actual change in direction has to be earned by forces
on the spine. Desire is a blend of three unit vectors:

- **wander** — a Perlin walk on the heading offset. Perlin rather than random is
  the whole trick: `rand()` gives jitter and re-rolling every N seconds gives
  twitch, whereas Perlin gives a heading with a continuous derivative, so the
  path curves the way a searching animal's does.
- **phototaxis** — attraction to the light with a distance falloff *and* a
  comfort radius inside which the pull switches off, so the animal arrives,
  overshoots, mills around and drifts away instead of docking onto the cursor.
- **edge avoidance** — a soft repulsion that ramps up inside a margin.

The desired heading feeds a critically damped angular spring, so turns
accelerate in and ease out. Two actuators then execute it: a yaw couple (equal
and opposite lateral forces, hence pure torque) and an active bend written into
the spine's rest curvature.

### Correction found by measurement

**Correction 6 — the yaw couple was inert.** Sweeping it from 0 to 120 changed
the turn rate by 0.5 %. As an absolute force of order 10² it was nothing against
thrust forces of order 10⁴, and anisotropic drag resists lateral motion anyway.

Expressing it instead as a **fraction of the animal's own current thrust** fixed
it, and is the better model for a second reason: the couple *is* differential
limb beating, so it should scale with how hard the limbs are working. A drifting
animal now cannot turn sharply and a bursting one can spin — behaviour that
previously would have needed a special case.

### A measurement that looked like a bug and was not

Body bend measured 55–60° mean, which is far more than a real Artemia flexes,
and the creature looked permanently hooked. Isolating the systems showed the
cause was **edge avoidance in a cramped test box** — the animal was turning away
from a wall almost continuously. In open water:

| condition | mean bend | max bend |
|---|---|---|
| all systems on | 8.2° | 28° |
| steering off | 0.4° | 1° |

Essentially zero with steering off means thrust bowing is negligible — the thoracic
stiffness profile is doing its job. The lesson was about the harness, not the
model.

---

## 4. Arousal

### Observed
Real Artemia alternate, with no obvious period, between near-gliding, steady
cruising and short bursts. Nothing alive holds a rhythm steadily.

### Hypothesis
This is the system whose *absence* is most obvious. A creature swimming at a
constant beat frequency reads as a toy within about two seconds no matter how
good the body physics are.

### Implementation — `creature/arousal.js`

One scalar in [0,1] from a very slow fBm walk, combined with an exponentially
decaying startle channel by a saturating max rather than a sum, so a startle
always reads clearly regardless of current mood. The time constants are
deliberately asymmetric — arousal rises with a 0.06 s half-life and falls with a
0.9 s one. An animal commits to fleeing instantly and calms down over seconds;
the reverse looks broken.

Arousal drives beat frequency, stroke amplitude and turn willingness together,
so a low-arousal animal does not merely swim slowly — it idles.

Measured startle response: 211 → 586 → 179 px/s (baseline, peak, settled).

---

## 5. The medium

**Correction 7 — the buoyancy model was conceptually wrong.** The first version
had the creature sink when idle and generate lift when swimming. It barely
functioned (the lift term saturated immediately), but the real problem is that
**this is a top-down microscope view**: gravity points into the screen, not down
it. A creature drifting toward the bottom of the frame is being pulled by a
force that has no representation in this projection.

What a real sample does have is bulk motion — the drift you see in every
microscopy clip when all the suspended debris slides the same way at once. That
is horizontal, it is in the image plane, and it is shared by everything in
frame. So `core/medium.js` provides one slow flow field, taken as the curl of a
Perlin potential:

```
u = ( ∂P/∂y , −∂P/∂x )
```

Taking the curl guarantees `div u = 0`, so motes swirl and shear but never pile
up in a corner — which is exactly the failure mode of sampling a noise field
directly as a velocity.

**The creature and the particles read the same field.** That sharing is the
point: when the debris near the animal drifts the way the animal does, the eye
reads "these are in the same fluid", which no amount of independent per-object
noise can fake. An idling creature is now carried ~360 px in 10 s and slowly
reoriented by the shear across its own length. Phototaxis measures 223 px mean
distance to the light with it on, against 605 px with it off.

---

## 6. What is still wrong

Ranked by how much each would improve the illusion.

### 6.1 It is two-dimensional, and the animal is not
The most conspicuous omission. Real Artemia roll about their long axis and swim
ventral-side-up along gentle 3-D helices; the reference photograph is a
specimen held flat, which is exactly the pose the animal does *not* hold while
swimming.

**Proposed model.** Add a roll angle `ρ` per creature, driven by its own slow
noise plus a weak righting torque, and use it purely as a *rendering*
projection: scale the body's lateral half-width by `cos ρ`, foreshorten the limb
sweep by the same factor, and swap the draw order of the two limb rows as `ρ`
passes through zero. No new physics, one new state variable, and it would buy
the single largest missing cue. This is the first thing to try.

### 6.2 The metachronal wave is a clock, not a central pattern generator
`φ_i = ωt − iΔφ` imposes the wave. Real limb coordination is a chain of coupled
oscillators that *entrain*, which is why the wave can change wavelength, stall,
restart, and run asymmetrically down the two sides.

**Proposed model.** Replace the single master phase with eleven Kuramoto-coupled
oscillators:

```
dφ_i/dt = ω_i + K·[ sin(φ_{i−1} − φ_i − Δ) + sin(φ_{i+1} − φ_i + Δ) ]
```

The steady state is the same travelling wave, so nothing looks worse — but
transients become real, the wave takes time to establish after a startle, and
**turning could stop being an actuator at all**: bias `ω_i` on one side and the
asymmetric beating that currently has to be modelled as a couple would emerge
from the oscillator chain. That is a strictly better model of the same
behaviour, and it removes a hand-written system rather than adding one.

### 6.3 Phototaxis is engineering, not biology
Reynolds-style desired-heading steering is a control loop. The animal has two
eyes and no idea where it is; it almost certainly does **tropotaxis** —
comparing intensity between the two eyes and turning toward the brighter.

**Proposed model.** Sample the light at each eye's actual position (the
renderer already places them) and drive the yaw couple from the *difference*.
This is both simpler and more faithful, and it produces for free several
behaviours currently absent: spiralling approach, circling when the gradient is
flat, and a bias that persists when one eye is shaded. It also degrades
correctly — an animal facing away from the light gets almost no signal, which is
why real phototaxis involves so much casting about.

### 6.4 Arousal is exogenous noise
The fBm walk is a stand-in for a nervous system, and it is the least defensible
system in the project — it *works*, but it explains nothing. A relaxation
oscillator, or a two-state Markov process with dwell times fitted to observed
glide/swim bout durations, would be no more complex and would make a testable
claim about the animal.

### 6.5 The limbs do not know about each other
Each blade computes drag against still water. In reality each limb beats in the
wake of the one ahead of it, which is a large part of why metachrony is
efficient. A per-limb local-flow term, reduced by the preceding limb's recent
motion, would capture this and would probably change the optimal `limbsPerWave`
in a way that could be checked against the animal.

### 6.6 Smaller things
- The abdomen is entirely passive. Artemia flex it actively in escape responses.
- Feeding is absent: the thoracic limbs are also the filter-feeding apparatus,
  and a food field would produce area-restricted search for almost nothing.
- Wall behaviour is a repulsion field, not a thigmotactic response.
- Only one organism. The framework supports more (`core/` and the drive,
  steering and arousal systems are organism-agnostic); nothing has been done
  with schooling or collision.

---

## 7. Parameters that matter most

If you change one thing, change one of these.

| parameter | effect |
|---|---|
| `body.dragNormal / dragTangent` | the ratio that makes it swim rather than skid |
| `arousal.range` | set to 0 and the creature becomes a machine within seconds |
| `limbs.limbsPerWave` | thrust ripple ranges from 19 % to 673 % across its range |
| `limbs.strokeAsymmetry` | 0 gives a symmetric, mechanical flutter |
| `body.bendOmega` + stiffness profile | too soft buckles, too stiff is a rod |
| `steering.wanderHalfLife` | the difference between searching and twitching |
