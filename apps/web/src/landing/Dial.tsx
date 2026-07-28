import {ClientOnly} from "@tanstack/react-router";
import {Suspense, lazy, useEffect, useRef, useState} from "react";
import type {PointerEvent as ReactPointerEvent} from "react";

type MapaeRenderState = "loading" | "ready" | "fallback";

const LazyMapaeScene = lazy(async () => {
    const module = await import("./MapaeScene");
    return {default: module.MapaeScene};
});

const BOUNDARIES = [
    {
        key: "SCOPE",
        value: "ASSET + PAYEE",
        detail: "사용할 자산과 결제할 상대를 지정합니다",
    },
    {
        key: "BUDGET",
        value: "AMOUNT + PERIOD",
        detail: "소유자가 금액과 주기를 목적에 맞게 정합니다",
    },
    {
        key: "CONTROL",
        value: "EXPIRY + REVOKE",
        detail: "권한은 만료되며 소유자가 언제든 회수할 수 있습니다",
    },
] as const;

function SceneFallback() {
    return <span className="ritual-canvas-host" aria-hidden="true" />;
}

/**
 * One signed authority becomes a visible boundary field as the page moves.
 *
 * Scroll progress is kept in refs because the canvas needs a continuous signal
 * while React only needs three semantic phases. The object remains a product
 * explanation: pointer motion adds depth, but clicking only selects a boundary
 * and never gates Studio or performs a wallet action.
 */
export function Dial() {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef(1);
    const progressRef = useRef(0);
    const pointerRef = useRef({x: 0, y: 0});
    const burstRef = useRef(0);
    const [selected, setSelected] = useState(0);
    const [phase, setPhase] = useState(0);
    const [renderState, setRenderState] = useState<MapaeRenderState>("loading");

    useEffect(() => {
        const root = rootRef.current?.closest<HTMLElement>(".hero-action");
        if (!root) return;

        let frame = 0;
        const update = () => {
            frame = 0;
            const viewport = window.innerHeight;
            const distance = Math.max(root.offsetHeight - viewport, 1);
            const progress = Math.min(Math.max(-root.getBoundingClientRect().top / distance, 0), 1);
            progressRef.current = progress;
            const nextPhase = progress < 0.27 ? 0 : progress < 0.66 ? 1 : 2;
            setPhase((current) => (current === nextPhase ? current : nextPhase));
        };
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(update);
        };

        update();
        window.addEventListener("scroll", schedule, {passive: true});
        window.addEventListener("resize", schedule);
        return () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
        };
    }, []);

    function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        if (event.pointerType === "touch") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerRef.current = {
            x: ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
            y: ((event.clientY - bounds.top) / bounds.height - 0.5) * 2,
        };
    }

    function chooseBoundary(index: number) {
        stageRef.current = index + 1;
        burstRef.current = 1;
        setSelected(index);
    }

    function selectNextBoundary() {
        chooseBoundary((selected + 1) % BOUNDARIES.length);
    }

    const current = BOUNDARIES[selected] ?? BOUNDARIES[0];

    return (
        <div
            className="ritual"
            ref={rootRef}
            data-phase={phase}
            data-selected={selected}
            data-render={renderState}
        >
            <button
                className="ritual-object"
                type="button"
                aria-label={`${current.key}: ${current.detail}. 다음 경계 보기`}
                onPointerMove={onPointerMove}
                onPointerLeave={() => {
                    pointerRef.current = {x: 0, y: 0};
                }}
                onClick={selectNextBoundary}
            >
                <ClientOnly fallback={<SceneFallback />}>
                    <Suspense fallback={<SceneFallback />}>
                        <LazyMapaeScene
                            stageRef={stageRef}
                            progressRef={progressRef}
                            pointerRef={pointerRef}
                            burstRef={burstRef}
                            onRenderState={setRenderState}
                        />
                    </Suspense>
                </ClientOnly>
                <span className="ritual-medallion" aria-hidden="true">
                    <span>
                        <img
                            src="/brand/emblem.png"
                            alt=""
                            width={439}
                            height={512}
                            draggable={false}
                        />
                    </span>
                </span>
                <span className="ritual-tap" aria-hidden="true">
                    TRACE THE BOUNDARY
                </span>
            </button>

            <dl className="ritual-proof" aria-label="Mapae product principles">
                <div>
                    <dt>OWNER</dt>
                    <dd>SETS THE SCOPE</dd>
                </div>
                <div>
                    <dt>CHAIN</dt>
                    <dd>ENFORCES IT</dd>
                </div>
                <div>
                    <dt>AGENT</dt>
                    <dd>ACTS WITHIN</dd>
                </div>
            </dl>

            <ol className="ritual-boundaries" aria-label="위임된 권한의 경계">
                {BOUNDARIES.map((boundary, index) => (
                    <li key={boundary.key} data-active={selected === index ? "true" : "false"}>
                        <button
                            type="button"
                            onClick={() => chooseBoundary(index)}
                            aria-label={`${boundary.key}: ${boundary.detail}`}
                        >
                            <i aria-hidden="true" />
                            <span>{boundary.key}</span>
                            <strong>{boundary.value}</strong>
                        </button>
                    </li>
                ))}
            </ol>

            <p className="ritual-readout" aria-live="polite">
                <span>{current.key}</span>
                <strong>{current.value}</strong>
                <small>{current.detail}</small>
            </p>

            <div className="ritual-scroll-cue" aria-hidden="true">
                <span>SCROLL TO OPEN THE MANDATE</span>
                <i />
            </div>
        </div>
    );
}
