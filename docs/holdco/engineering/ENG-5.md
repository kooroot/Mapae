# ENG-5 — mapae.mcpb: 매니페스트, 오프라인 팩, 매니페스트 기반 스모크

.mcpb 3단계 중 2단계. ENG-4가 증명한 Node 번들을 Claude Desktop 확장으로 싼다.

## 만든 것

| 파일 | 역할 |
|---|---|
| `apps/agent-mcp/mcpb/manifest.json` | MCPB 0.3, `server.type: node`, 호스팅 기본값 env, `user_config` 네 칸 |
| `apps/agent-mcp/mcpb/pack.ts` | `bun run build:mcpb`. 번들 → 스테이징(`mcpb/dist/mapae/`) → 시스템 `zip -X -D` → `mcpb/dist/mapae.mcpb`. 네트워크 없음 |
| `apps/agent-mcp/mcpb/fake-seller-preload.mjs` | 테스트 전용 `node --import`. 매니페스트의 SELLER_URL 오리진에 402 오퍼 하나를 프로세스 안에서 돌려준다(리스너 없음) |
| `apps/agent-mcp/mcpb/mcpb.test.ts` | 매니페스트 필드, 아카이브 목록, 번들 동일성, 비밀 부재, 매니페스트대로의 부팅 4가지 |

아카이브 내용(`unzip -l`): `manifest.json`, `server/index.js`, `deployments/giwa-sepolia.framework.json`,
`deployments/giwa-sepolia.framework-manifest.json` — 4파일, 디렉터리 항목 없음.

- **아카이브 크기: 442,894 bytes** (압축 전 2,581,492 bytes, 그중 번들 2,540,026).
- `mcpb/dist/`는 기존 `.gitignore:29 dist/`가 덮는다(`.gitignore` 변경 없음).

## 테스트한 방법

`bun test apps/agent-mcp` — 16 pass(새 파일 8개 포함). 새 테스트는 소켓을 열지 않는다.

1. 팩을 실행하고 스테이징된 `manifest.json`의 모든 필드를 단언.
2. `unzip -Z1` 목록과 스테이징 디렉터리가 정확히 4파일, 배포 파일 두 개는 레포 사본과 바이트 동일.
3. 번들 명령이 `["bun","build","./index.ts","--target=node","--outfile",…]`이고, `scripts/check-mcp-stdio.ts`에 같은 인자열이 있음을 소스 문자열로 단언. 스테이징 번들의 `Bun.` 0, `hono` 0.
4. 매니페스트에 32바이트 hex 값 없음, 네 파일 어디에도 픽스처 키와 permission 없음.
5. `${__dirname}` → 스테이징 디렉터리, `${user_config.*}` → 픽스처 키·PERMISSION_CONTEXT(선택 칸은 Desktop처럼 default)로 풀어 `node <args>`를 그 env로 실행. RPC·facilitator URL만 프리로드의 루프백 오리진으로 바꿈. initialize·tools/list·mapae_status → 두 도구, `ok:true`, `sessionKey` = 픽스처 주소, 프로세스 생존, stdout은 JSON-RPC만.
6. 대조군: 스테이징 사본에서 `deployments/giwa-sepolia.framework.json`을 지우면 `RUNTIME_UNAVAILABLE`이고 detail이 그 사본 경로를 가리킴 — 스테이징 파일을 읽는다는 증거.
7. `user_config` 네 칸 모두 빈 문자열 → `ok:false`, `RUNTIME_UNAVAILABLE`, 프로세스 생존.
8. `max_payment_musdc` 기본값 그대로, 판매자 오퍼 2.500001 mUSDC → `SPEND_POLICY_REFUSED`(docs/mcp-guide.md §6), detail이 `AGENT_MAX_PAYMENT_MUSDC`를 지목, 판매자에게 간 요청은 서명 없는 1건뿐(서명 전 거절). 해석된 env에 `AGENT_MAX_PAYMENT_MUSDC=2.50`, `AGENT_SESSION_BUDGET_MUSDC=10.00`.

그 밖에: `bun run check:mcp-stdio` → control 9, entry point 0, Node bundle 0. `bun run typecheck && bun run check:docs` 통과.

## Node 버전

- **스모크를 돌린 Node: v25.9.0** (이 머신의 `node`; ENG-4와 같음).
- **`compatibility.runtimes.node: ">=20.0.0"`.** 이유: `server.type: node` 확장은 Desktop이 자기 내장 Node로 실행하므로, 루트 `engines`(`>=24.22.1 <25`, 개발 도구 체인용)를 그대로 적으면 내장 Node가 더 오래된 Desktop에서 설치 자체가 거절될 수 있다. 번들이 쓰는 런타임 기능은 전역 `fetch`·`Request`/`Response`, `AbortSignal.timeout`, 전역 `crypto`(WebCrypto)이고 모두 Node 20에서 기본 제공된다(18은 2025-04 지원 종료이고 전역 `crypto`가 플래그 없이 보장되지 않음). 하한 20은 이 추론이지 측정이 아니다: v20에서 실제로 돌려 보지 않았다. Desktop이 실제로 어떤 Node로 띄웠는지는 아래 결과 표의 로그 칸이 측정한다.

