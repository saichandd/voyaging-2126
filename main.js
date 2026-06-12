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
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ============================================================
// 1. CORE SETUP
// ============================================================
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Filmic tonemapping (ACES) applied by OutputPass at the end of the chain — render
// passes stay linear/HDR so bloom samples values > 1.0, then ACES gives a cinematic
// highlight rolloff instead of the old flat, clipped look.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Soft contact shadows for the hero close-ups (one directional sun light).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000206);
scene.fog = new THREE.FogExp2(0x070a18, 0.00016);

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
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.11, 0.32, 1.6);
composer.addPass(bloom);

// Cinematic grade — edge chromatic aberration + soft vignette + fine film grain.
// Runs in linear HDR before OutputPass (which is the sole ACES tonemap + sRGB encode).
const gradePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, grainAmt: { value: 0.04 }, caAmount: { value: 0.0016 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, grainAmt, caAmount; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; float dist = length(d);
      vec2 off = d * caAmount * (0.3 + dist*2.5);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= mix(0.68, 1.0, smoothstep(0.85, 0.32, dist));     // soft vignette (never black)
      col += (hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 100.0) - 0.5) * grainAmt;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
});
composer.addPass(gradePass);
const smaaPass = new SMAAPass(innerWidth, innerHeight);
composer.addPass(smaaPass);
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ============================================================
// 2. UTILITIES
// ============================================================
const clock = new THREE.Clock();
const TAU = Math.PI * 2;
// Shared lighting/scratch constants for the render overhaul.
const SUN_DIR = new THREE.Vector3(40, 18, 25).normalize();   // env-bake sun direction (IBL highlight)
const _tmpVec = new THREE.Vector3();
const _shFwd = new THREE.Vector3(), _shRight = new THREE.Vector3(), _shUp = new THREE.Vector3(), _shLook = new THREE.Vector3();

// ---- Texture loading (real photoreal maps live in /textures) ----
const texLoader = new THREE.TextureLoader();
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
const TEX = 'textures/';
// srgb:true for colour / emissive / sky maps; default = linear data (normal / roughness / bump).
function loadTex(url, { srgb = false } = {}) {
  const t = texLoader.load(TEX + url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = MAX_ANISO;
  return t;
}

// ---- Procedural surface-detail maps (built once, shared): panel/rivet normal + lit windows ----
function sobelToNormal(ctx, s, STR = 2.0) {
  const src = ctx.getImageData(0, 0, s, s).data, out = ctx.createImageData(s, s), d = out.data;
  const H = (px, py) => src[((((py + s) % s) * s) + ((px + s) % s)) * 4] / 255;
  for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) {
    const dx = (H(px + 1, py) - H(px - 1, py)) * STR, dy = (H(px, py + 1) - H(px, py - 1)) * STR;
    const nx = -dx, ny = -dy, nz = 1, l = Math.hypot(nx, ny, nz), o = (py * s + px) * 4;
    d[o] = (nx / l * 0.5 + 0.5) * 255; d[o + 1] = (ny / l * 0.5 + 0.5) * 255; d[o + 2] = (nz / l * 0.5 + 0.5) * 255; d[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(ctx.canvas); tex.colorSpace = THREE.NoColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; return tex;
}
function panelNormalTexture(s = 1024, cols = 6, rows = 14) {
  const c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const v = 122 + (Math.random() * 14 | 0); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i * s / cols, j * s / rows, s / cols, s / rows); }
  x.strokeStyle = 'rgba(40,40,40,1)'; x.lineWidth = 3;
  for (let i = 1; i < cols; i++) { x.beginPath(); x.moveTo(i * s / cols, 0); x.lineTo(i * s / cols, s); x.stroke(); }
  for (let j = 1; j < rows; j++) { x.beginPath(); x.moveTo(0, j * s / rows); x.lineTo(s, j * s / rows); x.stroke(); }
  x.fillStyle = 'rgba(228,228,228,1)';
  for (let i = 1; i < cols; i++) for (let j = 0; j < rows * 5; j++) { x.beginPath(); x.arc(i * s / cols, (j / (rows * 5)) * s, 1.7, 0, TAU); x.fill(); }
  return sobelToNormal(x, s);
}
function windowGridTexture(w = 1024, h = 256, cols = 44, rows = 4) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  x.fillStyle = '#04060a'; x.fillRect(0, 0, w, h); const cw = w / cols, ch = h / rows, pad = Math.min(cw, ch) * 0.24;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const r = Math.random(); if (r < 0.2) continue; x.globalAlpha = 0.55 + Math.random() * 0.45; x.fillStyle = r < 0.82 ? '#ffd9a0' : '#bfe9ff'; x.fillRect(i * cw + pad, j * ch + pad, cw - 2 * pad, ch - 2 * pad); }
  x.globalAlpha = 1; const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; return tex;
}
const PANEL_N = panelNormalTexture();
const WIN_TEX = windowGridTexture();
const winMat = new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 0.5, metalness: 0.4, emissive: 0xffffff, emissiveMap: WIN_TEX, emissiveIntensity: 1.5 });

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
  // Soft day/night terminator (smooth, not a hard line). N,L in world space.
  float dayNight(vec3 N, vec3 L){ return smoothstep(-0.18, 0.22, dot(N, L)); }
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
    if (v < 0.7) c.setHSL(0.58, 0.10, 0.78 + Math.random() * 0.22);
    else if (v < 0.9) c.setHSL(0.13, 0.28, 0.75 + Math.random() * 0.2);
    else c.setHSL(0.07, 0.45, 0.7);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.3, vertexColors: true, sizeAttenuation: false,
    transparent: true, opacity: 0.8,
    map: radialTexture(['rgba(255,255,255,1)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)'], 64),
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

scene.add(buildStarfield(9000, 3000));

// ------------------------------------------------------------
// Milky Way background dome — a canvas-painted equirectangular galaxy (deep base +
// soft nebula clouds + a bright galactic band + thousands of baked stars). Replaces
// the empty black void so every shot has depth. Drawn once; zero external files.
// ------------------------------------------------------------
function makeGalaxyTexture(w = 2048, h = 1024) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#02030a'; x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'lighter';
  const nebCols = ['rgba(40,60,120,0.10)', 'rgba(90,40,110,0.08)', 'rgba(30,90,110,0.08)', 'rgba(120,70,40,0.06)'];
  for (let i = 0; i < 24; i++) {
    const cx = Math.random() * w, cy = h * (0.30 + Math.random() * 0.4), r = 120 + Math.random() * 380;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, nebCols[i % nebCols.length]); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.fill();
  }
  // bright milky galactic band across the middle
  const band = x.createLinearGradient(0, h * 0.36, 0, h * 0.64);
  band.addColorStop(0, 'rgba(0,0,0,0)'); band.addColorStop(0.5, 'rgba(175,185,215,0.13)'); band.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = band; x.fillRect(0, h * 0.36, w, h * 0.28);
  // stars — dense near the band, sparse elsewhere; varied size + stellar colour
  for (let i = 0; i < 7000; i++) {
    const inBand = Math.random() < 0.6;
    const sx = Math.random() * w;
    const sy = inBand ? h * (0.42 + Math.random() * 0.16) : Math.random() * h;
    const r = Math.random() < 0.96 ? Math.random() * 0.5 + 0.25 : Math.random() * 0.8 + 0.7;   // fine dusting
    const b = 0.4 + Math.random() * 0.45, t = Math.random();
    x.fillStyle = t < 0.7 ? `rgba(255,255,255,${b})` : t < 0.9 ? `rgba(200,220,255,${b})` : `rgba(255,225,190,${b})`;
    x.beginPath(); x.arc(sx, sy, r, 0, TAU); x.fill();
  }
  x.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
// Real Milky Way as the scene background (equirectangular). IBL stays the PMREM env (independent).
const skyTex = loadTex('2k_stars_milky_way.jpg', { srgb: true });
skyTex.mapping = THREE.EquirectangularReflectionMapping;
scene.background = skyTex;
scene.backgroundIntensity = 0.5;

// ============================================================
// 4. SUN
// ============================================================
const sunGroup = new THREE.Group();
scene.add(sunGroup);

const sunRadius = 9;
// Real solar photosphere texture, pushed above 1.0 (toneMapped:false) so it stays blinding
// and feeds the bloom as a true HDR emitter.
const sunTex = loadTex('2k_sun.jpg', { srgb: true });
const sunMat = new THREE.MeshBasicMaterial({ map: sunTex, color: new THREE.Color(1.7, 1.5, 1.2), toneMapped: false });
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
addCoronaSprite(sunRadius * 2.3, 0.3, ['rgba(255,210,120,0.85)', 'rgba(255,140,40,0.35)', 'rgba(255,90,30,0)']);

