# Veil Hunt — Game Design

## The pitch

Two players. Seven minutes. One moonlit ruin.

The **Runner** must light three ritual seals and escape through the gate. The
**Hunter** must find them and cut them down before that happens. Neither player
ever sees the other on a map — every scrap of knowledge is *earned*, through
line of sight, footprints in the mud, the sound of a sprint on flagstones, a
door left swinging, or a crossbow bolt that found its mark.

## Core loop contract

| | Runner | Hunter |
| --- | --- | --- |
| **Primary verb** | Move unseen, channel seals | Track, close, strike |
| **Objective** | 3 seals → gate → escape | Capture, or run out the clock |
| **Pressure** | Wounds escalate, noise betrays you, the clock | The seal counter is public — every bell is a loss |
| **Reward** | A lit seal (map-wide bell), a clean escape | A landed wound, a mark, a sprung snare |
| **Fail state** | Blade hit while Cursed | Runner reaches the gate |
| **Retry** | Rematch with roles swapped |

## The asymmetry rule

The Hunter is never given the Runner's position for free. This is the single
design constraint everything else serves. Concretely, it is enforced in code:
`Match.buildSnapshot()` filters each player's snapshot through
`server/visibility.ts`, so the Hunter's client *does not receive* the Runner's
transform unless perception genuinely permits it. There is no client-side
"hide the marker" — the data simply is not sent.

What the Hunter gets instead:

- **Line of sight**, gated by range, a generous facing cone, walls, smoke and
  the Runner's concealment state.
- **Sound**, positional and directional. Footsteps vary by surface; water is
  loud and dangerous to cross; a wounded Runner breathes audibly.
- **Footprints** in mud and grass, fading over 26 seconds, revealed in a burst
  by the Tracking Pulse — older traces read dimmer.
- **Disturbance**: doors left ajar stay ajar, charms rattle when knocked.
- **A mark**, from the crossbow: a *coarse* drifting wisp quantised to a 3.5 m
  grid. Direction, not a pin.

## Roles

### Runner — vulnerable, quick, clever

Slightly faster sprint than the Hunter but a much worse stamina economy, so a
straight-line chase is survivable only in bursts. Wins through routing,
deception and nerve.

| Kit | Bind | Behaviour |
| --- | --- | --- |
| Echo Decoy | Q | A phantom that walks away from you making real footstep noise and appearing on the Hunter's tracking. 9 s life, 21 s cooldown. |
| Veil Smoke | F | A cloud that breaks line of sight both ways and damps the Tracking Pulse to 25%. 9 s, 27 s cooldown — too slow to spam. |
| Flash Ward | RMB | Two charges. A hidden sigil; if the Hunter blunders across it they are stunned 1.6 s and you get a 24% speed burst. The Hunter then has 20 s of stun immunity, so they can never be chain-locked. |
| Throw stone | LMB | Makes a noise 13 m away from where you actually are. |
| Interact | E (hold) | Seals, gate, shrine, doors, snare escape. |

Movement: sprint, crouch (quieter, slower), vault low obstacles, and crouch-only
tunnels the Hunter physically cannot follow through.

### Hunter — heavy, deliberate, frightening

Slower top speed, far better stamina, and the only player who can breach.

| Kit | Bind | Behaviour |
| --- | --- | --- |
| Ritual Blade | LMB | 0.34 s wind-up, 3.3 m reach, 71° cone, no hits through walls. One wound per hit. |
| Marking Crossbow | RMB | 3 bolts, a *visible slow* projectile that can be dodged. Does not wound — marks for 8 s and slows 16% for 3 s. Spent bolts stick in the world and can be recovered. |
| Tracking Pulse | Q | Reveals fresh footprints within 27 m for 4.5 s. Directional, never a wall-hack. 17 s cooldown. |
| Snare | F | Three charges, max three live. Roots the Runner 1.5 s, then slows. The Runner escapes with a 1.2 s channel. |
| Breach | E on a barricade | Forces a barricaded shortcut. Very loud, and self-slows for 1.5 s afterwards — pressure, not a teleport. |

## Wounds and capture

Three states, never a health bar:

**Unmarked → Wounded → Cursed → captured.**

The next valid blade hit while Cursed ends the match. Each escalation adds
audible breathing, a stronger magical seam glow, slower ritual channels
(100% → 86% → 72%) and a heavier vignette and heartbeat. Movement stays
playable throughout — Cursed is only 7% slower, because a Runner who cannot run
is not playing a game.

After every wound the Runner gets **3.2 s of protection**, longer than the blade
cooldown, so the Hunter can never chain all three hits from one engagement.

**The shrine**, far south, removes one wound level once per match. It takes 9
seconds, makes noise, and sits in a dead end. Healing is a real gamble.

## Map — Moonveil Ruins

A 132 × 132 m compact ruin with a fixed, learnable skeleton and seeded variation
on top.

| Landmark | Role in play |
| --- | --- |
| **Ruined chapel** (centre) | The hub. Tall silhouette visible everywhere, broken colonnade that shreds sight lines, a raised altar dais. |
| **Graveyard** (NW) | Soft mud — this is where footprints betray you. Mausoleum with a sarcophagus hide spot. |
| **Hedge maze** (NE) | Foliage concealment for a crouching Runner, looping paths, a wardrobe. |
| **Flooded courtyard** (SW) | Water is loud. Crossing it is a decision, not a shortcut. Arch colonnade for cover. |
| **Broken watchtower** (SE) | Ramp to a raised balcony — the Hunter's overlook, and a vaultable escape for the Runner. |
| **Undercroft tunnels** | Crouch-only gaps. Runner-exclusive escape valves. |
| **Escape gate** (N wall) | The finish line. |
| **Healing shrine** (far S) | High risk, high reward. |

Seven seal anchors exist; three go live per match, and the generator guarantees
at least two are outside the chapel so they can never bunch into one corner.
Seeded variation also picks which crouch tunnels are open, which barricades
exist, prop scatter and fog density. `?seed=12345` reproduces a match exactly.

Every seed is verified by a flood-fill test: 100% of walkable space is reachable
and no objective can be stranded.

## Environmental storytelling

The environment is the third participant:

- Spectral crows startle and scatter when someone runs past.
- Grass bends, water ripples, mist drifts.
- Lanterns flicker; hanging charms rattle when disturbed.
- A distant bell tolls map-wide the instant a seal lights.
- Fog thickens as the clock runs down, closing the world in.

**Every gameplay-critical sound also has a visual indicator** — directional arcs
at the screen edge, tinted by category. The game is fully playable muted.

## Hidden contracts

Some rounds privately assign each player a bonus contract, revealed only on the
results screen. They never replace the primary victory condition.

*Hunter:* capture in the chapel · land two marks · win with a snare unspent ·
let all three seals burn, then stop the escape.
*Runner:* escape without healing · spring the Hunter's own snare with a decoy ·
light the final seal while Cursed · carry a recovered bolt to the gate.

## Balance intent

- A pure footrace should be losable by both sides. The Runner is faster but
  runs out of breath; the Hunter is relentless.
- Every Hunter tool has a counter: smoke damps the pulse, the ward punishes
  carelessness, tunnels deny the chase, and bolts can be dodged.
- Every Runner tool has a tell: channelling is slow and public, smoke marks
  where you *were*, and the decoy sounds subtly different up close.
- The Runner can never repeatedly attack or permanently disable the Hunter.
- The Hunter can never chain a capture from one engagement.
