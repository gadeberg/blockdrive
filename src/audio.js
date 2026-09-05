// Everything you hear, synthesised at runtime. No audio files.
//
// One persistent graph handles the continuous layers (engine, tyres, wind,
// ambience); short events (crashes, blocks, birds) build tiny throwaway graphs.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Peak bus gains, calibrated by measuring each chain's RMS with an
// AnalyserNode rather than by guesswork. For reference the engine runs at
// about 0.065 RMS flat out.
const MIX = {
  squeal: 0.16,    // ~0.030 RMS at full slip, ~7 dB under the engine
  wind: 0.085,     // ~0.007 RMS at speed
  ambient: 0.07,   // ~0.005 RMS at rest — a bed, not a feature
  // One-shots. Filtered noise bursts lose most of their energy, so these are
  // far larger than they look; they were inaudible under the engine at 0.16.
  block: 0.9,
  bird: 0.09,
};

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.rpm = 0;
    this.squeal = 0;
    this.birdTimer = 2;
    this.lastCrash = -1;
    this.time = 0;
  }

  /** Must be called from a user gesture — browsers won't start audio otherwise. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    // master bus: a compressor keeps the engine from clipping on top of a crash
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);

    // two seconds of white noise, reused by every noise-based voice
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this._buildEngine();
    this._buildTyres();
    this._buildWind();
    this._buildAmbience();
  }

  _loop(dest) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(dest);
    src.start();
    return src;
  }

  _buildEngine() {
    const ctx = this.ctx;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);

    // one lowpass shapes the whole engine; opening it with revs is most of
    // what makes an engine sound like it's working
    this.engineLP = ctx.createBiquadFilter();
    this.engineLP.type = 'lowpass';
    this.engineLP.frequency.value = 400;
    this.engineLP.Q.value = 1.1;
    this.engineLP.connect(this.engineGain);

    const voice = (type, ratio, gain) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(this.engineLP);
      osc.start();
      return { osc, ratio };
    };

    this.engineVoices = [
      voice('sawtooth', 1, 0.5),      // fundamental
      voice('square', 0.5, 0.32),     // sub — gives it weight
      voice('sawtooth', 2.02, 0.18),  // detuned upper, adds the buzz
      voice('sawtooth', 3.01, 0.09),
    ];

    // intake / exhaust hiss
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.10;
    bp.connect(this.intakeGain).connect(this.engineLP);
    this._loop(bp);
    this.intakeBP = bp;
  }

  _buildTyres() {
    const ctx = this.ctx;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.master);

    // A skid is a tonal squeal riding on broadband scrub. A single narrow
    // bandpass throws away almost all of the noise energy — measured, the
    // first version of this came out around -71 dBFS, i.e. silent.
    const squeal = ctx.createBiquadFilter();
    squeal.type = 'bandpass';
    squeal.frequency.value = 1350;
    squeal.Q.value = 3;
    const squealLevel = ctx.createGain();
    squealLevel.gain.value = 1;
    squeal.connect(squealLevel).connect(this.squealGain);
    this._loop(squeal);

    const scrub = ctx.createBiquadFilter();
    scrub.type = 'bandpass';
    scrub.frequency.value = 2700;
    scrub.Q.value = 0.9;
    const scrubLevel = ctx.createGain();
    scrubLevel.gain.value = 0.45;
    scrub.connect(scrubLevel).connect(this.squealGain);
    this._loop(scrub);

    this.squealBP = squeal;
  }

  _buildWind() {
    const ctx = this.ctx;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.connect(this.windGain);
    this._loop(lp);
    this.windLP = lp;
  }

  _buildAmbience() {
    const ctx = this.ctx;
    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 0;
    this.ambGain.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    lp.connect(this.ambGain);
    this._loop(lp);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  // --- per-frame -----------------------------------------------------------

  /**
   * state: { driving, speed, throttle, slip, grounded, outdoors, quiet }
   * speed in m/s, throttle -1..1, slip 0..1.
   */
  update(dt, s) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.time += dt;

    // --- engine
    const targetRpm = s.driving ? this._gearRpm(s.speed, s.throttle) : 0;
    this.rpm += (targetRpm - this.rpm) * (1 - Math.exp(-9 * dt));

    if (this.rpm > 0.001) {
      const f = 40 + this.rpm * 165;
      for (const v of this.engineVoices) {
        v.osc.frequency.setTargetAtTime(f * v.ratio, t, 0.03);
      }
      this.engineLP.frequency.setTargetAtTime(320 + this.rpm * 2600, t, 0.05);
      this.intakeBP.frequency.setTargetAtTime(500 + this.rpm * 1600, t, 0.05);

      // louder under load, and a touch louder when the wheels are spinning up
      const load = 0.35 + 0.45 * Math.abs(s.throttle) + 0.30 * this.rpm;
      this.engineGain.gain.setTargetAtTime(0.16 * load, t, 0.06);
    } else {
      this.engineGain.gain.setTargetAtTime(0, t, 0.12);
    }

    // --- tyres: squeal tracks slip, and only above walking pace
    const wantSqueal = s.driving && s.grounded && s.speed > 3.5
      ? clamp(s.slip * 1.5, 0, 1) : 0;
    this.squeal += (wantSqueal - this.squeal) * (1 - Math.exp(-11 * dt));
    this.squealGain.gain.setTargetAtTime(MIX.squeal * this.squeal, t, 0.04);
    this.squealBP.frequency.setTargetAtTime(1250 + s.speed * 14, t, 0.08);

    // --- wind noise at speed
    const wind = clamp((s.speed - 7) / 38, 0, 1);
    this.windGain.gain.setTargetAtTime(MIX.wind * wind * wind, t, 0.15);
    this.windLP.frequency.setTargetAtTime(500 + s.speed * 26, t, 0.2);

    // --- ambience: a slow breathing wind bed, ducked when you're moving fast
    const breath = 0.55 + 0.45 * Math.sin(this.time * 0.21);
    const duck = 1 - clamp((s.speed - 6) / 22, 0, 1);
    this.ambGain.gain.setTargetAtTime(MIX.ambient * breath * duck, t, 0.3);

    // --- birds, only outdoors and only when it's calm enough to hear them
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 2.5 + Math.random() * 7;
      if (s.outdoors && s.quiet && !this.muted) this._chirp();
    }
  }

  // Fake gearbox: revs climb through a gear then drop on the shift. Far more
  // convincing than mapping speed straight to pitch.
  _gearRpm(speed, throttle) {
    const s = Math.abs(speed);
    const bounds = [0, 11, 20, 30, 41, 58];
    let g = 0;
    while (g < bounds.length - 2 && s > bounds[g + 1]) g++;
    const frac = clamp((s - bounds[g]) / (bounds[g + 1] - bounds[g]), 0, 1);
    // Revving against the brakes only makes sense while stopped; once you're
    // rolling, let the gear ramp own the note or every shift lands on a plateau.
    const stationary = 1 - clamp(s / 8, 0, 1);
    const idle = 0.17 + 0.34 * Math.max(0, throttle) * stationary;
    return Math.max(idle, 0.24 + 0.76 * frac);
  }

  // --- one-shots -----------------------------------------------------------

  _burst({ freq, q = 1, type = 'bandpass', gain, attack = 0.005, decay, pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = Math.random() * 1.5;

    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    src.connect(f).connect(g);
    tail.connect(this.master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  _tone({ from, to, gain, decay, type = 'sine', pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + decay);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    osc.connect(g);
    tail.connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  /** intensity 0..1 */
  crash(intensity) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastCrash < 0.11) return;   // scraping a wall isn't a drum roll
    this.lastCrash = now;

    const v = clamp(intensity, 0, 1);
    this._tone({ from: 90 + 70 * v, to: 34, gain: 0.30 * v + 0.04, decay: 0.28 });
    this._burst({
      freq: 700 + 1400 * v, q: 0.9,
      gain: 0.22 * v + 0.02, decay: 0.10 + 0.16 * v,
    });
  }

  /** Block dug out. `tone` is a rough hardness, 0 soft .. 1 hard. */
  blockBreak(tone = 0.5) {
    if (!this.ctx || this.muted) return;
    this._burst({
      freq: 320 + tone * 1500, q: 1.4 + tone * 2,
      gain: MIX.block, decay: 0.11,
    });
    this._tone({ from: 180 + tone * 120, to: 70, gain: 0.13, decay: 0.09 });
  }

  blockPlace(tone = 0.5) {
    if (!this.ctx || this.muted) return;
    this._burst({
      freq: 480 + tone * 1300, q: 2.2,
      gain: MIX.block * 0.8, decay: 0.06,
    });
    this._tone({ from: 150 + tone * 200, to: 240 + tone * 260, gain: 0.11, decay: 0.05 });
  }

  carDoor(closing) {
    if (!this.ctx || this.muted) return;
    this._tone({ from: closing ? 150 : 120, to: 52, gain: 0.16, decay: 0.16 });
    this._burst({ freq: 900, q: 1.1, gain: 0.10, decay: 0.07 });
  }

  _chirp() {
    const notes = 2 + ((Math.random() * 3) | 0);
    const base = 2100 + Math.random() * 1500;
    const pan = Math.random() * 1.6 - 0.8;
    for (let i = 0; i < notes; i++) {
      const at = i * (0.055 + Math.random() * 0.05);
      setTimeout(() => {
        if (!this.ctx || this.muted) return;
        const up = Math.random() > 0.4;
        const f = base * (0.9 + Math.random() * 0.3);
        this._tone({
          from: up ? f : f * 1.35,
          to: up ? f * 1.4 : f * 0.85,
          gain: MIX.bird, decay: 0.07 + Math.random() * 0.05, pan,
        });
      }, at * 1000);
    }
  }
}
