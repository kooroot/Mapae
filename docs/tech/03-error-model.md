<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 3. 에러 모델

정산 경로의 모든 실패 모드에 태그를 부여한 판별 유니온 (`packages/shared/src/errors.ts`).

블록체인 코드는 에러 표면이 유난히 넓다 — RPC 타임아웃, 레이트리밋, revert, nonce 경합, 서명 검증 실패, 릴레이어 가스 고갈. 이들을 하나의 `catch`로 뭉개면 **복구에 필요한 유일한 정보가 사라진다.** 각 태그는 다음을 구분한다:

- **재시도 가능** (`RpcUnavailable`, `RpcRateLimited`) — 백오프 후 재시도
- **운영 장애** (`RelayerOutOfGas` 등) — 503, 호출자 잘못이 아님. 알림 대상
- **호출자 오류** (`InvalidSignature`, `DomainMismatch`, `MalformedPayload`) — 4xx, 원인을 그대로 반환

`DomainMismatch`를 별도 태그로 둔 이유: EIP-712 도메인 불일치는 x402 통합에서 가장 흔한 실패이며, generic 500으로 나가면 데모 중에 원인을 특정할 수 없다.

**두 경로가 태그를 다르게 쓴다 (의도적).** 위 태그 유니온을 응답 본문에 그대로 싣는 것은
EIP-3009 직접 결제 경로(`apps/seller`)다. ERC-7710 위임 경로는 다르게 동작한다:

| | 직접 결제 (`apps/seller`) | 위임 결제 (`apps/delegated-seller`, `apps/facilitator-erc7710`) |
|---|---|---|
| 외부 응답 | `SettlementError._tag` + `describe()` 원인 | `delegation_rejected` / `settlement_unknown` 등 **불투명한 사유** |
| 상태 코드 | `httpStatusFor()` | 402 / 400 / 403 / 422 / 504 |
| 클라이언트 분기 | 태그 | `DelegatedPaymentFailureCode` (에이전트 측 자체 분류) |

위임 경로가 불투명한 이유는 태만이 아니라 위협 모델이다. 실패 사유를 상세히 돌려주면
공격자가 caveat 경계를 응답만으로 탐색할 수 있다 — 남은 한도, 만료 여부, 재위임 구조가
모두 오라클이 된다. **원인은 서버 로그로 간다.** `redactForLog`가 revert 사유
(`ERC20PeriodTransferEnforcer:transfer-amount-exceeded`)는 남기고, viem이 에러에 실어
보내는 bearer 길이의 hex(서명된 permission context)는 크기만 남기고 지운다. 운영자는
원인을 보고, 호출자는 보지 못한다.

### 낯선 사람의 상태에서 돌려봐야 보이는 것들

`bun run check` 는 이 저장소가 자기를 증명하는 방식이고, README 가 제일 먼저 시키는
명령이다. 그런데 그 게이트를 **항상 작업 트리에서만** 돌렸다 — 게이트는 자기가 도는 트리
밖의 버그를 잡지 못한다. 실제로 클론해서(`clone --recurse-submodules` → `bun install
--frozen-lockfile` → `bun run check`) 돌려보니 세 곳이 깨져 있었고, 셋 다 로컬에서는
보이지 않는 종류였다.

| 결함 | 로컬에서 안 보인 이유 |
|---|---|
| `check-docs.ts` 가 `AGENTS.md`/`CLAUDE.md` 를 무조건 읽어 `ENOENT` | 둘 다 gitignore 인데 작업 트리에는 있다 |
| `docs/deployed-contracts.md` 의 주소 5개의 정본이 gitignore | 로컬에만 있는 파일이 정본 노릇을 하고 있었다 |
| Foundry 테스트가 gitignore 된 생성물을 `vm.readFile` | 이전 Forge 실행이 남긴 파일이 있었다 |

세 번째가 가장 구조적이다. `make framework-test` 는 `framework-prepare` 에 의존한다고
선언하는데, 같은 스위트를 도는 `make test` 와 `bun run test:contracts` 는 하지 않았다 —
선언이 필요한 세 곳 중 한 곳에만 있었다.