// ---- Lighting + image-based lighting (IBL) ----
// A dim procedural "space" environment gives the PBR craft (metal/glass) believable
// reflections without flooding them like a studio: one hot sun disc on a navy gradient,
// baked to a PMREM env map used for IBL only (the visible background stays black).
function buildSpaceEnvScene() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(0x0a1426) }, bot: { value: new THREE.Color(0x01030a) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bot;
        void main(){ float h = clamp(normalize(vP).y*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bot,top,h),1.0); }`,
    })
  ));
  const sd = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe7c4).multiplyScalar(6.0) }));   // >1 = HDR for PMREM
  sd.position.copy(SUN_DIR).multiplyScalar(50);
  env.add(sd);
  return env;
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(buildSpaceEnvScene(), 0.25, 0.1, 100);   // placeholder IBL for frame 1
scene.environment = envRT.texture;
// Real studio HDRI for image-based reflections (roughness-correct). Keep pmrem alive until it loads.
new RGBELoader().load(TEX + 'studio_env_2k.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose(); envRT.dispose(); pmrem.dispose();
});

// Trim per-material env reflection strength so space stays moody (called after craft build).
function setEnvIntensity(root, intensity) {
  root.traverse(o => {
    const m = o.material; if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach(mat => {
      if (mat && mat.isMeshStandardMaterial) { mat.envMapIntensity = intensity; mat.needsUpdate = true; }
    });
  });
}

// Warm point fill at the sun (planets read it through their own shaders).
const sunLight = new THREE.PointLight(0xffd9a8, 0.7, 0, 1.2);
scene.add(sunLight);

// Directional "sun" key with soft shadows. Re-aimed each voyage frame from the sun
// (origin) toward the current subject so craft are lit consistently with the planets.
const sunKey = new THREE.DirectionalLight(0xfff4e6, 3.2);
sunKey.position.copy(SUN_DIR).multiplyScalar(200);
sunKey.castShadow = true;
sunKey.shadow.mapSize.set(2048, 2048);
sunKey.shadow.bias = -0.0005;
sunKey.shadow.normalBias = 0.04;
scene.add(sunKey);
scene.add(sunKey.target);
function frameSunShadow(center, radius) {
  const dir = _tmpVec.copy(center);
  if (dir.lengthSq() < 1e-6) dir.copy(SUN_DIR); else dir.normalize();   // sun(origin) → subject
  const c = sunKey.shadow.camera;
  c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
  c.near = 1; c.far = radius * 8;
  sunKey.position.copy(center).addScaledVector(dir, -radius * 4);        // step back toward the sun
  sunKey.target.position.copy(center); sunKey.target.updateMatrixWorld();
  c.updateProjectionMatrix();
}

// Cool rim back-light + sky/ground hemisphere fill so craft separate from the void.
const rimLight = new THREE.DirectionalLight(0x88b4ff, 0.3);
rimLight.position.copy(SUN_DIR).multiplyScalar(-180); rimLight.position.y += 60;
scene.add(rimLight); scene.add(rimLight.target);
scene.add(new THREE.HemisphereLight(0x223a5e, 0x05060a, 0.12));   // dim — let IBL carry the ambient

// ============================================================
// 5. PLANET FACTORY (procedural shader)
// ============================================================
function makePlanetMaterial({ base, accent, polar, scale, ridges = false, banded = false, glow = 0.0, variant = null }) {
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
      uVariant: { value: variant === 'earth' ? 1.0 : variant === 'mars' ? 2.0 : 0.0 },
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
      uniform float uVariant;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      ${NOISE_GLSL}
      void main() {
        vec3 nPos = normalize(vLocalPos);
        vec3 L = normalize(uLightPos - vWorldPos);          // sun at the origin, per-fragment
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 col;

        if (uVariant > 1.5) {
          // ---- MARS: ridged terrain, warped canyons, polar caps, dusty limb ----
          vec3 warp = vec3(fbm(nPos*2.0+vec3(5.0)), fbm(nPos*2.0+vec3(9.0)), fbm(nPos*2.0+vec3(13.0)));
          float terr = ridged(nPos*2.6 + warp*0.8);
          float canyon = 1.0 - smoothstep(0.0, 0.06, abs(fbm(nPos*3.0+warp*1.5) - 0.5));
          vec3 surf = mix(vec3(0.42,0.13,0.06), vec3(0.80,0.36,0.17), smoothstep(0.35,0.8,terr));
          surf = mix(surf, vec3(0.22,0.07,0.04), canyon*0.7);
          surf *= 0.85 + 0.3*fbm(nPos*12.0);
          float cap = smoothstep(0.80, 0.90, abs(nPos.y) + fbm(nPos*5.0)*0.08);
          surf = mix(surf, vec3(0.95,0.93,0.97), cap);
          float d = dayNight(vNormal, L);
          float rim = pow(1.0 - max(dot(vNormal,V),0.0), 3.0);
          col = surf*(d*0.95+0.06) + vec3(0.95,0.55,0.45)*rim*0.14*d;

        } else if (uVariant > 0.5) {
          // ---- EARTH: continents/oceans, ocean glint, cloud shadow, night-side lights ----
          vec3 q = vec3(fbm(nPos*1.7+vec3(11.0)), fbm(nPos*1.7+vec3(27.0)), fbm(nPos*1.7+vec3(41.0)));
          float h = fbm(nPos*2.3 + q*1.4);
          float land = smoothstep(0.50, 0.55, h);
          float lat = abs(nPos.y);
          vec3 ocean = mix(vec3(0.012,0.05,0.18), vec3(0.03,0.24,0.36), smoothstep(0.48,0.54,h) + fbm(nPos*0.8)*0.15);
          vec3 landCol = mix(vec3(0.55,0.44,0.22), vec3(0.09,0.30,0.11), smoothstep(0.05,0.35,lat));   // desert→lush
          landCol = mix(landCol, vec3(0.42,0.40,0.36), smoothstep(0.55,0.8,lat));                        // →tundra
          landCol = mix(landCol, landCol*1.2, smoothstep(0.58,0.82,h));                                  // highlands
          landCol *= 0.85 + 0.3*fbm(nPos*9.0);
          float ice = smoothstep(0.85, 0.94, lat + fbm(nPos*4.0)*0.07);   // confined to the poles
          vec3 surf = mix(mix(ocean, landCol, land), vec3(0.86,0.89,0.94), ice);
          float d = dayNight(vNormal, L);
          vec3 H = normalize(L + V);
          float spec = pow(max(dot(vNormal,H),0.0), 90.0) * (1.0-land) * d;                              // ocean glint
          vec3 cp = nPos*4.0 + vec3(uTime*0.012, 0.0, uTime*0.005);
          float cl = smoothstep(0.55, 0.92, fbm(cp)*0.7 + fbm(cp*2.5)*0.3);
          float shadow = 1.0 - cl*0.30;
          float lightsMask = land * smoothstep(0.50, 0.85, fbm(nPos*22.0)) * (1.0-ice);
          vec3 night = vec3(1.0,0.82,0.45) * lightsMask * (1.0-d) * 0.9;
          float rim = pow(1.0 - max(dot(vNormal,V),0.0), 3.0);
          col = surf*(d*shadow) + vec3(0.9,0.95,1.0)*spec*0.35 + night + vec3(0.45,0.66,1.0)*rim*0.18*d;

        } else {
          // ---- DEFAULT: rocky / gas-giant procedural (mercury, venus, jupiter, ...) ----
          vec3 p = nPos * uScale;
          float n = fbm(p);
          float r = ridged(p * 1.5);
          float bands = sin(nPos.y * 14.0 + fbm(p * 2.5) * 2.4) * 0.5 + 0.5;
          float surface = mix(mix(n, r, uRidges), bands, uBanded);
          col = mix(uBase, uAccent, smoothstep(0.35, 0.7, surface));
          float detail = fbm(p * 5.0);
          col = mix(col, col * 0.7, smoothstep(0.4, 0.7, detail) * 0.4);
          float pcap = smoothstep(0.78, 0.95, abs(nPos.y) + fbm(p * 3.0) * 0.07) * (1.0 - uBanded * 0.7);
          col = mix(col, uPolar, pcap);
          float ndl = max(0.0, dot(vNormal, L));
          col *= pow(ndl, 0.85) * 0.92 + 0.08;
          float rim = pow(1.0 - max(0.0, dot(vNormal, V)), 3.0) * (0.25 + uGlow);
          col += uAccent * rim * 0.6;
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Thin wrappers so the Mars surface ground-cap (Surface Ops) shares the exact same
// shader as the orbital globe — colours match the PLANETS rows for Earth/Mars.
// Real-texture Earth: day colour + normal + (inverted) specular→roughness + night-side city lights,
// with a soft day/night terminator driven by a per-frame sun-direction uniform.
function buildEarthMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    map: loadTex('earth_atmos_2048.jpg', { srgb: true }),
    normalMap: loadTex('earth_normal_2048.jpg'),
    roughnessMap: loadTex('earth_specular_2048.jpg'),
    metalness: 0.0, roughness: 1.0,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: loadTex('earth_lights_2048.png', { srgb: true }),
    emissiveIntensity: 1.0,
    normalScale: new THREE.Vector2(1.15, 1.15),   // deeper terrain relief
    envMapIntensity: 0.32,
  });
  const sunDir = { value: new THREE.Vector3().copy(SUN_DIR) };
  mat.userData.sunDirRef = sunDir;   // animate loop updates this each frame
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDir = sunDir;
    sh.uniforms.uNight = { value: 2.2 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n  varying vec3 vEarthWN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vEarthWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n  uniform vec3 uSunDir;\n  uniform float uNight;\n  varying vec3 vEarthWN;')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.95, 0.12, texture2D(roughnessMap, vRoughnessMapUv).g);')   // oceans smooth (soft glint), land rough
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= smoothstep(0.12, -0.25, dot(normalize(vEarthWN), normalize(uSunDir))) * uNight;');   // city lights on the night side only
  };
  return mat;
}
function buildMarsMaterialReal() {
  return new THREE.MeshStandardMaterial({
    map: loadTex('2k_mars.jpg', { srgb: true }),
    bumpMap: loadTex('2k_mars.jpg'), bumpScale: 0.04,
    roughness: 1.0, metalness: 0.0, envMapIntensity: 0.15,
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
        vec3 L = normalize(-vWorld);                        // sun at the origin
        float vdn = max(0.0, dot(vNormal, V));
        float fres = pow(1.0 - vdn, 2.4);                   // wider, softer limb halo
        float lit = smoothstep(-0.35, 0.45, dot(vNormal, L));
        float fwd = pow(max(0.0, dot(V, -L)), 2.5);         // forward-scatter brightening toward the sun
        float a = fres * (0.28 + 0.72 * lit) * uIntensity * (1.0 + 0.7 * fwd);
        gl_FragColor = vec4(uColor * a, a);
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
          float c = smoothstep(0.64, 0.98, n * 0.7 + n2 * 0.3);   // sparse, wispy coverage
          vec3 L = normalize(-vWorld);
          float ndl = max(0.0, dot(vNormal, L));
          float lighting = ndl * 0.65 + 0.04;                     // softer so it doesn't blow out
          gl_FragColor = vec4(uColor * lighting, c * 0.5);
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
  {
    key: 'mercury', name: 'MERCURY', size: 1.1, dist: 28, speed: 1.6, spin: 0.10, tilt: 0.05,
    base: 0x8a7a6a, accent: 0x40342a, polar: 0x6a5a4a, scale: 4.5, ridges: true, vel: 47.4,
    desc: 'The smallest planet and closest to the Sun. Airless and cratered, its surface swings from 430°C in daylight to −180°C at night.',
    rows: [['DIAMETER', '4,879 KM'], ['FROM SUN', '0.39 AU'], ['ORBIT', '88 D'], ['DAY', '176 D'], ['GRAVITY', '0.38 g'], ['MOONS', '0']]
  },
  {
    key: 'venus', name: 'VENUS', size: 1.55, dist: 44, speed: 1.18, spin: -0.04, tilt: 0.02,
    base: 0xe8b888, accent: 0x9a5a30, polar: 0xead4a0, scale: 3.5, ridges: false, vel: 35.0,
    desc: 'Earth’s twin in size, wrapped in a crushing carbon-dioxide atmosphere. A runaway greenhouse holds the surface near 465°C.',
    rows: [['DIAMETER', '12,104 KM'], ['FROM SUN', '0.72 AU'], ['ORBIT', '225 D'], ['DAY', '117 D'], ['GRAVITY', '0.90 g'], ['MOONS', '0']]
  },
  {
    key: 'earth', name: 'EARTH', size: 1.7, dist: 64, speed: 1.0, spin: 0.5, tilt: 0.41,
    base: 0x1d6dc8, accent: 0x2a8e54, polar: 0xf2f7ff, scale: 4.0, ridges: false, vel: 29.8,
    desc: 'Our home world and the departure point for the voyage. The only planet known to hold liquid water on its surface.',
    rows: [['DIAMETER', '12,742 KM'], ['FROM SUN', '1.00 AU'], ['ORBIT', '365 D'], ['DAY', '24 H'], ['GRAVITY', '1.00 g'], ['MOONS', '1']]
  },
  {
    key: 'mars', name: 'MARS', size: 1.32, dist: 88, speed: 0.78, spin: 0.48, tilt: 0.44,
    base: 0xc44a26, accent: 0x6a2412, polar: 0xf6e0c0, scale: 3.6, ridges: true, vel: 24.1,
    desc: 'The destination — a cold desert world half Earth’s size. Home to Olympus Mons, the tallest volcano in the Solar System.',
    rows: [['DIAMETER', '6,779 KM'], ['FROM SUN', '1.52 AU'], ['ORBIT', '687 D'], ['DAY', '24.6 H'], ['GRAVITY', '0.38 g'], ['MOONS', '2']]
  },
  {
    key: 'jupiter', name: 'JUPITER', size: 4.6, dist: 150, speed: 0.42, spin: 0.7, tilt: 0.05,
    base: 0xd8a878, accent: 0x6a3a22, polar: 0xeed8a8, scale: 2.6, ridges: false, banded: true, vel: 13.1,
    desc: 'The largest planet — a gas giant that could swallow over 1,300 Earths. Its Great Red Spot is a storm centuries old.',
    rows: [['DIAMETER', '139,820 KM'], ['FROM SUN', '5.20 AU'], ['ORBIT', '11.9 Y'], ['DAY', '9.9 H'], ['GRAVITY', '2.53 g'], ['MOONS', '95']]
  },
  {
    key: 'saturn', name: 'SATURN', size: 3.9, dist: 210, speed: 0.30, spin: 0.62, tilt: 0.47,
    base: 0xb59868, accent: 0x68502a, polar: 0xc8b48a, scale: 2.4, ridges: false, banded: true, vel: 9.7,
    desc: 'The ringed giant. Its bright ice rings span roughly 280,000 km yet are only tens of metres thick.',
    rows: [['DIAMETER', '116,460 KM'], ['FROM SUN', '9.54 AU'], ['ORBIT', '29.4 Y'], ['DAY', '10.7 H'], ['GRAVITY', '1.07 g'], ['MOONS', '146']],
    special: 'rings'
  },
  {
    key: 'uranus', name: 'URANUS', size: 2.4, dist: 260, speed: 0.22, spin: 0.4, tilt: 1.71,
    base: 0x9adde5, accent: 0x3a7a92, polar: 0xc8eef2, scale: 2.2, ridges: false, vel: 6.8,
    desc: 'An ice giant tipped on its side, rolling around the Sun at a 98° tilt. Methane gives it a pale blue-green colour.',
    rows: [['DIAMETER', '50,724 KM'], ['FROM SUN', '19.2 AU'], ['ORBIT', '84 Y'], ['DAY', '17.2 H'], ['GRAVITY', '0.89 g'], ['MOONS', '28']]
  },
  {
    key: 'neptune', name: 'NEPTUNE', size: 2.35, dist: 305, speed: 0.18, spin: 0.42, tilt: 0.49,
    base: 0x3a6ad8, accent: 0x1a2a78, polar: 0xc0d8f8, scale: 2.4, ridges: false, vel: 5.4,
    desc: 'The most distant planet — a deep-blue ice giant whose winds top 2,000 km/h, the fastest in the Solar System.',
    rows: [['DIAMETER', '49,244 KM'], ['FROM SUN', '30.1 AU'], ['ORBIT', '165 Y'], ['DAY', '16 H'], ['GRAVITY', '1.14 g'], ['MOONS', '16']]
  },
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

  let mat, mesh;
  if (p.key === 'earth') {
    mat = buildEarthMaterial();
    mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 96, 96), mat);
  } else if (p.key === 'mars') {
    mat = buildMarsMaterialReal();
    mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 96, 96), mat);
  } else {
    mat = makePlanetMaterial({ base: p.base, accent: p.accent, polar: p.polar, scale: p.scale, ridges: p.ridges, banded: p.banded });
    mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 64, 64), mat);
  }
  mesh.receiveShadow = true;
  tiltGroup.add(mesh);

  // Atmosphere for select planets — bright at silhouette, near-transparent at center.
  // Earth and Mars are left bare (no atmosphere halo, no clouds) — the user finds the
  // hazy shells distracting and wants the clean planet surface.
  if (p.key === 'venus') tiltGroup.add(makeAtmosphere(p.size * 1.16, 0xffd49a, 1.4));
  if (p.key === 'jupiter') tiltGroup.add(makeAtmosphere(p.size * 1.05, 0xffd0a0, 0.6));
  if (p.key === 'saturn') tiltGroup.add(makeAtmosphere(p.size * 1.04, 0xc8b48a, 0.35));
  if (p.key === 'uranus') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0xa0eef0, 0.9));
  if (p.key === 'neptune') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0x6090ff, 1.0));

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
// Orbital space data centers — LEO/MEO clusters of server-farm infrastructure,
// each with distinctive heat-radiator panels and solar arrays. Much smaller than
// the old satellites so they read as specks against Earth at true relative scale.
// Parented to Earth so they track Earth's position; animated in updateEarthSats.
// ------------------------------------------------------------
let earthSats = null;
function buildSpaceDataCenters() {
  const grp = new THREE.Group();
  grp.userData.sats = [];
  const R = planetMeshes.earth.config.size;

  // Shared materials
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc8cfd8, metalness: 0.75, roughness: 0.30, emissive: 0x1a2a3c, emissiveIntensity: 0.35 });
  // Heat radiators glow warm orange — the signature of active server cooling in orbit
  const radiatorMat = new THREE.MeshStandardMaterial({ color: 0xff5820, metalness: 0.2, roughness: 0.55, emissive: 0xff2a00, emissiveIntensity: 1.4, transparent: true, opacity: 0.92 });
  const solarMat = new THREE.MeshStandardMaterial({ color: 0x1b2c66, metalness: 0.5, roughness: 0.4, emissive: 0x0a1640, emissiveIntensity: 0.6 });

  // Geometry — everything much smaller so they're specks against a 1.7-unit Earth
  const bodyGeo = new THREE.BoxGeometry(0.014, 0.008, 0.020);
  const radiatorGeo = new THREE.BoxGeometry(0.018, 0.001, 0.012);   // flat radiator fins, perpendicular to body
  const solarGeo = new THREE.BoxGeometry(0.034, 0.0008, 0.010);     // long solar wings

  function planeBasis(inc, node) {
    const u = new THREE.Vector3(Math.cos(node), 0, Math.sin(node));
    const w0 = new THREE.Vector3(-Math.sin(node), 0, Math.cos(node));
    const v = w0.multiplyScalar(Math.cos(inc)).addScaledVector(new THREE.Vector3(0, 1, 0), -Math.sin(inc)).normalize();
    return { u, v };
  }

  function addDataCenter(r, u, v, theta, omega) {
    const dc = new THREE.Group();
    dc.add(new THREE.Mesh(bodyGeo, bodyMat));
    // Radiator fins above and below the main body
    const radA = new THREE.Mesh(radiatorGeo, radiatorMat); radA.position.y = 0.008; dc.add(radA);
    const radB = new THREE.Mesh(radiatorGeo, radiatorMat); radB.position.y = -0.008; dc.add(radB);
    // Solar arrays extending to the sides
    const solL = new THREE.Mesh(solarGeo, solarMat); solL.position.x = 0.024; dc.add(solL);
    const solR = new THREE.Mesh(solarGeo, solarMat); solR.position.x = -0.024; dc.add(solR);
    grp.add(dc);
    grp.userData.sats.push({ mesh: dc, r, u, v, theta, omega });
  }

  // LEO to low-MEO shells (R + 0.13 → R + 0.42 ≈ 490–1575 km altitude at Earth scale).
  // Proportional to real Starlink/OneWeb/GPS bands, just compressed to scene units.
  const shells = [
    { r: R + 0.13, inc: 0.90, count: 5 },   // ~490 km — dense LEO band
    { r: R + 0.18, inc: 1.55, count: 5 },   // ~675 km
    { r: R + 0.25, inc: 0.38, count: 4 },   // ~940 km
    { r: R + 0.32, inc: 2.10, count: 4 },   // ~1200 km
    { r: R + 0.42, inc: 1.12, count: 3 },   // ~1575 km
  ];
  shells.forEach((sh, si) => {
    const { u, v } = planeBasis(sh.inc, si * 1.21);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(sh.r, 0.0025, 6, 96),
      new THREE.MeshBasicMaterial({ color: 0x4ad4ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().crossVectors(u, v).normalize());
    grp.add(ring);
    const omega = 0.30 * Math.pow(R / sh.r, 1.5) + 0.10;
    for (let k = 0; k < sh.count; k++) {
      addDataCenter(sh.r, u, v, (k / sh.count) * TAU + Math.random() * 0.4, omega);
    }
  });
  // A handful of solo data centers on random inclined orbits
  for (let i = 0; i < 6; i++) {
    const r = R + 0.14 + Math.random() * 0.30;
    const { u, v } = planeBasis(Math.random() * Math.PI, Math.random() * TAU);
    addDataCenter(r, u, v, Math.random() * TAU, 0.30 * Math.pow(R / r, 1.5) + 0.10);
  }
  return grp;
}
earthSats = buildSpaceDataCenters();
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

// Crew shuttle (Ranger-style): a slim winged craft that rides up inside the rocket,
// docks to the Endurance for the cruise, then undocks and lands on Mars. Nose +Z.
function buildLiner() {
  const g = new THREE.Group();
  const hull = new THREE.MeshPhysicalMaterial({ color: 0xc8d2de, metalness: 0.8, roughness: 0.3, clearcoat: 1.0, clearcoatRoughness: 0.15, emissive: 0x22343f, emissiveIntensity: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2e3742, metalness: 0.8, roughness: 0.5 });
  const glowC = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });

  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 2.8, 18), hull);
  fus.rotation.x = Math.PI / 2; g.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.1, 18), hull);
  nose.rotation.x = Math.PI / 2; nose.position.z = 1.95; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8, 0, TAU, 0, Math.PI * 0.6), glowC);
  canopy.scale.set(1, 0.5, 1.7); canopy.rotation.x = -Math.PI / 2; canopy.position.set(0, 0.15, 0.85); g.add(canopy);
  // delta wings + tail fin
  for (const sgn of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 1.1), dark);
    wing.position.set(sgn * 0.5, -0.04, -0.55); wing.rotation.y = sgn * -0.34; g.add(wing);
  }
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.7), dark);
  fin.position.set(0, 0.3, -1.0); g.add(fin);
  const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.27, 0.5, 16), dark);
  eng.rotation.x = Math.PI / 2; eng.position.z = -1.6; g.add(eng);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 8, 18), glowC);
  collar.position.z = 1.5; g.add(collar);
  // Landing legs: splay out and aft (−Z) from the engine so they reach "down"
  // when the shuttle lands engine-first. Deployed for the gentle Mars touchdown.
  const legs = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI / 2;
    const dirL = new THREE.Vector3(Math.cos(a) * 0.6, Math.sin(a) * 0.6, -1).normalize();   // out + aft
    const base = new THREE.Vector3(Math.cos(a) * 0.18, Math.sin(a) * 0.18, -1.35);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6), dark);
    leg.position.copy(base).addScaledVector(dirL, 0.3);
    leg.quaternion.setFromUnitVectors(UP, dirL);
    legs.add(leg);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8), dark);
    pad.position.copy(base).addScaledVector(dirL, 0.6);
    legs.add(pad);
  }
  legs.visible = false; g.add(legs);

  // Engine plume (aft, −Z): bright core + translucent bell + glow, lit during burns.
  const plume = new THREE.Group();
  const pcore = new THREE.Mesh(new THREE.ConeGeometry(0.13, 1.3, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xe6f6ff, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false }));
  pcore.rotation.x = Math.PI; pcore.position.y = -0.65; plume.add(pcore);
  const pouter = new THREE.Mesh(new THREE.ConeGeometry(0.26, 2.4, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x6cc8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  pouter.rotation.x = Math.PI; pouter.position.y = -1.2; plume.add(pouter);
  const trail = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(['rgba(200,235,255,0.95)', 'rgba(80,180,255,0.4)', 'rgba(0,90,210,0)']),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  trail.scale.setScalar(2.6); trail.position.y = -0.5; plume.add(trail);
  plume.rotation.x = Math.PI / 2; plume.position.z = -1.7; plume.visible = false; g.add(plume);

  const fill = new THREE.PointLight(0xbfe6ff, 0.7, 24, 2); fill.position.set(0, 3, 1); g.add(fill);

  g.userData.trail = trail;
  g.userData.plume = plume;
  g.userData.legs = legs;
  g.scale.setScalar(0.26 * MS);
  return g;
}

// The Endurance — a large rotating ring of habitat modules around a central docking
// spine (artificial gravity for the long cruise). Spin axis = local +Z (travel axis).
function buildEndurance() {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 0.6, roughness: 0.38, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.5, 0.5), emissive: 0x222a33, emissiveIntensity: 0.12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a424e, metalness: 0.7, roughness: 0.5 });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });

  const ringR = 3.0;
  const ringGrp = new THREE.Group();
  // structural ring (torus in XY, normal +Z)
  ringGrp.add(new THREE.Mesh(new THREE.TorusGeometry(ringR, 0.09, 16, 160), dark));
  // 12 habitat modules around the ring, with glowing windows facing +Z
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const mod = new THREE.Group();
    mod.add(new THREE.Mesh(new RoundedBoxGeometry(1.15, 0.62, 0.6, 3, 0.07), i % 2 ? hull : dark));
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.32), winMat);
    win.position.z = 0.31; mod.add(win);
    mod.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, 0);
    mod.rotation.z = a + Math.PI / 2;   // long axis → tangent
    ringGrp.add(mod);
  }
  // 4 spokes from the hub out to the ring
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.14, ringR, 0.14), dark);
    spoke.position.set(Math.cos(a) * ringR / 2, Math.sin(a) * ringR / 2, 0);
    spoke.rotation.z = a - Math.PI / 2;   // long axis (Y) → radial
    ringGrp.add(spoke);
  }
  g.add(ringGrp);

  // Central spine / docking hub along Z (the travel axis).
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.8, 18), hull); core.rotation.x = Math.PI / 2; g.add(core);
  const ringHub = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 18), dark); ringHub.rotation.x = Math.PI / 2; g.add(ringHub);
  const dockNode = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 0.5, 14), dark); dockNode.rotation.x = Math.PI / 2; dockNode.position.z = 1.55; g.add(dockNode);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 14), hull); nose.rotation.x = Math.PI / 2; nose.position.z = 2.0; g.add(nose);
  const aft = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.5, 18), dark); aft.rotation.x = Math.PI / 2; aft.position.z = -1.6; g.add(aft);
  // a few hub running-lights
  for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU; const l = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), cyan); l.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.4); g.add(l); }

  const fill = new THREE.PointLight(0xbfe6ff, 0.6, 36, 2); fill.position.set(0, 5, 2); g.add(fill);

  g.userData.ring = ringGrp;
  g.scale.setScalar(0.5 * MS);
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
const AXIS_Z = new THREE.Vector3(0, 0, 1);                       // craft/station nose-or-hub axis (local +Z)

// ============================================================
// LAUNCH SITE — ground-perspective liftoff from Earth's day side
// ------------------------------------------------------------
// A real rocket is microscopic against the planet, so the iconic shot is from the
// GROUND (rocket large in frame), then we pull back to reveal Earth at true scale with
// the vehicle a small bright craft. The pad sits on a lit patch of Earth's surface; a
// blue sky dome fills the view at low altitude and fades to space as the rocket climbs.
const LAUNCH_N = new THREE.Vector3(-0.5, 0.55, 0.67).normalize();              // surface normal at the pad (sunlit)
const LAUNCH_T1 = new THREE.Vector3().crossVectors(LAUNCH_N, UP).normalize();  // downrange / gravity-turn axis
const LAUNCH_T2 = new THREE.Vector3().crossVectors(LAUNCH_T1, LAUNCH_N).normalize();
const PAD = E_POS.clone().addScaledVector(LAUNCH_N, E_R);                       // pad point on Earth's surface
// Launch-rig scale. The rocket, its whole trajectory, the chase cameras and the exhaust
// effects are all built at this fraction so the vehicle reads as a realistic speck against
// the fixed-size Earth (radius E_R = 1.7) rather than a planet-sized object. Earth never
// changes; only the launch rig shrinks. Drop LS to make the rocket smaller vs Earth.
const LS = 0.10;
// Rocket-model shrink, applied ON TOP of LS to the vehicle/pad/exhaust *sizes* only —
// NOT the trajectory, cameras or effect anchor points. So the rocket flies the same
// believable arc and the cameras stay put, but the vehicle reads ~10x smaller in frame
// (a tiny craft on a vast Earth) rather than filling it.
const RM = 0.1;
// Mothership/shuttle shrink: scales the Endurance + crew shuttle models, the cameras that
// frame them, their docking offsets and the shuttle's Mars-landing rest height together,
// so the whole deep-space rig reads ~10x smaller (to-scale vs the planets) without floating
// craft or mis-framed shots.
const MS = 0.1;
const LAUNCH_MAXALT = 3.5 * LS, LAUNCH_RANGE = 3.5 * LS, ROCKET_BASE = 0.5 * LS * RM;  // ascent shaping; rest height scales with the (RM-shrunk) rocket so it sits on the pad
// Shared launch + EDL event timelines (progress u in [0,1]) so motion, plume, camera
// and telemetry stay in sync.
const EV = { hold: 0.025, tower: 0.06, roll: 0.09, pitch: 0.15, maxQ: 0.25, meco: 0.46, sep: 0.49, ign2: 0.54, fairing: 0.63, tilt: 0.80, seco: 0.96 };
const EDL = { ENTRY: 0.16, AERO: 0.42, PITCH: 0.55, BURN: 0.62, TOUCH: 0.965 };
// The Endurance never lands: the transfer would carry it right down to Mars, so it
// brakes onto a high parking orbit this far from Mars's center and the shuttle flies
// the final drop alone (matches the ORBIT INSERTION callout + the EDL undock).
const PARK_D = 6.0;
// Colony model scale: drop this to make the settlement read smaller against the planet
// (the landing-pad offsets and surface cameras all derive from it).
const BASE_S = 0.24;
// EDL ground track: the station parks uprange of the colony so the whole descent moves
// monotonically downrange — undock, arc through entry, and settle on a pad just beside
// the base. Pad offsets (tang/cross from the colony center, derived from the pad's
// local position in buildMarsBase) sit on open ground clear of the solar farm and
// parked ships. The pad's own surface normal (dirPad in updateEDL) is the true descent
// axis so the shuttle settles ON the curved ground.
const EDL_LAT0 = -3.0, EDL_PAD_T = 0.2 * BASE_S, EDL_PAD_C = 1.1 * BASE_S;
const sstep = (x, a, b) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function earthGroundTexture(s = 1024) {
  // Barren high-desert floor — the dry tan/sand palette of the California Mojave around
  // Edwards/Mojave Air & Space Port: pale sand mottled with dust, scrub and dark gravel.
  const c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d');
  x.fillStyle = '#b49a6e'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 1700; i++) {
    const r = 8 + Math.random() * 74, t = Math.random();
    x.fillStyle = t < 0.42 ? `rgba(196,174,132,${0.06 + Math.random() * 0.13})`   // light sand patches
      : t < 0.78 ? `rgba(150,124,84,${0.05 + Math.random() * 0.12})`              // tan dust
        : `rgba(104,84,56,${0.06 + Math.random() * 0.14})`;                       // dark gravel / scrub
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, r, 0, TAU); x.fill();
  }
  // A scatter of small dark stones/brush so the ground isn't a flat wash up close.
  for (let i = 0; i < 700; i++) {
    x.fillStyle = `rgba(72,58,40,${0.18 + Math.random() * 0.28})`;
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 0, TAU); x.fill();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(5, 5);
  return tex;
}
function buildEarthGround() {
  const eR = planetMeshes.earth.config.size;
  const geo = new THREE.SphereGeometry(eR, 96, 64, 0, TAU, 0, Math.PI * 0.5);
  const mat = new THREE.MeshStandardMaterial({ map: earthGroundTexture(), color: 0x76844c, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.3 });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(E_POS);
  m.quaternion.setFromUnitVectors(UP, LAUNCH_N);   // cap apex → pad
  m.scale.setScalar(1.004);                         // lift just off the globe to kill z-fighting
  m.receiveShadow = true;
  return m;
}
// Wide flat terrain plane tangent at the pad. The globe is only 1.7 units across, so a
// real surface stance would show extreme curvature; this plane gives a believable flat
// horizon to "stand on" for the opening shot, then fades out as the camera cranes up —
// revealing the genuinely curved globe beneath, which is the curvature reveal itself.
function buildLaunchField() {
  const tex = earthGroundTexture(); tex.repeat.set(60, 60);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: 0xb09674, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.3,
    transparent: true, opacity: 1.0, side: THREE.DoubleSide, depthWrite: true,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(30, 72), mat);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), LAUNCH_N);   // disc normal -> surface up
  m.position.copy(PAD).addScaledVector(LAUNCH_N, 0.0008);                   // sit right at the pad surface
  m.receiveShadow = true;
  m.renderOrder = -0.4;
  return m;
}
function buildLaunchPad() {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.92, metalness: 0.05, envMapIntensity: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x5a6573, roughness: 0.5, metalness: 0.85, envMapIntensity: 0.4 });
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.3, 0.16, 32), concrete); pad.receiveShadow = true; g.add(pad);
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.22, 24), steel); mount.position.y = 0.18; mount.castShadow = mount.receiveShadow = true; g.add(mount);
  const tower = new THREE.Group(); tower.position.set(0.85, 0, 0);    // service gantry beside the rocket
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 3.4, 0.06), steel);
    leg.position.set(i < 2 ? 0.2 : -0.2, 1.7, i % 2 ? 0.2 : -0.2); leg.castShadow = true; tower.add(leg);
  }
  for (let j = 1; j < 8; j++) { const cr = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.46), steel); cr.position.y = j * 0.44; tower.add(cr); }
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.12), steel); arm.position.set(-0.45, 3.1, 0); tower.add(arm);
  g.add(tower);
  g.scale.setScalar(0.19 * LS * RM);
  return g;
}
// A lone access road crossing the desert to the pad: a graded dirt shoulder with a darker
// asphalt lane down the middle and a cleared apron at the pad end. Lies flat on the surface,
// running along LAUNCH_T1 (the horizon axis the opening looks down). Sized to the rocket scale.
function buildLaunchRoad() {
  const s = LS * RM;
  const g = new THREE.Group();
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x47443f, roughness: 0.97, metalness: 0.0, envMapIntensity: 0.2, transparent: true, depthWrite: false });
  const grade = new THREE.MeshStandardMaterial({ color: 0x927a54, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.2, transparent: true, depthWrite: false });
  const L = 200 * s;
  const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(1.1 * s, L), grade); shoulder.renderOrder = -0.37; g.add(shoulder);
  const apron = new THREE.Mesh(new THREE.CircleGeometry(2.2 * s, 28), grade); apron.position.z = 0.00012; apron.renderOrder = -0.36; g.add(apron);
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(0.5 * s, L), asphalt); lane.position.z = 0.00024; lane.renderOrder = -0.35; g.add(lane);
  // orient flat: local X -> T2 (width), Y -> T1 (length), Z -> N (up surface normal)
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(LAUNCH_T2, LAUNCH_T1, LAUNCH_N));
  g.position.copy(PAD).addScaledVector(LAUNCH_N, 0.0011);   // just above the desert field
  g.userData.mats = [asphalt, grade];
  return g;
}
function buildLaunchSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: {
      uUp: { value: LAUNCH_N.clone() }, uFade: { value: 1.0 },
      uHorizon: { value: new THREE.Color(0xaecdee) }, uZenith: { value: new THREE.Color(0x1f5aa8) },
    },
    vertexShader: `varying vec3 vL; void main(){ vL = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uUp,uHorizon,uZenith; uniform float uFade; varying vec3 vL;
      void main(){
        float a = dot(vL, normalize(uUp));
        vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.8, max(a, 0.0)));
        float alpha = uFade * smoothstep(-0.12, 0.02, a);   // opaque daytime sky (no stars), fading only at the horizon and with altitude
        gl_FragColor = vec4(c, clamp(alpha, 0.0, 1.0));
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(36, 32, 16), mat);
  m.position.copy(PAD);
  m.renderOrder = -0.5;
  return m;
}

