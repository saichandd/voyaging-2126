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
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.5, 1.05);
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
const winMat = new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 0.5, metalness: 0.4, emissive: 0xffffff, emissiveMap: WIN_TEX, emissiveIntensity: 3.0 });

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
const sunMat = new THREE.MeshBasicMaterial({ map: sunTex, color: new THREE.Color(2.4, 2.1, 1.7), toneMapped: false });
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
    normalScale: new THREE.Vector2(0.8, 0.8),
    envMapIntensity: 0.2,
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
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.92, 0.10, texture2D(roughnessMap, vRoughnessMapUv).g);')   // oceans smooth (glint), land rough
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
        float fres = pow(1.0 - max(0.0, dot(vNormal, V)), 3.0);
        float lit = smoothstep(-0.25, 0.4, dot(vNormal, L));
        float a = fres * (0.35 + 0.65 * lit) * uIntensity;
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

  // Atmosphere for select planets — bright at silhouette, near-transparent at center
  if (p.key === 'earth') tiltGroup.add(makeAtmosphere(p.size * 1.12, 0x4ab8ff, 1.6));
  if (p.key === 'venus') tiltGroup.add(makeAtmosphere(p.size * 1.16, 0xffd49a, 1.4));
  if (p.key === 'mars') tiltGroup.add(makeAtmosphere(p.size * 1.09, 0xff8a4a, 0.9));
  if (p.key === 'jupiter') tiltGroup.add(makeAtmosphere(p.size * 1.05, 0xffd0a0, 0.6));
  if (p.key === 'saturn') tiltGroup.add(makeAtmosphere(p.size * 1.04, 0xc8b48a, 0.35));
  if (p.key === 'uranus') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0xa0eef0, 0.9));
  if (p.key === 'neptune') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0x6090ff, 1.0));

  // Earth: real drifting cloud shell (colour doubles as the alpha mask).
  if (p.key === 'earth') {
    const cloudTex = loadTex('earth_clouds_2048.png', { srgb: true });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(p.size * 1.03, 96, 96),
      new THREE.MeshStandardMaterial({ map: cloudTex, alphaMap: cloudTex, transparent: true, depthWrite: false, roughness: 1.0, metalness: 0.0 }));
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
  g.scale.setScalar(0.26);
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
  g.scale.setScalar(0.5);
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
const LAUNCH_MAXALT = 3.5, LAUNCH_RANGE = 3.5, ROCKET_BASE = 0.5;              // ascent shaping (scene units)
// Shared launch + EDL event timelines (progress u in [0,1]) so motion, plume, camera
// and telemetry stay in sync.
const EV = { hold: 0.025, tower: 0.06, roll: 0.09, pitch: 0.15, maxQ: 0.25, meco: 0.46, sep: 0.49, ign2: 0.54, fairing: 0.63, tilt: 0.80, seco: 0.96 };
// Launch broadcast callouts, surfaced one at a time as the flight passes each event —
// the running flight log a narrator reads over (status drives the ENGINE field separately).
const LAUNCH_CALLOUTS = [
  { at: 0.00, tag: 'IGNITION', text: 'Ignition sequence start — engines building to full thrust against the hold-downs.' },
  { at: 0.025, tag: 'LIFTOFF', text: 'Liftoff! Clearing the pad under 3–4 g — three to four times your own weight.' },
  { at: 0.06, tag: 'TOWER CLEAR', text: 'Tower cleared. Rolling the vehicle onto its flight azimuth toward orbit.' },
  { at: 0.15, tag: 'PITCH OVER', text: 'Pitch program — the rocket leans downrange and the gravity turn begins.' },
  { at: 0.25, tag: 'MAX-Q', text: 'Max-Q — peak aerodynamic pressure. Engines throttle down through the stress.' },
  { at: 0.34, tag: 'THROTTLE UP', text: 'Through the thick air — throttling back up, accelerating hard now.' },
  { at: 0.46, tag: 'MECO', text: 'MECO — main engine cutoff. The first stage has done its job.' },
  { at: 0.49, tag: 'STAGE SEP', text: 'Stage separation — the booster falls away to fly itself home and be reused.' },
  { at: 0.54, tag: 'SES-1', text: 'Second-stage ignition — a single vacuum engine lights to push on to orbit.' },
  { at: 0.63, tag: 'FAIRING SEP', text: 'Fairing jettison — the nose cone splits away; the air is too thin to matter.' },
  { at: 0.80, tag: 'ASCENT', text: 'Above 200 km, building toward 28,000 km/h — nearly orbital velocity.' },
  { at: 0.96, tag: 'SECO · ORBIT', text: 'SECO — engines off. The push is over. You are weightless, in orbit.' },
];
// Cruise flight-log: the eight-month coast to Mars, surfaced as the journey unfolds.
const CRUISE_CALLOUTS = [
  { at: 0.00, tag: 'RENDEZVOUS', text: 'Closing on the Endurance — the interplanetary mothership already waiting in orbit.' },
  { at: 0.09, tag: 'DOCKED', text: 'Soft capture, hard dock. The crew transfers aboard for the long ride to Mars.' },
  { at: 0.20, tag: 'SPIN-UP', text: 'The habitat ring spins up — centrifugal force stands in for gravity so muscles and bone hold.' },
  { at: 0.34, tag: 'LIFE ABOARD', text: 'Frozen and dried food; all water — even urine — recycled. A game area to pass the months.' },
  { at: 0.46, tag: 'TRANS-MARS', text: 'Engines off. We coast a Hohmann transfer — a free-fall arc around the Sun, eight months long.' },
  { at: 0.60, tag: 'DEEP SPACE', text: 'Earth is a blue point behind us now; some 480 million km of emptiness lie ahead.' },
  { at: 0.72, tag: 'COMMS LAG', text: 'A call home already takes minutes each way — and grows longer with every passing day.' },
  { at: 0.84, tag: 'KEPLER II', text: "Watch the speed bleed off as we climb away from the Sun — Kepler's 2nd law, made visible." },
  { at: 0.93, tag: 'MARS AHEAD', text: 'Mars brightens from a star into a disc dead ahead. Arrival is near.' },
];
// Approach flight-log: the final closing on Mars, from rust-red star to a world below.
const APPROACH_CALLOUTS = [
  { at: 0.00, tag: 'MARS IN SIGHT', text: 'Mars dead ahead — a rust-red star, brightening by the day after eight months.' },
  { at: 0.22, tag: 'RESOLVING', text: 'It swells from a point into a disc; polar caps and dark plains resolve out of the glare.' },
  { at: 0.42, tag: 'FINAL APPROACH', text: 'Closing fast. The lag to Earth has stretched past twenty minutes each way — we are on our own.' },
  { at: 0.60, tag: 'ORBIT INSERTION', text: 'Capture burn — the Endurance brakes into a parking orbit around Mars.' },
  { at: 0.78, tag: 'PARKING ORBIT', text: 'In orbit at last. The red world fills the windows; the landing shuttle is powered up.' },
  { at: 0.90, tag: 'UNDOCK PREP', text: 'The crew boards the shuttle. Final checks before separating for the descent.' },
];
// Descent & Landing flight-log: from undock in orbit to dust-settling touchdown.
const EDL_CALLOUTS = [
  { at: 0.00, tag: 'UNDOCK', text: 'Separation — the shuttle releases from the Endurance and drops away toward the surface.' },
  { at: 0.07, tag: 'DEORBIT', text: 'Deorbit burn — committing to the descent. There is no turning back now.' },
  { at: 0.13, tag: 'ENTRY INTERFACE', text: 'Entry interface — meeting the thin Martian air at thousands of kilometres an hour.' },
  { at: 0.19, tag: 'PEAK HEATING', text: 'Peak heating — a sheath of plasma wraps the heat shield, glowing orange.' },
  { at: 0.34, tag: 'AEROBRAKE', text: 'The atmosphere does the braking — far thinner than Earth’s, but enough to bleed speed.' },
  { at: 0.52, tag: 'PITCH UP', text: 'Pitching upright, engines swinging down for the powered descent.' },
  { at: 0.66, tag: 'RETRO BURN', text: 'Retro burn — the engines light to kill the last of the velocity.' },
  { at: 0.85, tag: 'FINAL DESCENT', text: 'Throttling down, feeling for the ground. Landing legs deployed.' },
  { at: 0.97, tag: 'TOUCHDOWN', text: 'Touchdown on Mars. The dust settles. After eight months — you have arrived.' },
];
// Surface Operations flight-log: a tour of the colony you've travelled 480 million km to reach.
const SURFACE_CALLOUTS = [
  { at: 0.00, tag: 'BOOTS ON MARS', text: 'Boots on Mars. The shuttle stands on the red plain beside the colony.' },
  { at: 0.16, tag: 'THE COLONY', text: 'Pressurized domes, habitat modules, and the first Starships that came before — home now.' },
  { at: 0.34, tag: 'POWER & AIR', text: 'Solar arrays drink the weak Martian sun; inside, the air is kept at a comfortable 18°C.' },
  { at: 0.52, tag: 'LOW GRAVITY', text: 'Gravity is just 38% of Earth’s — yet after months in near-zero g, many can barely stand.' },
  { at: 0.70, tag: 'THE FRONTIER', text: 'Water ice mined from below, oxygen split from the thin air — a foothold on another world.' },
  { at: 0.87, tag: 'WELCOME', text: 'Welcome to Mars. The journey that began on a launch pad ends here, 480 million km from home.' },
];
const EDL = { ENTRY: 0.16, AERO: 0.42, PITCH: 0.55, BURN: 0.62, TOUCH: 0.965 };

