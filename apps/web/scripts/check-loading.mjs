import assert from 'node:assert/strict';

// Run against a production build (`vite preview`) or a deployed surface. A dev
// server injects CSS with JavaScript and cannot catch this SSR regression.
const [origin, surface] = process.argv.slice(2);
const selectors = {faucet: '.fct-workspace', landing: '.home-hero', app: '.studio-shell'};
assert.ok(origin && surface in selectors, 'Usage: node scripts/check-loading.mjs <origin> <landing|app|faucet>');
const pages = [['/', selectors[surface]], ['/ko', selectors[surface]]];
if (surface === 'landing') for (const locale of ['', '/ko']) {
    pages.push([`${locale}/arcade`, '.arc-room']);
    for (const section of ['guardians', 'outings', 'ranking', 'journal', 'wallet']) pages.push([`${locale}/arcade/${section}`, '.nft-arcade']);
}
for (const [path, selector] of pages) {
    const url = new URL(path, origin);
    const response = await fetch(url);
    assert.equal(response.status, 200, url.href);
    const html = await response.text();
    assert.ok(html.slice(html.indexOf('<body')).includes(selector.slice(1)), `${path}: page content missing from SSR`);
    const head = html.slice(0, html.indexOf('</head>'));
    const links = [...head.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag).filter(tag => /rel="stylesheet"/.test(tag));
    assert.ok(links.length, `${path}: no stylesheets in the server-rendered head`);
    const css = (await Promise.all(links.map(async tag => {
        const href = tag.match(/href="([^"]+)"/)?.[1];
        assert.ok(href);
        const sheet = await fetch(new URL(href, url));
        assert.equal(sheet.status, 200, href);
        return sheet.text();
    }))).join('\n');
    assert.ok(css.includes(selector), `${path}: page CSS arrives only after JavaScript`);
    assert.match(css, /\.sr-only\s*\{[^}]*clip-path:inset\(50%\)/, `${path}: accessible descriptions must stay visually hidden without landing CSS`);
    assert.ok(!/noto-serif-kr-korean-|nanum-gothic-coding-korean-/.test(css), `${path}: unpartitioned Korean font`);
    if (surface === 'faucet' || surface === 'app') assert.ok(!css.includes('noto-serif-kr-'), 'Unused display faces in the critical stylesheet');
    if (surface === 'faucet') {
        assert.ok(!css.includes('.studio-shell'), 'Faucet includes Studio styles');
        assert.ok(!css.includes('.home-hero'), 'Faucet includes landing styles');
    }
    console.log(`${url.href}: SSR content and page styles present`);
}
console.log('WEB_LOADING_OK');
