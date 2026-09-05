// Streams chunk meshes in and out around the car, on a per-frame time budget
// so generation never blocks the render loop for long.

import * as THREE from 'three';
import { CH_X, CH_Z, chunkKey } from './world.js';
import { buildChunkGeometry } from './mesher.js';
import { buildAtlasTexture } from './blocks.js';

export class Terrain {
  constructor(world, scene, viewDistance = 7, anisotropy = 1) {
    this.world = world;
    this.scene = scene;
    this.viewDistance = viewDistance;

    this.material = new THREE.MeshLambertMaterial({
      map: buildAtlasTexture(anisotropy),
      vertexColors: true,
    });

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    this.meshes = new Map();
    this.pending = [];
    this.urgent = new Set();
    this.centerKey = null;

    world.onChange((cx, cz) => this.urgent.add(chunkKey(cx, cz)));
  }

  // Rebuild the work list when the car crosses into a new chunk.
  update(worldX, worldZ) {
    const cx = Math.floor(worldX / CH_X);
    const cz = Math.floor(worldZ / CH_Z);
    const key = chunkKey(cx, cz);
    if (key === this.centerKey) return;
    this.centerKey = key;
    this.cx = cx;
    this.cz = cz;

    const R = this.viewDistance;
    const todo = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R) continue;
        todo.push({ cx: cx + dx, cz: cz + dz, d2 });
      }
    }
    todo.sort((a, b) => a.d2 - b.d2);
    this.pending = todo;

    this._evict(cx, cz, R + 2);
  }

  _evict(cx, cz, keep) {
    for (const [key, mesh] of this.meshes) {
      const [mx, mz] = key.split(',').map(Number);
      if (Math.abs(mx - cx) > keep || Math.abs(mz - cz) > keep) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(key);
      }
    }
  }

  _build(cx, cz) {
    const world = this.world;
    // Neighbour data must exist or the mesher would wall off the chunk edge.
    world.ensureChunk(cx, cz);
    world.ensureChunk(cx + 1, cz);
    world.ensureChunk(cx - 1, cz);
    world.ensureChunk(cx, cz + 1);
    world.ensureChunk(cx, cz - 1);

    const chunk = world.getChunk(cx, cz);
    const key = chunkKey(cx, cz);
    const old = this.meshes.get(key);
    const geo = buildChunkGeometry(world, chunk);
    chunk.dirty = false;

    if (!geo) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        this.meshes.delete(key);
      }
      return;
    }

    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
      return;
    }

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.meshes.set(key, mesh);
    this.group.add(mesh);
  }

  // Returns the number of chunks still queued.
  step(budgetMs = 6) {
    const t0 = performance.now();

    // Player edits jump the queue — a dug block must vanish this frame.
    for (const key of this.urgent) {
      const [cx, cz] = key.split(',').map(Number);
      this._build(cx, cz);
    }
    this.urgent.clear();

    while (this.pending.length) {
      const next = this.pending[0];
      const key = chunkKey(next.cx, next.cz);
      const chunk = this.world.getChunk(next.cx, next.cz);
      if (this.meshes.has(key) && chunk && !chunk.dirty) {
        this.pending.shift();
        continue;
      }
      this.pending.shift();
      this._build(next.cx, next.cz);
      if (performance.now() - t0 > budgetMs) break;
    }
    return this.pending.length;
  }

  /** Drop every mesh — used when swapping to a different world. */
  clear() {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.pending = [];
    this.urgent.clear();
    this.centerKey = null;
  }

  // Blocking build of everything within `radius` — used for the initial load
  // so the first frame isn't a hole in the ground.
  preload(worldX, worldZ, radius = 4) {
    const cx = Math.floor(worldX / CH_X);
    const cz = Math.floor(worldZ / CH_Z);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        this._build(cx + dx, cz + dz);
      }
    }
  }
}
