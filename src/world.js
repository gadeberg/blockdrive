// Voxel data: chunk storage, terrain generation and ray traversal.
// Pure data + math — nothing in here touches three.js.

import { Noise, hash2 } from './noise.js';
import { B } from './blocks.js';

export const CH_X = 16;
export const CH_Y = 96;
export const CH_Z = 16;
const CH_AREA = CH_X * CH_Z;

export const idx = (x, y, z) => y * CH_AREA + z * CH_X + x;
export const chunkKey = (cx, cz) => cx + ',' + cz;

// Road network: a grid of two-lane roads every ROAD_P blocks, flattened into
// the terrain. They give you something to drive on before you build anything.
const ROAD_P = 128;
const ROAD_HALF = 3.4;   // asphalt half-width
const SHOULDER = 4.8;    // concrete shoulder half-width
const BLEND = 20;       // distance over which terrain eases into the road

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

function signedWrap(v, p) {
  const m = ((v % p) + p) % p;
  return m > p / 2 ? m - p : m;
}

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint8Array(CH_X * CH_Y * CH_Z);
    this.maxY = 0;      // highest non-air block, lets the mesher skip empty sky
    this.generated = false;
    this.dirty = true;  // needs a mesh rebuild
  }
  get(x, y, z) { return this.blocks[idx(x, y, z)]; }
  set(x, y, z, b) {
    this.blocks[idx(x, y, z)] = b;
    if (b !== B.AIR && y > this.maxY) this.maxY = y;
  }
}

export class World {
  constructor(seed = 20260905) {
    this.seed = seed;
    this.noise = new Noise(seed);
    this.chunks = new Map();
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }
  _notify(cx, cz) { for (const fn of this.listeners) fn(cx, cz); }

  // --- terrain shape ------------------------------------------------------

  // Low-frequency ground: the base the terrain builds on.
  baseHeight(x, z) {
    return 34 + this.noise.fbm2(x * 0.0032, z * 0.0032, 3) * 17;
  }

  // What a road settles to. Fewer octaves than the land around it, so roads
  // roll gently instead of launching you off every rise.
  roadHeight(x, z) {
    return 34 + this.noise.fbm2(x * 0.0032, z * 0.0032, 2) * 15;
  }

  terrainHeight(x, z) {
    let h = this.baseHeight(x, z);
    h += this.noise.fbm2(x * 0.012, z * 0.012, 4) * 9;
    h += this.noise.fbm2(x * 0.045, z * 0.045, 2) * 1.8;

    // mountain mask — squared so peaks stay rare and localised
    const m = Math.max(0, this.noise.fbm2(x * 0.0014 + 91.3, z * 0.0014 - 40.7, 2));
    h += m * m * 78;
    return h;
  }

  // Everything the column generator needs to know about one (x, z).
  column(x, z) {
    let h = this.terrainHeight(x, z);

    const dx = Math.abs(signedWrap(x, ROAD_P)); // distance to N–S road
    const dz = Math.abs(signedWrap(z, ROAD_P)); // distance to E–W road
    const d = Math.min(dx, dz);

    let road = 0; // 0 none, 1 asphalt, 2 shoulder
    const roadDist = d;
    if (d < BLEND) {
      // Road height is sampled on the road's own centre line, so the surface
      // never has a cross-slope, and both roads agree at an intersection.
      const nx = Math.round(x / ROAD_P) * ROAD_P;
      const nz = Math.round(z / ROAD_P) * ROAD_P;
      const wNS = Math.max(0, 1 - dx / BLEND);
      const wEW = Math.max(0, 1 - dz / BLEND);
      const roadH =
        (this.roadHeight(nx, z) * wNS + this.roadHeight(x, nz) * wEW) / (wNS + wEW);

      const t = smoothstep(clamp((BLEND - d) / (BLEND - SHOULDER), 0, 1));
      h = h * (1 - t) + roadH * t;

      if (d <= ROAD_HALF) road = 1;
      else if (d <= SHOULDER) road = 2;
    }

    const hi = Math.floor(h);
    let top;
    if (road === 1) {
      // dashed centre line on whichever axis this road runs along
      const onCentre = dx < 0.6 ? (((z % 8) + 8) % 8) < 4
                     : dz < 0.6 ? (((x % 8) + 8) % 8) < 4
                     : false;
      top = onCentre ? B.LINE : B.ASPHALT;
    } else if (road === 2) {
      top = B.CONCRETE;
    } else if (hi < 20) {
      top = B.SAND;
    } else if (hi > 66) {
      top = B.SNOW;
    } else {
      top = B.GRASS;
    }
    return { hi, top, road, roadDist };
  }

