import {useEffect, useRef, useState} from "react";
import {HorseHead} from "../brand/marks";
import {shownPolicy} from "../lib/config";
import {formatCountdown, struckTicks, tickCount} from "../lib/dial";

/*
 * The engraved dial.
 *
 * This is the argument as an object: the ticks are the cap, the sweep is the
 * period, and the number cut into the centre is where the authority ends. There
 * is no progress bar anywhere in this product — a bar says "how far along", and
 * the claim being made is "how far is permitted".
 *
 * It is a POLICY PREVIEW and says so on its face. It draws the shape of the
 * permission the demo uses; it is not reading a live delegation, and pretending
 * otherwise would put a marketing page's hero on the critical path of a public
 * RPC. The live reading belongs to the console, which has a delegation to read
 * and an operator to read it. The one thing here that is not a preview is the
 * refusal: `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` is the string
 * the deployed enforcer actually returns.
 */

const SIZE = 400;
const CENTRE = SIZE / 2;
const R_RIM_OUTER = 186;
const R_RIM_INNER = 172;
const R_SWEEP = 178;
const R_TICK_TOP = 166;
const R_MAJOR_BASE = 144;
const R_MINOR_BASE = 156;

/** Polar to cartesian, with 12 o'clock at zero — the way a tally is read. */
function point(radius: number, turn: number): {x: number; y: number} {
    const radians = (turn * 360 - 90) * (Math.PI / 180);
    return {x: CENTRE + radius * Math.cos(radians), y: CENTRE + radius * Math.sin(radians)};
}

type Attempt = {kind: "idle"} | {kind: "refused"; at: number};

