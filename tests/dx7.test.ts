import { describe, expect, it } from "vitest";
import {
  buildBankSysex,
  buildSingleVoiceSysex,
  initVoice,
  parseBankSysex,
  parseSingleVoiceSysex,
  splitSysex,
  vcedToVmem,
  vmemName,
  vmemToVced,
} from "../src/protocol/dx7";

// A VCED voice with every parameter at a distinct legal value.
function sampleVced(): Uint8Array {
  const v = new Uint8Array(155);
  const ranges = [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 3, 3, 7, 3, 7, 99, 1, 31, 99, 14];
  for (let op = 0; op < 6; op++) ranges.forEach((max, k) => (v[op * 21 + k] = (op * 7 + k * 5) % (max + 1)));
  [99, 99, 99, 99, 99, 99, 99, 99, 31, 7, 1, 99, 99, 99, 99, 1, 5, 7, 48].forEach(
    (max, k) => (v[126 + k] = (k * 11 + 3) % (max + 1)),
  );
  v.set(Array.from("BRASS  1  ", (c) => c.charCodeAt(0)), 145);
  return v;
}

describe("DX7 voice formats", () => {
  it("VCED -> VMEM -> VCED is lossless", () => {
    const vced = sampleVced();
    expect(vmemToVced(vcedToVmem(vced))).toEqual(vced);
  });

  it("reads the voice name", () => {
    expect(vmemName(vcedToVmem(sampleVced()))).toBe("BRASS  1");
    expect(vmemName(initVoice())).toBe("INIT VOICE");
  });

  it("builds and parses a 32-voice bank with a valid checksum", () => {
    const voices = Array.from({ length: 32 }, (_, i) => (i % 2 ? initVoice() : vcedToVmem(sampleVced())));
    const syx = buildBankSysex(voices);
    expect(syx).toHaveLength(4104);
    expect(Array.from(syx.subarray(0, 6))).toEqual([0xf0, 0x43, 0x00, 0x09, 0x20, 0x00]);
    expect(parseBankSysex(syx)).toEqual(voices);
    syx[100]! ^= 1;
    expect(() => parseBankSysex(syx)).toThrow(/checksum/);
  });

  it("builds and parses a single voice", () => {
    const vced = sampleVced();
    const syx = buildSingleVoiceSysex(vced);
    expect(syx).toHaveLength(163);
    expect(parseSingleVoiceSysex(syx)).toEqual(vced);
  });

  it("splits a file with several dumps", () => {
    const a = buildSingleVoiceSysex(sampleVced());
    const b = buildBankSysex(Array.from({ length: 32 }, initVoice));
    expect(splitSysex(Uint8Array.from([...a, ...b]))).toEqual([a, b]);
  });
});

describe("parameter changes", () => {
  it("addresses all 155 VCED bytes", async () => {
    const { buildParameterChanges } = await import("../src/protocol/dx7");
    const vced = sampleVced();
    const msgs = buildParameterChanges(vced, 2);
    expect(msgs).toHaveLength(155);
    expect(Array.from(msgs[0]!)).toEqual([0xf0, 0x43, 0x12, 0, 0, vced[0], 0xf7]);
    expect(Array.from(msgs[150]!)).toEqual([0xf0, 0x43, 0x12, 1, 22, vced[150], 0xf7]);
  });
});
