// A 6-operator FM engine for previewing DX7 voices in the browser. It follows
// the msfa engine used in Dexed (Apache 2.0, Google) for envelopes, scaling,
// frequencies and feedback, so it sounds close to the FM-1 without being
// bit-exact. It has no DOM dependencies: the AudioWorklet runs it, and the
// tests drive it directly.

import { algorithm, modulatorsOf, type Algorithm } from "../editor/algorithms";
import type { Operator, Voice } from "../editor/patch";
import { Envelope, PitchEnvelope, scaleOutLevel } from "./envelope";

const TABLE_BITS = 12;
const TABLE_SIZE = 1 << TABLE_BITS;
const SINE = new Float32Array(TABLE_SIZE + 1).map((_, i) => Math.sin((2 * Math.PI * i) / TABLE_SIZE));

/** sin(2π·phase), phase in cycles. */
function sin(phase: number): number {
  const p = (phase - Math.floor(phase)) * TABLE_SIZE;
  const i = p | 0;
  const a = SINE[i]!;
  return a + (SINE[i + 1]! - a) * (p - i);
}

// ---------------------------------------------------------------- scaling

const EXP_SCALE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66, 80, 94, 110, 126, 142, 158, 174, 190, 206, 222, 238, 250];

function scaleCurve(group: number, depth: number, curve: number): number {
  const scale =
    curve === 0 || curve === 3 ? (group * depth * 329) >> 12 : ((EXP_SCALE[Math.min(group, EXP_SCALE.length - 1)]! * depth * 329) >> 15);
  return curve < 2 ? -scale : scale;
}

/** Keyboard level scaling for `note`, in the 0-127 output level scale. */
export function levelScaling(op: Operator, note: number): number {
  const offset = note - op.breakPoint - 17;
  return offset >= 0
    ? scaleCurve(Math.trunc((offset + 1) / 3), op.rightDepth, op.rightCurve)
    : scaleCurve(Math.trunc(-(offset - 1) / 3), op.leftDepth, op.leftCurve);
}

const VELOCITY = [
  0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163, 166, 170, 173, 174, 178, 181, 184, 186, 189, 190,
  194, 196, 198, 200, 202, 205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232, 233, 235, 237, 238, 240,
  241, 242, 243, 244, 246, 246, 248, 249, 250, 251, 252, 253, 254,
];

const velocityScaling = (velocity: number, sens: number) =>
  ((sens * (VELOCITY[Math.max(0, Math.min(127, velocity)) >> 1]! - 239) + 7) >> 3) << 4;

export const rateScalingFor = (op: Operator, note: number) => (op.rateScaling * Math.min(31, Math.max(0, Math.trunc(note / 3) - 7))) >> 3;

/** The envelope's output level for one operator on one note, as the DX7 computes it. */
export function scaledOutLevel(op: Operator, note: number, velocity: number): number {
  let out = Math.min(127, scaleOutLevel(op.outputLevel) + levelScaling(op, note)) << 5;
  out += velocityScaling(velocity, op.velocitySens);
  return Math.max(0, out);
}

/** Operator frequency in Hz for a MIDI note (after transpose), before pitch modulation. */
export function operatorHz(op: Operator, note: number): number {
  if (op.fixed) {
    let log2 = (((op.coarse & 3) * 100 + op.fine) * Math.log2(10)) / 100;
    if (op.detune > 7) log2 += (13457 * (op.detune - 7)) / (1 << 24);
    return 2 ** log2;
  }
  let log2 = Math.log2(440) + (note - 69) / 12;
  log2 += ((0.0209 * Math.exp(-0.396 * log2)) / 7) * log2 * (op.detune - 7);
  return 2 ** log2 * (op.coarse === 0 ? 0.5 : op.coarse) * (1 + op.fine / 100);
}

// --------------------------------------------------------------------- LFO

const PITCH_SENS = [0, 10, 20, 33, 55, 92, 153, 255];
const AMP_SENS = [0, 0.26, 0.43, 1];

export const lfoHz = (speed: number) => {
  let s = speed === 0 ? 1 : (165 * speed) >> 6;
  s *= s < 160 ? 11 : 11 + ((s - 160) >> 4);
  return (s * 25190424) / 2 ** 32;
};

