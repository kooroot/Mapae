# 마패 인프라 지도 — 머신 · 서비스 · 지갑 · 흐름

이 문서는 한 가지 질문에 답한다: **어떤 지갑이 어디에 있고, 어떤 서비스가 무엇을
하며, 누가 가스를 내는가.** 지갑 변수명은 전역 규약을 따른다 — 지갑 하나에 이름
하나, 어느 파일에서든 같은 이름은 같은 지갑이다.

주소·포트·경로는 전부 이 저장소와 GIWA 체인에 이미 공개된 값이다. 상태 표기는
2026-08-04 기준이다.

---

## 0. 세 줄 정신 모델

1. **가스를 내는 지갑은 운영 지갑 5개뿐이고, 서로 절대 겹치면 안 된다.**
   겹치는 순간 한쪽 장애가 다른 쪽 장애가 된다 — 그래서 코드가 부팅 시점에 거부한다.
2. **사용자 쪽 세 identity(오너 지갑, payer 스마트계정, 에이전트 세션키)는 가스를
   한 푼도 내지 않는다.** 그게 제품이다. payer 계정의 ETH 잔액은 설계상 정확히 0이다.
3. **지갑 하나 = 변수명 하나, 어느 파일에서든 동일.** `FACILITATOR_SIGNER_ADDRESS`는
   어디에 적혀 있든 정산 서명자이고, `REVOCATION_RELAYER_ADDRESS`는 어디서든 서브미터의
   발신 지갑이다. 서비스마다 뜻이 바뀌는 상대적 이름은 쓰지 않는다.

---

## 1. 전체 토폴로지

네 개 층이다: 사용자 → Cloudflare 엣지 → 맥미니(운영) → GIWA 체인.
맥북은 개발·배포 전용이고 운영 트래픽을 받지 않는다.

```mermaid
flowchart TB
    subgraph USER["사용자 층"]
        BROWSER["브라우저 — Studio<br/>세션키 생성·grant 서명·회수 버튼"]
        WALLET["오너 지갑<br/>MetaMask / Rabby"]
        AGENT["AI 에이전트<br/>MCP mapae_pay_for_resource"]
    end

    subgraph EDGE["Cloudflare 엣지"]
        LANDING["Worker mapae<br/>mapae.io 랜딩"]
        APP["Worker mapae-app<br/>app.mapae.io Studio"]
        DOCS["gitbook.mapae.io<br/>기술 문서"]
        TUNNEL["Tunnel mapae<br/>facilitator.mapae.io<br/>seller.mapae.io"]
    end

    subgraph MINI["맥미니 — 상시 운영, 전부 loopback 바인딩"]
        CFD["cloudflared<br/>경로 규칙 라우팅"]
        FAC["apps/facilitator-erc7710 :8081<br/>x402 검증·정산"]
        SELLER["apps/delegated-seller :3001<br/>402 발행, 데모 벤더"]
        BOOT["apps/account-bootstrap :8083<br/>계정 배포 대납"]
        REVO["apps/revocation-submitter :8082<br/>회수 대납 — 라이브"]
    end

    subgraph CHAIN["GIWA Sepolia — eip155:91342"]
        USDC["MockUSDC"]
        DM["DelegationManager<br/>+ 32 caveat enforcers"]
        EP["EntryPoint v0.7"]
        PAYER["payer 스마트계정들<br/>HybridDeleGator, ETH 0"]
    end

    BROWSER --> APP
    WALLET -.서명만.- BROWSER
    AGENT -->|"402 → Payment-Signature"| TUNNEL
    BROWSER -->|"/bootstrap · /revoke"| TUNNEL
    TUNNEL --> CFD
    CFD -->|"path ^/bootstrap"| BOOT
    CFD -->|"path ^/revoke"| REVO
    CFD -->|"facilitator.mapae.io 나머지"| FAC
    CFD -->|"seller.mapae.io"| SELLER
    SELLER -->|"loopback /verify /settle"| FAC
    FAC -->|"redeemDelegations"| DM
    DM --> USDC
    BOOT -->|"CREATE2 배포"| PAYER
    REVO -->|"depositTo + handleOps"| EP
    EP -->|"disableDelegation"| DM
```

