import * as THREE from 'three';
import { World, CH_Y } from './world.js';
import { Terrain } from './terrain.js';
import { Vehicle } from './vehicle.js';
import { Player, PLAYER_PARAMS } from './player.js';
import { buildCar } from './carmodel.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { B, BLOCKS, buildAtlasCanvas, hardnessOf, TILE, ATLAS_COLS } from './blocks.js';
import * as storage from './storage.js';
import {
  buildSave, cleanName, deleteWorld, downloadSave, editsFrom, lastWorldId,
  listWorlds, loadWorld, newId, parseSeed, readSaveFile, saveWorld, storageAvailable,
} from './storage.js';

const VIEW_DISTANCE = 8;          // chunks
const REACH = 6;                  // blocks you can mine/place from, on foot
const ENTER_RANGE = 4.2;          // how close you must be to get in
const EXIT_MAX_SPEED = 3.0;       // m/s — you have to slow down to get out
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
// The shadow box has to be big enough that its edge lands out in the fog —
// a tighter box draws a hard line across the road a fixed distance ahead of
// you, and it moves with you, which is impossible to unsee.
const SHADOW_EXTENT = 72;
const SHADOW_LEAD = 34;     // push the box toward what you're looking at
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -SHADOW_EXTENT;
sun.shadow.camera.right = SHADOW_EXTENT;
sun.shadow.camera.top = SHADOW_EXTENT;
sun.shadow.camera.bottom = -SHADOW_EXTENT;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 340;
sun.shadow.bias = -0.0008;
// Everything in this world is an axis-aligned cube, so a generous normal bias
// kills the acne that was striping the road without visible peter-panning.
sun.shadow.normalBias = 0.1;
scene.add(sun, sun.target);

const shadowFocus = new THREE.Vector3();
const lightRight = new THREE.Vector3();
const lightUp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const viewFlat = new THREE.Vector3();

function updateShadowCamera(focus) {
  camera.getWorldDirection(viewFlat);
  viewFlat.y = 0;
  if (viewFlat.lengthSq() > 1e-6) viewFlat.normalize();

  shadowFocus.copy(focus).addScaledVector(viewFlat, SHADOW_LEAD);

  // Snap the box to whole shadow texels, otherwise every shadow edge crawls
  // and shimmers as you drive.
  lightRight.crossVectors(SUN_DIR, WORLD_UP).normalize();
  lightUp.crossVectors(lightRight, SUN_DIR).normalize();
  const texel = (SHADOW_EXTENT * 2) / sun.shadow.mapSize.x;
  const dr = shadowFocus.dot(lightRight);
  const du = shadowFocus.dot(lightUp);
  shadowFocus.addScaledVector(lightRight, Math.round(dr / texel) * texel - dr);
  shadowFocus.addScaledVector(lightUp, Math.round(du / texel) * texel - du);

  sun.position.copy(shadowFocus).addScaledVector(SUN_DIR, 170);
  sun.target.position.copy(shadowFocus);
  sun.target.updateMatrixWorld();
}

// ---------------------------------------------------------------- world

const world = new World();
const terrain = new Terrain(world, scene, VIEW_DISTANCE,
  renderer.capabilities.getMaxAnisotropy());
const vehicle = new Vehicle(world);
const player = new Player(world);
const audio = new GameAudio();

const car = buildCar();
car.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
scene.add(car.group);

// Two nested outlines: a dark one reads on pale blocks, a bright one on dark
// ones like asphalt. A single colour disappears against half the palette.
const highlight = new THREE.Group();
highlight.add(new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, fog: false }),
));
highlight.add(new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, fog: false }),
));
highlight.visible = false;
scene.add(highlight);

/** 'drive' or 'foot'. */
let mode = 'drive';

