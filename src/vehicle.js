// Arcade car: a box rigid body with four raycast wheels.
//
// Each wheel casts down into the voxel grid, a spring/damper carries the
// chassis, and a tyre model turns wheel-plane velocity into forces inside a
// friction circle. Surface grip comes from the block under the tyre, so tarmac
// bites and sand doesn't.

import * as THREE from 'three';
import { B, gripOf } from './blocks.js';

const GRAVITY = 22;          // arcade gravity — heavier than real, feels planted
const DT = 1 / 120;          // fixed physics step
const MAX_SUBSTEPS = 5;

const P = {
  mass: 1000,
  half: new THREE.Vector3(0.85, 0.42, 1.85),

  // The collision proxy is shorter and sits higher than the painted body, so
  // the wheels meet the ground first instead of the sills beaching on it.
  colHalf: new THREE.Vector3(0.78, 0.34, 1.76),
  colOffsetY: 0.15,
  // A voxel landscape is a staircase of one-block risers. Anything up to this
  // is climbed rather than crashed into; taller faces are still walls.
  stepHeight: 1.05,

  wheelRadius: 0.38,
  susRest: 0.45,
  susStiff: 46000,
  susDamp: 2700,
  susMaxForce: 27000,
  // Tyre forces really act at the contact patch, but that long lever arm makes
  // a light arcade car wheelie and trip over itself. Raising the application
  // point toward the centre of mass keeps some squat and roll without the flips.
  tyreForceLift: 0.55,

  engineForce: 15000,
  reverseForce: 7000,
  brakeForce: 20000,
  boostMul: 1.7,
  dragK: 4.0,             // quadratic drag -> ~200 km/h flat out
  rollResist: 0.02,

  baseGrip: 1.35,         // multiplied by the surface's own grip
  handbrakeGrip: 0.34,
  downforce: 3.6,

  maxSteer: 0.56,
  steerSpeedFalloff: 0.74,
  steerRate: 5.0,

  // Airborne behaviour. Throttle is held almost constantly while driving, so
  // mapping it to pitch would front-flip the car off every jump. Instead the
  // car self-levels in the air and steering gives a little yaw authority to
  // aim the landing.
  airYaw: 2.6,
  airLevel: 14.0,
  airTumbleDamp: 0.2,   // per-second retention of pitch/roll while airborne
  angularDamp: 0.9,       // per-second retention while grounded

  restitution: 0.08,      // chassis vs blocks
  hitFriction: 0.45,
};

const UP = new THREE.Vector3(0, 1, 0);

class Wheel {
  constructor(x, y, z, steering, drive) {
    this.local = new THREE.Vector3(x, y, z);
    this.steering = steering;
    this.drive = drive;
    this.radius = P.wheelRadius;

    this.world = new THREE.Vector3();   // suspension attach point, world space
    this.contact = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.grounded = false;
    this.compression = 0;
    this.suspensionLength = P.susRest;
    this.spin = 0;        // visual roll angle
    this.slip = 0;        // 0..1, how far past the friction limit
    this.block = 0;       // surface block id under this wheel
  }
}

export class Vehicle {
  constructor(world) {
    this.world = world;

    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();

    const s = P.half.clone().multiplyScalar(2);
    const m = P.mass;
    // inverse inertia of a solid box, in body space
    this.invI0 = new THREE.Vector3(
      12 / (m * (s.y * s.y + s.z * s.z)),
      12 / (m * (s.x * s.x + s.z * s.z)),
      12 / (m * (s.x * s.x + s.y * s.y)),
    );

    const wx = 0.78, wy = -0.28, wz = 1.28;
    this.wheels = [
      new Wheel(-wx, wy,  wz, true,  true),
      new Wheel( wx, wy,  wz, true,  true),
      new Wheel(-wx, wy, -wz, false, true),
      new Wheel( wx, wy, -wz, false, true),
    ];

    this.steer = 0;
    this.groundedCount = 0;
    this.impact = 0;       // set on a hard collision, decays; drives camera shake
    this.airborne = 0;     // seconds since last ground contact
    this.stuck = 0;        // seconds spent with the hull inside terrain

    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._t3 = new THREE.Vector3();
    // scratch vectors — each helper owns its own so nothing aliases
    this._r = new THREE.Vector3();    // applyForce
    this._pv = new THREE.Vector3();   // pointVelocity
    this._si = new THREE.Vector3();   // applyImpulse
    this._sj = new THREE.Vector3();
    this._af = new THREE.Vector3();   // applyForce
    this._fs = new THREE.Vector3();   // suspension force
    this._ri = new THREE.Vector3();   // contact solver
    this._rj = new THREE.Vector3();
    this._rk = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._invQuat = new THREE.Quaternion();
    this._acc = 0;
  }