맥북(개발 전용)에는 그림에 없는 세 가지가 더 있다: x402-rs Rust 컨테이너(:8080,
D1–D2 EOA 흐름 개발용), 콘솔(:5173, loopback 전용 핀 모드 UI), delegation-lab
(fork 시뮬레이션·e2e). 어느 것도 운영 트래픽을 받지 않는다.

---

## 2. 서비스는 각자 무엇을 하나

| 서비스 | 머신 | 포트 | 공개 경로 | 쓰는 지갑 | 한 줄 역할 |
|---|---|---|---|---|---|
| `apps/facilitator-erc7710` | 미니 | 8081 | `facilitator.mapae.io` | **정산 서명자** | ERC-7710 결제를 검증하고 `redeemDelegations`로 정산. 가스를 대신 낸다 |
| `apps/delegated-seller` | 미니 | 3001 | `seller.mapae.io` | 없음 (`PAY_TO` 주소만) | 402를 발행하고 리소스를 게이트. 받기만 하므로 키가 없다 |
| `apps/account-bootstrap` | 미니 | 8083 | `facilitator.mapae.io/bootstrap` | **부트스트랩 스폰서** | 서명만 있고 배포 안 된 payer 계정을 스폰서 가스로 배포 |
| `apps/revocation-submitter` | 미니 | 8082 | `facilitator.mapae.io/revoke` (라이브, 2026-08-04) | **서브미터 릴레이어 + 회수 스폰서** | 오너가 서명한 회수 UserOp을 EntryPoint에 실어 보낸다 |
| Worker `mapae` / `mapae-app` | Cloudflare | — | `mapae.io` / `app.mapae.io` | 없음 | 랜딩 / Studio. 브라우저 코드만 서빙, 키 없음 |

같은 도메인(`facilitator.mapae.io`) 아래 세 서비스가 사는 이유: cloudflared가
**경로 규칙**으로 가른다. `^/bootstrap` → 8083, `^/revoke` → 8082, 나머지 → 8081.
경로 규칙이 호스트 전역 규칙보다 위에 있어야 하고, 경로는 그대로 전달되므로 각
서비스의 `/health`는 밖에서 닿지 않는다.

---

## 3. 지갑 지도

### 3.1 그림 — 누가 어디서 체인에 브로드캐스트하나

```mermaid
flowchart LR
    subgraph OPS["운영 지갑 5개 — 가스를 낸다, 절대 서로 겹치지 않는다"]
        DEPLOYER["① Deployer<br/>0x5Ea1FB5f…c0DE<br/>contracts/.env"]
        FACSIGNER["② 정산 서명자<br/>0x5eA109ED…E7eC<br/>facilitator-erc7710/.env"]
        BOOTSP["③ 부트스트랩 스폰서<br/>0x11E188f7…3211<br/>account-bootstrap/.env"]
        SUBREL["④ 서브미터 릴레이어<br/>신규 생성 — 배선 중<br/>revocation-submitter/.env"]
        REVSP["⑤ 회수 스폰서<br/>신규 생성 — 배선 중<br/>revocation-submitter/.env"]
    end

    subgraph USERSIDE["사용자 쪽 — 가스 0"]
        OWNER["오너 EOA<br/>지갑 앱에만 존재"]
        PAYERACC["payer 스마트계정<br/>0xA4e4d00E…F382 등<br/>ETH 잔액 0"]
        SESSION["에이전트 세션키<br/>브라우저 탭에서 생성<br/>서버에 전송 안 됨"]
    end

    RECV["수취 주소 PAY_TO<br/>키 없음, 주소만"]

    DEPLOYER -->|"컨트랙트 배포 — 완료"| C1["GIWA"]
    FACSIGNER -->|"결제 정산 tx"| C1
    BOOTSP -->|"계정 배포 tx"| C1
    SUBREL -->|"handleOps tx"| C1
    REVSP -->|"depositTo tx"| C1
    OWNER -.->|"서명만 — tx 없음"| PAYERACC
    SESSION -.->|"서명만 — tx 없음"| C1
    C1 -->|"mUSDC 입금"| RECV
```

### 3.2 표 — 일곱 지갑, 키가 사는 곳

