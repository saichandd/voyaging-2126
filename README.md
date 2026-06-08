# Voyaging 2126 · Inner System Travel Atlas

An interactive, stylized **Three.js** space-travel simulator that flies a guided
**Earth → Mars** tourist voyage — built to demonstrate **Newton's** and **Kepler's**
laws of motion in a watchable way.

The transfer is a real Hohmann ellipse timed by **Kepler's equation**
(`M = E − e·sin E`, solved with Newton–Raphson), so the spacecraft visibly slows as
it climbs toward Mars — Kepler's 2nd law made visible. Telemetry uses the canonical
Earth→Mars numbers (≈32.7 → 21.5 km/s, 1.00 → 1.52 AU, ≈259-day transit).

## The voyage (5 stages, ~2 min total)

1. **Launch** — rocket ascent through a constellation of satellites circling Earth.
2. **Cruise** — staging (separate-then-ignite), then an 8-month coast with a spinning
   habitat ring for artificial gravity.
3. **Approach** — the Sun-centred transfer map; the ship slows nearing Mars (Kepler II).
4. **Entry, Descent & Landing** — a guided, shallow hypersonic entry (bow shock +
   plasma wake) → supersonic parachute → heat-shield jettison → retro-braked,
   dust-kicking touchdown.
5. **Surface Operations** — a Mars colony (landed Starship, pressurised domes,
   habitat modules, solar arrays, rover).

## Run it

No build step — just serve the folder and open it:

```bash
python3 serve.py
# → http://localhost:5173
```

`serve.py` is a tiny static server that sends `Cache-Control: no-store` so edits
show up on reload (ES-module imports otherwise cache aggressively).

## Controls

- **Voyage Simulator** panel (top-right): click any stage to jump to it.
- **Play / Replay** controls, or **Space** to play/pause, **Esc** to exit.
- Playback auto-advances through all five stages with a per-stage progress bar.

## Tech

- [Three.js](https://threejs.org/) r0.160 (via unpkg import map) — WebGL, custom
  shader materials, sprites, `EffectComposer` + `UnrealBloom` post-processing,
  HDRI image-based lighting (PMREM), `OrbitControls`.
- Planets, Sun, sky, and reflections render from real texture maps; spacecraft, the
  colony, the asteroid belt, and all surface detail maps (panel normals, window
  grids) are still built procedurally from primitives. Texture credits and licenses:
  [ATTRIBUTION.md](ATTRIBUTION.md).
