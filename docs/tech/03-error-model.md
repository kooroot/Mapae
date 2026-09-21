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
싣는 것은 EIP-3009 직접 결제의 오류 모델(`packages/shared`의 `SettlementError`)이다.
그 경로를 내던 앱은 지웠지만 모델과 테스트는 남아 있다. ERC-7710 위임 경로는
다르게 동작한다.

| | 직접 결제 (`packages/shared` 오류 모델) | 위임 결제 (`apps/delegated-seller`, `apps/facilitator-erc7710`) |
|---|---|---|
| 외부 응답 | `SettlementError._tag` + `describe()` 원인 | x402 v2 §9의 **닫힌 낱말** — `invalid_payload`, `settlement_pending` 등(+ §9 밖의 `delegation_rejected`). 사유의 문장은 나가지 않는다. 판매자는 그 낱말을 실패 응답의 `Payment-Response`(x402 v2 `SettleResponse`)에 실어 보낸다 |
| 상태 코드 | `httpStatusFor()` | 402 / 400 / 503 / 502 / 504 |
| 클라이언트 분기 | 태그 | `DelegatedPaymentFailureCode` (에이전트 측 자체 분류) |

위임 경로가 낱말만 내보내는 것은 위협 모델 때문이다. 실패 사유를 문장으로 반환하면
공격자가 응답만으로 caveat 경계 — 남은 한도, 만료 여부, 재위임 구조 — 를 탐색할
수 있다. 원인은 서버 로그로 간다. `redactForLog`는 revert 사유
(`ERC20PeriodTransferEnforcer:transfer-amount-exceeded`)는 남기고, viem이 에러에
포함시키는 bearer 길이의 hex(서명된 permission context)는 크기만 남기고
제거한다. 운영자는 원인을 보고, 호출자는 보지 못한다.

## 거절 낱말은 §9의 것이다

브로드캐스트 전에 형성된 facilitator의 거절은 한 분류(`describeFailure`)에서 나오고,
`delegation_rejected` 하나를 빼면 모두 x402 v2 §9 어휘다. `/verify`의 `invalidReason`,
`/settle`의 `errorReason`, `/settle`이 원장에 남기는 `rejected` 행의 `errorCode`가 그 한
값이므로, 구매자가 받은 이유와 운영자가 세는 코드가 어긋날 수 없다. 채굴된 뒤에 실패한
결과(`settlement_reverted`, `vendor_not_credited`)는 이 분류를 거치지 않는다 — 영수증을
읽은 저널이 terminal 행에 적고, `/settle`이 그 행을 그대로 싣는다(아래 표 마지막 줄).

| 낱말 | 무엇이 내는가 |
|---|---|
| `invalid_x402_version` | 요청 또는 payload의 `x402Version`이 2가 아니다 |
| `invalid_payload` | 요청이 스스로에 대해 하는 말이 틀렸다 — 객체가 아님, 본문을 읽을 수 없음(content-type·크기·`JSON.parse`), `paymentPayload`·`paymentRequirements`·`accepted`·`payload` 누락, `accepted`가 판매자 오퍼와 정확히 같지 않음, `delegationManager` 비허용, `delegator`·`permissionContext` 형식·디코드·루트 위임자, 주장한 delegator와 서명된 루트 payer 불일치 |
| `invalid_payment_requirements` | 오퍼 자신의 조건 — 자산, `payTo`, `maxTimeoutSeconds`(1–300), `amount`, 안전 상한, 이 facilitator가 redeemer로 광고되지 않음 |
| `unsupported_scheme` | `scheme`이 `exact`가 아니거나 `extra.assetTransferMethod`가 `erc7710`이 아니다 |
| `invalid_network` | GIWA Sepolia가 아닌 체인 |
| `invalid_transaction_state` | `/verify`만 낸다 — 이 결제의 정산이 이미 온체인에서 실패로 끝났다(채굴된 revert, 판매자 앞 `Transfer` 없는 영수증). 재시뮬레이션이 유효하게 만들 수 없다 |
| `settlement_pending` | `/settle`만 낸다 — 원래 거래는 있고 결과를 모른다. 언제나 비어 있지 않은 `transaction`과 함께 |
| `unexpected_verify_error` / `unexpected_settle_error` | 위 어디에도 속하지 않는 예외 — 우리 쪽 결함이다. 브로드캐스트 전에 던졌으므로 청구된 것은 없지만, 위임에 대한 판정도 아니다. 판매자는 앞의 것을 503(판정 없음), 뒤의 것을 504(모름)로 읽는다 — 어느 시점의 실패인지 그 낱말이 말하지 않으므로, 우리가 아닌 facilitator를 가리킨 판매자가 "청구되지 않았다"고 주장할 수는 없다 |
| `settlement_reverted` / `vendor_not_credited` | 거절이 아니라 채굴된 terminal 결과 — `describeFailure`가 아니라 영수증을 읽은 저널이 내고, 가스는 이미 썼다 |

