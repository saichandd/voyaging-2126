/* ============================================================
   Voyaging 2126 // Inner System Travel Atlas
   A realistic inner-system view with a guided, physics-driven
   Earth → Mars voyage you can sit back and watch.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ============================================================
// 1. CORE SETUP
// ============================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// EffectComposer + OutputPass handles tonemapping — keep render passes linear so
// bloom samples HDR values correctly.
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000206);
scene.fog = new THREE.FogExp2(0x000510, 0.00025);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 8000);
camera.position.set(180, 110, 240);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 6;
controls.maxDistance = 1800;
controls.target.set(0, 0, 0);
controls.autoRotate = true;       // gentle attract-mode drift while idle
controls.autoRotateSpeed = 0.3;

// Post-processing
// HDR-capable render target so bloom can sample values > 1.0
const hdrTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType,
  colorSpace: THREE.LinearSRGBColorSpace,
});
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 0.95);
composer.addPass(bloom);
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ============================================================
// 2. UTILITIES
// ============================================================
const clock = new THREE.Clock();
const TAU = Math.PI * 2;

function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Hex color literals are sRGB; ShaderMaterial uniforms operate on linear values
// so we convert here. (Built-in materials do this implicitly.)
function linearColor(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

// Shared GLSL noise helpers for shader materials
const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * vnoise(p);
      p *= 2.07;
      a *= 0.5;
    }
    return v;
  }
  float ridged(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }
`;

// ============================================================
// 3. STARFIELD
// ============================================================
function buildStarfield(count, radius) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = radius * (0.55 + Math.random() * 0.45);
    const t = Math.random() * TAU;
    const p = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(p) * Math.cos(t);
    positions[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    positions[i * 3 + 2] = r * Math.cos(p);
    const c = new THREE.Color();
    const v = Math.random();
    // Realistic stellar colours: mostly white / blue-white, some warm.
    if (v < 0.7)      c.setHSL(0.58, 0.10, 0.78 + Math.random() * 0.22);
    else if (v < 0.9) c.setHSL(0.13, 0.28, 0.75 + Math.random() * 0.2);
    else              c.setHSL(0.07, 0.45, 0.7);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6, vertexColors: true, sizeAttenuation: false,
    transparent: true, opacity: 0.95,
    map: radialTexture(['rgba(255,255,255,1)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)'], 64),
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

scene.add(buildStarfield(9000, 3000));

// ============================================================
// 4. SUN
// ============================================================
const sunGroup = new THREE.Group();
scene.add(sunGroup);

const sunRadius = 9;
const sunUniforms = { uTime: { value: 0 } };
const sunMat = new THREE.ShaderMaterial({
  uniforms: sunUniforms,
  vertexShader: /* glsl */ `
    varying vec3 vPosition;
    varying vec3 vNormal;
    void main() {
      vPosition = position;
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    varying vec3 vPosition;
    varying vec3 vNormal;
    ${NOISE_GLSL}
    void main() {
      vec3 p = vPosition * 0.18;
      float n1 = fbm(p + vec3(uTime * 0.07));
      float n2 = ridged(p * 1.5 - vec3(uTime * 0.05));
      float surface = mix(n1, n2, 0.55);
      vec3 cool = vec3(0.85, 0.18, 0.02);
      vec3 mid  = vec3(1.0, 0.55, 0.12);
      vec3 hot  = vec3(1.0, 0.95, 0.7);
      vec3 col = mix(cool, mid, smoothstep(0.25, 0.65, surface));
      col = mix(col, hot, smoothstep(0.55, 0.92, surface * surface));
      float fres = pow(1.0 - max(0.0, dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
      col += vec3(1.0, 0.55, 0.18) * fres * 0.55;
      gl_FragColor = vec4(col * 1.6, 1.0);
    }
  `,
});
const sun = new THREE.Mesh(new THREE.SphereGeometry(sunRadius, 96, 96), sunMat);
sunGroup.add(sun);

// Sun corona (sprite stack for soft halo)
function addCoronaSprite(scale, opacity, stops) {
  const m = new THREE.SpriteMaterial({
    map: radialTexture(stops, 256),
    blending: THREE.AdditiveBlending, transparent: true,
    opacity, depthWrite: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(scale);
  sunGroup.add(s);
  return s;
}
// A single, tight corona glow (the extra outer haze layers were removed).
addCoronaSprite(sunRadius * 3.4, 0.9, ['rgba(255,210,120,0.85)', 'rgba(255,140,40,0.35)', 'rgba(255,90,30,0)']);

// Lighting
const sunLight = new THREE.PointLight(0xffd9a8, 4.2, 0, 1.2);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x182842, 0.55));
const fillLight = new THREE.DirectionalLight(0x4a6088, 0.25);
fillLight.position.set(-1, 0.5, -1);
scene.add(fillLight);

