import * as THREE from 'three';
import { World, CH_Y } from './world.js';
import { Terrain } from './terrain.js';
import { Vehicle } from './vehicle.js';
import { buildCar } from './carmodel.js';
import { Input } from './input.js';
import { B, BLOCKS, buildAtlasCanvas, TILE, ATLAS_COLS } from './blocks.js';

const VIEW_DISTANCE = 8;          // chunks
const REACH = 26;                 // blocks, measured from the camera
const HOTBAR = [B.ASPHALT, B.LINE, B.CONCRETE, B.PLANKS, B.BRICK, B.STONE, B.CHECKER, B.LAMP];

// ---------------------------------------------------------------- renderer

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY_LOW = 0xc7dcf2;
scene.fog = new THREE.Fog(SKY_LOW, 70, VIEW_DISTANCE * 16 - 16);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- sky + light

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3f7fd0) },
      bottom: { value: new THREE.Color(SKY_LOW) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.02, 0.55, h)), 1.0);
      }`,
  }),
);
sky.scale.setScalar(900);
sky.frustumCulled = false;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xbcd8f5, 0x5a5347, 1.05));

const sun = new THREE.DirectionalLight(0xfff2dd, 1.75);
const SUN_DIR = new THREE.Vector3(0.42, 0.76, 0.5).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42;
sun.shadow.camera.bottom = -42;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- world

const world = new World();
const terrain = new Terrain(world, scene, VIEW_DISTANCE);
const vehicle = new Vehicle(world);
const car = buildCar();
car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
scene.add(car.group);

const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, fog: false }),
);
highlight.visible = false;
scene.add(highlight);

function spawn() {
  // x = 0 is a road centre line, so we always start on tarmac
  const x = 0.5;
  const z = 8.5;
  const y = world.surfaceY(x, z) + 1.4;
  vehicle.reset(x, y, z, 0);
}

// ---------------------------------------------------------------- HUD

const hud = document.getElementById('hud');
const startPanel = document.getElementById('start');
const playBtn = document.getElementById('play');
const loadingText = document.getElementById('loading');
const elSpeed = document.getElementById('speed');
const elGear = document.getElementById('gear');
const elCoords = document.getElementById('coords');
const elFps = document.getElementById('fps');
const elToast = document.getElementById('toast');

let slot = 0;
let toastTimer = 0;

function toast(msg) {
  elToast.textContent = msg;
  elToast.classList.add('show');
  toastTimer = 1.4;
}

function buildHotbar() {
  const atlas = buildAtlasCanvas();
  const bar = document.getElementById('hotbar');
  HOTBAR.forEach((block, i) => {
    const el = document.createElement('div');
    el.className = 'slot';
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    const tile = BLOCKS[block].tiles[0];
    c.getContext('2d').drawImage(
      atlas,
      (tile % ATLAS_COLS) * TILE, Math.floor(tile / ATLAS_COLS) * TILE, TILE, TILE,
      0, 0, TILE, TILE,
    );
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    el.append(c, num);
    bar.appendChild(el);
  });
  return [...bar.children];
}

const slots = buildHotbar();
function selectSlot(i) {
  slot = ((i % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
  slots.forEach((el, n) => el.classList.toggle('on', n === slot));
  toast(BLOCKS[HOTBAR[slot]].name);
}
selectSlot(0);
elToast.classList.remove('show');

// ---------------------------------------------------------------- camera rig

const input = new Input(renderer.domElement);
let camYaw = 0;      // offset from the car's heading
let camPitch = 0.20;
let sinceLook = 99;
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

function updateCamera(dt) {
  const fwd = vehicle.forward(tmp);
  const heading = Math.atan2(fwd.x, fwd.z);

  // ease the look offset back behind the car once you're moving and idle
  if (sinceLook > 1.1 && Math.abs(vehicle.speed) > 4) {
    const k = 1 - Math.exp(-2.2 * dt);
    camYaw *= 1 - k;
    camPitch += (0.20 - camPitch) * k;
  }

  const yaw = heading + camYaw;
  const cp = Math.cos(camPitch);
  const sp = Math.sin(camPitch);

  const speed = Math.abs(vehicle.speed);
  const dist = 7.4 + Math.min(speed / 16, 2.4);

  camTarget.copy(vehicle.pos).addScaledVector(vehicle.forward(tmp2), 1.2);
  camTarget.y += 1.15;

  // spherical offset: behind the car, raised by pitch
  tmp.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);
  camPos.copy(camTarget).addScaledVector(tmp, dist);

  // don't let the camera end up inside a hill
  const dir = tmp2.copy(camPos).sub(camTarget);
  const len = dir.length();
  dir.divideScalar(len);
  const hit = world.raycast(camTarget.x, camTarget.y, camTarget.z, dir.x, dir.y, dir.z, len);
  if (hit) camPos.copy(camTarget).addScaledVector(dir, Math.max(1.2, hit.dist - 0.35));

  const lerp = 1 - Math.exp(-14 * dt);
  camera.position.lerp(camPos, lerp);

  // crash shake
  if (vehicle.impact > 0.01) {
    const a = vehicle.impact * 0.28;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }

  camera.lookAt(camTarget);

  const targetFov = 70 + Math.min(speed / 3.2, 16);
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt));
    camera.updateProjectionMatrix();
  }

  sky.position.copy(camera.position);
}

// ---------------------------------------------------------------- block editing

let digCooldown = 0;
let placeCooldown = 0;

function aim() {
  camera.getWorldDirection(tmp);
  return world.raycast(
    camera.position.x, camera.position.y, camera.position.z,
    tmp.x, tmp.y, tmp.z, REACH,
  );
}

const invCarQuat = new THREE.Quaternion();
function insideCar(x, y, z) {
  invCarQuat.copy(vehicle.quat).invert();
  tmp.set(x + 0.5, y + 0.5, z + 0.5).sub(vehicle.pos).applyQuaternion(invCarQuat);
  return Math.abs(tmp.x) < 1.35 && Math.abs(tmp.y) < 0.95 && Math.abs(tmp.z) < 2.35;
}

function editBlocks(dt, ev) {
  digCooldown -= dt;
  placeCooldown -= dt;

  const hit = aim();
  if (hit) {
    highlight.visible = true;
    highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  } else {
    highlight.visible = false;
  }
  if (!hit) return;

  if ((ev.click[0] || input.held[0]) && digCooldown <= 0) {
    world.setBlock(hit.x, hit.y, hit.z, B.AIR);
    digCooldown = 0.07;
  }

  if ((ev.click[2] || input.held[2]) && placeCooldown <= 0) {
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (y >= 0 && y < CH_Y && !world.isSolid(x, y, z) && !insideCar(x, y, z)) {
      world.setBlock(x, y, z, HOTBAR[slot]);
      placeCooldown = 0.09;
    }
  }
}

// ---------------------------------------------------------------- car visuals

const wheelTmp = new THREE.Vector3();

function updateCarMesh() {
  car.group.position.copy(vehicle.pos);
  car.group.quaternion.copy(vehicle.quat);

  vehicle.wheels.forEach((w, i) => {
    const { pivot, wheel } = car.pivots[i];
    const drop = Math.min(w.suspensionLength, 0.6);
    wheelTmp.copy(w.local);
    wheelTmp.y -= drop;
    pivot.position.copy(wheelTmp);
    pivot.rotation.y = w.steering ? -vehicle.steer : 0;
    wheel.rotation.x = w.spin;
  });
}

// ---------------------------------------------------------------- loop

let running = false;
let last = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;
let hudTimer = 0;

function frame(now) {
  // dev hook: inspect live state from the console
window.__dbg = {
  vehicle, world, terrain, input,
  state: () => ({
    running,
    pos: vehicle.pos.toArray().map((n) => +n.toFixed(2)),
    vel: vehicle.vel.toArray().map((n) => +n.toFixed(2)),
    grounded: vehicle.groundedCount,
    locked: input.locked,
    wheels: vehicle.wheels.map((w) => ({ g: w.grounded, c: +w.compression.toFixed(2) })),
  }),
};

requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const ev = input.consume();

  if (running) {
    // --- look
    if (ev.look[0] || ev.look[1]) {
      camYaw -= ev.look[0] * 0.0023;
      camPitch = THREE.MathUtils.clamp(camPitch + ev.look[1] * 0.0018, -0.45, 1.15);
      camYaw = THREE.MathUtils.clamp(camYaw, -Math.PI, Math.PI);
      sinceLook = 0;
    } else {
      sinceLook += dt;
    }

    // --- hotbar
    if (ev.slot !== null) selectSlot(ev.slot);
    if (ev.scroll) selectSlot(slot + ev.scroll);

    // --- one-shot keys
    if (input.down('KeyR')) { spawn(); toast('respawned'); input.keys.delete('KeyR'); }
    if (input.down('KeyF')) { vehicle.flipUpright(); input.keys.delete('KeyF'); }
    if (input.down('KeyL')) {
      car.beam.intensity = car.beam.intensity > 0 ? 0 : 60;
      toast(car.beam.intensity ? 'headlights on' : 'headlights off');
      input.keys.delete('KeyL');
    }

    world.ensureRadius(vehicle.pos.x, vehicle.pos.z, 2);
    vehicle.update(dt, input.driving());
    if (vehicle.pos.y < -8) spawn();

    editBlocks(dt, ev);
  }

  updateCarMesh();
  updateCamera(dt);

  terrain.update(vehicle.pos.x, vehicle.pos.z);
  terrain.step(running ? 5 : 10);

  sun.position.copy(vehicle.pos).addScaledVector(SUN_DIR, 90);
  sun.target.position.copy(vehicle.pos);
  sun.target.updateMatrixWorld();

  // --- hud
  fpsAccum += dt; fpsFrames++;
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.12;
    const kmh = Math.abs(vehicle.speed) * 3.6;
    elSpeed.textContent = Math.round(kmh);
    elGear.textContent = vehicle.groundedCount === 0 ? 'AIR'
      : vehicle.speed < -0.5 ? 'R'
      : kmh < 1 ? 'N' : 'D';
    elCoords.textContent =
      `${Math.round(vehicle.pos.x)}, ${Math.round(vehicle.pos.y)}, ${Math.round(vehicle.pos.z)}`;
    if (fpsAccum > 0.4) {
      elFps.textContent = `${Math.round(fpsFrames / fpsAccum)} fps`;
      fpsAccum = 0; fpsFrames = 0;
    }
  }
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) elToast.classList.remove('show');
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot

input.onEscape = () => {
  running = false;
  hud.classList.add('hidden');
  startPanel.classList.remove('hidden');
  playBtn.textContent = 'Resume';
};

playBtn.disabled = true;
playBtn.addEventListener('click', () => {
  startPanel.classList.add('hidden');
  hud.classList.remove('hidden');
  running = true;
  input.lock();
});

// dev hook: inspect live state from the console
window.__dbg = {
  vehicle, world, terrain, input,
  state: () => ({
    running,
    pos: vehicle.pos.toArray().map((n) => +n.toFixed(2)),
    vel: vehicle.vel.toArray().map((n) => +n.toFixed(2)),
    grounded: vehicle.groundedCount,
    locked: input.locked,
    wheels: vehicle.wheels.map((w) => ({ g: w.grounded, c: +w.compression.toFixed(2) })),
  }),
};

requestAnimationFrame(frame);

// Build the ground under the car before the first frame the player sees.
setTimeout(() => {
  spawn();
  terrain.preload(vehicle.pos.x, vehicle.pos.z, 4);
  spawn();
  playBtn.disabled = false;
  loadingText.textContent = 'world ready';
}, 60);
