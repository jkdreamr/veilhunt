# Veil Hunt

A 3D asymmetric two-player hide-and-hunt game that runs in the browser.

One player is the **Hunter**. The other is the **Runner**. The Runner must light
three ritual seals hidden in a moonlit ruin and escape through the gate before
seven minutes are up. The Hunter must track them down and cut them off — but is
never told where they are. Every scrap of knowledge is earned: a footprint in
the mud, a sprint heard across flagstones, a door left swinging, a crossbow bolt
that found its mark.

Built with TypeScript, Vite, Three.js, Express and Socket.IO. All art, geometry,
textures and audio are generated procedurally at runtime — there are no asset
files, no external services, no accounts and no API keys.

---

## Quick start

```bash
npm install
npm run dev
```

Open the printed **Play here** URL. To play alone, create a room and click
**Add practice bot**.

## Playing with a friend on the same Wi-Fi

`npm run dev` binds to `0.0.0.0` and prints both a localhost URL and a LAN URL:

```
  VEIL HUNT — development

  Play here      http://localhost:5188
  Second player  http://192.168.1.42:5188

  Both computers must be on the same Wi-Fi. Share the LAN URL and the
  4-letter room code.
```

1. You open the **Play here** URL, enter a name, and click **Create Room**.
2. Read out the four-character room code (it uses an unambiguous alphabet —
   no `0`/`O` or `1`/`I` confusion).
3. Your friend opens the **Second player** URL on their computer, enters a
   name, clicks **Join Room** and types the code.
4. Both click **Ready**. Roles are assigned automatically and revealed
   privately. A rematch swaps them.

If the second computer cannot reach the URL, it is almost always the host's
firewall. On macOS, allow incoming connections for `node` when prompted. On
Windows, allow Node.js on private networks.

## Production

```bash
npm run build
npm run start
```

`npm run start` serves the built client **and** the multiplayer server from a
single process on port `8787`, and prints its localhost and LAN URLs the same
way. Set `PORT` or `VEIL_SERVER_PORT` to change it.

## All commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Game server + Vite dev server, bound to `0.0.0.0`, prints LAN URLs |
| `npm run build` | Builds the client to `dist/client` and the server to `dist/server` |
| `npm run start` | Production: serves the built client and the socket server together |
| `npm run typecheck` | Type-checks the client and server projects |
| `npm run test` | Vitest — deterministic game-logic tests |
| `npm run test:e2e` | Playwright — two browser contexts against a real build |
| `npm run inspect:canvas` | Screenshots the running game and reports render diagnostics |

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move (camera-relative) |
| Mouse | Look and aim |
| `Shift` | Sprint (costs stamina) |
| `Ctrl` or `C` | Crouch — slower, much quieter |
| `Space` | Vault a low obstacle |
| `E` (hold) | Interact: seals, gate, shrine, doors, breach, escape a snare |
| `Esc` | Pause, settings, release the cursor |

| | Left click | Right click | `Q` | `F` | `R` |
| --- | --- | --- | --- | --- | --- |
| **Hunter** | Ritual Blade | Marking Crossbow | Tracking Pulse | Snare | Reload |
| **Runner** | Throw stone | Flash Ward | Echo Decoy | Veil Smoke | — |

Standard gamepads are supported for movement, look and the main actions.
Keyboard and mouse are the complete, primary control scheme.

## How a round plays

**As the Runner** you are faster in a sprint but run out of breath quickly. Your
job is to reach three ritual seals and channel each one for about seven seconds
— a long, loud, stationary commitment. When the third lights, a bell rings
across the whole map and the Hunter knows exactly what is at stake. Then you
have to reach the gate and hold it for six more seconds.

You have three tools and none of them let you fight: an **Echo Decoy** that
walks away making real footstep noise, **Veil Smoke** that breaks line of sight
and blinds the Hunter's tracking pulse, and two **Flash Wards** that stun a
careless Hunter and give you a burst of speed. You can also throw a stone to
make noise somewhere you are not.

Getting hit does not kill you. It moves you **Unmarked → Wounded → Cursed**.
Only a blade hit while Cursed ends the match. Each stage makes you breathe
louder, glow brighter and channel slower. A shrine in the far south will remove
one wound — but it takes nine seconds, makes noise, and sits in a dead end.

**As the Hunter** you are relentless rather than fast. You have a **Ritual
Blade** with a visible wind-up and a real recovery, a **Marking Crossbow** with
three dodgeable bolts that mark rather than wound, a **Tracking Pulse** that
lights up recent footprints, three **Snares**, and the ability to **Breach**
barricaded shortcuts — loudly.

You are never given the Runner's position. You find them.

## Accessibility

- **Every important sound has a visual indicator.** Directional arcs at the
  screen edge point at footsteps, combat and rituals, tinted by category. The
  game is fully playable muted.
- Separate master / ambience / effects volume sliders, plus mute.
- Adjustable mouse sensitivity and invert-Y.
- Reduced camera shake and a reduced-motion option (which also honours your OS
  preference on first run).
- Wound state uses distinct shapes and text labels, not colour alone.
- High-contrast interaction prompts.
- All menus are keyboard-navigable with visible focus rings.

## Map — Moonveil Ruins

A compact 132 × 132 m ruin with a hand-authored skeleton you can learn: a
**ruined chapel** at the centre, a **graveyard** in soft mud where footprints
betray you, a **hedge maze** that conceals a crouching Runner, a **flooded
courtyard** that is loud to cross, a **broken watchtower** with a raised
balcony, **crouch-only undercroft tunnels** the Hunter physically cannot follow
you through, the **escape gate** on the north wall and the **healing shrine** in
the far south.

Seven seal anchors exist; three go live each match. The seed also decides which
tunnels are open, which barricades exist, prop scatter and fog density. Add
`?seed=12345` to the URL to reproduce a specific match.

## Architecture in one paragraph

`src/shared/` holds the canonical schema and all the rules — constants, types,
the socket protocol, payload validation, seeded RNG, map generation, collision
and the movement integrator — and is imported by both the client and the server,
so there is exactly one definition of how the game works. The server is
authoritative for everything that decides the outcome and sends each player a
snapshot **filtered by perception rules**, so a client literally does not receive
the opponent's position when it should not know it. Movement feels immediate
because the client predicts with the same pure function the server runs, then
reconciles by replaying unacknowledged inputs.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for detail,
[`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) for design intent and
[`docs/TESTING.md`](docs/TESTING.md) for the test strategy.

## Known limitations

- **Desktop-first.** It runs on a tablet in landscape, and the menus reflow down
  to narrow windows, but there are no touch controls — this is a keyboard-and-
  mouse game.
- **Two players per room**, by design. There is no spectator mode.
- **No matchmaking or persistence.** Rooms live in server memory and disappear
  when empty; there is no database and no accounts. Restarting the server ends
  any match in progress.
- **LAN or same-machine play.** There is no relay server, so playing over the
  internet needs your own hosting or a tunnel.
- **Reconnection** works while a match is running (a 45-second grace window) but
  a player who reloads the page mid-match rejoins by re-entering the same name
  and room code.
- **Gamepad support is best-effort** — it is wired and works, but the game is
  tuned and tested for keyboard and mouse.
- Audio is entirely synthesised, so it is atmospheric rather than cinematic.

## Licence

MIT. All assets are generated at runtime; nothing third-party is bundled beyond
the npm dependencies listed in `package.json`.
