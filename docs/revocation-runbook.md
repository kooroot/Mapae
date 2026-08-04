# 회수(revocation) 런북

킬 스위치를 **로컬에서 완주시키고 검증하는** 절차. 설계 근거와 반례표는
[기술 노트 §2 콘솔·회수](tech-notes.md)에 있고, 여기서는 중복하지 않는다.

GIWA 활성화 절차(예치금 arming, 서비스 배포, 키 보관)는 이 문서에 없다 — 운영
비밀값이 필요하므로 내부 런북에서 다룬다.

---

## 0. 한 줄 요약

소유자가 UserOperation 하나에 서명하고, 제출 엔드포인트가 그것을 EntryPoint에
실어 `disableDelegation`을 태운다. 그 뒤로 같은 위임을 쓰는 모든 결제가 끊긴다.

소유자의 지갑은 **가스를 내지 않는다.** 지불 계정도 ETH를 들지 않는다. 회수
비용은 EntryPoint에 미리 넣어둔 예치금에서 나간다.

---

## 1. 사전 조건

| | |
|---|---|
| `anvil` | Foundry 설치본 (`foundryup`) |
| 네트워크 | GIWA fork를 뜨기 위한 아웃바운드 RPC 접근 |
| 포트 | `8547`(anvil), `8183`(제출 엔드포인트) 비어 있을 것 |
| 비밀값 | **없음.** 계정·소유자·에이전트·릴레이어 키를 전부 그 자리에서 파생한다 |

공개 GIWA RPC는 rate limit이 있다. 사설 엔드포인트가 있으면
`apps/delegation-lab/.env`의 `GIWA_FORK_SOURCE_RPC_URL`로 넘기고 `SUITE_CUPS`를
올린다. 값은 **인자가 아니라 환경변수로만** 전달한다 — 제공자 키가 URL 경로에
들어 있는 경우가 많아 `ps`와 셸 히스토리에 그대로 남는다.

---

## 2. 로컬 완주

```bash
cd apps/delegation-lab
bun run test:e2e:revoke
```

`apps/revocation-submitter`를 **실제 프로세스로 띄워** 아래 표의 케이스를 순서대로
왕복한다. 수트가 통과한 케이스 글자를 세어 마지막 줄에
`PASS — N cases (ABC…)`로 출력하며, 이 표가 그 글자의 정본이다.
유닛 테스트가 검증기를, 반례 수트가 온체인 강제를 각각 덮지만, 서비스 자체가
부팅되는지 — env 파싱, 배포 아티팩트 읽기, 시작 시 릴레이어 확인, `/health`,
single-flight, simulate→broadcast, `UserOperationEvent.success` 판정 — 는 이
명령만이 실행한다.

| 케이스 | 증명 대상 | 기대 응답 |
|---|---|---|
| A 예치금 없음 | 예치금 게이트가 **쓰기 전에** 답한다 | `409 prefund_short` + 부족분 |
| B 남의 계정 | 체인을 읽기도 전에 거절 | `400 invalid_submission` |
| C 정상 | 실제로 회수된다 | `200` + tx, `disabledDelegations` 참 |
| D 재요청 | 예치금이 실제로 소모됐다 | `409 prefund_short` |
| E 재충전 후 재요청 | 리플레이를 막는 건 **nonce**다 | `502` + `AA25 invalid account nonce` |
| F 콘솔 preflight | 회수 버튼이 브라우저에서 닿을 수 있다 | `204` + 정확한 `allow-origin`·`content-type` |
| G 낯선 출처 preflight | 허용 목록에 없는 출처는 거절 | `403`, `allow-origin` 없음 |
| H Origin 없는 요청 | CORS 가드가 스크립트를 깨지 않았다 | `200` |
| I 스폰서드 /health | 모드·스폰서·예산을 밝히고 payer는 없다 | `mode: "sponsored"` + 예산 |
| J 스폰서드 회수 | ETH 0·예치금 0 계정이 회수되고 스폰서가 낸다 | `200` + tx, 스폰서 지출·잔여 예치 측정 |
| K 비소유자 서명 | 계정의 ERC-1271이 **예치 전에** 거절한다 | `403 invalid_account_signature`, 스폰서 nonce 불변 |
| L 완료 후 재제출 | 끝난 회수는 한 푼도 쓰지 않고 거절 | `409 already_revoked`, 추가 예치 없음 |
| P 수수료 300 wei | 수수료 **하한**이 릴레이어 손실을 막는다 | `400 invalid_submission`, 스폰서 nonce 불변 |
| M 예산 1 wei | 일일 예산이 실제 상한이다 | `503 budget_exhausted`, 위임은 그대로 |
| N 닫힌 응답 본문 | 공개 모드는 `detail`을 싣지 않는다 | `400 invalid_submission`, `detail` 없음 |
| O rate 1/시간 | 두 번째 요청부터 끊긴다 | `429 rate_limited` |