function spawn() {
  const x = 0.5;
  const z = 8.5;
  const y = world.surfaceY(x, z) + 1.4;
  vehicle.reset(x, y, z, 0);
  if (mode === 'foot') seatPlayer();
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
const elPrompt = document.getElementById('prompt');

let slot = 0;
let toastTimer = 0;

function toast(msg) {
  elToast.textContent = msg;
  elToast.classList.add('show');
  toastTimer = 1.6;
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

function applyMode() {
  hud.classList.toggle('drive', mode === 'drive');
  hud.classList.toggle('foot', mode === 'foot');
  highlight.visible = false;
  elPrompt.classList.remove('show');
}

// ---------------------------------------------------------------- getting in and out

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const carObstacle = {
  pos: vehicle.pos,
  quat: vehicle.quat,
  invQuat: new THREE.Quaternion(),
  half: new THREE.Vector3(0.85, 0.5, 1.9),
  tmp: new THREE.Vector3(),
};

/** Put the player at the driver's door, or anywhere nearby that fits. */
function seatPlayer() {
  const right = vehicle.right(new THREE.Vector3());
  const fwd = vehicle.forward(new THREE.Vector3());
  const candidates = [
    tmp2.copy(vehicle.pos).addScaledVector(right, -1.9).clone(),
    tmp2.copy(vehicle.pos).addScaledVector(right, 1.9).clone(),
    tmp2.copy(vehicle.pos).addScaledVector(fwd, -3.2).clone(),
    tmp2.copy(vehicle.pos).addScaledVector(fwd, 3.2).clone(),
    vehicle.pos.clone(),
  ];

  for (const c of candidates) {
    // walk downward from just above the car looking for a gap that fits
    for (let dy = 1.5; dy > -5; dy -= 0.5) {
      player.placeAt(c.x, vehicle.pos.y + dy, c.z, Math.atan2(fwd.x, fwd.z));
      if (!player._overlaps()) {
        player.pitch = 0;
        return;
      }
    }
  }
  // nothing fits: drop them on top of the column and let gravity sort it out
  player.placeAt(vehicle.pos.x, world.surfaceY(vehicle.pos.x, vehicle.pos.z) + 0.5,
    vehicle.pos.z, Math.atan2(fwd.x, fwd.z));
}

function exitCar() {
  if (Math.abs(vehicle.speed) > EXIT_MAX_SPEED || vehicle.groundedCount === 0) {
    toast('stop the car first');
    return;
  }
  seatPlayer();
  mode = 'foot';
  applyMode();
  audio.carDoor(false);
}

function enterCar() {
  mode = 'drive';
  applyMode();
  camYaw = 0;
  camPitch = 0.2;
  audio.carDoor(true);
}

function nearCar() {
  return player.eyePosition(tmp).distanceTo(vehicle.pos) < ENTER_RANGE;
}

// ---------------------------------------------------------------- camera

const input = new Input(renderer.domElement);
let camYaw = 0;      // offset from the car's heading
let camPitch = 0.20;
let sinceLook = 99;
let camBlend = 0;    // >0 while easing between the two camera styles
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const camQuat = new THREE.Quaternion();
const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function driveCamera(dt) {
  const fwd = vehicle.forward(tmp);
  const heading = Math.atan2(fwd.x, fwd.z);

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

  tmp.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);
  camPos.copy(camTarget).addScaledVector(tmp, dist);

  // don't let the camera end up inside a hill
  const dir = tmp2.copy(camPos).sub(camTarget);
  const len = dir.length();
  dir.divideScalar(len);
  const hit = world.raycast(camTarget.x, camTarget.y, camTarget.z, dir.x, dir.y, dir.z, len);
  if (hit) camPos.copy(camTarget).addScaledVector(dir, Math.max(1.2, hit.dist - 0.35));

  camQuat.setFromRotationMatrix(
    new THREE.Matrix4().lookAt(camPos, camTarget, THREE.Object3D.DEFAULT_UP),
  );

  const targetFov = 70 + Math.min(speed / 3.2, 16);
  setFov(targetFov, dt);
  return 1 - Math.exp(-14 * dt);   // how fast to chase the target pose
}

function footCamera(dt) {
  player.eyePosition(camPos);
  // camera looks down its own -Z, our yaw convention faces +Z
  camEuler.set(player.pitch, player.yaw + Math.PI, 0);
  camQuat.setFromEuler(camEuler);
  setFov(70, dt);
  return 1;   // no lag on foot
}

function setFov(target, dt) {
  if (Math.abs(camera.fov - target) > 0.05) {
    camera.fov += (target - camera.fov) * (1 - Math.exp(-4 * dt));
    camera.updateProjectionMatrix();
  }
}

function updateCamera(dt) {
  let k = mode === 'drive' ? driveCamera(dt) : footCamera(dt);

  if (camBlend > 0) {
    camBlend = Math.max(0, camBlend - dt);
    k = 1 - Math.exp(-11 * dt);   // ease through the transition either way
  }

  if (k >= 1) {
    camera.position.copy(camPos);
    camera.quaternion.copy(camQuat);
  } else {
    camera.position.lerp(camPos, k);
    camera.quaternion.slerp(camQuat, k);
  }

  if (mode === 'drive' && vehicle.impact > 0.01) {
    const a = vehicle.impact * 0.28;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }

  sky.position.copy(camera.position);
}

// ---------------------------------------------------------------- block editing (on foot only)

let digCooldown = 0;
let placeCooldown = 0;
const invCarQuat = new THREE.Quaternion();

function aim() {
  const eye = player.eyePosition(tmp);
  const dir = player.lookDirection(tmp2);
  return world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, REACH);
}

