# Mapae — 마패

> 마패는 특권의 증표가 아니라 한계의 증표다.
> 새겨진 말의 수는 쓸 수 있는 권한이 아니라, 그 권한이 끝나는 지점이었다.

[English edition →](README.md)

**AI 에이전트에게 지갑이 아니라 온체인 한도를 준다.** Mapae는 GIWA Chain 위에서
에이전트가 위임받은 한도 안에서만 스스로 결제하게 하는 에이전틱 페이먼트
인프라다. 소유자는 자금을 스마트계정에 두고 금액·주기·수취인·만료가 새겨진
권한 하나를 서명해 넘긴다. 에이전트의 세션키가 할 수 있는 일은 정확히 그
권한이 끝나는 지점까지다. 계정이 아직 없어도 시작할 수 있다 — 서명을 먼저
하면 스폰서가 그 계정을 대신 배포하고, 사용자는 어느 단계에서도 ETH를 들지
않는다.

## 세 가지 주장

1. **한도는 코드의 약속이 아니라 배포된 컨트랙트가 강제하는 사실이다.**
   주기 한도·만료·수취인 고정은 백엔드 검사가 아니라 온체인 caveat enforcer가
   판정한다. 백엔드를 통째로 바꿔치기해도 한도는 그대로다.
2. **지불자는 가스를 내지 않는다.** 지불자 스마트계정의 ETH 잔액은 설계상 0이고,
   트랜잭션은 facilitator의 릴레이어가 브로드캐스트한다. 릴레이어가 완전히
   침해되어도 자금 탈취·경로 변경·한도 초과는 불가능하다 —
   [4. 보안 고려](tech/04-security.md)가 그 경계를 케이스로 증명한다.
3. **거절도 증거다.** 한도를 넘긴 결제와 만료된 권한은 정산 전에 거절되고,
   그 거절 사유는 enforcer가 돌려준 revert 문자열 그대로 기록된다.

## 증거 — GIWA Sepolia

`채굴됨`은 블록에 들어가 익스플로러에서 열리는 트랜잭션이고, `시뮬레이션`은
GIWA의 현재 상태를 상대로 한 `eth_call`이다. 거절에 해시가 없는 것은 빈틈이
아니라 설계다 — facilitator가 시뮬레이션으로 먼저 걸러내므로 어차피 revert할
트랜잭션에 가스를 쓰지 않는다.

| 경로 | 결과 | 증거 수준 | 증거 |
|---|---|---|---|
| 위임 결제 1 mUSDC | 정산, 지불자 가스 0 | 채굴됨 | [`0xe897fe55…a97d`](https://sepolia-explorer.giwa.io/tx/0xe897fe55048b91c0f6728d0af313e30db2b425af8955ee89f7174a16c6aaa97d) |
| 위임 결제 2.5 mUSDC | 정산 | 채굴됨 | [`0x71d71442…6ce4`](https://sepolia-explorer.giwa.io/tx/0x71d7144213a04ae7b463f1c0e2b021c672938f10c7d92d5d4fe367e532f46ce4) |
| MCP tool 1회 — 사람 개입 없음 | 정산, 지불자 가스 0 | 채굴됨 | [`0x533c5cb2…964c`](https://sepolia-explorer.giwa.io/tx/0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c) |
| 주기 한도 초과 결제 | 거절, 자금 불변 | 시뮬레이션 | `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` |
| 만료된 권한으로 결제 | 거절 | 시뮬레이션 | `TimestampEnforcer:expired-delegation` |
| 스폰서드 온보딩 — 배포 전 서명으로 계정 배포 | 배포, 새 사용자 가스 0 | 채굴됨 | [`0xed21ac71…9902`](https://sepolia-explorer.giwa.io/tx/0xed21ac71881cc587cc742862fea9ce16e5d2a09370a3516118884c66e1599902) |
| 스폰서드 온보딩 — mUSDC 플로트 | 3 mUSDC 민팅 | 채굴됨 | [`0x9d14588b…baa0`](https://sepolia-explorer.giwa.io/tx/0x9d14588b8bc3e72851b320036696493f668a7675f664b5b812737540a373baa0) |

전체 증거표와 시퀀스는 [2. 결제 흐름](tech/02-payment-flows.md), 배포·검증된
컨트랙트 목록은 [배포 컨트랙트](deployed-contracts.md)에 있다.

## 직접 확인하기

이 문서의 수치는 아래 명령으로 직접 재현할 수 있다.

```bash
bun run check                # 키·네트워크 없이 전 계층 회귀 + 문서 게이트
cd apps/delegation-lab
bun run test:negative        # 일회용 체인에 프레임워크를 직접 배포해 거절 케이스를 실행
```

`test:negative`는 키도, 네트워크도, 별도 배포 아티팩트도 필요 없다 — 깨끗한
클론에서 Bun과 Foundry만으로 돈다. 케이스 개수는 수트가 스스로 세어 출력한다.

에이전트에 직접 물려 보려면 [MCP 연결 가이드](mcp-guide.md)를 따른다.
자기 계정을 직접 만들어 보려면 [app.mapae.io](https://app.mapae.io)가 가장
짧은 경로다 — 서명 한 번이면 스폰서가 계정을 배포한다.

## 읽는 순서

| 장 | 내용 |
|---|---|
| [1. 시스템 구성](tech/01-architecture.md) | 컴포넌트와 언어 선택 근거 |
| [2. 결제 흐름](tech/02-payment-flows.md) | 직접 결제, 위임 결제, MCP 자동화, Studio와 회수 — 증거표 포함 |
| [3. 에러 모델](tech/03-error-model.md) | 실패 분류와 사유 반환 정책 |
| [4. 보안 고려](tech/04-security.md) | facilitator 신뢰 경계 — 침해 시 최대 피해의 상한 |
| [5. 확인된 온체인 환경](tech/05-onchain-environment.md) | 직접 읽어 확인한 주소만 담은 표 |
| [6. 검증 상태와 로드맵](tech/06-roadmap.md) | 검증 수준별 현재 상태와 향후 계획 |

공개 문서: [docs.mapae.io](https://docs.mapae.io) ·
저장소: [github.com/kooroot/Mapae](https://github.com/kooroot/Mapae) ·
원문 단일 문서: [tech-notes.md](https://github.com/kooroot/Mapae/blob/main/docs/tech-notes.md)
