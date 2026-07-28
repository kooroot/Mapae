<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 4. 보안 고려

## facilitator 신뢰 경계

facilitator는 릴레이어 키를 쥐고, 서명된 `X-PAYMENT`를 넘겨받고, leaf가 지정한
redeemer 본인이다. 즉 **모든 신원 검사를 통과하는 위치**에 있다. 이 시스템이 답해야
하는 질문은 "facilitator를 신뢰할 수 있는가"가 아니라 **"완전히 침해되었을 때 최대
피해가 무엇인가"**다.

핵심은 `redeemDelegations`의 서명 범위다. permission context는 서명되지만
**execution은 서명되지 않는다** — `_executionCallDatas`는 상환 시점에 호출자가
calldata로 공급한다 (`DelegationManager.sol:126-133`). 침해된 facilitator는 멀쩡한
leaf와 함께 **자기가 고른 아무 execution이나** 제출할 수 있고, 이를 막는 것은
오직 그 leaf에 붙은 caveat 집합뿐이다.

`wrong-redeemer` 케이스는 이걸 덮지 못한다. 그건 *낯선 자*가 상환할 수 없음을
증명한다. facilitator는 낯선 자가 아니다.

| 침해된 facilitator가 시도할 수 있는 것 | 거절하는 enforcer | 온체인 revert |
|---|---|---|
| 벤더 대신 자기 주소로 지급 | `AllowedCalldataEnforcer` | `invalid-calldata` |
| 받은 금액을 부풀리기 (주기 상한 이내라도) | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| 1회성 지불을 상시 allowance로 전환 (`approve` 드레인) | `ERC20TransferAmountEnforcer` | `invalid-method` |
| 다른 컨트랙트로 호출 돌리기 | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| native 값 끼워 빼내기 | `ValueLteEnforcer` | `value-too-high` |
| **payer 계정 자신을 target으로** (self 분기 진입) | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| 같은 leaf 재상환 | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| 만료 후 상환 | `TimestampEnforcer` | `expired-delegation` |
| 주기 상한 초과 누적 | `ERC20PeriodTransferEnforcer` | `transfer-amount-exceeded` |

self-target 케이스가 이 표에서 가장 덜 자명하다. 실행은 `IDeleGatorCore(root.delegator).executeFromExecutor`로 일어나므로(`DelegationManager.sol:252-253`), execution의 target이 payer 계정이면 계정이 **자기 자신을**
호출하게 되고 `msg.sender == address(this)`가 성립한다 — `onlyEntryPointOrSelf`의 *self*
분기다(`DeleGatorCore.sol:106-109`). 그 분기로 `withdrawDeposit`(:356),
`enableDelegation`(:373 — **회수를 되돌린다**), `_authorizeUpgrade`(:526 — 구현체 교체)에
닿는다. DeleGatorCore 안에는 self 호출을 막는 것이 없고, 거기 서 있는 것은 caveat뿐이다.
페이로드로 `withdrawDeposit(address,uint256)`을 고른 것은 그 calldata가 정확히 68바이트라
`ERC20TransferAmountEnforcer`의 길이 게이트(:87)를 **통과한 뒤** 컨트랙트 검사(:92)에서
걸리기 때문이다 — 크기 때문에 우연히 막히는 게 아님을 분명히 하려고.
뮤테이션으로 귀속을 확인했다: target만 토큰으로 되돌리면 revert가 `invalid-method`로
바뀌어 단언이 깨진다. 다만 이 케이스가 증명하는 것은 **caveat이 거절한다**까지이고,
caveat이 없었다면 self 호출이 성공했으리라는 것은 위 두 컨트랙트를 읽어서 아는 것이지
이 케이스가 증명하는 바가 아니다.

`approve` 케이스는 주소 검사를 **전부 통과하도록** 작성했다 — spender 슬롯에 고정된
벤더 주소가 들어간다. 그래서 이를 거절하는 것은 셀렉터 검사뿐이고, 실제로 거절한다.
지갑 탈취의 고전적 수법이 caveat 하나로 막히는 지점이다.

**그래서 남는 것 — 침해된 facilitator가 실제로 할 수 있는 일:**

- **정산 거부(liveness).** 자금은 안전하지만 결제는 진행되지 않는다. seller는
  504 `settlement_unknown`을 돌려주고, 이는 안전성이 아니라 가용성 문제다.
- **순서 조작·지연.** 만료 창 안에서.
- **지불자가 이미 승인한 그 금액을, 그 벤더에게, 실제로 집행.** seller가 리소스를
  주지 않았더라도. 손실이 발생할 수 있지만 **수취인은 언제나 에이전트가 고정한
  벤더**이며 facilitator 자신이 될 수 없다.

즉 **자금 탈취·경로 변경·한도 초과는 불가능하고, 남는 것은 가용성과 순서**다.
이것이 릴레이어에게 가스를 맡기면서도 자금을 맡기지 않는 구조의 값이다.

**증거.** 위 9행은 주장이 아니라 `negative-path-suite.ts`가 실행하는 케이스다.
6개 변조 케이스에는 **대조군**이 붙어 있다 — 같은 leaf, 같은 redeemer, 변조만 뺀
execution은 정상 정산된다. 대조군이 없으면 6개의 초록 체크가 변조와 무관한 이유
(소진된 주기, 낡은 계정)로도 나올 수 있다. 23개 케이스 전부 일회용 체인과
GIWA fork 양쪽에서 통과한다.

## 공격 벡터 대응표

