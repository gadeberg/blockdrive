# Blockdrive

A voxel world you drive through. Infinite blocky terrain with a road network cut
into it, an arcade car with real suspension, and the ability to mine and place
blocks from the driver's seat — carve a shortcut through a hill, pave a jump,
then go and hit it.

Browser + three.js. No build step, no npm, no assets: textures are drawn
procedurally into a canvas atlas at load time and three.js comes from a pinned
CDN import map.

## Run it

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123>. Any static server works — the only
requirement is that the files are served over http, since ES modules won't load
from `file://`.

## Controls

| Key | |
| --- | --- |
| `W` / `S` | throttle / reverse |
| `A` / `D` | steer |
| `Space` | handbrake — hold it into a corner to drift |
| `Shift` | boost |
| `C` | brake |
| Mouse | look around (auto-recentres behind the car once you're moving) |
| Left click | mine the block under the crosshair |
| Right click | place the selected block |
| `1`–`8` / scroll | pick a block |
| `R` | respawn |
| `F` | flip the car upright |
| `L` | headlights |
| `Esc` | release the mouse |

## How it works

| File | |
| --- | --- |
| `src/world.js` | chunk storage, terrain + road generation, voxel raycasting |
| `src/mesher.js` | chunk → geometry: face culling, per-vertex ambient occlusion, atlas UVs |
| `src/terrain.js` | streams chunk meshes in and out on a per-frame time budget |
| `src/vehicle.js` | the car: box rigid body, four raycast wheels, tyre friction circle |
| `src/blocks.js` | block registry and the procedurally drawn texture atlas |
| `src/carmodel.js` | the car, built out of boxes |
| `src/noise.js` | seeded Perlin / fBm |
| `src/main.js` | renderer, camera rig, HUD, block editing, game loop |

### Terrain

Height is fBm noise with a squared mountain mask. A road grid runs every 128
blocks; near a road the terrain eases toward a height sampled **on the road's
own centre line**, so roads never have a cross-slope and the two directions
agree exactly at an intersection. Where a road meets a hill it cuts through it,
and where it crosses a dip the column fills in underneath as an embankment.
Trees are placed from a deterministic per-column hash, so a trunk near a chunk
boundary still drops its canopy into the neighbouring chunk.

### Driving

Each wheel casts three short rays (back, centre, front of the contact patch)
and takes the highest ground, which is what lets the car roll over voxel steps
instead of tripping on every one. A spring/damper carries the chassis, and each
tyre resolves longitudinal and lateral demand inside a friction circle scaled by
the grip of the block underneath — tarmac bites, sand and snow don't.

Three things exist purely to make a car work in a world made of cubes:

- **The collision proxy is shorter and higher than the bodywork.** With a
  box the size of the visible car, the sills beach on any one-block riser.
- **Step-up assist.** A low corner pressed against a face it could ride over
  lifts instead of colliding, up to `stepHeight` (1.05). One-block kerbs are
  climbable at any speed; two-block walls are still walls.
- **Airborne self-levelling.** Throttle is held near-constantly while driving,
  so mapping it to pitch would front-flip the car off every crest. Instead the
  car damps its tumble and rotates back toward upright in the air, and steering
  gives a little yaw authority to aim the landing.

If a crash does wedge the hull inside terrain, the car detects it and lifts
itself back to the surface rather than leaving you buried.

### Debugging

`window.__dbg` exposes `{ vehicle, world, terrain, input, state() }`. Because
the physics runs on a fixed timestep independent of rendering, you can drive the
car deterministically from the console without the render loop — useful for
soak-testing handling:

```js
const { vehicle: v, world: w } = window.__dbg;
v.reset(0.5, w.surfaceY(0.5, 8.5) + 1.4, 8.5, 0);
for (let i = 0; i < 3600; i++) {
  w.ensureRadius(v.pos.x, v.pos.z, 2);
  v.update(1 / 60, { throttle: 1, steer: 0, handbrake: false, brake: false, boost: false });
}
v.pos;
```

## Tuning

Handling lives in the `P` object at the top of `src/vehicle.js` — engine force,
suspension rate, grip, steering falloff, step height. `VIEW_DISTANCE` in
`src/main.js` trades draw distance for frame rate; chunk meshes cast shadows, so
dropping that is the first thing to try on a slow machine.