export function Dial() {
    const ticks = tickCount(shownPolicy.periodAmount);
    const spentAmount = 1_000_000n; // the preview stands one payment into its period
    const struck = struckTicks(shownPolicy.periodAmount, shownPolicy.periodAmount - spentAmount);

    const [turn, setTurn] = useState(0);
    const [attempt, setAttempt] = useState<Attempt>({kind: "idle"});
    const frame = useRef<number>(0);

    // The sweep runs off a wall clock reduced modulo the period, not off a CSS
    // `animation-duration`. A CSS clock free-runs against the visitor's machine
    // and drifts; drift is the exact property this product claims does not
    // happen, so the animation is not allowed to introduce it. The console's
    // live dial reads the chain's block timestamp for the same reason.
    useEffect(() => {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const period = Number(shownPolicy.periodDurationSeconds) * 1000;
        if (reduced) {
            setTurn((Date.now() % period) / period);
            return;
        }
        const tick = () => {
            setTurn((Date.now() % period) / period);
            frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame.current);
    }, []);

    // Auto-clear, so the refusal reads as an event rather than as a state the
    // page got stuck in.
    useEffect(() => {
        if (attempt.kind !== "refused") return;
        const timer = setTimeout(() => setAttempt({kind: "idle"}), 6_000);
        return () => clearTimeout(timer);
    }, [attempt]);

    const refused = attempt.kind === "refused";
    const remaining = BigInt(
        Math.max(Math.ceil(Number(shownPolicy.periodDurationSeconds) * (1 - turn)), 0),
    );
    const sweep = point(R_SWEEP, refused ? struck / ticks : turn);

    return (
        <div className="dial" data-refused={refused}>
            <svg
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className="dial-face"
                role="img"
                aria-label={`한도 3 mUSDC, 주기 60초. 이번 주기 사용 1, 남음 2.`}
            >
                {/* The rim is masked so it dissolves at its own baseline. The object
                    has an edge that ends — which is the thesis, drawn. The mask is on
                    the rim and never on the type: a Korean sentence in fog is a
                    sentence nobody reads. */}
                <defs>
                    <linearGradient id="rimFade" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0.58" stopColor="#fff" stopOpacity="1" />
                        <stop offset="0.86" stopColor="#fff" stopOpacity="0.32" />
                        <stop offset="1" stopColor="#fff" stopOpacity="0" />
                    </linearGradient>
                    <mask id="rimMask">
                        <rect width={SIZE} height={SIZE} fill="url(#rimFade)" />
                    </mask>
                </defs>

                <g mask="url(#rimMask)">
                    <circle
                        cx={CENTRE}
                        cy={CENTRE}
                        r={R_RIM_OUTER}
                        className="rim"
                        strokeWidth="1.5"
                    />
                    <circle cx={CENTRE} cy={CENTRE} r={R_RIM_INNER} className="rim-inner" />

                    {/* Minor ticks — four to a whole token. Non-text weight, so they
                        may carry --ink-4 without touching the contrast floor. */}
                    {Array.from({length: ticks * 4}, (_, index) => {
                        if (index % 4 === 0) return null;
                        const t = index / (ticks * 4);
                        const a = point(R_TICK_TOP, t);
                        const b = point(R_MINOR_BASE, t);
                        return (
                            <line
                                key={`minor-${index}`}
                                x1={a.x}
                                y1={a.y}
                                x2={b.x}
                                y2={b.y}
                                className="tick-minor"
                            />
                        );
                    })}

                    {/* Major ticks — one per whole token. A struck one is spent, and
                        struck is the tally's own verb. */}
                    {Array.from({length: ticks}, (_, index) => {
                        const t = index / ticks;
                        const a = point(R_TICK_TOP, t);
                        const b = point(R_MAJOR_BASE, t);
                        const isStruck = index < struck;
                        return (
                            <line
                                key={`major-${index}`}
                                x1={a.x}
                                y1={a.y}
                                x2={b.x}
                                y2={b.y}
                                className={isStruck ? "tick-struck" : "tick-major"}
                            />
                        );
                    })}

                    {/* The boundary itself: the arc past the last permitted tick.
                        Drawn only when a refusal happens, and it is the only moment
                        red covers distance rather than marking a point. */}
                    {refused && (
                        <path
                            className="over"
                            d={describeArc(R_TICK_TOP - 6, struck / ticks, 3.5 / ticks)}
                        />
                    )}
                </g>

                {/* The sweep. It stops on refusal — stillness reads as authority,
                    where a shake would read as a bug. */}
                <g transform={`translate(${sweep.x} ${sweep.y})`}>
                    <g transform={`rotate(${(refused ? struck / ticks : turn) * 360})`}>
                        <path d="M0 -9 L9 8 H4.5 L0 -0.5 L-4.5 8 H-9 Z" className="sweep" />
                    </g>
                </g>

                {/* The centre is the engraving. */}
                <g transform={`translate(${CENTRE - 46} ${CENTRE - 74})`}>
                    <HorseHead size={92} ink="var(--ink)" accent="var(--red)" />
                </g>
                <text x={CENTRE} y={CENTRE + 58} className="engraved" textAnchor="middle">
                    3 mUSDC / 60s
                </text>
            </svg>

            <div className="dial-readout">
                <p className="value dial-live" aria-live="off">
                    사용 <strong>1</strong> / 3 · {formatCountdown(remaining)} 후 초기화
                </p>
                <button
                    type="button"
                    className="ghost"
                    onClick={() => setAttempt({kind: "refused", at: Date.now()})}
                    disabled={refused}
                >
                    3.5 결제 시도
                </button>
            </div>

            {/* aria-live on the container, not on the countdown: a screen reader
                announcing a ticking clock every frame is unusable, while the
                refusal is exactly the event that must be announced. */}
            <div className="dial-verdict" role="status" aria-live="polite">
                {refused ? (
                    <p className="value refusal-line">
                        <span className="refusal-tag">거절</span>
                        ERC20PeriodTransferEnforcer:transfer-amount-exceeded
                    </p>
                ) : (
                    <p className="label">
                        한도를 넘겨보세요. 되돌리는 것은 이 서버가 아니라 인포서 컨트랙트입니다.
                    </p>
                )}
            </div>
        </div>
    );
}

/** An arc between two turns, used once: to draw the part that was refused. */
function describeArc(radius: number, from: number, to: number): string {
    const start = point(radius, from);
    const end = point(radius, to);
    const large = to - from > 0.5 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}