`delegation_rejected`는 거절 판정 중 §9 밖의 유일한 낱말이고, 그래서 정의가 좁다:
facilitator가 라이브 상태로 위임을 검사했고 체인이 redeem을 거부했다 — 디코드된 시뮬레이션
revert(노드가 `-32000`으로 보고해 viem에 revert 데이터가 없는 `ExecutionRevertedError`까지),
또는 `MAX_REDEMPTION_GAS`를 넘는 가스. "viem 오류면 전부"가 아니다: 우리 인코딩 실수 같은
다른 viem 오류는 `unexpected_*_error`다 — facilitator는 체인이 본 적 없는 위임을 거절됐다고
말하지 않는다. 구매자를 재서명으로 보내는 마지막 판단은 판매자 사다리의 몫이고, 그쪽의
`decideVerification`은 `/verify`의 `invalidReason`을 세 갈래로 읽는다: `rate_limited`와
`facilitator_not_ready`와 `unexpected_verify_error`는 판정이 아니라 "판정이 없다"라서
`unavailable`(503), 나머지는 `rejected`(402 + 오퍼 재발행), 그리고 그때 실리는 낱말은
허용집합에 있을 때만 facilitator의 것이고 밖의 문자열은 `delegation_rejected`로 접힌다.
`unexpected_verify_error`가 503인 이유는 브로드캐스트 전 우리 쪽 예외라 아무도 청구되지
않았고 위임에 대한 판정도 아니기 때문이다 — 거절로 읽으면 멀쩡한 grant를 다시 서명하러
보낸다. `invalid_transaction_state`는 거절로 남는다: 같은 leaf로는 다시 살 수 없지만 새
결제는 가능하므로 402가 맞다. 요청의 글 자체를 지적하는 네 낱말
(`unsupported_scheme`·`invalid_network`·`invalid_payment_requirements`·`invalid_x402_version`)도
같은 402로 답하는데, 이는 스펙의 400 매핑을 놓친 것이 아니라 고른 것이다: 400은 *읽을 수
없는* 결제에 대한 우리 답이고, 파싱은 됐지만 오퍼와 어긋난 payload는 402와 함께 돌아온 오퍼를
읽으면 고쳐진다 — 낡거나 잘못 읽은 오퍼로 서명한 구매자에게 필요한 것이 정확히 그것이다. 그날 가스 예산이 모자란
`budget_exhausted`·`payer_budget_exhausted`도 §9 밖이고, 위임이 아니라 우리 릴레이어의
하루가 거절한 것이다.

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
- **지출 caveat 부재.** 링크에 기간 상한도 평생 총액도 없으면 남은 잔량이
  `undefined`로 남는다. 이 상태를 두 소비자가 서로 다르게 판정하는 것은 질문이
  다르기 때문이다.

