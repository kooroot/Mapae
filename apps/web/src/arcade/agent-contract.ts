import type {ActivityOutcome, AgentMode, AgentProfile, Decide} from "@mapae/arcade";
import type {Guardian} from "./guardian";
import type {Locale} from "../lib/i18n";

export type AutonomousGameProps = {
    appearance?: Guardian; profile: AgentProfile; locale: Locale; mode: AgentMode; seed: number;
    budget: {balance: number; allowance: number}; decide: Decide; reducedMotion: boolean;
    suspended?: boolean; autoAdvance?: boolean;
    onComplete: (result: ActivityOutcome) => void; onExit: () => void;
};

/** Human turns are supplied by UI controls, never an agent callback or a payment budget. */
export type PlayableGameProps = AutonomousGameProps | (Omit<AutonomousGameProps, "mode" | "decide" | "budget" | "autoAdvance"> & {
    mode: "human"; decide?: never; budget?: never; autoAdvance?: false;
});