// Ascent path: rise vertically off the pad, pitch over (gravity turn), level out.
const lp = (y, z) => E_POS.clone().add(new THREE.Vector3(0, E_R + y, z));
const launchCurve = new THREE.CatmullRomCurve3([
  lp(0.0, 0.0), lp(1.8, 0.0), lp(4.0, 0.3), lp(6.0, 1.8), lp(6.8, 4.6), lp(6.2, 8.4), lp(4.6, 12.6),
]);

// A detailed launch vehicle (nose +Y): separable first stage + upper stage +
// capsule, with a layered exhaust flame. Parts stored in userData.
function buildRocket() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xeef1f5, metalness: 0.42, roughness: 0.52, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.4, 0.4), emissive: 0x0e1420, emissiveIntensity: 0.10 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b323c, metalness: 0.82, roughness: 0.38 });
  const black = new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.5, roughness: 0.6 });
  const soot = new THREE.MeshStandardMaterial({ color: 0x4c483f, metalness: 0.55, roughness: 0.72 });   // scorched lower booster
  const cyan = new THREE.MeshBasicMaterial({ color: 0x9fe9ff });
  const R = 0.34;   // slimmer, modern proportions (was 0.42)

  // First stage (separable) — slender tank, scorched skirt, octaweb engines, folded grid fins + legs
  const stage1 = new THREE.Group();
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 3.0, 28), body); s1.position.y = -1.0; stage1.add(s1);
  const sootBand = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.006, R * 1.006, 0.95, 28), soot); sootBand.position.y = -2.05; stage1.add(sootBand);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.012, R * 1.012, 0.16, 28), black); stripe.position.y = 0.25; stage1.add(stripe);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.16, 0.42, 28), dark); skirt.position.y = -2.62; stage1.add(skirt);
  // octaweb: 8 ring engines + 1 centre
  for (let i = 0; i < 9; i++) {
    const center = i === 8, a = (i / 8) * TAU, r = center ? 0 : R * 0.58;
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.095, 0.34, 12), black);
    noz.position.set(Math.cos(a) * r, -2.98, Math.sin(a) * r); stage1.add(noz);
  }
  // folded grid fins near the top of the booster
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const gf = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.035), dark);
    gf.position.set(Math.cos(a) * (R + 0.02), 0.7, Math.sin(a) * (R + 0.02));
    gf.lookAt(gf.position.clone().setY(0.7).multiplyScalar(2)); stage1.add(gf);
  }
  // folded landing legs hugging the base
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.2, 0.10), dark);
    leg.position.set(Math.cos(a) * (R + 0.03), -2.0, Math.sin(a) * (R + 0.03));
    leg.rotation.y = -a; leg.rotation.x = 0.05; stage1.add(leg);
  }
  g.add(stage1);

  // Upper stage + payload (continues after staging) — interstage, vacuum bell, capsule windows
  const upper = new THREE.Group();
  const inter = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.96, R, 0.34, 28), black); inter.position.y = 0.7; upper.add(inter);
  const vac = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.20, 0.46, 16, 1, true), dark); vac.position.y = 0.5; upper.add(vac);   // vacuum engine bell
  const s2 = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.9, R * 0.96, 1.5, 28), body); s2.position.y = 1.65; upper.add(s2);
  const win = new THREE.Mesh(new THREE.TorusGeometry(R * 0.9, 0.035, 8, 28), cyan); win.position.y = 2.0; win.rotation.x = Math.PI / 2; upper.add(win);
  // Payload fairing on its own (cloned) material so it can be faded + jettisoned independently.
  // Ogive nose for a believable aerodynamic profile.
  const fairMat = body.clone();
  const fairing = new THREE.Group();
  const fairBase = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.66, R * 0.9, 0.85, 28), fairMat); fairBase.position.y = 2.95; fairing.add(fairBase);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(R * 0.66, 24, 16, 0, TAU, 0, Math.PI * 0.5), fairMat);
  tip.scale.y = 2.0; tip.position.y = 3.38; fairing.add(tip);
  upper.add(fairing);
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
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  glow.material.opacity = 0.5;
  glow.scale.setScalar(1.7); glow.position.y = -0.7; flameGrp.add(glow);
  g.add(flameGrp);

  // Warm engine fill. Short range + modest intensity so it doesn't blast the pad white
  // at the new tiny launch scale (the sun key light already carries the vehicle).
  // decay 0 = flat fill within a short range, so the light can't blast the pad into a
  // white hotspot via inverse-square at the tiny launch scale (it's only a warm fill;
  // the sun key light carries the vehicle).
  const light = new THREE.PointLight(0xffcaa0, 0.18, 0.6, 0); light.position.y = -2.2; g.add(light);

  g.userData = { stage1, upper, flameGrp, core, outer, glow, light, fairing };
  g.scale.setScalar(0.10 * LS * RM);
  return g;
}

// The jettisoned first stage (same body as the rocket's stage 1) — flown in world
// space as it tumbles back down toward Earth after staging. Scaled to match buildRocket.
function buildSpentStage() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xeef1f5, metalness: 0.42, roughness: 0.52, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.4, 0.4), emissive: 0x0e1420, emissiveIntensity: 0.10 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b323c, metalness: 0.82, roughness: 0.38 });
  const black = new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.5, roughness: 0.6 });
  const soot = new THREE.MeshStandardMaterial({ color: 0x4c483f, metalness: 0.55, roughness: 0.72 });
  const R = 0.34;
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 3.0, 28), body); s1.position.y = -1.0; g.add(s1);
  const sootBand = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.006, R * 1.006, 0.95, 28), soot); sootBand.position.y = -2.05; g.add(sootBand);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.012, R * 1.012, 0.16, 28), black); stripe.position.y = 0.25; g.add(stripe);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.16, 0.42, 28), dark); skirt.position.y = -2.62; g.add(skirt);
  for (let i = 0; i < 9; i++) {
    const center = i === 8, a = (i / 8) * TAU, r = center ? 0 : R * 0.58;
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.095, 0.34, 12), black);
    noz.position.set(Math.cos(a) * r, -2.98, Math.sin(a) * r); g.add(noz);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const gf = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.035), dark);
    gf.position.set(Math.cos(a) * (R + 0.02), 0.7, Math.sin(a) * (R + 0.02));
    gf.lookAt(gf.position.clone().setY(0.7).multiplyScalar(2)); g.add(gf);
  }
  g.scale.setScalar(0.10 * LS * RM);
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

