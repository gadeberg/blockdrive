// The car, built out of boxes so it belongs in a world made of boxes.

import * as THREE from 'three';

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export function buildCar(bodyColor = 0xe0483a) {
  const group = new THREE.Group();

  const paint = mat(bodyColor);
  const dark = mat(0x22262e);
  const glass = mat(0x1a2733);
  const chrome = mat(0xb9c0cb);
  const lamp = mat(0xfff2c0, { emissive: 0xffe08a, emissiveIntensity: 0.9 });
  const tail = mat(0x8c1f1a, { emissive: 0xd8261c, emissiveIntensity: 0.55 });

  const shell = new THREE.Group();
  // The physics origin sits at the centre of mass; drop the bodywork a little
  // so the car reads as a car and not a lifted truck.
  shell.position.y = -0.16;

  shell.add(box(1.62, 0.40, 3.56, paint, 0, 0.00, 0));      // main body
  shell.add(box(1.68, 0.20, 2.90, dark, 0, -0.22, 0));      // sills / underbody
  shell.add(box(1.50, 0.16, 1.40, paint, 0, 0.22, 1.02));   // bonnet
  shell.add(box(1.50, 0.16, 0.90, paint, 0, 0.22, -1.30));  // boot lid

  shell.add(box(1.44, 0.40, 1.52, glass, 0, 0.42, -0.16));  // greenhouse
  shell.add(box(0.07, 0.40, 1.52, paint, -0.73, 0.42, -0.16)); // pillars
  shell.add(box(0.07, 0.40, 1.52, paint,  0.73, 0.42, -0.16));
  shell.add(box(1.48, 0.12, 1.60, paint, 0, 0.66, -0.18));  // roof

  shell.add(box(1.66, 0.24, 0.26, dark, 0, 0.02, 1.76));    // front bumper
  shell.add(box(1.66, 0.24, 0.26, dark, 0, 0.02, -1.76));   // rear bumper
  shell.add(box(1.30, 0.10, 0.16, chrome, 0, 0.16, 1.80));  // grille

  // spoiler
  shell.add(box(1.34, 0.07, 0.32, dark, 0, 0.52, -1.62));
  shell.add(box(0.10, 0.18, 0.10, dark, -0.52, 0.42, -1.58));
  shell.add(box(0.10, 0.18, 0.10, dark,  0.52, 0.42, -1.58));

  // lights
  shell.add(box(0.34, 0.16, 0.10, lamp, -0.52, 0.10, 1.83));
  shell.add(box(0.34, 0.16, 0.10, lamp,  0.52, 0.10, 1.83));
  shell.add(box(0.36, 0.14, 0.10, tail, -0.50, 0.12, -1.83));
  shell.add(box(0.36, 0.14, 0.10, tail,  0.50, 0.12, -1.83));

  // mirrors
  shell.add(box(0.16, 0.09, 0.12, chrome, -0.84, 0.40, 0.52));
  shell.add(box(0.16, 0.09, 0.12, chrome,  0.84, 0.40, 0.52));

  group.add(shell);

  // --- wheels: pivot handles steering, inner mesh handles roll
  const tyreGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 16);
  tyreGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.32, 8);
  hubGeo.rotateZ(Math.PI / 2);

  const tyreMat = mat(0x1b1d21);
  const hubMat = mat(0xd7dce4);

  const pivots = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    const wheel = new THREE.Group();

    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = true;
    wheel.add(tyre);

    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.castShadow = true;
    wheel.add(hub);

    // a spoke bar makes the spin readable
    const spoke = box(0.34, 0.07, 0.07, hubMat, 0, 0, 0);
    wheel.add(spoke);

    pivot.add(wheel);
    group.add(pivot);
    pivots.push({ pivot, wheel });
  }

  // headlight cones, switched on at dusk-ish light levels / in tunnels
  const beam = new THREE.SpotLight(0xfff0cc, 0, 40, Math.PI / 6, 0.5, 1.2);
  beam.position.set(0, 0.1, 1.9);
  beam.target.position.set(0, -0.6, 12);
  group.add(beam, beam.target);

  return { group, pivots, beam };
}