계측 오류도 하나 있었다. 클론 실행을 `| tail -25` 로 받아 종료 코드가 0 으로 보였는데,
그건 `tail` 의 종료 코드다. 실제로는 1 이었다. CLAUDE.md 가 기록한 `ps -Eww` false zero
와 같은 부류 — **파이프를 통과한 종료 코드는 계측이 아니다.**

### 데모의 정문에서 "이유 반환" 이 깨져 있었다

같은 방법을 README 의 다음 명령에 적용했다. `bun run test:e2e:mcp` 는 준비물이 넷인데
하나씩, 그것도 최악의 순서로 알려줬다. `RELAYER_ADDRESS` 를 채우면 anvil 이 GIWA 를 **네트워크로
fork 한 뒤** 약 15초 지점에서 자식 프로세스가 죽으면서 `apps/facilitator-erc7710/index.ts`
의 **소스 목록**을 찍었고, 정작 없는 것(그 앱 자신의 `.env` 안 `RELAYER_PRIVATE_KEY`)은
그 안에 묻혀 있었다.

`assertPrerequisites()` 가 넷을 한꺼번에, 어떤 spawn 보다도 먼저 검사한다. 자식 앱의
`.env` 는 존재만 본다 — 변수를 여기서 읽으면 각 앱의 요구사항이 두 벌이 되고, 어긋나는
사본은 한 걸음 못 미치는 검사보다 나쁘다.

그리고 이 명령이 **클론에서 원리적으로 돌지 않는다**는 사실 자체가 문서화되어 있지 않았다.
서명된 root permission 이 필요하고 그건 배포된 계정을 소유한 지갑만 만들 수 있다. README 는
그걸 "the demo in one command" 라고만 불렀다. 이제 그 제약을 적고, 대신 **아무나 돌릴 수
있는** 것을 앞에 놓는다 — `bun run test:negative` 는 일회용 Anvil 에 38유닛 Framework 를
직접 배포해 23개 케이스를 돌리며, 키도 네트워크도 우리 아티팩트도 필요 없다. Bun 과
Foundry 만 있는 깨끗한 클론에서 실측: `23/23 cases passed`, 종료 코드 0.

### 빈 체인은 "한도 없음"이 아니라 "읽은 것이 없음"이다

에이전트 자동화 경로의 판정 기준은 "실패 시 조용히 죽지 말고 **이유** 반환"이고, 그 이유를 만드는 곳이
`judgePreflight` 다. 서명 전에 체인의 회계를 읽어 판매자에게 걸어 들어가는 대신 원인을
말하는 함수다.

그 함수의 규칙이 전부 루프였다. statuses 가 비면 revoked·expired·notYetActive 검사가
모두 그냥 지나가고, `tightest` 는 `undefined` 로 남아 한도 비교도 건너뛰고, 결과는
`{ok: true}` 였다. **아무것도 읽지 못한 상태에서 999 mUSDC 결제를 통과시킨다** — 실측.

도달 가능한 상태다. `isPermissionContext` 는 hex 의 모양과 길이를 보는 가드이고, 빈
`Delegation[]` 의 올바른 ABI 인코딩은 그 가드를 통과하는 130자짜리 문자열이며
`decodeDelegations` 는 그것을 `[]` 로 돌려준다.

자금 경로는 아니었다 — 정산은 여전히 온체인에서 거절된다. 무너진 것은 이 함수가 존재하는
이유 쪽이다.

코드는 `PERMISSION_INACTIVE` 를 재사용하지 않고 **`PERMISSION_EMPTY`** 를 새로 만들었다.
CLAUDE.md 의 규칙("모호한 태그를 재사용하지 말고 새 태그를 추가하라")이 여기 정확히
들어맞는다: `PERMISSION_INACTIVE` 는 운영자를 회수·만료를 확인하러 체인으로 보내는데,
망가진 permission 아티팩트에는 거기서 찾을 것이 없다.

가드는 두 곳에 있고 서로 다른 호출자를 막는다 — `loadDelegatedAgentRuntime` 은 부팅에서
한 번 던지고(기존의 "missing, malformed, or too large" 검증 바로 옆, 그 검증의 구멍이었다),
`judgePreflight` 는 자기 상태 목록을 직접 만드는 호출자를 막는다.