// ============================================================
// 5. PLANET FACTORY (procedural shader)
// ============================================================
function makePlanetMaterial({ base, accent, polar, scale, ridges = false, banded = false, glow = 0.0 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBase: { value: linearColor(base) },
      uAccent: { value: linearColor(accent) },
      uPolar: { value: linearColor(polar) },
      uScale: { value: scale },
      uLightPos: { value: new THREE.Vector3(0, 0, 0) },
      uRidges: { value: ridges ? 1.0 : 0.0 },
      uBanded: { value: banded ? 1.0 : 0.0 },
      uGlow: { value: glow },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3  uBase;
      uniform vec3  uAccent;
      uniform vec3  uPolar;
      uniform float uScale;
      uniform vec3  uLightPos;
      uniform float uRidges;
      uniform float uBanded;
      uniform float uGlow;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      ${NOISE_GLSL}
      void main() {
        vec3 nPos = normalize(vLocalPos);
        vec3 p = nPos * uScale;
        float n = fbm(p);
        float r = ridged(p * 1.5);
        // Latitude-banded variation for gas giants
        float bandLat = nPos.y;
        float bands = sin(bandLat * 14.0 + fbm(p * 2.5) * 2.4) * 0.5 + 0.5;
        float surface = mix(mix(n, r, uRidges), bands, uBanded);
        vec3 col = mix(uBase, uAccent, smoothstep(0.35, 0.7, surface));
        float detail = fbm(p * 5.0);
        col = mix(col, col * 0.7, smoothstep(0.4, 0.7, detail) * 0.4);
        // Polar caps (suppressed on gas giants)
        float lat = abs(nPos.y);
        float pcap = smoothstep(0.78, 0.95, lat + fbm(p * 3.0) * 0.07) * (1.0 - uBanded * 0.7);
        col = mix(col, uPolar, pcap);
        // Light
        vec3 L = normalize(uLightPos - vWorldPos);
        float ndl = max(0.0, dot(vNormal, L));
        float light = pow(ndl, 0.85) * 0.92 + 0.08;
        col *= light;
        // Subtle rim
        vec3 V = normalize(cameraPosition - vWorldPos);
        float rim = pow(1.0 - max(0.0, dot(vNormal, V)), 3.0) * (0.25 + uGlow);
        col += uAccent * rim * 0.6;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Atmospheric fresnel shell — FrontSide so we can compute true view-vs-normal
// fresnel; bright only at the silhouette where dot(N,V) → 0.
function makeAtmosphere(radius, color, intensity = 1.0) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uColor: { value: linearColor(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = 1.0 - max(0.0, dot(vNormal, V));
        fres = pow(fres, 3.5);
        gl_FragColor = vec4(uColor * fres * uIntensity, fres);
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 64), mat);
}

// Cloud layer (Earth-style)
function makeCloudLayer(radius, color = 0xffffff) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 96),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: linearColor(color) } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vLocal;
        varying vec3 vWorld;
        void main() {
          vLocal = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec3 vNormal;
        varying vec3 vLocal;
        varying vec3 vWorld;
        ${NOISE_GLSL}
        void main() {
          vec3 p = normalize(vLocal) * 4.0;
          float n = fbm(p + vec3(uTime * 0.012, 0.0, uTime * 0.005));
          float n2 = fbm(p * 2.5 + vec3(uTime * 0.03));
          float c = smoothstep(0.55, 0.92, n * 0.7 + n2 * 0.3);
          vec3 L = normalize(-vWorld);
          float ndl = max(0.0, dot(vNormal, L));
          float lighting = ndl * 0.85 + 0.05;
          gl_FragColor = vec4(uColor * lighting, c * 0.55);
        }
      `,
    })
  );
}

// ============================================================
// 6. PLANET DEFINITIONS
// ============================================================
// Visual params (size/dist/speed) are compressed for a legible single-screen
// view; the rows carry the real figures.
const PLANETS = [
  { key: 'mercury', name: 'MERCURY', size: 1.1, dist: 28,  speed: 1.6,  spin: 0.10, tilt: 0.05,
    base: 0x8a7a6a, accent: 0x40342a, polar: 0x6a5a4a, scale: 4.5, ridges: true, vel: 47.4,
    desc: 'The smallest planet and closest to the Sun. Airless and cratered, its surface swings from 430°C in daylight to −180°C at night.',
    rows: [['DIAMETER', '4,879 KM'], ['FROM SUN', '0.39 AU'], ['ORBIT', '88 D'], ['DAY', '176 D'], ['GRAVITY', '0.38 g'], ['MOONS', '0']] },
  { key: 'venus', name: 'VENUS', size: 1.55, dist: 44, speed: 1.18, spin: -0.04, tilt: 0.02,
    base: 0xe8b888, accent: 0x9a5a30, polar: 0xead4a0, scale: 3.5, ridges: false, vel: 35.0,
    desc: 'Earth’s twin in size, wrapped in a crushing carbon-dioxide atmosphere. A runaway greenhouse holds the surface near 465°C.',
    rows: [['DIAMETER', '12,104 KM'], ['FROM SUN', '0.72 AU'], ['ORBIT', '225 D'], ['DAY', '117 D'], ['GRAVITY', '0.90 g'], ['MOONS', '0']] },
  { key: 'earth', name: 'EARTH', size: 1.7, dist: 64, speed: 1.0, spin: 0.5, tilt: 0.41,
    base: 0x1d6dc8, accent: 0x2a8e54, polar: 0xf2f7ff, scale: 4.0, ridges: false, vel: 29.8,
    desc: 'Our home world and the departure point for the voyage. The only planet known to hold liquid water on its surface.',
    rows: [['DIAMETER', '12,742 KM'], ['FROM SUN', '1.00 AU'], ['ORBIT', '365 D'], ['DAY', '24 H'], ['GRAVITY', '1.00 g'], ['MOONS', '1']] },
  { key: 'mars', name: 'MARS', size: 1.32, dist: 88, speed: 0.78, spin: 0.48, tilt: 0.44,
    base: 0xc44a26, accent: 0x6a2412, polar: 0xf6e0c0, scale: 3.6, ridges: true, vel: 24.1,
    desc: 'The destination — a cold desert world half Earth’s size. Home to Olympus Mons, the tallest volcano in the Solar System.',
    rows: [['DIAMETER', '6,779 KM'], ['FROM SUN', '1.52 AU'], ['ORBIT', '687 D'], ['DAY', '24.6 H'], ['GRAVITY', '0.38 g'], ['MOONS', '2']] },
  { key: 'jupiter', name: 'JUPITER', size: 4.6, dist: 150, speed: 0.42, spin: 0.7, tilt: 0.05,
    base: 0xd8a878, accent: 0x6a3a22, polar: 0xeed8a8, scale: 2.6, ridges: false, banded: true, vel: 13.1,
    desc: 'The largest planet — a gas giant that could swallow over 1,300 Earths. Its Great Red Spot is a storm centuries old.',
    rows: [['DIAMETER', '139,820 KM'], ['FROM SUN', '5.20 AU'], ['ORBIT', '11.9 Y'], ['DAY', '9.9 H'], ['GRAVITY', '2.53 g'], ['MOONS', '95']] },
  { key: 'saturn', name: 'SATURN', size: 3.9, dist: 210, speed: 0.30, spin: 0.62, tilt: 0.47,
    base: 0xb59868, accent: 0x68502a, polar: 0xc8b48a, scale: 2.4, ridges: false, banded: true, vel: 9.7,
    desc: 'The ringed giant. Its bright ice rings span roughly 280,000 km yet are only tens of metres thick.',
    rows: [['DIAMETER', '116,460 KM'], ['FROM SUN', '9.54 AU'], ['ORBIT', '29.4 Y'], ['DAY', '10.7 H'], ['GRAVITY', '1.07 g'], ['MOONS', '146']],
    special: 'rings' },
  { key: 'uranus', name: 'URANUS', size: 2.4, dist: 260, speed: 0.22, spin: 0.4, tilt: 1.71,
    base: 0x9adde5, accent: 0x3a7a92, polar: 0xc8eef2, scale: 2.2, ridges: false, vel: 6.8,
    desc: 'An ice giant tipped on its side, rolling around the Sun at a 98° tilt. Methane gives it a pale blue-green colour.',
    rows: [['DIAMETER', '50,724 KM'], ['FROM SUN', '19.2 AU'], ['ORBIT', '84 Y'], ['DAY', '17.2 H'], ['GRAVITY', '0.89 g'], ['MOONS', '28']] },
  { key: 'neptune', name: 'NEPTUNE', size: 2.35, dist: 305, speed: 0.18, spin: 0.42, tilt: 0.49,
    base: 0x3a6ad8, accent: 0x1a2a78, polar: 0xc0d8f8, scale: 2.4, ridges: false, vel: 5.4,
    desc: 'The most distant planet — a deep-blue ice giant whose winds top 2,000 km/h, the fastest in the Solar System.',
    rows: [['DIAMETER', '49,244 KM'], ['FROM SUN', '30.1 AU'], ['ORBIT', '165 Y'], ['DAY', '16 H'], ['GRAVITY', '1.14 g'], ['MOONS', '16']] },
];

const planetMeshes = {};
const orbitPaths = [];

function buildPlanet(p) {
  const orbitGroup = new THREE.Group();
  orbitGroup.rotation.y = Math.random() * TAU;
  scene.add(orbitGroup);

  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.z = p.tilt;
  tiltGroup.position.x = p.dist;
  orbitGroup.add(tiltGroup);

  const mat = makePlanetMaterial({
    base: p.base, accent: p.accent, polar: p.polar, scale: p.scale,
    ridges: p.ridges, banded: p.banded,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 64, 64), mat);
  tiltGroup.add(mesh);

  // Atmosphere for select planets — bright at silhouette, near-transparent at center
  if (p.key === 'earth')   tiltGroup.add(makeAtmosphere(p.size * 1.12, 0x4ab8ff, 1.6));
  if (p.key === 'venus')   tiltGroup.add(makeAtmosphere(p.size * 1.16, 0xffd49a, 1.4));
  if (p.key === 'mars')    tiltGroup.add(makeAtmosphere(p.size * 1.09, 0xff8a4a, 0.9));
  if (p.key === 'jupiter') tiltGroup.add(makeAtmosphere(p.size * 1.05, 0xffd0a0, 0.6));
  if (p.key === 'saturn')  tiltGroup.add(makeAtmosphere(p.size * 1.04, 0xc8b48a, 0.35));
  if (p.key === 'uranus')  tiltGroup.add(makeAtmosphere(p.size * 1.10, 0xa0eef0, 0.9));
  if (p.key === 'neptune') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0x6090ff, 1.0));

  // Earth keeps a realistic drifting cloud layer.
  if (p.key === 'earth') {
    const clouds = makeCloudLayer(p.size * 1.035, 0xc8d8e8);
    mesh.add(clouds);
    mesh.userData.clouds = clouds;
  }

  // Saturn rings
  if (p.special === 'rings') {
    tiltGroup.add(buildSaturnRings(p.size));
  }

  // Orbit path (subtle ring on the ecliptic)
  const orbitPath = new THREE.Mesh(
    new THREE.RingGeometry(p.dist - 0.04, p.dist + 0.04, 256),
    new THREE.MeshBasicMaterial({
      color: 0x6ff1ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  orbitPath.rotation.x = Math.PI / 2;
  scene.add(orbitPath);
  orbitPaths.push(orbitPath);

  planetMeshes[p.key] = {
    config: p, orbitGroup, tiltGroup, mesh, material: mat,
    angle: Math.random() * TAU,
  };
}

PLANETS.forEach(buildPlanet);

// ------------------------------------------------------------
// Earth satellite constellation — many small craft on inclined orbital shells
// (plus scattered extras), with faint orbit rings. Parented to Earth so it
// tracks Earth's position and inherits its visibility; animated in updateEarthSats.
// ------------------------------------------------------------
let earthSats = null;
function buildEarthSatellites() {
  const grp = new THREE.Group();
  grp.userData.sats = [];
  const R = planetMeshes.earth.config.size;
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcfd6de, metalness: 0.7, roughness: 0.4, emissive: 0x2a3a4c, emissiveIntensity: 0.5 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x1b2c66, metalness: 0.5, roughness: 0.4, emissive: 0x0a1640, emissiveIntensity: 0.7 });
  const bodyGeo = new THREE.BoxGeometry(0.06, 0.05, 0.09);
  const panelGeo = new THREE.BoxGeometry(0.16, 0.004, 0.06);

  // Orthonormal basis (u, v) for an orbit plane at inclination `inc`, node `node`.
  function planeBasis(inc, node) {
    const u = new THREE.Vector3(Math.cos(node), 0, Math.sin(node));
    const w0 = new THREE.Vector3(-Math.sin(node), 0, Math.cos(node));
    const v = w0.multiplyScalar(Math.cos(inc)).addScaledVector(new THREE.Vector3(0, 1, 0), -Math.sin(inc)).normalize();
    return { u, v };
  }
  function addSat(r, u, v, theta, omega) {
    const sat = new THREE.Group();
    sat.add(new THREE.Mesh(bodyGeo, bodyMat));
    const pL = new THREE.Mesh(panelGeo, panelMat); pL.position.x = 0.12; sat.add(pL);
    const pR = new THREE.Mesh(panelGeo, panelMat); pR.position.x = -0.12; sat.add(pR);
    grp.add(sat);
    grp.userData.sats.push({ mesh: sat, r, u, v, theta, omega });
  }

  // Constellation shells: each is a visible orbital band carrying many satellites.
  const shells = [
    { r: R + 0.5, inc: 0.9 }, { r: R + 0.75, inc: 1.5 }, { r: R + 1.0, inc: 0.35 },
    { r: R + 1.25, inc: 2.2 }, { r: R + 1.55, inc: 1.1 }, { r: R + 1.9, inc: 2.7 },
  ];
  shells.forEach((sh, si) => {
    const { u, v } = planeBasis(sh.inc, si * 1.21);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(sh.r, 0.006, 6, 96),
      new THREE.MeshBasicMaterial({ color: 0x6ff1ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().crossVectors(u, v).normalize());
    grp.add(ring);
    const omega = 0.28 * Math.pow(R / sh.r, 1.5) + 0.12;
    for (let k = 0; k < 11; k++) addSat(sh.r, u, v, (k / 11) * TAU + Math.random() * 0.3, omega);
  });
  // Scattered extras on random orbits.
  for (let i = 0; i < 16; i++) {
    const r = R + 0.45 + Math.random() * 1.7;
    const { u, v } = planeBasis(Math.random() * Math.PI, Math.random() * TAU);
    addSat(r, u, v, Math.random() * TAU, 0.28 * Math.pow(R / r, 1.5) + 0.12);
  }
  return grp;
}
earthSats = buildEarthSatellites();
planetMeshes.earth.tiltGroup.add(earthSats);

function updateEarthSats(dt) {
  if (!earthSats) return;
  for (const s of earthSats.userData.sats) {
    s.theta += s.omega * dt;
    s.mesh.position.set(0, 0, 0).addScaledVector(s.u, Math.cos(s.theta) * s.r).addScaledVector(s.v, Math.sin(s.theta) * s.r);
    s.mesh.lookAt(0, 0, 0);   // keep a consistent attitude (panels glint as they pass)
  }
}

// ============================================================
// 9. SATURN RINGS
// ============================================================
function buildSaturnRings(planetRadius) {
  const inner = planetRadius * 1.3;
  const outer = planetRadius * 2.4;
  const geo = new THREE.RingGeometry(inner, outer, 256, 4);
  // Re-do UVs so the ring texture maps radially
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.sqrt(pos.getX(i) ** 2 + pos.getY(i) ** 2);
    const u = (r - inner) / (outer - inner);
    uv.setXY(i, u, (i % 2));
  }

  const mat = new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: { uInner: { value: inner }, uOuter: { value: outer } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      ${NOISE_GLSL}
      void main() {
        float t = vUv.x;
        float band1 = smoothstep(0.18, 0.2, t) * (1.0 - smoothstep(0.21, 0.23, t));
        float band2 = smoothstep(0.46, 0.48, t) * (1.0 - smoothstep(0.50, 0.52, t));
        float band3 = smoothstep(0.74, 0.76, t) * (1.0 - smoothstep(0.78, 0.80, t));
        float gaps = band1 + band2 + band3;
        float n = fbm(vec3(t * 30.0, vUv.y * 6.0, 0.0));
        // Linear-space tans
        vec3 col = mix(vec3(0.50, 0.35, 0.13), vec3(0.78, 0.69, 0.42), n);
        col *= 0.55 + 0.5 * smoothstep(0.0, 1.0, t);
        float alpha = (0.78 - gaps * 0.95) * smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.95, 1.0, t));
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

// ============================================================
// 10. ASTEROID BELT
// ============================================================
function buildAsteroidBelt() {
  const count = 1600;
  const geo = new THREE.IcosahedronGeometry(0.18, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7a6a55, metalness: 0.4, roughness: 0.85,
    flatShading: true, emissive: 0x0a0805, emissiveIntensity: 0.2,
  });
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();
  const data = [];
  for (let i = 0; i < count; i++) {
    const r = 115 + Math.random() * 20;
    const a = Math.random() * TAU;
    const y = (Math.random() - 0.5) * 1.6;
    const s = 0.3 + Math.random() * 1.0;
    const speed = 0.06 + Math.random() * 0.04;
    data.push({ r, a, y, s, speed, rx: Math.random() * TAU, ry: Math.random() * TAU });
    dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    dummy.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.dummy = dummy;
  inst.userData.data = data;
  scene.add(inst);
  return inst;
}
const asteroidBelt = buildAsteroidBelt();

// ============================================================
// 12. CAMERA
// ============================================================
// Camera transition state
let camTween = null;
let followKey = null;
function focusOn(planetKey) {
  let target = new THREE.Vector3(0, 0, 0);
  let camPos = new THREE.Vector3(180, 110, 240);

  if (planetKey) {
    const pm = planetMeshes[planetKey];
    pm.tiltGroup.getWorldPosition(target);
    const radius = pm.config.size;
    // sunDir points sun → planet. Stepping back along -sunDir puts the camera
    // between sun and planet, so the day side faces us. Add a side tangent and
    // a small lift for a 3/4 hero shot.
    const sunDir = target.clone().normalize();
    const tangent = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0)).normalize();
    if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0);
    camPos = target.clone()
      .add(sunDir.clone().multiplyScalar(-radius * 5.0))
      .add(tangent.multiplyScalar(radius * 5.0))
      .add(new THREE.Vector3(0, radius * 2.4, 0));
  }

  camTween = {
    fromPos: camera.position.clone(),
    toPos: camPos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    t: 0, duration: 2.2,
  };
  followKey = planetKey;
}

// Live HUD clock
const timeEl = document.getElementById('stat-time');

// ============================================================
// 12B. VOYAGE MODE — Earth → Mars Hohmann transfer
// ------------------------------------------------------------
// A guided, physics-driven crossing. The ship flies a true transfer
// ellipse (Sun at one focus) timed by Kepler's equation, so it visibly
// slows as it climbs toward Mars — Kepler's 2nd law made watchable.
// Displayed telemetry uses the REAL Earth→Mars transfer (a=1.262 AU,
// ~259 days) while the 3D geometry is compressed to the scene's orbits.
// ============================================================
const R1 = planetMeshes.earth.config.dist;   // Earth orbit radius (scene units)
const R2 = planetMeshes.mars.config.dist;    // Mars orbit radius (scene units)
const A_T = (R1 + R2) / 2;                    // transfer semi-major axis (scene)
const E_T = (R2 - R1) / (R2 + R1);            // transfer eccentricity (scene)
const EARTH_ANGLE = 0;                        // Earth's world angle at departure
const MARS_SWEEP = 2.369;                     // rad Mars travels during transit (~136°)
const MARS_START = Math.PI - MARS_SWEEP;      // Mars world angle at departure (~44° lead)

// Solve Kepler's equation  M = E − e·sin E  for eccentric anomaly E.
function keplerE(M, e) {
  let E = M;
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

// Heliocentric state on the transfer ellipse at progress s (0 = Earth, 1 = Mars).
// Mean anomaly is linear in time (Kepler II), so equal time steps cover equal area.
function transferState(s) {
  const M = Math.PI * s;                       // perihelion (0) → aphelion (π)
  const E = keplerE(M, E_T);
  const r = A_T * (1 - E_T * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + E_T) * Math.sin(E / 2),
                            Math.sqrt(1 - E_T) * Math.cos(E / 2));
  const ang = EARTH_ANGLE + nu;
  return { pos: new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r), r, nu };
}

// Canonical textbook telemetry for the real Earth→Mars transfer.
const REAL_E = 0.2076, REAL_A = 1.262, VISVIVA = 29.78 * 29.78; // (km/s)²·AU
function voyageStats(s) {
  const E = keplerE(Math.PI * s, REAL_E);
  const rAU = REAL_A * (1 - REAL_E * Math.cos(E));
  const v = Math.sqrt(VISVIVA * (2 / rAU - 1 / REAL_A));
  return { rAU, v, day: s * 259 };
}

// Passenger liner: a spine, a spinning habitat ring (artificial gravity),
// an engine bell with a burn trail that only lights during the burns.
function buildLiner() {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x9fb0c4, metalness: 0.9, roughness: 0.35, emissive: 0x24384e, emissiveIntensity: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x33404f, metalness: 0.8, roughness: 0.5 });
  const glowC = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffb86b });

  // Slender hull — narrower than the launch vehicle it rode up inside.
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.23, 5.2, 16), hull);
  fus.rotation.x = Math.PI / 2; g.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.23, 1.3, 16), hull);
  nose.rotation.x = Math.PI / 2; nose.position.z = 3.2; g.add(nose);
  const win = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.04, 8, 20), glowC);
  win.position.z = 2.3; g.add(win);
  const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.7, 16), dark);
  eng.rotation.x = Math.PI / 2; eng.position.z = -2.9; g.add(eng);

  // Spinning habitat ring (forward axis = Z), with cabin lights.
  const ringGrp = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.22, 12, 44), hull);
  ringGrp.add(ring);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.07), dark);
    spoke.position.set(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0);
    spoke.rotation.z = a; ringGrp.add(spoke);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    const lit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.1), i % 3 ? glowC : warm);
    lit.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0);
    lit.rotation.z = a; ringGrp.add(lit);
  }
  g.add(ringGrp);

  // Engine plume (vacuum burn): a bright core + translucent bell + glow. Built
  // pointing −Y, then rotated to fire aft (−Z). Lit only during the injection
  // burn / staging ignition (toggled in updateHelio).
  const plume = new THREE.Group();
  const pcore = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.5, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xe6f6ff, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }));
  pcore.rotation.x = Math.PI; pcore.position.y = -0.75; plume.add(pcore);
  const pouter = new THREE.Mesh(new THREE.ConeGeometry(0.3, 2.8, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x6cc8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  pouter.rotation.x = Math.PI; pouter.position.y = -1.4; plume.add(pouter);
  const trail = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(['rgba(200,235,255,0.95)', 'rgba(80,180,255,0.4)', 'rgba(0,90,210,0)']),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  trail.scale.setScalar(3.0); trail.position.y = -0.6; plume.add(trail);
  plume.rotation.x = Math.PI / 2; plume.position.z = -2.9; plume.visible = false; g.add(plume);

  // Soft fill light travelling with the liner so the hull stays readable
  // during the long engines-off coast (the Sun alone leaves it in silhouette).
  const fill = new THREE.PointLight(0xbfe6ff, 0.7, 34, 2);
  fill.position.set(0, 4, 1);
  g.add(fill);

  g.userData.ring = ringGrp;
  g.userData.trail = trail;
  g.userData.plume = plume;
  g.scale.setScalar(0.45);
  return g;
}

function buildEllipseLine(samples, opacity, color) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const nu = (i / samples) * TAU;
    const r = A_T * (1 - E_T * E_T) / (1 + E_T * Math.cos(nu));
    const ang = EARTH_ANGLE + nu;
    pts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
  );
}

const UP = new THREE.Vector3(0, 1, 0);
const E_POS = new THREE.Vector3(64, 0, 0);            // Earth at departure (EARTH_ANGLE = 0)
const E_R = planetMeshes.earth.config.size;          // Earth radius (scene units)
const clamp01 = x => Math.max(0, Math.min(1, x));
const BASE_N = new THREE.Vector3(2.2, 1.15, 3.0).normalize();   // Mars-surface normal the colony sits on (faces the camera)

// Ascent path: rise vertically off the pad, pitch over (gravity turn), level out.
const lp = (y, z) => E_POS.clone().add(new THREE.Vector3(0, E_R + y, z));
const launchCurve = new THREE.CatmullRomCurve3([
  lp(0.0, 0.0), lp(1.8, 0.0), lp(4.0, 0.3), lp(6.0, 1.8), lp(6.8, 4.6), lp(6.2, 8.4), lp(4.6, 12.6),
]);

// A detailed launch vehicle (nose +Y): separable first stage + upper stage +
// capsule, with a layered exhaust flame. Parts stored in userData.
function buildRocket() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xe6ecf2, metalness: 0.45, roughness: 0.45, emissive: 0x1c2636, emissiveIntensity: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x39424f, metalness: 0.7, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.6, roughness: 0.55 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });

  // First stage (separable)
  const stage1 = new THREE.Group();
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.0, 24), body); s1.position.y = -1.0; stage1.add(s1);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.28, 24), black); band.position.y = 0.2; stage1.add(band);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 0.45, 24), dark); skirt.position.y = -2.55; stage1.add(skirt);
  for (let i = 0; i < 5; i++) {
    const a = i === 4 ? 0 : (i / 4) * TAU, r = i === 4 ? 0 : 0.27;
    const noz = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 12), black);
    noz.position.set(Math.cos(a) * r, -2.95, Math.sin(a) * r); stage1.add(noz);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.8, 0.5), dark);
    fin.position.set(Math.cos(a) * 0.46, -2.3, Math.sin(a) * 0.46); fin.rotation.y = -a; stage1.add(fin);
  }
  g.add(stage1);

  // Upper stage + capsule (continues after staging)
  const upper = new THREE.Group();
  const inter = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.32, 24), dark); inter.position.y = 0.7; upper.add(inter);
  const s2 = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 1.5, 24), body); s2.position.y = 1.65; upper.add(s2);
  const win = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.04, 8, 24), cyan); win.position.y = 2.0; win.rotation.x = Math.PI / 2; upper.add(win);
  const fair = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.38, 1.0, 24), body); fair.position.y = 2.95; upper.add(fair);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 18), body); tip.position.y = 3.7; upper.add(tip);
  g.add(upper);

  // Layered exhaust flame (bright core + outer cone + glow), animated in updateLaunch.
  const flameGrp = new THREE.Group(); flameGrp.position.y = -3.0;
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.3, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff4cf, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.rotation.x = Math.PI; core.position.y = -0.65; flameGrp.add(core);
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.34, 2.4, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8c2e, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false }));
  outer.rotation.x = Math.PI; outer.position.y = -1.2; flameGrp.add(outer);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(['rgba(255,225,160,0.95)', 'rgba(255,130,40,0.4)', 'rgba(255,60,20,0)']),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.setScalar(1.7); glow.position.y = -0.7; flameGrp.add(glow);
  g.add(flameGrp);

  const light = new THREE.PointLight(0xffcaa0, 1.5, 9, 2); light.position.y = -2.6; g.add(light);

  g.userData = { stage1, upper, flameGrp, core, outer, glow, light };
  g.scale.setScalar(0.3);
  return g;
}

// The jettisoned first stage (same body as the rocket's stage 1) — flown in world
// space as it tumbles back down toward Earth after staging. Scaled to match buildRocket.
function buildSpentStage() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xe6ecf2, metalness: 0.45, roughness: 0.45, emissive: 0x1c2636, emissiveIntensity: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x39424f, metalness: 0.7, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.6, roughness: 0.55 });
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.0, 24), body); s1.position.y = -1.0; g.add(s1);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.28, 24), black); band.position.y = 0.2; g.add(band);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 0.45, 24), dark); skirt.position.y = -2.55; g.add(skirt);
  for (let i = 0; i < 5; i++) {
    const a = i === 4 ? 0 : (i / 4) * TAU, r = i === 4 ? 0 : 0.27;
    const noz = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 12), black);
    noz.position.set(Math.cos(a) * r, -2.95, Math.sin(a) * r); g.add(noz);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.8, 0.5), dark);
    fin.position.set(Math.cos(a) * 0.46, -2.3, Math.sin(a) * 0.46); fin.rotation.y = -a; g.add(fin);
  }
  g.scale.setScalar(0.3);
  return g;
}

// Exhaust column: additive puffs trailing the rocket up the ascent path.
function buildLaunchTrail() {
  const grp = new THREE.Group();
  const tex = radialTexture(['rgba(255,255,255,0.95)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0)']);
  grp.userData.puffs = [];
  for (let i = 0; i < 16; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    grp.add(sp); grp.userData.puffs.push(sp);
  }
  return grp;
}

// Soft round puff, reused for frost flakes (staging) and dust clouds (landing).
const PUFF_TEX = radialTexture(['rgba(255,255,255,0.95)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)']);

// A burst of little sprites with random outward directions + speeds, played back
// by a 0→1 progress value in the updaters. Used for the ice/gas shower thrown off
// at stage separation and the dust kicked up under the retro-rockets at touchdown.
function buildParticles(count, color, additive, sizeMin, sizeMax) {
  const grp = new THREE.Group();
  grp.userData.parts = [];
  for (let i = 0; i < count; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: PUFF_TEX, color, transparent: true, opacity: 0, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    const a = Math.random() * TAU, z = Math.random() * 2 - 1, r = Math.sqrt(Math.max(0, 1 - z * z));
    sp.userData.dir = new THREE.Vector3(Math.cos(a) * r, z, Math.sin(a) * r);
    sp.userData.speed = 0.5 + Math.random() * 1.5;
    sp.userData.size = sizeMin + Math.random() * (sizeMax - sizeMin);
    grp.add(sp); grp.userData.parts.push(sp);
  }
  grp.visible = false;
  return grp;
}

// Striped parachute canopy texture — alternating gores in the Mars-EDL palette
// (burnt orange / off-white), with darker seams and a band near the skirt.
function chuteTexture() {
  const w = 512, h = 256;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const gores = 16;
  for (let i = 0; i < gores; i++) {
    ctx.fillStyle = i % 2 ? '#efe7d6' : '#e8632a';
    ctx.fillRect((i / gores) * w, 0, w / gores + 1.5, h);
  }
  ctx.fillStyle = 'rgba(120,60,30,0.5)';
  for (let i = 0; i < gores; i++) ctx.fillRect((i / gores) * w - 0.75, 0, 1.5, h);   // seams
  ctx.fillStyle = 'rgba(150,70,35,0.55)'; ctx.fillRect(0, h * 0.82, w, h * 0.07);     // skirt band
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// EDL descent craft (nose +Y): backshell + heat shield, with an entry bow-shock
// and streaming plasma wake, a striped deployable parachute, a retro cluster for
// powered descent, and landing legs.
function buildLander() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xd2d9e0, metalness: 0.45, roughness: 0.5, emissive: 0x222c38, emissiveIntensity: 0.4 });
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x6b3d29, metalness: 0.25, roughness: 0.85, emissive: 0x2a0f06, emissiveIntensity: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x333b45, metalness: 0.6, roughness: 0.5 });

  // Backshell (cone) + collar; the capsule rides nose-out (+Y), shield toward Mars (−Y).
  const capsule = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.8, 24), body); capsule.position.y = 0.42; g.add(capsule);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.56, 0.22, 24), dark); g.add(collar);
  // Ablative heat shield — kept as its own handle so it can be jettisoned after the chute.
  const hs = new THREE.Mesh(new THREE.SphereGeometry(0.66, 24, 12, 0, TAU, 0, Math.PI * 0.46), shieldMat);
  hs.rotation.x = Math.PI; hs.position.y = -0.14; g.add(hs);

  // Entry bow-shock cap glowing just ahead of the heat shield (toward Mars).
  const bow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(['rgba(255,252,238,0.98)', 'rgba(255,150,55,0.6)', 'rgba(255,60,20,0)']),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
  bow.scale.setScalar(2.0); bow.position.y = -0.58; g.add(bow);

  // Plasma wake streaming behind the capsule (+Y, away from Mars).
  const wake = [];
  for (let i = 0; i < 12; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: PUFF_TEX, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    sp.position.y = 0.5 + i * 0.55;
    g.add(sp); wake.push(sp);
  }

  // Parachute (deploys mid-descent): striped gored canopy + skirt ring + suspension lines.
  const chute = new THREE.Group();
  const chuteTex = chuteTexture();
  const canopyMat = new THREE.MeshStandardMaterial({ map: chuteTex, emissiveMap: chuteTex, emissive: 0xffffff, emissiveIntensity: 0.55, metalness: 0, roughness: 0.95, side: THREE.DoubleSide, transparent: true });
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.6, 30, 16, 0, TAU, 0, Math.PI * 0.5), canopyMat);
  canopy.position.y = 3.0; chute.add(canopy);
  const skirt = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.05, 8, 36),
    new THREE.MeshStandardMaterial({ color: 0xcf5a26, roughness: 0.9 }));
  skirt.rotation.x = Math.PI / 2; skirt.position.y = 3.0; chute.add(skirt);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU;
    const A = new THREE.Vector3(0, 0.85, 0), B = new THREE.Vector3(Math.cos(a) * 1.5, 2.7, Math.sin(a) * 1.5);
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, A.distanceTo(B), 5), dark);
    line.position.copy(A).lerp(B, 0.5);
    line.quaternion.setFromUnitVectors(UP, B.clone().sub(A).normalize());
    chute.add(line);
  }
  chute.visible = false; g.add(chute);

  // Powered-descent retro cluster: four canted engine plumes + a central glow.
  const retros = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const r = new THREE.Mesh(new THREE.ConeGeometry(0.13, 1.15, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xcdecff, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }));
    r.rotation.x = Math.PI; r.position.set(Math.cos(a) * 0.3, -0.7, Math.sin(a) * 0.3); retros.add(r);
  }
  const retroGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(['rgba(220,244,255,0.95)', 'rgba(90,170,255,0.45)', 'rgba(40,90,200,0)']),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  retroGlow.scale.setScalar(2.1); retroGlow.position.y = -0.82; retros.add(retroGlow);
  retros.visible = false; g.add(retros);

  // Landing legs with footpads (deploy late in the descent).
  const legs = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 6), dark);
    leg.position.set(Math.cos(a) * 0.42, -0.42, Math.sin(a) * 0.42);
    leg.quaternion.setFromUnitVectors(UP, new THREE.Vector3(Math.cos(a) * 0.6, -1, Math.sin(a) * 0.6).normalize());
    legs.add(leg);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10), dark);
    pad.position.set(Math.cos(a) * 0.74, -0.8, Math.sin(a) * 0.74); legs.add(pad);
  }
  legs.visible = false; g.add(legs);

  g.userData = { hs, bow, wake, chute, canopy, retros, legs };
  g.scale.setScalar(0.5);
  return g;
}

// Mars surface colony (shown in Surface Operations): a landed Starship, pressurised
// glass domes + habitat modules, solar arrays, a comms dish and a rover — the
// SpaceX/NASA colony image. Built +Y up; placed + oriented on the surface in updateHelio.
function buildMarsBase() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 0.9, roughness: 0.28, emissive: 0x2a3340, emissiveIntensity: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9eef4, metalness: 0.3, roughness: 0.6, emissive: 0x2a3038, emissiveIntensity: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.7, roughness: 0.5 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x5a4030, metalness: 0.2, roughness: 0.95, emissive: 0x1a0f08, emissiveIntensity: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xbfe9ff, metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.34, emissive: 0x2f6a86, emissiveIntensity: 0.6, side: THREE.DoubleSide });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x16245c, metalness: 0.6, roughness: 0.35, emissive: 0x0b1b44, emissiveIntensity: 0.6 });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });

  // Pressurised dome: glass cap + base ring + structural arcs + interior glow.
  function dome(x, z, r) {
    const d = new THREE.Group(); d.position.set(x, 0, z);
    d.add(new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12, 0, TAU, 0, Math.PI * 0.5), glass));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.07, 8, 24), white); ring.rotation.x = Math.PI / 2; d.add(ring);
    for (let i = 0; i < 2; i++) { const arc = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.03, 6, 18, Math.PI), white); arc.rotation.y = i * Math.PI / 2; d.add(arc); }
    const glow = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 10, 8), warm); glow.position.y = r * 0.22; glow.scale.y = 0.5; d.add(glow);
    g.add(d);
  }
  // Horizontal habitat module (capsule) with a lit window stripe.
  function hab(x, z, len, rot) {
    const h = new THREE.Group(); h.position.set(x, 0.08, z); h.rotation.y = rot;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, len, 14), white); body.rotation.z = Math.PI / 2; h.add(body);
    for (const s of [-1, 1]) { const cap = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), white); cap.position.x = s * len / 2; h.add(cap); }
    const win = new THREE.Mesh(new THREE.BoxGeometry(len * 0.7, 0.025, 0.025), warm); win.position.y = 0.055; h.add(win);
    g.add(h);
  }

  // Ground pads.
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.025, 28), padMat));
  const pad2 = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.03, 24), padMat); pad2.position.set(0.85, 0, -0.5); g.add(pad2);

  // Landed Starship (hero).
  const ship = new THREE.Group(); ship.position.set(0.85, 0, -0.5);
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.62, 20), metal); hull.position.y = 0.43; ship.add(hull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 20), metal); nose.position.y = 0.87; ship.add(nose);
  const flapT = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.1), dark); flapT.position.set(0.1, 0.72, 0); ship.add(flapT);
  const flapB = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.12), dark); flapB.position.set(-0.1, 0.2, 0); ship.add(flapB);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.101, 0.101, 0.03, 20), warm); band.position.y = 0.66; ship.add(band);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6), dark);
    leg.position.set(Math.cos(a) * 0.12, 0.1, Math.sin(a) * 0.12);
    leg.quaternion.setFromUnitVectors(UP, new THREE.Vector3(Math.cos(a) * 0.7, -1, Math.sin(a) * 0.7).normalize());
    ship.add(leg);
  }
  g.add(ship);

  // Domes + habitat modules.
  dome(-0.18, 0.12, 0.2); dome(0.2, 0.32, 0.15); dome(-0.55, -0.12, 0.13);
  hab(-0.08, -0.26, 0.4, 0.5); hab(0.36, -0.04, 0.3, 1.4);

  // Solar arrays.
  for (let i = 0; i < 3; i++) {
    const arr = new THREE.Group(); arr.position.set(-0.72, 0.12, 0.35 + i * 0.22);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), dark); post.position.y = -0.06; arr.add(post);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.006, 0.18), panelMat); panel.rotation.x = -0.5; arr.add(panel);
    g.add(arr);
  }

  // Comms dish on a mast.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6), dark); mast.position.set(0.5, 0.17, 0.45); g.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, 0, Math.PI * 0.4), white); dish.position.set(0.5, 0.34, 0.45); dish.rotation.set(-0.8, 0, 0.3); g.add(dish);

  // Rover.
  const rover = new THREE.Group(); rover.position.set(-0.42, 0.04, 0.52);
  const rbody = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.09), white); rbody.position.y = 0.04; rover.add(rbody);
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 10), dark); w.rotation.x = Math.PI / 2;
    w.position.set(i < 2 ? 0.06 : -0.06, 0.025, i % 2 ? 0.05 : -0.05); rover.add(w);
  }
  g.add(rover);

  // Scattered window / path lights for "life".
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU, r = 0.32 + (i % 3) * 0.1;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.013, 6, 6), i % 2 ? warm : cyan);
    dot.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r); g.add(dot);
  }

  // Local fill so the colony reads even on Mars's shadowed side.
  const fill = new THREE.PointLight(0xffe0c0, 0.9, 7, 2); fill.position.set(0, 1.3, 0.6); g.add(fill);

  g.scale.setScalar(0.5);
  return g;
}

// Journey timeline: ordered stages, each with a real-time duration.
// Stages follow NASA's Mars mission timeline: Launch → Cruise → Approach →
// Entry, Descent & Landing → Surface Operations. Durations sum to ~120s.
// Text/facts are short, informal prompts — meant to be narrated over live.
const PHASES = [
  { key: 'launch', label: '01 · LAUNCH', short: 'LAUNCH', dur: 16, mode: 'launch',
    tag: 'STAGE 01 · LAUNCH',
    law: 'NEWTON III · action–reaction',
    facts: [
      'Liftoff: 3–4 g pins you to your seat — you feel 3 to 4× your own weight.',
      'The rocket burns tonnes of fuel a second; it shakes and roars.',
      '~9 minutes of burn to reach 28,000 km/h — orbital speed.',
      'Then the engines cut and you’re suddenly weightless.',
    ] },
  { key: 'cruise', label: '02 · CRUISE', short: 'CRUISE', dur: 48, mode: 'helio', s0: 0.0, s1: 0.78, view: 'ring',
    tag: 'STAGE 02 · CRUISE',
    law: 'NEWTON I + KEPLER · coasting on an ellipse',
    facts: [
      'An 8-month coast to Mars — engines off, floating the whole way.',
      'Zero-g weakens you: bones lose ~1% density a month, muscles waste — so you train ~2 hrs a day.',
      'Spin the habitat ring (~2 rpm) and its rim feels like gravity.',
      'Food is freeze-dried & vacuum-packed; water — even urine — is recycled.',
    ] },
  { key: 'approach', label: '03 · APPROACH', short: 'APPROACH', dur: 24, mode: 'helio', s0: 0.78, s1: 0.94, view: 'map',
    tag: 'STAGE 03 · APPROACH',
    law: 'KEPLER II · slower when farther',
    facts: [
      'Mars grows from a dot into a disc over the final weeks.',
      'You’re slowing down — fastest near the Sun, slowest out here (Kepler).',
      'Millions of km from help: a radio call to Earth takes minutes each way.',
      'Cosmic radiation is a constant risk; you shelter in a shielded bay in solar storms.',
    ] },
  { key: 'edl', label: '04 · ENTRY, DESCENT & LANDING', short: 'ENTRY / DESCENT / LANDING', dur: 20, mode: 'edl', s0: 0.94, s1: 1.0,
    tag: 'STAGE 04 · ENTRY, DESCENT & LANDING',
    law: 'NEWTON · braking burn',
    facts: [
      'The famous “7 minutes of terror” — fully automated; too far for live control.',
      'You hit the thin air at ~20,000 km/h; the heat shield glows near 1,000°C.',
      'Parachutes deploy, then retro-rockets fire to slow you for touchdown.',
    ] },
  { key: 'surface', label: '05 · SURFACE OPERATIONS', short: 'SURFACE OPS', dur: 12, mode: 'helio', s0: 1.0, s1: 1.0, view: 'surface',
    tag: 'STAGE 05 · SURFACE OPERATIONS',
    law: 'gravity · 0.38 g',
    facts: [
      'Arrived — ~8.5 months and ~480 million km after launch.',
      'Gravity is 0.38 g, but after months weightless even that feels heavy — many can’t stand at first.',
      'A rust-red desert under a dusty pink sky, and a Sun half the size of home.',
      'Your return window to Earth opens only in ~26 months.',
    ] },
];
let _acc = 0;
PHASES.forEach(p => { p.t0 = _acc; _acc += p.dur; p.t1 = _acc; });
const TOTAL_DUR = _acc;

const voyage = {
  active: false, playing: false, t: 0, total: TOTAL_DUR, stage: 0, lastStage: -1,
  manualView: null, ship: null, rocket: null, ellipseFull: null, ellipseTrail: null,
  camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), camInit: false,
  lastHighlight: null,
};

const vEls = {};
['v-phase', 'v-elapsed', 'v-vel', 'v-dist', 'v-engine', 'v-law', 'v-notes', 'vc-tag', 'v-playpause', 'v-progress']
  .forEach(id => { vEls[id] = document.getElementById(id); });

function stageIndexForT(t) {
  for (let i = 0; i < PHASES.length; i++) if (t < PHASES[i].t1) return i;
  return PHASES.length - 1;
}

function viewTarget(view, st, s) {
  const ship = st.pos;
  const vel = transferState(Math.min(1, s + 0.02)).pos.clone().sub(ship);
  if (vel.lengthSq() < 1e-6) vel.set(0, 0, 1);
  vel.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(vel, up).normalize();
  if (view === 'map')  { const c = new THREE.Vector3(-12, 0, 0); return { pos: c.clone().add(new THREE.Vector3(20, 182, 92)), look: c }; }
  if (view === 'ring') { return { pos: ship.clone().addScaledVector(side, 2.3).addScaledVector(up, 0.85).addScaledVector(vel, 0.7), look: ship.clone() }; }
  if (view === 'chase'){ return { pos: ship.clone().addScaledVector(vel, -10).addScaledVector(side, 2.2).addScaledVector(up, 4.5), look: ship.clone().addScaledVector(vel, 4) }; }
  if (view === 'depart'){
    // Side-on staging shot: the separation axis runs across the frame — liner on
    // one side, the spent stage tumbling away on the other, frost shower between.
    const look = ship.clone().addScaledVector(vel, -2.0);
    const pos = look.clone().addScaledVector(side, 4.8).addScaledVector(up, 1.6).addScaledVector(vel, 0.5);
    return { pos, look };
  }
  if (view === 'surface') {
    // 3/4 side view of the colony: low over the surface so structures stand up and
    // the planet curves away behind. Built from the surface normal + two tangents.
    const m = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(m);
    const mR = planetMeshes.mars.config.size;
    const B = m.clone().addScaledVector(BASE_N, mR);                 // the colony's surface point
    const t1 = new THREE.Vector3().crossVectors(BASE_N, UP).normalize();
    const t2 = new THREE.Vector3().crossVectors(t1, BASE_N).normalize();
    const pos = B.clone().addScaledVector(BASE_N, 1.2).addScaledVector(t1, 1.3).addScaledVector(t2, 1.08);
    return { pos, look: B.clone().addScaledVector(BASE_N, 0.34) };
  }
  const mars = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(mars);
  return { pos: ship.clone().addScaledVector(vel, -10).addScaledVector(up, 5).addScaledVector(side, 6), look: mars };
}

function updateLaunch(u) {
  voyage.ship.visible = voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  voyage.lander.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.dust) voyage.dust.visible = false;
  if (voyage.base) voyage.base.visible = false;
  voyage.rocket.visible = voyage.launchTrail.visible = true;
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'earth');
  orbitPaths.forEach(o => { o.visible = true; });

  const rd = voyage.rocket.userData;
  const sepU = 0.5;                                  // first-stage separation point
  const staged = u >= sepU;
  rd.flameGrp.visible = true;
  rd.upper.visible = true;

  // Eased ascent: hold on the pad, then accelerate upward (gravity turn).
  const p = Math.pow(u, 1.7);
  const rp = voyage.rocket.position.copy(launchCurve.getPoint(p));
  voyage.rocket.quaternion.setFromUnitVectors(UP, launchCurve.getTangent(p));

  // Stage 1 rides along until separation, then it's flown away separately (below).
  rd.stage1.visible = !staged;
  if (!staged) { rd.stage1.position.set(0, 0, 0); rd.stage1.rotation.set(0, 0, 0); }

  // Flame: a big first-stage plume at the base; after staging, a smaller upper-stage plume.
  const flick = 0.85 + Math.sin(elapsed * 42) * 0.15;
  if (staged) {
    rd.flameGrp.position.y = 0.45;
    rd.flameGrp.scale.set(flick * 0.55, (0.8 + (u - sepU) * 0.5) * flick, flick * 0.55);
  } else {
    rd.flameGrp.position.y = -3.0;
    rd.flameGrp.scale.set(flick, (1.0 + u * 0.5) * flick, flick);
  }
  rd.glow.scale.setScalar((staged ? 0.9 : 1.5) + Math.sin(elapsed * 26) * 0.25);
  rd.light.intensity = 1.4 + Math.sin(elapsed * 40) * 0.4;

  // Spent first stage: separates and tumbles back down toward Earth.
  if (voyage.spentStage) {
    voyage.spentStage.visible = staged;
    if (staged) {
      const sepP = Math.pow(sepU, 1.7);
      const sepPos = launchCurve.getPoint(sepP);
      const sepTan = launchCurve.getTangent(sepP);
      const radialOut = sepPos.clone().sub(E_POS).normalize();
      const sideV = new THREE.Vector3().crossVectors(sepTan, radialOut).normalize();
      const fall = (u - sepU) / (1 - sepU);                  // 0 → 1 over the rest of the ascent
      voyage.spentStage.position.copy(sepPos)
        .addScaledVector(sepTan, fall * 1.1)                  // coasts on a moment
        .addScaledVector(radialOut, -(fall * fall) * 5.5)     // then gravity pulls it back toward Earth
        .addScaledVector(sideV, fall * 0.5);
      voyage.spentStage.quaternion.setFromUnitVectors(UP, sepTan);
      voyage.spentStage.rotateX(fall * 4.0);                  // tumbling end over end
      voyage.spentStage.rotateZ(fall * 2.2);
    }
  }

  // Exhaust column trailing up from the pad (thins out after staging).
  const puffs = voyage.launchTrail.userData.puffs;
  puffs.forEach((sp, i) => {
    const f = i / (puffs.length - 1);              // 0 = pad, 1 = at the rocket
    sp.position.copy(launchCurve.getPoint(p * f));
    const heat = f * f;                            // hotter near the rocket
    sp.material.color.setRGB(1, 0.5 + heat * 0.45, 0.28 + heat * 0.35);
    sp.material.opacity = (0.1 + heat * 0.5) * (0.4 + p) * (staged ? 0.5 : 1);
    sp.scale.setScalar(0.7 + (1 - f) * 2.4);       // older puffs spread out
  });

  // Camera: low hero-angle on the pad → chase; at staging, pull back to frame the
  // upper stage climbing away from the tumbling first stage.
  let off, lookPt;
  if (staged) {
    off = new THREE.Vector3(-4.8, 2.0, -5.2);
    lookPt = rp.clone().lerp(voyage.spentStage.position, 0.4);
  } else {
    off = new THREE.Vector3(-3.2, -1.0 + u * 4.2, -2.6 - u * 1.0);
    lookPt = rp.clone().add(new THREE.Vector3(0, 0.6, 0));
  }
  return { pos: rp.clone().add(off), look: lookPt };
}

// Entry, Descent & Landing — the real "7 minutes of terror" beats:
// hypersonic entry (bow shock + streaming plasma wake) → supersonic parachute +
// heat-shield jettison → backshell release → retro-rocket powered descent with
// dust kicked up off the surface, settling onto its legs.
function updateEDL(u) {
  voyage.ship.visible = voyage.rocket.visible = voyage.launchTrail.visible = voyage.flash.visible = false;
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.base) voyage.base.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  voyage.lander.visible = true;
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'mars');
  orbitPaths.forEach(o => { o.visible = false; });

  // Mars at its rendezvous point. The craft flies a real guided-entry arc: a
  // shallow, mostly-horizontal hypersonic entry that steepens into a vertical,
  // retro-braked touchdown — not a straight drop.
  const s = 0.94 + u * 0.06;
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  const M = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(M);
  const mR = planetMeshes.mars.config.size;
  const dir = new THREE.Vector3(0.42, 0.74, 0.52).normalize();          // local "up" at the landing site
  const tang = new THREE.Vector3().crossVectors(dir, UP).normalize();   // downrange (approach) axis
  const cross = new THREE.Vector3().crossVectors(dir, tang).normalize();

  // Altitude eases to the surface; cross-range bleeds out by the start of powered
  // descent, so motion goes shallow-horizontal → steep-vertical (a guided arc).
  const edlPos = (uu) => {
    const a = Math.pow(clamp01(1 - uu), 1.55) * 3.8 + 0.32;
    const lat = Math.pow(clamp01((0.82 - uu) / 0.82), 1.25) * 6.5;
    return M.clone().addScaledVector(dir, mR + a).addScaledVector(tang, lat);
  };
  const pos = edlPos(u);
  const alt = pos.distanceTo(M) - mR;
  const velDir = edlPos(Math.min(1, u + 0.012)).sub(pos);
  if (velDir.lengthSq() < 1e-7) velDir.copy(tang).negate();
  velDir.normalize();
  voyage.lander.position.copy(pos);

  // Attitude: entry = heat-shield into the airflow (angled); under chute / powered
  // descent = upright (nose up, engines down) with a gentle pendulum sway.
  const sway = Math.sin(elapsed * 1.8) * (u > 0.42 && u < 0.82 ? 0.09 : 0.02);
  const qEntry = new THREE.Quaternion().setFromUnitVectors(UP, velDir.clone().negate());
  const qUp = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().applyAxisAngle(tang, sway));
  voyage.lander.quaternion.copy(qEntry).slerp(qUp, clamp01((u - 0.32) / 0.13));

  const rd = voyage.lander.userData;
  const entry = u < 0.42, descent = u >= 0.42 && u < 0.78, landing = u >= 0.78;

  // --- Hypersonic entry: bow shock on the shield + a long, turbulent plasma wake ---
  const ei = clamp01(1 - Math.abs(u - 0.16) / 0.26);
  rd.bow.material.opacity = ei * (0.7 + Math.sin(elapsed * 30) * 0.2);
  rd.bow.scale.setScalar(1.6 + ei * 0.9 + Math.sin(elapsed * 26) * 0.22);
  rd.wake.forEach((sp, i) => {
    const f = i / (rd.wake.length - 1);                    // 0 = at craft, 1 = far behind
    sp.material.opacity = ei * (1 - f) * 0.85;
    sp.material.color.setRGB(1, 0.5 + (1 - f) * 0.45, 0.18 + (1 - f) * 0.4);   // white-hot → deep orange
    const turb = 1 + Math.sin(elapsed * 17 + i * 1.6) * 0.14 * f;              // turbulent shimmer down the tail
    sp.scale.setScalar((0.55 + f * 1.95) * (0.6 + ei * 0.7) * turb);
  });

  // --- Heat-shield jettison: drops away and tumbles once decelerated ---
  if (u < 0.5) { rd.hs.visible = true; rd.hs.position.y = -0.14; rd.hs.rotation.set(Math.PI, 0, 0); }
  else if (u < 0.66) {
    const j = (u - 0.5) / 0.16;
    rd.hs.visible = true;
    rd.hs.position.y = -0.14 - j * 4.5;                    // falls toward Mars
    rd.hs.rotation.set(Math.PI + j * 6, j * 4, 0);         // tumbling
  } else rd.hs.visible = false;

  // --- Parachute: supersonic snatch (over-inflate, then settle), ride, cut away ---
  if (descent) {
    rd.chute.visible = true; rd.chute.position.y = 0;
    const inf = clamp01((u - 0.42) / 0.045);
    const snatch = 1 + Math.max(0, 1 - Math.abs(u - 0.475) / 0.04) * 0.28;     // brief over-inflation
    rd.chute.scale.set(inf * snatch, (0.5 + inf * 0.5) * snatch, inf * snatch);
    rd.canopy.material.opacity = 1;
  } else if (landing && u < 0.86) {
    const r = (u - 0.78) / 0.08;                          // backshell + chute cut away upward
    rd.chute.visible = true; rd.chute.position.y = r * 5; rd.chute.scale.set(1, 1, 1);
    rd.canopy.material.opacity = 1 - r;
  } else { rd.chute.visible = false; }

  // --- Powered descent: retros throttle UP as the ground nears, braking to a hover ---
  rd.retros.visible = landing;
  if (landing) {
    const thr = 0.55 + clamp01((u - 0.78) / 0.16) * 0.7;
    rd.retros.scale.set(1, thr + Math.sin(elapsed * 44) * 0.14, 1);
  }
  rd.legs.visible = u > 0.7;

  // --- Dust: blown radially out in a thin sheet as the retros hit the ground ---
  if (voyage.dust) {
    const near = landing && alt < 1.4;
    voyage.dust.visible = near;
    if (near) {
      const d = clamp01((1.4 - alt) / 1.2);                // grows as the craft settles
      voyage.dust.position.copy(M).addScaledVector(dir, mR + 0.06);
      voyage.dust.quaternion.setFromUnitVectors(UP, dir);                       // lie the sheet on the ground plane
      voyage.dust.userData.parts.forEach(p => {
        const reach = d * p.userData.speed;
        p.position.set(p.userData.dir.x * reach * 1.3, Math.abs(p.userData.dir.y) * reach * 0.18, p.userData.dir.z * reach * 1.3);
        p.material.opacity = d * (1 - d * 0.35) * 0.5;
        p.scale.setScalar(p.userData.size * (1 + reach * 1.5));
      });
    }
  }

  // --- Camera: side-on for the entry streak, closer for the chute, low for touchdown ---
  let camP, lookP;
  if (entry)        { camP = pos.clone().addScaledVector(cross, 6.0).addScaledVector(dir, 1.7).addScaledVector(tang, 2.2); lookP = pos.clone().addScaledVector(velDir, 1.2); }
  else if (descent) { camP = pos.clone().addScaledVector(cross, 4.8).addScaledVector(dir, 1.1).addScaledVector(tang, 0.6); lookP = pos.clone().addScaledVector(dir, 0.3); }
  else              { camP = pos.clone().addScaledVector(cross, 3.3).addScaledVector(dir, 0.55).addScaledVector(tang, 0.7); lookP = pos.clone().addScaledVector(dir, -0.25); }
  return { pos: camP, look: lookP };
}

function updateHelio(ph, u, dt) {
  voyage.rocket.visible = false;
  voyage.lander.visible = false;
  voyage.launchTrail.visible = false;
  voyage.flash.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  voyage.ship.visible = ph.key !== 'surface';   // ship is "landed" / hidden on the surface
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = ph.key !== 'surface';
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = true;
  orbitPaths.forEach(o => { o.visible = ph.key !== 'surface'; });  // hide orbit rings on the Mars close-up
  const s = ph.s0 + u * (ph.s1 - ph.s0);
  const st = transferState(s);
  voyage.ship.position.copy(st.pos);
  if (s < 1) voyage.ship.lookAt(transferState(Math.min(1, s + 0.002)).pos);
  voyage.ship.userData.ring.rotation.z += dt * 1.5;
  voyage.ship.userData.ring.scale.setScalar(1);   // fully deployed unless stowed during cruise emergence

  // Early in Cruise: stage separation. The spent launch vehicle is jettisoned —
  // a flash and a shower of ice/gas off the separation plane, then it tumbles
  // away as the liner's engine ignites and pulls it ahead.
  if (ph.key === 'cruise') {
    const sep = clamp01(u / 0.22);                        // slower, more readable
    const fwd = transferState(Math.min(1, s + 0.004)).pos.clone().sub(st.pos).normalize();
    const side = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const plane = st.pos.clone().addScaledVector(fwd, -1.6);    // the staging interface, at the liner's tail
    // The habitat ring rode up STOWED inside the fairing; it deploys once clear.
    const dep = clamp01((sep - 0.18) / 0.5);
    voyage.ship.userData.ring.scale.setScalar(0.12 + dep * 0.88);
    voyage.rocket.visible = sep < 1;
    voyage.rocket.userData.stage1.visible = false;       // first stage already fell away during launch
    voyage.rocket.userData.flameGrp.visible = false;     // spent — engine off
    if (sep < 1) {
      const back = 2.7 + Math.pow(sep, 0.85) * 6.5;       // starts touching the liner's tail, then eases away
      voyage.rocket.position.copy(st.pos)
        .addScaledVector(fwd, -back)                       // falls behind
        .addScaledVector(side, sep * 0.6)                 // drifts slightly aside
        .addScaledVector(UP, -sep * 0.45);                // and a touch down
      voyage.rocket.quaternion.setFromUnitVectors(UP, fwd);
      const tumble = clamp01((sep - 0.2) / 0.8);          // drifts straight first, THEN slowly tumbles
      voyage.rocket.rotateX(tumble * 2.8);
      voyage.rocket.rotateZ(tumble * 1.5);
    }
    voyage.flash.visible = sep < 0.34;                    // separation flash at the interface
    if (voyage.flash.visible) {
      const fa = 1 - sep / 0.34;
      voyage.flash.position.copy(plane);
      voyage.flash.material.opacity = fa * 0.95;
      voyage.flash.scale.setScalar(1.3 + (1 - fa) * 5.2);
    }
    // Ice/frost + pneumatic gas thrown off the separation plane (signature staging look).
    if (voyage.frost) {
      voyage.frost.visible = sep < 0.9;
      voyage.frost.position.copy(plane);
      voyage.frost.userData.parts.forEach(p => {
        p.position.copy(p.userData.dir).multiplyScalar(sep * p.userData.speed * 2.4);
        p.material.opacity = clamp01(1 - sep / 0.9) * 0.7;
        p.scale.setScalar(p.userData.size * (0.6 + sep * 1.6));
      });
    }
    // Spacecraft engine: OFF until the spent stage is clear, THEN ignites — a bright
    // transient over-expansion settling into the steady vacuum plume of the injection
    // burn. Real sequencing: separate first, then light.
    const sd = voyage.ship.userData;
    const lit = sep > 0.12 && u < 0.18;
    sd.plume.visible = lit;
    if (lit) {
      const ign = Math.max(0, 1 - (sep - 0.12) / 0.07);   // ignition transient (over-expanded plume)
      const fl = (0.9 + Math.sin(elapsed * 34) * 0.12) * (1 + ign * 0.9);
      sd.plume.scale.set(fl, (1.1 + Math.sin(elapsed * 18) * 0.12) * (1 + ign * 1.2), fl);
      sd.trail.material.opacity = 0.9;
      sd.trail.scale.setScalar((2.6 + Math.sin(elapsed * 28) * 0.4) * (1 + ign * 0.7));
    } else {
      sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001);
    }
  } else {
    if (voyage.frost) voyage.frost.visible = false;
    const sd = voyage.ship.userData;
    sd.plume.visible = false;
    sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001);
  }
  if (voyage.dust) voyage.dust.visible = false;
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  // Mars surface colony — shown only on the Surface Operations close-up, planted on
  // the camera-facing surface point with its spin frozen so it holds still.
  if (voyage.base) {
    if (ph.key === 'surface') {
      planetMeshes.mars.mesh.rotation.y = 0.6;
      const Mw = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(Mw);
      voyage.base.position.copy(Mw).addScaledVector(BASE_N, planetMeshes.mars.config.size);
      voyage.base.quaternion.setFromUnitVectors(UP, BASE_N);
      voyage.base.visible = true;
    } else voyage.base.visible = false;
  }
  const pts = []; const n = 90;
  for (let i = 0; i <= n; i++) {
    const nu = (i / n) * st.nu;
    const r = A_T * (1 - E_T * E_T) / (1 + E_T * Math.cos(nu));
    pts.push(new THREE.Vector3(Math.cos(EARTH_ANGLE + nu) * r, 0, Math.sin(EARTH_ANGLE + nu) * r));
  }
  voyage.ellipseTrail.geometry.setFromPoints(pts);
  return { s, st };
}

function updateTelemetry(ph, u, s) {
  // Per-stage text + traveller's-log facts: only rewrite when the stage changes.
  if (voyage.stage !== voyage.lastStage) {
    voyage.lastStage = voyage.stage;
    vEls['v-phase'].textContent = ph.short;
    vEls['vc-tag'].textContent = ph.tag;
    vEls['v-law'].textContent = ph.law;
    vEls['v-notes'].innerHTML = ph.facts.map(f => `<div class="note">› ${f}</div>`).join('');
    highlightStage();
  }
  if (ph.mode === 'launch') {
    const secs = u * 540;
    vEls['v-elapsed'].textContent = `T+ ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
    vEls['v-vel'].textContent = `${(u * 7.8).toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = `${Math.round(u * 400)} KM ALT`;
    vEls['v-engine'].textContent = '● BURN'; vEls['v-engine'].className = 'warn';
  } else if (ph.mode === 'edl') {
    vEls['v-elapsed'].textContent = `ALT ${Math.max(0, Math.round(Math.pow(1 - u, 1.5) * 125))} KM`;
    vEls['v-vel'].textContent = `${(Math.pow(1 - u, 1.2) * 5.4 + 0.05).toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = u < 0.42 ? 'ATMOS. ENTRY' : (u < 0.78 ? 'PARACHUTE' : 'POWERED DESCENT');
    const hot = u < 0.42, retro = u >= 0.78;
    vEls['v-engine'].textContent = hot ? '▲ ENTRY' : (retro ? '● RETRO' : '○ CHUTE');
    vEls['v-engine'].className = (hot || retro) ? 'warn' : '';
  } else {
    const st = voyageStats(s);
    vEls['v-elapsed'].textContent = `DAY ${Math.round(st.day)} / 259`;
    vEls['v-vel'].textContent = `${st.v.toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = `${st.rAU.toFixed(2)} AU`;
    // Match the visuals: separation (engine off) → injection burn → coast.
    let eng = '○ OFF', warn = false;
    if (ph.key === 'cruise' && u / 0.22 < 0.12) eng = '○ SEP';
    else if (ph.burn || (ph.key === 'cruise' && u >= 0.026 && u < 0.18)) { eng = '● BURN'; warn = true; }
    vEls['v-engine'].textContent = eng;
    vEls['v-engine'].className = warn ? 'warn' : '';
  }
}

function highlightStage() {
  const key = PHASES[voyage.stage].key;
  document.querySelectorAll('.sim-stage').forEach(b => b.classList.toggle('active', b.dataset.stage === key));
}

function updateVoyage(dt) {
  if (voyage.playing) {
    voyage.t += dt;
    const cur = PHASES[voyage.stage];
    if (voyage.t >= cur.t1) {
      if (voyage.stage < PHASES.length - 1) {        // auto-advance to the next stage
        voyage.stage++;
        voyage.t = PHASES[voyage.stage].t0;
        voyage.camInit = false;
      } else {                                       // end of the journey
        voyage.t = cur.t1;
        setVoyagePlay(false);
      }
    }
  }
  const ph = PHASES[voyage.stage];
  const u = clamp01((voyage.t - ph.t0) / ph.dur);
  vEls['v-progress'].style.width = (u * 100).toFixed(1) + '%';  // per-stage progress
  let cam;
  if (ph.mode === 'launch') {
    cam = updateLaunch(u);
    updateTelemetry(ph, u, null);
  } else if (ph.mode === 'edl') {
    cam = updateEDL(u);
    updateTelemetry(ph, u, 0.94 + u * 0.06);
  } else {
    const { s, st } = updateHelio(ph, u, dt);
    updateTelemetry(ph, u, s);
    // Cruise opens near Earth (the staging), then settles into the ring close-up.
    let view = ph.view;
    if (ph.key === 'cruise') view = u < 0.24 ? 'depart' : 'ring';
    cam = viewTarget(view, st, s);
  }
  if (!voyage.camInit) { voyage.camPos.copy(cam.pos); voyage.camLook.copy(cam.look); voyage.camInit = true; }
  const k = 1 - Math.exp(-dt * 2.4);
  voyage.camPos.lerp(cam.pos, k);
  voyage.camLook.lerp(cam.look, k);
  camera.position.copy(voyage.camPos);
  camera.lookAt(voyage.camLook);
}

function setVoyagePlay(p) {
  if (p) {
    // Pressing play at the end of a stage advances to (and plays) the next one.
    const cur = PHASES[voyage.stage];
    if (voyage.t >= cur.t1 - 1e-4) {
      voyage.stage = (voyage.stage + 1) % PHASES.length;
      voyage.t = PHASES[voyage.stage].t0;
      voyage.camInit = false;
    }
  }
  voyage.playing = p;
  vEls['v-playpause'].textContent = p ? '❚❚ PAUSE' : '▶ PLAY';
}

function startVoyage() {
  if (voyage.active) return;
  voyage.active = true;
  voyage.t = 0;
  voyage.stage = 0;
  voyage.lastStage = -1;
  voyage.manualView = null;
  voyage.lastHighlight = null;
  voyage.camInit = false;
  controls.enabled = false;
  camTween = null; followKey = null;

  if (!voyage.ship) {
    voyage.ship = buildLiner();
    scene.add(voyage.ship);
    voyage.rocket = buildRocket();
    scene.add(voyage.rocket);
    voyage.spentStage = buildSpentStage();
    voyage.spentStage.visible = false;
    scene.add(voyage.spentStage);
    voyage.lander = buildLander();
    scene.add(voyage.lander);
    voyage.launchTrail = buildLaunchTrail();
    scene.add(voyage.launchTrail);
    voyage.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(['rgba(255,255,255,0.95)', 'rgba(255,205,130,0.5)', 'rgba(255,120,40,0)']),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    }));
    voyage.flash.visible = false;
    scene.add(voyage.flash);
    voyage.frost = buildParticles(26, 0xdff0ff, true, 0.05, 0.17);   // ice/gas at staging
    scene.add(voyage.frost);
    voyage.dust = buildParticles(28, 0xc98f63, false, 0.18, 0.5);    // dust at touchdown
    scene.add(voyage.dust);
    voyage.base = buildMarsBase();                                   // Mars surface colony
    voyage.base.visible = false;
    scene.add(voyage.base);
    voyage.ellipseFull = buildEllipseLine(240, 0.22, 0x6ff1ff);
    scene.add(voyage.ellipseFull);
    voyage.ellipseTrail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xb8f8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    scene.add(voyage.ellipseTrail);
  }
  planetMeshes.earth.orbitGroup.rotation.y = -EARTH_ANGLE;

  document.getElementById('voyage').classList.remove('hidden');
  document.getElementById('voyage-controls').classList.remove('hidden');
  document.getElementById('hud').classList.add('voyage-on');
  setVoyagePlay(false);   // start paused — the viewer presses play
}

function endVoyage() {
  if (!voyage.active) return;
  voyage.active = false;
  voyage.playing = false;
  controls.enabled = true;
  if (voyage.ship) {
    voyage.ship.visible = voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
    voyage.rocket.visible = voyage.launchTrail.visible = voyage.flash.visible = false;
    voyage.lander.visible = false;
    if (voyage.frost) voyage.frost.visible = false;
    if (voyage.dust) voyage.dust.visible = false;
    if (voyage.base) voyage.base.visible = false;
    if (voyage.spentStage) voyage.spentStage.visible = false;
  }
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = true;
  orbitPaths.forEach(o => { o.visible = true; });
  document.getElementById('voyage').classList.add('hidden');
  document.getElementById('voyage-controls').classList.add('hidden');
  document.getElementById('hud').classList.remove('voyage-on');
  document.querySelectorAll('.sim-stage').forEach(b => b.classList.remove('active'));
  controls.target.set(0, 0, 0);
  focusOn(null);
}

// Voyage simulator — a button per stage (top-right panel, always visible).
function startVoyageAtStage(key) {
  if (!voyage.active) startVoyage();
  voyage.manualView = null;
  const i = PHASES.findIndex(p => p.key === key);
  voyage.stage = i >= 0 ? i : 0;          // 'full' / unknown → first stage
  voyage.t = PHASES[voyage.stage].t0;
  voyage.camInit = false;                 // snap the camera to the chosen stage
  setVoyagePlay(false);                   // seek + PAUSE; the viewer presses play
}
document.querySelectorAll('.sim-stage').forEach(b =>
  b.addEventListener('click', () => startVoyageAtStage(b.dataset.stage)));

vEls['v-playpause'].addEventListener('click', () => setVoyagePlay(!voyage.playing));
document.getElementById('v-replay').addEventListener('click', () => {
  voyage.t = PHASES[voyage.stage].t0;   // restart the current stage from the top
  voyage.camInit = false;
  setVoyagePlay(true);
});

addEventListener('keydown', e => {
  if (!voyage.active) return;
  if (e.code === 'Space') { e.preventDefault(); setVoyagePlay(!voyage.playing); }
  else if (e.code === 'Escape') endVoyage();
});

// ============================================================
// 13. ANIMATION LOOP
// ============================================================
let elapsed = 0;

function animate() {
  const dt = clock.getDelta();
  elapsed += dt;
  const t = elapsed;

  // Sun shader
  sunUniforms.uTime.value = t;
  sun.rotation.y += dt * 0.05;

  // Planets — orbit + spin
  for (const key in planetMeshes) {
    const pm = planetMeshes[key];
    // During a voyage, orbital revolution is frozen so the transfer diagram
    // holds still; Earth/Mars positions are driven by the voyage controller.
    if (!voyage.active) {
      pm.angle += dt * 0.05 * pm.config.speed;
      pm.orbitGroup.rotation.y = pm.angle;
    }
    pm.mesh.rotation.y += dt * pm.config.spin;
    if (pm.mesh.userData.clouds) {
      // Clouds are children of the mesh — they inherit spin. Add a small differential drift.
      pm.mesh.userData.clouds.rotation.y += dt * 0.05;
      pm.mesh.userData.clouds.material.uniforms.uTime.value = t;
    }
    pm.material.uniforms.uTime.value = t;
    // Update light position relative to sun
    pm.material.uniforms.uLightPos.value.set(0, 0, 0);
  }

  updateEarthSats(dt);   // satellites orbiting Earth

  // Asteroid belt drift
  const dummy = asteroidBelt.userData.dummy;
  const data = asteroidBelt.userData.data;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    d.a += dt * d.speed * 0.08;
    d.rx += dt * 0.4;
    d.ry += dt * 0.3;
    dummy.position.set(Math.cos(d.a) * d.r, d.y, Math.sin(d.a) * d.r);
    dummy.rotation.set(d.rx, d.ry, 0);
    dummy.scale.setScalar(d.s);
    dummy.updateMatrix();
    asteroidBelt.setMatrixAt(i, dummy.matrix);
  }
  asteroidBelt.instanceMatrix.needsUpdate = true;

  if (voyage.active) {
    // Voyage controller drives the camera directly (OrbitControls disabled).
    updateVoyage(dt);
  } else {
    // Camera tween (in flight) — finishes when k reaches 1, then we hand off to follow
    if (camTween) {
      camTween.t += dt / camTween.duration;
      const k = Math.min(1, camTween.t);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
      controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
      if (k >= 1) camTween = null;
    } else if (followKey) {
      // Once tween is over, translate camera + target to track moving planet
      const pm = planetMeshes[followKey];
      const newTarget = new THREE.Vector3();
      pm.tiltGroup.getWorldPosition(newTarget);
      const delta = newTarget.clone().sub(controls.target);
      controls.target.copy(newTarget);
      camera.position.add(delta);
    }
    // Attract-mode drift only when idle (not flying to / tracking a body).
    controls.autoRotate = !camTween && !followKey;
    controls.update();
  }

  // HUD live readouts
  const seconds = Math.floor(performance.now() / 1000);
  timeEl.textContent = new Date(seconds * 1000).toISOString().slice(11, 19);

  composer.render();
  requestAnimationFrame(animate);
}

animate();

// ============================================================
// 14. RESIZE
// ============================================================
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});
