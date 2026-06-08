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
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.72, 1.0);
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
      float n1 = fbm(p + vec3(uTime * 0.06));
      float n2 = ridged(p * 1.5 - vec3(uTime * 0.05));
      float s = mix(n1, n2, 0.5);
      vec3 col = mix(vec3(0.85, 0.18, 0.02), vec3(1.0, 0.55, 0.12), smoothstep(0.25, 0.6, s));
      col = mix(col, vec3(1.0, 0.95, 0.72), smoothstep(0.55, 0.95, s * s));
      float mu = clamp(vNormal.z, 0.0, 1.0);                 // view-space normal → limb
      col *= (0.55 + 0.45 * pow(mu, 0.6)) * 2.6;             // hot center, dim limb, HDR core for bloom
      gl_FragColor = vec4(col, 1.0);
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
const envRT = pmrem.fromScene(buildSpaceEnvScene(), 0.25, 0.1, 100);   // soft (sigma 0.25) stylized IBL
scene.environment = envRT.texture;     // IBL only — do NOT dispose envRT (backs scene.environment)
pmrem.dispose();

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
const sunLight = new THREE.PointLight(0xffd9a8, 1.5, 0, 1.2);
scene.add(sunLight);

// Directional "sun" key with soft shadows. Re-aimed each voyage frame from the sun
// (origin) toward the current subject so craft are lit consistently with the planets.
const sunKey = new THREE.DirectionalLight(0xfff1dc, 2.6);
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
const rimLight = new THREE.DirectionalLight(0x88b4ff, 0.5);
rimLight.position.copy(SUN_DIR).multiplyScalar(-180); rimLight.position.y += 60;
scene.add(rimLight); scene.add(rimLight.target);
scene.add(new THREE.HemisphereLight(0x223a5e, 0x05060a, 0.35));

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
function makeEarthMaterial() { return makePlanetMaterial({ base: 0x1d6dc8, accent: 0x2a8e54, polar: 0xf2f7ff, scale: 4.0, variant: 'earth' }); }
function makeMarsMaterial() { return makePlanetMaterial({ base: 0xc44a26, accent: 0x6a2412, polar: 0xf6e0c0, scale: 3.6, ridges: true, variant: 'mars' }); }

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
    variant: p.key === 'earth' ? 'earth' : (p.key === 'mars' ? 'mars' : null),
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 64, 64), mat);
  tiltGroup.add(mesh);

  // Atmosphere for select planets — bright at silhouette, near-transparent at center
  if (p.key === 'earth') tiltGroup.add(makeAtmosphere(p.size * 1.12, 0x4ab8ff, 1.6));
  if (p.key === 'venus') tiltGroup.add(makeAtmosphere(p.size * 1.16, 0xffd49a, 1.4));
  if (p.key === 'mars') tiltGroup.add(makeAtmosphere(p.size * 1.09, 0xff8a4a, 0.9));
  if (p.key === 'jupiter') tiltGroup.add(makeAtmosphere(p.size * 1.05, 0xffd0a0, 0.6));
  if (p.key === 'saturn') tiltGroup.add(makeAtmosphere(p.size * 1.04, 0xc8b48a, 0.35));
  if (p.key === 'uranus') tiltGroup.add(makeAtmosphere(p.size * 1.10, 0xa0eef0, 0.9));
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

