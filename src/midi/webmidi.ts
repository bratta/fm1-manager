import { handshake, type Connection, type Connector, type SysexLink } from "./link";

/** Port names the FM-1 has been seen under (normal and update mode). */
const FM1_PORT_HINT = /fm-?1|usb composite|usb-midi|sinco/i;

// Windows prefixes duplicate names with "2 - ", macOS sometimes appends " Port 1".
const portKey = (name: string | null) => (name ?? "").replace(/^\d+\s*-\s*/, "").trim().toLowerCase();

export async function openMidi(): Promise<MIDIAccess> {
  if (!navigator.requestMIDIAccess) {
    throw new Error("This browser has no Web MIDI. Use Chrome, Edge or Opera on desktop.");
  }
  try {
    return await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    throw new Error("MIDI access was refused. Allow MIDI (with SysEx) for this page and try again.");
  }
}

class WebMidiLink implements SysexLink {
  private queue: Uint8Array[] = [];
  private waiter: ((m: Uint8Array | null) => void) | null = null;
  private readonly onMessage = (e: MIDIMessageEvent) => {
    const data = e.data;
    if (!data || data[0] !== 0xf0) return;
    const msg = new Uint8Array(data);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else this.queue.push(msg);
  };

  constructor(
    private readonly input: MIDIInput,
    private readonly output: MIDIOutput,
  ) {
    input.addEventListener("midimessage", this.onMessage);
  }

  get name() {
    return this.output.name ?? "MIDI port";
  }

  send(msg: Uint8Array) {
    if (this.output.state !== "connected") throw new Error("port disconnected");
    this.output.send(msg);
  }

  receive(timeoutMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  drain() {
    this.queue = [];
  }

  close() {
    this.input.removeEventListener("midimessage", this.onMessage);
    this.waiter?.(null);
    this.waiter = null;
  }
}

/** Input/output pairs that belong to the same device, likeliest FM-1 first. */
export function portPairs(access: MIDIAccess): [MIDIInput, MIDIOutput][] {
  const outputs = [...access.outputs.values()].filter((o) => o.state === "connected");
  const pairs: [MIDIInput, MIDIOutput][] = [];
  for (const input of access.inputs.values()) {
    if (input.state !== "connected") continue;
    const output = outputs.find((o) => portKey(o.name) === portKey(input.name));
    if (output) pairs.push([input, output]);
  }
  return pairs.sort((a, b) => Number(FM1_PORT_HINT.test(b[0].name ?? "")) - Number(FM1_PORT_HINT.test(a[0].name ?? "")));
}

/** Connector that polls the system's MIDI ports for an FM-1. */
export function webMidiConnector(access: MIDIAccess): Connector {
  return async (accept, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    do {
      for (const [input, output] of portPairs(access)) {
        const link = new WebMidiLink(input, output);
        try {
          const identity = await handshake(link, 2, 700);
          if (identity && accept(identity)) return { link, identity } satisfies Connection;
        } catch {
          // port went away mid-handshake; keep looking
        }
        link.close();
      }
      await new Promise((r) => setTimeout(r, 500));
    } while (Date.now() < deadline);
    return null;
  };
}
