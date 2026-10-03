/** Synthesized locally; no audio assets or network requests. Only unlock on a gesture. */
export class ArcadeSound {
    private context: AudioContext | null = null;
    private enabled = false;

    async enable(enabled: boolean): Promise<boolean> {
        this.enabled = enabled;
        if (!enabled) {
            await this.context?.suspend();
            return true;
        }
        try {
            this.context ??= new AudioContext();
            await this.context.resume();
            return true;
        } catch {
            this.enabled = false;
            return false;
        }
    }

    play(kind: "hit" | "wrong" | "start" | "end" | "fever" | "golden" | "guard", combo = 0) {
        const ctx = this.context;
        if (!this.enabled || !ctx || ctx.state !== "running") return;
        const notes = kind === "fever" ? [523, 784, 1046, 1318] : kind === "golden" ? [784, 1046] : kind === "end" ? [523, 659, 784] :
            kind === "start" ? [330, 440, 660] : [kind === "wrong" ? 110 : kind === "guard" ? 170 : 420 + Math.min(combo, 20) * 24];
        notes.forEach((frequency, i) => {
            const start = ctx.currentTime + i * 0.09;
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = (kind === "wrong" || kind === "guard") ? "triangle" : "square";
            oscillator.frequency.setValueAtTime(frequency, start);
            oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.65, start + 0.10);
            gain.gain.setValueAtTime(0.045, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.13);
            oscillator.onended = () => {oscillator.disconnect(); gain.disconnect();};
        });
    }

    dispose() { void this.context?.close().catch(() => {}); this.context = null; }
}
