# Mapae (마패)

[English](README.md) | **한국어**

> **Bounded authority for autonomous payments on GIWA.**

Mapae는 AI 에이전트가 사용자의 지갑이나 개인키를 소유하지 않고도,
정해진 금액·기간·수취인 범위 안에서 자율적으로 결제할 수 있게 만드는
GIWA-native 에이전틱 페이먼트 인프라입니다.

[![Network: GIWA Sepolia](https://img.shields.io/badge/network-GIWA%20Sepolia-111827)](https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa)
![x402 v2](https://img.shields.io/badge/x402-v2-635BFF)
![ERC-7710](https://img.shields.io/badge/delegation-ERC--7710-3C3C3D)
![Tests](https://img.shields.io/badge/tests-468%20TS%20%2B%2014%20Foundry-16A34A)

**마패는 특권의 증표가 아니라 한계의 증표입니다.**

에이전트에게 지갑을 넘기는 대신, 온체인에서 강제되는 제한된 경제적 권한만
위임합니다.

## 왜 Mapae인가

일반적인 자동 결제 봇은 에이전트 프로세스에 자금이 든 EOA 개인키를 넣습니다.
코드의 `MAX_PAYMENT`를 지우면 지갑 전체가 노출되는 구조입니다.

Mapae는 실행 주체와 자금 소유자를 분리합니다.

| 구분 | 일반 자동 결제 봇 | Mapae |
|---|---|---|
| 자금 소유 | 에이전트 EOA | 사용자의 스마트계정 |
| 에이전트 권한 | 지갑 전체 | 세션키에 위임된 범위만 |
| 한도 강제 | 애플리케이션 코드 | 온체인 caveat |
| 결제 가스 | 지불자 | facilitator relayer |
| 회수 | 키 교체 | 위임 취소 |

현재 정책 모델은 다음을 지원합니다.

- 주기별 ERC-20 지출 상한
- 짧은 만료 시간
- 특정 vendor로 수취인 고정
- facilitator/redeemer 제한
- manager → child 재위임과 상위 한도 합산
- owner가 언제든 실행할 수 있는 위임 취소

## 작동 방식

```mermaid
flowchart LR
    Owner["Account owner<br/>wallet"] -->|"root delegation"| Account["HybridDeleGator<br/>smart account"]
    Account -->|"period / expiry / vendor caveats"| Session["Agent session key"]
    Session -->|"payment-specific ERC-7710 leaf"| Agent["AI agent"]
    Agent -->|"GET resource"| Seller["x402 seller"]
    Seller -->|"402 Payment Required"| Agent
    Agent -->|"Payment-Signature"| Seller
    Seller -->|"verify / settle"| Facilitator["ERC-7710 facilitator"]
    Facilitator -->|"redeemDelegations"| Manager["DelegationManager"]
    Manager -->|"mUSDC.transfer"| Seller
```

Mapae에는 비교 가능한 두 결제 경로가 함께 있습니다.

| 경로 | 목적 | 상태 |
|---|---|---|
| EIP-3009 + x402-rs | 가스리스 exact 결제 기준선 | GIWA Sepolia 정산 완료 |
| ERC-7710 + x402 | 제한·만료·회수 가능한 에이전트 결제 | GIWA Sepolia 정산 완료, caveat 거절은 배포된 enforcer가 GIWA 현재 상태를 상대로 판정 |

## 현재 상태

아래에서 "완료"라 부르는 것이 두 종류이고, 열이 그중 무엇인지 말한다. **GIWA**는 GIWA
Sepolia에 블록으로 들어가 익스플로러에서 열리는 트랜잭션이다. **로컬 fork**는 실제 GIWA
상태와 실제 배포 바이트코드를 상대로 로컬 Anvil fork에서 돈다는 뜻이다 — 강한 결과지만
채굴된 것은 없고 따라갈 링크도 없다.

| 기능 | 결과 | 증명된 곳 |
|---|---|---|
| 토큰 + facilitator | MockUSDC 배포·소스 검증, x402-rs facilitator 연결 | **GIWA** |
| 직접 결제 | `402 → sign → verify → settle → resource` 완주 | **GIWA** |
| 위임 결제 | Framework와 owner 스마트계정 배포, root 위임 오프라인 서명·ERC-1271 검증, 위임 결제 가스리스 정산 | **GIWA** |
| 에이전트 자동화 | MCP tool 한 번 호출로 사람 개입 0 완주 | **GIWA** |
| 콘솔 | 콘솔이 한도·남은 주기 잔액·정산 영수증을 체인에서 직접 읽음 | 로컬 fork |
| 상시 게이트 | 문서·로깅·의존성 권고·테스트 수 상시 게이트, TypeScript 468 + Foundry 14, 두 체인 타깃 negative path 23/23 | 로컬 + GIWA 읽기 전용 검증 |

- MockUSDC: [`0xcfeb…e92`](https://sepolia-explorer.giwa.io/address/0xcfeb694719A09caeb80798e2011298F29CDa4e92)
- 직접 정산: [`0xc9ab…b7a9`](https://sepolia-explorer.giwa.io/tx/0xc9ab58de064e88776cf2681851849cb4d79ad5c468d2675c60cbdd6ffaa3b7a9)
- 위임 정산 1 mUSDC: [`0xe897…a97d`](https://sepolia-explorer.giwa.io/tx/0xe897fe55048b91c0f6728d0af313e30db2b425af8955ee89f7174a16c6aaa97d)
- 위임 정산 2.5 mUSDC: [`0x71d7…6ce4`](https://sepolia-explorer.giwa.io/tx/0x71d7144213a04ae7b463f1c0e2b021c672938f10c7d92d5d4fe367e532f46ce4)
- **에이전트 자율 정산**, MCP 1회 호출, 사람 개입 0:
  [`0x533c…9964c`](https://sepolia-explorer.giwa.io/tx/0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c)
  — block 33534935, payer −1.00 mUSDC, vendor +1.00 mUSDC, **payer 가스 지출 0**.
  이 실행이 실제 결함도 하나 드러냈고 수정이 같은 트리에 있다 — 체인에서는 채굴됐는데
  에이전트는 거절됐다는 답을 받았다. 아래 "settlement-unknown" 참조.
- 한도 초과와 만료는 백엔드 검사가 아니라 **배포된 enforcer가 거절**한다.
  **이 둘에는 걸 tx 해시가 없고**, 그것은 빈틈이 아니라 설계가 작동한 결과다:
  facilitator가 브로드캐스트 전에 `redeemDelegations`를 GIWA 현재 상태에 시뮬레이션하므로
  enforcer의 revert가 `/verify`에서 나오고, 어차피 실패할 트랜잭션에 가스를 쓰지 않는다.
  판정은 배포된 enforcer 바이트코드가 실제 주기 카운터를 읽어 내리지만 — 블록이 아니라
  `eth_call`이다. 증거표는 [기술 문서](https://gitbook.mapae.io)에 있다.
- 회귀 검증: **468 TypeScript tests (shared/delegation/scripts 335 + MCP 3 + 콘솔 94 + 웹 36)
  + 14 Foundry tests**, 그리고 동일한 23개 caveat 케이스를 일회용 체인과 GIWA fork
  양쪽에서 돌리는 체인 파라미터화 negative-path 수트. 내역을 적는 이유는
  `bun run check`가 네 개의 숫자로 나눠 찍기 때문이다 — 합계 하나만 적으면 명령이
  실제로 보여주는 어떤 것과도 대조할 수 없다.

### 증명하지 않은 것

초록 체크를 늘리는 것보다 경계를 분명히 하는 편이 낫다.

- **회수는 GIWA에서 한 번도 실행된 적이 없다.** 아래 결과는 전부 로컬 fork에서 나온
  것이다 — 실제 배포 바이트코드, 실제 계정, 실제 EntryPoint를 쓰지만 채굴된 트랜잭션도
  익스플로러 링크도 없다. GIWA에서 payer 계정의 EntryPoint 예치금이 `0`이라, 라이브
  체인을 상대로는 콘솔의 회수 버튼이 누군가 예치하기 전까지 비활성으로 렌더된다.
  `DeleGatorCore.disableDelegation`은 `onlyEntryPointOrSelf`라 owner는 EntryPoint
  UserOperation으로 회수한다. 두 분기 모두 양쪽 수트 타깃에서 돈다 — *self*
  분기, 그리고 실제 owner 서명 UserOperation을 `handleOps`로 태우는 *EntryPoint*
  분기. 의존 요소가 실제로 작동함을 증명하는 대조군 3개가 함께 붙는다: 예치금이
  없으면 `AA21`, owner가 아닌 서명은 `AA24`, 서명된 `entryPoint` 필드를 변조하면
  `AA24`. 제출 엔드포인트(`apps/revocation-submitter`)가 생겼고 콘솔의 회수 버튼도
  거기에 연결됐다 — 연결 → 계정 `owner()` 대조 → 서명 → POST. 아직 증명하지 않은
  것은 마지막 한 뼘, **MetaMask가 그 9개 필드 구조체를 사람이 읽을 수 있게
  렌더링하는지**다. 이건 테스트가 아니라 실제 지갑을 실제 사람 앞에 띄워봐야 한다.
- **킬 스위치는 가스리스가 아니며, 미리 충전해두지 않으면 작동하지 않는다.**
  결제는 EntryPoint를 아예 거치지 않으므로(relayer가 `redeemDelegations`를 직접
  호출) 결제에 대한 payer의 zero-ETH 불변식은 그대로다. 회수는 EntryPoint를 피할
  수 없고, EntryPoint는 계정의 *예치금*에서 가스를 걷는다. 예치금이 없으면 회수는
  `AA21`로 실패한다. relayer가 `EntryPoint.depositTo(payerAccount)`로 채워줄 수
  있으며, 이때 payer의 ETH 잔액은 정확히 0으로 유지되고 relayer는 그 예치금을 다시
  회수할 수 없다. 프레임워크 전체 `DelegationManager.pause()`는 예치금이 필요 없다.
- **정산이 에이전트의 인내심보다 오래 걸릴 수 있고, 그때 답은 "모름"이다.**
  MCP 결제 루프를 fork가 아니라 GIWA에서 돌려서 찾았다. 결제 하나에 타임아웃 넷이 쌓이는데
  (facilitator 영수증 대기 → 판매자의 호출 → 판매자 HTTP idle → 에이전트 자신의 기한)
  순서가 거꾸로였다: `Bun.serve` 기본값 10초가 60초 영수증 대기 밑에 깔려 있었다.
  이체는 채굴됐고 에이전트는 거절됐다는 답을 받았다. 이제 예산이 바깥으로 갈수록
  길어지고(25 → 35 → 45 → 50초), 결과가 확정되지 않은 결제는 `PAYMENT_REJECTED`가
  아니라 `SETTLEMENT_UNKNOWN`을 돌려준다 — 둘은 정반대 대응을 부르고, 앞의 것을
  재시도하면 두 번 낼 수 있기 때문이다. fork는 즉시 채굴이라 로컬 테스트로는 절대
  나오지 않는다.
- **중복방지는 프로세스 내부에서만 보장된다.** 단일 replica에서는 올바르지만
  다중 replica 전에 영속 저장소로 옮겨야 한다.
- **실제 스테이블코인은 별도의 토큰 동작 검토가 필요하다.** MockUSDC는 테스트넷 rail이다.

## 빠른 시작

### 준비 사항

- [Bun](https://bun.sh/)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Docker Compose — x402 facilitator 실행 시
- Anvil — 로컬 Framework 통합 검증 시

### 설치 및 검증

```bash
git clone --recurse-submodules https://github.com/kooroot/Mapae.git
cd Mapae
bun install --frozen-lockfile
bun run check
```

`bun run check`는 전체 패키지의 strict TypeScript, 네 가지 상시 검사(문서·로깅·
의존성 권고·테스트 수치), shared/delegation 테스트, MCP 서버 스모크, 콘솔 렌더
테스트, 실제 콘솔 빌드, Foundry 테스트를 모두 실행합니다. 키는 필요 없습니다.
네트워크를 원하는 것은 권고 검사 하나뿐이고, 그것도 닿지 못하면 그렇다고 말하고
계속 갑니다.
같은 명령과 hermetic 23-case 위임 수트를 모든 pull request와 `main` push에서
GitHub Actions가 실행합니다. 재귀 submodule checkout 뒤 최근 전체 게이트 재검증에 사용한
Bun·Foundry 버전을 고정하므로, 로컬에서만 녹색인 상태를 완료로 세지 않습니다.

문서 검사를 게이트에 넣은 이유는 이 README가 시스템의 1차 설명이기 때문입니다 —
그러면 문서 부패가 정합성 버그가 됩니다. 코드 블록에 적힌 모든 `bun run`·`make`
명령이 실제로 존재하는지, 모든 상대 링크가 열리는지, 모든 주소가 두 정본(배포
아티팩트와 `packages/shared/src/token.ts`) 중 하나와 일치하는지 확인합니다. 첫
실행에서 MockUSDC 주소가 어떤 아티팩트에도 없다는 것이 드러났는데, 이 저장소는
그동안 반대로 적어두고 있었습니다.

위 배지의 테스트 수는 이 페이지의 다른 숫자가 아니라 **실제로 존재하는 테스트**와
대조합니다. 배지·총계·내역이 서로 맞는다는 것은 맞다는 뜻이 아니었습니다 — 손으로
고치면 셋이 함께 움직이기 때문이고, 실제로 수트가 자란 직후 적힌 수가 12개 모자란
채로 게이트는 "수치 확인됨"을 출력했습니다. 아무것도 매칭되지 않는 이름 필터로
`bun test`를 돌리면 파일을 전부 수집한 뒤 본문은 하나도 실행하지 않고 총계를
보고합니다. 컨트랙트 쪽은 `forge test --list`가 같은 일을 합니다.

권고 검사는 `bun audit`을 돌리고, 모든 발견을 **고치거나 근거를 붙여 명시적으로
수용**하도록 요구합니다. 현재 수용된 것은 하나입니다 — `@modelcontextprotocol/sdk`가
우리가 쓰지 않는 트랜스포트를 위해 끌어오는 HTTP 어댑터의 Windows 경로 traversal.
호환 업데이트로는 닫히지 않습니다(SDK가 `^1.19.9`를 선언하고 수정은 2.0.5에
들어갔습니다). 그래서 수용의 근거는 오직 "그 어댑터가 우리 번들에 들어오지
않는다"이고, 그것을 매 실행마다 다시 잽니다. 같은 측정이 먼저 컨트롤 파일 — 일부러
그 트랜스포트를 import하는 파일 — 을 찾아내야 합니다. 항상 0을 돌려주는 탐지기는
아무것도 증명하지 않은 채 검사를 통과시키기 때문입니다.

로깅 검사는 `console.*` 인자에 들어간 날것의 에러를 거절합니다. 로컬 fork에 쓰는
비공개 RPC 엔드포인트는 API 키를 URL **경로**에 실어 인증하고, viem은 모든 에러
메시지에 transport URL을 박아 넣습니다. 그래서 `console.error(error.message)`는
자격증명 노출입니다. 에러는 `redactForLog`를 통해서만 싱크에 닿고, 그 함수가 모든
URL을 `scheme://host`로 줄입니다. 이 규칙은 원래 리뷰로 지켜졌습니다 — 감사가 17개의
탈출 경로를 찾아 파일 단위로 고쳤지만, 그 스윕의 범위가 두 디렉터리였던 탓에
`apps/agent`는 금지된 표현을 그대로 통과시켰습니다. 새 코드가 계속 되살리는 규칙은
게이트에 있어야 합니다.

콘솔 빌드를 게이트에 넣은 이유는 타입 검사만으로는 못 잡기 때문입니다. `node:`
전용 import는 타입 검사를 멀쩡히 통과한 뒤 번들에서 깨지는데, 이는 브라우저
코드에서 서버 전용 모듈에 손을 뻗는 것과 같은 부류의 실수입니다.

### 한도가 결제를 거절하는 것을, 당신 것인 체인에서

우리 것이 하나도 없이 확인할 수 있는 가장 강한 결과입니다. 일회용 Anvil을 띄우고
고정된 38유닛 Framework와 MockUSDC를 거기 배포한 뒤, 배포된 enforcer 바이트코드를
상대로 23개 케이스를 돌립니다 — 주기 한도와 그 리셋, 만료, 재사용, 잘못된 redeemer,
수취인 바꿔치기, 침해된 facilitator가 이득을 볼 수 있는 여섯 가지 시도, 그리고
계정과 EntryPoint 양쪽을 통한 회수.

```bash
cd apps/delegation-lab
bun run test:negative
```

키도, 네트워크도, 우리 쪽 아티팩트도 필요 없습니다. 소유자·에이전트·매니저·자식
계정을 스스로 만들어 쓰고 기본 타깃이 hermetic입니다. Bun과 Foundry만 설치된
깨끗한 클론에서 실측했습니다 — `23/23 cases passed`, 종료 코드 0. 모든 거절이
enforcer 이름과 정확한 revert 문자열을 찍으므로, 무엇이 거절하는지가 주장이 아니라
읽히는 형태로 남습니다.

같은 23개 케이스를 **로컬 사본이 아니라 GIWA에 실제로 배포된 컨트랙트**를 상대로도
돌립니다:

```bash
SUITE_TARGET=fork bun run test:negative
```

이쪽은 GIWA RPC 엔드포인트가 필요하고 라이브 체인을 로컬로 fork합니다 —
브로드캐스트는 없습니다. 둘 중 더 강한 결과이고 이 저장소의 주장이 기대는 쪽입니다.
거절이 [docs/deployed-contracts.md](docs/deployed-contracts.md)의 주소에 놓인
enforcer 바이트코드에서, 실제 GIWA 상태를 읽고 나오기 때문입니다.
2026-07-26 실측 — 두 타깃 모두 `23/23 cases passed`, 종료 코드 0.

### 에이전트가 스스로 결제하고, 회수되는 것까지 한 명령으로

GIWA를 로컬로 fork하고 ERC-7710 facilitator와 seller를 그 fork에 붙인 뒤, MCP
서버에게 유료 리소스를 사게 하고, 이어서 권한을 회수해 같은 호출이 거절되는 것을
보여줍니다.

```bash
cd apps/delegation-lab
bun run test:e2e:mcp
```

**이건 클론에서는 돌지 않으며, 우회할 결함이 아닙니다.** 이 명령은 *이* 배포를
재생합니다 — `apps/delegation-lab/.env`와 `open-agent.permission.json`의 서명된 root
permission이 필요하고, 그 permission은 배포된 계정을 소유한 지갑만 만들 수 있습니다.
둘 다 gitignore이므로 신선한 클론은
`RELAYER_ADDRESS must be set (apps/delegation-lab/.env)`에서 멈춥니다. 준비 절차는
[`docs/giwa-demo-runbook.md`](docs/giwa-demo-runbook.md)에 있고, 직접 끝까지 몰아볼
결제 루프가 필요하면 위의 `test:negative`를 쓰세요 — 누구의 서명도 없이 같은 강제를
증명합니다.

중간에 한도로 감당할 수 없는 결제도 한 번 요청하는데, 에이전트는 서명하기 전에
enforcer 자신의 회계를 읽어 거절합니다 —
`payment of 2500000 exceeds 2000000 left in this period`.

이어서 두 정지 스위치를 바깥쪽부터 증명합니다. `DelegationManager`를 일시정지하면
— 프레임워크 전체를 멈추는 쪽 — facilitator가 정산 전에 거절하고, health 엔드포인트가
"불건전하다"가 아니라 **그 이유**를 보고합니다. 프레임워크를 되돌린 뒤 위임 하나를
회수하면 같은 호출이 다시 거절되므로, 두 증명이 서로를 가리지 않습니다.

GIWA에는 아무것도 닿지 않습니다. 자식 프로세스가 loopback RPC에 고정되지 않으면
스크립트가 시작조차 하지 않고, 끝난 뒤 실제 relayer nonce가 그대로인지 다시
읽어 확인합니다.

### 콘솔 실행

```bash
cd apps/console
VITE_RPC_URL=http://127.0.0.1:8546 \
VITE_PERMISSION_CONTEXT=0x… \
bun run dev
```

화면 두 개 — 각인된 한도와 남은 주기 잔액, 그리고 정산 영수증. 영수증은
enforcer 자신의 `TransferredInPeriod` 이벤트에서 읽으므로 별도 원장도 계정
체계도 없습니다. 지갑 연결이 곧 유일한 신원입니다.

### 로컬 Delegation Framework 시나리오 실행

터미널 1:

```bash
anvil --silent --chain-id 31337 --port 8545
```

터미널 2:

```bash
cd contracts
forge build

cd ../apps/delegation-lab
bun run test:local
```

이 시나리오는 공식 MetaMask Delegation Framework를 로컬 Anvil에 배포한 뒤
다음을 실제 EVM에서 검증합니다.

1. 3 mUSDC 주기 한도 안의 결제 3건 성공
2. 같은 주기의 추가 결제 거절
3. 고정 vendor가 아닌 수취인 거절

## 구성

실제 사용자 주소나 키는 소스에 하드코딩하지 않습니다.

```bash
cp apps/delegation-lab/.env.example apps/delegation-lab/.env
```

| 변수 | 역할 |
|---|---|
| `CASE_1_OWNER_ADDRESS` | Case 1 owner, owner 스마트계정과 root delegation 제어 |
| `CASE_2_VENDOR_ADDRESS` | Case 2 vendor 정책의 고정 수취인 |
| `FRAMEWORK_ADMIN_ADDRESS` | DelegationManager ownership·pause 관리 |
| `DEPLOYER_ADDRESS` | Framework·owner account 배포 signer의 기대 주소 |
| `RELAYER_ADDRESS` | 정산 relayer 기대 주소, Framework 배포에는 사용하지 않음 |

Deployer·relayer·Framework admin·세 데모 case identity는 모두 별도 역할입니다.
개인키에서 파생된 주소가 설정한 공개주소와 다르면 broadcast 전에 중단합니다.

`.env`, `.secrets`, 배포 broadcast, permission artifact는 Git에서 제외됩니다.
세션 생성은 출력을 의도적으로 나눕니다 — 개인키는 `.secrets/`로 가고, 짝이 되는
공개주소는 `deployments/d3-session-addresses.json`으로 들어갑니다. 그래야
`docs/deployed-contracts.md`가 모든 클론에서 정본을 갖습니다. 예제 파일에는
fixture 값만 들어 있습니다.

## 보안 모델

### 침해된 facilitator가 할 수 있는 것

facilitator는 릴레이어 키를 쥐고, 서명된 `Payment-Signature`를 받고, leaf가 지정한 redeemer
본인입니다 — 모든 신원 검사를 통과하는 위치입니다. 그러므로 물어야 할 것은 신뢰
여부가 아니라 **완전히 침해되었을 때의 최대 피해**입니다.

서명은 permission context를 덮지만 **execution은 덮지 않습니다.**
`redeemDelegations`는 `_executionCallDatas`를 호출자의 calldata로 받습니다
(`DelegationManager.sol:126-133`). 즉 침해된 facilitator는 멀쩡한 leaf와 함께 자기가
고른 아무 execution이나 제출할 수 있고, 이를 막는 것은 그 leaf의 caveat뿐입니다.
그리고 실제로 막힙니다.

| 시도 | 거절하는 enforcer | 온체인 revert |
|---|---|---|
| 벤더 대신 자기 주소로 지급 | `AllowedCalldataEnforcer` | `invalid-calldata` |
| 금액 부풀리기 (주기 상한 이내라도) | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |
| 1회성 지불을 상시 allowance로 전환 | `ERC20TransferAmountEnforcer` | `invalid-method` |
| 다른 컨트랙트로 호출 돌리기 | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| native 값 끼워 빼내기 | `ValueLteEnforcer` | `value-too-high` |
| **payer 계정 자신을 target으로** (self 분기 진입) | `ERC20TransferAmountEnforcer` | `invalid-contract` |
| 같은 leaf 재상환 | `ERC20TransferAmountEnforcer` | `allowance-exceeded` |

남는 것은 안전성이 아니라 가용성입니다 — 정산을 거부하거나, 만료 창 안에서 순서를
바꾸거나, 지불자가 이미 승인한 결제를 집행할 수 있습니다. 다만 수취인은 언제나
에이전트가 고정한 벤더이고 자기 자신이 될 수 없습니다. **탈취·경로 변경·한도 초과는
불가능합니다.** 릴레이어에게 가스는 맡기되 자금은 맡기지 않는 구조의 값이 여기 있습니다.

각 행은 `negative-path-suite.ts`의 케이스이며, 6개 변조 케이스에는 대조군이
붙어 있습니다 — 같은 leaf·같은 redeemer로 변조만 뺀 execution은 정상 정산됩니다.
소진된 주기나 낡은 계정 때문이 아니라 변조 때문에 거절되었음을 이 대조군이 보장합니다.

### 결제 바인딩

- facilitator는 서명된 `permissionContext`의 마지막/root delegator를
  canonical payer로 사용합니다.
- 별도 wire field인 `payload.delegator`가 signed root와 다르면 거절합니다.
- 중복방지 키 `paymentIntentId`는 JSON 문자열이 아니라 network, asset,
  amount, payTo, manager, permission-context byte hash를 ABI 인코딩해 생성합니다.
- 동일 intent의 동시 정산 요청은 single-flight로 한 번만 실행합니다.
- permission context와 결제 서명은 bearer authorization으로 취급해 로그에
  남기지 않습니다.
- facilitator는 loopback 또는 사설망에서만 운영하고 요청 크기·gas·금액
  상한을 적용합니다.

현재 프로세스 내 중복방지는 안전하지만, 재시작과 다중 replica를 넘는
idempotency는 제품화 전에 Redis/Postgres 같은 영속 저장소로 이전해야 합니다.

위협 모델과 온체인 보안 설계는 [기술 문서](https://gitbook.mapae.io)에 정리되어 있습니다.

## GIWA 연동

| 항목 | 값 |
|---|---|
| Network | GIWA Sepolia |
| Chain ID | `91342` |
| CAIP-2 | `eip155:91342` |
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |
| EntryPoint | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

Mapae의 기본 MVP는 누구나 사용할 수 있는 무허가 결제 경로입니다.
향후 검증형 B2B 경로에서는 GIWA의
[Dojang](https://github.com/giwa-io/dojang) `Verified Address` attestation을
선택적 KYC 게이트로 결합합니다. Dojang은 현재 결제 경로에 아직
통합되어 있지 않습니다.

## 저장소 구조

```text
contracts/                 MockUSDC + exact Framework Forge 배포
facilitator/               x402-rs GIWA configuration
packages/shared/           chain, token, x402 v2 types, error model
packages/delegation/       policies, signing, revocation, ERC-7710 boundary
apps/agent/                EIP-3009 payer agent
apps/seller/               EIP-3009 x402 seller
apps/delegation-lab/       policy scenarios and deployment previews
apps/delegated-agent/      ERC-7710 payment agent
apps/delegated-seller/     ERC-7710 resource seller
apps/facilitator-erc7710/  delegated settlement adapter
apps/agent-mcp/            요청 시 리소스를 결제하는 MCP 서버
apps/revocation-submitter/ 서명된 회수를 실어 나르는 loopback 엔드포인트
apps/console/              위임·영수증 화면, 지갑 모듈 크기
apps/web/                  공개 랜딩(mapae.io)과 Studio(app.mapae.io)
docs/                      기술 노트와 배포 컨트랙트 레퍼런스
```

## 문서

- [mapae.io](https://mapae.io) — 온체인 증거를 담은 라이브 랜딩
- [app.mapae.io](https://app.mapae.io) — Studio: 위임 발급·조회·회수
- [기술 문서](https://gitbook.mapae.io)
- [MCP 가이드](docs/mcp-guide.md) — 결제 서버를 MCP 클라이언트에 등록하는 절차
- [회수 런북](docs/revocation-runbook.md) — 킬 스위치와 그 검증 방법
- [배포된 컨트랙트](docs/deployed-contracts.md)

## 배포 안전장치

기본 명령은 배포 preview만 수행합니다. Framework·owner account 배포와 ownership
수락은 `--broadcast`와 배포 대상 조합에 묶인 승인 문구를 함께 요구합니다.
MockUSDC 배포와 `run:giwa` 정산은 `--broadcast` 하나로 게이트되는데, 정산은
온체인 caveat이 한도를 쥐고 있고 인프라 배포는 그렇지 않기 때문입니다. 활성화
단계마다 별도 승인을 거칩니다.

이 저장소에서 재현 가능한 것은 전부 일회용 체인이나 로컬 fork에서 돌아갑니다.
end-to-end 스크립트는 자식 프로세스가 loopback 노드가 아닌 곳과 통신하려 하면
시작하지 않습니다 — 같은 명령을 실제 RPC로 겨누면 진짜 정산이 나가기 때문입니다.
`apps/delegation-lab`의 배포 도구는 정반대 이유로 HTTPS 전용 규칙을 더 엄격히
유지합니다. 그것들은 GIWA에 닿는 것이 목적이므로 fork를 겨눠서는 안 됩니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참조. `contracts/lib/` 아래 submodule은 각 업스트림
프로젝트의 라이선스를 따릅니다.
