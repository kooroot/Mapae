import {useEffect, useRef, useState, type ReactNode} from "react";

/**
 * Reveal on first approach, once, and never again.
 *
 * Three decisions here are deliberate and each is a way this pattern usually
 * goes wrong.
 *
 * **It unobserves after firing.** A reveal that re-triggers on scroll-up turns a
 * page into an aquarium — content that animates every time it is passed reads as
 * a screensaver, not as a document.
 *
 * **It starts visible and is hidden by a class the observer removes.** The
 * inverse — hidden by default, shown by JS — leaves every section blank for a
 * reader with JS disabled or a bot that does not run it, and this page is
 * prerendered specifically so its argument survives without JS. `.reveal` only
 * hides once `data-armed` is set, which happens in an effect, so the static HTML
 * is never invisible.
 *
 * **Reduced motion skips the whole mechanism**, rather than shortening it. An
 * 0.01ms transition still causes a repaint storm on a long page.
 */
export function Reveal({
    children,
    delay = 0,
    as: Tag = "div",
    className = "",
}: {
    children: ReactNode;
    delay?: number;
    as?: "div" | "section" | "li" | "tr";
    className?: string;
}) {
    const ref = useRef<HTMLElement>(null);
    const [shown, setShown] = useState(false);
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setShown(true);
            return;
        }
        setArmed(true);
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    setShown(true);
                    observer.unobserve(entry.target);
                }
            },
            // A negative bottom margin means the reveal fires when the element is
            // properly on screen rather than as its first pixel clips the fold,
            // which is what makes a stagger read as choreography instead of as
            // lag.
            {rootMargin: "0px 0px -12% 0px", threshold: 0.12},
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <Tag
            // The cast is the narrow kind: one element type, one ref, no user
            // input involved.
            ref={ref as never}
            className={`reveal ${className}`}
            data-armed={armed || undefined}
            data-shown={shown || undefined}
            style={delay ? {transitionDelay: `${delay}ms`} : undefined}
        >
            {children}
        </Tag>
    );
}
