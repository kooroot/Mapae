<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 3. 에러 모델

정산 경로의 모든 실패 모드에 태그를 부여한 판별 유니온이다
(`packages/shared/src/errors.ts`).

블록체인 코드는 에러 표면이 넓다 — RPC 타임아웃, 레이트리밋, revert, nonce
경합, 서명 검증 실패, 릴레이어 가스 고갈. 이를 하나의 `catch`로 합치면 복구에
필요한 정보가 사라진다. 각 태그는 다음을 구분한다.

- **재시도 가능** (`RpcUnavailable`, `RpcRateLimited`) — 백오프 후 재시도
- **운영 장애** (`RelayerOutOfGas` 등) — 503, 호출자 잘못이 아님, 알림 대상
- **호출자 오류** (`InvalidSignature`, `DomainMismatch`, `MalformedPayload`) — 4xx, 원인을 반환

`DomainMismatch`가 별도 태그인 이유: EIP-712 도메인 불일치는 x402 통합에서 가장
흔한 실패이며, generic 500으로 나가면 원인을 특정할 수 없다.

**두 경로는 응답 정책이 다르다 (의도적).** 태그 유니온을 응답 본문에 그대로
싣는 것은 EIP-3009 직접 결제 경로(`apps/seller`)다. ERC-7710 위임 경로는 다르게
동작한다.

| | 직접 결제 (`apps/seller`) | 위임 결제 (`apps/delegated-seller`, `apps/facilitator-erc7710`) |
|---|---|---|
| 외부 응답 | `SettlementError._tag` + `describe()` 원인 | `delegation_rejected` / `settlement_unknown` 등 **불투명한 사유** |
| 상태 코드 | `httpStatusFor()` | 402 / 400 / 403 / 422 / 504 |
| 클라이언트 분기 | 태그 | `DelegatedPaymentFailureCode` (에이전트 측 자체 분류) |

위임 경로가 불투명한 것은 위협 모델 때문이다. 실패 사유를 상세히 반환하면
공격자가 응답만으로 caveat 경계 — 남은 한도, 만료 여부, 재위임 구조 — 를 탐색할
수 있다. 원인은 서버 로그로 간다. `redactForLog`는 revert 사유
(`ERC20PeriodTransferEnforcer:transfer-amount-exceeded`)는 남기고, viem이 에러에
포함시키는 bearer 길이의 hex(서명된 permission context)는 크기만 남기고
제거한다. 운영자는 원인을 보고, 호출자는 보지 못한다.

## 상태 부재의 판정 규칙

가드 코드 전반에 다음 규칙을 적용한다: **읽지 못했거나 존재하지 않는 값이 판정
자리에 놓이면 충족이 아니라 거절 또는 별도 사유여야 한다.**

- **`PERMISSION_EMPTY`.** 빈 `Delegation[]`의 올바른 ABI 인코딩은 hex 형태
  가드를 통과하는 130자 문자열이고 `decodeDelegations`는 이를 `[]`로 되돌린다.
  이 상태에서 pre-flight의 모든 검사는 비교 대상이 없어 통과하게 되므로, 별도
  태그로 거절한다. `PERMISSION_INACTIVE`를 재사용하지 않는 이유는 두 태그의
  지시가 다르기 때문이다 — 전자는 아티팩트 재생성, 후자는 체인에서 회수·만료
  확인. 가드는 부팅 검증(`loadDelegatedAgentRuntime`)과 판정 함수
  (`judgePreflight`) 양쪽에 있다.
- **주기 caveat 부재.** 링크에 `ERC20PeriodTransferEnforcer` caveat이 없으면
  남은 잔량이 `undefined`로 남는다. 이 상태를 두 소비자가 서로 다르게 판정하는
  것은 질문이 다르기 때문이다.

| | 질문 | `tightest === undefined` |
|---|---|---|
| `judgePreflight` (런타임) | 체인이 이 결제를 거절하는가 | 통과 — 한도가 없으면 거절되지 않는다 |
| `giwa-preflight` (사람 게이트) | 설정이 의도와 일치하는가 | 실패 — 대조할 값이 없다 |

  계산(`tightestPeriodRemaining`)은 `packages/delegation`에서 공유하고, 판정은
  각자 유지하며 상호 참조 주석으로 연결되어 있다.
- **수수료 판정의 입력 부재.** `judgeSubmissionReadiness`는 base fee를 읽지
  못한 상태를 `base_fee_unreadable`로 거절한다. `fee_below_basefee`와 사유를
  나누는 이유는 지시가 반대이기 때문이다 — 전자는 소유자에게 더 높은 수수료로
  재서명하라는 뜻이고, 후자는 체인 읽기를 재시도하라는 뜻이다.

## 상시 게이트