function blockedByCar(x, y, z) {
  invCarQuat.copy(vehicle.quat).invert();
  tmp.set(x + 0.5, y + 0.5, z + 0.5).sub(vehicle.pos).applyQuaternion(invCarQuat);
  return Math.abs(tmp.x) < 1.35 && Math.abs(tmp.y) < 0.95 && Math.abs(tmp.z) < 2.35;
}

function blockedByPlayer(x, y, z) {
  const hw = PLAYER_PARAMS.width / 2;
  return x + 1 > player.pos.x - hw && x < player.pos.x + hw
    && z + 1 > player.pos.z - hw && z < player.pos.z + hw
    && y + 1 > player.pos.y && y < player.pos.y + PLAYER_PARAMS.height;
}

function editBlocks(dt, ev) {
  digCooldown -= dt;
  placeCooldown -= dt;

  const hit = aim();
  highlight.visible = !!hit;
  if (!hit) return;
  highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

  if ((ev.click[0] || input.held[0]) && digCooldown <= 0) {
    const removed = world.getBlock(hit.x, hit.y, hit.z);
    if (world.setBlock(hit.x, hit.y, hit.z, B.AIR)) audio.blockBreak(hardnessOf(removed));
    digCooldown = 0.18;
  }

  if ((ev.click[2] || input.held[2]) && placeCooldown <= 0) {
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (y >= 0 && y < CH_Y && !world.isSolid(x, y, z)
        && !blockedByCar(x, y, z) && !blockedByPlayer(x, y, z)) {
      const placed = HOTBAR[slot];
      if (world.setBlock(x, y, z, placed)) audio.blockPlace(hardnessOf(placed));
      placeCooldown = 0.2;
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


// ---------------------------------------------------------------- worlds

const AUTOSAVE_EVERY = 20;   // seconds, and only when something has changed

let current = { id: newId(), name: 'My world', seed: 20260905, created: Date.now() };
let autosaveTimer = AUTOSAVE_EVERY;

const elCurrentWorld = document.getElementById('currentWorld');
const elCurrentMeta = document.getElementById('currentMeta');
const elWorldList = document.getElementById('worldList');
const elNewName = document.getElementById('newName');
const elNewSeed = document.getElementById('newSeed');
const elStorageNote = document.getElementById('storageNote');
const elImportInput = document.getElementById('importInput');

function captureState() {
  return {
    mode,
    car: { pos: vehicle.pos.toArray(), quat: vehicle.quat.toArray() },
    player: { pos: player.pos.toArray(), yaw: player.yaw, pitch: player.pitch },
    slot,
    headlights: car.beam.intensity > 0,
  };
}

function applyState(state) {
  if (state.car) {
    vehicle.pos.fromArray(state.car.pos);
    vehicle.quat.fromArray(state.car.quat).normalize();
    vehicle.vel.set(0, 0, 0);
    vehicle.angVel.set(0, 0, 0);
    vehicle.steer = 0;
    vehicle.impact = 0;
    vehicle.stuck = 0;
  } else {
    spawn();
  }

  mode = state.mode === 'foot' ? 'foot' : 'drive';
  if (state.player) {
    const [px, py, pz] = state.player.pos;
    player.placeAt(px, py, pz, state.player.yaw);
    player.pitch = state.player.pitch;
  } else if (mode === 'foot') {
    seatPlayer();
  }

  selectSlot(Number.isInteger(state.slot) ? state.slot : 0);
  car.beam.intensity = state.headlights ? 60 : 0;
  applyMode();
}

/** Make `save` the world we're playing: rebuild terrain, restore where we were. */
function activate(save) {
  current = { id: save.id, name: save.name, seed: save.seed, created: save.created };
  world.reset(save.seed, editsFrom(save));
  terrain.clear();
  applyState(save.state || {});

  const f = focusPosition();
  world.ensureRadius(f.x, f.z, 3);
  terrain.preload(f.x, f.z, 4);

  storage.setLastWorldId(save.id);
  autosaveTimer = AUTOSAVE_EVERY;
  refreshWorldUI();
}

function saveCurrent({ quiet = false } = {}) {
  const save = buildSave({ ...current, world, state: captureState() });
  const res = saveWorld(save);
  if (res.ok) {
    world.dirty = false;
    if (!quiet) toast(`saved "${current.name}"`);
    refreshWorldUI();
  } else if (!quiet) {
    toast(res.error);
  }
  return res.ok;
}

function loadById(id) {
  if (id === current.id) return;
  if (world.dirty) saveCurrent({ quiet: true });   // never lose the world you're leaving
  const res = loadWorld(id);
  if (!res.ok) { toast(res.error); return; }
  activate(res.save);
  toast(`loaded "${res.save.name}"`);
}

function createWorld(name, seedText) {
  if (world.dirty) saveCurrent({ quiet: true });
  activate({
    id: newId(),
    name: cleanName(name, 'New world'),
    seed: parseSeed(seedText),
    created: Date.now(),
    edits: {},
    state: {},
  });
  saveCurrent({ quiet: true });
  toast(`new world "${current.name}"`);
}

// --- UI

function timeAgo(ts) {
  if (!ts) return 'never saved';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function refreshWorldUI() {
  elCurrentWorld.textContent = current.name;
  elCurrentMeta.textContent = `seed ${current.seed} · ${world.editCount()} blocks changed`;
  renderWorldList();
}

function renderWorldList() {
  elWorldList.textContent = '';
  const worlds = listWorlds();

  if (!worlds.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No saved worlds yet.';
    elWorldList.appendChild(empty);
    return;
  }

  for (const w of worlds) {
    const isCurrent = w.id === current.id;
    const row = document.createElement('div');
    row.className = isCurrent ? 'world on' : 'world';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = w.name;          // never innerHTML: names can come from a file
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `seed ${w.seed} · ${w.count} block${w.count === 1 ? '' : 's'} · ${timeAgo(w.saved)}`;
    info.append(name, meta);

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = isCurrent ? 'Playing' : 'Load';
    load.disabled = isCurrent;
    load.addEventListener('click', () => loadById(w.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Delete';
    del.disabled = isCurrent;
    if (isCurrent) del.title = 'Load a different world before deleting this one';
    let armed = false;
    del.addEventListener('click', () => {
      if (!armed) {                      // two clicks, rather than a blocking confirm()
        armed = true;
        del.textContent = 'Sure?';
        setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 3000);
        return;
      }
      deleteWorld(w.id);
      toast(`deleted "${w.name}"`);
      renderWorldList();
    });

    row.append(info, load, del);
    elWorldList.appendChild(row);
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    const want = tab.dataset.view;
    document.getElementById('view-play').classList.toggle('hidden', want !== 'play');
    document.getElementById('view-worlds').classList.toggle('hidden', want !== 'worlds');
    if (want === 'worlds') refreshWorldUI();
  });
});

document.getElementById('createWorld').addEventListener('click', () => {
  createWorld(elNewName.value, elNewSeed.value);
  elNewName.value = '';
  elNewSeed.value = '';
});

document.getElementById('saveNow').addEventListener('click', () => saveCurrent());

document.getElementById('exportWorld').addEventListener('click', () => {
  downloadSave(buildSave({ ...current, world, state: captureState() }));
  toast('exported');
});

document.getElementById('importWorld').addEventListener('click', () => elImportInput.click());

elImportInput.addEventListener('change', async () => {
  const file = elImportInput.files && elImportInput.files[0];
  elImportInput.value = '';
  if (!file) return;

  const res = await readSaveFile(file);
  if (!res.ok) { toast(res.error); return; }

  if (world.dirty) saveCurrent({ quiet: true });
  // Always land on a fresh id so an import can never overwrite a world you
  // already have.
  res.save.id = newId();
  activate(res.save);
  saveCurrent({ quiet: true });
  toast(`imported "${res.save.name}"`);
});

// ---------------------------------------------------------------- loop

let running = false;
let last = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;
let hudTimer = 0;
let ambientTimer = 0;
let outdoors = true;
let quietSurroundings = true;

function focusPosition() {
  return mode === 'drive' ? vehicle.pos : player.pos;
}

function updateAmbientContext() {
  const p = focusPosition();
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  outdoors = !world.raycast(p.x, p.y + 1, p.z, 0, 1, 0, 48);
  const surface = world.getBlock(x, world.surfaceY(p.x, p.z) - 1, z);
  quietSurroundings = surface !== B.SAND && surface !== B.SNOW;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  const ev = input.consume();
  let driveInput = { throttle: 0, steer: 0, handbrake: false, brake: false, boost: false };

  if (running) {
    // --- look
    if (ev.look[0] || ev.look[1]) {
      if (mode === 'drive') {
        camYaw = THREE.MathUtils.clamp(camYaw - ev.look[0] * 0.0023, -Math.PI, Math.PI);
        camPitch = THREE.MathUtils.clamp(camPitch + ev.look[1] * 0.0018, -0.45, 1.15);
      } else {
        player.yaw -= ev.look[0] * 0.0023;
        player.pitch = THREE.MathUtils.clamp(player.pitch - ev.look[1] * 0.0023, -1.54, 1.54);
      }
      sinceLook = 0;
    } else {
      sinceLook += dt;
    }

    // --- keys that fire once
    if (ev.keys.has('KeyE')) {
      if (mode === 'drive') exitCar();
      else if (nearCar()) enterCar();
      else toast('too far from the car');
      camBlend = 0.35;
    }
    if (ev.keys.has('KeyM')) toast(audio.setMuted(!audio.muted) ? 'sound off' : 'sound on');
    if (ev.keys.has('KeyR')) {
      spawn();          // also re-seats you beside the car if you're on foot
      toast('respawned');
    }
    if (mode === 'drive') {
      if (ev.keys.has('KeyF')) vehicle.flipUpright();
      if (ev.keys.has('KeyL')) {
        car.beam.intensity = car.beam.intensity > 0 ? 0 : 60;
        toast(car.beam.intensity ? 'headlights on' : 'headlights off');
      }
    }

    // --- hotbar (on foot: it's the only time you can build)
    if (mode === 'foot') {
      if (ev.slot !== null) selectSlot(ev.slot);
      if (ev.scroll) selectSlot(slot + ev.scroll);
    }

    // --- simulate
    const focus = focusPosition();
    world.ensureRadius(focus.x, focus.z, 2);

    if (mode === 'drive') {
      driveInput = input.driving();
      vehicle.update(dt, driveInput);
      if (vehicle.pos.y < -8) spawn();
    } else {
      // the parked car keeps settling, just with nobody at the wheel
      vehicle.update(dt, driveInput);
      carObstacle.invQuat.copy(vehicle.quat).invert();
      player.update(dt, input.walking(), carObstacle);
      if (player.pos.y < -8) seatPlayer();
      editBlocks(dt, ev);
      elPrompt.classList.toggle('show', nearCar());
    }

    // --- audio
    const impact = vehicle.impactEvent;
    vehicle.impactEvent = 0;
    if (impact > 0.06) audio.crash(impact);

    ambientTimer -= dt;
    if (ambientTimer <= 0) { ambientTimer = 0.5; updateAmbientContext(); }

    autosaveTimer -= dt;
    if (autosaveTimer <= 0) {
      autosaveTimer = AUTOSAVE_EVERY;
      if (world.dirty) saveCurrent({ quiet: true });
    }

    let slip = 0;
    for (const w of vehicle.wheels) if (w.slip > slip) slip = w.slip;
    audio.update(dt, {
      driving: mode === 'drive',
      speed: Math.abs(vehicle.speed),
      throttle: driveInput.throttle,
      slip,
      grounded: vehicle.groundedCount > 0,
      outdoors,
      quiet: quietSurroundings && (mode === 'foot' || Math.abs(vehicle.speed) < 7),
    });
  }

  updateCarMesh();
  updateCamera(dt);

  const focus = focusPosition();
  terrain.update(focus.x, focus.z);
  terrain.step(running ? 5 : 10);

  updateShadowCamera(focus);

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
    const p = focusPosition();
    elCoords.textContent = `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
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
  saveCurrent({ quiet: true });
};

// localStorage is synchronous, so this is safe to do on the way out.
addEventListener('beforeunload', () => {
  if (running || world.dirty) saveCurrent({ quiet: true });
});

playBtn.disabled = true;
playBtn.addEventListener('click', () => {
  startPanel.classList.add('hidden');
  hud.classList.remove('hidden');
  running = true;
  audio.start();
  input.lock();
});

// dev hook: inspect live state from the console
window.__dbg = {
  vehicle, world, terrain, input, player, audio, storage,
  camera, renderer, scene, sun,
  save: () => saveCurrent(),
  get world_() { return current; },
  get mode() { return mode; },
  state: () => ({
    running,
    mode,
    pos: focusPosition().toArray().map((n) => +n.toFixed(2)),
    vel: vehicle.vel.toArray().map((n) => +n.toFixed(2)),
    grounded: vehicle.groundedCount,
    onGround: player.onGround,
    locked: input.locked,
  }),
};

requestAnimationFrame(frame);

// Build the ground under the car before the first frame the player sees.
setTimeout(() => {
  const previous = lastWorldId();
  const restored = previous ? loadWorld(previous) : null;

  if (restored && restored.ok) {
    activate(restored.save);
    loadingText.textContent = `resumed "${current.name}"`;
  } else {
    activate({
      id: current.id,
      name: current.name,
      seed: current.seed,
      created: current.created,
      edits: {},
      state: {},
    });
    saveCurrent({ quiet: true });
    loadingText.textContent = 'world ready';
  }

  elStorageNote.textContent = storageAvailable()
    ? 'Autosaves as you play, and whenever you press Esc.'
    : 'Browser storage is blocked here, so worlds cannot autosave. Use Export to keep one.';

  playBtn.disabled = false;
}, 60);