테스트 두 개 중 하나는 처음에 **공허하게** 통과했다. `not.toMatchObject({code:
"PERMISSION_INACTIVE"})` 는 가드가 없어 `{ok: true}` 가 나와도 통과한다 — 뮤테이션이 2개
중 1개만 깨뜨려서 드러났다. 양쪽을 다 단언하도록 고쳤고, 이제 가드를 제거하면 둘 다 깨진다.

### 없는 한도를 ✅ 로 적으면, 없다는 사실이 사라진다

위 가드는 체인이 **비어 있는** 경우를 막았다. 같은 계열의 두 번째 상태는 막지 못했다 —
체인은 멀쩡히 있는데 **어느 링크에도 주기 caveat 이 없는** 경우다. 도달 가능하다:
`readDelegationStatus` 는 그 링크에 `ERC20PeriodTransferEnforcer` caveat 이 없으면
enforcer 를 아예 호출하지 않고 `remaining` 을 `undefined` 로 둔다.

그러면 `tightest` 가 `undefined` 로 남는데, 이 값을 두 곳이 각자 해석하고 있었고 둘 다
통과로 읽었다. 그중 하나가 **브로드캐스트 직전 게이트**(`giwa-preflight.ts`)다:

```ts
record(tightest === undefined || amount <= tightest, "한도 대비 결제액", …);
```

`✅ 한도 대비 결제액 — 주기 caveat 없음`. 마지막 줄은 `GO — N개 조건 전부 충족` 이다.
이 제품의 중심 주장인 온체인 한도가 **빠져 있는 상태**가, 되돌릴 수 없는 정산을 앞둔
사람에게 "확인함"으로 보고된 것이다. 없음을 허가로 읽는 바로 그 모양이다.

**두 곳을 같게 고치지 않았다.** 질문이 다르기 때문이다:

| | 질문 | `tightest === undefined` |
|---|---|---|
| `judgePreflight` (런타임) | 체인이 이 결제를 거절하는가 | **통과** — 한도가 없으면 거절되지 않는다 |
| `giwa-preflight` (사람 게이트) | 내가 생각한 설정이 맞는가 | **실패** — 대조할 값이 없다 |

계산(`tightestPeriodRemaining`)만 `packages/delegation` 으로 올려 공유하고, 판단은 각자
두되 서로를 가리키는 주석을 달았다. 애초에 이 버그가 생긴 이유가 같은 여섯 줄이 두 벌
있었고 한 벌만 고쳐졌기 때문이다. `judgePreflight` 쪽 테스트에 "여기를 고치러 왔다면 먼저
저 주석을 읽으라"고 적어뒀다 — 일관성을 맞추려는 다음 사람이 정확히 그 테스트를 깨뜨린다.

현재 데모 permission 의 root 는 `ERC20PeriodTransferEnforcer` 를 갖고 있어 이 변경은
데모 동작에 영향이 없다. 확인하고 고쳤다.

같은 모양을 이 게이트에서 두 개 더 찾았다. 하나를 고치고 나서 **같은 관용구로 파일을
다시 훑은 것**이 방법이었다 — 판단 자리에 놓인 `undefined`.

| 자리 | 예전 | 무엇이 뒤집혔나 |
|---|---|---|
| 주기 한도 | `tightest === undefined \|\| amount <= tightest` | 한도가 없는데 "한도 안" |
| 유효창 | `status.validity` 없으면 상세만 `"제한 없음"`, 판정은 ✅ | **만료되지 않는 위임**이 유효창 확인됨으로 |
| relayer 가스 | `REDEMPTION_GAS_CEILING * (fees.maxFeePerGas ?? 0n)` | 상한을 못 읽으면 최악 비용이 **0** 이 되고 `relayerEth > 0n` 은 1 wei 로도 통과 |

셋째가 가장 구체적으로 위험하다. 이 조건이 존재하는 이유가 "정산 가스를 낼 수 있는가"
인데, 못 읽었을 때 그 질문의 답이 **자동으로 예**가 된다. 그리고 viem 의
`estimateFeesPerGas` 는 `maxFeePerGas` 를 nullable 로 선언한다 — 타입으로 확인했다
(`undefined extends Fees["maxFeePerGas"]` 가 참). 가정이 아니라 실재하는 상태다.