## 운영자 절차

1. 레포 루트에서 `bun run build:mcpb` (오프라인, 출력 `apps/agent-mcp/mcpb/dist/mapae.mcpb`).
2. 공식 검증기(네트워크 필요, 운영자 단계): `bunx @anthropic-ai/mcpb validate apps/agent-mcp/mcpb/dist/mapae/manifest.json` (스테이징 경로. 원본 `apps/agent-mcp/mcpb/manifest.json`도 내용 동일).
3. Free 계정 Desktop에서 `mapae.mcpb`를 더블클릭(또는 설정 → 확장 → 고급 설정 → Install Extension…) → 설치.
4. 설정 대화상자에 Studio 번들의 두 값을 붙여넣는다:
   - **에이전트 세션 키** ← 번들의 `AGENT_PRIVATE_KEY`
   - **Permission context** ← 번들의 permission context 값(`PARENT_PERMISSION_CONTEXT`, 파일로 받았다면 그 안의 hex)
   상한 두 칸은 비워 두면 2.50 / 10.00.
5. 새 채팅에서: `mapae_status를 호출해서 상태를 보여줘` → `ok: true`와 세션 키 주소 확인. 이어서 `마패 도구로 /s/demo-cafe/americano 를 결제하고 결과와 거래 해시를 알려줘` (2.50 mUSDC 이하인 실제 상품 경로로 바꿔도 된다).
6. Desktop이 실제로 쓴 Node 버전: macOS `~/Library/Logs/Claude/mcp-server-Mapae.log`(Windows `%APPDATA%\Claude\logs\mcp-server-Mapae.log`)에서 서버 시작 줄의 node 경로·버전. 안 보이면 같은 폴더의 `main.log`에서 확장 런타임 항목을 찾는다.
7. Pro 계정 Desktop에서 3–6 반복. 아래 표를 채운다. 스크린샷은 아카이브 디렉터리가 아니라 `docs/` 바깥에 둔다.

## 결과 (운영자 기입)

| 플랜 | 설치 | 도구 호출 (mapae_status) | 결제 tx 해시 | Node 버전 (로그) | 비고 |
|---|---|---|---|---|---|
| Free | | | | | |
| Pro | | | | | |

## Rollback

추가 파일만 있다. `git revert <merge>`로 `apps/agent-mcp/mcpb/`, 루트 `package.json`의 `build:mcpb` 한 줄, 이 문서가 사라진다. 런타임 코드(`index.ts`, `server.ts`, `packages/delegation`)는 건드리지 않았다.

## Assumptions

- `compatibility.runtimes.node`는 `>=20.0.0`(위 이유). v20 실측은 없다.
- 매니페스트 `version`은 `apps/agent-mcp`의 서버 버전과 같은 `0.1.0`. `display_name`·설명·`user_config` 제목은 한국어로 썼다(프로브 매니페스트와 같은 톤).
- Desktop은 값이 비어 있는 선택 `user_config` 칸을 `default`로 채운다고 보고 테스트의 치환도 그렇게 했다. "빈 user_config" 경우는 네 칸 모두 빈 문자열로 줬다(가장 나쁜 경우).
- "스테이징 파일에 32바이트 hex 키가 없음"은 매니페스트에 정규식으로 적용했다. 번들(92개)과 배포 파일(232개)에는 공개 typehash·codehash 등 32바이트 hex가 정상적으로 들어 있어 정규식은 의미가 없으므로, 그 파일들에는 픽스처 키와 permission 문자열의 부재를 단언했다.
- 지출 한도 테스트는 판매자 리스너 대신 `mcpb/fake-seller-preload.mjs`가 프로세스 안에서 `https://seller.mapae.io` 요청을 가로챈다. 매니페스트의 SELLER_URL env 값은 바꾸지 않았다(덮어쓴 env는 RPC·facilitator 두 개뿐이고, 나머지는 프리로드용 `FAKE_*` 하네스 변수).
- `apps/agent-mcp/tsconfig.json`의 `include`가 `*.ts`(최상위)뿐이라 `mcpb/*.ts`는 `typecheck` 대상이 아니다(`fixtures/*.ts`와 같은 상황). 티켓 범위상 tsconfig는 고치지 않았다; bun이 테스트 실행 때 트랜스파일한다.
- 스테이징 디렉터리는 `mcpb/dist/mapae/`, 매 팩마다 `mcpb/dist/`를 지우고 새로 만든다. 테스트도 팩을 실행하므로 테스트 후 `dist/`에 최신 아카이브가 남는다.
- PARENT_PERMISSION_CONTEXT_PATH는 매니페스트에 넣지 않았다(티켓의 env 목록에 없음); 인라인 값이 우선한다(ENG-4).
