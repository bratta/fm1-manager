import { IDENTITY_QUERY, IDENTITY_REPLY_PREFIX, parseIdentity, type Identity } from "../protocol/vendor";

/** A two-way SysEx connection to one MIDI device. */
export interface SysexLink {
  readonly name: string;
  send(msg: Uint8Array): void;
  /** Next complete SysEx message, or null after timeoutMs. */
  receive(timeoutMs: number): Promise<Uint8Array | null>;
  /** Drop anything already received. */
  drain(): void;
  close(): void;
}

export interface Connection {
  link: SysexLink;
  identity: Identity;
}

/** Find a device whose identity passes accept, waiting up to timeoutMs. */
export type Connector = (accept: (id: Identity) => boolean, timeoutMs: number) => Promise<Connection | null>;

const startsWith = (msg: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => msg[i] === b);

/** Ask a device who it is. Returns null if it never answers like an FM-1. */
export async function handshake(link: SysexLink, attempts = 3, timeoutMs = 1000): Promise<Identity | null> {
  link.drain();
  for (let attempt = 0; attempt < attempts; attempt++) {
    link.send(IDENTITY_QUERY);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await link.receive(deadline - Date.now());
      if (!msg) break;
      if (startsWith(msg, IDENTITY_REPLY_PREFIX)) {
        const id = parseIdentity(msg);
        if (id) return id;
      }
    }
  }
  return null;
}