앞의 둘은 우리 빌더로는 만들 수 없는 permission 에서만 나온다 —
`preparePeriodDelegation` 은 timestamp caveat 과 주기 scope 를 무조건 붙인다. 손으로 만든
아티팩트에서만 나타난다는 뜻이고, **그래서 아무도 마주친 적이 없어 남아 있었다.**

네 번째는 다른 파일에 있었고, 이번 사냥에서 가장 값이 나갔다. 회수 제출기가
`judgeSubmissionReadiness` 에 `block.baseFeePerGas ?? 0n` 을 넘기고 있었다. 그 판정기가
막는 것은 이것이다 — EntryPoint 는 `min(maxFeePerGas, baseFee + priority)` 로 보전하는데
relayer 자신의 트랜잭션은 `baseFee` 아래로는 포함되지 못하므로, 서명된 `maxFeePerGas` 가
현재 base fee 밑이면 relayer 는 **회수할 수 없는 비용**을 낸다. 체인에서는 성공하고
운영자만 조용히 마른다.

`?? 0n` 은 그 검사를 `maxFeePerGas < 0n` 으로 만든다 — 모든 입력에 대해 거짓이다.
**가드가 존재하기를 멈춘다.** viem 은 블록의 base fee 를 `bigint | null` 로 선언하므로
도달 가능한 상태다.

이제 판정기가 `bigint | undefined` 를 받고 `base_fee_unreadable` 로 거절한다.
`fee_below_basefee` 와 사유를 나눈 것은 지시가 반대이기 때문이다 — 앞은 소유자에게 더
높은 수수료로 다시 서명하라는 뜻이고, 뒤는 우리가 체인을 못 읽었다는 뜻이다. 변이로
확인: 가드를 빼면 정확히 두 테스트가 깨진다. 회수 e2e 8 케이스는 그대로 통과한다
(fork 의 블록에는 base fee 가 있으므로 동작 변화가 없다).

### 기억으로 지키던 규칙을 게이트로 옮겼다

`redactForLog`가 있어도 그것을 **부르는 것**은 사람이었다. 6차원 감사가 17개의 탈출
경로를 찾아 파일 단위로 닫았는데, 그 스윕의 범위가 `apps/delegation-lab` 과
`apps/delegated-agent` 였다. `apps/agent/index.ts` 는 금지된 표현을 글자 그대로 유지한
채 그 스윕을 통과했다:

```ts
console.error(`\n${err instanceof Error ? err.message : String(err)}`);
```

오늘 무해한 이유는 그 파일이 `http()` 를 URL 없이 부르기 때문이다 — 다른 앱들처럼
`throttledHttp(readRpcUrl())` 한 줄만 들어가면 "닫혔다"고 문서화된 구멍이 조용히
열린다. 새 코드가 계속 되살리는 규칙은 게이트에 있어야 한다.

`bun run check:logging` 이 `apps/` · `packages/` · `scripts/` 전체에서 `console.*` 인자
안의 날것의 에러를 거절한다. AST 대신 어휘 검사인 이유는 실측이다 — 이 저장소의
`typescript` 는 7.x 네이티브 포트이고, 그 npm 패키지가 JS 에 노출하는 것은 `version`
뿐이다(`createSourceFile` 도 `SyntaxKind` 도 없다). 표현 하나를 린트하려고 파서를 하나 더
들이는 것보다, 주석·문자열·정규식 리터럴을 먼저 지우고 텍스트를 보는 편이 싸다.

지우는 쪽이 위험한 부분이라 export 해서 테스트한다(14 케이스). 그중 하나는 이 저장소의
실제 줄이다: `redactUrls` 의 정규식 `/\bhttps?:\/\/[^\s"'<>)\]}]+/gi` 는 문자 클래스
안에 큰따옴표와 작은따옴표를 **둘 다** 갖고 있어서, 정규식 리터럴을 모르는 스트리퍼는
그 지점부터 파일 끝까지 어긋난다 — 이후의 모든 `console` 호출이 검사에서 사라진다.

