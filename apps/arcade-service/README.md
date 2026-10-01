# Mapae Arcade 로컬 서비스

브라우저는 게임 관측만 보내며 모델 키·위임 서명·에이전트 키를 보관하지 않는다.
서버는 `127.0.0.1:3004`에서만 실행한다. 운영 배포용 인증 서버가 아니다.

```bash
cd apps/arcade-service
bun run dev
```

기본값은 모델과 결제 모두 꺼짐이다. 기존 설치된 Ollama 모델을 쓸 경우:

```bash
ARCADE_MODEL_PROVIDER=ollama ARCADE_MODEL=설치된모델명 ARCADE_PAYMENT_MODE=simulation bun run dev
```

모델 설치·다운로드·유료 호출은 이 명령이 대신하지 않는다. 모델 이름을 실제 설치된 이름으로
지정한다. Ollama 주소는 loopback HTTP만 허용한다. 공식 OpenAI를 쓸 때는 서버 환경에
`ARCADE_MODEL_PROVIDER=openai`, `ARCADE_MODEL`, `OPENAI_API_KEY`,
`ARCADE_ALLOW_PAID_MODEL=true`가 모두 필요하다. 별도 사용자 승인 없이 유료 설정을 켜지 않는다.
사용자 브라우저에 키를 입력하는 칸은 없다.

모델 호출은 회당 최대 출력 800토큰, 기본 45초, 최대 동시 호출 2개다. UTC 날짜당 기본
60회(환경 변수로 1~1000회)의 시도 횟수를 SQLite에 예약하므로 실패·서버 재시작도 예산을
되돌리지 않는다. 모델별 가격을 안다는 가정으로 달러 한도를 표시하지 않는다.
입력 최대 16 KiB, 모델 응답 최대 32 KiB, 역할별 액션 검증을 적용한다. 실패·거절·시간 초과는
게임 화면으로 전달하고 규칙 봇으로 대체하지 않는다. `model`은 서버 설정에서 붙이며 모델이
스스로 주장한 이름을 신뢰하지 않는다. 게임 실시간 프레임에서 LLM을 호출하지 않는다.