// Crew shuttle (Ranger-style): a slim winged craft that rides up inside the rocket,
// docks to the Endurance for the cruise, then undocks and lands on Mars. Nose +Z.
function buildLiner() {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xc8d2de, metalness: 0.85, roughness: 0.35, emissive: 0x22343f, emissiveIntensity: 0.5 });
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
  const hull = new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 0.7, roughness: 0.4, emissive: 0x2a3340, emissiveIntensity: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a424e, metalness: 0.7, roughness: 0.5 });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x6ff1ff });

  const ringR = 3.0;
  const ringGrp = new THREE.Group();
  // structural ring (torus in XY, normal +Z)
  ringGrp.add(new THREE.Mesh(new THREE.TorusGeometry(ringR, 0.09, 10, 60), dark));
  // 12 habitat modules around the ring, with glowing windows facing +Z
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const mod = new THREE.Group();
    mod.add(new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.62, 0.6), i % 2 ? hull : dark));
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.14, 0.02), i % 3 ? warm : cyan);
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
  g.scale.setScalar(0.16);
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
  g.scale.setScalar(0.16);
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
  { key: 'cruise', label: '02 · CRUISE', short: 'CRUISE', dur: 48, mode: 'helio', s0: 0.03, s1: 0.78, view: 'endurance',
    tag: 'STAGE 02 · CRUISE',
    law: 'NEWTON I + KEPLER · coasting on an ellipse',
    facts: [
      'Dock with the Endurance — a giant ring station that carries you to Mars.',
      'The whole ring spins (~2 rpm); centrifugal force becomes your gravity (a = ω²r).',
      'Then engines off — an 8-month coast on an ellipse, floating between worlds.',
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
  { key: 'edl', label: '04 · DESCENT & LANDING', short: 'DESCENT & LANDING', dur: 20, mode: 'edl', s0: 0.94, s1: 1.0,
    tag: 'STAGE 04 · DESCENT & LANDING',
    law: 'NEWTON · powered descent',
    facts: [
      'The shuttle undocks from the Endurance and drops toward Mars.',
      'Future tech: no parachutes — a smooth, computer-flown powered descent.',
      'Engines throttle to a gentle hover and set you down softly on the legs.',
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
  if (view === 'endurance') {
    // Look mostly down the travel axis from ahead-and-above so the spinning ring
    // reads face-on, with the docked shuttle in the foreground and deep space behind.
    return { pos: ship.clone().addScaledVector(vel, 7.0).addScaledVector(up, 3.0).addScaledVector(side, 2.2), look: ship.clone().addScaledVector(vel, 1.0) };
  }
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
  if (voyage.station) voyage.station.visible = false;
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
    sp.scale.setScalar(0.28 + (1 - f) * 0.85);     // older puffs spread out
  });

  // Camera: a clean 3/4 from above the limb (not looking up from below), tracking the
  // rocket up; at staging, pull back to frame the upper stage and the falling booster.
  let off, lookPt;
  if (staged) {
    off = new THREE.Vector3(-3.4, 1.8, -3.8);
    lookPt = rp.clone().lerp(voyage.spentStage.position, 0.4);
  } else {
    off = new THREE.Vector3(-2.4, 0.8 + u * 3.4, -2.7 - u * 0.8);
    lookPt = rp.clone().add(new THREE.Vector3(0, 0.4, 0));
  }
  return { pos: rp.clone().add(off), look: lookPt };
}

// Descent & Landing — futuristic + easy: the shuttle undocks from the Endurance
// (parked in Mars orbit) and flies a smooth, controlled powered descent to a soft
// touchdown — no parachutes, no fiery "7 minutes of terror".
function updateEDL(u) {
  voyage.rocket.visible = voyage.launchTrail.visible = false;
  voyage.lander.visible = false;
  voyage.ellipseFull.visible = voyage.ellipseTrail.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.base) voyage.base.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  voyage.ship.visible = true;
  voyage.station.visible = true;                          // Endurance waits in orbit above
  for (const key in planetMeshes) planetMeshes[key].tiltGroup.visible = (key === 'mars');
  orbitPaths.forEach(o => { o.visible = false; });

  const s = 0.94 + u * 0.06;
  planetMeshes.mars.orbitGroup.rotation.y = -(MARS_START + s * MARS_SWEEP);
  const M = new THREE.Vector3(); planetMeshes.mars.tiltGroup.getWorldPosition(M);
  const mR = planetMeshes.mars.config.size;
  const dir = new THREE.Vector3(0.42, 0.74, 0.52).normalize();          // local "up" at the landing site
  const tang = new THREE.Vector3().crossVectors(dir, UP).normalize();   // downrange axis
  const cross = new THREE.Vector3().crossVectors(dir, tang).normalize();

  // Endurance parked in Mars orbit (ring still turning), where the shuttle undocked.
  voyage.station.position.copy(M).addScaledVector(dir, mR + 8.5).addScaledVector(tang, 2.6);
  voyage.station.quaternion.setFromUnitVectors(AXIS_Z, tang);
  voyage.station.userData.ring.rotation.z = elapsed * 0.5;

  // Shuttle: a smooth arc from just below the station down to a gentle touchdown.
  const dpos = (uu) => {
    const a = Math.pow(clamp01(1 - uu), 1.3) * 6.5 + 0.48;   // min alt: shuttle rests on its legs, not buried
    const lat = Math.pow(clamp01((0.8 - uu) / 0.8), 1.2) * 4.0;
    return M.clone().addScaledVector(dir, mR + a).addScaledVector(tang, lat);
  };
  const pos = dpos(u);
  const alt = pos.distanceTo(M) - mR;
  const velDir = dpos(Math.min(1, u + 0.012)).sub(pos);
  if (velDir.lengthSq() < 1e-7) velDir.copy(dir).negate();
  velDir.normalize();
  voyage.ship.position.copy(pos);

  // Attitude: a nose-forward glide that smoothly pitches upright (engine down) to land.
  const qGlide = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, velDir);
  const qUp = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, dir);   // nose up, engine (−Z) toward Mars
  voyage.ship.quaternion.copy(qGlide).slerp(qUp, clamp01((u - 0.35) / 0.3));

  const sd = voyage.ship.userData;
  const landing = u >= 0.55, touched = u > 0.96;
  // Braking plume: lights for the powered descent, throttles to a gentle hover, then
  // cuts off the instant the legs settle on the surface.
  sd.plume.visible = landing && !touched;
  if (landing && !touched) {
    const thr = 0.5 + clamp01((u - 0.55) / 0.38) * 0.7;
    sd.plume.scale.set(1, thr + Math.sin(elapsed * 40) * 0.12, 1);
    sd.trail.material.opacity = 0.85; sd.trail.scale.setScalar(2.0);
  } else { sd.trail.material.opacity = 0; sd.trail.scale.setScalar(0.001); }
  sd.legs.visible = u > 0.6;

  // Soft entry shimmer (futuristic heat shielding) — a gentle glow, not a fireball.
  voyage.flash.visible = u < 0.34;
  if (voyage.flash.visible) {
    const gi = clamp01(1 - Math.abs(u - 0.14) / 0.18);
    voyage.flash.position.copy(pos).addScaledVector(velDir, 0.5);
    voyage.flash.material.opacity = gi * 0.5;
    voyage.flash.scale.setScalar(1.2 + gi * 1.4);
  }

  // Light dust as it settles (gentle, not a big kick-up).
  if (voyage.dust) {
    const near = landing && alt < 1.2;
    voyage.dust.visible = near;
    if (near) {
      const d = clamp01((1.2 - alt) / 1.0);
      voyage.dust.position.copy(M).addScaledVector(dir, mR + 0.05);
      voyage.dust.quaternion.setFromUnitVectors(UP, dir);
      voyage.dust.userData.parts.forEach(p => {
        const reach = d * p.userData.speed * 0.8;
        p.position.set(p.userData.dir.x * reach, Math.abs(p.userData.dir.y) * reach * 0.15, p.userData.dir.z * reach);
        p.material.opacity = d * (1 - d * 0.4) * 0.35;
        p.scale.setScalar(p.userData.size * (1 + reach));
      });
    }
  }

  // Camera: 3/4 following the shuttle down, Mars below and the Endurance above early on.
  let camP, lookP;
  if (u < 0.4) { camP = pos.clone().addScaledVector(cross, 4.2).addScaledVector(dir, 1.4).addScaledVector(tang, 1.7); lookP = pos.clone().addScaledVector(velDir, 1.0); }
  else         { camP = pos.clone().addScaledVector(cross, 2.8).addScaledVector(dir, 1.0).addScaledVector(tang, 0.7); lookP = pos.clone().addScaledVector(dir, -0.4); }
  return { pos: camP, look: lookP };
}

