# Veil Hunt — Testing

## Commands

```bash
npm run typecheck                  # client + server tsconfigs, both must pass
npm run test                       # Vitest — deterministic logic, no browser
npm run test:e2e                   # Playwright — two browser contexts, real build
npm run inspect:canvas -- --url http://127.0.0.1:4173 --state active-runner
```

`npm run test:e2e` builds the client in `e2e` mode into **`dist/e2e-client`**
and the server, then serves both on `127.0.0.1:4173` with `VEIL_TEST_HOOKS=1`
and `VEIL_CLIENT_DIR` pointed at that directory.

The separate output directory matters: the E2E bundle enables
`window.__VEIL_HUNT_TEST__`, and it originally overwrote `dist/client`, so
running the test suite left a hook-enabled bundle behind for the next
`npm run start` to serve. `dist/client` is now only ever written by
`npm run build` and compiles the test-hook guard to `false`.

## Unit tests (Vitest, 95 tests)

Pure and near-pure logic, no rendering and no sockets.

**`matchRules.test.ts`** — wound progression and the capture rule, the
protection window, channel and movement penalties per wound level, blade
validation (range, arc boundary, wall occlusion, cooldown, protection), seal
counting, gate locking, all four victory outcomes and their precedence,
cooldowns never going negative, role assignment and rematch swapping.

**`validation.test.ts`** — name sanitisation (control characters, angle
brackets, length), room-code generation from the unambiguous alphabet and
collision-free uniqueness over 400 draws, and rejection of every malformed
payload shape: NaN, Infinity, wrong types, negative sequence numbers, oversized
and empty input batches, and unknown action kinds. Also asserts that oversized
`dt` and movement values are *clamped* rather than accepted.

**`mapgen.test.ts`** — seeded reproducibility (byte-identical maps for the same
seed), seal selection invariants, the fixed navigational skeleton surviving
across seeds, finite bounded geometry, collision resolution and floor sampling,
and line-of-sight blocking.

The important one: **connectivity**. For every seed it rasterises the walkable
area on a 0.8 m grid, flood-fills from the Runner spawn, and asserts that every
active seal, the gate, the shrine, the Hunter spawn and every hide spot is
reachable. This caught a real bug during development where `roomShell()` treated
doorway offsets as absolute coordinates, sealing the mausoleum and the
watchtower and spawning a huge unintended wall across the graveyard.

**`match.test.ts`** — integration against the real `Match` and `RoomManager`
classes the server runs:

- countdown blocks movement; the clock starts at seven minutes
- movement authority, replayed-sequence rejection, and no NaN under 900 ticks of
  adversarial input
- blade hits advance wounds exactly once; long-range attacks are rejected; the
  protection window blocks a follow-up; three hits capture
- seals channel, decay when released, and the third opens the gate
- the gate stays locked and un-channelable until all three seals burn
- escape, capture and timeout endings
- crossbow marking, expiry, ammo consumption and reload
- **information hiding**: no transform through a wall, snares hidden from the
  Runner, wards hidden from the Hunter, traces only to the Hunter
- disconnect cleanup and lobby/room lifecycle including reconnect
- a **bot soak**: a full match driven by two bots asserting no NaN, no leaving
  the map, no negative cooldowns and bounded entity counts
- a **progression check**: a scripted bot Runner must light at least two seals,
  proving the objective is findable and reachable

## End-to-end tests (Playwright)

Two genuinely independent browser contexts — separate storage, separate sockets.

**`multiplayer.spec.ts`**

| Scenario | What it proves |
| --- | --- |
| Create + join + ready | Room codes work, roles are opposing, both clients share a seed |
| Join a bad code | A clear error, not a hang |
| Synchronized state | Seals, gate and timer agree across clients |
| Movement visibility | One client's motion appears on the other when in sight |
| Local movement | Input actually moves the player, transforms stay finite |
| Boundary collision | Four directions of sustained sprinting cannot leave the map or fall through the floor |
| No console errors | The happy path is clean |
| Long-range attack | Rejected by the server |
| Valid blade hit | Advances the wound exactly once |
| Protection window | Blocks an immediate second hit |
| Third hit | Captures, and both clients reach results |
| Seal activation | Runner lights a seal; the Hunter receives the global cue |
| Gate locking | Locked and reported blocked until all three seals burn |
| Escape | Runner wins; results synchronized on both clients |
| Timeout | Hunter wins when the clock expires |
| Rematch | Roles swap |
| Disconnect | The surviving client keeps rendering and resolves cleanly |

**`playtest.spec.ts`** — the bot playtest and render health:

- A 60-second scripted session sweeping headings, sprinting, crouching,
  vaulting, interacting and firing every ability. Asserts per-step: no NaN
  transforms, never outside the map, never below the floor or launched into the
  air, no negative cooldowns, and bounded entity counts.
- Aggregate: frames advanced, the timer is not frozen, scripted input produced
  real distance, softlock windows stay below half the samples, geometry and
  texture counts do not creep (leak detection), and the canvas never went blank.
  Writes `artifacts/playtest/bot-playtest.json`.
- **Render budget**: samples the renderer from eight headings while sprinting
  and asserts the worst-case view stays within 300 draw calls and 750k
  triangles.
- **Canvas health**: non-blank frames with real colour variety and legible mean
  luminance during actual gameplay.

## Canvas inspector

`scripts/inspect-canvas.mjs` launches GPU-backed Chromium, drives the game to a
named state through the test hooks, screenshots it and reports objective pixel
metrics (colour entropy, edge density, luminance contrast, dominant-colour
share) plus renderer diagnostics compared against the render budget. It exits
non-zero on a blank canvas or any page error.

States: `menu`, `lobby`, `active-runner`, `active-hunter`.

## Test hooks

`window.__VEIL_HUNT_TEST__` is installed only when `import.meta.env.DEV` or
`MODE === 'e2e'`. It exposes:

- `state()` — screen, role, room code, seed, phase, timer, seals, gate, wound,
  cooldowns, charges, interaction prompt, opponent visibility, frame count
- `transform()`, `seals()`, `snapshot()`, `net()`, `renderer()`, `world()`
- `canvas()` — a `readPixels` probe returning non-blank, unique colours and
  mean luminance
- `errors()` — captured window errors and unhandled rejections
- `input.*` — move, look, interact, vault, action, stop
- `lobby.*` — create, join, ready, addBot, rematch, returnToLobby
- `debug(kind, value)` — deterministic state forcing

**It never exposes hidden opponent information.** `snapshot()` returns the same
filtered snapshot the client actually received, so if the Hunter should not know
where the Runner is, the test hook cannot reveal it either.

Server-side state forcing (`activateAllSeals`, `placeAdjacent`,
`separatePlayers`, `teleportRunnerToGate`, `teleportRunnerToSeal`,
`setTimeRemaining`, `clearProtection`, `woundRunner`, `skipCountdown`) is
registered **only** when the server starts with `VEIL_TEST_HOOKS=1`. A normal
`npm run start` has no such handler.

## What is deliberately not tested automatically

- Audio *content* (that a bell sounds like a bell). Node graph hygiene and
  absence of exceptions are covered; timbre is a listening judgement.
- Gamepad input, which needs real hardware. Keyboard and mouse are complete and
  covered.
- Real-network latency and packet loss. Tests run over loopback.
