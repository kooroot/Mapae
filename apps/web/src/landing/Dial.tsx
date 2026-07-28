import {useEffect, useRef, useState} from "react";
import {GuillocheSeal} from "../brand/Guilloche";
import {EMBLEM_ASPECT} from "../brand/marks";
import {shownPolicy} from "../lib/config";
import {formatCountdown, struckTicks, tickCount} from "../lib/dial";

/*
 * The engraved dial.
 *
 * This is the argument as an object: the sectors are the cap, the sweep is the
 * period, and the emblem cut into the centre is where the authority ends. There
 * is no progress bar anywhere in this product — a bar says "how far along", and
 * the claim being made is "how far is permitted".
 *
 * TWO QUANTITIES, DRAWN DIFFERENTLY ON PURPOSE. A dial showing both an amount
 * and a duration is only readable if the eye can tell which is which without a
 * legend, so they never share a visual language:
 *
 *   amount  — the inner track, thick, divided into one sector per whole token,
 *             filled red once spent. Discrete, because the cap is discrete.
 *   period  — the outer ring, one hairline tick per second and a continuous
 *             sweep. Continuous, because time is.
 *
 * An earlier version drew the cap as three bare ticks on a 400px face. Three
 * marks on that much circumference is not a tally, it is three marks, and it
 * read as an unfinished clock.
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

const R_BEZEL_OUTER = 192;
const R_BEZEL_INNER = 182;
const R_SECOND_TOP = 178; // the 60 period ticks hang from here
const R_SECOND_BASE = 171;
const R_SECOND_BASE_5 = 166;
const R_SWEEP = 178;
const R_TRACK = 126; // the amount track's centreline
const TRACK_WEIGHT = 15;
const R_OVERSHOOT = 205; // the refused attempt, drawn outside the bezel
const EMBLEM_W = 104;

const ATTEMPT = 3.5; // mUSDC, against a cap of 3 — the demo's over-cap payment

/** Polar to cartesian, with 12 o'clock at zero — the way a tally is read. */
function point(radius: number, turn: number): {x: number; y: number} {
    const radians = (turn * 360 - 90) * (Math.PI / 180);
    return {x: CENTRE + radius * Math.cos(radians), y: CENTRE + radius * Math.sin(radians)};
}

