// Restore an FM-1 to a stock firmware package over USB-MIDI.
// This mirrors the two-stage pull protocol of M-VAVE's own updater, as
// reimplemented in AL-255/FM-1-RE tools/fm1_ota.py:
//   1. Normal mode: send the upgrade command. The device checks the package by
//      pulling parts of it, signals 0xE0000000, then reboots into its loader.
//   2. Loader mode ("ota-FM-1"): send the upgrade command again. The device
//      pulls the whole image, writes flash, signals 0xF0000000 and reboots.
//   3. Normal mode again: confirm the device reports the expected version.

import type { Connection, Connector, SysexLink } from "../midi/link";
import {
  OTA_ADDR_FINISHED,
  OTA_ADDR_VERIFIED,
  OTA_MAX_DATA,
  UPGRADE_COMMAND,
  baseModel,
  buildOtaResponse,
  buildOtaSuccess,
  formatIdentity,
  isOtaLoader,
  parseOtaRequest,
} from "../protocol/vendor";
import type { FirmwareInfo } from "./fwsc";

export type RestoreStage = "connecting" | "checking" | "rebooting" | "writing" | "confirming" | "done";

export interface RestoreEvents {
  stage?(stage: RestoreStage, message: string): void;
  progress?(fraction: number): void;
  log?(line: string): void;
}

export interface RestoreTiming {
  /** Wait after the upgrade command before the device starts asking. */
  startDelayMs: number;
  /** Pause before each answer; the vendor updater paces at about 10 ms. */
  responseDelayMs: number;
  /** Keep the link open after the verification signal so the reply drains. */
  verifyDrainMs: number;
  checkIdleMs: number;
  writeIdleMs: number;
  reconnectMs: number;
}

export const DEFAULT_TIMING: RestoreTiming = {
  startDelayMs: 2000,
  responseDelayMs: 10,
  verifyDrainMs: 3000,
  checkIdleMs: 8000,
  writeIdleMs: 180_000,
  reconnectMs: 30_000,
};

export class RestoreError extends Error {
  constructor(message: string, readonly flashTouched: boolean) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ServeResult {
  served: number;
  terminal: number | null;
}

async function serve(
  link: SysexLink,
  image: Uint8Array,
  isTerminal: (address: number) => boolean,
  idleMs: number,
  timing: RestoreTiming,
  events: RestoreEvents,
): Promise<ServeResult> {
  let served = 0;
  let bytes = 0;
  let lastRequest = Date.now();
  for (;;) {
    const msg = await link.receive(1000);
    if (!msg) {
      if (Date.now() - lastRequest > idleMs) return { served, terminal: null };
      continue;
    }
    const req = parseOtaRequest(msg);
    if (!req) continue;
    lastRequest = Date.now();

    if (req.address === OTA_ADDR_VERIFIED || req.address === OTA_ADDR_FINISHED) {
      events.log?.(`device signalled 0x${req.address.toString(16).toUpperCase()}`);
      if (!trySend(link, buildOtaSuccess(req.address))) return { served, terminal: req.address };
      if (isTerminal(req.address)) return { served, terminal: req.address };
      continue;
    }
    if (req.length > OTA_MAX_DATA || req.address + req.length > image.length) {
      throw new RestoreError(
        `device asked for bytes outside the package (0x${req.address.toString(16)}, ${req.length})`,
        true,
      );
    }
    await sleep(timing.responseDelayMs);
    if (!trySend(link, buildOtaResponse(req, image.subarray(req.address, req.address + req.length)))) {
      return { served, terminal: null };
    }
    served++;
    bytes += req.length;
    events.progress?.(Math.min(0.99, bytes / image.length));
  }
}

function trySend(link: SysexLink, msg: Uint8Array): boolean {
  try {
    link.send(msg);
    return true;
  } catch {
    return false; // the port vanished, usually because the device rebooted
  }
}

/**
 * Run the full restore. The caller must have confirmed with the user, and
 * fw.stock must be set: only known stock packages are flashed.
 */
export async function restoreStockFirmware(
  fw: FirmwareInfo,
  connect: Connector,
  events: RestoreEvents = {},
  timing: RestoreTiming = DEFAULT_TIMING,
): Promise<void> {
  if (!fw.stock) throw new RestoreError("only known stock firmware packages can be restored", false);
  const stage = (s: RestoreStage, m: string) => {
    events.stage?.(s, m);
    events.log?.(m);
  };

  stage("connecting", "Looking for the FM-1…");
  let dev: Connection | null = await connect((id) => baseModel(id) === fw.model, 5000);
  if (!dev) throw new RestoreError(`no ${fw.model} answered. Check the USB cable and close other MIDI apps.`, false);
  events.log?.(`found ${formatIdentity(dev.identity)} on "${dev.link.name}"`);

  if (!isOtaLoader(dev.identity)) {
    stage("checking", "The synth is checking the firmware package…");
    dev.link.send(UPGRADE_COMMAND);
    await sleep(timing.startDelayMs);
    const check = await serve(dev.link, fw.logical, (a) => a === OTA_ADDR_VERIFIED, timing.checkIdleMs, timing, events);
    if (check.terminal !== OTA_ADDR_VERIFIED) {
      dev.link.close();
      throw new RestoreError("the synth did not accept the package. Nothing was written; it should still work as before.", false);
    }
    events.log?.(`package check finished after ${check.served} requests`);
    await sleep(timing.verifyDrainMs);
    dev.link.close();

    stage("rebooting", "The synth is restarting into update mode…");
    dev = await connect((id) => isOtaLoader(id) && baseModel(id) === fw.model, timing.reconnectMs);
    if (!dev) {
      throw new RestoreError(
        "the synth did not come back in update mode. Unplug it, plug it back in, and run the restore again.",
        false,
      );
    }
    events.log?.(`update loader is ${formatIdentity(dev.identity)}`);
  } else {
    events.log?.("the synth is already in update mode, continuing from there");
  }

  stage("writing", "Writing firmware. Do not unplug the synth or close this tab.");
  events.progress?.(0);
  dev.link.send(UPGRADE_COMMAND);
  await sleep(timing.startDelayMs);
  const write = await serve(dev.link, fw.logical, () => true, timing.writeIdleMs, timing, events);
  dev.link.close();
  if (write.terminal === OTA_ADDR_VERIFIED) {
    throw new RestoreError("the update loader stopped after checking the package. The firmware was not written.", false);
  }
  if (write.terminal !== OTA_ADDR_FINISHED) {
    throw new RestoreError(
      "contact was lost while writing. Leave the synth plugged in and run the restore again; it can resume from update mode.",
      true,
    );
  }
  events.progress?.(1);
  events.log?.(`write finished after ${write.served} requests`);

  stage("confirming", "Waiting for the synth to restart…");
  const after = await connect((id) => !isOtaLoader(id) && id.model === fw.model, timing.reconnectMs * 2);
  if (!after) throw new RestoreError("the write finished, but the synth has not reappeared yet. Try unplugging and replugging it.", true);
  after.link.close();
  if (after.identity.version !== fw.version) {
    throw new RestoreError(
      `the synth restarted as ${formatIdentity(after.identity)}, not V${fw.version} as expected`,
      true,
    );
  }
  stage("done", `Restored to ${formatIdentity(after.identity)}.`);
}
