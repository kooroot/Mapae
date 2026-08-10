/**
 * Draw the mermaid diagrams, then reveal them.
 *
 * `startOnLoad` is off and this runs the render explicitly, because the elements start
 * hidden: mermaid replaces the source text with an SVG, and a page that paints
 * `sequenceDiagram autonumber …` for a beat before swapping reads as broken. Marking each
 * element after the render is what `pre.mermaid[data-drawn]` makes visible.
 *
 * If mermaid throws — a syntax error in a diagram, a bundle that failed to load — the
 * blocks are revealed anyway. The source of a sequence diagram is legible to the audience
 * this book has; an empty space is not.
 */
import mermaid from "./mermaid.min.js";

const blocks = [...document.querySelectorAll("pre.mermaid")];

async function draw() {
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        themeVariables: {
            background: "#121110",
            primaryColor: "#171614",
            primaryTextColor: "#ece6dc",
            primaryBorderColor: "#c98a4b",
            lineColor: "#857c6e",
            actorTextColor: "#ece6dc",
            signalColor: "#b3aa9c",
            signalTextColor: "#ece6dc",
            fontFamily: "Pretendard, system-ui, sans-serif",
        },
    });
    await mermaid.run({nodes: blocks});
}

draw()
    .catch(() => {})
    .finally(() => {
        for (const block of blocks) block.setAttribute("data-drawn", "");
    });