// Soft, lumpy smoke puff — several overlapping radial blobs give a cloud-like
// alpha instead of a single clean disc, so the liftoff cloud reads as billowing.
function smokeTexture(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    const a = i * 2.39996;                                    // golden-angle scatter
    const off = size * 0.17 * ((i % 4) + 1) / 4;
    const cx = size / 2 + Math.cos(a) * off;
    const cy = size / 2 + Math.sin(a) * off;
    const r = size * (0.16 + 0.07 * (i % 3));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Liftoff ground cloud: soft smoke puffs that erupt at the pad on ignition and
// billow outward + upward, lingering as the rocket climbs away. Normal (non-additive)
// blending so it reads as dense opaque smoke, warm at the base, grey as it spreads.
function buildGroundSmoke(count = 44) {
  const grp = new THREE.Group();
  const tex = smokeTexture();
  grp.userData.puffs = [];
  for (let i = 0; i < count; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
    sp.userData = {
      ang: (i * 2.39996) % TAU,                  // direction it billows across the ground
      rad: 0.3 + ((i * 7) % 11) / 11,            // how far out it reaches (0.3..1.3)
      rise: ((i * 5) % 9) / 9,                    // how much it lifts as it ages
      size: 0.35 + ((i * 3) % 7) / 7 * 0.5,       // base sprite scale (small — grows with life)
      phase: ((i * 13) % 19) / 19,                // staggered emergence so it keeps boiling
    };
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
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
  }));
  bow.scale.setScalar(2.0); bow.position.y = -0.58; g.add(bow);

  // Plasma wake streaming behind the capsule (+Y, away from Mars).
  const wake = [];
  for (let i = 0; i < 12; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: PUFF_TEX, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
    }));
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
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  }));
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