| | 질문 | `tightest === undefined` |
|---|---|---|
| `judgePreflight` (런타임) | 체인이 이 결제를 거절하는가 | 통과 — 한도가 없으면 거절되지 않는다 |
| `giwa-preflight` (사람 게이트) | 설정이 의도와 일치하는가 | 실패 — 대조할 값이 없다 |

  계산(`tightestRemaining`)은 `packages/delegation`에서 공유하고, 판정은
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
| `check:storage` | `apps/web/src` 전역에서 브라우저 저장소 **쓰기**가 승인된 한 모듈(`lib/grant-store.ts`) 밖으로 나가지 않는지 — 그 모듈의 투영은 에이전트 세션 키를 뺀 화이트리스트이고, 다른 곳의 두 번째 쓰기는 그 화이트리스트도 그 테스트도 물려받지 않는다. 읽기와 삭제는 어디서나 허용한다 |
| `check:mcp-stdio` | MCP 서버의 엔트리포인트 번들이 HTTP 어댑터에 닿지 않는지 — 대조군에서 참조를 먼저 찾아낸 뒤에야 그 0을 신뢰한다. 출력이 부재 그 자체라 항상 0을 내는 탐지기가 곧 fail-open이다 |
| `check:advisories` | `bun audit`의 모든 발견이 수정되었거나, 매 실행 재측정되는 `prove` 함수가 딸린 수용인지 |
| `check:counts` | 저장소 README가 적은 테스트 수가 bun·forge가 실제로 수집하는 수와 일치하는지 — 문서의 숫자끼리의 일치가 아니라 수트와의 일치를 검사한다 |

## 판매자 사다리 — 청구되지 않은 실패와 확인되지 않은 실패

불투명 사유 중 이 둘은 구분이 필수다. "지불자는 청구되지 않았다"는 다시 결제해도 되는
답이고, "청구 여부를 확인하지 못했다"의 재시도는 이중 지불이 된다. 판매자 사다리는 그
구분을 상태 코드로 낸다.

| 상태 | 언제 | 오퍼를 다시 싣는가 | 영수증 |
|---|---|---|---|
| `400 malformed_payment` | 헤더가 크거나 파싱 불가·ERC-7710 아님, 또는 실려 온 `payment-identifier`가 형식에 어긋남 | 아니오 — 고칠 곳이 헤더 안에 있다 | `invalid_payload`, `transaction: ""`, 그리고 헤더 자체가 읽힌 경우에만 지불자 |
| `409 payment_identifier_conflict` | 같은 `payment-identifier`에 다른 지문(다른 자원·값·메서드), 또는 아직 정산되지 않은 id에 다른 리프 | 아니오 — 이 id로는 무엇을 내도 같은 답이다 | 그 낱말과 지불자, `transaction: ""`. 이 요청으로 청구된 것은 없다 |
| `409 payment_identifier_settled` | 같은 지문에 다른 리프인데, 그 id로는 이미 정산이 끝났다 | 아니오 — 그 이름으로는 이미 냈다 | 그 낱말과 **저장된** 지불자, 그리고 해시가 있으면 해시 |
| `503 facilitator_unavailable` | `/supported` 미도달, `/verify`·`/settle`이 `rate_limited`·`facilitator_not_ready`, `/verify`가 `unexpected_verify_error` | 아니오 — 같은 결제를 나중에 다시 내면 된다 | 그 낱말과 지불자. 단 헤더를 아예 안 보낸 요청에는 영수증 없음 |
| `402` + 오퍼 | `/verify` 거절, 또는 아무도 청구되지 않은 `/settle` 실패(예산 낱말, 그리고 해시와 함께 오는 `settlement_reverted` — 채굴된 revert라 자산이 움직이지 않았다) | **예** — 새 leaf로 낼 수 있다 | 그 낱말과 지불자 |
| `504 settlement_unknown` | `/settle` 결과를 모른다: 응답 유실, `settlement_pending`, `unexpected_settle_error`, payer 불일치, 그리고 **해시를 댄 실패의 낱말이 채굴 실패 낱말이 아닐 때** | 아니오 — 청구됐을 수 있다 | `settlement_pending`, 지불자, 그리고 해시가 있으면 해시 |
| `502 settlement_misdirected` | `vendor_not_credited` — 채굴됐고 우리 `payTo`가 아닌 곳을 채웠다 | 아니오 — 잔고가 이미 움직였다 | `vendor_not_credited`, 지불자, 해시 |

결제 헤더를 **읽은** 뒤 거절하는 응답은 모두 `Payment-Response`에 x402 v2
`SettleResponse`를 싣는다: `success: false`, `network`, §9 낱말 하나, 그리고 아는 경우의
지불자. 해시가 있으면(504의 `settlement_pending`, 502의 `vendor_not_credited`) 반드시 함께
간다 — 구매자가 스스로 확인할 유일한 수단이다.

