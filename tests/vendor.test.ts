import { describe, expect, it } from "vitest";
import { fromHex, hex } from "../src/protocol/bytes";
import { pack7, unpack7 } from "../src/protocol/pack7";
import {
  IDENTITY_QUERY,
  buildFrame,
  buildOtaResponse,
  buildOtaSuccess,
  buildReadCurrentVoice,
  parseCurrentVoice,
  parseFrame,
  parseIdentity,
  parseOtaRequest,
} from "../src/protocol/vendor";
import golden from "./fixtures/python-golden.json";
import record from "./fixtures/fm1-v15-reflash-2026-09-04.json";

const identityReply = (text: string) => {
  const body = new Uint8Array(27);
  body.set(new TextEncoder().encode(text));
  return buildFrame(0x11, body);
};

describe("pack7", () => {
  it("round-trips arbitrary bytes", () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 0xff);
    for (const n of [0, 1, 6, 7, 8, 55, 1000]) {
      expect(unpack7(pack7(data.subarray(0, n)))).toEqual(data.subarray(0, n));
    }
  });

  it("produces only 7-bit values", () => {
    expect(pack7(Uint8Array.from([0xff, 0xff, 0xff])).every((b) => b < 0x80)).toBe(true);
  });
});

describe("identity", () => {
  it("builds the documented handshake query", () => {
    expect(buildFrame(0x11, [])).toEqual(IDENTITY_QUERY);
  });

  it("parses the identity a real update loader sent", () => {
    expect(parseIdentity(fromHex(record.ota.identity_sysex_hex))).toEqual({ model: "ota-FM-1", version: 15 });
  });

  it("parses a normal-mode identity", () => {
    expect(parseIdentity(identityReply("FM-1_015"))).toEqual({ model: "FM-1", version: 15 });
  });

  it("rejects a bad checksum", () => {
    const decoded = unpack7(identityReply("FM-1_014").subarray(1, -1));
    decoded[decoded.length - 1]! ^= 1;
    expect(parseIdentity(Uint8Array.from([0xf0, ...pack7(decoded), 0xf7]))).toBeNull();
  });

  it("rejects frames whose declared length is wrong", () => {
    const body = new Uint8Array(27);
    const msg = buildFrame(0x11, body);
    const decoded = unpack7(msg.subarray(1, -1));
    decoded[3] = 26;
    expect(parseFrame(Uint8Array.from([0xf0, ...pack7(decoded), 0xf7]))).toBeNull();
  });
});

describe("current voice read", () => {
  it("matches fm1-read-voice byte for byte", () => {
    expect(hex(buildReadCurrentVoice())).toBe(golden.read_voice.toUpperCase());
  });

  it("extracts the 155-byte voice from a reply", () => {
    const voice = Uint8Array.from({ length: 155 }, (_, i) => i % 100);
    const reply = buildFrame(0x23, [5, 0, 0, 0, 0, 155, 0, 0, ...voice]);
    expect(parseCurrentVoice(reply)).toEqual(voice);
  });
});

describe("OTA frames", () => {
  it("parses a device read request", () => {
    expect(parseOtaRequest(fromHex(golden.request_example))).toEqual({ flashType: 0, address: 0xaab20, length: 481 });
  });

  it("builds the success reply like the vendor updater", () => {
    expect(hex(buildOtaSuccess(0xe0000000))).toBe(golden.success_E0.toUpperCase());
  });

  it("declares body length = data + 8 for every length, including the 481-byte final block", () => {
    for (let len = 0; len <= 512; len++) {
      const frame = parseFrame(buildOtaResponse({ flashType: 0, address: 0x1234, length: len }, new Uint8Array(len)));
      expect(frame?.body.length).toBe(len + 8);
      expect(frame?.checksumOk).toBe(true);
    }
  });

  it("refuses to send the wrong number of bytes", () => {
    expect(() => buildOtaResponse({ flashType: 0, address: 0, length: 32 }, new Uint8Array(31))).toThrow();
    expect(() => buildOtaResponse({ flashType: 0, address: 0, length: 513 }, new Uint8Array(513))).toThrow();
  });
});
