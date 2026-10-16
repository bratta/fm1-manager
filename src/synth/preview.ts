// Plays voices in the browser through the FM engine in an AudioWorklet.
// The audio context starts on the first note, since browsers only allow
// sound after the user has interacted with the page.

import type { Voice } from "../editor/patch";
import type { PreviewMessage } from "./processor";
import processorUrl from "./processor.ts?worker&url";

export class Preview {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private voice: Voice | null = null;
  private muted = 0;
  private volume = 0.7;

  private post(m: PreviewMessage) {
    this.node?.port.postMessage(m);
  }

  private start(): Promise<void> {
    this.starting ??= (async () => {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule(processorUrl);
      const node = new AudioWorkletNode(ctx, "fm1-preview", { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      if (this.voice) this.post({ type: "voice", voice: this.voice });
      this.post({ type: "muted", mask: this.muted });
      this.post({ type: "volume", volume: this.volume });
    })();
    return this.starting;
  }

  setVoice(voice: Voice) {
    this.voice = voice;
    this.post({ type: "voice", voice });
  }

  setMuted(mask: number) {
    this.muted = mask;
    this.post({ type: "muted", mask });
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.post({ type: "volume", volume });
  }

  async noteOn(note: number, velocity: number) {
    await this.start();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    this.post({ type: "noteOn", note, velocity });
  }

  noteOff(note: number) {
    // A quick tap can let go before the audio has finished starting.
    if (this.node) this.post({ type: "noteOff", note });
    else void this.starting?.then(() => this.post({ type: "noteOff", note }));
  }

  setSustain(on: boolean) {
    this.post({ type: "sustain", on });
  }

  allOff() {
    this.post({ type: "allOff" });
  }
}
