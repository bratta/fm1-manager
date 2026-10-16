// Back up all 128 presets by stepping through them. The stock firmware can't
// dump its stored presets, but from V14 it selects preset n+1 on MIDI Program
// Change n, and it can send back the voice that's currently loaded. So we
// select each preset in turn and read it.

import type { SysexLink } from "./midi/link";
import { buildReadCurrentVoice, parseCurrentVoice } from "./protocol/vendor";
import { equalBytes } from "./protocol/bytes";
import { vcedName } from "./protocol/dx7";

export const PRESET_COUNT = 128;

export interface BackupOptions {
  /** MIDI channel 1-16 to send Program Change on. The FM-1 listens on all by default. */
  channel: number;
  /** Time for the synth to load a preset before we read it. */
  settleMs: number;
  readTimeoutMs: number;
  retries: number;
  progress?(done: number, name: string): void;
  signal?: AbortSignal;
}

export const DEFAULT_BACKUP: BackupOptions = { channel: 1, settleMs: 150, readTimeoutMs: 1500, retries: 2 };

export class BackupError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readVoice(link: SysexLink, timeoutMs: number): Promise<Uint8Array | null> {
  link.drain();
  link.send(buildReadCurrentVoice());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await link.receive(deadline - Date.now());
    if (!msg) return null;
    const vced = parseCurrentVoice(msg);
    if (vced) return vced;
  }
  return null;
}

export const programChange = (channel: number, program: number) =>
  Uint8Array.from([0xc0 | ((channel - 1) & 0x0f), program & 0x7f]);

/** Returns the 128 presets as 155-byte VCED voices, in preset order. */
export async function backupAllPresets(link: SysexLink, opts: BackupOptions = DEFAULT_BACKUP): Promise<Uint8Array[]> {
  const voices: Uint8Array[] = [];
  for (let program = 0; program < PRESET_COUNT; program++) {
    if (opts.signal?.aborted) throw new BackupError("backup cancelled");
    link.send(programChange(opts.channel, program));
    await sleep(opts.settleMs);

    let voice: Uint8Array | null = null;
    for (let attempt = 0; attempt <= opts.retries && !voice; attempt++) {
      voice = await readVoice(link, opts.readTimeoutMs);
    }
    if (!voice) throw new BackupError(`the synth stopped answering at preset ${program + 1}`);
    voices.push(voice);
    opts.progress?.(program + 1, vcedName(voice));

    // If the first few presets all read back identical, the synth is almost
    // certainly ignoring Program Change (wrong MIDI channel or old firmware).
    if (program === 3 && voices.every((v) => equalBytes(v, voices[0]!))) {
      throw new BackupError(
        "the synth doesn't seem to be switching presets. Check that its MIDI channel is set to All or matches the channel chosen here, and that it runs firmware V14 or later.",
      );
    }
  }
  return voices;
}