class Lfo {
  private phase = 0;
  private delayPos = 0;
  private hold = 0.5;
  private rand = 0;
  constructor(private readonly sampleRate: number) {}

  keyDown(sync: boolean) {
    if (sync) this.phase = 0.5;
    this.delayPos = 0;
  }

  /** 0..1 */
  value = 0;
  /** 0..1, how far the delay has faded the LFO in */
  ramp = 1;

  next(v: Voice["lfo"]) {
    const inc = lfoHz(v.speed) / this.sampleRate;
    const before = this.phase;
    this.phase = (this.phase + inc) % 1;
    const p = this.phase;
    let x: number;
    switch (v.wave) {
      case 0: x = p < 0.5 ? 1 - 2 * p : 2 * p - 1; break;
      case 1: x = 1 - p; break;
      case 2: x = p; break;
      case 3: x = p < 0.5 ? 1 : 0; break;
      case 4: x = 0.5 + 0.5 * Math.sin(2 * Math.PI * p); break;
      default:
        if (p < before) {
          this.rand = (this.rand * 179 + 17) & 0xff;
          this.hold = ((this.rand ^ 0x80) + 1) / 256;
        }
        x = this.hold;
    }
    this.value = x;
    this.ramp = this.delayRamp(v.delay);
  }

  // The delay holds the LFO off, then fades it in, faster for short delays.
  private delayRamp(delay: number): number {
    if (delay === 0) return 1;
    const a = 99 - delay;
    const fast = (16 + (a & 15)) << (1 + (a >> 4));
    const slow = Math.max(0x80, fast & 0xff80);
    const step = ((this.delayPos < 0.5 ? fast : slow) * 25190424) / 2 ** 32 / this.sampleRate;
    this.delayPos = Math.min(1, this.delayPos + step);
    return this.delayPos < 0.5 ? 0 : (this.delayPos - 0.5) * 2;
  }
}

// ------------------------------------------------------------------- notes

class Note {
  readonly envs: Envelope[];
  readonly pitchEnv: PitchEnvelope;
  readonly phase = new Float64Array(6);
  readonly baseHz = new Float64Array(6);
  readonly out = new Float64Array(6);
  fb1 = 0;
  fb2 = 0;
  note = -1;
  velocity = 100;
  held = false;
  sustained = false;
  age = 0;

  constructor(sampleRate: number) {
    this.envs = Array.from({ length: 6 }, () => new Envelope(sampleRate));
    this.pitchEnv = new PitchEnvelope(sampleRate);
  }

  get active() {
    return this.note >= 0;
  }

  /** Midi note after the voice's transpose. */
  private pitch(v: Voice) {
    return this.note + v.transpose - 24;
  }

  start(v: Voice, note: number, velocity: number, age: number) {
    this.note = note;
    this.velocity = velocity;
    this.held = true;
    this.sustained = false;
    this.age = age;
    const p = this.pitch(v);
    v.ops.forEach((op, i) => {
      this.envs[i]!.start(op.rates, op.levels, scaledOutLevel(op, p, velocity), rateScalingFor(op, p));
      this.baseHz[i] = operatorHz(op, p);
      if (v.oscSync) this.phase[i] = 0;
    });
    this.fb1 = this.fb2 = 0;
    this.pitchEnv.start(v.pitchRates, v.pitchLevels);
  }

  update(v: Voice) {
    const p = this.pitch(v);
    v.ops.forEach((op, i) => {
      this.envs[i]!.update(op.rates, op.levels, scaledOutLevel(op, p, this.velocity), rateScalingFor(op, p));
      this.baseHz[i] = operatorHz(op, p);
    });
    this.pitchEnv.update(v.pitchRates, v.pitchLevels);
  }

  release() {
    this.held = false;
    this.envs.forEach((e) => e.release());
    this.pitchEnv.release();
  }

  /** Silent and finished: every carrier's envelope has ended near zero. */
  done(alg: Algorithm) {
    return !this.held && !this.sustained && alg.carriers.every((c) => this.envs[c - 1]!.stage === 4 && this.envs[c - 1]!.level < 1000);
  }
}

// ------------------------------------------------------------------ engine

