// Turns a chunk's voxels into a BufferGeometry: culled faces, per-vertex
// ambient occlusion, atlas UVs.

import * as THREE from 'three';
import { CH_X, CH_Y, CH_Z, idx } from './world.js';
import { B, tileForFace, tileUV } from './blocks.js';

// n = face normal, u/v = tangents chosen so cross(u, v) === n (keeps winding
// counter-clockwise seen from outside). face: 0 top, 1 bottom, 2 side.
const DIRS = [
  { n: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], face: 2, shade: 0.86 },
  { n: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0], face: 2, shade: 0.86 },
  { n: [ 0, 1, 0], u: [1, 0,  0], v: [0, 0, -1], face: 0, shade: 1.00 },
  { n: [ 0,-1, 0], u: [1, 0,  0], v: [0, 0,  1], face: 1, shade: 0.55 },
  { n: [ 0, 0, 1], u: [1, 0,  0], v: [0, 1, 0], face: 2, shade: 0.94 },
  { n: [ 0, 0,-1], u: [-1, 0, 0], v: [0, 1, 0], face: 2, shade: 0.94 },
];

// corner order: (-1,-1), (+1,-1), (+1,+1), (-1,+1)
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const AO_LEVELS = [0.42, 0.62, 0.82, 1.0];

export function buildChunkGeometry(world, chunk) {
  const ox = chunk.cx * CH_X;
  const oz = chunk.cz * CH_Z;
  const blocks = chunk.blocks;

  const get = (wx, wy, wz) => {
    const lx = wx - ox;
    const lz = wz - oz;
    if (lx >= 0 && lx < CH_X && lz >= 0 && lz < CH_Z) {
      if (wy < 0) return B.STONE;
      if (wy >= CH_Y) return B.AIR;
      return blocks[idx(lx, wy, lz)];
    }
    return world.getBlock(wx, wy, wz);
  };
  const solid = (wx, wy, wz) => get(wx, wy, wz) !== B.AIR;

  const pos = [];
  const nor = [];
  const uvs = [];
  const col = [];
  const ind = [];
  let vcount = 0;

  const yMax = Math.min(CH_Y - 1, chunk.maxY);

  for (let y = 0; y <= yMax; y++) {
    for (let z = 0; z < CH_Z; z++) {
      for (let x = 0; x < CH_X; x++) {
        const b = blocks[idx(x, y, z)];
        if (b === B.AIR) continue;

        const wx = ox + x;
        const wz = oz + z;

        for (let d = 0; d < 6; d++) {
          const dir = DIRS[d];
          const [nx, ny, nz] = dir.n;
          if (solid(wx + nx, y + ny, wz + nz)) continue;

          const [ux, uy, uz] = dir.u;
          const [vx, vy, vz] = dir.v;
          const { u0, v0, u1, v1 } = tileUV(tileForFace(b, dir.face));

          // centre of the neighbouring (empty) cell — AO samples live around it
          const ax = wx + nx, ay = y + ny, az = wz + nz;

          const ao = [0, 0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const [su, sv] = CORNERS[c];

            pos.push(
              wx + 0.5 + nx * 0.5 + ux * su * 0.5 + vx * sv * 0.5,
              y  + 0.5 + ny * 0.5 + uy * su * 0.5 + vy * sv * 0.5,
              wz + 0.5 + nz * 0.5 + uz * su * 0.5 + vz * sv * 0.5,
            );
            nor.push(nx, ny, nz);
            uvs.push(su < 0 ? u0 : u1, sv < 0 ? v0 : v1);

            const s1 = solid(ax + ux * su, ay + uy * su, az + uz * su) ? 1 : 0;
            const s2 = solid(ax + vx * sv, ay + vy * sv, az + vz * sv) ? 1 : 0;
            const cn = solid(ax + ux * su + vx * sv,
                             ay + uy * su + vy * sv,
                             az + uz * su + vz * sv) ? 1 : 0;
            const level = (s1 && s2) ? 0 : 3 - (s1 + s2 + cn);
            ao[c] = level;
            const light = AO_LEVELS[level] * dir.shade;
            col.push(light, light, light);
          }

          // split the quad along the diagonal with the smaller AO contrast,
          // otherwise occlusion looks like it flips across the face
          if (ao[0] + ao[2] > ao[1] + ao[3]) {
            ind.push(vcount + 1, vcount + 2, vcount + 3, vcount + 1, vcount + 3, vcount);
          } else {
            ind.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
          }
          vcount += 4;
        }
      }
    }
  }

  if (vcount === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(vcount > 65535
    ? new THREE.BufferAttribute(new Uint32Array(ind), 1)
    : new THREE.BufferAttribute(new Uint16Array(ind), 1));
  geo.computeBoundingSphere();
  return geo;
}