일곱 개의 진짜 누출을 일곱 개의 진짜 파일에 심어 증명했다. 그중 하나가 중요한데,
모듈 로컬 redactor 헬퍼(`console.error(myOwnRedact(error.message))`)는 세탁하지 못한다 —
`payment-client.ts` 가 실제로 그런 헬퍼를 갖고 있었고 그 반환값이 세 소비자에게 출력됐다.

체커의 첫 초안이 놓친 것도 하나 있었고, 그건 테스트가 아니라 테스트가 덮지 않은 모양을
찔러보다 나왔다: **`error?.message`**. `error.message` 보다 조심스러워 보이고 똑같이
누출하며, 사람이 catch 블록을 정리하다 쓰는 바로 그 형태다.

**범위는 `console.*` 뿐이다.** 응답 본문의 `detail: {message: error.message}` 도 같은
위험이지만, 그걸 잡으려면 어떤 객체가 응답이 되는지 알아야 하고, 오탐이 있는 체커는
꺼진다 — 경계가 명시된 체커보다 나쁘다.

### 자기 자신과만 맞춰본 숫자는 맞은 적이 없다

`check-docs.ts` 가 생긴 이유 중 하나가 "수트가 자랄 때마다 적힌 테스트 수가 어긋난다"
였는데, 정작 거기 붙은 검사는 문서를 **자기 자신과** 비교했다 — 배지 대 총계 대 내역
합. 셋은 사람이 손으로 고칠 때 함께 움직인다. 그래서 셋이 일치한다는 사실은 셋이
맞다는 뜻이 아니었고, 이번에 테스트 12개를 더했을 때 실제 수가 341 → 353 으로
바뀌는 동안 게이트는 녹색으로 `test counts check out` 을 출력했다. 같은 드리프트가
더 오래 방치된 곳도 있었다 — 저장소 지침 문서는 같은 명령을 `188 TS` 라고 적고
있었다.

세는 일은 bun 과 forge 에게 맡긴다. 소스를 정규식으로 세면 `describe.each` 와 생성된
케이스와 skip 을 사람이 추측해야 하고, **새로운 방식으로 틀린 숫자는 그냥 낡은 숫자보다
나쁘다.** 아무것도 매칭되지 않는 이름 필터를 주면 bun 은 파일을 전부 수집한 뒤
`skipping 256 tests` 를 출력하고 본문은 하나도 실행하지 않는다 — 수트당 약 200ms.
컨트랙트는 `forge test --list --json` 이 컴파일만 하고 294ms 에 14를 돌려준다.

`check-docs.ts` 안에 두지 않았다. 그 파일은 정적·즉시·오프라인을 약속하고, 이 검사는
프로세스를 네 번 띄운다. 약속이 다르면 게이트도 다른 게 맞다.

읽지 못한 개수는 **0이 아니라 실패**다. 0으로 읽으면 모든 비교가 공허하게 통과하고,
그건 이 검사가 막으려는 바로 그 상태다.

### 422 와 504 는 서로 반대되는 주장이다

불투명한 사유들 중 이 둘만은 **뭉개면 안 된다.** `settlement_failed`(422)는 "지불자는
청구되지 않았다"이고 `settlement_unknown`(504)은 "청구되었는지 우리도 모른다"이다.
전자는 재시도를 권하는 답이고, 그 재시도가 두 번 지불한다.

이건 가정이 아니라 이미 한 번 치른 값이다. GIWA `0x533c5cb2…9964c`(block 31634935)는
지불자에게서 1.00 mUSDC 를 실제로 옮겼는데 호출자는 `PAYMENT_REJECTED` 를 받았다.

그 구분은 `errorReason === "settlement_unconfirmed"` 문자열 하나에 달려 있었고, 그
문자열은 **두 프로세스에 각각 맨 리터럴로** 적혀 있었다. 읽는 쪽(`delegated-seller`)의
응답 타입은 필드가 전부 optional 이라, 생산자를 고쳐도 양쪽 다 타입체크를 통과하고
동작으로만 드러난다 — 계약이되 컴파일러가 검사할 수 없는 계약이었다.

