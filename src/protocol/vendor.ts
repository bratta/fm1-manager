// M-VAVE vendor SysEx frames. Every frame is F0 pack7(decoded) F7, where
// decoded = 00 59 <type> <body_len:u24le> <body...> <checksum>
// and checksum = ~sum(body) & 0xFF.
// Sources: github.com/AL-255/FM-1-RE (tools/fm1_ota.py, docs/io/11-ota-protocol.md)
// and github.com/czietz/fm1-read-voice.

import { pack7, unpack7 } from "./pack7";
import { concat, readU24le, readU32le, u24le, u32le } from "./bytes";

export const FRAME_MAGIC = [0x00, 0x59] as const;

export const FrameType = {
  Identity: 0x11,
  Read: 0x23,
  Ota: 0x30,
} as const;

/** Handshake query (frame type 0x11, empty body). Answered with the identity block. */
export const IDENTITY_QUERY = Uint8Array.from([0xf0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7f, 0xf7]);
/** Packed prefix every identity reply starts with (pack7 of 00 59 11). */
export const IDENTITY_REPLY_PREFIX = [0xf0, 0x00, 0x32, 0x45, 0x58] as const;
/** Puts the device into firmware-update mode. Only sent by the OTA flow. */
export const UPGRADE_COMMAND = Uint8Array.from([0xf0, 0x22, 0x24, 0x35, 0x7f, 0xf7]);

export const checksum = (body: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += body[i] ?? 0;
  return ~sum & 0xff;
};

export function buildFrame(type: number, body: ArrayLike<number>): Uint8Array {
  const decoded = concat(FRAME_MAGIC, [type], u24le(body.length), body, [checksum(body)]);
  return concat([0xf0], pack7(decoded), [0xf7]);
}

export interface Frame {
  type: number;
  body: Uint8Array;
  checksumByte: number;
  checksumOk: boolean;
}

/** Decode a vendor frame, or return null if it is not one. */
export function parseFrame(msg: Uint8Array, { exactLength = true } = {}): Frame | null {
  if (msg.length < 4 || msg[0] !== 0xf0 || msg[msg.length - 1] !== 0xf7) return null;
  const u = unpack7(msg.subarray(1, -1));
  if (u.length < 7 || u[0] !== FRAME_MAGIC[0] || u[1] !== FRAME_MAGIC[1]) return null;
  const bodyLen = readU24le(u, 3);
  // The device rejects frames whose declared length does not match; so do we.
  if (exactLength ? u.length !== bodyLen + 7 : u.length < bodyLen + 7) return null;
  const body = u.slice(6, 6 + bodyLen);
  const checksumByte = u[6 + bodyLen]!;
  return { type: u[2]!, body, checksumByte, checksumOk: checksumByte === checksum(body) };
}

// ---------------------------------------------------------------- identity

export interface Identity {
  /** e.g. "FM-1" in normal mode, "ota-FM-1" in the update loader. */
  model: string;
  /** e.g. 15 for stock V15. */
  version: number;
}

const LEGACY_V16_BODY = (() => {
  const b = new Uint8Array(27);
  b.set(new TextEncoder().encode("FM-1_016"));
  return b;
})();

export function parseIdentity(msg: Uint8Array): Identity | null {
  const frame = parseFrame(msg);
  if (!frame || frame.type !== FrameType.Identity || frame.body.length !== 27) return null;
  const { body } = frame;
  // A community-modified build reported FM-1_016 but kept V15's checksum.
  // fm1_ota.py accepts exactly that payload, so we do too.
  const legacy = frame.checksumByte === 0x19 && body.every((b, i) => b === LEGACY_V16_BODY[i]);
  if (!frame.checksumOk && !legacy) return null;

  const text = String.fromCharCode(...body).replace(/\0+$/, "");
  const plain = /^([^_\0]+)_([0-9]+)$/.exec(text);
  if (plain) return { model: plain[1]!, version: parseInt(plain[2]!, 10) };

  // Older encoded identity format used by the vendor updater: the version
  // field is stored as digit values without the ASCII '0' offset.
  const sep = body.subarray(0, 25).indexOf(0x5f);
  if (sep < 0) return null;
  const model = String.fromCharCode(...body.subarray(0, sep));
  const encoded = String.fromCharCode(...Array.from(body.subarray(8, 28), (b) => (b + 0x30) & 0xff));
  const digits = /^[0-9]+/.exec(encoded.slice(sep + 1));
  return digits ? { model, version: parseInt(digits[0], 10) } : null;
}

export const isOtaLoader = (id: Identity): boolean => id.model.toLowerCase().startsWith("ota-");
export const baseModel = (id: Identity): string => (isOtaLoader(id) ? id.model.slice(4) : id.model);
export const formatIdentity = (id: Identity): string => `${id.model} V${id.version}`;

// ------------------------------------------------------------- voice read

/** Unpacked DX7 voice (VCED) length. */
export const VCED_LENGTH = 155;
const READ_SUBJECT_CURRENT_VOICE = 5;

/**
 * Ask for the voice currently loaded in the edit buffer. Verified on stock
 * V14 and V15 by fm1-read-voice. The firmware has no known command that
 * returns the stored presets, and the read interface is not safe to probe.
 */
export const buildReadCurrentVoice = (): Uint8Array =>
  buildFrame(FrameType.Read, [READ_SUBJECT_CURRENT_VOICE, ...u32le(0), ...u24le(VCED_LENGTH)]);

/** Extract the 155-byte VCED voice from a read reply, or null. */
export function parseCurrentVoice(msg: Uint8Array): Uint8Array | null {
  const frame = parseFrame(msg, { exactLength: false });
  if (!frame || !frame.checksumOk) return null;
  // Body = subject(1) + offset(4) + length(3) + data.
  if (frame.body.length < 8 + VCED_LENGTH) return null;
  return frame.body.slice(8, 8 + VCED_LENGTH);
}

// ------------------------------------------------------------ OTA frames

export const OTA_MAX_DATA = 512;
export const OTA_ADDR_VERIFIED = 0xe0000000;
export const OTA_ADDR_FINISHED = 0xf0000000;

export interface OtaRequest {
  flashType: number;
  address: number;
  length: number;
}

/** Decode a read request the device sends while pulling the firmware image. */
export function parseOtaRequest(msg: Uint8Array): OtaRequest | null {
  const frame = parseFrame(msg);
  if (!frame || frame.type !== FrameType.Ota || frame.body.length !== 8 || !frame.checksumOk) return null;
  return {
    flashType: frame.body[0]!,
    address: readU32le(frame.body, 1),
    length: readU24le(frame.body, 5),
  };
}

/** Answer a request with exactly the bytes it asked for. */
export function buildOtaResponse(req: OtaRequest, data: Uint8Array): Uint8Array {
  if (data.length !== req.length || req.length > OTA_MAX_DATA) {
    throw new RangeError(`response must carry exactly the ${req.length} requested bytes (max ${OTA_MAX_DATA})`);
  }
  return buildFrame(FrameType.Ota, concat([req.flashType], u32le(req.address), u24le(req.length), data));
}

const SUCCESS = new TextEncoder().encode("success\0");

/** Reply to the verification-done (0xE0000000) and finished (0xF0000000) signals. */
export const buildOtaSuccess = (address: number): Uint8Array =>
  buildOtaResponse({ flashType: 0, address, length: SUCCESS.length }, SUCCESS);
