# @mapae/docs

`docs/`의 마크다운을 정적 HTML로 렌더해 `docs.mapae.io`에 올린다. 2026-08-10까지
GitBook 유료 티어가 하던 일이다.

## 왜 직접 렌더하나

GitBook에서 커스텀 도메인은 유료 기능이고, 그 유료 도메인이 **떠나는 비용을 낮춘다**.
`gitbook.mapae.io`는 우리 도메인이므로 렌더러를 바꿔도 주소가 살아 있다. GitBook이
실제로 서빙하던 18개 경로는 `pages.ts`의 `URL_FOR_SOURCE`에 못 박혀 있고
`pages.test.ts`가 그 약속을 지킨다 — 파일 경로에서 유도되지 않는 값이라(GitBook이
`SUMMARY.md`의 `##` 제목으로 섹션 슬러그를 만들었다) 데이터로 적고 테스트로 지키는
것 외에 방법이 없다.

새로운 진실의 출처는 없다. 무엇을 어떤 순서로 싣는지는 `docs/SUMMARY.md`가 정하고,
기술 문서 챕터는 여전히 `gitbook:build`가 `docs/tech-notes.md`에서 생성하며
`check:gitbook`이 바이트 단위로 검증한다. 여기서는 그 마크다운을 HTML로 바꾸기만 한다.

## Worker가 둘인 이유

| Worker | 호스트 | 하는 일 |
|---|---|---|
| `mapae-docs` | `docs.mapae.io` | 책 자체. `main` 없음 — 스크립트를 돌리지 않고 파일만 서빙한다 |
| `mapae-docs-legacy` | `gitbook.mapae.io` | 같은 경로로 301. 에셋 바인딩 없음 |

한 Worker에 두 호스트를 붙일 수도 있었지만, Cloudflare는 에셋이 매치되면 스크립트를
부르지 않는다. 그래서 리다이렉트를 책 쪽에 두려면 `run_worker_first`가 필요하고,
그러면 폰트 92개와 3.5 MB mermaid 번들까지 매 방문마다 스크립트를 거친다 — 레거시
호스트 하나 때문에 본 사이트의 "런타임 없음"을 버리는 거래다. 나눠두면 리다이렉트는
낡은 링크를 따라온 사람에게만 과금되고, 그 링크가 사라지는 날 `wrangler delete`
한 번으로 지울 수 있다.

**옛 호스트는 장식이 아니다.** GASOK 제출 폼 10/12번 답이 `gitbook.mapae.io`이고,
그 링크는 우리가 회수할 수 없다.

## 명령

```bash
# 저장소 루트에서
bun run build:docs          # apps/docs/dist 생성
bun run test:docs           # 33 테스트 — URL 맵, 링크 해석, 렌더, 리다이렉트
bun run deploy:docs         # 빌드 후 docs.mapae.io 배포
bun run deploy:docs:legacy  # gitbook.mapae.io 리다이렉트 Worker 배포 (호스트 갱신 때만)
```

`bun run check`가 `test:docs`와 `build:docs`를 모두 돌리므로, 빌드가 깨지면 게이트에서
잡힌다.

## 처음 올릴 때 (한 번)

1. GitBook 쪽에서 `gitbook.mapae.io` 커스텀 도메인을 **먼저 해제한다.** 하지 않으면
   Cloudflare가 커스텀 도메인 등록을 거부한다 (CNAME이 이미 잡혀 있다).
2. `bun run deploy:docs` — `docs.mapae.io` 커스텀 도메인과 DNS 레코드는 wrangler가
   `routes[].custom_domain`을 보고 만든다.
3. 18개 URL이 200을 반환하는지 확인한 뒤 `bun run deploy:docs:legacy`.
4. `curl -sI https://gitbook.mapae.io/tech/02-payment-flows`가 `301`과
   `location: https://docs.mapae.io/tech/02-payment-flows`를 주는지 확인한다.
5. 그다음에 GitBook 구독을 해지한다. 순서가 뒤바뀌면 문서가 잠시 사라진다.

## 빌드 산출물

- 페이지마다 `<url>/index.html` — 확장자 없는 주소가 리라이트 규칙 없이 풀린다.
- `_headers` — CSP는 `script-src 'self'`. mermaid를 CDN이 아니라 `node_modules`에서
  복사해 넣는 이유가 이것이다. 폰트(Pretendard 동적 서브셋 92개, IBM Plex Mono)도 같다.
- `404.html`, `robots.txt`, `sitemap.xml`.

폰트와 mermaid는 커밋하지 않는다. 락파일이 버전을 고정하고 `bun install`이 받아온다.