| # | 역할 | 주소 | 키 위치 | 가스 | 겹치면 무엇이 죽나 |
|---|---|---|---|---|---|
| ① | Deployer | `0x5Ea1FB5f222572c03220356cb2914Da2b5acc0DE` | `contracts/.env` `PRIVATE_KEY` | 냈음 (배포 완료) | 정산 (nonce 충돌) |
| ② | 정산 서명자 | `0x5eA109EDC7E89b6A752032Aa2B6F1092e081E7eC` | `apps/facilitator-erc7710/.env` — 맥북·미니 같은 값이라 **동시 1인스턴스만** | **낸다** | 모든 결제 |
| ③ | 부트스트랩 스폰서 | `0x11E188f7E5beea0BdE3016D0dcCB2b91226c3211` | `apps/account-bootstrap/.env` `BOOTSTRAP_PRIVATE_KEY` | **낸다** | 온보딩 + 잔고 합쳐짐 |
| ④ | 서브미터 릴레이어 | `0x226B24364e573162Fa68fB0752748B5eE6312822` | `apps/revocation-submitter/.env` `REVOCATION_RELAYER_PRIVATE_KEY` | **낸다** | ②와 겹치면 정산이 죽는다 |
| ⑤ | 회수 스폰서 | `0x3306EC395Aefa0c0d78d10fCFB45c4390a8eDB33` | `apps/revocation-submitter/.env` `REVOCATION_SPONSOR_PRIVATE_KEY` | **낸다** | ④와 겹치면 자력 회수까지 죽는다 |
| ⑥ | Payer 스마트계정 | `0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382` 등 | **키 없음** — 오너가 지갑에서 서명 | **0** | — |
| ⑦ | 수취 (`PAY_TO`) | 벤더별 | **키 없음** — 주소만 | — | — |

에이전트 세션키는 표 밖이다: Studio가 브라우저 탭 메모리에서 만들고, 서버에
전송되지 않으며, 온체인 caveat(기간 한도·만료) 안에서만 유효하다. 유출돼도
피해 상한이 caveat이다.

### 3.3 명명 규약 — 지갑 하나, 이름 하나

| 변수명 | 지갑 | 키가 있는 곳 | 참조(주소만)로 쓰는 곳 |
|---|---|---|---|
| `FACILITATOR_SIGNER_*` | ② | `apps/facilitator-erc7710/.env` | 부트스트랩·서브미터 (충돌 검사) |
| `BOOTSTRAP_*` | ③ | `apps/account-bootstrap/.env` | 서브미터 (충돌 검사) |
| `REVOCATION_RELAYER_*` | ④ | `apps/revocation-submitter/.env` | — |
| `REVOCATION_SPONSOR_*` | ⑤ | `apps/revocation-submitter/.env` | 부트스트랩 (충돌 검사) |
| `DEPLOYER_ADDRESS` | ① | `contracts/.env` (`PRIVATE_KEY`) | 부트스트랩·서브미터 (충돌 검사) |

과거에는 `RELAYER_ADDRESS`라는 이름이 세 서비스에서 세 지갑을 가리켰고, 부트스트랩
`.env`의 정산 서명자 *참조*를 서브미터의 *발신 지갑*으로 읽는 실수가 실제로
일어났다. 지금은 이름 자체가 지갑을 특정하고, 두 가지가 그 실수를 코드로 막는다:
라이브 서비스에서 옛 철자는 경고와 함께 읽히다 값이 갈리면 부팅이 거부되고,
서브미터에서는 옛 철자가 보이기만 해도 부팅이 거부된다.

### 3.4 왜 절대 겹치면 안 되나 — 서로 다른 두 위험

- **프로세스 사이: nonce 공간.** 두 프로세스가 한 주소로 브로드캐스트하면 둘 다
  `eth_getTransactionCount(pending)`에서 nonce를 채우다 충돌한다. 프로세스가 다르면
  어떤 라이브러리도 이를 조정해 줄 수 없다. ②를 ④로 재사용하면 죽는 것은 회수가
  아니라 **정산**이고, 장애가 반대편에 나타나므로 원인을 찾기 어렵다.
