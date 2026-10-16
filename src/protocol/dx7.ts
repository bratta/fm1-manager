// Yamaha DX7 voice formats. The FM-1 stores voices as standard 128-byte
// packed DX7 voices (VMEM) and accepts standard DX7 SysEx dumps:
//   32-voice bank: F0 43 0n 09 20 00 <4096 bytes VMEM> <ck> F7
//   single voice:  F0 43 0n 00 01 1B <155 bytes VCED> <ck> F7
// After a bank dump the FM-1 asks on its own screen which bank (A-D) to store into.

export const VMEM_LENGTH = 128;
export const VCED_LENGTH = 155;
export const VOICES_PER_BANK = 32;
export const BANK_DATA_LENGTH = VMEM_LENGTH * VOICES_PER_BANK;
export const BANK_SYSEX_LENGTH = 6 + BANK_DATA_LENGTH + 2;
export const SINGLE_SYSEX_LENGTH = 6 + VCED_LENGTH + 2;
const NAME_LENGTH = 10;

export const dx7Checksum = (data: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
  return (128 - (sum & 0x7f)) & 0x7f;
};

const nameFrom = (bytes: Uint8Array): string =>
  String.fromCharCode(...Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? b : 0x20))).trimEnd();

export const vmemName = (vmem: Uint8Array): string => nameFrom(vmem.subarray(118, 128));
export const vcedName = (vced: Uint8Array): string => nameFrom(vced.subarray(145, 155));

// ------------------------------------------------------------ bank dumps

export function buildBankSysex(voices: readonly Uint8Array[], channel = 0): Uint8Array {
  if (voices.length !== VOICES_PER_BANK) throw new RangeError(`a bank holds exactly ${VOICES_PER_BANK} voices`);
  const data = new Uint8Array(BANK_DATA_LENGTH);
  voices.forEach((v, i) => {
    if (v.length !== VMEM_LENGTH) throw new RangeError(`voice ${i + 1} is not ${VMEM_LENGTH} bytes`);
    data.set(v, i * VMEM_LENGTH);
  });
  const out = new Uint8Array(BANK_SYSEX_LENGTH);
  out.set([0xf0, 0x43, channel & 0x0f, 0x09, 0x20, 0x00]);
  out.set(data, 6);
  out[6 + BANK_DATA_LENGTH] = dx7Checksum(data);
  out[7 + BANK_DATA_LENGTH] = 0xf7;
  return out;
}

export function parseBankSysex(msg: Uint8Array): Uint8Array[] {
  const isBank =
    msg.length === BANK_SYSEX_LENGTH &&
    msg[0] === 0xf0 && msg[1] === 0x43 && (msg[2]! & 0xf0) === 0x00 &&
    msg[3] === 0x09 && msg[4] === 0x20 && msg[5] === 0x00 && msg[msg.length - 1] === 0xf7;
  if (!isBank) throw new Error("not a DX7 32-voice bank dump (expected 4104 bytes starting F0 43 0n 09 20 00)");
  const data = msg.subarray(6, 6 + BANK_DATA_LENGTH);
  if (dx7Checksum(data) !== msg[6 + BANK_DATA_LENGTH]) throw new Error("bank checksum does not match");
  return Array.from({ length: VOICES_PER_BANK }, (_, i) => data.slice(i * VMEM_LENGTH, (i + 1) * VMEM_LENGTH));
}

// ---------------------------------------------------------- single voice

export function buildSingleVoiceSysex(vced: Uint8Array, channel = 0): Uint8Array {
  if (vced.length !== VCED_LENGTH) throw new RangeError(`a single voice is ${VCED_LENGTH} bytes`);
  const out = new Uint8Array(SINGLE_SYSEX_LENGTH);
  out.set([0xf0, 0x43, channel & 0x0f, 0x00, 0x01, 0x1b]);
  out.set(vced, 6);
  out[6 + VCED_LENGTH] = dx7Checksum(vced);
  out[7 + VCED_LENGTH] = 0xf7;
  return out;
}

export function parseSingleVoiceSysex(msg: Uint8Array): Uint8Array {
  const ok =
    msg.length === SINGLE_SYSEX_LENGTH &&
    msg[0] === 0xf0 && msg[1] === 0x43 && (msg[2]! & 0xf0) === 0x00 &&
    msg[3] === 0x00 && msg[4] === 0x01 && msg[5] === 0x1b && msg[msg.length - 1] === 0xf7;
  if (!ok) throw new Error("not a DX7 single-voice dump");
  const vced = msg.slice(6, 6 + VCED_LENGTH);
  if (dx7Checksum(vced) !== msg[6 + VCED_LENGTH]) throw new Error("voice checksum does not match");
  return vced;
}

/**
 * One DX7 parameter change per VCED byte: F0 43 1n gg pp vv F7, address
 * (gg << 7) + pp. The FM-1 applies these to its edit buffer only, while a
 * single-voice dump is stored into the selected preset (AL-255/FM-1-RE,
 * docs/io/05-midi.md §5.1).
 */
export function buildParameterChanges(vced: Uint8Array, channel = 0): Uint8Array[] {
  if (vced.length !== VCED_LENGTH) throw new RangeError(`a single voice is ${VCED_LENGTH} bytes`);
  return Array.from(vced, (value, addr) =>
    Uint8Array.from([0xf0, 0x43, 0x10 | (channel & 0x0f), (addr >> 7) & 0x03, addr & 0x7f, value & 0x7f, 0xf7]),
  );
}

