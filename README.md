# Blockdrive

A voxel world you drive through. Infinite blocky terrain with a road network cut
into it, an arcade car with real suspension, and a first-person builder who can
get out and rearrange the landscape — carve a shortcut through a hill, pave a
jump, get back in and go and hit it.

Browser + three.js. No build step, no npm, no assets: textures are drawn
procedurally into a canvas atlas at load time, every sound is synthesised at
runtime with WebAudio, and three.js comes from a pinned CDN import map.

## Run it

```bash
./serve.py
```

Then open <http://localhost:8123>. `-p 9000` picks another port, and
`--host 0.0.0.0` makes it reachable from a phone on the same network.

It's a plain static server with one job beyond `python3 -m http.server`: it
sends `no-store` and refuses to answer `304 Not Modified`. Python's stock server
sends no cache headers at all, which leaves the browser free to apply heuristic
caching — you edit a module, reload, and quietly get the old one back, with no
indication anything is stale. Any static server works if you'd rather use your
own; just make sure it doesn't cache, or reload with Cmd/Ctrl+Shift+R.

ES modules won't load from `file://`, so opening `index.html` directly does not
work — it has to be served over http.

## Controls

You are either **driving** or **on foot** — never both. Press `E` to swap. The
car has to be stopped and on the ground before you can get out; you have to be
standing next to it to get back in.

### Driving

| Key | |
| --- | --- |
| `W` / `S` | throttle / reverse |
| `A` / `D` | steer |
| `Space` | handbrake — hold it into a corner to drift |
| `Shift` | boost |
| `C` | brake |
| `F` | flip the car upright |
| `L` | headlights |

### On foot

| Key | |
| --- | --- |
| `W` `A` `S` `D` | walk |
| `Space` | jump |
| `Shift` | sprint |
| Left click | mine the block under the crosshair |
| Right click | place the selected block |
| `1`–`8` / scroll | pick a block |

### Always

| Key | |
| --- | --- |
| `E` | get out of the car / get back in |
| Mouse | look around (while driving it recentres behind the car once you're moving) |
| `R` | respawn |
| `M` | mute |
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
| `src/player.js` | the first-person walker: AABB vs voxels, auto-stepping |
| `src/audio.js` | every sound, synthesised — engine, tyres, wind, impacts, ambience |
| `src/storage.js` | saving and loading worlds: slots, files, and validation |
| `serve.py` | dev server: static files with caching disabled |
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

### On foot

A 0.6×1.8 box that slides along the voxel grid, resolved one axis at a time by
binary-searching back to the contact point. Auto-step is **1.05 blocks**, not
Minecraft's 0.6: this world has no slabs or stairs, so every riser is exactly
one block and a 0.6 step height would never fire — you'd be jumping over every
bump in the terrain. Jumping still clears about 1.3 blocks, so a two-block wall
is a wall. Blocked movement in mid-air keeps your horizontal velocity, so
pressing into a ledge and jumping carries you onto it.

The parked car is a box you collide with rather than walk through, and it keeps
being simulated while you're out of it, so it settles and rolls to rest.

### Saving

A world is its **seed plus every block you have changed** — nothing else. The
terrain generator is deterministic, so that pair reproduces the world exactly,
and a save stays tiny: a few hundred bytes for a small build, rather than the
24 KB per chunk a raw dump would cost. `World.setBlock` is the single chokepoint
where edits happen, so it records them, and `generate()` replays them over
freshly generated terrain — an edit routinely predates the chunk it belongs to,
because chunks are generated lazily as you drive toward them.

Worlds live in named slots in browser storage and autosave every 20 seconds
while something has changed, when you press Esc, and when the tab closes. The
Worlds tab on the pause screen lists them with their seed, block count and last
save; you can create one from a seed (any text works — it gets hashed), load,
delete, and export or import a `.blockdrive.json` file to move a world between
machines or hand it to someone.

Imported files are treated as untrusted: format, version, seed, chunk keys,
block indices and block ids are all validated before anything reaches the world,
because a bad index would quietly corrupt a chunk or hang the tab. World names
are rendered with `textContent`, never `innerHTML`. An import always lands on a
fresh id, so it can never overwrite a world you already have.

### Sound

All of it is generated at runtime; there are no audio files. The engine is four
oscillators through one lowpass, and most of what makes it sound like an engine
is a fake five-speed gearbox: revs climb through a gear and drop on the shift,
instead of pitch tracking speed directly. Tyre squeal is bandpassed noise driven
by how far past the friction limit the tyres are, crashes are a pitch-swept
thump plus a noise burst scaled by impact severity, and block break/place sounds
are pitched by a per-block hardness value. Underneath it all sits a slow wind
bed with birdsong, ducked as you speed up and suppressed on sand and snow.

`M` mutes. Browsers won't start audio without a user gesture, so the context is
created when you press Drive.

Bus levels live in the `MIX` object at the top of `src/audio.js`. They were set
by tapping each chain with an `AnalyserNode` and measuring RMS, not by ear —
filtered noise loses most of its energy, so the numbers are nowhere near where
intuition puts them. For reference the engine runs at about 0.065 RMS flat out,
tyre squeal peaks around 0.030 while sliding and sits near 0.002 on a straight,
and the ambient bed idles at about 0.005.

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
suspension rate, grip, steering falloff, step height. On-foot movement is the
same pattern in `src/player.js` (set `stepHeight` to 0.6 if you want strict
Minecraft rules). Mix levels are the `MIX` object in `src/audio.js`.

World saves are keyed under `blockdrive.*` in localStorage; clearing site data
loses them, which is what Export is for.

### Texture filtering

Two things matter for a world made of tiled cubes, and both show up as
flickering lines on the road ahead of you rather than anywhere obvious:

- **Anisotropy.** A road you are driving down is seen at a grazing angle, which
  is the worst case for isotropic mip selection: the GPU picks a level from the
  larger axis derivative, over-blurs along the direction of travel, and lays
  visible bands across the surface that swim as you turn. The atlas is sampled
  at the hardware maximum, which is what actually fixed it.
- **The mip chain is built by hand.** Letting the GPU generate mipmaps for a
  texture atlas averages neighbouring tiles together, so at distance asphalt
  blends into kerb, grass and centre line and the road washes out to a flat
  grey. Each level is instead built tile by tile from the level above, so tiles
  never bleed across their borders, and the low-pass stays progressive the way
  a normal chain is. Below one pixel per tile the atlas cannot separate them at
  all, but nothing that small is legible anyway.

`minFilter` is `NearestMipmapLinear`: nearest *within* a level keeps blocks
crisp and avoids sampling neighbouring tiles, linear *between* levels stops the
transition being a hard line.

Shadows use a single shadow map that follows you, sized by `SHADOW_EXTENT` and
pushed ahead of the camera by `SHADOW_LEAD` in `src/main.js`. Both matter more
than they look: too small a box and its edge draws a hard line across the road
a fixed distance in front of the car, travelling with you. The box is snapped to
whole shadow texels each frame so shadow edges don't crawl as you drive.

`VIEW_DISTANCE` in `src/main.js` trades draw distance for frame rate; chunk
meshes cast shadows, so dropping that is the first thing to try on a slow
machine.

## A note on dependencies

There is deliberately no `package.json`. The game needs no build step, and
serving the directory is the whole deployment story. If you'd rather not depend
on the CDN at runtime, `npm i three@0.169.0` and repoint the import map in
`index.html` at `node_modules/three/build/three.module.js` — nothing else
changes.