  // --- helpers ------------------------------------------------------------

  forward(out = new THREE.Vector3()) { return out.set(0, 0, 1).applyQuaternion(this.quat); }
  // With forward = +Z and up = +Y in a right-handed frame, the car's right
  // hand side is local -X. Getting this wrong mirrors the steering.
  right(out = new THREE.Vector3())   { return out.set(-1, 0, 0).applyQuaternion(this.quat); }
  up(out = new THREE.Vector3())      { return out.set(0, 1, 0).applyQuaternion(this.quat); }

  /** Signed forward speed in m/s. */
  get speed() { return this.vel.dot(this.forward(this._t3)); }

  pointVelocity(point, out) {
    this._pv.copy(point).sub(this.pos);
    return out.copy(this.angVel).cross(this._pv).add(this.vel);
  }

  /** v := I⁻¹_world · v, in place. */
  _iinvWorld(v) {
    return v.applyQuaternion(this._invQuat).multiply(this.invI0).applyQuaternion(this.quat);
  }

  applyImpulse(imp, point) {
    this.vel.addScaledVector(imp, 1 / P.mass);
    const r = this._si.copy(point).sub(this.pos);
    const t = this._iinvWorld(this._sj.copy(r).cross(imp));
    this.angVel.add(t);
  }

  applyForce(f, point) {
    this._force.add(f);
    this._r.copy(point).sub(this.pos);
    this._torque.add(this._af.copy(this._r).cross(f));
  }

  reset(x, y, z, heading = 0) {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(UP, heading);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.steer = 0;
    this.impact = 0;
    this.stuck = 0;
  }

  // Crashing into a hillside at speed can wedge the hull inside the blocks,
  // where opposing pushes cancel out and nothing frees it. Rather than leave
  // the player buried, lift the car back onto the surface.
  unstick() {
    this.pos.y = Math.max(this.pos.y, this.world.surfaceY(this.pos.x, this.pos.z) + 1.2);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    const f = this.forward(this._t1);
    this.quat.setFromAxisAngle(UP, Math.atan2(f.x, f.z));
    this.stuck = 0;
  }

  /** Rotate upright in place, keeping heading — the "I'm on my roof" key. */
  flipUpright() {
    const f = this.forward(this._t1);
    const heading = Math.atan2(f.x, f.z);
    this.quat.setFromAxisAngle(UP, heading);
    this.angVel.set(0, 0, 0);
    this.vel.y = 0;
    this.pos.y += 1.2;
  }

  // --- main step ----------------------------------------------------------

  update(dt, input) {
    this._acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this._acc >= DT && steps < MAX_SUBSTEPS) {
      this._step(DT, input);
      this._acc -= DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._acc = 0; // don't build a backlog

    if (this.world.isSolid(
      Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z))) {
      this.stuck += dt;
      if (this.stuck > 0.35) this.unstick();
    } else {
      this.stuck = 0;
    }

