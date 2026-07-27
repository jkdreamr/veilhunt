# Veil Hunt — Progress

Living status log. Updated as work lands so the task survives context loss.

## Status: complete and verified

| Phase | State | Evidence |
| --- | --- | --- |
| 1. Scaffold + shared foundation | **done** | `src/shared/*` typechecks clean |
| 2. Authoritative server | **done** | full match sims in ~300 ms, no NaN/leaks |
| 3. Client core + netcode | **done** | Renderer, camera, input, prediction, interpolation, app shell |
| 4. World art, characters, VFX | **done** | 135 draw calls / 126k triangles in active play |
| 5. UI + audio | **done** | 11 screens, role-aware HUD, 48 procedural synth voices |
| 6. Tests, QA, release | **done** | 96 unit + 20 e2e green; 23 states screenshotted |

## Built

### Shared (`src/shared/`) — the canonical schema
`constants.ts` (every tunable), `types.ts` (match-state schema), `protocol.ts`
(socket events), `validation.ts` (runtime payload guards), `rng.ts` (mulberry32),
`mapgen.ts` (Moonveil Ruins from a seed), `collision.ts` (circle-vs-OBB, floor
sampling, line of sight), `movement.ts` (the one integrator both sides run),
`matchRules.ts` (pure rules), `contracts.ts` (hidden bonus objectives).

### Server (`src/server/`)
`index.ts` (Express + Socket.IO, serves `dist/client` in production, prints LAN
URLs, per-socket rate limiting, env-gated test hooks), `RoomManager.ts` (rooms,
ready, roles, rematch, disconnect grace, reaping), `Match.ts` (30 Hz
authoritative sim, filtered snapshots), `visibility.ts` (perception rules),
`Bot.ts` (simulated second client), `roomCode.ts`.

### Client (`src/client/`)
`main.ts` (phase machine + loop), `GameClient.ts` (one round), `core/`
(Renderer + post chain, CameraRig, Input, Settings), `net/` (NetClient,
Predictor, Interpolator), `world/` (palette, textures, materials, props, sky,
WorldBuilder), `entities/` (Characters, Markers), `systems/` (Audio, synth,
Vfx), `ui/` (Ui, screens, hud), `test/hooks.ts`.

### Tooling
`scripts/dev.mjs` (dual-process launcher with LAN URLs), `scripts/e2e-server.mjs`
(builds + serves for Playwright with `VEIL_TEST_HOOKS=1`),
`scripts/inspect-canvas.mjs` (pixel metrics + render budget).

## Bugs found and fixed during development

1. **Sealed rooms and a phantom wall.** `roomShell()` treated doorway openings as
   absolute world coordinates while every call site passed centre-relative
   offsets. Result: the mausoleum and watchtower were completely sealed, some
   seals were unreachable, and a ~26 m unintended wall was generated across the
   graveyard. Found by a grid flood-fill audit, not by looking at the code.
   Fixed by making offsets relative to each wall's midpoint and clamping them
   inside the wall. Now locked down by `mapgen.test.ts`, which flood-fills every
   seed and asserts 100% reachability of all objectives.
2. **Seal progress froze instead of decaying.** `interactStop` cleared the
   channel kind to `'none'`, which made `decayChannel()` return early, so a
   Runner could bank partial progress on a seal indefinitely. Fixed by keeping
   the channel record and letting decay run.
3. **Crossbow could soft-lock the Hunter.** Auto-reload required every bolt to
   have landed first, so a Hunter out of ammo with bolts still in flight could
   wait a long time. Simplified to reload whenever empty.
4. **Garbled `resolveCircleBox` return.** A malformed expression
   (`px === px ? … : …`) in the collision push-out. Fixed before it shipped.
5. **Raw ANSI control bytes in source.** Replaced with `\u001b` escapes.

6. **The third-person camera was in front of the player.** `CameraRig` derived
   its look direction with inverted X/Z signs, so the camera sat along the facing
   direction instead of behind it — every frame showed the player from the front
   with the world behind them. Found by looking at a real gameplay screenshot,
   not by reading the code.
7. **Renderer diagnostics measured only the last post pass.** `renderer.info`
   auto-resets per draw call, so with an EffectComposer chain the reported counts
   were 1 draw call and 1 triangle — the final full-screen quad. The
   render-budget check was therefore meaningless. Fixed with
   `info.autoReset = false` plus a manual reset each frame; the real numbers are
   ~135 calls / ~126k triangles.