지금은 요청 절반이 있던 자리(`packages/delegation/src/x402.ts`)에 응답 절반도 함께 산다:
`SETTLEMENT_UNCONFIRMED` 상수 하나, `Erc7710VerifyResponse`/`Erc7710SettleResponse`,
그리고 판정 자체가 `decideSettlement()` 라는 순수 함수다. facilitator 도 chain 도 key 도
없이 테스트되므로 `bun run check` 안에 들어간다.

판정 사다리 — `unknown` 쪽으로 기우는 것이 의도다:

| 관찰 | 결과 | 이유 |
|---|---|---|
| 응답 못 받음 (연결 거부·non-2xx·JSON 아님·타임아웃) | `unknown` 504 | "요청이 닿지 않음"과 "브로드캐스트 후 답이 유실됨"을 구분할 수 없다 |
| `errorReason === SETTLEMENT_UNCONFIRMED` | `unknown` 504 (+해시) | 해시가 없으면 호출자는 확인할 방법이 없다 |
| `success !== true` | `failed` 422 | 깨끗한 거절 — 돈이 움직이지 않았다 |
| `success === true`, payer 불일치 | `unknown` 504 | 브로드캐스트는 했다고 한다. 어긋난 건 신원뿐이고 잔액은 아무도 확인하지 않았다 |
| `success === true`, payer 일치 | `settled` 200 | |

마지막에서 두 번째 줄은 이번에 바뀐 동작이다. 이전에는 422 였는데, 그건 검사한 적 없는
잔액을 단정하는 답이었다.

여섯 뮤테이션으로 증명했다 — 미확인 분기 제거, payer 교차검사 제거, 도달불가를 `failed`
로, 해시 정규식 제거, verify 의 payer 무시, 그리고 **상수 이름 변경**. 각각 정확히 한두
테스트만 깨진다. 마지막 것이 핵심이다: 상수를 바꾸면 두 프로세스가 조용히 어긋나던 예전
상태에서는 아무 테스트도 깨지지 않았다.

배선까지 확인하려면 fork 에서 그 경로를 강제한다 — facilitator 가 이미 브로드캐스트한
트랜잭션의 receipt 대기를 1ms 만에 포기하게 만든다:

```bash
cd apps/delegation-lab && SETTLEMENT_RECEIPT_TIMEOUT_MS=1 bun run test:e2e:mcp
```

상태 코드만 보는 검증은 약하다 — 모든 것에 504 를 돌려주는 seller 도 통과한다. 그래서
이 실행은 enforcer 이벤트를 fork 에서 직접 읽어 **돈이 실제로 움직였는지**까지 확인한다.
지불자는 청구되었고, 답은 모른다고 말했다 — 그게 정직한 조합이다.

이 환경변수는 전부터 있었고 주석에도 "이렇게 하면 그 경로를 탈 수 있다"고 적혀 있었지만,
켜면 `body.ok !== true` 가드에 걸려 실행이 **실패**했다. 문서화된 탈출구로 문서화된
경로를 탈 수 없었던 것이다. CLAUDE.md 가 기록한 `verify-forge-addresses.ts` 와 같은 부류
— "재실행하라"고 적힌 조건이 조용히 재실행되지 않게 되는 방식.

## Effect 이관 계획

현재 판별 유니온으로 구현하되, `_tag` 판별자는 **의도적으로 [Effect](https://effect.website)의 `Data.TaggedError`와 동형**으로 잡았다.

| 단계 | 상태 |
|---|---|
| 현재 | 판별 유니온 + 명시적 분기. 타입 레벨에서 실패 모드가 전부 열거됨 |
| 다음 | 정산 경로를 `Effect<A, SettlementError, R>`로 이관 — 타입드 에러 채널, `Schedule` 기반 재시도/백오프, 리소스 안전한 RPC 커넥션 |

MVP 기간에 도입하지 않은 이유는 부분 도입이 어렵기 때문이다. Effect는 호출 체인 전체를 감염시키므로, 핵심 결제 루프가 검증되기 전에 도입하면 실행 리스크가 된다. 에러 모델의 **형태**를 먼저 확정해두면 이관은 재작성이 아니라 기계적 치환이 된다.