function earthGroundTexture(s = 1024) {
  const c = document.createElement('canvas'); c.width = c.height = s; const x = c.getContext('2d');
  x.fillStyle = '#5f6b3c'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 1600; i++) {
    const r = 8 + Math.random() * 72, t = Math.random();
    x.fillStyle = t < 0.4 ? `rgba(74,92,48,${0.06 + Math.random() * 0.14})`
      : t < 0.75 ? `rgba(118,104,64,${0.05 + Math.random() * 0.12})`
        : `rgba(48,66,38,${0.06 + Math.random() * 0.14})`;
    x.beginPath(); x.arc(Math.random() * s, Math.random() * s, r, 0, TAU); x.fill();
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
  const tex = earthGroundTexture(); tex.repeat.set(26, 26);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, color: 0x707d49, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.3,
    transparent: true, opacity: 1.0, side: THREE.DoubleSide, depthWrite: true,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(30, 72), mat);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), LAUNCH_N);   // disc normal -> surface up
  m.position.copy(PAD).addScaledVector(LAUNCH_N, 0.012);                    // sit just above the globe cap
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
  g.scale.setScalar(0.19);
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
  const body = new THREE.MeshStandardMaterial({ color: 0xd9dee3, metalness: 0.6, roughness: 0.44, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.6, 0.6), emissive: 0x141a26, emissiveIntensity: 0.12 });
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
  // Payload fairing on its own (cloned) material so it can be faded + jettisoned without
  // affecting the rest of the body.
  const fairMat = body.clone();
  const fairing = new THREE.Group();
  const fair = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.38, 1.0, 24), fairMat); fair.position.y = 2.95; fairing.add(fair);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 18), fairMat); tip.position.y = 3.7; fairing.add(tip);
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
  glow.scale.setScalar(1.7); glow.position.y = -0.7; flameGrp.add(glow);
  g.add(flameGrp);

  const light = new THREE.PointLight(0xffcaa0, 1.5, 9, 2); light.position.y = -2.6; g.add(light);

  g.userData = { stage1, upper, flameGrp, core, outer, glow, light, fairing };
  g.scale.setScalar(0.10);
  return g;
}