A–H는 **핀 모드**(단일 payer, loopback, 콘솔용)로, I–O는 같은 바이너리를
`PAYER_ACCOUNT_ADDRESS` 없이 재기동한 **스폰서드 모드**(공개 터널용)로 돈다.
스폰서드 케이스가 **새 계정**을 쓰는 이유: 첫 계정의 예치금은 E가 재충전해 두어
부족분이 0이고, 그 상태로는 이 모드의 존재 이유인 예치 대납 레그가 아예 돌지
않는다.

D와 E가 분리된 이유가 이 수트에서 가장 비자명하다. D만 있으면 "리플레이가
막혔다"고 말할 수 없다 — D를 막은 것은 체인 앞단의 예치금 게이트이고, nonce는
실행된 적이 없다. E는 예치금을 다시 채워 그 게이트를 치운 뒤 같은 바디를 그대로
다시 보낸다. 그러면 남는 방어선은 EntryPoint의 nonce 하나뿐이고, 그 nonce가
실제로 `AA25`로 끊는다.

케이스 C는 릴레이어의 **수지**까지 확인한다. 트랜잭션이 성공했다는 것만으로는
릴레이어가 보전됐다는 뜻이 아니라서다(§4).

K가 스폰서드 모드의 축이다. EntryPoint는 서명보다 예치금을 먼저 검사하므로
(`AA21`이 `AA24`보다 앞), 예치금 없는 계정에서는 시뮬레이션이 서명 판정에
도달하지 못한다 — 먼저 예치하면 쓰레기 서명 하나하나가 실제 `depositTo`를
소모한다. 그래서 스폰서드 경로는 예치 전에 계정 자신의
`getPackedUserOperationTypedDataHash` + `isValidSignature` 두 번의 `eth_call`로
서명을 묻는다. 판정 주체는 여전히 체인이고, 달라진 것은 시점뿐이다.

J가 측정하는 **잔여 예치(leftover)** 는 이 설계의 비용 상한이다. EntryPoint는
안 쓴 선납분을 **요청자 계정의 예치금으로** 환급하므로, 스폰서드 프로파일
(`SPONSORED_REVOCATION_GAS`, 기본 프로파일의 1% 수수료)이 그 선물의 상한을
정한다 — 요청당 최대 0.000007 ETH, 일일 예산이 총량을 다시 묶는다.

P는 같은 수수료가 **하한**이기도 한 이유다. EntryPoint의 릴레이어 보전은
`min(서명된 maxFeePerGas, tip + baseFee)`인데 릴레이어 자신의 트랜잭션은
`baseFee + tip`으로 나간다. GIWA 실측으로 base fee는 267 wei, 권장 tip은
1,000,000 wei — 세 자릿수 차이다. 하한이 없으면 base fee 바로 위(예: 300 wei)로
서명한 요청이 `fee_below_basefee`를 통과해 낸 것의 1/3700만 보전받고, 수수료가
낮으면 선납금도 작아 일일 예산조차 그것을 거의 세지 않는다. 싸게 공격할수록
유일한 상한이 덜 묶는 구조라, 하한은 예산이 아니라 오퍼레이션 쪽에 둔다.
릴레이어의 `handleOps` 브로드캐스트도 그 오퍼레이션의 `maxFeePerGas`로 상한을
잡아 보전액이 지출의 상한이 되게 한다.

---

## 3. 실패를 읽는 법

| 증상 | 원인 | 조치 |
|---|---|---|
| `409 prefund_short` | 예치금 부족. payer는 설계상 ETH 0이라 **기본 상태**다 | `EntryPoint.depositTo(payer)`로 arming |
| `409 fee_below_basefee` | 서명된 `maxFeePerGas`가 현재 base fee 아래 | 다시 빌드·서명. 그대로 태우면 성공하면서 운영자만 잃는다 |
| `409 relayer_unfunded` | 릴레이어 잔액 부족 | 릴레이어 충전 |
| `400 invalid_submission` | 검증기가 거절. 메시지가 필드를 지목한다 | 바디를 `buildRevocationSubmissionBody`로 다시 생성 |
| `502` + `AA24 signature error` | 서명자가 계정의 `owner()`가 아니거나 digest가 낡음 | 연결 지갑 확인. nonce를 다시 읽고 한 번에 빌드·서명 |
| `502` + `AA25 invalid account nonce` | 이미 쓴 UserOperation | 정상 동작. 이미 회수됐는지 확인 |
| `403 invalid_account_signature` | (스폰서드) 계정의 ERC-1271이 서명을 거절 — 예치 전에 끊은 것 | 소유자 지갑으로 다시 서명 |
| `409 already_revoked` | (스폰서드) 이미 끝난 회수의 재제출 | 정상 동작. 할 일 없음 |
| `409 sender_busy` | (스폰서드) 같은 계정의 다른 회수가 진행 중 | 잠시 후 재시도 |
| `429 rate_limited` | (스폰서드) IP 또는 계정 단위 빈도 초과 | 잠시 후 재시도 |
| `503 budget_exhausted` / `sponsor_unfunded` | (스폰서드) 일일 예산 소진 또는 스폰서 잔액 부족 | 운영자가 예산·잔액 확인 |