// Dusty Mars sky dome for Surface Ops — butterscotch gradient that lightens to a hazy
// horizon, with a small pale sun disc + glow. Replaces the clear black space on the ground.
function buildMarsSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    // uFade lets EDL blend the dusty sky in with falling altitude (space → atmosphere),
    // the same trick the launch sky uses in reverse.
    uniforms: { uUp: { value: BASE_N.clone() }, uSun: { value: SUN_DIR.clone() }, uFade: { value: 1.0 }, uHorizon: { value: new THREE.Color(0xc99268) }, uZenith: { value: new THREE.Color(0x7c5240) } },
    vertexShader: `varying vec3 vL; void main(){ vL = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uUp,uSun,uHorizon,uZenith; uniform float uFade; varying vec3 vL;
      void main(){
        float a0 = dot(vL, normalize(uUp));
        float a = clamp(a0, 0.0, 1.0);
        vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.65, a));
        float d = max(dot(vL, normalize(uSun)), 0.0);
        c += vec3(1.0,0.96,0.86) * pow(d, 260.0) * 2.0          // small pale sun disc
           + uHorizon * pow(d, 8.0) * 0.45                       // forward-scatter glow
           + uHorizon * smoothstep(0.16, 0.0, a) * 0.4;          // hazy horizon band
        c *= mix(0.45, 1.0, smoothstep(-0.35, 0.0, a0));         // darken below the horizon so "down" reads
        gl_FragColor = vec4(c, uFade);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), mat);
  m.renderOrder = -1;
  return m;
}

// Mars surface colony (shown in Surface Operations): a landed Starship, pressurised
// glass domes + habitat modules, solar arrays, a comms dish and a rover — the
// SpaceX/NASA colony image. Built +Y up; placed + oriented on the surface in updateHelio.
function buildMarsBase() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xcfd4da, metalness: 0.85, roughness: 0.36, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.4, 0.4), emissive: 0x242a32, emissiveIntensity: 0.15 });
  const white = new THREE.MeshStandardMaterial({ color: 0xdee4ec, metalness: 0.3, roughness: 0.6, emissive: 0x222a33, emissiveIntensity: 0.22 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x39414e, metalness: 0.7, roughness: 0.5 });
  const strut = new THREE.MeshStandardMaterial({ color: 0xaab2bd, metalness: 0.85, roughness: 0.4 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x4a3020, metalness: 0.2, roughness: 0.98, emissive: 0x140a05, emissiveIntensity: 0.25 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xdff2ff, metalness: 0.0, roughness: 0.12, transmission: 0.9, ior: 1.25, thickness: 0.4, transparent: true, clearcoat: 1.0, clearcoatRoughness: 0.1, side: THREE.DoubleSide });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x1a2b6a, metalness: 0.6, roughness: 0.35, emissive: 0x0a1640, emissiveIntensity: 0.5 });
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 1.0, emissive: 0xffb066, emissiveIntensity: 1.3 });   // lit interior: dim body, bright emissive (blooms, doesn't clip white)
  const suitMat = new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 0.85, metalness: 0.05 });
  const visorMat = new THREE.MeshStandardMaterial({ color: 0x10141a, metalness: 0.5, roughness: 0.3, emissive: 0x5fd0ff, emissiveIntensity: 0.7 });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffcaa0 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });
  const glowMats = [interiorMat];

  // --- Geodesic pressurised dome: faceted glass + visible strut frame + lit interior glow ---
  function dome(x, z, r) {
    const d = new THREE.Group(); d.position.set(x, 0, z);
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const shell = new THREE.Mesh(geo, glass); shell.scale.y = 0.62; d.add(shell);
    const frame = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.4 }));
    frame.scale.y = 0.62; d.add(frame);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.94, r * 0.06, 8, 28), strut); ring.rotation.x = Math.PI / 2; ring.position.y = 0.005; d.add(ring);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 12, 8), interiorMat); glow.position.y = r * 0.16; glow.scale.y = 0.5; d.add(glow);
    g.add(d);
  }
  // Horizontal habitat module (capsule) with a lit window stripe.
  function hab(x, z, len, rot) {
    const h = new THREE.Group(); h.position.set(x, 0.09, z); h.rotation.y = rot;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, len, 6, 14), white); body.rotation.z = Math.PI / 2; h.add(body);
    const win = new THREE.Mesh(new THREE.BoxGeometry(len * 0.7, 0.03, 0.03), warm); win.position.set(0, 0.06, 0.075); h.add(win);
    g.add(h); return h;
  }
  // Upright landed Starship (ogive nose, flaps, window band, splayed legs) on a scorched pad.
  function ship(x, z, rot) {
    const s = new THREE.Group(); s.position.set(x, 0, z); s.rotation.y = rot || 0;
    const H = 0.86, R = 0.092;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(R * 3.4, R * 3.8, 0.02, 28), padMat); pad.receiveShadow = true; s.add(pad);
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 24), metal); hull.position.y = H / 2 + 0.05; hull.castShadow = true; s.add(hull);
    const npts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; npts.push(new THREE.Vector2(Math.cos(t * Math.PI * 0.5) * R, t * 0.34)); }
    const nose = new THREE.Mesh(new THREE.LatheGeometry(npts, 24), metal); nose.position.y = H + 0.05; nose.castShadow = true; s.add(nose);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 1.02, 0.07, 48, 1, true), winMat); band.position.y = H * 0.8; s.add(band);
    for (const [hy, fh] of [[0.78, 0.16], [0.16, 0.2]]) for (const sz of [1, -1]) {
      const fl = new THREE.Mesh(new THREE.BoxGeometry(0.02, fh, 0.12), dark); fl.position.set(0, H * hy, sz * R * 1.1); s.add(fl);
    }
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU; const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 5), dark);
      leg.position.set(Math.cos(a) * R * 1.1, 0.07, Math.sin(a) * R * 1.1);
      leg.quaternion.setFromUnitVectors(UP, new THREE.Vector3(Math.cos(a) * 0.55, -1, Math.sin(a) * 0.55).normalize()); s.add(leg);
    }
    g.add(s); return s;
  }
  // Small astronaut figure (built once, cloned) for scale + life.
  function makeAstronaut() {
    const a = new THREE.Group();
    a.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.03, 4, 10), suitMat));   // torso (origin ~0.04 up)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 10), suitMat); head.position.y = 0.06; a.add(head);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), visorMat); visor.position.set(0, 0.062, 0.012); a.add(visor);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.034, 0.016), dark); pack.position.set(0, 0.03, -0.022); a.add(pack);
    for (const sx of [1, -1]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.007, 0.05, 6), suitMat); leg.position.set(sx * 0.012, -0.02, 0); a.add(leg); }
    a.position.y = 0.05;
    return a;
  }

  // Glowing top-light for masts/towers; red blinkers stored for the live pulse.
  const blinkMat = new THREE.MeshBasicMaterial({ color: 0xff4a3a });
  const blinkMats = [blinkMat];
  function beacon(grp, x, y, z) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), blinkMat);
    b.position.set(x, y, z); grp.add(b);
  }
  // Ground-anchored light post (replaces the old floating dots).
  function lightPost(x, z, mat) {
    const p = new THREE.Group(); p.position.set(x, 0, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.07, 5), dark); pole.position.y = 0.035; p.add(pole);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), mat); lamp.position.y = 0.075; p.add(lamp);
    g.add(p); return p;
  }
  // Pressurised connecting tunnel between two ground points.
  function tunnel(x1, z1, x2, z2) {
    const a = new THREE.Vector3(x1, 0.045, z1), b = new THREE.Vector3(x2, 0.045, z2);
    const t = new THREE.Group(); t.position.copy(a).lerp(b, 0.5);
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 10), white);
    m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize()); t.add(m);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, len * 0.8), warm);
    win.quaternion.copy(m.quaternion); win.position.y = 0.028; t.add(win);
    g.add(t); return t;
  }

  // --- Layout ---------------------------------------------------------------
  // The crew landing pad — at the exact spot the EDL shuttle sets down
  // (local (-0.81, -0.77) maps to world tang 0.2*BASE_S / cross 1.1*BASE_S = EDL_PAD_T/C).
  const PAD_L = [-0.81, -0.77];
  {
    const p = new THREE.Group(); p.position.set(PAD_L[0], 0, PAD_L[1]);
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.33, 0.018, 28), padMat); slab.receiveShadow = true; p.add(slab);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.008, 6, 36), new THREE.MeshStandardMaterial({ color: 0xd8dee6, roughness: 0.7, emissive: 0xb8c4d0, emissiveIntensity: 0.35 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.012; p.add(ring);
    for (let i = 0; i < 8; i++) {                                  // edge lights guiding the shuttle in
      const a = (i / 8) * TAU;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.013, 6, 6), i % 2 ? cyan : warm);
      lamp.position.set(Math.cos(a) * 0.30, 0.022, Math.sin(a) * 0.30); p.add(lamp);
    }
    g.add(p);
  }
  // Welcoming party + cargo staged at the pad edge.
  const astro = makeAstronaut();
  [[-0.52, -0.62], [-0.47, -0.72]].forEach(([ax, az]) => { const a = astro.clone(); a.position.set(ax, 0.05, az); g.add(a); });
  [[-0.45, -0.5, 0.3], [-0.36, -0.55, -0.2], [-0.5, -0.4, 0.8]].forEach(([cx, cz, rot]) => {
    const c = new THREE.Group(); c.position.set(cx, 0.025, cz); c.rotation.y = rot;
    c.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.08), dark));
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.01, 0.082), strut); lid.position.y = 0.03; c.add(lid);
    g.add(c);
  });

  // The two ships: the colony's heavy-lift hero + the crew ship that came before.
  ship(0.7, -0.45, 0.4);
  ship(-0.55, 0.35, -0.7);

  // Dome cluster: one big habitat dome, two mid domes, and a green-glowing greenhouse.
  dome(-0.02, 0.12, 0.30); dome(0.30, 0.38, 0.17); dome(-0.42, -0.08, 0.16);
  {
    const gh = new THREE.Group(); gh.position.set(0.07, 0, 0.58);
    const geo = new THREE.IcosahedronGeometry(0.15, 1);
    const shell = new THREE.Mesh(geo, glass); shell.scale.y = 0.62; gh.add(shell);
    const frame = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.4 }));
    frame.scale.y = 0.62; gh.add(frame);
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x1d3a14, roughness: 1.0, emissive: 0x57e86b, emissiveIntensity: 1.0 });
    glowMats.push(greenMat);
    const green = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), greenMat); green.position.y = 0.025; green.scale.y = 0.5; gh.add(green);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.01, 8, 28), strut); ring.rotation.x = Math.PI / 2; ring.position.y = 0.005; gh.add(ring);
    g.add(gh);
  }

  // Habitat capsules linked by a tunnel network back to the domes.
  hab(0.02, -0.30, 0.34, 0.4); hab(0.36, -0.13, 0.28, 1.3); hab(-0.30, 0.30, 0.26, -0.5);
  tunnel(0.02, -0.30, -0.02, 0.12); tunnel(0.36, -0.13, 0.30, 0.38);
  tunnel(-0.30, 0.30, -0.02, 0.12); tunnel(-0.42, -0.08, 0.02, -0.30);
  tunnel(0.07, 0.58, -0.02, 0.12);

  // Control tower: the colony's lit nerve centre, red beacon on top.
  {
    const t = new THREE.Group(); t.position.set(0.38, 0, -0.36);
    const mastT = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.22, 8), strut); mastT.position.y = 0.11; t.add(mastT);
    const cab = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.06, 0.11, 2, 0.015), white); cab.position.y = 0.25; t.add(cab);
    const winBand = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.022, 12), warm); winBand.position.y = 0.255; t.add(winBand);
    beacon(t, 0, 0.30, 0);
    g.add(t);
  }

  // Solar farm — three rows of tilted panels feeding the base.
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
    const arr = new THREE.Group(); arr.position.set(-0.95 + c * 0.2, 0.08, 0.45 + r * 0.2);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 6), dark); post.position.y = -0.05; arr.add(post);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.006, 0.13), panelMat); panel.rotation.x = -0.5; arr.add(panel);
    g.add(arr);
  }

  // Comms array: main dish + a small one, red blinker on the mast.
  {
    const cm = new THREE.Group(); cm.position.set(0.62, 0, 0.5);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6), dark); mast.position.y = 0.17; cm.add(mast);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, 0, Math.PI * 0.42), white); dish.position.y = 0.34; dish.rotation.set(-0.8, 0, 0.3); cm.add(dish);
    const dish2 = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 6, 0, TAU, 0, Math.PI * 0.42), white); dish2.position.set(0.1, 0.16, 0.05); dish2.rotation.set(-1.1, 0.5, 0); cm.add(dish2);
    beacon(cm, 0, 0.36, 0);
    g.add(cm);
  }

  // Ice-mining rig: a derrick over the subsurface glacier, drill string down the middle.
  {
    const rig = new THREE.Group(); rig.position.set(-0.62, 0, 0.72);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 5), strut);
      leg.position.set(Math.cos(a) * 0.05, 0.14, Math.sin(a) * 0.05);
      leg.quaternion.setFromUnitVectors(UP, new THREE.Vector3(-Math.cos(a) * 0.3, 1, -Math.sin(a) * 0.3).normalize());
      rig.add(leg);
    }
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.025, 0.07), dark); crown.position.y = 0.29; rig.add(crown);
    const drill = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.28, 5), dark); drill.position.y = 0.14; rig.add(drill);
    const shed = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.05, 0.08, 2, 0.012), white); shed.position.set(0.09, 0.025, 0.02); rig.add(shed);
    beacon(rig, 0, 0.315, 0);
    g.add(rig);
  }

  // Fuel depot: tank cluster between the pad and the base, pipe run to the pad.
  for (let i = 0; i < 3; i++) {
    const tk = new THREE.Group(); tk.position.set(-0.84 + i * 0.14, 0, -0.34 - (i % 2) * 0.07);
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.11, 6, 14), white); tank.position.y = 0.1; tk.add(tank);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.03, 12), dark); skirt.position.y = 0.015; tk.add(skirt);
    g.add(tk);
  }
  {
    const pipe = new THREE.Group(); pipe.position.set(-0.78, 0, -0.55);
    const run = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6), strut);
    run.rotation.x = Math.PI / 2; run.position.y = 0.02; pipe.add(run);
    g.add(pipe);
  }

  // Rovers — one parked mid-base, one out by the pad with its dirt track.
  function roverAt(x, z, rot) {
    const rover = new THREE.Group(); rover.position.set(x, 0.04, z); rover.rotation.y = rot;
    rover.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.09), white));
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.08), winMat); cab.position.set(0.045, 0.04, 0); rover.add(cab);
    for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 10), dark); w.rotation.x = Math.PI / 2; w.position.set(i < 2 ? 0.06 : -0.06, -0.02, i % 2 ? 0.05 : -0.05); rover.add(w); }
    g.add(rover); return rover;
  }
  roverAt(-0.3, 0.5, 0.3); roverAt(-0.55, -0.6, -1.1);
  const track = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.4), new THREE.MeshStandardMaterial({ color: 0x3a2414, roughness: 1, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false }));
  track.rotation.x = -Math.PI / 2; track.position.set(-0.42, 0.012, 0.62); track.rotation.z = 0.5; g.add(track);

  // Astronauts about the base for life + scale.
  [[0.32, 0.05], [0.18, -0.12], [-0.12, 0.42], [0.5, 0.2]].forEach(([ax, az]) => { const a = astro.clone(); a.position.set(ax, 0.05, az); g.add(a); });

  // Flag by the big dome.
  {
    const fg = new THREE.Group(); fg.position.set(0.1, 0, 0.4);
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.26, 6), strut); flagPole.position.y = 0.13; fg.add(flagPole);
    var flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.075), new THREE.MeshStandardMaterial({ color: 0xc8443a, roughness: 0.9, side: THREE.DoubleSide, emissive: 0x3a0a08, emissiveIntensity: 0.3 }));
    flag.position.set(0.065, 0.22, 0); fg.add(flag);
    g.add(fg);
  }

  // Pathway lights: posts lining the route from the landing pad into the base,
  // plus a loose perimeter ring.
  [[-0.62, -0.6], [-0.44, -0.42], [-0.26, -0.3], [-0.1, -0.2]].forEach(([x, z], i) => lightPost(x, z, i % 2 ? warm : cyan));
  for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; lightPost(Math.cos(a) * (0.95 + (i % 3) * 0.1), Math.sin(a) * (0.95 + (i % 3) * 0.1), i % 2 ? warm : cyan); }

  // Warm "golden hour" fill so the base reads even on Mars's shadowed side.
  const fill = new THREE.PointLight(0xffce96, 2.2, 9, 2); fill.position.set(0.0, 1.4, 0.3); g.add(fill);

  // --- Conform to the curved surface ---------------------------------------
  // The colony spans ±1.1 local on a globe only 2.64 local-units in radius, so a flat
  // layout leaves the rim floating ~0.25 in the air. Drop every ground-anchored child
  // onto the sphere and tilt it to its own local normal.
  const Rloc = planetMeshes.mars.config.size / BASE_S;
  g.children.forEach(c => {
    if (c.isLight) return;
    const d2 = c.position.x * c.position.x + c.position.z * c.position.z;
    const ny = Math.sqrt(Math.max(0, Rloc * Rloc - d2));
    c.position.y += ny - Rloc;
    const n = new THREE.Vector3(c.position.x, ny, c.position.z).normalize();
    c.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(UP, n));
  });

  g.userData = { glowMats, flag, blinkMats };
  g.scale.setScalar(BASE_S);
  return g;
}

// Curved Mars ground patch for Surface Ops: a real slice of a Mars-radius sphere that
// shares the orbital Mars shader, so the colony sits ON terrain with a true horizon
// (planet curving away behind) instead of floating on the limb. Lifted a hair off the
// globe to avoid z-fighting.
function marsGroundTexture(s = 1024) {
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.fillStyle = '#a8542c'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 1500; i++) {                 // mottled dust/rock variation
    const r = 6 + Math.random() * 64, px = Math.random() * s, py = Math.random() * s, t = Math.random();
    x.fillStyle = t < 0.5 ? `rgba(120,55,28,${0.06 + Math.random() * 0.12})`
      : t < 0.85 ? `rgba(205,125,72,${0.05 + Math.random() * 0.10})`
        : `rgba(70,32,18,${0.06 + Math.random() * 0.12})`;
    x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
  }
  for (let i = 0; i < 500; i++) {                  // scattered dark rocks
    x.fillStyle = `rgba(38,18,10,${0.2 + Math.random() * 0.3})`;
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, 1 + Math.random() * 4, 0, TAU); x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(3, 3);
  return tex;
}
function buildMarsGround() {
  const mR = planetMeshes.mars.config.size;
  const geo = new THREE.SphereGeometry(mR, 96, 72, 0, TAU, 0, Math.PI * 0.6);   // cap around +Y, edge past the horizon in every shot
  // Dedicated Mars-dirt material (NOT the globe shader, whose pole-apex would read as ice);
  // MeshStandard so it catches the sun + IBL and RECEIVES the colony's contact shadow.
  const mat = new THREE.MeshStandardMaterial({ map: marsGroundTexture(), color: 0xc16a3c, roughness: 0.98, metalness: 0.0 });
  const m = new THREE.Mesh(geo, mat);
  m.scale.setScalar(1.002);
  m.receiveShadow = true;
  return m;
}

// Journey timeline: ordered stages, each with a real-time duration.
// Stages follow NASA's Mars mission timeline: Launch → Cruise → Approach →
// Entry, Descent & Landing → Surface Operations. Durations sum to 420s (7:00),
// sized so each stage's notes narrate comfortably (~70 words/min over them).
const PHASES = [
  {
    key: 'launch', label: '01 · LAUNCH', short: 'LAUNCH', dur: 75, mode: 'launch',
    tag: 'STAGE 01 · LAUNCH',
    // The traveller's log: all notes for the stage shown together, simple and fun —
    // meant to be narrated over live.
    facts: [
      'the weather looks a bit overcast but our take off should be pretty clean.',
      'its gonna be a modest 1-2 gforce of for about  20 minutes for us to reach escape velocity',
      'see the curvature of our beautiful blue marble once we leave stratosphere',
      'the sky goes from blue to dark purple to black in about a minute. you can watch the atmosphere end',
      'after that engines off for a few min until and weightlessness',
      'everyone hands are gonna rise, keep the space sickness bags held tight in your hands please'

    ]
  },
  {
    key: 'cruise', label: '02 · CRUISE', short: 'CRUISE', dur: 145, mode: 'helio', s0: 0.03, s1: 0.78, view: 'endurance',
    tag: 'STAGE 02 · CRUISE',
    facts: [
      'dock with the mothership. it has been waiting in orbit we put it in.',
      'all your devices will be fully functional once we finish docking.',
      'spins so the floor pushes up on your feet. fake gravity.',
      'were gonna be almost 2 inches taller in space as your spine relaxes.',
      'engines are on low for 6 months. the suns gravity is gonna do the work for us, we just coast.',
      'please dont forget to use the gym or play sports. atleast 1-2 hours a day or.. your bones get weak.',
      'all water on board is recycled. even piss. but it is clean what youd drink at home.',
      'all frozen and dried food.',
      'all the rooms are lighted up because we have a lot of space nomads onboard there. i still dont get how they make it work.',
      'Planets are going to much farther than it looks here but youre gonna see our blue dot. pretty common to get emotional ngl.',
      'we slow down the further we get from the sun. For the science students it is all uphill from here if you can remember the keplers laws.',
    ]
  },
  {
    key: 'approach', label: '03 · APPROACH', short: 'APPROACH', dur: 60, mode: 'helio', s0: 0.78, s1: 0.94, view: 'approach',
    tag: 'STAGE 03 · APPROACH',
    facts: [
      'within these 6 months, Mars grows from a dot, to a red coin, to a new planet.',
      'a call home now takes 15 minutes to arrive.',
      'Mars has two tiny potato-shaped moons. which idk why i cant see in the screen now. one is slowly falling and will become a ring someday.',
      'the mothership is gonna slow down a bit near mars. this is as close as it ever gets.',
      'youre gonna pack into the shuttle again, ready to descend.',
    ]
  },
  {
    key: 'edl', label: '04 · DESCENT & LANDING', short: 'DESCENT & LANDING', dur: 70, mode: 'edl', s0: 0.94, s1: 1.0,
    tag: 'STAGE 04 · DESCENT & LANDING',
    facts: [
      'the shuttle pops off the mothership and we just drop.',
      'mars air is super thin, but our speeds are gonna be high',
      'the air does most of the braking for free. the engines helps us slow down',
      'touchdown. dust everywhere. 150 million km from home. tisses are always gonna be in the seats for the teary eyed.',
      'the sky is gonna be red from mars surface. youll learn more soon.'

    ]
  },
  {
    key: 'surface', label: '05 · SURFACE OPERATIONS', short: 'SURFACE OPS', dur: 70, mode: 'helio', s0: 1.0, s1: 1.0, view: 'surface',
    tag: 'STAGE 05 · SURFACE OPERATIONS',
    facts: [
      'And youre on mars. you weigh a third of what you did at home. but after months floating, standing is hard. legs are gonna feel like jelly',
      'inside the colony it is a comfy 18°C. outside it is -60 and the air is unbreathable. stay inside.',
      'the greenhouse grows real salad. it is the most popular building — people miss green.',
      'water comes from ice mined underground, oxygen is made from the air. nothing is wasted.',
      'sunsets here are blue. not kidding. the dust flips the colors around.',
      'the return window opens in 15 months. the planets set the schedule, not us.',
      'please purchase the tickets from spacexyz.com',
    ]
  },
];
let _acc = 0;
PHASES.forEach(p => { p.t0 = _acc; _acc += p.dur; p.t1 = _acc; });
const TOTAL_DUR = _acc;

const ZERO_V = new THREE.Vector3();
const voyage = {
  active: false, playing: false, t: 0, total: TOTAL_DUR, stage: 0, lastStage: -1,
  manualView: null, ship: null, rocket: null, ellipseFull: null, ellipseTrail: null,
  // camPos/camLook are smoothed OFFSETS from camAnchor (the tracked subject), not world points.
  camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), camUp: new THREE.Vector3(0, 1, 0), camInit: false,
  camAnchor: new THREE.Vector3(), camAnchorKey: 'world',
  lastHighlight: null,
};

const vEls = {};
['v-phase', 'v-elapsed', 'v-vel', 'v-dist', 'v-engine', 'v-notes', 'vc-tag', 'v-playpause', 'v-progress']
  .forEach(id => { vEls[id] = document.getElementById(id); });

function stageIndexForT(t) {
  for (let i = 0; i < PHASES.length; i++) if (t < PHASES[i].t1) return i;
  return PHASES.length - 1;
}

function viewTarget(view, st, s, u = 0) {
  const ship = st.pos;
  const vel = transferState(Math.min(1, s + 0.02)).pos.clone().sub(ship);
  if (vel.lengthSq() < 1e-6) vel.set(0, 0, 1);
  vel.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(vel, up).normalize();
  if (view === 'map') { const c = new THREE.Vector3(-12, 0, 0); return { pos: c.clone().add(new THREE.Vector3(20, 182, 92)), look: c }; }
  if (view === 'approach') {
    // Cinematic zoom: start far back so Mars is a distant rust-red disc with the station
    // small in the foreground, then close in over the stage until the planet fills the frame.
    const mars = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(mars);
    const toMars = mars.clone().sub(ship); const dist = Math.max(0.001, toMars.length());
    toMars.normalize();
    const sideM = new THREE.Vector3().crossVectors(toMars, up).normalize();
    if (sideM.lengthSq() < 1e-4) sideM.set(1, 0, 0);
    const ez = u * u * (3 - 2 * u);                                  // smoothstep the closing
    const D = THREE.MathUtils.lerp(dist + 22, 5.0, ez);             // camera distance from Mars, shrinking
    const pos = mars.clone().addScaledVector(toMars, -D)
      .addScaledVector(up, 1.4 + (1 - ez) * 2.0).addScaledVector(sideM, 1.8 + (1 - ez) * 3.0);
    return { pos, look: mars, fov: 40 };
  }
  if (view === 'arrival') {
    // Close on the Endurance + docked shuttle in Mars orbit, the red world filling the
    // background, just before the shuttle undocks for descent.
    const mars = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(mars);
    const toMars = mars.clone().sub(ship).normalize();
    const sideM = new THREE.Vector3().crossVectors(toMars, up).normalize();
    if (sideM.lengthSq() < 1e-4) sideM.set(1, 0, 0);
    const pos = ship.clone().addScaledVector(toMars, -6.0 * MS).addScaledVector(up, 1.6 * MS).addScaledVector(sideM, 2.2 * MS);
    return { pos, look: ship.clone().addScaledVector(toMars, 0.8 * MS), fov: 46 };
  }
  if (view === 'ring') { return { pos: ship.clone().addScaledVector(side, 2.3).addScaledVector(up, 0.85).addScaledVector(vel, 0.7), look: ship.clone() }; }
  if (view === 'endurance') {
    // Look mostly down the travel axis from ahead-and-above so the spinning ring
    // reads face-on, with the docked shuttle in the foreground and deep space behind.
    // Offsets ride the MS model scale so the (10x-shrunk) station fills the frame.
    return { pos: ship.clone().addScaledVector(vel, 5.5 * MS).addScaledVector(up, 2.2 * MS).addScaledVector(side, 1.8 * MS), look: ship.clone().addScaledVector(vel, 0.5 * MS), fov: 46 };
  }
  if (view === 'dock') {
    // Close on the docking interface as the shuttle closes in on the Endurance's nose,
    // with a slow orbital drift so the shot breathes.
    const d = ship.clone().addScaledVector(vel, 1.5 * MS);
    const off = side.clone().multiplyScalar(7.0 * MS).applyAxisAngle(up, elapsed * 0.06);
    return { pos: d.clone().add(off).addScaledVector(up, 2.6 * MS).addScaledVector(vel, -3.0 * MS), look: d, fov: 42 };
  }
  if (view === 'coast') {
    // Look back down the track toward the Sun and the shrinking inner system — Earth a
    // blue point near the glare — with the Endurance silhouetted in the foreground.
    const out = ship.clone().normalize();                                  // Sun -> ship, pointing outward
    const off = side.clone().multiplyScalar(2.4 * MS).applyAxisAngle(up, elapsed * 0.04);
    return { pos: ship.clone().addScaledVector(out, 6.0 * MS).addScaledVector(up, 2.0 * MS).add(off), look: ship.clone(), fov: 42 };
  }
  if (view === 'chase') { return { pos: ship.clone().addScaledVector(vel, -7 * MS).addScaledVector(side, 2.5 * MS).addScaledVector(up, 3 * MS), look: ship.clone().addScaledVector(vel, 2 * MS), fov: 48 }; }
  if (view === 'depart') {
    // Side-on staging shot: the separation axis runs across the frame — liner on
    // one side, the spent stage tumbling away on the other, frost shower between.
    const look = ship.clone().addScaledVector(vel, -2.0);
    const pos = look.clone().addScaledVector(side, 4.8).addScaledVector(up, 1.6).addScaledVector(vel, 0.5);
    return { pos, look };
  }
  if (view === 'surface') {
    // Cinematic colony tour: a low "boots on the ground" hero shot that orbits a quarter-turn
    // while craning up to a high survey of the base mid-stage, then settling back low — the
    // planet curving to a real horizon, the domes looming. up = surface normal so it reads level.
    const m = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(m);
    const mR = planetMeshes.mars.config.size;
    const B = m.clone().addScaledVector(BASE_N, mR * 1.002);          // the colony's ground point
    const t1 = new THREE.Vector3().crossVectors(BASE_N, UP).normalize();
    const t2 = new THREE.Vector3().crossVectors(t1, BASE_N).normalize();
    const arc = Math.sin(u * Math.PI);                               // 0 at the ends, 1 mid-stage
    const ang = (u - 0.5) * 1.4 + Math.sin(elapsed * 0.1) * 0.06;    // quarter-turn orbit + live drift
    const sF = BASE_S * 2;                                           // camera rig rides the colony scale
    const height = (0.8 + arc * 2.6) * sF;                           // low → high survey → low
    const dist = (1.7 + (1 - arc) * 0.6) * sF;
    const radial = t1.clone().multiplyScalar(-dist).applyAxisAngle(BASE_N, ang);
    const pos = B.clone().addScaledVector(BASE_N, height).add(radial).addScaledVector(t2, (1.0 - arc * 0.5) * sF);
    const look = B.clone().addScaledVector(BASE_N, (0.16 + arc * 0.5) * sF).addScaledVector(t1, 0.15 * sF);
    return { pos, look, fov: 44, up: BASE_N };
  }
  const mars = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(mars);
  return { pos: ship.clone().addScaledVector(vel, -10).addScaledVector(up, 5).addScaledVector(side, 6), look: mars };
}

function updateLaunch(u) {
  voyage.ship.visible = voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  voyage.lander.visible = false;
  if (voyage.ground) voyage.ground.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.dust) voyage.dust.visible = false;
  if (voyage.base) voyage.base.visible = false;
  if (voyage.station) voyage.station.visible = false;
  if (voyage.edlLight) voyage.edlLight.visible = false;
  voyage.rocket.visible = voyage.launchTrail.visible = true;
  if (voyage.groundSmoke) voyage.groundSmoke.visible = true;
  // Barren California high-desert floor for the ground shot — a flat tan plain reaching a
  // real horizon. It stays solid through the low climb, then recedes (fades) as the rocket
  // ascends and the curved Earth comes up beneath, so it's the ground falling away, not a
  // trick transition.
  if (voyage.earthGround) voyage.earthGround.visible = false;
  if (voyage.launchField) {
    const fieldFade = clamp01(1 - (u - 0.15) / 0.06);    // solid through the held ground shot, gone as we lift
    voyage.launchField.visible = fieldFade > 0.01;
    voyage.launchField.material.opacity = fieldFade;
    if (voyage.launchRoad) {                              // the access road fades out with the ground
      voyage.launchRoad.visible = fieldFade > 0.01;
      voyage.launchRoad.userData.mats.forEach(m => { m.opacity = fieldFade; });
    }
  }
  if (voyage.marsSky) voyage.marsSky.visible = false;
  if (voyage.launchPad) voyage.launchPad.visible = true;
  if (voyage.launchSky) voyage.launchSky.visible = true;
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'earth');
  planetMeshes.earth.mesh.rotation.y = 0.35;          // freeze Earth's spin so the pad/ground hold still
  if (earthSats) earthSats.visible = false;           // no orbital satellites in the daytime sky
  orbitPaths.forEach(o => { o.visible = false; });    // no orbit rings during the ground launch

  const rd = voyage.rocket.userData;
  const staged = u >= EV.sep;
  rd.upper.visible = true;
  rd.stage1.visible = !staged;
  if (!staged) { rd.stage1.position.set(0, 0, 0); rd.stage1.rotation.set(0, 0, 0); }

  // Physics-shaped ascent: a brief hold, dead-vertical climb, then a gravity turn downrange.
  const altOf = (t) => {
    if (t < EV.hold) return 0.0;
    const climb = THREE.MathUtils.smoothstep(t, EV.hold, EV.meco);
    const coast = THREE.MathUtils.smoothstep(t, EV.meco, 1.0);
    return LAUNCH_MAXALT * (0.8 * Math.pow(climb, 1.3) + 0.2 * coast);
  };
  const rngOf = (t) => LAUNCH_RANGE * Math.pow(clamp01((t - EV.pitch) / (1 - EV.pitch)), 1.7);
  const sitePos = (t) => PAD.clone().addScaledVector(LAUNCH_N, altOf(t) + ROCKET_BASE).addScaledVector(LAUNCH_T1, rngOf(t));
  const pos = sitePos(u);
  const vel = sitePos(Math.min(1, u + 0.01)).sub(pos);
  if (vel.lengthSq() < 1e-8) vel.copy(LAUNCH_N);
  vel.normalize();
  voyage.rocket.position.copy(pos);
  // Attitude: locked vertical off the pad, then slerp to the flight-path tangent; a small
  // roll program just after tower-clear that fades out.
  const qVert = new THREE.Quaternion().setFromUnitVectors(UP, LAUNCH_N);
  const qPath = new THREE.Quaternion().setFromUnitVectors(UP, vel);
  voyage.rocket.quaternion.copy(qVert).slerp(qPath, THREE.MathUtils.smoothstep(u, EV.tower, EV.tilt));
  voyage.rocket.rotateY((1 - clamp01((u - EV.tower) / 0.22)) * 0.5 * Math.sin(elapsed * 1.1));

  // Air-pressure proxy (drops with altitude) drives plume shape + sky fade.
  const alt = altOf(u);
  const altFrac = alt / LAUNCH_MAXALT;   // 0..~0.85 — scale-independent altitude for the smoke/trail fades
  const H = LAUNCH_MAXALT * 0.42, atmP = Math.exp(-alt / H);
  const throttle = 1 - 0.34 * Math.exp(-Math.pow((u - EV.maxQ) / 0.06, 2));   // max-Q throttle-down
  const flick = 0.85 + Math.sin(elapsed * 42) * 0.15;
  // Engine on only while actually burning: first stage to MECO, then upper stage from
  // SES-1 to a quick cutoff at SECO (orbit). Dark coast at MECO and after orbit insertion.
  const secoFade = 1 - clamp01((u - EV.seco) / 0.015);
  const flameOn = (!staged && u < EV.meco) ? 1 : (staged && u >= EV.ign2 ? secoFade : 0);
  rd.flameGrp.visible = flameOn > 0.001;
  if (!staged) {
    rd.flameGrp.position.y = -3.0;
    const bloom = 1 + (1 - atmP) * 1.8;              // plume balloons wide in near-vacuum
    rd.core.scale.set(flick * (0.9 + 0.1 * atmP), throttle * (1.4 + u * 0.7) * flick, flick * (0.9 + 0.1 * atmP));
    rd.outer.scale.set(flick * bloom, throttle * (1.0 + (1 - atmP) * 0.9) * flick, flick * bloom);
    rd.outer.material.opacity = 0.16 * (0.3 + 0.7 * atmP);
    rd.core.material.opacity = 0.3;
  } else {
    rd.flameGrp.position.y = 0.45;
    const s2 = clamp01((u - EV.ign2) / 0.1) * secoFade;   // second-stage spin-up, cut off at SECO
    rd.core.scale.set(flick * 0.5 * s2, (0.7 + (u - EV.ign2)) * flick * s2, flick * 0.5 * s2);
    rd.outer.scale.set(flick * 2.4 * s2, 0.9 * flick * s2, flick * 2.4 * s2);   // vacuum bell bloom
    rd.outer.material.opacity = 0.28 * s2;
    rd.core.material.opacity = 0.85 * s2;
  }
  rd.glow.visible = flameOn > 0.001;
  rd.glow.scale.setScalar((staged ? 0.32 : 0.62 * (0.6 + 0.4 * atmP)) + Math.sin(elapsed * 26) * 0.12);
  rd.light.intensity = flameOn * ((staged ? 0.08 : 0.1 * throttle) + Math.sin(elapsed * 40) * 0.03);

  // Max-Q condensation cone.
  if (voyage.vaporCone) {
    const q = Math.exp(-Math.pow((u - EV.maxQ) / 0.05, 2));
    voyage.vaporCone.visible = q > 0.02 && !staged;
    voyage.vaporCone.material.opacity = 0.8 * q;
    voyage.vaporCone.scale.setScalar((0.6 + 0.7 * q) * LS * RM);
    voyage.vaporCone.position.copy(pos).addScaledVector(vel, 0.1 * LS);
  }

  // Fairing jettison after second-stage ignition.
  if (rd.fairing) {
    const fj = clamp01((u - EV.fairing) / 0.09);
    rd.fairing.position.x = fj * 0.6;
    rd.fairing.rotation.z = -fj * 1.4;
    rd.fairing.visible = fj < 0.999;
    rd.fairing.traverse(o => { if (o.material && 'opacity' in o.material) { o.material.transparent = true; o.material.opacity = 1 - fj; } });
  }

  // Spent first stage tumbles back toward Earth + an entry/retro glow; ullage frost burst.
  if (voyage.spentStage) {
    const fall = (u - EV.sep) / (1 - EV.sep);
    voyage.spentStage.visible = staged && fall < 0.9;       // gone home before the orbit beauty shots
    if (staged) {
      const sepPos = sitePos(EV.sep);
      voyage.spentStage.position.copy(sepPos)
        .addScaledVector(vel, fall * 0.8 * LS)
        .addScaledVector(LAUNCH_N, -(fall * fall) * 6.0 * LS)
        .addScaledVector(LAUNCH_T1, fall * 0.5 * LS);
      voyage.spentStage.quaternion.setFromUnitVectors(UP, LAUNCH_N);
      voyage.spentStage.rotateX(fall * 4.0); voyage.spentStage.rotateZ(fall * 2.2);
      if (voyage.boosterGlow) {
        // Entry-heating glow: flares as it bites into the air, then fades as it descends home.
        const heat = clamp01((fall - 0.18) / 0.16) * clamp01((0.82 - fall) / 0.25);
        voyage.boosterGlow.visible = heat > 0.02;
        voyage.boosterGlow.position.copy(voyage.spentStage.position).addScaledVector(LAUNCH_N, -0.08 * LS);
        voyage.boosterGlow.material.opacity = heat * 0.85;
        voyage.boosterGlow.scale.setScalar((0.4 + fall * 0.7) * LS * RM);
      }
      if (voyage.frost) {
        const burst = clamp01((u - EV.sep) / 0.06);
        voyage.frost.visible = burst > 0 && burst < 1;
        voyage.frost.userData.parts.forEach(p => {
          p.position.copy(sepPos).addScaledVector(p.userData.dir, burst * p.userData.speed * 0.5 * LS * RM);
          p.material.opacity = (1 - burst) * 0.45; p.scale.setScalar(p.userData.size * (1 + burst) * LS * RM);
        });
      }
    } else {
      if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
      if (voyage.frost) voyage.frost.visible = false;
    }
  }

  // Exhaust/smoke: a dense column near the pad that lingers as the rocket climbs away.
  const rng = rngOf(u);
  const colTop = Math.min(alt + ROCKET_BASE, 3.2 * LS);
  const colFrac = colTop / Math.max(0.001, alt + ROCKET_BASE);
  const puffs = voyage.launchTrail.userData.puffs;
  puffs.forEach((sp, i) => {
    const f = i / (puffs.length - 1);
    sp.position.copy(PAD).addScaledVector(LAUNCH_N, colTop * f).addScaledVector(LAUNCH_T1, rng * colFrac * f);
    const heat = f * f;
    sp.material.color.setRGB(1, 0.55 + heat * 0.4, 0.42 + heat * 0.35);
    sp.material.opacity = (0.08 + (1 - f) * 0.2) * (0.5 + u * 0.5) * (staged ? 0.3 : 1) * clamp01(1.15 - altFrac * 2.6);
    sp.scale.setScalar((0.3 + (1 - f) * 0.8) * LS * RM);   // smaller puffs so the contrail doesn't read as bubbles
  });

  // Liftoff ground cloud: each puff erupts (staggered), then billows out + up and
  // thins, lit warm at the base by the engines and greying as it spreads — the big
  // mushrooming smoke wall that sells a real launch.
  const smoke = voyage.groundSmoke.userData.puffs;
  const erupt = clamp01(u / 0.05);                          // the cloud front billows up fast in the first seconds
  smoke.forEach((sp) => {
    const d = sp.userData;
    const life = clamp01((erupt - d.phase * 0.5) / 0.5);    // staggered 0..1 emergence
    if (life <= 0.001) { sp.material.opacity = 0; return; }
    const spread = (0.25 + life * 0.9) * (0.5 + d.rad * 0.5);  // clusters at the pad, billows out modestly
    const lift = 0.12 + life * (0.45 + d.rise * 1.15);         // piles up into a billowing mound at the base
    sp.position.copy(PAD)
      .addScaledVector(LAUNCH_T1, Math.cos(d.ang) * spread * LS * RM)
      .addScaledVector(LAUNCH_T2, Math.sin(d.ang) * spread * LS * RM)
      .addScaledVector(LAUNCH_N, lift * LS * RM);
    const warm = clamp01(1 - life * 1.8) * clamp01(1 - lift * 0.7);  // engine glow only at the base, early
    sp.material.color.setRGB(0.62 + warm * 0.36, 0.6 + warm * 0.16, 0.58);  // smoke grey, warming to tan at the root
    sp.material.opacity = (0.32 - life * 0.22) * clamp01(1.2 - altFrac * 1.6);
    sp.scale.setScalar(d.size * (0.55 + life * 1.4) * LS * RM);  // expands modestly as it ages
  });

  // Sky fades to space with the thinning atmosphere.
  if (voyage.launchSky) {
    voyage.launchSky.material.uniforms.uFade.value = clamp01(Math.pow(atmP, 0.6));
    voyage.launchSky.visible = atmP > 0.02;
  }

  // Camera: a broadcast-style sequence of beats, each timed to a flight event. All offsets
  // ride the rocket's own scale (rf = LS·RM) so the chase stays CLOSE on the small vehicle
  // through the whole ascent — Earth fills the background at its true size, the rocket isn't
  // a far-off speck.
  const up = LAUNCH_N, side = LAUNCH_T2, fwd = LAUNCH_T1;
  const rf = LS * RM;
  const CRANE = 0.28;
  let camP, lookP, fov = 50;
  if (u < CRANE) {                             // open low on the barren plain looking toward the horizon,
    const r = clamp01(u / CRANE);              // the rocket on the pad. LINGER close for the first half,
    const hold = 0.5;                          // then ease up and slightly back as it lifts — staying close.
    const e = clamp01((r - hold) / (1 - hold));
    const ease = e * e * (3 - 2 * e);
    const drift = r * 1.0;                     // a slow dolly so the held hero shot still breathes
    const near = pos.clone()
      .addScaledVector(fwd, (-2.7 - drift) * rf).addScaledVector(side, -1.4 * rf).addScaledVector(up, (0.15 + drift * 0.5) * rf);
    const nearLook = pos.clone().addScaledVector(fwd, 7.0 * rf).addScaledVector(up, 0.05 * rf);   // toward the horizon
    // End on a close tracking pedestal (still on the vehicle) rather than a far wide shot.
    const far = pos.clone().addScaledVector(side, 3.4 * rf).addScaledVector(up, 0.8 * rf).addScaledVector(fwd, -1.8 * rf);
    camP = near.lerp(far, ease);
    lookP = nearLook.lerp(pos.clone(), ease);
    fov = 44 - ease * 4;
  } else if (u < EV.maxQ) {                    // downrange tracking pedestal — rocket climbing against curved Earth
    camP = pos.clone().addScaledVector(side, 3.4 * rf).addScaledVector(up, 0.4 * rf).addScaledVector(fwd, -1.8 * rf);
    lookP = pos.clone().addScaledVector(vel, 1.0 * rf); fov = 40;
  } else if (u < EV.meco) {                    // long-lens chase through max-Q and the high climb
    camP = pos.clone().addScaledVector(side, 2.6 * rf).addScaledVector(up, 0.2 * rf).addScaledVector(fwd, -0.7 * rf);
    lookP = pos.clone().addScaledVector(up, 0.5 * rf); fov = 34;
  } else if (u < EV.ign2) {                    // MECO + staging: pull back so the booster is seen falling away
    camP = pos.clone().addScaledVector(side, 3.0 * rf).addScaledVector(up, 0.7 * rf).addScaledVector(fwd, -2.2 * rf);
    lookP = pos.clone().addScaledVector(up, -0.7 * rf); fov = 38;   // frame the gap between the stages
  } else if (u < EV.fairing) {                 // second-stage ignition: tight on the upper stage lighting
    camP = pos.clone().addScaledVector(side, 2.0 * rf).addScaledVector(up, 0.5 * rf).addScaledVector(fwd, -1.1 * rf);
    lookP = pos.clone().addScaledVector(up, -0.2 * rf); fov = 40;
  } else if (u < 0.72) {                       // fairing jettison: side-quarter angle to catch the halves splitting
    camP = pos.clone().addScaledVector(side, 1.8 * rf).addScaledVector(up, 0.7 * rf).addScaledVector(fwd, 0.7 * rf);
    lookP = pos.clone().addScaledVector(up, 0.1 * rf); fov = 44;
  } else if (u < EV.seco) {                    // ascent to orbit: the climbing stage high over Earth's curving limb
    camP = pos.clone().addScaledVector(side, 4.4 * rf).addScaledVector(up, 1.4 * rf).addScaledVector(fwd, -2.0 * rf);
    lookP = pos.clone().addScaledVector(up, -2.5 * rf).addScaledVector(fwd, -2.0 * rf); fov = 54;   // tilt down to Earth below
  } else {                                     // SECO / orbit: close on the now-coasting stage, sunlit, Earth behind
    camP = pos.clone().addScaledVector(side, 2.2 * rf).addScaledVector(up, 0.5 * rf).addScaledVector(fwd, -1.2 * rf);
    lookP = pos.clone().addScaledVector(up, -0.6 * rf).addScaledVector(fwd, -0.2 * rf); fov = 46;
  }
  return { pos: camP, look: lookP, fov, up: LAUNCH_N };
}

// Descent & Landing — futuristic + easy: the shuttle undocks from the Endurance
// (parked in Mars orbit) and flies a smooth, controlled powered descent to a soft
// touchdown — no parachutes, no fiery "7 minutes of terror".
function updateEDL(u) {
  voyage.rocket.visible = voyage.launchTrail.visible = false;
  if (voyage.groundSmoke) voyage.groundSmoke.visible = false;
  voyage.lander.visible = false;
  if (voyage.earthGround) voyage.earthGround.visible = false;
  if (voyage.launchField) voyage.launchField.visible = false;
  if (voyage.launchRoad) voyage.launchRoad.visible = false;
  if (voyage.launchPad) voyage.launchPad.visible = false;
  if (voyage.launchSky) voyage.launchSky.visible = false;
  if (voyage.vaporCone) voyage.vaporCone.visible = false;
  if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  if (earthSats) earthSats.visible = true;
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  voyage.ship.visible = true;
  voyage.station.visible = u < 0.55;          // the parked Endurance shrinks to nothing once we're deep in the air
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'mars');
  orbitPaths.forEach(o => { o.visible = false; });

  const s = 0.94 + u * 0.06;
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  planetMeshes.mars.mesh.rotation.y = 0.6;     // freeze the spin so the colony site holds still (matches Surface Ops)
  const M = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(M);
  const mR = planetMeshes.mars.config.size;
  // Land beside the colony (BASE_N site) so Surface Ops opens on the just-landed shuttle.
  const dir = BASE_N;                                                   // local up at the landing site
  const tang = new THREE.Vector3().crossVectors(dir, UP).normalize();   // matches viewTarget('surface') t1
  const cross = new THREE.Vector3().crossVectors(tang, dir).normalize();// matches viewTarget('surface') t2

  // The Mars ground patch the shuttle descends onto (the same cap Surface Ops uses).
  if (voyage.ground) {
    voyage.ground.position.copy(M);
    voyage.ground.quaternion.setFromUnitVectors(UP, dir);
    voyage.ground.material.transparent = false; voyage.ground.material.opacity = 1;
    voyage.ground.visible = true;
  }
  // The colony is the destination for the low beats — but at this stylized scale it would
  // read continent-sized from orbit, so it only appears behind the mid-stage camera cut.
  if (voyage.base) {
    voyage.base.position.copy(M).addScaledVector(dir, mR * 1.002);
    voyage.base.quaternion.setFromUnitVectors(UP, dir);
    voyage.base.visible = u > 0.46;
    const b = voyage.base.userData, pulse = 1.15 + Math.sin(elapsed * 1.6) * 0.2;
    if (b.glowMats) b.glowMats.forEach(m => { m.emissiveIntensity = pulse; });
    if (b.flag) b.flag.rotation.z = Math.sin(elapsed * 2.0) * 0.16;
    if (b.blinkMats) { const on = Math.sin(elapsed * 4.0) > 0.2 ? 1 : 0.1; b.blinkMats.forEach(m => m.color.setRGB(on, 0.29 * on, 0.23 * on)); }
  }

  // Endurance parked uprange on its high orbit (ring still turning): the descent ground
  // track runs monotonically downrange from it to the pad beside the colony.
  voyage.station.position.copy(M).addScaledVector(dir, PARK_D).addScaledVector(tang, EDL_LAT0);
  voyage.station.quaternion.setFromUnitVectors(AXIS_Z, tang);
  voyage.station.userData.ring.rotation.z = elapsed * 0.5;

  // The pad's true surface normal: the descent axis. Settling along dirPad puts the
  // legs ON the curved ground (a flat tangent-plane offset would float them above it).
  const dirPad = dir.clone().multiplyScalar(mR)
    .addScaledVector(tang, EDL_PAD_T).addScaledVector(cross, EDL_PAD_C).normalize();

  // Descent profile: ease off the dock → entry arc downrange → pitch up → retro-burn to a
  // soft touchdown on the pad. One smooth position function so velocity (and attitude)
  // can be read off it by finite difference.
  const startAlt = PARK_D - mR;
  const REST = 0.48 * MS;                                 // legs-on-ground rest height
  const posAt = (uu) => {
    const fall = Math.pow(clamp01((EDL.BURN - uu) / EDL.BURN), 1.3);
    const hover = Math.pow(clamp01((1 - uu) / (1 - EDL.BURN)), 2.0);
    let a = uu < EDL.BURN ? ((startAlt - 1.5) * fall + 1.5) : (1.5 * hover);
    a = startAlt + (a - startAlt) * sstep(uu, 0.015, 0.2);            // gentle sink off the dock
    const drift = sstep(uu, 0.0, 0.66);                               // ground track eases onto the pad
    const axis = dir.clone().lerp(dirPad, drift).normalize();         // radial axis: station's up → pad's up
    const lat = EDL_LAT0 * (1 - drift);
    return M.clone().addScaledVector(axis, mR + a + REST).addScaledVector(tang, lat);
  };
  // The stage opens with the shuttle ON the dock (same nose offset cruise uses), easing
  // onto the descent trajectory over the first beats — a true visible separation.
  const dock = voyage.station.position.clone().addScaledVector(tang, 1.5 * MS);
  const shipAt = (uu) => dock.clone().lerp(posAt(uu), sstep(uu, 0.0, 0.10));
  const pos = shipAt(u);
  const alt = pos.distanceTo(M) - mR - REST;              // height of the legs above the pad
  const velDir = shipAt(Math.min(1, u + 0.01)).sub(pos);
  if (velDir.lengthSq() < 1e-9) velDir.copy(dirPad).negate(); else velDir.normalize();
  voyage.ship.position.copy(pos);

  // Attitude from an explicit wings-level basis — docked along the station spine, nose
  // into the airflow for the glide, upright (engines down) for the burn. Blending the
  // NOSE DIRECTION inside one stable frame avoids the setFromUnitVectors roll-flip that
  // used to snap the craft sideways at pitch-up.
  const wDock = 1 - sstep(u, 0.05, 0.18);
  const wUp = sstep(u, EDL.PITCH - 0.05, EDL.PITCH + 0.10);
  const wGlide = Math.max(0, 1 - wDock - wUp);
  const nose = new THREE.Vector3()
    .addScaledVector(tang, wDock + 0.001)                 // tiny tang bias keeps the basis non-degenerate
    .addScaledVector(velDir, wGlide)
    .addScaledVector(dirPad, wUp).normalize();
  const wing = new THREE.Vector3().crossVectors(dirPad, nose);
  if (wing.lengthSq() < 1e-4) wing.crossVectors(dirPad, tang);
  wing.normalize();
  const shipY = new THREE.Vector3().crossVectors(nose, wing).normalize();
  voyage.ship.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wing, shipY, nose));

  const sd = voyage.ship.userData;
  const deorbit = u >= 0.07 && u < 0.13;                  // short burn commits the descent
  const inEntry = u >= EDL.ENTRY && u < EDL.AERO;
  const landing = u >= EDL.BURN, touched = u > EDL.TOUCH;

  // Entry plasma glow + ionization trail (brief, high up).
  voyage.flash.visible = inEntry;
  if (inEntry) {
    const heat = clamp01(1 - Math.abs(u - 0.26) / 0.15);   // plasma peaks mid-entry
    voyage.flash.position.copy(pos).addScaledVector(velDir, 0.35 * MS);   // glow just ahead of the nose
    voyage.flash.material.opacity = heat * 0.6;
    voyage.flash.scale.setScalar((0.5 + heat * 1.0) * MS);
    sd.trail.material.color.setHex(0xff7a32); sd.trail.material.opacity = heat * 0.7;
    sd.trail.scale.set(0.9 + heat * 0.7, 1.8 + heat * 2.2, 1);
  }

  // Engines: the deorbit blip, then the retro/landing burn — cut the instant legs settle.
  sd.plume.visible = (deorbit || landing) && !touched;
  if (sd.plume.visible) {
    const thr = deorbit ? 0.55 : 0.6 + clamp01((u - EDL.BURN) / (1 - EDL.BURN)) * 0.7;
    const f = 1 + Math.sin(elapsed * 44) * 0.1;
    sd.plume.scale.set(deorbit ? 0.6 : 0.85, thr * f, deorbit ? 0.6 : 0.85);
    sd.trail.material.color.setHex(0x6cc8ff); sd.trail.material.opacity = 0.9; sd.trail.scale.setScalar(deorbit ? 1.4 : 2.2);
  } else if (!inEntry) { sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001); }
  sd.legs.visible = u > 0.6;

  // The landing burn lights the pad below — the glow swells as the ground nears.
  if (voyage.edlLight) {
    const lit = landing && !touched ? clamp01((1.6 - alt) / 1.6) : 0;
    voyage.edlLight.visible = lit > 0.01;
    voyage.edlLight.intensity = lit * 2.2;
    voyage.edlLight.position.copy(pos).addScaledVector(dirPad, -0.5 * MS);
  }

  // Dusty Mars sky fades in as the shuttle drops into the atmosphere (space → haze),
  // the launch sky's trick in reverse.
  if (voyage.marsSky) {
    const fade = clamp01((2.2 - alt) / 1.4);
    voyage.marsSky.visible = fade > 0.01;
    voyage.marsSky.position.copy(M);
    voyage.marsSky.material.uniforms.uSun.value.copy(M).multiplyScalar(-1).normalize();
    voyage.marsSky.material.uniforms.uFade.value = fade;
    asteroidBelt.visible = fade < 0.5;                    // no asteroids hanging in the daytime haze
  }

  // Dust + a few lofted debris kicked up by the burn near touchdown; settles after.
  if (voyage.dust) {
    const active = (landing && alt < 2.4 * MS) || (touched && u < 0.998);
    voyage.dust.visible = active;
    if (active) {
      // Builds as the retro plume nears the ground, peaks at touchdown, then hangs
      // and slowly settles — a reddish Mars dust wall blown out flat across the pad.
      const settle = touched ? clamp01((0.998 - u) / 0.05) : 1;
      const amp = touched ? settle : clamp01((2.4 * MS - alt) / (2.2 * MS));
      voyage.dust.position.copy(M).addScaledVector(dirPad, mR + 0.04 * MS);
      voyage.dust.quaternion.setFromUnitVectors(UP, dirPad);
      voyage.dust.userData.parts.forEach((p, i) => {
        const debris = (i % 7 === 0);
        const reach = amp * p.userData.speed * (debris ? 1.8 : 1.5) * MS;
        const lift = debris ? 0.5 : 0.16;                       // billows wide and flat, hugging the ground
        p.position.set(p.userData.dir.x * reach, Math.abs(p.userData.dir.y) * reach * lift, p.userData.dir.z * reach);
        p.material.opacity = amp * (debris ? 0.65 : 0.6) * (1 - amp * 0.2);
        p.scale.setScalar(p.userData.size * (debris ? 0.7 : 1.3) * (1 + reach * 0.9) * MS);
      });
    }
  }

  // Telemetry handoff (read in updateTelemetry). The start reference is the true
  // spherical altitude at the parked station (radial + lateral), so ALT opens at max.
  voyage.edlAlt = alt;
  voyage.edlStartAlt = Math.hypot(PARK_D, EDL_LAT0) - mR;
  voyage.edlPhase = u < 0.07 ? 'UNDOCK' : u < EDL.ENTRY ? 'DEORBIT' : u < EDL.AERO ? 'PLASMA / AEROBRAKE'
    : u < EDL.BURN ? 'PITCH-UP' : u < EDL.TOUCH ? 'RETRO BURN' : 'TOUCHDOWN';

  // Camera beats (offsets ride MS; up = local surface normal so every shot reads level):
  // undock over the station → entry chase → dusty-sky hero → low pad shot → touchdown.
  const site = M.clone().addScaledVector(dirPad, mR);
  const upCam = dir.clone().lerp(dirPad, sstep(u, 0.3, 0.6)).normalize();  // roll eases from station-local to pad-local up
  let camP, lookP, fov;
  if (u < 0.14) {                              // from above the station: the shuttle slips off the dock and
    camP = voyage.station.position.clone()     // falls away toward the red disc far below
      .addScaledVector(dir, 8.0 * MS).addScaledVector(cross, 1.5 * MS).addScaledVector(tang, 1.0 * MS);
    lookP = pos.clone().addScaledVector(dir, -2.0 * MS); fov = 50;
  } else if (u < 0.46) {                       // entry: chase from behind-above, plasma streaking, Mars rising into frame
    camP = pos.clone().addScaledVector(tang, -6.5 * MS).addScaledVector(dir, 2.6 * MS).addScaledVector(cross, 2.2 * MS);
    lookP = pos.clone().addScaledVector(velDir, 2.2 * MS).addScaledVector(dir, -1.8 * MS); fov = 52;
  } else if (u < 0.66) {                       // aerobrake → pitch-up: side hero as the dusty sky materializes
    camP = pos.clone().addScaledVector(cross, 3.0 * MS).addScaledVector(dirPad, 0.7 * MS).addScaledVector(tang, 1.0 * MS);
    lookP = pos.clone().addScaledVector(dirPad, -0.3 * MS); fov = 48;
  } else if (u < 0.93) {                       // powered descent: low at the pad, colony behind, ship sinking to us
    camP = site.clone().addScaledVector(cross, 3.2 * MS).addScaledVector(dirPad, 1.6 * MS).addScaledVector(tang, 1.6 * MS);
    lookP = pos.clone().lerp(site, 0.25).addScaledVector(dirPad, 0.5 * MS); fov = 50;
  } else {                                     // touchdown: 3/4 shot over the pad — legs, dust wall, colony beyond
    camP = site.clone().addScaledVector(cross, 3.0 * MS).addScaledVector(dirPad, 1.2 * MS).addScaledVector(tang, -2.0 * MS);
    lookP = pos.clone().addScaledVector(dirPad, 0.3 * MS); fov = 46;
  }
  return { pos: camP, look: lookP, fov, up: upCam };
}

function updateHelio(ph, u, dt) {
  voyage.rocket.visible = false;
  voyage.lander.visible = false;
  voyage.launchTrail.visible = false;
  if (voyage.groundSmoke) voyage.groundSmoke.visible = false;
  voyage.flash.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.dust) voyage.dust.visible = false;
  if (voyage.edlLight) voyage.edlLight.visible = false;
  if (voyage.earthGround) voyage.earthGround.visible = false;
  if (voyage.launchField) voyage.launchField.visible = false;
  if (voyage.launchRoad) voyage.launchRoad.visible = false;
  if (voyage.launchPad) voyage.launchPad.visible = false;
  if (voyage.launchSky) voyage.launchSky.visible = false;
  if (voyage.vaporCone) voyage.vaporCone.visible = false;
  if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
  if (earthSats) earthSats.visible = true;
  const isSurface = ph.key === 'surface';
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = !isSurface;
  // On the surface only Mars exists — no other planets hanging in the daytime sky.
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = !isSurface || key === 'mars';
  orbitPaths.forEach(o => { o.visible = !isSurface; });   // hide orbit rings on the Mars close-up

  const s = ph.s0 + u * (ph.s1 - ph.s0);
  const st = transferState(s);
  const fwd = transferState(Math.min(1, s + 0.004)).pos.clone().sub(st.pos).normalize();
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  // Parking-orbit clamp: hold the Endurance PARK_D clear of Mars's center — it slides
  // around the planet instead of descending into it (reads as the capture/insertion).
  if (!isSurface) {
    const Mw = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(Mw);
    const toShip = st.pos.clone().sub(Mw);
    if (toShip.length() < PARK_D) st.pos.copy(Mw).addScaledVector(toShip.normalize(), PARK_D);
  }

  if (!isSurface) {
    // The Endurance flies the transfer, its ring spinning for artificial gravity.
    voyage.station.visible = true;
    voyage.station.position.copy(st.pos);
    voyage.station.quaternion.setFromUnitVectors(AXIS_Z, fwd);
    voyage.station.userData.ring.rotation.z += dt * 0.5;

    // Crew shuttle: flies in and docks at the station's nose at the start of cruise,
    // then rides along docked for the rest of the coast + approach.
    voyage.ship.visible = true;
    const sd = voyage.ship.userData;
    const docked = st.pos.clone().addScaledVector(fwd, 1.5 * MS);
    if (ph.key === 'cruise') {
      const dockT = clamp01(u / 0.10);
      const appr = Math.pow(1 - dockT, 1.4);              // 1 = approaching, 0 = docked
      const side = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      voyage.ship.position.copy(docked)
        .addScaledVector(fwd, -appr * 5.0 * MS)
        .addScaledVector(UP, -appr * 2.8 * MS)
        .addScaledVector(side, appr * 1.6 * MS);
      const burning = appr > 0.04;                         // docking maneuver burn
      sd.plume.visible = burning;
      sd.plume.scale.set(1, 1, 1);
      sd.trail.material.opacity = burning ? 0.8 : 0;
      sd.trail.scale.setScalar(burning ? 2.2 : 0.001);
    } else {
      voyage.ship.position.copy(docked);
      sd.plume.visible = false;
      sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001);
    }
    voyage.ship.quaternion.setFromUnitVectors(AXIS_Z, fwd);
    sd.legs.visible = false;
  } else {
    voyage.station.visible = false;
    // The shuttle stays parked on the colony landing pad, right where EDL set it down.
    const Mw = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(Mw);
    const mR = planetMeshes.mars.config.size;
    const tangS = new THREE.Vector3().crossVectors(BASE_N, UP).normalize();
    const crossS = new THREE.Vector3().crossVectors(tangS, BASE_N).normalize();
    const dirPad = BASE_N.clone().multiplyScalar(mR).addScaledVector(tangS, EDL_PAD_T).addScaledVector(crossS, EDL_PAD_C).normalize();
    voyage.ship.visible = true;
    voyage.ship.position.copy(Mw).addScaledVector(dirPad, mR + 0.48 * MS);
    voyage.ship.quaternion.setFromUnitVectors(AXIS_Z, dirPad);
    const sd = voyage.ship.userData;
    sd.legs.visible = true;
    sd.plume.visible = false;
    sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001);
  }

  // Mars surface colony — shown only on the Surface Operations close-up, planted on
  // the camera-facing surface point with its spin frozen so it holds still.
  if (voyage.base) {
    if (isSurface) {
      planetMeshes.mars.mesh.rotation.y = 0.6;
      const Mw = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(Mw);
      const mR = planetMeshes.mars.config.size;
      if (voyage.ground) {
        voyage.ground.position.copy(Mw);
        voyage.ground.quaternion.setFromUnitVectors(UP, BASE_N);   // cap apex → colony point
        voyage.ground.material.transparent = false; voyage.ground.material.opacity = 1;
        voyage.ground.visible = true;
      }
      voyage.base.position.copy(Mw).addScaledVector(BASE_N, mR * 1.002);   // seat on the ground cap
      voyage.base.quaternion.setFromUnitVectors(UP, BASE_N);
      voyage.base.visible = true;
      // Living base: gently pulse the window glow, flutter the flag, blink the beacons.
      const b = voyage.base.userData, pulse = 1.15 + Math.sin(elapsed * 1.6) * 0.2;
      if (b.glowMats) b.glowMats.forEach(m => { m.emissiveIntensity = pulse; });
      if (b.flag) b.flag.rotation.z = Math.sin(elapsed * 2.0) * 0.16;
      if (b.blinkMats) { const on = Math.sin(elapsed * 4.0) > 0.2 ? 1 : 0.1; b.blinkMats.forEach(m => m.color.setRGB(on, 0.29 * on, 0.23 * on)); }
      if (voyage.marsSky) {
        voyage.marsSky.position.copy(Mw);
        voyage.marsSky.material.uniforms.uSun.value.copy(Mw).multiplyScalar(-1).normalize();   // sun direction from the colony
        voyage.marsSky.material.uniforms.uFade.value = 1;   // fully in the atmosphere on the ground
        voyage.marsSky.visible = true;
      }
      asteroidBelt.visible = false;   // no asteroids hanging in the Martian daytime sky
    } else { voyage.base.visible = false; if (voyage.ground) voyage.ground.visible = false; if (voyage.marsSky) voyage.marsSky.visible = false; asteroidBelt.visible = true; }
  }

  if (!isSurface) {
    const pts = []; const n = 90;
    for (let i = 0; i <= n; i++) {
      const nu = (i / n) * st.nu;
      const r = A_T * (1 - E_T * E_T) / (1 + E_T * Math.cos(nu));
      pts.push(new THREE.Vector3(Math.cos(EARTH_ANGLE + nu) * r, 0, Math.sin(EARTH_ANGLE + nu) * r));
    }
    voyage.ellipseTrail.geometry.setFromPoints(pts);
  }
  return { s, st };
}

function updateTelemetry(ph, u, s) {
  // Per-stage text + traveller's-log facts: only rewrite when the stage changes.
  if (voyage.stage !== voyage.lastStage) {
    voyage.lastStage = voyage.stage;
    vEls['v-phase'].textContent = ph.short;
    vEls['vc-tag'].textContent = ph.tag;
    vEls['v-notes'].innerHTML = ph.facts.map(f => `<div class="note">› ${f}</div>`).join('');
    highlightStage();
  }
  if (ph.mode === 'launch') {
    const secs = u * 540;
    // Velocity dips at MECO then climbs again on the upper stage; altitude keeps rising.
    const vel = u < EV.meco ? u * 6.6 : 5.3 + (u - EV.meco) * 4.8;
    vEls['v-elapsed'].textContent = `T+ ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
    vEls['v-vel'].textContent = `${vel.toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = `${Math.round(u * 400)} KM ALT`;
    // Engine status tracks the flight phase.
    const coast = u >= EV.meco && u < EV.ign2;
    const status = u < EV.hold ? '◐ IGNITION' : u >= EV.seco ? '○ SECO' : coast ? '○ COAST'
      : u >= EV.ign2 ? '● SES-1' : u >= EV.maxQ && u < 0.34 ? '▼ THROTTLE' : '● BURN';
    vEls['v-engine'].textContent = status;
    vEls['v-engine'].className = (coast || u >= EV.seco) ? '' : 'warn';
  } else if (ph.mode === 'edl') {
    const a = Math.max(0, voyage.edlAlt ?? 4.7), a0 = voyage.edlStartAlt || 4.7;
    vEls['v-elapsed'].textContent = `ALT ${Math.round(a / a0 * 125)} KM`;
    vEls['v-vel'].textContent = `${Math.max(0, a / a0 * 4.2 + (u >= EDL.ENTRY && u < EDL.AERO ? 1.2 : 0)).toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = voyage.edlPhase || 'DESCENT';
    const retro = u >= EDL.BURN && u <= EDL.TOUCH, plasma = u >= EDL.ENTRY && u < EDL.AERO;
    const deorb = u >= 0.07 && u < 0.13;
    vEls['v-engine'].textContent = u > EDL.TOUCH ? '○ DOWN' : retro ? '● RETRO' : plasma ? '▲ PLASMA'
      : deorb ? '● DEORBIT' : u < 0.07 ? '○ UNDOCK' : u < EDL.ENTRY ? '○ FREE-FALL' : '○ AEROBRAKE';
    vEls['v-engine'].className = (retro || plasma || deorb) ? 'warn' : '';
  } else {
    const st = voyageStats(s);
    if (ph.key === 'surface') {
      // Landed: surface-appropriate readouts rather than orbital telemetry.
      vEls['v-elapsed'].textContent = 'SOL 1 · ARRIVED';
      vEls['v-vel'].textContent = '0.0 KM/S';
      vEls['v-dist'].textContent = 'MARS · 1.52 AU';
      vEls['v-engine'].textContent = '○ SHUTDOWN'; vEls['v-engine'].className = '';
    } else {
      vEls['v-elapsed'].textContent = `DAY ${Math.round(st.day)} / 259`;
      vEls['v-vel'].textContent = `${st.v.toFixed(1)} KM/S`;
      vEls['v-dist'].textContent = `${st.rAU.toFixed(2)} AU`;
      // Cruise opens with the docking maneuver, then engines-off coast on the ellipse.
      let eng = '○ OFF', warn = false;
      if (ph.key === 'cruise' && u < 0.10) { eng = '◐ DOCKING'; warn = true; }
      else if (ph.burn) { eng = '● BURN'; warn = true; }
      vEls['v-engine'].textContent = eng;
      vEls['v-engine'].className = warn ? 'warn' : '';
    }
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
  sunGroup.visible = ph.mode !== 'launch';   // the stylized sun disc reads as a portal in the up-looking pad view
  let cam, camAnchor = null, camAnchorKey = 'world';
  if (ph.mode === 'launch') {
    cam = updateLaunch(u);
    camAnchor = voyage.rocket.position; camAnchorKey = 'rocket';
    updateTelemetry(ph, u, null);
  } else if (ph.mode === 'edl') {
    cam = updateEDL(u);
    camAnchor = voyage.ship.position; camAnchorKey = 'shuttle';
    updateTelemetry(ph, u, 0.94 + u * 0.06);
  } else {
    const { s, st } = updateHelio(ph, u, dt);
    updateTelemetry(ph, u, s);
    // Cruise plays as a sequence of beats over the eight-month coast: docking, ring
    // life, the trans-Mars departure, the deep-space coast, then the Kepler map.
    let view = ph.view;
    if (ph.key === 'cruise') {
      view = u < 0.16 ? 'dock' : u < 0.38 ? 'endurance' : u < 0.60 ? 'chase' : u < 0.82 ? 'coast' : 'map';
    }
    if (ph.key === 'approach') view = u < 0.82 ? 'approach' : 'arrival';
    cam = viewTarget(view, st, s, u);
    // Ship-centric shots track the craft as it flies the transfer; the fixed map
    // and surface views smooth in world space instead.
    if (view !== 'map' && view !== 'surface') { camAnchor = st.pos; camAnchorKey = 'ship'; }
  }
  // Aim the directional sun + shadow frustum at the current subject each frame so the
  // craft are lit from the same direction as the planet shaders (sun at the origin).
  let _subj = null, _srad = 5;
  if (ph.mode === 'launch') { _subj = voyage.rocket.position; _srad = 3.5 * RM; }
  else if (ph.mode === 'edl') { _subj = voyage.ship.position; _srad = 4 * MS; }
  else if (ph.key === 'surface') { _subj = voyage.base.position; _srad = 5; }
  else if (voyage.station && voyage.station.visible) { _subj = voyage.station.position; _srad = 4 * MS; }
  if (_subj) frameSunShadow(_subj, _srad);

  // Launch frames the tiny rocket from very close, so pull the near plane right in for that
  // stage only (the rest keep 0.1 to preserve depth precision around the planet shells).
  const wantNear = ph.mode === 'launch' ? 0.002 : 0.1;
  if (camera.near !== wantNear) { camera.near = wantNear; camera.updateProjectionMatrix(); }

  // Per-stage focal length (stages may return a `fov`): snap on seek, ease while playing.
  const targetFov = cam.fov || 55;
  const targetUp = cam.up || UP;   // local "up" so launch/surface read level instead of tilted
  // Smooth the camera RELATIVE to the moving subject (anchor): beat-to-beat moves still
  // glide, but the anchor's own motion is followed exactly. Smoothing in absolute space
  // made tight shots trail whole frame-widths behind the craft flying the transfer.
  const anc = camAnchor || ZERO_V;
  const relPos = cam.pos.clone().sub(anc), relLook = cam.look.clone().sub(anc);
  if (!voyage.camInit) {
    voyage.camPos.copy(relPos); voyage.camLook.copy(relLook); voyage.camUp.copy(targetUp);
    voyage.camAnchor.copy(anc); voyage.camAnchorKey = camAnchorKey;
    voyage.camInit = true; camera.fov = targetFov; camera.updateProjectionMatrix();
  } else if (Math.abs(camera.fov - targetFov) > 0.01) { camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
  if (voyage.camAnchorKey !== camAnchorKey) {
    // The subject changed (e.g. chase → map): rebase the stored offsets onto the new
    // anchor so the camera's absolute pose carries over and glides, not teleports.
    voyage.camPos.add(voyage.camAnchor).sub(anc);
    voyage.camLook.add(voyage.camAnchor).sub(anc);
    voyage.camAnchorKey = camAnchorKey;
  }
  voyage.camAnchor.copy(anc);
  const k = 1 - Math.exp(-dt * 2.4);
  voyage.camPos.lerp(relPos, k);
  voyage.camLook.lerp(relLook, k);
  voyage.camUp.lerp(targetUp, k);
  if (voyage.camUp.lengthSq() > 1e-6) voyage.camUp.normalize();
  camera.position.copy(anc).add(voyage.camPos);
  camera.up.copy(voyage.camUp);
  // Cinematic shake: liftoff rumble + max-Q buffet + touchdown jolt. Applied here,
  // after the position smoothing, so the high-frequency vibration isn't damped away.
  const shakeAmp = stageShake(ph, u);
  _shLook.copy(anc).add(voyage.camLook);                 // smoothed look, back in world space
  if (shakeAmp > 1e-4) {
    const tt = voyage.t;
    _shFwd.subVectors(voyage.camLook, voyage.camPos).normalize();
    _shRight.crossVectors(_shFwd, voyage.camUp).normalize();
    _shUp.crossVectors(_shRight, _shFwd).normalize();
    const jx = (Math.sin(tt * 47.0) + 0.7 * Math.sin(tt * 31.3 + 1.1)) * shakeAmp;
    const jy = (Math.sin(tt * 43.0 + 1.3) + 0.7 * Math.sin(tt * 27.7 + 0.6)) * shakeAmp;
    camera.position.addScaledVector(_shRight, jx).addScaledVector(_shUp, jy);
    _shLook.addScaledVector(_shRight, -jx * 0.4).addScaledVector(_shUp, -jy * 0.4);
  }
  camera.lookAt(_shLook);
}

// Camera shake amplitude (world units) by stage moment: rocket rumble at ignition,
// a buffet through max-Q, and a hard jolt at Mars touchdown — zero everywhere else.
function stageShake(ph, u) {
  if (ph.mode === 'launch') {
    return 0;                                                                  // no launch shake — clean, steady ascent
  }
  if (ph.mode === 'edl') {
    return u >= EDL.TOUCH ? clamp01(1 - (u - EDL.TOUCH) / 0.035) * 0.04 : 0;   // jolt on contact, decays
  }
  return 0;
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
    voyage.station = buildEndurance();          // the Endurance ring station
    voyage.station.visible = false;
    scene.add(voyage.station);
    voyage.lander = buildLander();
    scene.add(voyage.lander);
    voyage.launchTrail = buildLaunchTrail();
    scene.add(voyage.launchTrail);
    voyage.groundSmoke = buildGroundSmoke();
    voyage.groundSmoke.visible = false;
    scene.add(voyage.groundSmoke);
    voyage.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(['rgba(255,255,255,0.95)', 'rgba(255,205,130,0.5)', 'rgba(255,120,40,0)']),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    }));
    voyage.flash.visible = false;
    scene.add(voyage.flash);
    voyage.vaporCone = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(['rgba(240,250,255,0.9)', 'rgba(200,225,255,0.35)', 'rgba(200,225,255,0)']),
      transparent: true, blending: THREE.NormalBlending, depthWrite: false, opacity: 0,
    }));
    voyage.vaporCone.visible = false; scene.add(voyage.vaporCone);   // max-Q condensation
    voyage.boosterGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(['rgba(255,180,90,0.95)', 'rgba(255,90,30,0.4)', 'rgba(255,40,10,0)']),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
    }));
    voyage.boosterGlow.visible = false; scene.add(voyage.boosterGlow);   // spent-stage reentry glow
    voyage.frost = buildParticles(14, 0xdff0ff, true, 0.025, 0.07);   // ice/gas at staging — subtle wisp
    scene.add(voyage.frost);
    voyage.dust = buildParticles(40, 0xc98f63, false, 0.18, 0.5);    // dust at touchdown
    scene.add(voyage.dust);
    voyage.edlLight = new THREE.PointLight(0xcfe8ff, 0, 2.5, 2);     // landing burn lighting the pad
    voyage.edlLight.visible = false;
    scene.add(voyage.edlLight);
    voyage.base = buildMarsBase();                                   // Mars surface colony
    voyage.base.visible = false;
    scene.add(voyage.base);
    voyage.ground = buildMarsGround();                               // curved Mars ground under the colony
    voyage.ground.visible = false;
    scene.add(voyage.ground);
    voyage.marsSky = buildMarsSky();                                 // dusty Mars sky (Surface Ops only)
    voyage.marsSky.visible = false;
    scene.add(voyage.marsSky);
    voyage.earthGround = buildEarthGround();                         // launch-site ground patch
    voyage.earthGround.visible = false;
    scene.add(voyage.earthGround);
    voyage.launchField = buildLaunchField();                         // flat foreground terrain for the opening crane
    voyage.launchField.visible = false;
    scene.add(voyage.launchField);
    voyage.launchRoad = buildLaunchRoad();                           // access road crossing the desert to the pad
    voyage.launchRoad.visible = false;
    scene.add(voyage.launchRoad);
    voyage.launchPad = buildLaunchPad();                             // concrete pad + service gantry
    voyage.launchPad.position.copy(PAD);
    voyage.launchPad.quaternion.setFromUnitVectors(UP, LAUNCH_N);
    voyage.launchPad.visible = false;
    scene.add(voyage.launchPad);
    voyage.launchSky = buildLaunchSky();                             // blue daytime sky that fades to space
    voyage.launchSky.visible = false;
    scene.add(voyage.launchSky);
    voyage.ellipseFull = buildEllipseLine(240, 0.22, 0x6ff1ff);
    scene.add(voyage.ellipseFull);
    voyage.ellipseTrail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xb8f8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    scene.add(voyage.ellipseTrail);

    // Pixar pass: trim IBL reflection strength so space stays moody, and enable soft
    // self-shadows on the solid craft (skip additive/transparent flames + glass).
    [voyage.ship, voyage.rocket, voyage.spentStage, voyage.station, voyage.base].forEach(o => {
      if (!o) return;
      setEnvIntensity(o, 0.55);
      o.traverse(m => {
        if (!m.isMesh) return;
        const mat = m.material;
        const soft = mat && (mat.blending === THREE.AdditiveBlending || mat.transparent === true);
        m.castShadow = !soft;
        m.receiveShadow = !soft;
      });
    });
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
  sunGroup.visible = true;   // restore the sun for the free-roam atlas view
  if (voyage.ship) {
    voyage.ship.visible = voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
    voyage.rocket.visible = voyage.launchTrail.visible = voyage.flash.visible = false;
    if (voyage.groundSmoke) voyage.groundSmoke.visible = false;
    voyage.lander.visible = false;
    if (voyage.frost) voyage.frost.visible = false;
    if (voyage.dust) voyage.dust.visible = false;
    if (voyage.base) voyage.base.visible = false;
    if (voyage.ground) voyage.ground.visible = false;
    if (voyage.earthGround) voyage.earthGround.visible = false;
    if (voyage.launchField) voyage.launchField.visible = false;
    if (voyage.launchRoad) voyage.launchRoad.visible = false;
    if (voyage.launchPad) voyage.launchPad.visible = false;
    if (voyage.launchSky) voyage.launchSky.visible = false;
    if (voyage.vaporCone) voyage.vaporCone.visible = false;
    if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
    if (voyage.spentStage) voyage.spentStage.visible = false;
    if (voyage.station) voyage.station.visible = false;
    if (voyage.marsSky) voyage.marsSky.visible = false;
    if (voyage.edlLight) voyage.edlLight.visible = false;
  }
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = true;
  orbitPaths.forEach(o => { o.visible = true; });
  document.getElementById('voyage').classList.add('hidden');
  document.getElementById('voyage-controls').classList.add('hidden');
  document.getElementById('hud').classList.remove('voyage-on');
  document.querySelectorAll('.sim-stage').forEach(b => b.classList.remove('active'));
  camera.fov = 55; camera.updateProjectionMatrix();   // reset any per-stage focal length
  camera.up.set(0, 1, 0);                              // reset roll for OrbitControls
  if (earthSats) earthSats.visible = true;
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