Ollama는 Chat Completions의 JSON Schema 출력 강제를, OpenAI는 JSON 출력을 사용하고 실행 전 액션을 다시 검증한다.
[Ollama 공식 호환성 문서](https://docs.ollama.com/capabilities/structured-outputs),
[OpenAI 구조화 출력 문서](https://developers.openai.com/api/docs/guides/structured-outputs).

## API

| 요청 | 결과 |
|---|---|
| `GET /api/arcade/status` | `model: {configured,provider,model,remainingCalls,maxCalls,budgetPeriod}` 및 `payments: {mode,unit,ticketPrice,broadcastEnabled,balanceSource}` |
| `POST /api/arcade/decide` | `AgentDecisionRequest` → `{source:"llm",model,action,explanation}` |
| `POST /api/arcade/tickets` | `{game,requestId: UUIDv4}` → `{source:"mapae-simulation"|"mapae-fork",ticket}` |
| `GET /api/arcade/tickets/:id` | 확정된 티켓 조회 및 원장 기반 복구 |
| `POST /api/arcade/tickets/:id/consume` | `{runId: UUIDv4}` → 소비한 티켓, 같은 runId 재전송은 멱등 |

티켓은 `{id,game,status,runId,amount:"1.00",unit:"mUSDC",transaction,payer}`다. race 티켓은
3경기 시즌 하나, stamp/shop 티켓은 게임 하나다. 결제는 입장 전 한 번이며 프레임·공격·협상
턴마다 결제하지 않는다. 오류는 HTTP non-2xx의 `{error:{code,message}}`다.
서버는 CORS를 열지 않는다. 웹 개발 서버의 `/api/arcade` 프록시를 이용하며 비 JSON 쓰기와
외부 Origin 요청을 거절한다. 로컬 사용자 한 명을 위한 경계이며 운영 다중 사용자 인증은 별도다.

## 결제 모드와 근거

- `disabled`: 기본값. 티켓 결제 API가 명시적으로 거절한다. 웹의 데모 코인과 별개다.
- `simulation`: 네트워크 없는 결제 경로 실습. SDK로 루트와 결제별 leaf를 서명하고 기존
  `@mapae/delegation`의 `payForDelegatedResource` → `@mapae/seller` 페이월 → 기존
  `@mapae/store` settlement journal/주문을 실제로 통과한다. facilitator의 정산만 fixture이며
  **온체인 검증·잔액 이동이 아니다**. 결과 해시는 합성값이고 explorer에 연결하지 않는다.
- `fork`: 실제 로컬 EVM 결제. 기존 `loadDelegatedAgentRuntime`이 배포/manifest/부모 위임을
  검증하고 leaf를 서명한다. 서비스 안에서 기존 facilitator의 `SettlementRecovery`,
  `createPaymentRoutes`, Transfer 영수증 검증을 사용한다. RPC는 loopback의 Anvil이어야 하고
  `web3_clientVersion`+`anvil_nodeInfo`를 시뮬레이션/전송 직전에도 확인한다. 외부 facilitator
  주소는 금지한다. 폐기용 relayer를 메모리에서 생성하고 `anvil_setBalance`로만 가상 자금을 준다.
  payer의 자금과 위임 한도는 포크의 스마트 계정/enforcer가 강제한다.

fork 준비에는 이미 떠 있는 Anvil, 해당 포크에서 유효한 부모 위임과 일치하는 세션 키,
배포 JSON/manifest, framework owner 및 받는 주소가 필요하다. `.env.example`에 정확한 필드가
있다. `ARCADE_ALLOW_LOCAL_FORK=true`가 필요하고 `FACILITATOR_URL`은 설정하면 안 된다.
이 서비스는 운영 RPC·운영 facilitator를 실행하거나 GIWA로 전송하는 모드를 제공하지 않는다.

입장 시도는 서명 전 pending을 저장하고, leaf 생성 후 전송 전에 intent를 묶는다. 같은
requestId는 같은 게임과 티켓만 돌려준다. 응답 유실은 이미 확정된 주문/정산 원장으로 복구한다.
아직 미확정이면 입장과 새 청구를 모두 막는다. 티켓 소비는 SQLite 트랜잭션으로 runId에
한 번만 묶이며 다른 runId로 재사용할 수 없다. 원장에 정산이 남았지만 주문 생성 직전에
종료된 경우에도 서명·재결제 없이 주문을 복구한다. 금융 기록을 브라우저 잔액으로 대체하지 않는다.

데이터는 `data/arcade-{mode}-admissions.sqlite`, `data/arcade-{mode}-payments.sqlite`에
분리되고 모델 호출 예산은 모드 전환에도 유지되는 `data/arcade-model.sqlite`에 기록된다.
기존 운영 서비스의 DB 스키마나 마이그레이션을 수정하지 않는다. 미확정 결제가
있는 DB를 지우고 새 결제를 시작하는 것은 복구 절차가 아니다. 해당 정산 원장을 먼저 확인한다.

## 검증

```bash
bun test apps/arcade-service packages/store/src/arcade.test.ts
cd apps/arcade-service && bunx tsc --noEmit
```

단위/통합 테스트의 LLM 응답은 계약 fixture이며 실제 모델 추론 증거와 구분한다.
결제 simulation 테스트는 실제 seller/client/위임 인코딩/주문/원장을 검증하지만 실제 EVM
enforcer 실행을 대신하지 않는다. 포크와 실제 모델 검증은 통합 작업의 별도 실행 근거가 필요하다.

실제 EVM 입장권 검증은 다음 명령으로 재현한다. Foundry의 `anvil`과 빌드된
`contracts/out/MockUSDC.sol/MockUSDC.json`이 필요하다(`cd contracts && forge build`).

```bash
cd apps/arcade-service
bun --no-env-file run anvil-integration.ts
```

이 harness는 동적 loopback 포트에 일회용 Anvil을 띄우고 새 키·스마트 계정·부모 위임을 만든다.
38개 Framework 계약과 2단계 소유권 이전을 실제로 배포하고 코드 fingerprint를 검증한다.
자금은 Anvil 안에서만 생성한다. `.env`, 기존 개인키·운영 DB·실서비스는 읽지 않는다.
입장권의 정확한 토큰 증감, payer 가스 0, replay/중복 소비 거절, 클라이언트 사전 검사 없이
실제 enforcer의 한도 거절, 채굴 중단으로 영수증이 미확정일 때 입장·새 청구 차단과 원래
영수증 조회 후 복구를 확인한다. 종료 시 Anvil과 임시 파일을 정리한다.

`fixtures/entrypoint-v07.json`은 공개 GIWA RPC의 읽기 전용 `eth_getCode`로 확보한
canonical v0.7 runtime이다. 저장소의 기존 `GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash`와
일치할 때만 로컬 Anvil에 주입한다. 이 fixture 덕분에 검증 명령 자체는 upstream RPC나
GIWA 요청 없이 실행된다. 설치된 SDK의 별도 EntryPoint 빌드를 같은 코드로 취급하지 않는다.