  // --- generation ---------------------------------------------------------

  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let ch = this.chunks.get(key);
    if (ch) return ch;
    ch = new Chunk(cx, cz);
    this.chunks.set(key, ch);
    this.generate(ch);
    return ch;
  }

  getChunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)); }

  // Collision needs block data, not meshes. Meshing runs on a time budget and
  // can fall behind at 190 km/h; without this the car would drive into
  // not-yet-generated chunks, read them as air, and drop out of the world.
  ensureRadius(x, z, r = 2) {
    const cx = Math.floor(x / CH_X);
    const cz = Math.floor(z / CH_Z);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) this.ensureChunk(cx + dx, cz + dz);
    }
  }

  generate(ch) {
    const ox = ch.cx * CH_X;
    const oz = ch.cz * CH_Z;

    for (let x = 0; x < CH_X; x++) {
      for (let z = 0; z < CH_Z; z++) {
        const { hi, top, road } = this.column(ox + x, oz + z);
        const cap = Math.min(hi, CH_Y - 1);
        for (let y = 0; y <= cap; y++) {
          let b;
          if (y === cap) b = top;
          else if (y > cap - 4) b = road ? B.GRAVEL : (top === B.SAND ? B.SAND : B.DIRT);
          else b = B.STONE;
          ch.set(x, y, z, b);
        }
      }
    }

    // Trees are placed from a padded column range so a trunk near the chunk
    // edge still drops its canopy into this chunk.
    for (let x = -3; x < CH_X + 3; x++) {
      for (let z = -3; z < CH_Z + 3; z++) {
        const wx = ox + x;
        const wz = oz + z;
        if (hash2(wx, wz, this.seed) > 0.012) continue;
        const c = this.column(wx, wz);
        if (c.top !== B.GRASS) continue;
        if (c.roadDist < SHOULDER + 2.5) continue;   // keep the verge clear
        // skip steep ground so trees don't sprout off cliff faces
        const slope = Math.max(
          Math.abs(c.hi - this.column(wx + 1, wz).hi),
          Math.abs(c.hi - this.column(wx, wz + 1).hi),
        );
        if (slope > 2) continue;
        this._tree(ch, wx, c.hi + 1, wz);
      }
    }

    ch.generated = true;
  }

  _tree(ch, wx, wy, wz) {
    const r = hash2(wx, wz, this.seed + 7);
    const trunk = 5 + Math.floor(r * 4);   // tall enough to drive under
    const put = (x, y, z, b) => {
      const lx = x - ch.cx * CH_X;
      const lz = z - ch.cz * CH_Z;
      if (lx < 0 || lz < 0 || lx >= CH_X || lz >= CH_Z || y < 0 || y >= CH_Y) return;
      if (b === B.LEAVES && ch.get(lx, y, lz) !== B.AIR) return;
      ch.set(lx, y, lz, b);
    };

    const topY = wy + trunk;
    for (let y = wy; y < topY; y++) put(wx, y, wz, B.LOG);

    // canopy: narrow, wide, wide, narrow — with ragged corners
    const radii = [1, 2, 2, 1];
    for (let i = 0; i < radii.length; i++) {
      const dy = i - 2;
      const rad = radii[i];
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) {
            if (rad > 1 || hash2(wx + dx, wz + dz, i) > 0.4) continue;
          }
          put(wx + dx, topY + dy, wz + dz, B.LEAVES);
        }
      }
    }
    put(wx, topY + 2, wz, B.LEAVES);   // a tip so the crown isn't flat
  }

  // --- access -------------------------------------------------------------

  getBlock(x, y, z) {
    if (y < 0) return B.STONE;       // bedrock floor: nothing falls out of the world
    if (y >= CH_Y) return B.AIR;
    const cx = x >> 4;
    const cz = z >> 4;
    const ch = this.chunks.get(chunkKey(cx, cz));
    if (!ch) return B.AIR;
    return ch.blocks[idx(x - cx * CH_X, y, z - cz * CH_Z)];
  }

  isSolid(x, y, z) { return this.getBlock(x, y, z) !== B.AIR; }

  setBlock(x, y, z, b) {
    if (y < 0 || y >= CH_Y) return false;
    const cx = x >> 4;
    const cz = z >> 4;
    const ch = this.ensureChunk(cx, cz);
    const lx = x - cx * CH_X;
    const lz = z - cz * CH_Z;
    if (ch.blocks[idx(lx, y, lz)] === b) return false;
    ch.set(lx, y, lz, b);
    ch.dirty = true;
    this._notify(cx, cz);

    // a change on a chunk border shows up in the neighbour's mesh too
    if (lx === 0) this._touch(cx - 1, cz);
    if (lx === CH_X - 1) this._touch(cx + 1, cz);
    if (lz === 0) this._touch(cx, cz - 1);
    if (lz === CH_Z - 1) this._touch(cx, cz + 1);
    return true;
  }

  _touch(cx, cz) {
    const ch = this.getChunk(cx, cz);
    if (ch) { ch.dirty = true; this._notify(cx, cz); }
  }

  // Ground height at (x, z) — highest solid block, +1. Used for spawning.
  surfaceY(x, z) {
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    this.ensureChunk(fx >> 4, fz >> 4);
    for (let y = CH_Y - 1; y >= 0; y--) {
      if (this.getBlock(fx, y, fz) !== B.AIR) return y + 1;
    }
    return 0;
  }

  // --- ray traversal (Amanatides & Woo) -----------------------------------

  // Returns { block, x, y, z, nx, ny, nz, dist, px, py, pz } or null.
  // `ignore` lets a caller pass through one block type — the car uses it so
  // foliage isn't drivable terrain.
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 64, ignore = -1) {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    const invX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const invY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const invZ = dz === 0 ? Infinity : Math.abs(1 / dz);

    let tMaxX = dx === 0 ? Infinity : (dx > 0 ? x + 1 - ox : ox - x) * invX;
    let tMaxY = dy === 0 ? Infinity : (dy > 0 ? y + 1 - oy : oy - y) * invY;
    let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? z + 1 - oz : oz - z) * invZ;

    let t = 0;
    let nx = 0, ny = 0, nz = 0;

    for (let guard = 0; guard < 512; guard++) {
      const b = this.getBlock(x, y, z);
      if (b !== B.AIR && b !== ignore) {
        return {
          block: b, x, y, z, nx, ny, nz, dist: t,
          px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t,
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (tMaxX > maxDist) return null;
        x += stepX; t = tMaxX; tMaxX += invX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > maxDist) return null;
        y += stepY; t = tMaxY; tMaxY += invY; nx = 0; ny = -stepY; nz = 0;
      } else {
        if (tMaxZ > maxDist) return null;
        z += stepZ; t = tMaxZ; tMaxZ += invZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }
}
