// Keyboard, pointer-lock mouse look, and edge-triggered mouse buttons.

export class Input {
  constructor(element) {
    this.el = element;
    this.keys = new Set();
    this.locked = false;
    this.pointerLockFailed = false;   // some embedded contexts refuse it

    this.lookX = 0;      // accumulated mouse delta, consumed each frame
    this.lookY = 0;
    this.scroll = 0;
    this.slotPressed = null;
    this.justPressed = new Set();   // key-down edges, consumed each frame

    // click edges (single shot) and held state (for continuous digging)
    this.clicked = [false, false, false];
    this.held = [false, false, false];

    this.onEscape = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.justPressed.add(k);
      if (k.startsWith('Digit')) {
        const n = Number(k.slice(5));
        if (n >= 1 && n <= 8) this.slotPressed = n - 1;
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) {
        e.preventDefault();
      }
      // Without pointer lock there is no lock-exit event, so Escape has to be
      // wired up by hand.
      if (k === 'Escape' && this.pointerLockFailed && this.locked) {
        this.locked = false;
        if (this.onEscape) this.onEscape();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    element.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.clicked[e.button] = true;
      this.held[e.button] = true;
    });
    addEventListener('mouseup', (e) => { this.held[e.button] = false; });
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });

    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.scroll += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === element) {
        this.locked = true;
        this.pointerLockFailed = false;
        return;
      }
      // In fallback mode we never held a real lock, so a stray change event
      // isn't the player pressing Escape — don't pause the game on it.
      if (this.pointerLockFailed) return;
      this.locked = false;
      this.held = [false, false, false];
      this.keys.clear();
      if (this.onEscape) this.onEscape();
    });
  }

  lock() {
    let promise;
    try {
      promise = this.el.requestPointerLock();
    } catch {
      this._fallback();
      return;
    }
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => this._fallback());
    }
    // Older browsers fail silently; if the lock never lands, fall back anyway.
    setTimeout(() => { if (!this.locked) this._fallback(); }, 400);
  }

  // Play without pointer lock: mouse movement still reports deltas and clicks
  // still work, you just keep your cursor.
  _fallback() {
    if (this.locked) return;
    this.pointerLockFailed = true;
    this.locked = true;
  }

  down(...codes) { return codes.some((c) => this.keys.has(c)); }

  /** Snapshot of on-foot inputs for this frame. */
  walking() {
    const fwd = this.down('KeyW', 'ArrowUp');
    const back = this.down('KeyS', 'ArrowDown');
    const left = this.down('KeyA', 'ArrowLeft');
    const right = this.down('KeyD', 'ArrowRight');
    return {
      forward: (fwd ? 1 : 0) + (back ? -1 : 0),
      strafe: (right ? 1 : 0) + (left ? -1 : 0),
      jump: this.down('Space'),
      sprint: this.down('ShiftLeft', 'ShiftRight'),
    };
  }

  /** Snapshot of driving inputs for this frame. */
  driving() {
    const up = this.down('KeyW', 'ArrowUp');
    const dn = this.down('KeyS', 'ArrowDown');
    const left = this.down('KeyA', 'ArrowLeft');
    const right = this.down('KeyD', 'ArrowRight');
    return {
      throttle: (up ? 1 : 0) + (dn ? -1 : 0),
      steer: (right ? 1 : 0) + (left ? -1 : 0),
      handbrake: this.down('Space'),
      brake: this.down('KeyC'),
      boost: this.down('ShiftLeft', 'ShiftRight'),
    };
  }

  /** Read and clear the per-frame edge events. */
  consume() {
    const out = {
      look: [this.lookX, this.lookY],
      scroll: this.scroll,
      slot: this.slotPressed,
      click: this.clicked.slice(),
      keys: this.justPressed,
    };
    this.lookX = this.lookY = 0;
    this.scroll = 0;
    this.slotPressed = null;
    this.clicked = [false, false, false];
    this.justPressed = new Set();
    return out;
  }
}