| 벡터 | 대응 |
|---|---|
| 서명 리플레이 | EIP-3009 nonce 소비 (`authorizationState`), 테스트로 검증 |
| 스마트어카운트 서명 | OZ `SignatureChecker` — EOA와 EIP-1271 동시 지원. `ecrecover` 단독은 4337 계정에서 조용히 실패 |
| authorization 프론트런 | `transferWithAuthorization`은 관찰자가 먼저 제출 가능하나 자금은 서명된 `to`로만 이동 — 절도가 아닌 순서 문제. 수취 사실에 로직을 거는 경우 `receiveWithAuthorization` 사용 |
| 유효 기간 | `validAfter`/`validBefore` 강제. L2 시퀀서의 타임스탬프 조작 폭(초)은 유효창(분·시간) 대비 무의미 |
| 릴레이어 권한 | 금액·수취인이 서명에 고정되어 변경 불가 |
| 서명 로그 노출 | facilitator 오류 로그에는 signature·전체 payload를 남기지 않고 체인·자산·금액·주소·nonce 메타데이터만 기록 |
| facilitator 공격면 | API를 loopback/사설망에만 노출하고, 컨테이너 이미지를 digest로 고정하며 read-only·cap-drop·no-new-privileges 적용 |
| 리다이렉트 탈취 | agent와 seller의 결제 요청은 HTTP redirect를 거부해 `X-PAYMENT` authorization이 다른 origin으로 전달되지 않게 함 |
| 악성 DelegationManager | GIWA 배포 아티팩트에서 단일 manager allowlist, canonical EntryPoint와 필수 enforcer 주소 검증 |
| permission context 노출 | Git 제외, 크기 제한, 로그·오류 상세 미출력 |
| payer 영수증 위조 | `permissionContext`의 마지막/root delegator를 canonical payer로 도출하고 wire claim 불일치 거절 |
| verify→settle 경합 | settle 직전 재시뮬레이션 |
| 중복 settle | canonical 결제 조건과 context 바이트의 `paymentIntentId`로 단일화, broadcast tx hash를 receipt보다 먼저 저장 |
| 복잡한 delegation gas DoS | estimate 후 설정 gas cap 초과 거절 |
| 비인가 relayer | leaf의 `RedeemerEnforcer`와 402 `facilitatorAddresses` 교집합 강제 |
| 취약 의존성 | `bun audit`을 게이트에서 실행. 모든 발견은 고치거나, 근거와 **재측정 가능한 증명**을 붙여 수용 |

## 고칠 수 없는 권고를, 기록만 하고 끝내지 않는 법

`bun audit` 이 하나를 보고한다 — `@hono/node-server <2.0.5`, moderate,
`serve-static` 의 Windows 경로 traversal(`%5C`). 우리 MCP 서버는 stdio 트랜스포트를
쓰고 HTTP 서버를 띄우지 않는다. 그 어댑터는 SDK 가 *streamable HTTP* 트랜스포트를
위해 끌어오는 것이라, 우리 번들에는 들어오지 않는다 — 엔트리포인트를 번들하면 974개
모듈에서 `hono` 참조가 **0회**다.

호환 업데이트로는 닫히지 않는다. `@modelcontextprotocol/sdk@1.29.0` 이 최신 릴리스이고
`^1.19.9` 를 선언하는데, 1.x 의 마지막은 `1.19.15` 이고 수정은 `2.0.5` 에 들어갔다.
`overrides` 로 2.x 를 밀어 넣을 수는 있지만, 그것은 SDK 가 한 번도 테스트하지 않은
major 를 설치해서 **우리가 적재하지 않는 코드**를 고치는 일이다. 그래서 수용한다.

문제는 수용의 근거다. "우리는 그 코드에 닿지 않는다"는 쓰는 날에는 참이고 누군가
import 한 줄을 더하는 순간 거짓이 되며, 산문은 그걸 알아채지 못한다. 그래서
`scripts/check-advisories.ts` 의 수용 항목은 **`prove` 함수를 하나씩 들고 있다.**
매 실행마다 자기 주장을 다시 잰다. 실패 방향은 셋이고 전부 의도된 것이다 — 수용되지
않은 발견(새 권고가 옛 권고 뒤에 숨지 못한다), 증명이 깨진 수용(수용 근거가 사라졌다),
그리고 더 이상 보고되지 않는 수용(쓰지 않는 예외는 근거보다 오래 산다).

**계측 자체도 계측한다.** 항상 0을 돌려주는 탐지기는 검사를 통과시키면서 아무것도
증명하지 않는다 — 보안 게이트에서 가장 나쁜 모양이다. 그래서
`apps/agent-mcp/advisory-control.ts` 가 일부러 그 트랜스포트를 import 하고, 게이트는
컨트롤에서 참조를 **찾아낸 뒤에야** 진짜 엔트리포인트의 0을 믿는다(측정값 3 대 0).

이게 이론이 아니라는 증거는 만드는 도중에 나왔다. 처음에는 in-process `Bun.build` 를
썼는데, 같은 호출이 `bun run` 에서는 성공하고 `bun test` 에서는
`Could not resolve: "@mapae/shared"` 로 실패했다 — 번들러가 해석 루트를 **호출자에
따라** 잡는다. 해석 실패를 0으로 읽었다면 게이트는 "도달하지 않음"을 출력했을 것이다.
지금은 소유 패키지 디렉터리를 cwd 로 고정해 번들하고, 못 잰 경우는 0이 아니라
`null` 로 다룬다.

`bun audit` 의 상태 구분도 실측이다. 발견이 있으면 exit 1 + JSON, 깨끗하면 exit 0 +
`{}`, 레지스트리에 못 닿으면 exit 1 + **빈 stdout**. exit code 로는 "찾았다" 와 "묻지
못했다" 가 구분되지 않으므로 stdout 으로 판별한다. 닿지 못하면 비교를 건너뛰되 그렇다고
말하고, 증명은 그대로 돌린다 — 증명은 로컬이고, 썩는 쪽은 증명이다.