스폰서드 모드의 응답 본문은 **닫힌 enum**이다 — `detail.message`가 없다. 핀
모드는 loopback에서 소유자 자신에게 답하므로 검증 메시지를 싣지만, 공개 모드에서
viem 에러 문자열은 전송 URL(경로 키 포함)을 통째로 품을 수 있어 본문에 싣지
않는다. 자세한 원인은 서비스 stderr에만 남는다.

`AA24`가 특히 헷갈린다 — nonce나 가스 문제처럼 읽히지만 대개 **다른 지갑으로
서명**했거나 빌드와 서명 사이에 값이 다시 읽힌 경우다. 콘솔이 서명 전에
`owner()`를 대조하는 이유가 이것이다.

---

## 4. 함정 — 잘 알려진 Anvil 키를 릴레이어로 쓰지 말 것

GIWA에서 `0xf39Fd6e5…92266`과 `0x70997970…c79C8`은 EIP-7702 designator
(`0xef0100…`)를 달고 있고, 그 대상은 **들어온 잔액을 즉시 전액 전송하는 스위퍼**다.

서명자로 쓰면 서명 검증이 ERC-1271로 새는 것으로 드러나 금방 눈에 띈다. 문제는
**릴레이어**로 쓸 때다. `EntryPoint._compensate`가 beneficiary에게
`beneficiary.call{value: …}`로 지급하므로 스위퍼 코드가 실행되고, `handleOps`
한 번에 릴레이어가 빈다.

측정값(fork): 릴레이어 1 ETH → 0.00024 ETH, 같은 블록의 트랜잭션 비용은
0.00017 ETH. `debug_traceTransaction`의 중첩 CALL에서 잔액이 빠져나갔다.
증상이 수수료 추정 버그처럼 보이고, 실제 실패는 몇 케이스 뒤 "insufficient
funds"로 나타나 엉뚱한 곳을 보게 만든다.

그래서 이 수트는 릴레이어 키까지 파생해서 쓰고, 시작 시 릴레이어 주소에 코드가
없는지 확인하며, 케이스 C에서 가스 대비 잔액 변화를 검증한다.

---

## 5. 콘솔에서

```bash
cd apps/console && bun run dev
```

`VITE_REVOCATION_SUBMITTER_URL`이 없으면 회수 버튼은 **비활성 상태로 남는다.**
보낼 곳 없이 지갑 서명을 받는 것은 버튼이 없는 것보다 나쁘다 — 그 서명은 위임을
끄는 bearer 권한이기 때문이다.

이 값은 loopback만 허용하며 빌드 시점에 강제된다. 제출 엔드포인트에는 애플리케이션
인증이 없고 릴레이어 키를 들고 있다.

버튼이 잠기는 다섯 가지 이유는 각각 다른 문장을 보여준다 — 엔드포인트 미설정,
이미 회수됨, 지갑 미연결, 소유자 아님, 예치금 부족.

### 브라우저 레그 — cross-origin preflight

콘솔은 `:5173`, 제출기는 `:8082`다. 포트가 다르면 다른 출처이고, 회수 요청이
`content-type: application/json`을 실어 보내므로 **브라우저가 preflight를 먼저 보낸다.**
그 preflight가 실패하면 POST는 아예 나가지 않는다 — 버튼은 살아 있어 보이고 아무 일도
일어나지 않으며, 콘솔에도 서버 로그에도 흔적이 남지 않는다.

제출기는 `REVOCATION_CONSOLE_ORIGINS`의 출처만 답한다. 기본값은 `vite`(5173)와
`vite preview`(4173)를 loopback 두 표기로 덮는다. 콘솔을 다른 포트에서 띄웠다면 이
값을 같이 바꿔야 한다.

