import { describe, expect, it } from "vitest";
import { inspectFirmware, logicalImage, type FirmwareInfo } from "../src/firmware/fwsc";
import { restoreStockFirmware, RestoreError, type RestoreTiming } from "../src/firmware/restore";
import type { Connector, SysexLink } from "../src/midi/link";
import { equalBytes, fromHex } from "../src/protocol/bytes";
import { buildFrame, IDENTITY_QUERY, parseIdentity, UPGRADE_COMMAND, type OtaRequest } from "../src/protocol/vendor";
import record from "./fixtures/fm1-v15-reflash-2026-09-04.json";
import { answer, readStock, recordedRequests, stockAvailable } from "./helpers";

const FAST: RestoreTiming = {
  startDelayMs: 1,
  responseDelayMs: 0,
  verifyDrainMs: 1,
  checkIdleMs: 50,
  writeIdleMs: 50,
  reconnectMs: 200,
};

const identity = (text: string) => {
  const body = new Uint8Array(27);
  body.set(new TextEncoder().encode(text));
  return buildFrame(0x11, body);
};

/** Simulates an FM-1 by replaying the request sequence the real device made. */
class FakeFm1 {
  mode: "normal" | "ota" = "normal";
  version = 16;
  outbox: Uint8Array[] = [];
  pending: OtaRequest[] = [];
  mismatches = 0;
  /** Stop answering after this many write requests, to simulate a cable pull. */
  dieAfter = Infinity;
  writes = 0;

  constructor(private readonly image: Uint8Array) {}

  receiveFromHost(msg: Uint8Array) {
    if (equalBytes(msg, IDENTITY_QUERY)) {
      this.outbox.push(this.mode === "ota" ? fromHex(record.ota.identity_sysex_hex) : identity(`FM-1_0${this.version}`));
    } else if (equalBytes(msg, UPGRADE_COMMAND)) {
      this.pending = recordedRequests(this.mode === "normal" ? "stage" : "flash");
      this.next();
    } else {
      const expected = this.pending.shift();
      if (!expected || !equalBytes(msg, answer(expected, this.image))) this.mismatches++;
      if (expected?.address === 0xe0000000) this.mode = "ota";
      else if (expected?.address === 0xf0000000) {
        this.mode = "normal";
        this.version = 15;
      } else this.next();
    }
  }

  private next() {
    const req = this.pending[0];
    if (!req) return;
    if (this.mode === "ota" && ++this.writes > this.dieAfter) return;
    const body = [req.flashType, ...[0, 8, 16, 24].map((s) => (req.address >>> s) & 0xff), req.length & 0xff, (req.length >> 8) & 0xff, 0];
    this.outbox.push(buildFrame(0x30, body));
  }
}

function fakeConnector(dev: FakeFm1): Connector {
  return async (accept) => {
    const link: SysexLink = {
      name: "FM-1 Midi",
      send: (m) => dev.receiveFromHost(m),
      receive: async () => dev.outbox.shift() ?? (await new Promise((r) => setTimeout(r, 2)), null),
      drain: () => (dev.outbox = []),
      close: () => {},
    };
    link.send(IDENTITY_QUERY);
    const id = parseIdentity(dev.outbox.shift()!);
    return id && accept(id) ? { link, identity: id } : null;
  };
}

describe.skipIf(!stockAvailable)("restore to stock against a simulated FM-1", () => {
  let fw: FirmwareInfo;
  const setup = async () => {
    fw = await inspectFirmware(readStock());
    return new FakeFm1(logicalImage(readStock()));
  };

  it("walks the recorded check, reboot, write and confirm sequence", async () => {
    const dev = await setup();
    const stages: string[] = [];
    await restoreStockFirmware(fw, fakeConnector(dev), { stage: (s) => stages.push(s) }, FAST);
    expect(dev.mismatches).toBe(0);
    expect(dev.version).toBe(15);
    expect(stages).toEqual(["connecting", "checking", "rebooting", "writing", "confirming", "done"]);
  });

  it("resumes when the synth is already in update mode", async () => {
    const dev = await setup();
    dev.mode = "ota";
    await restoreStockFirmware(fw, fakeConnector(dev), {}, FAST);
    expect(dev.mismatches).toBe(0);
    expect(dev.version).toBe(15);
  });

  it("reports that flash was touched if contact is lost mid-write", async () => {
    const dev = await setup();
    dev.dieAfter = 100;
    const err = await restoreStockFirmware(fw, fakeConnector(dev), {}, FAST).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as RestoreError).flashTouched).toBe(true);
  });

  it("refuses packages that are not known stock firmware", async () => {
    const dev = await setup();
    const err = await restoreStockFirmware({ ...fw, stock: null }, fakeConnector(dev), {}, FAST).catch((e) => e);
    expect((err as RestoreError).flashTouched).toBe(false);
    expect(dev.outbox).toHaveLength(0);
  });
});
