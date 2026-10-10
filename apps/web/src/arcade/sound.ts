export type SoundKind = "hit" | "wrong" | "start" | "end" | "fever" | "golden" | "guard" | "perfect" | "tick" | "go" | "combo" | "break" | "seal" | "feverEnd" | "record" | "coin";

/** One chiptune gesture: notes stepped `gap` seconds apart, each falling to `glide` × its pitch over 100ms. */
type Voice = {notes: number[]; wave: OscillatorType; gap?: number; glide?: number; gain?: number};

/** Two semitones per step, capped so a long streak stays pleasant. */
const lift = (frequency: number, steps: number) => frequency * 2 ** (Math.min(Math.max(steps, 0), 8) / 6);

function voice(kind: SoundKind, combo: number): Voice {
    switch (kind) {
        case "hit": return {notes: [420 + Math.min(combo, 20) * 24], wave: "square"};
        case "wrong": return {notes: [110], wave: "triangle"};
        case "guard": return {notes: [170], wave: "triangle"};
        case "start": return {notes: [330, 440, 660], wave: "square"};
        case "end": return {notes: [523, 659, 784], wave: "square"};
        case "fever": return {notes: [523, 784, 1046, 1318], wave: "square"};
        case "golden": return {notes: [784, 1046], wave: "square"};
        case "perfect": return {notes: [880, 1320, 1760], wave: "square"};
        // A dry countdown blip, then an octave leap on the go.
        case "tick": return {notes: [660], wave: "triangle", glide: 1, gain: 0.035};
        case "go": return {notes: [523, 1046], wave: "square", gap: 0.06, glide: 1};
        // `combo` is the multiplier just reached; every tier climbs the same rising fourth a step higher.
        case "combo": return {notes: [lift(587, combo - 1), lift(784, combo - 1)], wave: "square", gap: 0.06};
        case "break": return {notes: [392, 262], wave: "triangle", gap: 0.08};
        // A low wooden thump under the stamp, felt more than heard.
        case "seal": return {notes: [196], wave: "triangle", glide: 0.5, gain: 0.06};
        // The fever arpeggio played back down.
        case "feverEnd": return {notes: [1046, 784, 523], wave: "square", gap: 0.08};
        case "record": return {notes: [659, 784, 1046, 1568], wave: "square", gap: 0.1, glide: 1};
        case "coin": return {notes: [988, 1319], wave: "square", gap: 0.07, glide: 1, gain: 0.035};
    }
}

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

    /** `delayMs` schedules on the audio clock, so a cue lands with the motion it accompanies instead of drifting with a timer. */
    play(kind: SoundKind, combo = 0, delayMs = 0) {
        const ctx = this.context;
        if (!this.enabled || !ctx || ctx.state !== "running") return;
        const {notes, wave, gap = 0.09, glide = 0.65, gain: level = 0.045} = voice(kind, combo);
        const at = ctx.currentTime + Math.max(delayMs, 0) / 1000;
        notes.forEach((frequency, i) => {
            const start = at + i * gap;
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = wave;
            oscillator.frequency.setValueAtTime(frequency, start);
            oscillator.frequency.exponentialRampToValueAtTime(frequency * glide, start + 0.10);
            gain.gain.setValueAtTime(level, start);
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
