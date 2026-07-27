# Veil Hunt — Build Plan

One-sentence pitch: a 7-minute, two-player, asymmetric hide-and-hunt duel in a moonlit
dark-fantasy ruin, where the Runner lights three ritual seals and escapes while the
Hunter tracks, wounds, and captures.

## 1. Design contract

**Core loop contract**

| Element | Runner | Hunter |
| --- | --- | --- |
| Verb | Move unseen / channel seals | Track / close distance / strike |
| Objective | Activate 3 seals, escape the gate | Capture, or run out the clock |
| Pressure | Wound escalation, noise, footprints, timer | Runner progress bar, limited bolts/snares |
| Reward | Seal lit (world bell + gate progress) | Wound landed, mark applied, snare triggered |
| Fail / retry | Captured at Cursed + 1 blade hit | Runner escapes through the gate |

**Asymmetry rule** — the Hunter never receives the Runner's position for free. All
position knowledge is earned through line of sight, footprints, noise events, marks,
and disturbed props.

## 2. Architecture

```
src/shared/   canonical schema + pure rules, imported by BOTH client and server
  constants.ts   every tunable number, single source of truth
  types.ts       match-state schema, snapshot shapes, enums
  protocol.ts    socket event names + payload types
  validation.ts  runtime guards for every inbound payload
  rng.ts         mulberry32 seeded RNG + seeded helpers
  mapgen.ts      deterministic Moonveil Ruins layout from a seed
  collision.ts   circle-vs-OBB resolve, segment-vs-world raycast, floor sampling
  movement.ts    pure movement step, run identically on client + server
  matchRules.ts  wounds, seals, gate, victory, cooldowns (pure functions)
  contracts.ts   hidden bonus contracts

src/server/   authoritative simulation
  index.ts       express + socket.io, serves dist/ in production
  roomCode.ts    short readable room codes
  RoomManager.ts rooms, players, roles, ready, rematch, disconnect
  Match.ts       30 Hz authoritative tick, 20 Hz filtered snapshots
  visibility.ts  per-role snapshot filtering (LOS, smoke, hide spots)

src/client/
  main.ts        app state machine + bootstrap
  net/           socket client, prediction buffer, remote interpolation
  core/          renderer, loop, camera rig, input, settings
  world/         Moonveil Ruins mesh build, materials, props, sky, post
  entities/      Runner + Hunter models, seals, gate, decoy, smoke, snare...
  systems/       audio, vfx, footprints, indicators
  ui/            screens + HUD (semantic HTML + CSS)
  test/          window.__VEIL_HUNT_TEST__ (dev + e2e only)
```

**Non-negotiables**
- Server owns: room/match state, timer, roles, seals, gate, attacks, wounds,
  cooldowns, victory, rematch.
- Movement uses client prediction + server re-simulation of the *same pure function*.
- Snapshots are filtered per role — the Hunter's socket literally never receives the
  Runner's transform unless the Runner is legitimately perceivable.
- No duplicated constants: client and server both import `src/shared/constants.ts`.

## 3. Map — Moonveil Ruins

Fixed navigational skeleton (hand-authored coordinates), seeded variation on top.

| Landmark | Role |
| --- | --- |
| Ruined chapel (centre) | Tall silhouette, main loop hub, 2 seal anchors |
| Graveyard (NW) | Sightline blockers, soft mud → footprints |
| Hedge maze (NE) | Foliage hiding, crouch tunnels beneath |
| Flooded courtyard (SW) | Water ripples + loud splashing, risky crossing |
| Broken watchtower (SE) | Raised balcony overlook, ramp access |
| Undercroft tunnels | Crouch-only, Runner escape valves |
| Escape gate (N wall) | Final objective |
| Healing shrine (far S) | One wound removed, long risky channel |

Seeded per match: which 3 of 7 seal anchors are live, door/barricade states, snare-able
choke props, small prop scatter, fog density, and which two crouch tunnels are open.
`?seed=12345` reproduces everything.

## 4. Phase order

1. **Scaffold + shared foundation** — configs, constants, types, rng, mapgen,
   collision, movement, matchRules. Unit-testable with zero rendering.
2. **Server** — rooms, lobby, roles, 30 Hz match sim, filtered snapshots.
3. **Client core** — renderer, camera, input, net prediction, playable grey-box.
4. **World art + VFX** — authored procedural Moonveil Ruins, materials, lighting,
   post chain, character models, event VFX.
5. **UI + audio** — all screens, HUD, procedural Web Audio.
6. **Abilities pass** — decoy, smoke, ward, blade, crossbow, pulse, snare, breach.
7. **Test + QA** — vitest units, Playwright two-context e2e, bot playtest, canvas
   inspection, screenshots, perf profiling, fixes.
8. **Docs + release** — README/CLAUDE/design/architecture/testing/progress, commit, push.

## 5. Performance budget (desktop tier)

| Metric | Target |
| --- | --- |
| Draw calls | ≤ 300 |
| Triangles | ≤ 750k |
| Geometries | ≤ 300 |
| Textures | ≤ 60 |
| Shadow-casting lights | 1 (directional moon) |
| Post passes beyond render+output | 2 (bloom, grade/vignette/grain) |
| DPR cap | 2 |

Strategy: `InstancedMesh` for every repeated prop (gravestones, hedges, pillars,
rubble, grass, lanterns), shared material kit, one shadow-casting light, no
transmission materials, pooled particle systems.

## 6. Acceptance gate

The build is done when two browser contexts can create/join a room, get opposing
roles, play a full match to each of the four endings (escape, capture, timeout,
disconnect), rematch with swapped roles — with typecheck, unit, e2e and production
build all green, and no console errors on the happy path.
