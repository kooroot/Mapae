# Mapae web surfaces

하나의 TanStack Start 코드베이스를 두 개의 공개 표면으로 배포한다.

| 공개 주소 | Cloudflare Worker | 표면 | 역할 |
|---|---|---|---|
| `https://mapae.io` | `mapae` | `landing` | 제품 설명, 기술 근거, Studio 진입 |
| `https://app.mapae.io` | `mapae-app` | `app` | 스폰서드 온보딩(계정 대납 배포)과 위임 발급, permission context 기반 온체인 권한·정산·회수 상태 확인 |

로컬 개발의 기본값은 `combined`다. `/`에서 랜딩을, `/app`에서 Studio를 함께
확인할 수 있다.

Mapae Arcade는 `/ko/arcade`(한국어), `/arcade`(영어)에서 제공한다.
지갑 연결 → 빈 캐릭터 목록 → 직접 생성 → GIWA 용돈 승인 → 에이전트 외출 순서다.
캐릭터 자동 생성·데모 잔액·코인 충전 기능은 없고, 직접 연습은 생성한 캐릭터로 무료 이용한다.
기록은 지갑 주소별로 현재 브라우저에 저장하며 서버 계정 동기화는 아니다.
게임·결제 구현은 `src/arcade/`, 판매 입장권 등록은
`apps/delegated-seller/seed-arcade.ts`에서 관리한다.
아케이드 이미지 에셋은 저장소에 포함하지 않는다. 웹을 빌드하거나 배포하기 전에
별도로 전달된 `mapae-arcade-assets-*.tar.gz`를 저장소 루트에서 풀어
`apps/web/public/arcade/`를 복원한다. 복사 후
`test -f apps/web/public/arcade/lobby-scene.webp`로 확인한다.

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

랜딩의 아케이드 초대장은 오른쪽 아래에 고정되어 본문 스크롤 중에도 유지된다. 말풍선은
접고 펼칠 수 있으며, 접었을 때도 작은 캐릭터를 눌러 입장할 수 있다. 방문 시 십이지신
하나를 선택하고 같은 탭의 직전 등장과는 겹치지 않는다. 화면을 보는 동안 선택은 유지된다.
캐릭터는 선명한 원본 아트로 표시하고 `prefers-reduced-motion`에서는 인사 움직임을 끈다. 탭 저장소에는 공개
zodiac enum 하나만 기록한다(`landing/arcade-greeter-store.ts`). 저장소가 막혀 있어도
입장 링크는 작동한다. 게임·의복 설명은 아케이드에 두고 랜딩의 제품 본문은 유지한다.

랜딩과 Studio의 기술 문서 링크는 `VITE_DOCS_URL`을 사용한다. 기본 프로덕션
값은 `https://docs.mapae.io`이며, GitHub 원문 URL을 제품 UI에 직접
하드코딩하지 않는다.

스폰서드 온보딩 엔드포인트는 `VITE_BOOTSTRAP_URL`로 지정한다. 프로덕션 값은
`https://facilitator.mapae.io`이고, 변수를 비우면 온보딩 단계가 UI에서 빠진다.
두 안전장치가 빌드에 걸려 있다: `vite.config.ts`가 허용 호스트(프로덕션
엔드포인트 또는 loopback)가 아니면 빌드를 거부하고, CSP `connect-src`에 이
origin이 포함되어야 브라우저가 요청을 내보낸다. 빌드 시점에 번들로 인라인되는
값이므로, env 없이 `deploy:app`을 실행하면 온보딩이 빠진 채 배포된다 — env를
준 빌드 후 `wrangler deploy`를 따로 실행한다.

회수 대납 엔드포인트는 `VITE_REVOCATION_SUBMITTER_PUBLIC_URL`로 지정한다 —
로컬 전용 `VITE_REVOCATION_SUBMITTER_URL`(loopback 강제)과는 별개 변수이고,
같은 이유의 빌드 가드(허용 호스트 핀)와 CSP `connect-src`가 걸려 있다. 변수를
비우면 Studio의 회수 버튼이 "엔드포인트 미설정"으로 비활성화된다.

공개 Studio가 연결하는 submitter는 **스폰서드 모드**의 것이다. 아무 계정이나
받는 일반 목적 릴레이가 아니다: 검증기가 회수 대상 위임의 delegator ==
sender를 강제하므로 자기 권한의 회수만 나를 수 있고, 예치금을 대납하기 전에
계정 자신의 ERC-1271(`isValidSignature`)로 서명을 판정하므로 소유자가 서명하지
않은 요청은 스폰서의 지출 없이 거절된다. 스폰서드 프로파일의 수수료 상한과
일일 예산이 나머지를 묶는다. 온보딩 스폰서와 같은 논리다 — 침해돼도 자기
잔액만큼의 가스가 전부이고, 호출자가 지명할 수 있는 것이 없다.
