# Veil Hunt — Architecture

## Shape of the system

```
                  ┌─────────────────────────────────────────┐
                  │            src/shared/                  │
                  │  constants · types · protocol           │
                  │  validation · rng · mapgen              │
                  │  collision · movement · matchRules      │
                  │  contracts (hidden bonus objectives)    │
                  └──────────┬───────────────────┬──────────┘
                 imported by │                   │ imported by
                             ▼                   ▼
        ┌────────────────────────────┐   ┌───────────────────────────┐
        │       src/server/          │   │       src/client/         │
        │  index  RoomManager        │◀──│  NetClient                │
        │  Match  visibility  Bot    │──▶│  Predictor  Interpolator  │
        └────────────────────────────┘   │  GameClient  main         │
              authoritative              │  world entities systems ui│
                                         └───────────────────────────┘
```

`src/shared/` is the contract. Both processes import the same constants, the
same collision code and the same movement integrator, so there is exactly one
definition of how the game works.

## Server

### `RoomManager`
Owns room lifecycle: creation with a short readable code, joining, ready state,
role assignment, the role-reveal → countdown → active → results progression,
rematch (which increments the round and therefore flips roles), disconnect grace
and room reaping. It is driven by a fixed-rate `update(dt)` and emits UI-facing
events through a `RoomEvents` interface, so it never touches sockets directly.

### `Match`
The authoritative simulation, ticked at 30 Hz. It owns:

- both players' motion, stamina, cooldowns, charges and status effects
- seals, gate, shrine channels
- decoys, smoke, wards, snares, bolts, footprints, doors, barricades
- attack validation, wound escalation and the protection window
- victory evaluation and match statistics
- `buildSnapshot(playerId)` — a *filtered* view, per role

Discrete actions are handled on arrival; movement is applied by replaying the
client's queued `InputCommand`s through the shared `stepMovement()`.

### `visibility.ts`
The perception rules, and the reason the game is fair. `canPerceive()` gates on
range, line of sight (segment-vs-oriented-box against opaque walls), a generous
facing cone, smoke (which blocks along the sight line, not just at the
endpoints), and Runner concealment from hide spots, foliage and shadow. Every
concealment rule has a range at which it stops working, so hiding is never
invincibility.

### `Bot`
A server-side simulated client that emits the same `InputCommand` /
`ActionCommand` stream a browser would, so it exercises the identical
authoritative path. Used for solo practice and for automated playtests. It
steers with whisker probes and has a stuck-breaker; it deliberately has no
pathfinding, because a bot that gets stuck the way a naive player would is a
useful signal.

## Netcode

**Client → server:** batched `InputCommand`s at 30 Hz plus discrete actions.
Never a position.

**Server → client:** a filtered `WorldSnapshot` at 20 Hz.

### Prediction and reconciliation
`Predictor` applies each input locally the instant it is produced and banks it.
When a snapshot arrives it drops acknowledged inputs, rewinds to the
authoritative transform and replays the unacknowledged tail through the *same*
`stepMovement()` the server ran. Because the function is pure and deterministic,
the replay normally lands on the same result and the correction is invisible.
Look direction is never overwritten by the network — the mouse always wins.

### Remote interpolation
`RemoteInterpolator` buffers snapshots and renders the opponent 110 ms in the
past, interpolating between the two samples that bracket render time. It also
carries a `presence` value that fades the remote rig in and out, so a player
slipping behind cover dissolves rather than popping.

### Anti-cheat posture
This is a friendly two-person game, so there is no rollback netcode and no
competitive anti-cheat. What *is* enforced, because it protects the design:

- Positions are never accepted from clients.
- `dt` is clamped per command (`MAX_INPUT_DT`), so a lagging or malicious client
  cannot buy extra distance.
- Replayed sequence numbers are discarded.
- Attacks are validated for range, arc, cooldown and wall occlusion.
- Interactions are validated for range *and* line of sight.
- Every payload is type-checked and NaN/Infinity-rejected before use.
- Per-socket token buckets bound input, action and lobby message rates.

## Map generation

`generateMap(seed)` produces a `MapData` describing walls (oriented boxes with a
base and height), vaultable low obstacles, platforms, ramps, zones, hide spots,
crouch-only gates, doors, barricades, props, seal anchors and spawn points.

The navigational skeleton is hand-authored — chapel, graveyard, hedge maze,
flooded courtyard, watchtower, gate, shrine — so players can learn the space.
The seed varies which three of seven seal anchors go live, which crouch tunnels
are open, which barricades exist, prop scatter and fog density.

Collision is 2D circle-vs-oriented-box in the XZ plane with a floor-height
field sampled from platforms and ramps. There is no physics engine: gravity is a
scalar, the floor is always defined (so falling out of the world is impossible),
and step-up smooths ramp seams. This was chosen deliberately over Rapier —
the game needs broad, stable, reproducible collision shared byte-for-byte
between client and server, not rigid-body dynamics.

## Client

### `main.ts` — app shell
Owns the phase machine (`title → connecting → lobby → roleReveal → tutorial →
match ⇄ paused → results`), the RAF loop, and the wiring between net, UI, audio
and `GameClient`. It also merges automated-test input overrides in dev/e2e
builds.

### `GameClient` — one round
Builds the world for the round's seed, owns prediction, camera, the character
rigs, marker sync and event feedback. It diffs consecutive snapshots to fire
one-shot feedback (hitstop, camera trauma, screen flash, VFX, rumble, cooldown
chimes) and translates server sound events into positional audio plus the
directional visual indicators.

### Rendering
One `WebGLRenderer` with ACES tone mapping, a single shadow-casting directional
moon, and a short post chain: bloom (threshold 0.85, so only authored emissive
blooms) → a grade pass doing vignette, animated grain, the dread tint and impact
flashes → `OutputPass`. DPR is capped at 2 and steps down automatically if the
95th-percentile frame time misses budget for three seconds.

### Module contracts
`src/client/contracts.ts` defines `WorldHandles`, `CharacterRig`,
`MarkerSystem`, `VfxSystem`, `AudioSystem` and `UiSystem`. The app shell depends
on the interfaces, not the implementations, which is what let the world, UI and
audio subsystems be built independently against a fixed surface.

## Determinism

Everything that could vary routes through `createRng(seed)` (mulberry32): map
layout, prop scatter, contract assignment, audio pitch variation, VFX jitter and
ambient motion. Time-based effects are driven by accumulated game time passed
into `update(dt, elapsed)`, never `Date.now()`. This is what makes `?seed=12345`
reproduce a match and keeps bot playtests and screenshot baselines stable.

## Lifecycle and cleanup

Every subsystem exposes `dispose()`. `GameClient.dispose()` removes its groups
from the scene and disposes world geometry, materials, textures, marker pools,
particle buffers and character rigs. `RenderSystem.dispose()` tears down the
composer and forces context loss. `NetClient.dispose()` clears the ping timer and
removes every socket listener. The E2E playtest asserts that geometry and texture
counts do not creep upward across a long session.
