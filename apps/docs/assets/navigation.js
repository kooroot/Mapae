const menu = document.querySelector('.docs-nav');
const wide = matchMedia('(min-width: 901px)');
const resize = () => {menu.open = wide.matches;};
wide.addEventListener('change', resize);
resize();

const input = document.querySelector('#docs-search');
const results = document.querySelector('#docs-search-results');
const status = document.querySelector('#docs-search-status');
const contents = document.querySelector('#docs-contents');
const ko = document.documentElement.lang === 'ko';
let index;
let timer;
let request = 0;
input.addEventListener('input', () => {
    clearTimeout(timer);
    const id = ++request;
    const term = input.value.trim().toLocaleLowerCase();
    results.replaceChildren();
    contents.hidden = !!term;
    status.textContent = '';
    if (!term) return;
    timer = setTimeout(async () => {
        status.textContent = ko ? '검색 중…' : 'Searching…';
        try {
            if (!index) {
                const response = await fetch('/assets/search-index.json');
                if (!response.ok) throw new Error('Search unavailable');
                index = await response.json();
            }
            if (id !== request) return;
            const terms = term.split(/\s+/);
            const matches = index.filter(page => terms.every(word => `${page.title} ${page.text}`.toLocaleLowerCase().includes(word)))
                .sort((a, b) => Number(b.locale === document.documentElement.lang) - Number(a.locale === document.documentElement.lang)).slice(0, 12);
            for (const page of matches) {
                const li = document.createElement('li');
                const link = document.createElement('a');
                link.href = page.url; link.textContent = page.title; link.lang = page.locale;
                const excerpt = document.createElement('small');
                const at = page.text.toLocaleLowerCase().indexOf(terms[0]);
                excerpt.textContent = page.text.slice(Math.max(0, at - 30), Math.max(0, at - 30) + 110) + '…';
                link.append(excerpt); li.append(link); results.append(li);
            }
            status.textContent = matches.length ? (ko ? `${matches.length}개 문서` : `${matches.length} pages`) : (ko ? '검색 결과가 없어요. 다른 단어로 찾아보세요.' : 'No results. Try another term.');
        } catch {
            if (id !== request) return;
            index = undefined; contents.hidden = false;
            status.textContent = ko ? '검색을 불러오지 못했어요. 목차를 이용하거나 다시 검색하세요.' : 'Search unavailable. Use the contents or search again.';
        }
    }, 150);
});