- **한 프로세스 안: 잔고.** viem의 공유 nonceManager는 같은 키로 만든 두 계정도
  직렬화한다(실측: 동시 8건 8/8, 관리 없는 대조군 1/8). 그래서 ④·⑤를 가르는 이유는
  nonce가 아니라 **자금이 합쳐지는 것**이다. 예치금을 스스로 채운 계정은 스폰서
  없이도 회수할 수 있는데(아래 4.3), 키를 합치면 스폰서 예산을 노린 공격이 그
  자력 경로까지 무장해제한다.

---

## 4. 세 가지 흐름

### 4.1 결제 — 에이전트가 한도 안에서 지불한다

```mermaid
sequenceDiagram
    participant A as 에이전트 (세션키)
    participant S as delegated-seller
    participant F as facilitator-erc7710
    participant D as DelegationManager

    A->>S: GET /deliverable
    S-->>A: 402 + Payment-Required 헤더
    A->>A: 부모 permission에서 결제 전용 leaf 서명
    A->>S: Payment-Signature
    S->>F: /verify → /settle
    F->>D: redeemDelegations (가스: ②)
    D->>D: enforcer가 기간 한도·만료 검사 — 온체인
    D-->>F: mUSDC 이동: payer 계정 → PAY_TO
    S-->>A: 200 + 리소스 + 영수증
```

한도를 넘거나 만료된 결제는 백엔드가 아니라 **enforcer 컨트랙트가** 거부한다.
그 대체가 제품의 핵심 주장이다.

### 4.2 온보딩 — 지갑에 ETH 없이 계정을 갖는다

```mermaid
sequenceDiagram
    participant B as 브라우저 (Studio)
    participant O as 오너 지갑
    participant BS as account-bootstrap
    participant C as GIWA

    B->>O: 아직 배포 안 된 계정 주소에 대해 root 서명 요청
    O-->>B: 서명 (tx 아님, 가스 0)
    B->>BS: POST /bootstrap { permissionContext }
    BS->>BS: 서명에서 오너 복원 → CREATE2 주소 일치 확인
    BS->>C: 계정 배포 + mUSDC 민팅 (가스: ③)
    C-->>BS: 배포 후 ERC-1271이 그 서명을 소급 검증
    BS-->>B: 계정 주소 + 영수증
```

배포 전에 한 서명이 배포 후에 유효해지는 것(late binding)이 이 흐름의 기둥이다.
요청 본문이 `permissionContext` 하나뿐인 것도 설계다 — 오너·salt를 받으면 아무나
남의 계정 배포 비용을 우리에게 물릴 수 있다.

### 4.3 회수 — 킬 스위치, 두 등급

```mermaid
sequenceDiagram
    participant B as 브라우저 (Studio)
    participant O as 오너 지갑
    participant R as revocation-submitter
    participant E as EntryPoint
    participant D as DelegationManager

    B->>O: 회수 UserOperation 서명 요청
    O-->>B: 서명 (tx 아님, 가스 0)
    B->>R: POST /revoke
    R->>R: 이미 회수됐나 → eth_call 2회로 서명 검증 → rate limit
    R->>E: 부족분만 depositTo (가스: ⑤)
    R->>E: handleOps (가스: ④, 예치금에서 상환)
    E->>D: disableDelegation
    D-->>E: 이후 이 위임의 모든 결제 차단
    E-->>B: 남은 선납분은 payer 계정 예치금으로 환급
```

두 등급이 있다:

- **계정이 예치금을 미리 채운 경우 — 검열 불가.** `handleOps`는 누구나 부를 수 있고
  EntryPoint가 실행자에게 예치금에서 지급하므로, 채워진 예치금은 공개 현상금이다.
  우리 서비스가 전부 꺼져도 제3자가 대신 실어 보내면 회수는 성사된다.
- **스폰서가 회수 시점에 채우는 경우(공개 `/revoke`) — 우리 가용성에 의존.**
  ETH가 전혀 없는 스폰서드 온보딩 계정을 위한 경로다. 실가치를 태우는 위임이라면
  소유자가 자기 예치금을 직접 채워 첫 등급으로 올라가는 것이 맞다.

---

## 5. 더 읽기

- 흐름별 근거와 반례표 — [기술 노트](tech-notes.md)
- 배포된 모든 컨트랙트 주소 — [deployed-contracts](deployed-contracts.md)
- 회수를 로컬에서 완주해 보기 — [회수 런북](revocation-runbook.md)
