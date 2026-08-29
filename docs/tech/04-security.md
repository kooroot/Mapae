<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 4. 보안 고려

## facilitator 신뢰 경계

facilitator는 릴레이어 키를 쥐고, 서명된 `Payment-Signature`를 넘겨받고, leaf가 지정한
redeemer 본인이다. 즉 모든 신원 검사를 통과하는 위치에 있다. 따라서 신뢰
경계는 facilitator의 신뢰 여부가 아니라 **완전히 침해되었을 때의 최대 피해**를
기준으로 정의한다.

핵심은 `redeemDelegations`의 서명 범위다. permission context는 서명되지만
**execution은 서명되지 않는다** — `_executionCallDatas`는 상환 시점에 호출자가
calldata로 공급한다(`DelegationManager.sol:126-133`). 침해된 facilitator는
유효한 leaf와 함께 임의의 execution을 제출할 수 있고, 이를 막는 것은 그 leaf에
붙은 caveat 집합뿐이다. `wrong-redeemer` 케이스는 이 위협을 덮지 못한다 — 그
케이스가 증명하는 것은 제3자가 상환할 수 없다는 사실이고, facilitator는
제3자가 아니다.

| 침해된 facilitator의 시도 | 거절하는 enforcer | 온체인 revert |
|---|---|---|
| 벤더 대신 자기 주소로 지급 | `AllowedCalldataEnforcer` | `invalid-calldata` |
| 금액 부풀리기 (주기 상한 이내라도) | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| 1회성 지불을 상시 allowance로 전환 (`approve` 드레인) | `ERC20TransferAmountEnforcer` | `invalid-method` |
| 다른 컨트랙트로 호출 변경 | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| native 값 동봉 | `ValueLteEnforcer` | `value-too-high` |
| **payer 계정 자신을 target으로** (self 분기 진입) | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| 같은 leaf 재상환 | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| 만료 후 상환 | `TimestampEnforcer` | `expired-delegation` |
| 주기 상한 초과 누적 | `ERC20PeriodTransferEnforcer` | `transfer-amount-exceeded` |

self-target 케이스가 가장 비자명하다. 실행은
`IDeleGatorCore(root.delegator).executeFromExecutor`로 일어나므로
(`DelegationManager.sol:252-253`), execution의 target이 payer 계정이면 계정이
자기 자신을 호출하게 되고 `msg.sender == address(this)` — `onlyEntryPointOrSelf`의
*self* 분기 — 가 성립한다(`DeleGatorCore.sol:106-109`). 이 분기로
`withdrawDeposit`(:356), `enableDelegation`(:373 — 회수를 되돌린다),
`_authorizeUpgrade`(:526 — 구현체 교체)에 닿는다. DeleGatorCore에는 self 호출을
막는 장치가 없고, 그 자리에 서 있는 것은 caveat뿐이다. 케이스의 페이로드로
`withdrawDeposit(address,uint256)`을 쓰는 이유는 그 calldata가 정확히
68바이트라 `ERC20TransferAmountEnforcer`의 길이 게이트(:87)를 통과한 뒤
컨트랙트 검사(:92)에서 걸리기 때문이다 — 크기로 우연히 막히는 것이 아님을
분명히 한다.

`approve` 케이스는 주소 검사를 전부 통과하도록 구성되어 있다 — spender 슬롯에
고정된 벤더 주소가 들어간다. 이를 거절하는 것은 셀렉터 검사뿐이고, 실제로
거절한다.

침해된 facilitator에게 남는 능력은 다음으로 한정된다.

- **정산 거부 (liveness).** 자금은 안전하나 결제가 진행되지 않는다. seller는
  504 `settlement_unknown`을 반환한다 — 안전성이 아니라 가용성 문제다.
- **순서 조작·지연.** 만료 창 안에서.
- **지불자가 이미 승인한 금액을, 지정된 벤더에게, 실제로 집행.** seller가
  리소스를 주지 않았더라도. 손실이 발생할 수 있으나 수취인은 언제나 에이전트가
  고정한 벤더이며 facilitator 자신이 될 수 없다.

**자금 탈취·경로 변경·한도 초과는 불가능하고, 남는 것은 가용성과 순서다.**
릴레이어에게 가스를 맡기면서 자금을 맡기지 않는 구조의 근거가 이것이다.

위 표의 9행은 `negative-path-suite.ts`가 실행하는 케이스이며, 6개 변조 케이스에는
대조군이 붙는다 — 같은 leaf, 같은 redeemer, 변조만 제거한 execution은 정상
정산된다. 대조군이 없으면 6개의 거절이 변조와 무관한 이유(소진된 주기, 낡은
계정)로도 나올 수 있다. 전체 케이스는 일회용 체인과 GIWA fork 양쪽에서
통과한다.

