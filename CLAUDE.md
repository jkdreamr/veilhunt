# CLAUDE.md — Veil Hunt

A 3D asymmetric two-player browser game. One Hunter, one Runner, seven minutes,
one moonlit ruin. TypeScript + Vite + Three.js on the client, Node + Express +
Socket.IO on the server.

## Commands

```bash
npm install
npm run dev         # game server + Vite, bound to 0.0.0.0, prints LAN URLs
npm run typecheck   # client tsconfig + server tsconfig, both must pass
npm run test        # Vitest, deterministic game-logic tests (no browser)
npm run build       # vite build (dist/client) + tsc (dist/server)
npm run test:e2e    # Playwright, two browser contexts against a real build
npm run start       # production: serves dist/client AND the socket server
npm run inspect:canvas -- --url http://127.0.0.1:4173 --state active-runner
```

**Run `npm run typecheck && npm run test` before every commit.** Run
`npm run test:e2e` before committing anything that touches netcode, match rules,
the client state machine or the UI flow.

## Architecture rules

- **`src/shared/` is the single source of truth.** Constants, types, the socket
  protocol, RNG, map generation, collision, movement and match rules all live
  there and are imported by *both* the client and the server. Never duplicate a
  tunable number — add it to `src/shared/constants.ts`.
- **The server is authoritative** for room state, match state, the timer, role
  assignment, seals, the gate, attacks, wounds, cooldowns, victory and rematch.
  The client sends *intent* only; it never sends a position.
- **Movement runs the same pure function on both sides.** `stepMovement()` in
  `src/shared/movement.ts` is called by the server to decide truth and by
  `Predictor` to predict locally, then replayed on reconciliation.
- **Snapshots are filtered per role.** `buildSnapshot(playerId)` in
  `src/server/Match.ts` uses `src/server/visibility.ts` to decide what each
  player may know. The Hunter's socket must never receive the Runner's transform
  unless perception rules genuinely allow it. If you add a field to
  `WorldSnapshot`, ask whether it leaks position.
- **All randomness goes through `createRng()`** from `src/shared/rng.ts`.
  `Math.random()` is banned in shared, server and gameplay client code — it
  breaks seeded reproduction (`?seed=12345`), screenshot baselines and bot
  playtests. The only permitted use is `randomSeed()` itself.
- **Validate every inbound payload** in `src/shared/validation.ts` before it
  reaches match state. NaN, Infinity, oversized arrays and unknown action kinds
  must all be rejected.
- **Clean up.** Every system exposes `dispose()` and must release listeners,
  geometries, materials, textures, audio nodes, timers and RAF handles.

## Client module boundaries

`src/client/contracts.ts` defines the interfaces between subsystems. The app
shell (`main.ts`) owns the loop and calls into world / characters / markers /
VFX / UI / audio; those modules never reach back into netcode or each other.

```
main.ts          app state machine, RAF loop, wiring
GameClient.ts    one round: prediction, camera, scene sync, event feedback
core/            Renderer (+post), CameraRig, Input, Settings
net/             NetClient, Predictor (reconciliation), Interpolator
world/           Moonveil Ruins geometry, materials, textures, sky
entities/        character rigs, gameplay markers
systems/         Audio (procedural Web Audio), Vfx (pooled particles)
ui/              screens + HUD, semantic DOM, no framework
test/            window.__VEIL_HUNT_TEST__, dev/e2e builds only
```

## Test hooks

`window.__VEIL_HUNT_TEST__` exists only when `import.meta.env.DEV` or
`MODE === 'e2e'`. It exposes the *local* client's state, renderer stats and a
canvas non-blank probe — never hidden opponent information.

Server-side deterministic state forcing (`activateAllSeals`, `placeAdjacent`,
`setTimeRemaining`, …) is reachable only when the server is started with
`VEIL_TEST_HOOKS=1`. A normal `npm run start` does not register that handler at
all.

**The E2E build is written to `dist/e2e-client`, not `dist/client`.** That
separation is deliberate: `npm run test:e2e` used to overwrite the production
bundle with a hook-enabled one, so a later `npm run start` would have shipped
debug hooks. The E2E server points at it via `VEIL_CLIENT_DIR`. Verify with:

```bash
npm run build && node -e "…"   # dist/client must compile IS_TEST_BUILD to false
```

## Performance budget

Desktop worst-case active view: ≤ 300 draw calls, ≤ 750k triangles, ≤ 300
geometries, ≤ 60 textures, 1 shadow-casting light, 2 post passes, DPR capped at
2. `tests/e2e/playtest.spec.ts` enforces the draw-call and triangle limits.
Prefer `InstancedMesh` and shared materials over new draw calls.

## Gotchas

- Relative imports **must** end in `.js` (the server build emits real Node ESM).
- Playwright must use `channel: 'chromium'` and `workers: 1` — the default
  headless shell silently falls back to CPU rendering and parallel contexts
  fight over the GPU.
- Do not put raw ANSI control bytes in source; write them as \u001b escapes.
- The map's `roomShell()` opening offsets are relative to each wall's midpoint.
  Getting this wrong seals rooms — `tests/unit/mapgen.test.ts` flood-fills every
  seed and will catch it.
