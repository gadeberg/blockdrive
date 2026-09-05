// First-person walker: an AABB that slides along voxels, with Minecraft-style
// auto-stepping so kerbs and single blocks don't stop you.

import * as THREE from 'three';

const P = {
  width: 0.6,
  height: 1.8,
  eye: 1.62,

  walk: 4.6,
  sprint: 7.4,
  groundAccel: 60,
  airAccel: 20,

  gravity: 26,
  jump: 8.4,
  terminal: 58,

  // Minecraft uses 0.6, which works because it has slabs and stairs. Every
  // riser in this world is exactly one block, so 0.6 would never fire and you
  // would be jumping over literally every bump in the terrain.
  stepHeight: 1.05,
};

const EPS = 1e-4;
const approach = (v, target, maxDelta) => {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
};

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3();   // centre of the feet
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.height = P.height;
    this._wish = new THREE.Vector3();
  }

  get eyeY() { return this.pos.y + P.eye; }

  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.eyeY, this.pos.z);
  }

  /** Unit look direction from yaw/pitch. */
  lookDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  placeAt(x, y, z, yaw = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.onGround = false;
  }

  // --- movement ------------------------------------------------------------

  /** input: { forward, strafe, jump, sprint } */
  update(dt, input, obstacle) {
    // forward is +Z at yaw 0; right = forward × up
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const wish = this._wish.set(
      s * input.forward - c * input.strafe,
      0,
      c * input.forward + s * input.strafe,
    );
    const len = wish.length();
    if (len > 1) wish.divideScalar(len);

    const speed = (input.sprint && input.forward > 0) ? P.sprint : P.walk;
    const accel = (this.onGround ? P.groundAccel : P.airAccel) * dt;
    this.vel.x = approach(this.vel.x, wish.x * speed, accel);
    this.vel.z = approach(this.vel.z, wish.z * speed, accel);

    if (input.jump && this.onGround) {
      this.vel.y = P.jump;
      this.onGround = false;
    }

    this.vel.y = Math.max(this.vel.y - P.gravity * dt, -P.terminal);

    this.onGround = false;
    this._moveY(this.vel.y * dt);
    this._moveHorizontal('x', this.vel.x * dt);
    this._moveHorizontal('z', this.vel.z * dt);

    if (obstacle) this._pushOutOf(obstacle);
  }

  /** Does the player box overlap solid blocks at the current position? */
  _overlaps() {
    const hw = P.width / 2;
    const { x, y, z } = this.pos;
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
    const y0 = Math.floor(y + EPS), y1 = Math.floor(y + P.height - EPS);
    const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (this.world.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Move along one axis, binary-searching back to the contact point if we end
   * up inside something. Returns true if the move was blocked.
   */
  _move(axis, d) {
    if (d === 0) return false;
    const start = this.pos[axis];
    this.pos[axis] = start + d;
    if (!this._overlaps()) return false;

    let free = 0;
    let hit = d;
    for (let i = 0; i < 10; i++) {
      const mid = (free + hit) / 2;
      this.pos[axis] = start + mid;
      if (this._overlaps()) hit = mid; else free = mid;
    }
    this.pos[axis] = start + free;
    return true;
  }

  _moveY(d) {
    if (this._move('y', d)) {
      if (d < 0) this.onGround = true;
      this.vel.y = 0;
    }
  }

  _moveHorizontal(axis, d) {
    const startA = this.pos[axis];
    const startY = this.pos.y;
    if (!this._move(axis, d)) return;

    // Blocked. Airborne, keep the velocity: pressing into a ledge and jumping
    // should carry you onto it the moment your feet clear the top.
    const blockedA = this.pos[axis];
    if (!this.onGround) return;

    this.pos[axis] = startA;
    this.pos.y = startY + P.stepHeight;
    if (this._overlaps()) {          // no headroom to step into
      this.pos.y = startY;
      this.pos[axis] = blockedA;
      this.vel[axis] = 0;
      return;
    }
    const carried = this.vel[axis];

    this._move(axis, d);
    if (Math.abs(this.pos[axis] - startA) <= Math.abs(blockedA - startA) + EPS) {
      this.pos.y = startY;           // stepping up gained nothing
      this.pos[axis] = blockedA;
      this.vel[axis] = 0;
      return;
    }
    this.vel[axis] = carried;        // the step cost us no speed
    this._move('y', -P.stepHeight);  // settle onto the step
    this.onGround = true;
  }

  /**
   * Keep the player out of the parked car. Approximated as box vs box in the
   * car's local frame — close enough that you can't walk through your own boot.
   */
  _pushOutOf(ob) {
    const hw = P.width / 2;
    const local = ob.tmp
      .set(this.pos.x, this.pos.y + P.height / 2, this.pos.z)
      .sub(ob.pos)
      .applyQuaternion(ob.invQuat);

    const ex = ob.half.x + hw;
    const ey = ob.half.y + P.height / 2;
    const ez = ob.half.z + hw;
    if (Math.abs(local.x) >= ex || Math.abs(local.y) >= ey || Math.abs(local.z) >= ez) return;

    const dx = ex - Math.abs(local.x);
    const dy = ey - Math.abs(local.y);
    const dz = ez - Math.abs(local.z);

    // push along whichever local axis needs the least movement, but never
    // downward — being shoved into the ground is worse than any overlap
    if (dy <= dx && dy <= dz && local.y > 0) {
      local.set(0, dy, 0);
    } else if (dx < dz) {
      local.set(Math.sign(local.x) * dx, 0, 0);
    } else {
      local.set(0, 0, Math.sign(local.z) * dz);
    }

    local.applyQuaternion(ob.quat);
    this.pos.add(local);
    if (local.y > 0) {
      this.onGround = true;
      if (this.vel.y < 0) this.vel.y = 0;
    }
  }
}

export const PLAYER_PARAMS = P;