`bun run check`는 코드와 함께 문서·설정의 주장을 기계적으로 검증한다. 전부 키와
네트워크 없이 동작하며, 깨끗한 클론에서 같은 결과를 낸다.

| 게이트 | 검증 내용 |
|---|---|
| `check:docs` | 문서의 모든 `bun run`·`make` 명령이 실제로 존재하는지, 상대 링크가 열리는지, 모든 주소가 배포 아티팩트·토큰 정본과 일치하는지 |
| `check:gitbook` | GitBook 챕터·SUMMARY·설정이 정본(`docs/tech-notes.md`)에서 유도한 것과 바이트 단위로 일치하는지 |
| `check:logging` | `apps/`·`packages/`·`scripts/`의 `console.*` 인자에 날것의 에러가 닿지 않는지 — viem은 전송 URL을 에러 메시지에 포함시키므로, 경로에 키가 든 RPC URL이 로그로 새는 경로를 차단한다 |
| `check:advisories` | `bun audit`의 모든 발견이 수정되었거나, 매 실행 재측정되는 `prove` 함수가 딸린 수용인지 |
| `check:counts` | 저장소 README가 적은 테스트 수가 bun·forge가 실제로 수집하는 수와 일치하는지 — 문서의 숫자끼리의 일치가 아니라 수트와의 일치를 검사한다 |

## 422와 504의 의미 구분

불투명 사유 중 이 둘은 구분이 필수다. `settlement_failed`(422)는 "지불자는
청구되지 않았다"이고 `settlement_unknown`(504)은 "청구 여부를 확인하지
못했다"이다. 전자는 재시도를 부르는 답이고, 미확인 상태의 재시도는 이중 지불이
된다.

이 구분의 근거는 실제 사례다. GIWA `0x533c5cb2…9964c`(block 31634935)는
지불자에게서 1.00 mUSDC를 실제로 이체했지만 호출자는 `PAYMENT_REJECTED`를
받았다 — 영수증 대기 타임아웃이 판매자의 HTTP 타임아웃보다 길게 설정되어
있었기 때문이다. 이후 타임아웃 예산은 바깥 계층일수록 길어지도록 재설계되었고
(25 → 35 → 45 → 50초), 결과 미확정 결제는 `SETTLEMENT_UNKNOWN`으로 반환된다.

판정은 순수 함수 `decideSettlement()`로 분리되어 있고
(`packages/delegation/src/x402.ts`), 판정 기준 문자열
(`SETTLEMENT_UNCONFIRMED`)과 응답 타입은 생산자·소비자가 같은 모듈에서
가져간다. 판정 사다리는 `unknown` 쪽으로 기운다.

| 관찰 | 결과 | 이유 |
|---|---|---|
| 응답 못 받음 (연결 거부·non-2xx·JSON 아님·타임아웃) | `unknown` 504 | "요청이 닿지 않음"과 "브로드캐스트 후 응답 유실"을 구분할 수 없다 |
| `errorReason === SETTLEMENT_UNCONFIRMED` | `unknown` 504 (+해시) | 해시가 없으면 호출자가 확인할 수단이 없다 |
| `success !== true` | `failed` 422 | 명시적 거절 — 자금이 이동하지 않았다 |
| `success === true`, payer 불일치 | `unknown` 504 | 브로드캐스트는 주장되었으나 신원이 어긋났고, 잔액은 확인되지 않았다 |
| `success === true`, payer 일치 | `settled` 200 | |

이 경로는 fork에서 강제 재현할 수 있다 — facilitator의 영수증 대기를 1ms로
줄이면 브로드캐스트 후 미확정 분기를 태운다.

```bash
cd apps/delegation-lab && SETTLEMENT_RECEIPT_TIMEOUT_MS=1 bun run test:e2e:mcp
```

이 실행은 상태 코드만 확인하지 않고, enforcer 이벤트를 fork에서 직접 읽어
자금이 실제로 이동했는지까지 대조한다.

## Effect 이관 계획

현재는 판별 유니온으로 구현하되, `_tag` 판별자는
[Effect](https://effect.website)의 `Data.TaggedError`와 동형으로 유지한다.

| 단계 | 상태 |
|---|---|
| 현재 | 판별 유니온 + 명시적 분기. 타입 레벨에서 실패 모드가 전부 열거됨 |
| 다음 | 정산 경로를 `Effect<A, SettlementError, R>`로 이관 — 타입드 에러 채널, `Schedule` 기반 재시도/백오프, 리소스 안전한 RPC 커넥션 |

MVP 기간에 도입하지 않은 이유는 부분 도입이 어렵기 때문이다. Effect는 호출 체인
전체에 전파되므로, 핵심 결제 루프 검증 전의 도입은 실행 리스크가 된다. 에러
모델의 형태를 먼저 확정하면 이관은 재작성이 아니라 기계적 치환이 된다.
