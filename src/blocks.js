// Block registry + a procedurally drawn texture atlas, so the game ships with
// no image assets at all.

import * as THREE from 'three';
import { mulberry32 } from './noise.js';

export const TILE = 32;         // px per tile in the atlas
export const ATLAS_COLS = 8;    // 8x8 tiles
const ATLAS_PX = TILE * ATLAS_COLS;

// --- tile ids -------------------------------------------------------------
export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3,
  SAND: 4, SNOW: 5, LOG_SIDE: 6, LOG_TOP: 7,
  LEAVES: 8, PLANKS: 9, BRICK: 10, ASPHALT: 11,
  LINE: 12, CONCRETE: 13, STEEL: 14, GRAVEL: 15,
  LAMP: 16, CHECKER: 17,
};

// --- block ids ------------------------------------------------------------
export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, SNOW: 5,
  LOG: 6, LEAVES: 7, PLANKS: 8, BRICK: 9, ASPHALT: 10,
  LINE: 11, CONCRETE: 12, STEEL: 13, GRAVEL: 14, LAMP: 15,
  CHECKER: 16,
};

// tiles: [top, side, bottom]
export const BLOCKS = [
  null, // AIR
  { name: 'Grass',    tiles: [T.GRASS_TOP, T.GRASS_SIDE, T.DIRT] },
  { name: 'Dirt',     tiles: [T.DIRT, T.DIRT, T.DIRT] },
  { name: 'Stone',    tiles: [T.STONE, T.STONE, T.STONE] },
  { name: 'Sand',     tiles: [T.SAND, T.SAND, T.SAND] },
  { name: 'Snow',     tiles: [T.SNOW, T.SNOW, T.DIRT] },
  { name: 'Log',      tiles: [T.LOG_TOP, T.LOG_SIDE, T.LOG_TOP] },
  { name: 'Leaves',   tiles: [T.LEAVES, T.LEAVES, T.LEAVES] },
  { name: 'Planks',   tiles: [T.PLANKS, T.PLANKS, T.PLANKS] },
  { name: 'Brick',    tiles: [T.BRICK, T.BRICK, T.BRICK] },
  { name: 'Asphalt',  tiles: [T.ASPHALT, T.ASPHALT, T.ASPHALT], grip: 1.0 },
  { name: 'Road line',tiles: [T.LINE, T.ASPHALT, T.ASPHALT], grip: 1.0 },
  { name: 'Concrete', tiles: [T.CONCRETE, T.CONCRETE, T.CONCRETE], grip: 0.97 },
  { name: 'Steel',    tiles: [T.STEEL, T.STEEL, T.STEEL], grip: 0.8 },
  { name: 'Gravel',   tiles: [T.GRAVEL, T.GRAVEL, T.GRAVEL], grip: 0.62 },
  { name: 'Lamp',     tiles: [T.LAMP, T.LAMP, T.LAMP], light: true },
  { name: 'Checker',  tiles: [T.CHECKER, T.CHECKER, T.CHECKER], grip: 1.05 },
];

// Surface grip multiplier used by the tyre model. Loose ground is slippery,
// tarmac is not.
const GRIP = new Float32Array(BLOCKS.length);
for (let i = 1; i < BLOCKS.length; i++) GRIP[i] = BLOCKS[i].grip ?? 0.88;
GRIP[B.SAND] = 0.55;
GRIP[B.SNOW] = 0.45;
GRIP[B.GRASS] = 0.72;
GRIP[B.DIRT] = 0.7;
GRIP[B.LEAVES] = 0.6;
export function gripOf(block) {
  return block > 0 && block < GRIP.length ? GRIP[block] : 0.85;
}

export const isSolid = (b) => b !== B.AIR;

// Rough hardness, 0 soft .. 1 hard. Only used to pitch the break/place sounds.
const HARDNESS = new Float32Array(BLOCKS.length);
for (let i = 1; i < BLOCKS.length; i++) HARDNESS[i] = 0.5;
HARDNESS[B.GRASS] = 0.2;   HARDNESS[B.DIRT] = 0.2;
HARDNESS[B.SAND] = 0.15;   HARDNESS[B.SNOW] = 0.1;
HARDNESS[B.GRAVEL] = 0.3;  HARDNESS[B.LEAVES] = 0.05;
HARDNESS[B.LOG] = 0.45;    HARDNESS[B.PLANKS] = 0.45;
HARDNESS[B.STONE] = 0.9;   HARDNESS[B.BRICK] = 0.85;
HARDNESS[B.CONCRETE] = 0.8; HARDNESS[B.ASPHALT] = 0.7;
HARDNESS[B.LINE] = 0.7;    HARDNESS[B.STEEL] = 1.0;
HARDNESS[B.LAMP] = 0.65;   HARDNESS[B.CHECKER] = 0.8;
export function hardnessOf(block) {
  return block > 0 && block < HARDNESS.length ? HARDNESS[block] : 0.5;
}