영수증은 성공과 실패에서 모양이 다르고, 타입이 `success`로 판별하는 합집합인 것도 그
때문이다(`packages/shared/src/x402.ts`): `payer`는 성공에 필수이고 실패에서만 생략될 수
있다 — 움직인 돈이 누가 냈는지 모를 수는 없지만, 헤더 자체가 읽히지 않은 400은 그 이름도
읽히지 않은 글자 안에 있었다. 같은 400이라도 헤더는 읽히고 그 안의 식별자만 형식에 어긋난
경우에는 지불자를 댄다. `errorReason`은 그 거울상으로 실패에 필수다. 참조 구현은 셋을 다
optional로 두지만, 우리 프로필은 나가는 낱말을 언제나 닫힌 어휘로 접어 갖고 있으므로
optional로 두면 "이유 없는 실패 영수증"이라는 생산자 없는 상태가 타입에 생긴다.

낱말과 칸은 일대일이 아니다. `invalid_payload`는 판매자가 읽지 못한 헤더에 스스로 대는
400의 낱말이면서, facilitator가 오퍼와 어긋나는 `accepted`나 서명된 root와 다른 위임자에
대는 낱말이기도 하고, 그것은 `KNOWN_REFUSAL_REASONS`를 그대로 통과해 지불자를 실은 402로
나온다. 칸은 상태로 읽고 낱말로 읽지 않는다.

영수증이 아예 없는 응답은 둘이다. 결제 헤더를 보내지 않은 요청 — 그 요청은 결제가
아니라 값을 물은 것이고, 없는 결제에 대한 영수증은 발명이다. 그리고 404 — 페이월이
헤더를 읽기 전에 떠나는 칸이므로 결제를 실은 요청도 영수증을 받지 못한다. 예외가 아니라
그 칸 자신의 규칙이다: 어차피 그 결제를 받아 줄 핸들러가 없었으니 값이 매겨진 적이 없고,
값이 매겨지지 않은 결제의 영수증도 발명이다. 그리고 모든 응답에
`Cache-Control: no-store`와 `Vary: Payment-Signature`가 붙는다 — 캐시가 결제한 본문을
미결제 요청에 주거나 미결제 402를 결제 요청에 주는 것을 막는다.

에이전트 쪽은 이 낱말을 읽어 실패를 분류한다(`payment-client.ts`). 재시도 응답이 2xx가
아니면 **헤더만** 읽고(바디는 열지 않는다 — 판매자가 bearer 헤더를 반사할 수 있다), 그
헤더에서도 두 칸만 본다: `errorReason`은 우리 상수와 문자열 일치하는 닫힌 집합에 있을 때만,
`transaction`은 16진 해시 모양일 때만. `settlement_pending`·`unexpected_settle_error` →
`SETTLEMENT_UNKNOWN`, `rate_limited`·`facilitator_not_ready`·`unexpected_verify_error` →
`SELLER_UNAVAILABLE`, 나머지 §9 낱말과 `delegation_rejected` → `PAYMENT_REJECTED`.

낱말이 할 수 있는 일에는 방향이 있다: 상태보다 **더** 조심하게 만들 수는 있어도 덜
조심하게 만들 수는 없다. `settlement_pending`은 402를 504의 독법으로 끌어올리지만,
`SETTLEMENT_UNKNOWN_STATUSES`(504·502·52x)에 속한 상태는 어떤 낱말로도 뒤집히지 않는다 —
그 집합은 아래 GIWA 사례가 만든 독법이고, 사례는 상태로 도착했다. 해시도 같은 규칙을 영수증
쪽에서 읽은 것이다: 실패 영수증이 해시를 대면 무언가 브로드캐스트됐다는 뜻이므로 낱말이
무엇이든 `SETTLEMENT_UNKNOWN`이고, 그 해시는 `detail`에 함께 실려 나간다 — 호출자가 탐색기에
넣을 수 있는 유일한 값이다. 집합 밖의 낱말은 아무것도 바꾸지 않고 상태 규칙이 결정한다 —
`vendor_not_credited`와 `settlement_reverted`가 그 보호의 이유다: 둘은 채굴된 실패의 낱말이고
해시와 함께 오므로 해시 규칙이 이미 읽는데, 이 낱말을 §9처럼 받아들이면 그것이 "아무 일도
없었으니 다시 내라"로 바뀐다.