export class FmEngine {
  private voice: Voice | null = null;
  private alg: Algorithm = algorithm(1);
  private mods: number[][] = [];
  private notes: Note[];
  private lfo: Lfo;
  private counter = 0;
  private sustain = false;
  /** bit n set: operator n+1 is muted (preview only, not part of the voice) */
  private muted = 0;
  volume = 0.7;

  constructor(
    private readonly sampleRate: number,
    polyphony = 12,
  ) {
    this.notes = Array.from({ length: polyphony }, () => new Note(sampleRate));
    this.lfo = new Lfo(sampleRate);
  }

  setVoice(v: Voice) {
    this.voice = v;
    this.alg = algorithm(v.algorithm);
    this.mods = [1, 2, 3, 4, 5, 6].map((op) => modulatorsOf(this.alg, op).map((m) => m - 1));
    this.notes.forEach((n) => n.active && n.update(v));
  }

  setMuted(mask: number) {
    this.muted = mask;
  }

  noteOn(note: number, velocity = 100) {
    if (!this.voice) return;
    const n =
      this.notes.find((x) => x.note === note) ??
      this.notes.find((x) => !x.active) ??
      this.notes.reduce((a, b) => (!b.held && a.held ? b : b.held === a.held && b.age < a.age ? b : a));
    this.lfo.keyDown(this.voice.lfo.keySync);
    n.start(this.voice, note, velocity, ++this.counter);
  }

  noteOff(note: number) {
    for (const n of this.notes) {
      if (n.note !== note || !n.held) continue;
      if (this.sustain) {
        n.held = false;
        n.sustained = true;
      } else n.release();
    }
  }

  setSustain(on: boolean) {
    this.sustain = on;
    if (!on) for (const n of this.notes) if (n.sustained) (n.sustained = false), n.release();
  }

  allNotesOff() {
    this.sustain = false;
    for (const n of this.notes) n.note = -1;
  }

  get activeNotes() {
    return this.notes.filter((n) => n.active).length;
  }

  /** Render mono samples into `out`, replacing its contents. */
  render(out: Float32Array) {
    out.fill(0);
    const v = this.voice;
    if (!v) return;
    const alg = this.alg;
    const sr = this.sampleRate;
    const [fbFrom, fbTo] = alg.feedback;
    const fbScale = v.feedback === 0 ? 0 : 2 ** (v.feedback - 8);
    const pmDepth = ((v.lfo.pitchDepth * 165) >> 6) / 255;
    const pmSens = PITCH_SENS[v.lfo.pitchSens]! / 255;
    const amDepth = ((v.lfo.ampDepth * 165) >> 6) / 255;
    const carrier = [1, 2, 3, 4, 5, 6].map((op) => alg.carriers.includes(op));
    const muted = this.muted;
    const live = this.notes.filter((n) => n.active);

    for (let s = 0; s < out.length; s++) {
      this.lfo.next(v.lfo);
      const { value: lfoValue, ramp } = this.lfo;
      const pitchLfo = pmDepth * ramp * pmSens * (lfoValue - 0.5) * 2;
      const ampLfo = amDepth * ramp * lfoValue;
      let mix = 0;
      for (const n of live) {
        const pitch = n.pitchEnv.next() + pitchLfo;
        const pitchMul = 2 ** pitch;
        let sum = 0;
        for (let i = 5; i >= 0; i--) {
          const op = v.ops[i]!;
          let level = n.envs[i]!.next();
          if (op.ampModSens) level -= ampLfo * AMP_SENS[op.ampModSens]! * 1536;
          const gain = (muted >> i) & 1 ? 0 : 2 ** (level / 256 - 14);
          let mod = 0;
          for (const m of this.mods[i]!) mod += n.out[m]!;
          if (i === fbTo - 1 && fbScale) mod += (n.fb1 + n.fb2) * 0.5 * fbScale;
          const y = sin(n.phase[i]! + mod) * gain;
          n.out[i] = y;
          if (i === fbFrom - 1) {
            n.fb2 = n.fb1;
            n.fb1 = y;
          }
          n.phase[i] = (n.phase[i]! + (n.baseHz[i]! * (op.fixed ? 1 : pitchMul)) / sr) % 1;
          if (carrier[i]) sum += y;
        }
        mix += sum;
      }
      out[s] = Math.tanh(mix * 0.2 * this.volume);
    }
    for (const n of live) if (n.done(alg)) n.note = -1;
  }
}