facilitator와 같은 공개 호스트는 `/bootstrap` 경로로 온보딩 스폰서도 라우팅한다
— 별도 프로세스, 별도 키다. 요청 본문은 `{permissionContext}` 하나이고 owner는
서명에서 복원하며 `CREATE2(owner)`가 permission의 delegator와 일치해야 하므로,
호출자는 우리가 배포비를 낼 주소를 지명할 수 없다. 응답은 닫힌 거절 enum만
내보낸다. 스폰서 키가 침해되어도 얻는 것은 잔액만큼의 가스 낭비다 — 위임 권한이
없으므로 payer 자금·한도·정산에는 닿지 못한다. 스폰서가 relayer·deployer와
겹치면 서비스가 기동을 거부한다: 인증 없는 요청에 응답하는 키를 정산 키와
공유하면, 그리핑이 정산 중단으로 번지기 때문이다.

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
| 리다이렉트 탈취 | agent와 seller의 결제 요청은 HTTP redirect를 거부해 결제 헤더(`Payment-Signature`/`X-PAYMENT`)의 authorization이 다른 origin으로 전달되지 않게 함 |
| 악성 DelegationManager | GIWA 배포 아티팩트에서 단일 manager allowlist, canonical EntryPoint와 필수 enforcer 주소 검증 |
| permission context 노출 | Git 제외, 크기 제한, 로그·오류 상세 미출력 |
| payer 영수증 위조 | `permissionContext`의 마지막/root delegator를 canonical payer로 도출하고 wire claim 불일치 거절 |
| verify→settle 경합 | settle 직전 재시뮬레이션 |
| 중복 settle | canonical 결제 조건과 context 바이트의 `paymentIntentId`로 단일화, broadcast tx hash를 receipt보다 먼저 저장 |
| 복잡한 delegation gas DoS | estimate 후 설정 gas cap 초과 거절 |
| 비인가 relayer | leaf의 `RedeemerEnforcer`와 402 `facilitatorAddresses` 교집합 강제 |
| 온보딩 그리핑 (배포 요청 반복) | 계정당 24시간 1회 faucet 창 + 일일 가스 예산 + 소액 전용 스폰서 지갑 — 소진 시 그날의 온보딩만 멈추고 정산·자금과 무관 |
| 배포 대상 주소 지명 | 요청 본문은 `{permissionContext}`뿐 — owner는 서명에서 복원, 계정은 `CREATE2(owner)`이며 delegator와 일치해야 함 |
| 비-canonical 서명 (high-s, `v ∉ {27,28}`) | 오프라인 canonical 검사 후에만 배포 — viem은 수락하지만 OZ `ECDSA`는 revert하므로, 검사 없이는 모든 grant가 revert하는 계정을 돈 내고 배포하게 된다 |
| 취약 의존성 | `bun audit`을 게이트에서 실행. 모든 발견은 수정하거나, 재측정 가능한 증명을 붙여 수용 |

## 의존성 권고의 수용 기준

`bun audit`이 보고하는 발견은 수정하거나, 근거를 붙여 명시적으로 수용한다.
현재 수용된 것은 없다.

수용의 근거는 산문이 아니라 코드다. `scripts/check-advisories.ts`의 수용
항목은 매 실행 자기 주장을 재측정하는 `prove` 함수를 가지며, 실패 방향은 셋이다
— 수용되지 않은 신규 발견, 증명이 깨진 수용, 더 이상 보고되지 않는 수용(쓰지
않는 예외는 근거보다 오래 남는다). 레지스트리에 닿지 못한 실행은 발견 0건과
구분된다 — 그 경우 비교를 건너뛴 사실을 출력하고, `prove` 함수는 오프라인으로
그대로 실행된다.

세 번째 방향이 실제로 발동한 적이 있다. `@hono/node-server <2.0.5`의 Windows
경로 traversal(moderate)을 수용하고 있었는데, 이후 권고의 영향 범위가
`< 1.19.15`와 `>= 2.0.0, < 2.0.5` 둘로 개정되었다 — 수정이 1.x로 백포트되었고,
락파일은 이미 그 1.19.15를 물고 있었다. 수용할 것이 남지 않아 항목을 지웠다.
수용문에 적혀 있던 "1.19.15가 published된 마지막 1.x"는 맞는 사실이었고, 그
1.19.15가 백포트였다는 것만 당시에 알 수 없었다.

## MCP 서버는 stdio 전용이다

위 수용 항목이 달고 있던 증명은 권고와 함께 사라지지 않고
`scripts/check-mcp-stdio.ts`로 남았다. 증명하려던 성질이 권고와 무관하기
때문이다 — `apps/agent-mcp`는 stdio로만 말하고 HTTP 리스너를 열지 않는다.
이것은 사고가 아니라 설계이며, 코드 어디에도 그렇게 적혀 있지 않고 `import`
한 줄이면 깨진다.

게이트는 엔트리포인트를 번들해 HTTP 어댑터 참조가 0인지 본다. 출력이 부재
그 자체이므로 항상 0을 반환하는 탐지기 — 이름이 바뀐 패키지, 문자열을
minify하는 번들러, 조용히 실패한 빌드 — 는 아무것도 증명하지 않은 채
통과한다. 그래서 대조군을 먼저 잰다. `apps/agent-mcp/http-transport-control.ts`는
실제 서버가 쓰지 않는 트랜스포트를 일부러 import하며, 거기서 참조를 찾아낸
뒤에야(측정값 3 대 0) 엔트리포인트의 0을 신뢰한다.

## 로깅과 자격증명

viem은 전송 URL 전체를 에러 메시지에 포함시키며, 경로에 API 키가 든 RPC
엔드포인트에서는 URL 자체가 크리덴셜이다. `packages/shared`의 `redactUrls`가
로그에 남는 URL을 `scheme://host`로 축약하고, `check:logging` 게이트가
`console.*` 인자에 날것의 에러가 닿는 코드를 저장소 전체에서 거절한다. 서명된
payload와 permission context는 bearer 권한이므로 로그·오류 상세에 출력하지
않는다.