// Scrubbable play-head: click or drag anywhere on the progress track to jump to that
// point in the current stage (use the stage buttons to move between stages).
const progTrack = document.querySelector('.sim-progress');
function seekFromEvent(e) {
  if (!voyage.active) return;
  const rect = progTrack.getBoundingClientRect();
  const f = clamp01((e.clientX - rect.left) / rect.width);
  const ph = PHASES[voyage.stage];
  voyage.t = ph.t0 + f * ph.dur;
  voyage.camInit = false;          // snap the camera to the scrubbed moment
  vEls['v-progress'].style.width = (f * 100).toFixed(1) + '%';
}
progTrack.addEventListener('pointerdown', e => {
  e.preventDefault();
  progTrack.setPointerCapture(e.pointerId);
  seekFromEvent(e);
  const move = ev => seekFromEvent(ev);
  const up = () => { progTrack.removeEventListener('pointermove', move); progTrack.removeEventListener('pointerup', up); };
  progTrack.addEventListener('pointermove', move);
  progTrack.addEventListener('pointerup', up);
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
      pm.mesh.userData.clouds.rotation.y += dt * 0.012;   // real cloud shell — just a slow drift
    }
    if (pm.material.uniforms) {                            // only the procedural planets have uniforms
      pm.material.uniforms.uTime.value = t;
      pm.material.uniforms.uLightPos.value.set(0, 0, 0);
    }
    if (pm.mesh.material.userData.sunDirRef) {             // real-texture Earth — feed sun direction (sun at origin)
      pm.mesh.getWorldPosition(_tmpVec);
      pm.mesh.material.userData.sunDirRef.value.copy(_tmpVec).multiplyScalar(-1).normalize();
    }
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

  gradePass.uniforms.time.value = t;
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
