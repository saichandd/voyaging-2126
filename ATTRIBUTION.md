# Asset Attribution

Voyaging 2126 renders its planets, Sun, sky, and image-based lighting from real
texture maps. All spacecraft, the colony, the asteroid belt, and every surface
detail map (panel normals, window grids) are still generated procedurally in code.

The texture assets in [`textures/`](textures/) are used under the licenses below.

## Solar System Scope — CC BY 4.0

Mars, Sun, and Milky Way maps. © [Solar System Scope](https://www.solarsystemscope.com/textures/),
licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

- `2k_mars.jpg` — Mars albedo
- `2k_sun.jpg` — Sun photosphere
- `2k_stars_milky_way.jpg` — Milky Way panorama

## three.js examples — MIT (imagery: NASA, public domain)

Earth maps, from the [three.js](https://github.com/mrdoob/three.js) example assets
([MIT License](https://github.com/mrdoob/three.js/blob/dev/LICENSE)). The underlying
imagery is derived from NASA Visible Earth / Blue Marble, which is in the public domain.

- `earth_atmos_2048.jpg` — surface color
- `earth_normal_2048.jpg` — surface normals
- `earth_specular_2048.jpg` — ocean specular / land roughness
- `earth_clouds_2048.png` — cloud layer (alpha)
- `earth_lights_2048.png` — night-side city lights

## Poly Haven — CC0

- `studio_env_2k.hdr` — HDRI used for image-based reflections on spacecraft metals.
  From [Poly Haven](https://polyhaven.com/), released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain).