    this.impact *= Math.pow(0.02, dt);
    for (const w of this.wheels) {
      const v = w.grounded ? this.speed : this.speed * 0.6;
      w.spin += (v / w.radius) * dt;
    }
  }

  _step(dt, input) {
    this._force.set(0, 0, 0);
    this._torque.set(0, 0, 0);
    this._invQuat.copy(this.quat).invert();

    // steering angle eases toward the target and tightens up with speed
    const spd = Math.abs(this.speed);
    const limit = P.maxSteer * (1 - P.steerSpeedFalloff * Math.min(spd / 42, 1));
    const target = input.steer * limit;
    const rate = P.steerRate * dt;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate, rate);

    // gravity
    this._force.y -= P.mass * GRAVITY;

    // air drag
    const v2 = this.vel.lengthSq();
    if (v2 > 0.01) {
      this._force.addScaledVector(this._t1.copy(this.vel).normalize(), -P.dragK * v2);
    }

    this._wheelForces(dt, input);

    if (this.groundedCount > 0) {
      // downforce along the body's own up, so it still works on banked ground
      const down = this.up(this._t1).multiplyScalar(-P.downforce * v2);
      this._force.add(down);
      this.airborne = 0;
    } else {
      this.airborne += dt;
      this._airControl(input);
    }

    // integrate linear
    this.vel.addScaledVector(this._force, dt / P.mass);

    // integrate angular: ω += R · I⁻¹ · Rᵀ · τ · dt
    const t = this._iinvWorld(this._t1.copy(this._torque));
    this.angVel.addScaledVector(t, dt);

    const damp = Math.pow(this.groundedCount > 0 ? P.angularDamp : 0.55, dt);
    this.angVel.multiplyScalar(damp);

    this.pos.addScaledVector(this.vel, dt);
    this._integrateRotation(dt);
    this._resolveCollisions();

    // settle: kill the last bit of creep so a parked car stays parked
    if (this.groundedCount > 0 && spd < 0.35 && input.throttle === 0) {
      this.vel.multiplyScalar(Math.pow(0.02, dt));
      this.angVel.multiplyScalar(Math.pow(0.02, dt));
    }
  }

  _integrateRotation(dt) {
    const { x: wx, y: wy, z: wz } = this.angVel;
    const q = this.quat;
    const dx = 0.5 * ( wx * q.w + wy * q.z - wz * q.y);
    const dy = 0.5 * ( wy * q.w + wz * q.x - wx * q.z);
    const dz = 0.5 * ( wz * q.w + wx * q.y - wy * q.x);
    const dw = 0.5 * (-wx * q.x - wy * q.y - wz * q.z);
    q.set(q.x + dx * dt, q.y + dy * dt, q.z + dz * dt, q.w + dw * dt).normalize();
  }

  // --- wheels -------------------------------------------------------------

  _wheelForces(dt, input) {
    const world = this.world;
    const down = this.up(new THREE.Vector3()).multiplyScalar(-1);
    const fwdBody = this.forward(new THREE.Vector3());
    const rightBody = this.right(new THREE.Vector3());

    this.groundedCount = 0;
    const maxLen = P.susRest + P.wheelRadius;

    // engine force is shared between the driven wheels
    const boost = input.boost ? P.boostMul : 1;
    let drive = 0;
    if (input.throttle > 0) drive = P.engineForce * input.throttle * boost;
    else if (input.throttle < 0) drive = -P.reverseForce * -input.throttle;

    for (const w of this.wheels) {
      w.world.copy(w.local).applyQuaternion(this.quat).add(this.pos);

      const hit = this._probe(w.world, down, fwdBody, maxLen);
      if (!hit) {
        w.grounded = false;
        w.compression = 0;
        w.suspensionLength = P.susRest;
        w.slip *= 0.9;
        continue;
      }

      w.grounded = true;
      this.groundedCount++;
      w.block = hit.block;
      w.suspensionLength = Math.max(0, hit.dist - P.wheelRadius);
      w.compression = maxLen - hit.dist;
      w.contact.copy(w.world).addScaledVector(down, hit.dist);
      w.normal.copy(hit.normal);

      // --- suspension
      const pv = this.pointVelocity(w.world, this._t1);
      const velAlongDown = pv.dot(down);
      let susF = P.susStiff * w.compression + P.susDamp * velAlongDown;
      susF = THREE.MathUtils.clamp(susF, 0, P.susMaxForce);
      this.applyForce(this._fs.copy(down).multiplyScalar(-susF), w.world);

      if (susF <= 0) { w.slip *= 0.9; continue; }

      // --- tyre plane
      const n = w.normal;
      let fwd = this._t1.copy(fwdBody);
      if (w.steering) {
        // rotate the wheel's forward around the body up by the steer angle
        const s = Math.sin(this.steer), c = Math.cos(this.steer);
        fwd.set(
          fwdBody.x * c + rightBody.x * s,
          fwdBody.y * c + rightBody.y * s,
          fwdBody.z * c + rightBody.z * s,
        );
      }
      fwd.addScaledVector(n, -fwd.dot(n));
      if (fwd.lengthSq() < 1e-6) { w.slip *= 0.9; continue; }
      fwd.normalize();
      const side = this._t2.copy(n).cross(fwd).normalize();

      const cv = this.pointVelocity(w.contact, this._t3);
      const vFwd = cv.dot(fwd);
      const vSide = cv.dot(side);

      // --- friction circle
      const rear = !w.steering;
      let mu = P.baseGrip * gripOf(w.block);
      if (input.handbrake && rear) mu *= P.handbrakeGrip;
      const limit = mu * susF;

      const quarter = P.mass / 4;
      // force that would exactly cancel sideways slip this step
      let fSide = -vSide * quarter / dt;

      let fFwd = w.drive ? drive / 4 : 0;
      if (input.brake) {
        fFwd += -Math.sign(vFwd) * Math.min(P.brakeForce / 4, Math.abs(vFwd) * quarter / dt);
      } else if (input.handbrake && rear) {
        fFwd += -Math.sign(vFwd) * Math.min(P.brakeForce / 6, Math.abs(vFwd) * quarter / dt);
      } else if (input.throttle === 0) {
        // rolling resistance + engine braking
        fFwd += -Math.sign(vFwd) * Math.min(P.rollResist * susF + Math.abs(vFwd) * 26, Math.abs(vFwd) * quarter / dt);
      }

      const mag = Math.hypot(fFwd, fSide);
      if (mag > limit && mag > 0) {
        const k = limit / mag;
        fFwd *= k;
        fSide *= k;
        w.slip = Math.min(1, (mag / limit - 1) * 0.35);
      } else {
        w.slip *= 0.85;
      }

      this._t1.copy(fwd).multiplyScalar(fFwd).addScaledVector(side, fSide);
      this._rk.copy(w.contact).addScaledVector(n, P.tyreForceLift);
      this.applyForce(this._t1, this._rk);
    }
  }

  // Three probes per wheel (back / centre / front of the contact patch) and we
  // take the highest ground. A single ray makes voxel stair-steps feel like
  // driving into a kerb; this rolls over them.
  _probe(origin, down, fwd, maxLen) {
    const offsets = [-0.26, 0, 0.26];
    let best = null;
    for (const o of offsets) {
      const ox = origin.x + fwd.x * o;
      const oy = origin.y + fwd.y * o;
      const oz = origin.z + fwd.z * o;
      const hit = this.world.raycast(ox, oy, oz, down.x, down.y, down.z, maxLen, B.LEAVES);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) {
        best = {
          dist: hit.dist,
          block: hit.block,
          normal: new THREE.Vector3(hit.nx, hit.ny, hit.nz),
        };
      }
    }
    if (best && best.normal.lengthSq() === 0) best.normal.set(0, 1, 0);
    return best;
  }

  // --- airborne stunt control --------------------------------------------

  _airControl(input) {
    if (this.airborne < 0.08) return;

    this.angVel.y += input.steer * P.airYaw * DT;

    // Damp tumble hard, but leave yaw alone so the steering above still bites.
    // Launching off a crest unloads the front suspension first and imparts a
    // nose-down pitch; unchecked, every jump ends on the roof.
    const yaw = this.angVel.dot(UP);
    const tumble = this._t3.copy(this.angVel).addScaledVector(UP, -yaw);
    tumble.multiplyScalar(Math.pow(P.airTumbleDamp, DT));
    this.angVel.copy(tumble).addScaledVector(UP, yaw);

    // rotate the body's up back toward world up
    const up = this.up(this._t1);
    const axis = this._t2.copy(up).cross(UP);
    const sin = axis.length();
    if (sin > 1e-5) {
      axis.divideScalar(sin);
      // past 90 degrees sin falls off again, so drive inverted cars at full tilt
      const strength = up.dot(UP) < 0 ? 1 : sin;
      this.angVel.addScaledVector(axis, strength * P.airLevel * DT);
    }
  }

  // --- chassis vs voxels --------------------------------------------------

  _resolveCollisions() {
    const h = P.colHalf;
    this._invQuat.copy(this.quat).invert();

    const push = this._t1.set(0, 0, 0);
    let hits = 0;
    let buried = 0;   // corners inside rock with every escape face blocked
    let lift = 0;     // how far up we'd have to rise to drive over a kerb

    for (let i = 0; i < 8; i++) {
      const low = (i & 2) === 0;
      const lx = (i & 1 ? h.x : -h.x) * 0.96;
      const ly = (low ? -h.y : h.y) * 0.96 + P.colOffsetY;
      const lz = (i & 4 ? h.z : -h.z) * 0.96;

      const p = this._t3.set(lx, ly, lz).applyQuaternion(this.quat).add(this.pos);
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      const block = this.world.getBlock(bx, by, bz);
      if (block === B.AIR) continue;

      // Foliage never stops a car — at speed you tear straight through it.
      if (block === B.LEAVES) {
        if (this.vel.lengthSq() > 16) this.world.setBlock(bx, by, bz, B.AIR);
        continue;
      }

      // smallest translation out of this block's AABB
      const dxn = p.x - bx, dxp = bx + 1 - p.x;
      const dyn = p.y - by, dyp = by + 1 - p.y;
      const dzn = p.z - bz, dzp = bz + 1 - p.z;

      let depth = dxn, ax = -1, ay = 0, az = 0;
      if (dxp < depth) { depth = dxp; ax = 1; ay = 0; az = 0; }
      if (dyn < depth) { depth = dyn; ax = 0; ay = -1; az = 0; }
      if (dyp < depth) { depth = dyp; ax = 0; ay = 1; az = 0; }
      if (dzn < depth) { depth = dzn; ax = 0; ay = 0; az = -1; }
      if (dzp < depth) { depth = dzp; ax = 0; ay = 0; az = 1; }

      // A low corner pressed against a face it could simply ride over: take the
      // step instead of the wall.
      if (low && ay === 0 && this.groundedCount > 0 && !this.world.isSolid(bx, by + 1, bz)) {
        const need = by + 1.02 - p.y;
        if (need > 0 && need <= P.stepHeight) {
          lift = Math.max(lift, need);
          continue;
        }
      }

      // never push out through a face that is buried in more solid blocks
      if (this.world.isSolid(bx + ax, by + ay, bz + az)) { buried++; continue; }

      hits++;
      push.x += ax * depth;
      push.y += ay * depth;
      push.z += az * depth;

      this._contactImpulse(p, this._n.set(ax, ay, az));
    }

    if (lift > 0) {
      this.pos.y += lift;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    if (!hits) {
      // Wholly inside the terrain — a fast landing on a steep face can do it.
      // Nothing sensible to push against, so climb straight out.
      if (buried) {
        this.pos.y += 0.3;
        if (this.vel.y < 0) this.vel.y = 0;
        this.angVel.multiplyScalar(0.5);
      }
      return;
    }
    push.divideScalar(hits);
    this.pos.addScaledVector(push, 0.85);
  }

  // Sequential impulse for one corner touching one block face. Without the
  // angular part the car can balance on a bumper indefinitely.
  _contactImpulse(point, n) {
    const v = this.pointVelocity(point, this._t2);
    const vn = v.dot(n);
    if (vn >= 0) return;

    const r = this._r.copy(point).sub(this.pos);

    // effective mass along the normal: 1/m + n · ((I⁻¹(r × n)) × r)
    const rn = this._iinvWorld(this._ri.copy(r).cross(n));
    const kn = 1 / P.mass + rn.cross(r).dot(n);
    if (kn <= 0) return;

    const jn = (-(1 + P.restitution) * vn) / kn;
    this.impact = Math.max(this.impact, Math.min(1, -vn / 20));

    this._rj.copy(n).multiplyScalar(jn);
    this.applyImpulse(this._rj, point);

    // tangential scrape so walls don't act like ice
    const v2 = this.pointVelocity(point, this._t2);
    const vt = this._rk.copy(v2).addScaledVector(n, -v2.dot(n));
    const speed = vt.length();
    if (speed > 0.05) {
      vt.divideScalar(speed);
      const rt = this._iinvWorld(this._ri.copy(r).cross(vt));
      const kt = 1 / P.mass + rt.cross(r).dot(vt);
      if (kt > 0) {
        const jt = Math.max(-speed / kt, -P.hitFriction * jn);
        this._rj.copy(vt).multiplyScalar(jt);
        this.applyImpulse(this._rj, point);
      }
    }
  }
}

export const CAR_PARAMS = P;
