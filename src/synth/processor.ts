// AudioWorklet that runs the FM engine. The page talks to it with messages
// (see PreviewMessage); it never touches MIDI or the synth.

import type { Voice } from "../editor/patch";
import { FmEngine } from "./engine";

export type PreviewMessage =
  | { type: "voice"; voice: Voice }
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "sustain"; on: boolean }
  | { type: "muted"; mask: number }
  | { type: "volume"; volume: number }
  | { type: "allOff" };

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class FmProcessor extends AudioWorkletProcessor {
  private engine = new FmEngine(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<PreviewMessage>) => {
      const m = e.data;
      switch (m.type) {
        case "voice": return this.engine.setVoice(m.voice);
        case "noteOn": return this.engine.noteOn(m.note, m.velocity);
        case "noteOff": return this.engine.noteOff(m.note);
        case "sustain": return this.engine.setSustain(m.on);
        case "muted": return this.engine.setMuted(m.mask);
        case "volume": return void (this.engine.volume = m.volume);
        case "allOff": return this.engine.allNotesOff();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = outputs[0];
    if (!channels?.[0]) return true;
    this.engine.render(channels[0]);
    for (let c = 1; c < channels.length; c++) channels[c]!.set(channels[0]);
    return true;
  }
}

registerProcessor("fm1-preview", FmProcessor);