**`*`는 거부한다.** 이 서비스는 애플리케이션 인증이 없고 자금이 든 릴레이어 키를 들고
있다. 와일드카드는 운영자가 열어 둔 아무 페이지에나 이 서비스의 가스를 쓸 길을 준다.
`validateRevocationSubmission`이 소유자 서명이 아닌 것을 이미 거절하므로 위조 경로는
아니지만, 재전송으로 가스를 태우는 경로는 열린다.

서버 사이드 `fetch`는 CORS를 강제하지 않으므로, 스크립트 검증만으로는 이 간극이
드러나지 않는다. `revocation-submitter-e2e.ts`의 케이스 F/G가 preflight 응답을,
케이스 H가 Origin 없는 요청을 직접 확인해 그 간극을 덮는다.

---

## 6. 백스톱

| 범위 | 수단 | 접근 제어 |
|---|---|---|
| 위임 하나 | `disableDelegation` (본 문서) | `onlyEntryPointOrSelf` |
| 프레임워크 전체 | `DelegationManager.pause()` | `onlyOwner` — 평범한 EOA 트랜잭션 |

`pause()`는 예치금이 필요 없다. 예치금 arming을 못 한 상태에서의 백스톱이다.
게이트(`verifyFrameworkOperationalState`)와 온체인(`whenNotPaused`) 양쪽이 막는다.

---

## 지갑 레그를 fork에서 검증하기

회수 경로에서 자동화가 덮지 못하는 곳은 정확히 하나다 — **사람이 지갑 승인 화면을
보고 승인하는 구간.** `revocation-submitter-e2e.ts`가 빌드→서명→POST→CORS
preflight→simulate→`handleOps`→`UserOperationEvent.success`까지 전 케이스를
완주하지만 서명은 viem `LocalAccount`가 만든다. 지갑 확장이 하는 일(사람에게
렌더링, `domain.chainId` 강제, 계정 전환, 사용자 거절)은 그 경로에 아예 없고,
injected provider를 스텁으로 흉내내면 검증 대상이 스텁 자신이 된다.

```bash
cd apps/delegation-lab
bun run lab:revoke        # GIWA head를 fork, 예치금 arming, 제출기 기동 후 대기
```

랩이 하는 일: GIWA 헤드를 fork → 파생 relayer에 `anvil_setBalance` →
`EntryPoint.depositTo(payer)`로 1회분의 8배 예치 → 제출기를 fork에 물려 기동 →
`apps/console/.env.local` 작성 → **Ctrl-C까지 그대로 대기.**

### fork로 충분한 이유

서명이 오프라인 EIP-712이고 **fork도 chain id 91342**라, 지갑이 서명하도록
요청받는 다이제스트가 라이브 GIWA의 것과 바이트 단위로 같다 — 같은 도메인, 같은
`verifyingContract`, 같은 `entryPoint`. 그리고 fork는 GIWA의 실제 상태를 들고
있으므로 커서 아래 계정이 진짜 payer `0xA4e4d00E…DDF382`와 진짜 owner다. 라이브
GIWA가 추가로 주는 것은 채굴된 트랜잭션과 익스플로러 링크뿐이다.

여기서 따라오는 결론: **MetaMask에 커스텀 네트워크를 추가할 필요가 없다.** 지갑은
`domain.chainId`를 선택된 네트워크와 비교하는데 실제 GIWA Sepolia도 91342다.
소유자는 GIWA Sepolia에 그대로 있으면서 서명하면 된다. 지갑은 fork에 접속하지
않는다 — fork와 말하는 것은 이 프로세스와 콘솔뿐이다.

### 알려진 함정 둘

- **`localhost` 말고 `127.0.0.1`로 열 것.** 같은 머신의 다른 프로젝트가
  `localhost:5173`에 service worker를 남겨두면 그 앱이 대신 뜬다. 서버는 두 호스트
  모두 정상 응답하는데 브라우저만 다른 것을 보여주므로, 원인을 콘솔에서 찾게 된다.
- **콘솔 포트가 5173이 아닐 수 있다.** 그 포트가 이미 쓰이면 vite는 5174로
  내려가고, CORS allowlist가 그 포트를 안 덮으면 회수 버튼이 **조용히** 아무 것도
  안 한다. 랩은 5173–5176과 4173을 두 호스트 표기로 모두 덮고, 어느 포트로 갈지
  미리 알려준다.

### 안전

라이브 GIWA에 닿는 것은 없다. 제출기 자식 프로세스는 spawn 전에 loopback fork로
고정되고, 실제 GIWA relayer nonce를 시작과 종료 시점에 각각 읽어 불변임을
증명한다. `.env.local`은 gitignored이며, 지우면 콘솔이 다시 라이브 GIWA를 본다.