/** Split a .syx file into its SysEx messages. */
export function splitSysex(file: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  file.forEach((b, i) => {
    if (b === 0xf0) start = i;
    else if (b === 0xf7 && start >= 0) {
      out.push(file.slice(start, i + 1));
      start = -1;
    }
  });
  return out;
}

// ------------------------------------------------- VCED <-> VMEM packing

const OP_VCED = 21;
const OP_VMEM = 17;

/** Pack a 155-byte VCED voice into the 128-byte VMEM form. */
export function vcedToVmem(vced: Uint8Array): Uint8Array {
  if (vced.length !== VCED_LENGTH) throw new RangeError(`VCED voice must be ${VCED_LENGTH} bytes`);
  const v = (i: number) => vced[i] ?? 0;
  const m = new Uint8Array(VMEM_LENGTH);
  for (let op = 0; op < 6; op++) {
    const s = op * OP_VCED;
    const d = op * OP_VMEM;
    for (let k = 0; k < 11; k++) m[d + k] = v(s + k) & 0x7f; // EG rates/levels, break point, depths
    m[d + 11] = ((v(s + 12) & 0x03) << 2) | (v(s + 11) & 0x03); // RC | LC
    m[d + 12] = ((v(s + 20) & 0x0f) << 3) | (v(s + 13) & 0x07); // DET | RS
    m[d + 13] = ((v(s + 15) & 0x07) << 2) | (v(s + 14) & 0x03); // KVS | AMS
    m[d + 14] = v(s + 16) & 0x7f; // output level
    m[d + 15] = ((v(s + 18) & 0x1f) << 1) | (v(s + 17) & 0x01); // FC | mode
    m[d + 16] = v(s + 19) & 0x7f; // fine frequency
  }
  for (let k = 0; k < 8; k++) m[102 + k] = v(126 + k) & 0x7f; // pitch EG
  m[110] = v(134) & 0x1f; // algorithm
  m[111] = ((v(136) & 0x01) << 3) | (v(135) & 0x07); // OKS | FB
  for (let k = 0; k < 4; k++) m[112 + k] = v(137 + k) & 0x7f; // LFO speed, delay, PMD, AMD
  m[116] = ((v(143) & 0x07) << 4) | ((v(142) & 0x07) << 1) | (v(141) & 0x01); // LPMS | LFW | LKS
  m[117] = v(144) & 0x7f; // transpose
  for (let k = 0; k < NAME_LENGTH; k++) m[118 + k] = v(145 + k) & 0x7f;
  return m;
}

/** Unpack a 128-byte VMEM voice into the 155-byte VCED form. */
export function vmemToVced(vmem: Uint8Array): Uint8Array {
  if (vmem.length !== VMEM_LENGTH) throw new RangeError(`VMEM voice must be ${VMEM_LENGTH} bytes`);
  const m = (i: number) => vmem[i] ?? 0;
  const v = new Uint8Array(VCED_LENGTH);
  for (let op = 0; op < 6; op++) {
    const s = op * OP_VMEM;
    const d = op * OP_VCED;
    for (let k = 0; k < 11; k++) v[d + k] = m(s + k) & 0x7f;
    v[d + 11] = m(s + 11) & 0x03;
    v[d + 12] = (m(s + 11) >> 2) & 0x03;
    v[d + 13] = m(s + 12) & 0x07;
    v[d + 14] = m(s + 13) & 0x03;
    v[d + 15] = (m(s + 13) >> 2) & 0x07;
    v[d + 16] = m(s + 14) & 0x7f;
    v[d + 17] = m(s + 15) & 0x01;
    v[d + 18] = (m(s + 15) >> 1) & 0x1f;
    v[d + 19] = m(s + 16) & 0x7f;
    v[d + 20] = (m(s + 12) >> 3) & 0x0f;
  }
  for (let k = 0; k < 8; k++) v[126 + k] = m(102 + k) & 0x7f;
  v[134] = m(110) & 0x1f;
  v[135] = m(111) & 0x07;
  v[136] = (m(111) >> 3) & 0x01;
  for (let k = 0; k < 4; k++) v[137 + k] = m(112 + k) & 0x7f;
  v[141] = m(116) & 0x01;
  v[142] = (m(116) >> 1) & 0x07;
  v[143] = (m(116) >> 4) & 0x07;
  v[144] = m(117) & 0x7f;
  for (let k = 0; k < NAME_LENGTH; k++) v[145 + k] = m(118 + k) & 0x7f;
  return v;
}

/** An empty "INIT VOICE" in VMEM form, used to pad short banks. */
export function initVoice(): Uint8Array {
  const vced = new Uint8Array(VCED_LENGTH);
  for (let op = 0; op < 6; op++) {
    const d = op * OP_VCED;
    vced.set([99, 99, 99, 99, 99, 99, 99, 0], d); // EG
    vced[d + 8] = 39; // break point C3
    vced[d + 16] = op === 5 ? 99 : 0; // only OP1 (stored last) sounds
    vced[d + 18] = 1; // frequency coarse 1
    vced[d + 20] = 7; // detune centre
  }
  vced.set([99, 99, 99, 99, 50, 50, 50, 50], 126);
  vced[136] = 1; // oscillator key sync
  vced[137] = 35; // LFO speed
  vced[143] = 3; // pitch mod sensitivity
  vced[144] = 24; // transpose C3
  vced.set(Array.from("INIT VOICE", (c) => c.charCodeAt(0)), 145);
  return vcedToVmem(vced);
}