// The jettisoned first stage (same body as the rocket's stage 1) — flown in world
// space as it tumbles back down toward Earth after staging. Scaled to match buildRocket.
function buildSpentStage() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xd9dee3, metalness: 0.6, roughness: 0.44, normalMap: PANEL_N, normalScale: new THREE.Vector2(0.6, 0.6), emissive: 0x141a26, emissiveIntensity: 0.12 });
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
  g.scale.setScalar(0.10);
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
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uUp: { value: BASE_N.clone() }, uSun: { value: SUN_DIR.clone() }, uHorizon: { value: new THREE.Color(0xc99268) }, uZenith: { value: new THREE.Color(0x7c5240) } },
    vertexShader: `varying vec3 vL; void main(){ vL = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uUp,uSun,uHorizon,uZenith; varying vec3 vL;
      void main(){
        float a = clamp(dot(vL, normalize(uUp)), 0.0, 1.0);
        vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.65, a));
        float d = max(dot(vL, normalize(uSun)), 0.0);
        c += vec3(1.0,0.96,0.86) * pow(d, 260.0) * 2.0          // small pale sun disc
           + uHorizon * pow(d, 8.0) * 0.45                       // forward-scatter glow
           + uHorizon * smoothstep(0.16, 0.0, a) * 0.4;          // hazy horizon band
        gl_FragColor = vec4(c, 1.0);
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

  // Central landing pad + the two ships (hero + the crew ship just flown down).
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.02, 28), padMat));
  ship(0.7, -0.45, 0.4);          // hero
  ship(-0.55, 0.35, -0.7);        // crew ship you arrived on

  // Geodesic domes (a settlement cluster) + a greenhouse tint dome.
  dome(-0.05, 0.18, 0.22); dome(0.28, 0.38, 0.16); dome(-0.42, -0.05, 0.15);

  // Habitat capsules + a connecting tube between two of them.
  const h1 = hab(0.0, -0.28, 0.34, 0.4), h2 = hab(0.34, -0.12, 0.28, 1.3);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 10), white);
  tube.position.copy(h1.position).lerp(h2.position, 0.5); tube.position.y = 0.09;
  tube.quaternion.setFromUnitVectors(UP, h2.position.clone().sub(h1.position).setY(0).normalize()); g.add(tube);

  // Solar farm — rows of tilted panels.
  for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) {
    const arr = new THREE.Group(); arr.position.set(-0.95 + c * 0.2, 0.08, 0.45 + r * 0.22);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 6), dark); post.position.y = -0.05; arr.add(post);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.006, 0.13), panelMat); panel.rotation.x = -0.5; arr.add(panel);
    g.add(arr);
  }

  // Comms dish, storage tanks, antenna mast.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6), dark); mast.position.set(0.62, 0.17, 0.5); g.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, 0, Math.PI * 0.42), white); dish.position.set(0.62, 0.34, 0.5); dish.rotation.set(-0.8, 0, 0.3); g.add(dish);
  for (let i = 0; i < 2; i++) { const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.12, 6, 14), white); tank.position.set(-0.78 + i * 0.16, 0.12, -0.4); g.add(tank); }

  // Rover with a short dirt track behind it.
  const rover = new THREE.Group(); rover.position.set(-0.3, 0.04, 0.5);
  rover.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.09), white));
  for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 10), dark); w.rotation.x = Math.PI / 2; w.position.set(i < 2 ? 0.06 : -0.06, -0.02, i % 2 ? 0.05 : -0.05); rover.add(w); }
  g.add(rover);
  const track = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.4), new THREE.MeshStandardMaterial({ color: 0x3a2414, roughness: 1, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false }));
  track.rotation.x = -Math.PI / 2; track.position.set(-0.42, 0.012, 0.62); track.rotation.z = 0.5; g.add(track);

  // Astronauts (cloned) for life + scale.
  const astro = makeAstronaut();
  [[0.32, 0.05], [0.18, -0.12], [-0.12, 0.42], [0.5, 0.2]].forEach(([ax, az]) => { const a = astro.clone(); a.position.set(ax, 0.05, az); g.add(a); });

  // Flag.
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.26, 6), strut); flagPole.position.set(0.1, 0.13, 0.4); g.add(flagPole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.075), new THREE.MeshStandardMaterial({ color: 0xc8443a, roughness: 0.9, side: THREE.DoubleSide, emissive: 0x3a0a08, emissiveIntensity: 0.3 }));
  flag.position.set(0.165, 0.22, 0.4); g.add(flag);

  // Perimeter / path lights.
  for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU, r = 0.5 + (i % 3) * 0.06; const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), i % 2 ? warm : cyan); dot.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r); g.add(dot); }

  // Warm "golden hour" fill so the base reads even on Mars's shadowed side.
  const fill = new THREE.PointLight(0xffce96, 2.2, 9, 2); fill.position.set(0.0, 1.4, 0.3); g.add(fill);

  g.userData = { glowMats, flag };
  g.scale.setScalar(0.5);
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
  const geo = new THREE.SphereGeometry(mR, 96, 72, 0, TAU, 0, Math.PI * 0.42);   // cap around +Y
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
// Entry, Descent & Landing → Surface Operations. Durations sum to ~120s.
// Text/facts are short, informal prompts — meant to be narrated over live.
const PHASES = [
  {
    key: 'launch', label: '01 · LAUNCH', short: 'LAUNCH', dur: 84, mode: 'launch',
    tag: 'STAGE 01 · LAUNCH',
    // Progressive callouts, revealed in sync with the flight events (see LAUNCH_CALLOUTS).
    facts: [
      'Ignition — the engines light and build to full thrust before release.',
      'Liftoff. 3–4 g, three to four times your own weight.',
      '~9 minutes of burning to reach 28,000 km/h, then weightless in orbit.',
    ]
  },
  {
    key: 'cruise', label: '02 · CRUISE', short: 'CRUISE', dur: 140, mode: 'helio', s0: 0.03, s1: 0.78, view: 'endurance',
    tag: 'STAGE 02 · CRUISE',
    facts: [
      'dock with the interplanetary mothership. already placed.',
      'comfortable travel as the ring spins giving gravity from centrifugal force.',
      'frozen, dried food. all water, even urine, is recycled. game area.',
      '8-month coast.',
    ]
  },
  {
    key: 'approach', label: '03 · APPROACH', short: 'APPROACH', dur: 70, mode: 'helio', s0: 0.78, s1: 0.94, view: 'approach',
    tag: 'STAGE 03 · APPROACH',
    facts: [
      'Mars grows from a dot into a disc over the final weeks',
      'any communication to earth is gonna take about 15min to reach at this distance',
    ]
  },
  {
    key: 'edl', label: '04 · DESCENT & LANDING', short: 'DESCENT & LANDING', dur: 80, mode: 'edl', s0: 0.94, s1: 1.0,
    tag: 'STAGE 04 · DESCENT & LANDING',
    facts: [
      'shuttle undocks from the Mothership.',
      'just a smooth descent much easier than the take off because of low gravity.',
      'the weather at in the US Colony is maintained at a nice 18 celcius.'
    ]
  },
  {
    key: 'surface', label: '05 · SURFACE OPERATIONS', short: 'SURFACE OPS', dur: 45, mode: 'helio', s0: 1.0, s1: 1.0, view: 'surface',
    tag: 'STAGE 05 · SURFACE OPERATIONS',
    facts: [
      'journey would not be complete in 8.5 months and ~480 million km after launch.',
      'gravity is only 38% g, but after months of very low gravity, many can’t stand.',
      'please purchase the tickets from spacexyz.com'
    ]
  },
];
let _acc = 0;
PHASES.forEach(p => { p.t0 = _acc; _acc += p.dur; p.t1 = _acc; });
const TOTAL_DUR = _acc;

const voyage = {
  active: false, playing: false, t: 0, total: TOTAL_DUR, stage: 0, lastStage: -1,
  manualView: null, ship: null, rocket: null, ellipseFull: null, ellipseTrail: null,
  camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), camUp: new THREE.Vector3(0, 1, 0), camInit: false,
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
    const pos = ship.clone().addScaledVector(toMars, -1.6).addScaledVector(up, 0.9).addScaledVector(sideM, 2.6);
    return { pos, look: ship.clone().addScaledVector(toMars, 0.6), fov: 46 };
  }
  if (view === 'ring') { return { pos: ship.clone().addScaledVector(side, 2.3).addScaledVector(up, 0.85).addScaledVector(vel, 0.7), look: ship.clone() }; }
  if (view === 'endurance') {
    // Look mostly down the travel axis from ahead-and-above so the spinning ring
    // reads face-on, with the docked shuttle in the foreground and deep space behind.
    return { pos: ship.clone().addScaledVector(vel, 7.0).addScaledVector(up, 3.0).addScaledVector(side, 2.2), look: ship.clone().addScaledVector(vel, 1.0) };
  }
  if (view === 'dock') {
    // Close on the docking interface as the shuttle closes in on the Endurance's nose,
    // with a slow orbital drift so the shot breathes.
    const d = ship.clone().addScaledVector(vel, 1.3);
    const off = side.clone().multiplyScalar(3.0).applyAxisAngle(up, elapsed * 0.06);
    return { pos: d.clone().add(off).addScaledVector(up, 1.2).addScaledVector(vel, -1.2), look: d, fov: 40 };
  }
  if (view === 'coast') {
    // Look back down the track toward the Sun and the shrinking inner system — Earth a
    // blue point near the glare — with the Endurance silhouetted in the foreground.
    const out = ship.clone().normalize();                                  // Sun -> ship, pointing outward
    const off = side.clone().multiplyScalar(2.6).applyAxisAngle(up, elapsed * 0.04);
    return { pos: ship.clone().addScaledVector(out, 7.0).addScaledVector(up, 2.4).add(off), look: ship.clone(), fov: 42 };
  }
  if (view === 'chase') { return { pos: ship.clone().addScaledVector(vel, -10).addScaledVector(side, 2.2).addScaledVector(up, 4.5), look: ship.clone().addScaledVector(vel, 4) }; }
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
    const height = 0.8 + arc * 2.6;                                  // low → high survey → low
    const dist = 1.7 + (1 - arc) * 0.6;
    const radial = t1.clone().multiplyScalar(-dist).applyAxisAngle(BASE_N, ang);
    const pos = B.clone().addScaledVector(BASE_N, height).add(radial).addScaledVector(t2, 1.0 - arc * 0.5);
    const look = B.clone().addScaledVector(BASE_N, 0.16 + arc * 0.5).addScaledVector(t1, 0.15);
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
  voyage.rocket.visible = voyage.launchTrail.visible = true;
  if (voyage.groundSmoke) voyage.groundSmoke.visible = true;
  // No flat foreground field and no fade trick: the rocket sits on the real Earth globe and
  // the camera physically pulls back so the curvature is revealed by the zoom-out itself.
  if (voyage.earthGround) voyage.earthGround.visible = false;
  if (voyage.launchField) voyage.launchField.visible = false;
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
    rd.outer.material.opacity = 0.6 * (0.3 + 0.7 * atmP);
    rd.core.material.opacity = 0.95;
  } else {
    rd.flameGrp.position.y = 0.45;
    const s2 = clamp01((u - EV.ign2) / 0.1) * secoFade;   // second-stage spin-up, cut off at SECO
    rd.core.scale.set(flick * 0.5 * s2, (0.7 + (u - EV.ign2)) * flick * s2, flick * 0.5 * s2);
    rd.outer.scale.set(flick * 2.4 * s2, 0.9 * flick * s2, flick * 2.4 * s2);   // vacuum bell bloom
    rd.outer.material.opacity = 0.28 * s2;
    rd.core.material.opacity = 0.85 * s2;
  }
  rd.glow.visible = flameOn > 0.001;
  rd.glow.scale.setScalar((staged ? 0.8 : 1.6 * (0.6 + 0.4 * atmP)) + Math.sin(elapsed * 26) * 0.25);
  rd.light.intensity = flameOn * ((staged ? 1.0 : 1.5 * throttle) + Math.sin(elapsed * 40) * 0.4);

  // Max-Q condensation cone.
  if (voyage.vaporCone) {
    const q = Math.exp(-Math.pow((u - EV.maxQ) / 0.05, 2));
    voyage.vaporCone.visible = q > 0.02 && !staged;
    voyage.vaporCone.material.opacity = 0.8 * q;
    voyage.vaporCone.scale.setScalar(0.6 + 0.7 * q);
    voyage.vaporCone.position.copy(pos).addScaledVector(vel, 0.1);
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
        .addScaledVector(vel, fall * 0.8)
        .addScaledVector(LAUNCH_N, -(fall * fall) * 6.0)
        .addScaledVector(LAUNCH_T1, fall * 0.5);
      voyage.spentStage.quaternion.setFromUnitVectors(UP, LAUNCH_N);
      voyage.spentStage.rotateX(fall * 4.0); voyage.spentStage.rotateZ(fall * 2.2);
      if (voyage.boosterGlow) {
        // Entry-heating glow: flares as it bites into the air, then fades as it descends home.
        const heat = clamp01((fall - 0.18) / 0.16) * clamp01((0.82 - fall) / 0.25);
        voyage.boosterGlow.visible = heat > 0.02;
        voyage.boosterGlow.position.copy(voyage.spentStage.position).addScaledVector(LAUNCH_N, -0.08);
        voyage.boosterGlow.material.opacity = heat * 0.85;
        voyage.boosterGlow.scale.setScalar(0.4 + fall * 0.7);
      }
      if (voyage.frost) {
        const burst = clamp01((u - EV.sep) / 0.06);
        voyage.frost.visible = burst > 0 && burst < 1;
        voyage.frost.userData.parts.forEach(p => {
          p.position.copy(sepPos).addScaledVector(p.userData.dir, burst * p.userData.speed * 1.1);
          p.material.opacity = (1 - burst) * 0.7; p.scale.setScalar(p.userData.size * (1 + burst));
        });
      }
    } else {
      if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
      if (voyage.frost) voyage.frost.visible = false;
    }
  }

  // Exhaust/smoke: a dense column near the pad that lingers as the rocket climbs away.
  const rng = rngOf(u);
  const colTop = Math.min(alt + ROCKET_BASE, 3.2);
  const colFrac = colTop / Math.max(0.001, alt + ROCKET_BASE);
  const puffs = voyage.launchTrail.userData.puffs;
  puffs.forEach((sp, i) => {
    const f = i / (puffs.length - 1);
    sp.position.copy(PAD).addScaledVector(LAUNCH_N, colTop * f).addScaledVector(LAUNCH_T1, rng * colFrac * f);
    const heat = f * f;
    sp.material.color.setRGB(1, 0.55 + heat * 0.4, 0.42 + heat * 0.35);
    sp.material.opacity = (0.2 + (1 - f) * 0.5) * (0.5 + u * 0.5) * (staged ? 0.3 : 1) * clamp01(1.35 - alt * 0.55);
    sp.scale.setScalar(0.5 + (1 - f) * 1.2);
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
      .addScaledVector(LAUNCH_T1, Math.cos(d.ang) * spread)
      .addScaledVector(LAUNCH_T2, Math.sin(d.ang) * spread)
      .addScaledVector(LAUNCH_N, lift);
    const warm = clamp01(1 - life * 1.8) * clamp01(1 - lift * 0.7);  // engine glow only at the base, early
    sp.material.color.setRGB(0.62 + warm * 0.36, 0.6 + warm * 0.16, 0.58);  // smoke grey, warming to tan at the root
    sp.material.opacity = (0.5 - life * 0.3) * clamp01(1.3 - alt * 0.2);
    sp.scale.setScalar(d.size * (0.55 + life * 1.4));        // expands modestly as it ages
  });

  // Sky fades to space with the thinning atmosphere.
  if (voyage.launchSky) {
    voyage.launchSky.material.uniforms.uFade.value = clamp01(Math.pow(atmP, 0.6));
    voyage.launchSky.visible = atmP > 0.02;
  }

  // Camera: a broadcast-style sequence of beats, each timed to a flight event.
  const up = LAUNCH_N, side = LAUNCH_T2, fwd = LAUNCH_T1;
  const CRANE = 0.16;
  let camP, lookP, fov = 50;
  if (u < CRANE) {                             // continuous pull-back from the pad — the curvature is revealed
    const r = clamp01(u / CRANE);              // by the camera physically retreating, not a fade
    const ease = r * r * (3 - 2 * r);          // smoothstep the move
    const eye = 0.3 + ease * 3.4;              // rise from near eye-height to a high vantage above the pad
    const back = 2.0 + ease * 5.2;             // and steadily pull back so Earth's limb curves into frame
    camP = PAD.clone().addScaledVector(up, eye).addScaledVector(fwd, -back).addScaledVector(side, -2.0 - ease * 1.6);
    lookP = pos.clone().addScaledVector(up, 0.3 * (1 - ease));   // hold the rocket centred as we retreat
    fov = 50 - ease * 8;
  } else if (u < EV.maxQ) {                    // downrange tracking pedestal — rocket climbing against curved Earth
    camP = pos.clone().addScaledVector(side, 3.4).addScaledVector(up, 0.4).addScaledVector(fwd, -1.8);
    lookP = pos.clone().addScaledVector(vel, 1.0); fov = 40;
  } else if (u < EV.meco) {                    // long-lens chase through max-Q and the high climb
    camP = pos.clone().addScaledVector(side, 2.6).addScaledVector(up, 0.2).addScaledVector(fwd, -0.7);
    lookP = pos.clone().addScaledVector(up, 0.5); fov = 34;
  } else if (u < EV.ign2) {                    // MECO + staging: pull back so the booster is seen falling away
    camP = pos.clone().addScaledVector(side, 3.0).addScaledVector(up, 0.7).addScaledVector(fwd, -2.2);
    lookP = pos.clone().addScaledVector(up, -0.7); fov = 38;   // frame the gap between the stages
  } else if (u < EV.fairing) {                 // second-stage ignition: tight on the upper stage lighting
    camP = pos.clone().addScaledVector(side, 2.0).addScaledVector(up, 0.5).addScaledVector(fwd, -1.1);
    lookP = pos.clone().addScaledVector(up, -0.2); fov = 40;
  } else if (u < 0.72) {                       // fairing jettison: side-quarter angle to catch the halves splitting
    camP = pos.clone().addScaledVector(side, 1.8).addScaledVector(up, 0.7).addScaledVector(fwd, 0.7);
    lookP = pos.clone().addScaledVector(up, 0.1); fov = 44;
  } else if (u < EV.seco) {                    // ascent to orbit: the climbing stage high over Earth's curving limb
    camP = pos.clone().addScaledVector(side, 4.4).addScaledVector(up, 1.4).addScaledVector(fwd, -2.0);
    lookP = pos.clone().addScaledVector(up, -2.5).addScaledVector(fwd, -2.0); fov = 54;   // tilt down to Earth below
  } else {                                     // SECO / orbit: close on the now-coasting stage, sunlit, Earth behind
    camP = pos.clone().addScaledVector(side, 2.2).addScaledVector(up, 0.5).addScaledVector(fwd, -1.2);
    lookP = pos.clone().addScaledVector(up, -0.6).addScaledVector(fwd, -0.2); fov = 46;
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
  if (voyage.launchPad) voyage.launchPad.visible = false;
  if (voyage.launchSky) voyage.launchSky.visible = false;
  if (voyage.vaporCone) voyage.vaporCone.visible = false;
  if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.base) voyage.base.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  if (earthSats) earthSats.visible = true;
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  voyage.ship.visible = true;
  voyage.station.visible = true;                          // Endurance waits in orbit above
  if (voyage.marsSky) voyage.marsSky.visible = false;
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'mars');
  orbitPaths.forEach(o => { o.visible = false; });

  const s = 0.94 + u * 0.06;
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  const M = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(M);
  const mR = planetMeshes.mars.config.size;
  // Land AT the colony site (BASE_N) so Surface Ops opens on the just-landed shuttle.
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

  // Endurance parked in Mars orbit (ring still turning), where the shuttle undocked.
  voyage.station.position.copy(M).addScaledVector(dir, mR + 8.5).addScaledVector(tang, 2.6);
  voyage.station.quaternion.setFromUnitVectors(AXIS_Z, tang);
  voyage.station.userData.ring.rotation.z = elapsed * 0.5;

  // Descent profile: undock high → aero-brake → pitch up → retro-burn to a soft hover-slam.
  const dpos = (uu) => {
    const fall = Math.pow(clamp01((EDL.BURN - uu) / EDL.BURN), 1.3);
    const hover = Math.pow(clamp01((1 - uu) / (1 - EDL.BURN)), 2.0);
    const a = uu < EDL.BURN ? (7.0 * fall + 1.5) : (1.5 * hover);
    const lat = Math.pow(clamp01((EDL.PITCH - uu) / EDL.PITCH), 1.2) * 4.5;
    return M.clone().addScaledVector(dir, mR + a + 0.48).addScaledVector(tang, lat);
  };
  const pos = dpos(u);
  const alt = pos.distanceTo(M) - mR;
  const velDir = dpos(Math.min(1, u + 0.012)).sub(pos);
  if (velDir.lengthSq() < 1e-7) velDir.copy(dir).negate();
  velDir.normalize();
  voyage.ship.position.copy(pos);

  // Attitude: nose-forward glide → pitches upright (engine down) for the burn + landing.
  const qGlide = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, velDir);
  const qUp = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, dir);
  voyage.ship.quaternion.copy(qGlide).slerp(qUp, clamp01((u - EDL.PITCH + 0.06) / 0.18));

  const sd = voyage.ship.userData;
  const inEntry = u < EDL.AERO, landing = u >= EDL.BURN, touched = u > EDL.TOUCH;

  // Entry plasma glow + ionization trail (brief, high up).
  voyage.flash.visible = inEntry;
  if (inEntry) {
    const heat = clamp01(1 - Math.abs(u - 0.24) / 0.14);   // plasma peaks after undock, fades before aerobrake
    voyage.flash.position.copy(pos).addScaledVector(velDir, 0.35);   // glow just ahead of the heat shield
    voyage.flash.material.opacity = heat * 0.55;
    voyage.flash.scale.setScalar(0.5 + heat * 0.9);
    sd.trail.material.color.setHex(0xff7a32); sd.trail.material.opacity = heat * 0.6;
    sd.trail.scale.set(0.9 + heat * 0.6, 1.8 + heat * 1.8, 1);
  }

  // Retro/landing burn: a tight bright collimated column, cut the instant legs settle.
  sd.plume.visible = landing && !touched;
  if (sd.plume.visible) {
    const thr = 0.6 + clamp01((u - EDL.BURN) / (1 - EDL.BURN)) * 0.7;
    const f = 1 + Math.sin(elapsed * 44) * 0.1;
    sd.plume.scale.set(0.85, thr * f, 0.85);
    sd.trail.material.color.setHex(0x6cc8ff); sd.trail.material.opacity = 0.9; sd.trail.scale.setScalar(2.2);
  } else if (!inEntry) { sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001); }
  sd.legs.visible = u > 0.6;

  // Dust + a few lofted debris kicked up by the burn near touchdown; settles after.
  if (voyage.dust) {
    const active = (landing && alt < 2.4) || (touched && u < 0.998);
    voyage.dust.visible = active;
    if (active) {
      // Builds as the retro plume nears the ground, peaks at touchdown, then hangs
      // and slowly settles — a reddish Mars dust wall blown out flat across the pad.
      const settle = touched ? clamp01((0.998 - u) / 0.05) : 1;
      const amp = touched ? settle : clamp01((2.4 - alt) / 2.2);
      voyage.dust.position.copy(M).addScaledVector(dir, mR + 0.04);
      voyage.dust.quaternion.setFromUnitVectors(UP, dir);
      voyage.dust.userData.parts.forEach((p, i) => {
        const debris = (i % 7 === 0);
        const reach = amp * p.userData.speed * (debris ? 1.8 : 1.5);
        const lift = debris ? 0.5 : 0.16;                       // billows wide and flat, hugging the ground
        p.position.set(p.userData.dir.x * reach, Math.abs(p.userData.dir.y) * reach * lift, p.userData.dir.z * reach);
        p.material.opacity = amp * (debris ? 0.65 : 0.6) * (1 - amp * 0.2);
        p.scale.setScalar(p.userData.size * (debris ? 0.7 : 1.3) * (1 + reach * 0.9));
      });
    }
  }

  // Telemetry handoff (read in updateTelemetry).
  voyage.edlAlt = alt;
  voyage.edlPhase = u < EDL.ENTRY ? 'ENTRY INTERFACE' : u < EDL.AERO ? 'PLASMA / AEROBRAKE'
    : u < EDL.BURN ? 'PITCH-UP' : u < EDL.TOUCH ? 'RETRO BURN' : 'TOUCHDOWN';

  // Camera: undock → high entry shot → tracking the descent → low ground-level burn + landing.
  let camP, lookP, fov;
  if (u < 0.12) {                              // undock: the shuttle drops away from the Endurance, Mars below
    camP = pos.clone().addScaledVector(cross, 4.6).addScaledVector(dir, 0.6).addScaledVector(tang, 0.6);
    lookP = pos.clone().addScaledVector(tang, -0.6).addScaledVector(dir, -1.1); fov = 52;   // craft centred, Mars below
  } else if (u < EDL.AERO) {
    camP = pos.clone().addScaledVector(cross, 3.0).addScaledVector(dir, 1.4).addScaledVector(tang, 2.0);
    lookP = pos.clone().addScaledVector(velDir, 1.4); fov = 50;
  } else if (u < EDL.BURN + 0.05) {
    camP = pos.clone().addScaledVector(cross, 2.2).addScaledVector(dir, 0.6).addScaledVector(tang, 1.1);
    lookP = pos.clone().addScaledVector(dir, -0.1); fov = 44;
  } else {
    camP = pos.clone().addScaledVector(cross, 1.9).addScaledVector(dir, 0.5).addScaledVector(tang, 0.8);
    lookP = pos.clone().addScaledVector(dir, -0.15); fov = 40;
  }
  return { pos: camP, look: lookP, fov, up: dir };
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
  if (voyage.earthGround) voyage.earthGround.visible = false;
  if (voyage.launchField) voyage.launchField.visible = false;
  if (voyage.launchPad) voyage.launchPad.visible = false;
  if (voyage.launchSky) voyage.launchSky.visible = false;
  if (voyage.vaporCone) voyage.vaporCone.visible = false;
  if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
  if (earthSats) earthSats.visible = true;
  const isSurface = ph.key === 'surface';
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = !isSurface;
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = true;
  orbitPaths.forEach(o => { o.visible = !isSurface; });   // hide orbit rings on the Mars close-up

  const s = ph.s0 + u * (ph.s1 - ph.s0);
  const st = transferState(s);
  const fwd = transferState(Math.min(1, s + 0.004)).pos.clone().sub(st.pos).normalize();
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);

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
    const docked = st.pos.clone().addScaledVector(fwd, 1.5);
    if (ph.key === 'cruise') {
      const dockT = clamp01(u / 0.10);
      const appr = Math.pow(1 - dockT, 1.4);              // 1 = approaching, 0 = docked
      const side = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      voyage.ship.position.copy(docked)
        .addScaledVector(fwd, -appr * 5.0)
        .addScaledVector(UP, -appr * 2.8)
        .addScaledVector(side, appr * 1.6);
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
    voyage.ship.visible = false;
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
      // Living base: gently pulse the window glow + flutter the flag.
      const b = voyage.base.userData, pulse = 1.15 + Math.sin(elapsed * 1.6) * 0.2;
      if (b.glowMats) b.glowMats.forEach(m => { m.emissiveIntensity = pulse; });
      if (b.flag) b.flag.rotation.z = Math.sin(elapsed * 2.0) * 0.16;
      if (voyage.marsSky) {
        voyage.marsSky.position.copy(Mw);
        voyage.marsSky.material.uniforms.uSun.value.copy(Mw).multiplyScalar(-1).normalize();   // sun direction from the colony
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
    voyage._lastCallout = -1;   // force the launch flight-log to rebuild on (re)entry
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
    // Progressive flight log: reveal callouts as each event passes, newest highlighted.
    let ci = 0; for (let i = 0; i < LAUNCH_CALLOUTS.length; i++) if (u >= LAUNCH_CALLOUTS[i].at) ci = i;
    if (ci !== voyage._lastCallout) {
      voyage._lastCallout = ci;
      const start = Math.max(0, ci - 3);
      vEls['v-notes'].innerHTML = LAUNCH_CALLOUTS.slice(start, ci + 1).map((c, k) => {
        const cur = (start + k) === ci;
        return `<div class="note"${cur ? ' style="opacity:1"' : ' style="opacity:0.5"'}>› <b>${c.tag}.</b> ${c.text}</div>`;
      }).join('');
    }
  } else if (ph.mode === 'edl') {
    const a = voyage.edlAlt ?? 8;
    vEls['v-elapsed'].textContent = `ALT ${Math.max(0, Math.round((a - 0.48) / 8.5 * 120))} KM`;
    vEls['v-vel'].textContent = `${Math.max(0, (a - 0.48) / 8.5 * 4.6 + (u < EDL.AERO ? 1.0 : 0)).toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = voyage.edlPhase || 'DESCENT';
    const retro = u >= EDL.BURN && u <= EDL.TOUCH, plasma = u >= EDL.ENTRY && u < EDL.AERO;
    vEls['v-engine'].textContent = u > EDL.TOUCH ? '○ DOWN' : retro ? '● RETRO' : plasma ? '▲ PLASMA'
      : u < EDL.ENTRY ? '○ FREE-FALL' : '○ AEROBRAKE';
    vEls['v-engine'].className = (retro || plasma) ? 'warn' : '';
    // Progressive descent flight-log: reveal callouts as each EDL phase passes.
    let ci = 0; for (let i = 0; i < EDL_CALLOUTS.length; i++) if (u >= EDL_CALLOUTS[i].at) ci = i;
    if (ci !== voyage._lastCallout) {
      voyage._lastCallout = ci;
      const start = Math.max(0, ci - 3);
      vEls['v-notes'].innerHTML = EDL_CALLOUTS.slice(start, ci + 1).map((c, k) => {
        const cur = (start + k) === ci;
        return `<div class="note"${cur ? ' style="opacity:1"' : ' style="opacity:0.5"'}>› <b>${c.tag}.</b> ${c.text}</div>`;
      }).join('');
    }
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
    // Progressive flight-log for the coast, approach and surface tour.
    const callouts = ph.key === 'cruise' ? CRUISE_CALLOUTS : ph.key === 'approach' ? APPROACH_CALLOUTS
      : ph.key === 'surface' ? SURFACE_CALLOUTS : null;
    if (callouts) {
      let ci = 0; for (let i = 0; i < callouts.length; i++) if (u >= callouts[i].at) ci = i;
      if (ci !== voyage._lastCallout) {
        voyage._lastCallout = ci;
        const start = Math.max(0, ci - 3);
        vEls['v-notes'].innerHTML = callouts.slice(start, ci + 1).map((c, k) => {
          const cur = (start + k) === ci;
          return `<div class="note"${cur ? ' style="opacity:1"' : ' style="opacity:0.5"'}>› <b>${c.tag}.</b> ${c.text}</div>`;
        }).join('');
      }
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
    // Cruise plays as a sequence of beats over the eight-month coast: docking, ring
    // life, the trans-Mars departure, the deep-space coast, then the Kepler map.
    let view = ph.view;
    if (ph.key === 'cruise') {
      view = u < 0.16 ? 'dock' : u < 0.38 ? 'endurance' : u < 0.60 ? 'chase' : u < 0.82 ? 'coast' : 'map';
    }
    if (ph.key === 'approach') view = u < 0.82 ? 'approach' : 'arrival';
    cam = viewTarget(view, st, s, u);
  }
  // Aim the directional sun + shadow frustum at the current subject each frame so the
  // craft are lit from the same direction as the planet shaders (sun at the origin).
  let _subj = null, _srad = 5;
  if (ph.mode === 'launch') { _subj = voyage.rocket.position; _srad = 3.5; }
  else if (ph.mode === 'edl') { _subj = voyage.ship.position; _srad = 4; }
  else if (ph.key === 'surface') { _subj = voyage.base.position; _srad = 5; }
  else if (voyage.station && voyage.station.visible) { _subj = voyage.station.position; _srad = 4; }
  if (_subj) frameSunShadow(_subj, _srad);

  // Per-stage focal length (stages may return a `fov`): snap on seek, ease while playing.
  const targetFov = cam.fov || 55;
  const targetUp = cam.up || UP;   // local "up" so launch/surface read level instead of tilted
  if (!voyage.camInit) { voyage.camPos.copy(cam.pos); voyage.camLook.copy(cam.look); voyage.camUp.copy(targetUp); voyage.camInit = true; camera.fov = targetFov; camera.updateProjectionMatrix(); }
  else if (Math.abs(camera.fov - targetFov) > 0.01) { camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
  const k = 1 - Math.exp(-dt * 2.4);
  voyage.camPos.lerp(cam.pos, k);
  voyage.camLook.lerp(cam.look, k);
  voyage.camUp.lerp(targetUp, k);
  if (voyage.camUp.lengthSq() > 1e-6) voyage.camUp.normalize();
  camera.position.copy(voyage.camPos);
  camera.up.copy(voyage.camUp);
  // Cinematic shake: liftoff rumble + max-Q buffet + touchdown jolt. Applied here,
  // after the position smoothing, so the high-frequency vibration isn't damped away.
  const shakeAmp = stageShake(ph, u);
  if (shakeAmp > 1e-4) {
    const tt = voyage.t;
    _shFwd.subVectors(voyage.camLook, voyage.camPos).normalize();
    _shRight.crossVectors(_shFwd, voyage.camUp).normalize();
    _shUp.crossVectors(_shRight, _shFwd).normalize();
    const jx = (Math.sin(tt * 47.0) + 0.7 * Math.sin(tt * 31.3 + 1.1)) * shakeAmp;
    const jy = (Math.sin(tt * 43.0 + 1.3) + 0.7 * Math.sin(tt * 27.7 + 0.6)) * shakeAmp;
    camera.position.addScaledVector(_shRight, jx).addScaledVector(_shUp, jy);
    _shLook.copy(voyage.camLook).addScaledVector(_shRight, -jx * 0.4).addScaledVector(_shUp, -jy * 0.4);
    camera.lookAt(_shLook);
  } else {
    camera.lookAt(voyage.camLook);
  }
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
    voyage.frost = buildParticles(26, 0xdff0ff, true, 0.05, 0.17);   // ice/gas at staging
    scene.add(voyage.frost);
    voyage.dust = buildParticles(40, 0xc98f63, false, 0.18, 0.5);    // dust at touchdown
    scene.add(voyage.dust);
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
    if (voyage.launchPad) voyage.launchPad.visible = false;
    if (voyage.launchSky) voyage.launchSky.visible = false;
    if (voyage.vaporCone) voyage.vaporCone.visible = false;
    if (voyage.boosterGlow) voyage.boosterGlow.visible = false;
    if (voyage.spentStage) voyage.spentStage.visible = false;
    if (voyage.station) voyage.station.visible = false;
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
