# 회수(revocation) 런북

킬 스위치를 **로컬에서 완주시키고 검증하는** 절차. 설계 근거와 반례표는
[기술 노트 §2 D6](tech-notes.md)에 있고, 여기서는 중복하지 않는다.

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

`apps/revocation-submitter`를 **실제 프로세스로 띄워** 5케이스를 왕복한다.
유닛 테스트가 검증기를, 반례 수트가 온체인 강제를 각각 덮지만, 서비스 자체가
부팅되는지 — env 파싱, 배포 아티팩트 읽기, 시작 시 릴레이어 확인, `/health`,
single-flight, simulate→broadcast, `UserOperationEvent.success` 판정 — 는 이
명령만이 실행한다.

| 케이스 | 무엇을 증명하나 | 기대 응답 |
|---|---|---|
| A 예치금 없음 | 예치금 게이트가 **쓰기 전에** 답한다 | `409 prefund_short` + 부족분 |
| B 남의 계정 | 체인을 읽기도 전에 거절 | `400 invalid_submission` |
| C 정상 | 실제로 회수된다 | `200` + tx, `disabledDelegations` 참 |
| D 재요청 | 예치금이 실제로 소모됐다 | `409 prefund_short` |
| E 재충전 후 재요청 | 리플레이를 막는 건 **nonce**다 | `502` + `AA25 invalid account nonce` |

D와 E가 분리된 이유가 이 수트에서 가장 비자명하다. D만 있으면 "리플레이가
막혔다"고 말할 수 없다 — D를 막은 건 체인 앞단의 예치금 게이트고, nonce는 실행된
적이 없다. E는 예치금을 다시 채워 그 게이트를 치운 뒤 같은 바디를 그대로 다시
보낸다. 그러면 남는 방어선은 EntryPoint의 nonce 하나뿐이고, 그게 실제로 `AA25`로
끊는다.

케이스 C는 릴레이어의 **수지**까지 확인한다. 트랜잭션이 성공했다는 것만으로는
릴레이어가 보전됐다는 뜻이 아니라서다(§4).

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
보낼 곳 없이 지갑 서명을 받는 건 버튼이 없는 것보다 나쁘다 — 그 서명은 위임을
끄는 bearer 권한이기 때문이다.

이 값은 loopback만 허용하며 빌드 시점에 강제된다. 제출 엔드포인트에는 애플리케이션
인증이 없고 릴레이어 키를 들고 있다.

버튼이 잠기는 다섯 가지 이유는 각각 다른 문장을 보여준다 — 엔드포인트 미설정,
이미 회수됨, 지갑 미연결, 소유자 아님, 예치금 부족.

---

## 6. 백스톱

| 범위 | 수단 | 접근 제어 |
|---|---|---|
| 위임 하나 | `disableDelegation` (본 문서) | `onlyEntryPointOrSelf` |
| 프레임워크 전체 | `DelegationManager.pause()` | `onlyOwner` — 평범한 EOA 트랜잭션 |

`pause()`는 예치금이 필요 없다. 예치금 arming을 못 한 상태에서의 백스톱이다.
게이트(`verifyFrameworkOperationalState`)와 온체인(`whenNotPaused`) 양쪽이 막는다.