/** An arc from one turn to another. Handles sweeps past a half circle. */
function arc(radius: number, from: number, to: number): string {
    const start = point(radius, from);
    const end = point(radius, to);
    const large = to - from > 0.5 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

type Attempt = {kind: "idle"} | {kind: "refused"; frozenTurn: number};

export function Dial() {
    const ticks = tickCount(shownPolicy.periodAmount);
    const spentAmount = 1_000_000n; // the preview stands one payment into its period
    const struck = struckTicks(shownPolicy.periodAmount, shownPolicy.periodAmount - spentAmount);
    const periodSeconds = Number(shownPolicy.periodDurationSeconds);

    const [turn, setTurn] = useState(0);
    const [attempt, setAttempt] = useState<Attempt>({kind: "idle"});
    const frame = useRef<number>(0);
    const latestTurn = useRef(0);

    // The sweep runs off a wall clock reduced modulo the period, not off a CSS
    // `animation-duration`. A CSS clock free-runs against the visitor's machine
    // and drifts; drift is the exact property this product claims does not
    // happen, so the animation is not allowed to introduce it. The console's
    // live dial reads the chain's block timestamp for the same reason.
    useEffect(() => {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const period = periodSeconds * 1000;
        const read = () => {
            const next = (Date.now() % period) / period;
            latestTurn.current = next;
            setTurn(next);
        };
        read();
        if (reduced) return;
        const tick = () => {
            read();
            frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame.current);
    }, [periodSeconds]);

    // Auto-clear, so the refusal reads as an event rather than as a state the
    // page got stuck in.
    useEffect(() => {
        if (attempt.kind !== "refused") return;
        const timer = setTimeout(() => setAttempt({kind: "idle"}), 6_000);
        return () => clearTimeout(timer);
    }, [attempt]);

    const refused = attempt.kind === "refused";
    // Frozen at the instant of refusal rather than snapped to the amount: the
    // sweep is the CLOCK, and parking the clock's hand at a position that means
    // an amount is the kind of quiet category error that makes an instrument
    // unreadable. Stillness reads as authority; a shake would read as a bug.
    const shownTurn = refused ? attempt.frozenTurn : turn;
    const remaining = BigInt(Math.max(Math.ceil(periodSeconds * (1 - shownTurn)), 0));
    const sweep = point(R_SWEEP, shownTurn);
    const gap = 0.012; // angular gap between sectors, in turns

    return (
        <div className="dial" data-refused={refused}>
            <GuillocheSeal size={300} className="dial-seal" />
            <svg
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className="dial-face"
                role="img"
                aria-label={`한도 ${ticks} mUSDC, 주기 ${periodSeconds}초. 이번 주기 사용 ${struck}, 남음 ${ticks - struck}.`}
            >
                <circle cx={CENTRE} cy={CENTRE} r={R_BEZEL_OUTER} className="bezel" />
                <circle cx={CENTRE} cy={CENTRE} r={R_BEZEL_INNER} className="bezel-inner" />

                {/* The period, one hairline per second. Every fifth is longer, the
                    way a real dial marks its intervals — this is what makes the
                    object read as an instrument before a single number is read. */}
                {Array.from({length: periodSeconds}, (_, index) => {
                    const t = index / periodSeconds;
                    const major = index % 5 === 0;
                    const a = point(R_SECOND_TOP, t);
                    const b = point(major ? R_SECOND_BASE_5 : R_SECOND_BASE, t);
                    return (
                        <line
                            key={`s-${index}`}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            className={major ? "second-major" : "second"}
                        />
                    );
                })}

                {/* Elapsed. Neutral, never red: nothing has been refused by the
                    clock — it is simply later than it was. */}
                {shownTurn > 0.004 && (
                    <path className="elapsed" d={arc(R_BEZEL_INNER, 0, Math.min(shownTurn, 0.999))} />
                )}

                {/* The cap: one sector per whole token. Struck through once spent —
                    a tally records what was used, it does not erase it. */}
                {Array.from({length: ticks}, (_, index) => {
                    const from = index / ticks + gap / 2;
                    const to = (index + 1) / ticks - gap / 2;
                    const isStruck = index < struck;
                    return (
                        <path
                            key={`sector-${index}`}
                            d={arc(R_TRACK, from, to)}
                            strokeWidth={TRACK_WEIGHT}
                            className={isStruck ? "sector-struck" : "sector"}
                        />
                    );
                })}

                {/* The boundary itself. An SVG arc cannot draw more than a full
                    turn, and the attempt is more than the cap by construction, so
                    the overshoot is clamped just short of closing and given a barb
                    — the reading is "it ran past the edge", not "it ran 0.97 of
                    the way round". */}
                {refused && (
                    <g className="overshoot">
                        <path className="over" d={arc(R_OVERSHOOT, 0, 0.965)} />
                        <path
                            className="over-barb"
                            d={`M ${point(R_OVERSHOOT, 0.965).x} ${point(R_OVERSHOOT, 0.965).y} l -13 -3 l 5 12 Z`}
                        />
                        <line
                            className="boundary"
                            x1={point(R_BEZEL_INNER - 4, 0).x}
                            y1={point(R_BEZEL_INNER - 4, 0).y}
                            x2={point(R_OVERSHOOT + 9, 0).x}
                            y2={point(R_OVERSHOOT + 9, 0).y}
                        />
                    </g>
                )}

                {/* The sweep, riding the second ring. */}
                <g transform={`translate(${sweep.x} ${sweep.y}) rotate(${shownTurn * 360})`}>
                    <path d="M0 -10 L8.5 7 H4.2 L0 -0.5 L-4.2 7 H-8.5 Z" className="sweep" />
                </g>

                {/* The centre is the engraving: the supplied emblem, and directly
                    under it the one string that is the whole thesis. */}
                <image
                    href="/brand/emblem.png"
                    x={CENTRE - EMBLEM_W / 2}
                    y={CENTRE - 84}
                    width={EMBLEM_W}
                    height={EMBLEM_W * EMBLEM_ASPECT}
                    preserveAspectRatio="xMidYMid meet"
                />
                <text x={CENTRE} y={CENTRE + 84} className="engraved" textAnchor="middle">
                    3 mUSDC / 60s
                </text>
                <text x={CENTRE} y={CENTRE + 104} className="engraved-sub" textAnchor="middle">
                    POLICY PREVIEW
                </text>
            </svg>

            <div className="dial-readout">
                <p className="value dial-live" aria-live="off">
                    사용 <strong>{struck}</strong> / {ticks} · {formatCountdown(remaining)} 후 초기화
                </p>
                <button
                    type="button"
                    className="ghost"
                    onClick={() => setAttempt({kind: "refused", frozenTurn: latestTurn.current})}
                    disabled={refused}
                >
                    {ATTEMPT} 결제 시도
                </button>
            </div>

            {/* aria-live on the container, not on the countdown: a screen reader
                announcing a ticking clock every frame is unusable, while the
                refusal is exactly the event that must be announced. */}
            <div className="dial-verdict" role="status" aria-live="polite">
                {refused ? (
                    /* The sentence first, the exact string second. The revert
                       reason is the strongest evidence on this page and it is not
                       being hidden — but it is an answer, not a headline, and a
                       visitor should learn what happened before they are handed a
                       contract name. */
                    <p className="value refusal-line">
                        <span className="refusal-tag">거절</span>
                        한도를 넘어서 결제가 이뤄지지 않았습니다
                        <span className="refusal-raw">
                            ERC20PeriodTransferEnforcer:transfer-amount-exceeded
                        </span>
                    </p>
                ) : (
                    <p className="label">
                        한도를 넘겨보세요. 막는 것은 이 서버가 아니라 체인입니다.
                    </p>
                )}
            </div>
        </div>
    );
}