이 구분의 근거는 실제 사례다. GIWA `0x533c5cb2…9964c`(block 31634935)는
지불자에게서 1.00 mUSDC를 실제로 이체했지만 호출자는 `PAYMENT_REJECTED`를
받았다 — 영수증 대기 타임아웃이 판매자의 HTTP 타임아웃보다 길게 설정되어
있었기 때문이다. 이후 타임아웃 예산은 바깥 계층일수록 길어지도록 재설계되었고
(25 → 35 → 45 → 50초), 결과 미확정 결제는 `SETTLEMENT_UNKNOWN`으로 반환된다.

판정은 순수 함수 `decideSettlement()`로 분리되어 있고
(`packages/delegation/src/facilitator-contract.ts`), 판정 기준 문자열
(`SETTLEMENT_PENDING`)과 응답 타입은 생산자·소비자가 같은 모듈에서
가져간다. 판정 사다리는 `unknown` 쪽으로 기운다.

| 관찰 | 결과 | 이유 |
|---|---|---|
| 응답 못 받음 (연결 거부·non-2xx·JSON 아님·타임아웃) | `unknown` 504 | "요청이 닿지 않음"과 "브로드캐스트 후 응답 유실"을 구분할 수 없다 |
| `errorReason === SETTLEMENT_PENDING` | `unknown` 504 (+해시) | x402 v2가 이 사유에 해시를 강제한다 — 해시가 없으면 호출자가 확인할 수단이 없다 |
| `errorReason === unexpected_settle_error` | `unknown` 504 (+해시) | 어느 시점의 실패인지 낱말이 말하지 않는다 — 브로드캐스트 여부를 말할 수 없는 답은 아무도 청구되지 않았다고 주장할 수 없다 |
| `success !== true`, `errorReason === vendor_not_credited` | `failed` 502 (+해시) | 채굴됐고 우리 `payTo`가 아닌 곳을 채웠다 — 잔고가 움직였을 수 있으므로 오퍼를 다시 주지 않는다 |
| `success !== true`, 해시가 있고 낱말이 채굴 실패(`settlement_reverted`·`vendor_not_credited`)가 아니다 | `unknown` 504 (+해시) | 해시가 낱말을 이긴다. `failed`에 닿는 모든 낱말은 브로드캐스트 전 거절을 주장하고(접힌 `delegation_rejected`도 그렇다), 해시는 그래도 무언가 나갔다고 말한다 — 낱말을 믿으면 증거를 쥐고 "다시 내라"로 답한다 |
| `success !== true`, 그 밖 | `failed` 402 + 오퍼 | 명시적 거절 — 자금이 이동하지 않았고, 새 leaf로 다시 낼 수 있다 |
| `success === true`, payer 불일치 | `unknown` 504 | 브로드캐스트는 주장되었으나 신원이 어긋났고, 잔액은 확인되지 않았다 |
| `success === true`, payer 일치 | `settled` 200 | |

`transaction`은 모든 `/settle` 응답에 있다 — 브로드캐스트한 해시, 아무것도
브로드캐스트하지 않았으면 `""`. x402 v2가 요구하는 모양이고, `settlement_pending`은 그
필수 해시 없이 나갈 수 없다.

`replayed: true`는 "이 호출이 그 답을 만든 호출이 아니다"라는 뜻이다. 호출이 시작될 때 이미
그 결제의 저널 행이 있었거나(재개된 청구는 그 행이 이미 이름 댄 바이트를 다시 보내므로 해시가
같다 — 새 거래가 아니다), 같은 결제로 몰린 동시 호출이 하나의 작업으로 합쳐져 그 작업의 답을
받았거나다. 그래서 한 결제에 표시 없는 답은 많아야 하나다. 다만 이것만으로 배송을 막을 수는
없다: 첫 시도가 `settlement_pending`으로 끝나고 나중 호출이 그 청구를 마무리하면 성공한 답은
전부 `replayed`다. 판매자의 중복 방지는 결제 intent id를 자기 쪽에 기록해 하고, 이 표시는
말 그대로 "다른 호출이 한 일"로만 읽는다.

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
