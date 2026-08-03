# Mapae web surfaces

하나의 TanStack Start 코드베이스를 두 개의 공개 표면으로 배포한다.

| 공개 주소 | Cloudflare Worker | 표면 | 역할 |
|---|---|---|---|
| `https://mapae.io` | `mapae` | `landing` | 제품 설명, 기술 근거, Studio 진입 |
| `https://app.mapae.io` | `mapae-app` | `app` | 스폰서드 온보딩(계정 대납 배포)과 위임 발급, permission context 기반 온체인 권한·정산·회수 상태 확인 |

로컬 개발의 기본값은 `combined`다. `/`에서 랜딩을, `/app`에서 Studio를 함께
확인할 수 있다.

```bash
bun run dev
```

프로덕션 빌드와 배포는 표면을 반드시 명시한다.

```bash
# mapae.io
bun run build:landing
bun run deploy:landing

# app.mapae.io
bun run build:app
bun run deploy:app
```

두 빌드 명령은 `VITE_SITE_SURFACE`와 `CLOUDFLARE_ENV`를 같이 고정한다. 따라서
`mapae` Worker의 `/`는 항상 랜딩이고, `mapae-app` Worker의 `/`는 항상 Studio다.
각 환경의 `routes[].custom_domain`도 `wrangler.jsonc`에 고정되어 있어 배포할 때
Cloudflare가 `mapae.io`와 `app.mapae.io`의 DNS 레코드와 인증서를 관리한다.
`workers.dev` 및 버전별 preview URL은 공개하지 않는다.

랜딩의 Studio CTA는 `VITE_APP_URL`, Studio의 Mapae 링크는
`VITE_LANDING_URL`을 사용한다. 기본 프로덕션 값은 각각
`https://app.mapae.io`, `https://mapae.io`다.

랜딩과 Studio의 기술 문서 링크는 `VITE_DOCS_URL`을 사용한다. 기본 프로덕션
값은 `https://gitbook.mapae.io`이며, GitHub 원문 URL을 제품 UI에 직접
하드코딩하지 않는다.

스폰서드 온보딩 엔드포인트는 `VITE_BOOTSTRAP_URL`로 지정한다. 프로덕션 값은
`https://facilitator.mapae.io`이고, 변수를 비우면 온보딩 단계가 UI에서 빠진다.
두 안전장치가 빌드에 걸려 있다: `vite.config.ts`가 허용 호스트(프로덕션
엔드포인트 또는 loopback)가 아니면 빌드를 거부하고, CSP `connect-src`에 이
origin이 포함되어야 브라우저가 요청을 내보낸다. 빌드 시점에 번들로 인라인되는
값이므로, env 없이 `deploy:app`을 실행하면 온보딩이 빠진 채 배포된다 — env를
준 빌드 후 `wrangler deploy`를 따로 실행한다.

공개 Studio는 인증 없는 revocation submitter를 연결하지 않는다. 권한 상태와
정산 이벤트는 GIWA 공개 RPC에서 읽고, 실제 회수 제출은 소유자 서명과 운영
릴레이어가 포함된 별도 보호 경로로 둔다. 온보딩 엔드포인트는 반대로 공개가
설계다 — 그 경계가 다른 이유는 권한의 차이다. submitter는 남의 계정을 향한
UserOperation을 릴레이어 가스로 나르는 서비스라 공개하면 일반 목적 릴레이가
되지만, 온보딩 스폰서는 위임 권한이 없어 침해돼도 자기 잔액만큼의 가스
낭비가 전부이고, 요청 본문이 `{permissionContext}` 하나라 호출자가 배포
대상을 지명할 수도 없다.