// --- procedural atlas -----------------------------------------------------

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// Fill a tile with a base colour plus per-pixel value noise.
function speckle(ctx, ox, oy, rand, base, amount, opts = {}) {
  const [r, g, b] = base;
  const grain = opts.grain ?? 1;
  for (let y = 0; y < TILE; y += grain) {
    for (let x = 0; x < TILE; x += grain) {
      const n = (rand() - 0.5) * 2 * amount;
      const c = `rgb(${clamp8(r + n)},${clamp8(g + n)},${clamp8(b + n)})`;
      px(ctx, ox + x, oy + y, grain, grain, c);
    }
  }
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function tilePos(id) {
  return [(id % ATLAS_COLS) * TILE, Math.floor(id / ATLAS_COLS) * TILE];
}

export function buildAtlasCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(90210);

  const draw = (id, fn) => {
    const [ox, oy] = tilePos(id);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, TILE, TILE);
    ctx.clip();
    fn(ox, oy);
    ctx.restore();
  };

  draw(T.GRASS_TOP, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [96, 152, 66], 26, { grain: 2 });
    for (let i = 0; i < 40; i++) {
      const x = ox + (rand() * TILE | 0);
      const y = oy + (rand() * TILE | 0);
      px(ctx, x, y, 2, 2, rand() > 0.5 ? '#7fbe52' : '#5d8f3e');
    }
  });

  draw(T.DIRT, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [134, 98, 66], 22, { grain: 2 });
    for (let i = 0; i < 22; i++) {
      px(ctx, ox + (rand() * TILE | 0), oy + (rand() * TILE | 0), 3, 2, '#6f4f34');
    }
  });

  draw(T.GRASS_SIDE, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [134, 98, 66], 22, { grain: 2 });
    // grass fringe hanging over the dirt
    for (let x = 0; x < TILE; x++) {
      const h = 6 + ((rand() * 5) | 0);
      for (let y = 0; y < h; y++) {
        const n = (rand() - 0.5) * 40;
        px(ctx, ox + x, oy + y, 1, 1, `rgb(${clamp8(96 + n)},${clamp8(152 + n)},${clamp8(66 + n)})`);
      }
    }
  });

  draw(T.STONE, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [128, 130, 136], 20, { grain: 2 });
    ctx.strokeStyle = 'rgba(70,72,78,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(ox + rand() * TILE, oy + rand() * TILE);
      ctx.lineTo(ox + rand() * TILE, oy + rand() * TILE);
      ctx.stroke();
    }
  });

  draw(T.SAND, (ox, oy) => speckle(ctx, ox, oy, rand, [220, 202, 148], 16, { grain: 2 }));
  draw(T.SNOW, (ox, oy) => speckle(ctx, ox, oy, rand, [236, 240, 248], 10, { grain: 2 }));
  draw(T.GRAVEL, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [126, 122, 118], 26, { grain: 2 });
    for (let i = 0; i < 26; i++) {
      const s = 2 + ((rand() * 3) | 0);
      px(ctx, ox + (rand() * TILE | 0), oy + (rand() * TILE | 0), s, s,
         rand() > 0.5 ? '#9a958f' : '#5f5b57');
    }
  });

  draw(T.LOG_SIDE, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [122, 90, 56], 16, { grain: 1 });
    for (let i = 0; i < 8; i++) {
      const x = ox + (rand() * TILE | 0);
      px(ctx, x, oy, 1 + ((rand() * 2) | 0), TILE, 'rgba(80,58,36,0.5)');
    }
  });

  draw(T.LOG_TOP, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [158, 122, 78], 12, { grain: 1 });
    ctx.strokeStyle = 'rgba(96,70,42,0.75)';
    for (let r = 3; r < TILE / 2; r += 4) {
      ctx.beginPath();
      ctx.arc(ox + TILE / 2, oy + TILE / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  draw(T.LEAVES, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [66, 122, 52], 34, { grain: 2 });
    for (let i = 0; i < 30; i++) {
      px(ctx, ox + (rand() * TILE | 0), oy + (rand() * TILE | 0), 2, 2, '#2f5c28');
    }
  });

  draw(T.PLANKS, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [176, 136, 88], 14, { grain: 1 });
    ctx.fillStyle = 'rgba(108,78,44,0.7)';
    for (let y = 0; y < TILE; y += 8) ctx.fillRect(ox, oy + y, TILE, 1);
    for (let y = 0; y < TILE; y += 8) {
      const x = ox + ((rand() * TILE) | 0);
      ctx.fillRect(x, oy + y, 1, 8);
    }
  });

  draw(T.BRICK, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [162, 76, 60], 14, { grain: 1 });
    ctx.fillStyle = '#cfc6bb';
    for (let y = 0; y < TILE; y += 8) {
      ctx.fillRect(ox, oy + y, TILE, 2);
      const off = (y / 8) % 2 ? 8 : 0;
      for (let x = off; x < TILE; x += 16) ctx.fillRect(ox + x, oy + y, 2, 8);
    }
  });

  draw(T.ASPHALT, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [58, 60, 64], 16, { grain: 1 });
    for (let i = 0; i < 30; i++) {
      px(ctx, ox + (rand() * TILE | 0), oy + (rand() * TILE | 0), 1, 1, '#7c7f85');
    }
  });

  draw(T.LINE, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [58, 60, 64], 16, { grain: 1 });
    px(ctx, ox + 12, oy, 8, TILE, '#e8d24a');
    for (let i = 0; i < 14; i++) {
      px(ctx, ox + 12 + (rand() * 8 | 0), oy + (rand() * TILE | 0), 1, 1, 'rgba(70,64,30,0.6)');
    }
  });

  draw(T.CONCRETE, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [176, 176, 172], 12, { grain: 2 });
    ctx.fillStyle = 'rgba(120,120,118,0.5)';
    ctx.fillRect(ox, oy, TILE, 1);
    ctx.fillRect(ox, oy, 1, TILE);
  });

  draw(T.STEEL, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [150, 156, 166], 10, { grain: 1 });
    ctx.fillStyle = 'rgba(90,96,106,0.55)';
    for (let y = 2; y < TILE; y += 6) ctx.fillRect(ox, oy + y, TILE, 2);
    ctx.fillStyle = 'rgba(220,226,236,0.5)';
    for (let i = 0; i < 4; i++) {
      const c = 4 + i * 8;
      ctx.fillRect(ox + c, oy + 2, 2, 2);
    }
  });

  draw(T.LAMP, (ox, oy) => {
    speckle(ctx, ox, oy, rand, [246, 226, 150], 12, { grain: 2 });
    ctx.fillStyle = 'rgba(226,178,68,0.85)';
    for (let y = 0; y < TILE; y += 8) ctx.fillRect(ox, oy + y, TILE, 2);
    for (let x = 0; x < TILE; x += 8) ctx.fillRect(ox + x, oy, 2, TILE);
  });

  draw(T.CHECKER, (ox, oy) => {
    for (let y = 0; y < TILE; y += 8) {
      for (let x = 0; x < TILE; x += 8) {
        const on = ((x / 8) + (y / 8)) % 2 === 0;
        px(ctx, ox + x, oy + y, 8, 8, on ? '#1b1d22' : '#f0f2f6');
      }
    }
  });

  return canvas;
}

export function buildAtlasTexture() {
  const tex = new THREE.CanvasTexture(buildAtlasCanvas());
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// UV rect for a tile, inset by half a texel so mipmaps never bleed between
// neighbouring tiles.
const INSET = 0.5 / ATLAS_PX;
export function tileUV(id) {
  const cx = id % ATLAS_COLS;
  const cy = Math.floor(id / ATLAS_COLS);
  const s = 1 / ATLAS_COLS;
  return {
    u0: cx * s + INSET,
    v0: 1 - (cy + 1) * s + INSET,
    u1: (cx + 1) * s - INSET,
    v1: 1 - cy * s - INSET,
  };
}

// face: 0 = +Y (top), 1 = -Y (bottom), 2 = side
export function tileForFace(block, face) {
  const def = BLOCKS[block];
  if (!def) return 0;
  return face === 0 ? def.tiles[0] : face === 1 ? def.tiles[2] : def.tiles[1];
}