8. **The canvas non-blank probe always read black.** WebGL clears the drawing
   buffer after compositing, so a later `readPixels` returned zeros even though
   the frame was fine. Fixed by enabling `preserveDrawingBuffer` in dev/E2E
   builds only.
9. **Every surface was near-black.** Albedo maps were authored mid-grey *and*
   multiplied by mid-grey palette colours, collapsing stone to ~0.02 linear.
   Textures are now near-white detail modulations with the palette colour as the
   real albedo.
10. **Spawns faced a wall.** Both players opened the match staring at masonry a
    few metres away. A clearance scan across all seeds found positions with a
    40 m+ open sightline into the ruins; spawns moved to `(16, 42)` and
    `(0, -26)`.
11. **WebGL contexts were never released on page unload.** Browsers cap live
    contexts per process, so a long Playwright run starved later pages and the
    client silently failed to boot. Fixed with a `pagehide` teardown.
12. **Chain-hit protection was too short to observe.** `HIT_PROTECTION` (3.2 s)
    only just exceeded a full blade cycle (2.88 s), leaving a 0.66 s window. Now
    4 s, so the Runner reliably gets a beat to disengage, with a unit test
    asserting the invariant directly.
13. **The seal activation beam whited out the screen.** An 11 m additive pillar
    with the Runner standing inside it (which they must, for seven seconds)
    filled the frame with white and hid the Hunter walking up behind them. The
    beam and aura now fade by proximity — they are long-range landmarks, not
    something you stand in.
14. **Rematch was unreachable at 1280×800.** The results tally pushed both
    action buttons below the fold, so after every match the player had to
    discover an internal scroll to start another. The tally now scrolls
    internally and the action row is pinned to the bottom. Verified visible at
    1280×800, 1440×900 and 900×700.
15. **`npm run test:e2e` left debug hooks in the production bundle.** The E2E
    build wrote to `dist/client`, so a later `npm run start` served a
    hook-enabled client. E2E now builds to `dist/e2e-client` and the harness
    points the server at it with `VEIL_CLIENT_DIR`; `dist/client` compiles the
    guard to `false` and exposes neither global at runtime.

## Verification log

- `npm run typecheck` — clean (client + server)
- `npm run test` — 95/95 passing
- Headless bot soak — full 7-minute match in ~300 ms wall time, no NaN, no
  out-of-bounds, no negative cooldowns, entity counts bounded under 100
- Map reachability — 100% of walkable space reachable on seeds 1, 12345, 777,
  99999, 424242; every seal, gate, shrine, spawn and hide spot reachable

## Final verification results

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass (client + server) |
| `npm run test` | 96/96 pass |
| `npm run build` | pass — 106 kB app + 142 kB three.js gzipped |
| `npm run test:e2e` | 20/20 pass in 7.7 min on a settled machine |
| `git diff --check` | clean, no binary or oversized files |
| Production `npm run start` | serves built client + sockets on 8787, LAN URL printed |
| Production human path | name → room → bot → ready → reveal → tutorial → play → pause → quit, driven entirely through real UI clicks and WASD/mouse, zero console errors |
| Debug hooks in production bundle | absent (`IS_TEST_BUILD` compiles to `false`; neither global exists at runtime) |

Render diagnostics in active play (Apple M3 Pro, GPU-backed Chromium, 1280×800):
135 draw calls, 126k triangles, 73 geometries, 42 textures — all inside the
desktop budget of 300 / 750k / 300 / 60.

Pixel metrics: colour entropy 4.66–4.88 bits, dominant-colour share 0.115–0.142,
edge density 0.53–0.69, luminance contrast 225–243. No blank frames.

Bot playtest (60 s scripted session): 7120 frames advanced, 237 m travelled,
1 softlock window of 29 samples, max 3 live entities, geometry growth 6,
texture growth 0, zero blank samples, zero console errors.

## Known limitations

- Desktop-first; no touch controls (menus reflow to 900 px, gameplay does not).
- Two players per room; no spectators, matchmaking or persistence.
- Rooms are in-memory — restarting the server ends matches in progress.
- LAN or same-machine only; no relay for internet play.
- Gamepad support is wired and functional but tuned for keyboard and mouse.
- Playwright runs are sensitive to machine load: on a box already at load
  average 7+, match-start can exceed the 45 s helper timeout. Run the suite on
  an idle machine.
