import {ClientOnly} from "@tanstack/react-router";
import {Suspense, lazy, useEffect, useRef, useState} from "react";
import type {PointerEvent as ReactPointerEvent} from "react";
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";

type MapaeRenderState = "loading" | "ready" | "fallback";

const LazyMapaeScene = lazy(async () => {
    const module = await import("./MapaeScene");
    return {default: module.MapaeScene};
});

const BOUNDARIES = [
    {key: "SCOPE", value: "ASSET + PAYEE"},
    {key: "BUDGET", value: "AMOUNT + PERIOD"},
    {key: "CONTROL", value: "EXPIRY + REVOKE"},
] as const;

type BoundaryKey = (typeof BOUNDARIES)[number]["key"];

const COPY: Record<
    Locale,
    {
        details: Record<BoundaryKey, string>;
        nextBoundary: string;
        boundariesAria: string;
    }
> = {
    en: {
        details: {
            SCOPE: "Specifies the asset to spend and the payee to pay",
            BUDGET: "The owner sets the amount and period to fit the purpose",
            CONTROL: "The permission expires, and the owner can revoke it at any time",
        },
        nextBoundary: "Show the next boundary",
        boundariesAria: "Boundaries of the delegated permission",
    },
    ko: {
        details: {
            SCOPE: "사용할 자산과 결제할 상대를 지정합니다",
            BUDGET: "소유자가 금액과 주기를 목적에 맞게 정합니다",
            CONTROL: "권한은 만료되며 소유자가 언제든 회수할 수 있습니다",
        },
        nextBoundary: "다음 경계 보기",
        boundariesAria: "위임된 권한의 경계",
    },
};

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
    const {locale} = useLocale();
    const t = COPY[locale];
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef(1);
    const progressRef = useRef(0);
    const pointerRef = useRef({x: 0, y: 0});
    const burstRef = useRef(0);
    const [sceneEnabled, setSceneEnabled] = useState(false);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const motion = matchMedia("(prefers-reduced-motion: reduce)");
        let near = false;
        const update = () => setSceneEnabled(near && !motion.matches);
        const observer = new IntersectionObserver(entries => {near = entries[0]?.isIntersecting ?? false; update();}, {rootMargin: "160px"});
        observer.observe(root); motion.addEventListener("change", update);
        return () => {observer.disconnect(); motion.removeEventListener("change", update);};
    }, []);
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

    const labels = locale === "ko" ? {SCOPE: ["사용 범위", "자산 · 수취인"], BUDGET: ["지출 한도", "금액 · 주기"], CONTROL: ["내 통제권", "만료 · 회수"]} : {SCOPE: ["Scope", "Asset · Payee"], BUDGET: ["Budget", "Amount · Period"], CONTROL: ["Control", "Expiry · Revoke"]};
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
                aria-label={`${labels[current.key][0]}: ${t.details[current.key]}. ${t.nextBoundary}`}
                onPointerMove={onPointerMove}
                onPointerLeave={() => {
                    pointerRef.current = {x: 0, y: 0};
                }}
                onClick={selectNextBoundary}
            >
                {sceneEnabled && <ClientOnly fallback={<SceneFallback />}>
                    <Suspense fallback={<SceneFallback />}>
                        <LazyMapaeScene
                            stageRef={stageRef}
                            progressRef={progressRef}
                            pointerRef={pointerRef}
                            burstRef={burstRef}
                            onRenderState={setRenderState}
                        />
                    </Suspense>
                </ClientOnly>}
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
                    {locale === "ko" ? "눌러서 권한 경계 살펴보기" : "Explore the boundaries"}
                </span>
            </button>

            <dl className="ritual-proof" aria-label={locale === "ko" ? "마패의 작동 원리" : "Mapae product principles"}>
                <div>
                    <dt>{locale === "ko" ? "소유자" : "OWNER"}</dt>
                    <dd>{locale === "ko" ? "범위를 정하고" : "SETS THE SCOPE"}</dd>
                </div>
                <div>
                    <dt>{locale === "ko" ? "체인" : "CHAIN"}</dt>
                    <dd>{locale === "ko" ? "한도를 지키고" : "ENFORCES IT"}</dd>
                </div>
                <div>
                    <dt>{locale === "ko" ? "에이전트" : "AGENT"}</dt>
                    <dd>{locale === "ko" ? "안에서 행동해요" : "ACTS WITHIN"}</dd>
                </div>
            </dl>

            <ol className="ritual-boundaries" aria-label={t.boundariesAria}>
                {BOUNDARIES.map((boundary, index) => (
                    <li key={boundary.key} data-active={selected === index ? "true" : "false"}>
                        <button
                            type="button"
                            onClick={() => chooseBoundary(index)}
                            aria-label={`${labels[boundary.key][0]}: ${t.details[boundary.key]}`}
                        >
                            <i aria-hidden="true" />
                            <span>{labels[boundary.key][0]}</span>
                            <strong>{labels[boundary.key][1]}</strong>
                        </button>
                    </li>
                ))}
            </ol>

            <p className="ritual-readout" aria-live="polite">
                <span>{labels[current.key][0]}</span>
                <strong>{labels[current.key][1]}</strong>
                <small>{t.details[current.key]}</small>
            </p>

            <div className="ritual-scroll-cue" aria-hidden="true">
                <span>{locale === "ko" ? "아래에서 더 알아보기" : "Scroll to explore"}</span>
                <i />
            </div>
        </div>
    );
}