function updateHelio(ph, u, dt) {
  voyage.rocket.visible = false;
  voyage.lander.visible = false;
  voyage.launchTrail.visible = false;
  voyage.flash.visible = false;
  if (voyage.spentStage) voyage.spentStage.visible = false;
  if (voyage.frost) voyage.frost.visible = false;
  if (voyage.dust) voyage.dust.visible = false;
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
      const dockT = clamp01(u / 0.24);
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
      voyage.base.position.copy(Mw).addScaledVector(BASE_N, planetMeshes.mars.config.size);
      voyage.base.quaternion.setFromUnitVectors(UP, BASE_N);
      voyage.base.visible = true;
    } else voyage.base.visible = false;
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
    vEls['v-elapsed'].textContent = `ALT ${Math.max(0, Math.round(Math.pow(1 - u, 1.3) * 110))} KM`;
    vEls['v-vel'].textContent = `${(Math.pow(1 - u, 1.4) * 3.4 + 0.04).toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = u < 0.2 ? 'UNDOCK' : (u < 0.55 ? 'GLIDE' : (u > 0.96 ? 'TOUCHDOWN' : 'POWERED LANDING'));
    const retro = u >= 0.55 && u <= 0.96;
    vEls['v-engine'].textContent = u > 0.96 ? '○ DOWN' : (retro ? '● RETRO' : '○ GLIDE');
    vEls['v-engine'].className = retro ? 'warn' : '';
  } else {
    const st = voyageStats(s);
    vEls['v-elapsed'].textContent = `DAY ${Math.round(st.day)} / 259`;
    vEls['v-vel'].textContent = `${st.v.toFixed(1)} KM/S`;
    vEls['v-dist'].textContent = `${st.rAU.toFixed(2)} AU`;
    // Cruise opens with the docking maneuver, then engines-off coast on the ellipse.
    let eng = '○ OFF', warn = false;
    if (ph.key === 'cruise' && u < 0.24) { eng = '◐ DOCKING'; warn = true; }
    else if (ph.burn) { eng = '● BURN'; warn = true; }
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
    if (ph.key === 'cruise') view = 'endurance';
    cam = viewTarget(view, st, s);
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
  if (!voyage.camInit) { voyage.camPos.copy(cam.pos); voyage.camLook.copy(cam.look); voyage.camInit = true; camera.fov = targetFov; camera.updateProjectionMatrix(); }
  else if (Math.abs(camera.fov - targetFov) > 0.01) { camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
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
    voyage.station = buildEndurance();          // the Endurance ring station
    voyage.station.visible = false;
    scene.add(voyage.station);
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
    if (voyage.station) voyage.station.visible = false;
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
