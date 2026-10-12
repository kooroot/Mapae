// The ESM renderer and each diagram engine are split by the docs build. Pages
// without diagrams load nothing; off-screen diagrams wait until approached.
let renderer;
function loadRenderer() {
    return renderer ??= import('mermaid').then(({default: mermaid}) => {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'dark',
            themeVariables: {
                background: '#121110', primaryColor: '#171614',
                primaryTextColor: '#ece6dc', primaryBorderColor: '#c98a4b',
                lineColor: '#857c6e', actorTextColor: '#ece6dc',
                signalColor: '#b3aa9c', signalTextColor: '#ece6dc',
                fontFamily: 'Pretendard Variable, system-ui, sans-serif',
            },
        });
        return mermaid;
    });
}
async function draw(block) {
    const source = block.textContent;
    try {
        const [mermaid] = await Promise.all([loadRenderer(), document.fonts.ready]);
        await mermaid.run({nodes: [block]});
    } catch {
        // Keep the document readable even when a renderer request fails.
        block.textContent = source;
    } finally {
        block.setAttribute('data-drawn', '');
    }
}
const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        void draw(entry.target);
    }
}, {rootMargin: '600px'});
for (const block of document.querySelectorAll('pre.mermaid')) observer.observe(block);
