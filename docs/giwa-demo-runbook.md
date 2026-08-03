# GIWA 실행 런북 — MCP 결제 1건

에이전트가 GIWA Sepolia에서 스스로 결제하는 것을 증명하는 절차. fork가 아니라 실제 체인이다.

> **이 문서의 마지막 단계는 실제 브로드캐스트다.** 실제 브로드캐스트는 매번
> 명시적 승인을 전제로 하며, 승인이 코드에 도달하는 지점은 `--broadcast` 플래그
> 하나다.

---

## 0. 명령별 증명 범위

| 명령 | 실제 체인 접근 | 증명 대상 |
|---|---|---|
| `forge test` | ❌ | 컨트랙트 로직. 로컬 EVM에서 새로 배포해서 검사 |
| `forge test --fork-url giwa_sepolia` | 베이스 상태만 | **배포된 컨트랙트에 대해서는 아무것도.** 테스트가 fork 안에 자기 사본을 새로 배포한다 |
| `make framework-test` | ❌ | 38유닛 **구성과 배선** — 개수·2단계 소유권·enforcer 상호 링크. 로컬 EVM에 새로 배포한다 |
| `bun run verify:framework` | ✅ | 38개 유닛의 **라이브 런타임 바이트코드**와 CREATE 주소 일치 |
| `make owner-account-verify` | ✅ | owner 스마트계정이 실제로 배포돼 있고 owner가 맞음 |
| `bun run preflight:giwa` | ✅ | 결제 한 건이 성공할 조건 전부 (개수는 스크립트가 센다 — 3절) |
| `bun run run:giwa -- --broadcast` | ✅ **쓰기** | 에이전트가 GIWA에서 실제로 결제함 |
| `bun run test:e2e:bootstrap` | fork | 온보딩 서비스 15케이스 — 배포·late binding·그리핑 방어. 최근 블록을 `SUITE_FORK_BLOCK`으로 요구 |

`forge test --fork-url`의 함정은 조용하다는 것이다. 통과하고, 주소를 출력하고, 그 주소는
실제 GIWA 주소가 아니다 — fork 안에서 방금 만들어진 것이다. 라이브 배포를 검사하는 것은
`verify:framework` 쪽이다.

**`make framework-test`는 같은 함정의 더 큰 판본이다.** 통과하면서 38줄짜리 주소 표를
출력하는데, 그것은 배포 보고서처럼 읽히지만 배포 보고서가 아니다. 실측하면 **38개 중 0개**가
GIWA 주소와 일치한다(예: `SimpleFactory` 로컬 `0x104fBc01…`, GIWA `0xbED01c51…`). 테스트가
자기 배포자로 새 체인에 배포하므로 CREATE 주소가 다를 수밖에 없다 — 그리고 그 테스트는
주소를 주장하지도 않는다. 주장하는 것은 구성이다: 유닛 38개, `pendingOwner`→`owner`
2단계 이양, `NativeTokenPaymentEnforcer`가 실제 `DelegationManager`를 가리키는지,
DeleGator 구현들이 같은 manager와 canonical EntryPoint를 물고 있는지, Hybrid가 SCL을
링크하는지. 주소를 GIWA와 대조하는 것은 `verify:framework` 하나뿐이다.

---

## 1. 사전 조건

- `apps/facilitator-erc7710/.env` — `RELAYER_PRIVATE_KEY` (가스 지불), `RELAYER_ADDRESS`
- `apps/delegated-seller/.env` — `PAY_TO` (공개 주소)
- `apps/delegated-agent/.env` — `AGENT_PRIVATE_KEY` (세션키), `PARENT_PERMISSION_CONTEXT_PATH`
- 서명된 root permission이 유효창 안에 있을 것
- payer 스마트계정에 mUSDC, relayer에 GIWA ETH — 이 런북은 이미 배포된 데모
  payer를 전제한다. 새 payer 계정이 필요하면 스폰서드 온보딩(app.mapae.io)이
  배포와 mUSDC 플로트를 대신한다

**payer는 ETH를 0으로 유지한다.** 가스리스가 데모의 중심 주장이고, 실행 스크립트가 그것을
사후에 대조한다.

## 2. 서비스 기동

두 프로세스를 각각 띄운다. 각자 자기 `.env`를 읽고, 그 안의 `GIWA_SEPOLIA_RPC_URL`이
실제 GIWA를 가리킨다.

```bash
cd apps/facilitator-erc7710 && bun run index.ts
cd apps/delegated-seller    && bun run index.ts
```

기동 자체는 브로드캐스트가 아니다. 두 서비스 모두 요청이 와야 움직인다.

기대 로그:

```
ERC-7710 facilitator listening on 127.0.0.1:8081
  network eip155:91342
  manager 0xF2F782Fa…F40C
  signer  0x5eA109ED…E7eC
delegated seller listening on 127.0.0.1:3001
```

## 3. 사전점검 — 읽기 전용

```bash
cd apps/delegation-lab && bun run preflight:giwa inv-001
```

조건이 **전부** ✅ 여야 다음으로 간다. 조건 개수는 스크립트가 스스로 세어
출력하며(`GO — N개 조건 전부 충족`), 그 N은 고정이 아니다 — facilitator나
판매자에 닿지 못하면 하위 항목이 기록되지 않아 총계가 줄어든다. 화면의 N을
기준으로 한다.

이 스크립트는 loopback RPC를 **거부**한다 —
fork를 상대로 통과한 GO는 GO가 아니라 거짓 안심이기 때문이다. (`mcp-e2e.ts`가 loopback만
허용하는 것과 정확히 대칭인 가드다.)

확인 항목: head block · 38-unit 구성 · 위임 체인 회수/유효창/주기 잔량 · 결제액이 잔량
안인지 · payer mUSDC · payer ETH(0이어야 정상) · relayer ETH가 최악 가스비보다 큰지 ·
facilitator가 광고하는 signer가 `RELAYER_ADDRESS`와 같은지 · 판매자 402의 금액/네트워크/payTo.

## 4. 드라이런

```bash
cd apps/delegation-lab && bun run run:giwa
```

MCP를 호출하지 않는다. 무엇이 일어날지만 출력하고 끝난다.

## 5. 실행 — 브로드캐스트 경계

```bash
cd apps/delegation-lab && bun run run:giwa -- --broadcast
```

> 이 줄만 복사해 새 터미널에서 실행하는 경우를 위해 `cd`를 함께 적는다 — 저장소
> 루트의 `package.json`에는 `run:giwa`가 없다.

일어나는 일:

1. 판매자에게 리소스를 요청 → **402**
2. MCP 서버가 부모 permission에서 이 결제 전용 leaf를 파생해 세션키로 서명
3. facilitator가 `redeemDelegations`를 GIWA에 브로드캐스트 — **가스는 relayer가 낸다**
4. 판매자가 리소스를 내준다

사람은 명령 한 번 외에 개입하지 않는다. 그것이 에이전트 자동화의 완료 판정이다.

스크립트는 전후 상태를 각각 독립적으로 읽어 네 가지를 대조한다:

- payer mUSDC가 정확히 결제액만큼 감소
- vendor mUSDC가 정확히 결제액만큼 증가
- **payer ETH가 변하지 않음** — 가스리스
- relayer nonce가 정확히 1 증가

하나라도 어긋나면 실패로 끝난다. 증거는 `giwa-mcp-run.evidence.json`에 남는다.

## 6. 실패 시

| 증상 | 원인 | 대응 |
|---|---|---|
| `LIMIT_EXCEEDED` | 이번 주기 잔량 부족 | 60초 기다렸다 재실행. **정상 동작이다** |
| `PERMISSION_INACTIVE` | 만료/미개시/회수 | permission 재서명 필요 |
| `PERMISSION_EMPTY` | permission 파일이 위임 0개로 디코드됨 | 체인 상태가 아니라 **아티팩트가 잘못됐다.** 서명 절차를 다시 밟을 것 |
| **`SETTLEMENT_UNKNOWN`** | 정산이 브로드캐스트됐고 결과를 확인하지 못함 | **재시도 금지.** 아래 참조 |
| `AA21` / relayer 잔고 | relayer ETH 고갈 | 충전 |
| 대조 실패 | 같은 블록에 다른 결제가 섞임 | 증거 JSON과 explorer로 수동 확인 |

### `SETTLEMENT_UNKNOWN`의 처리 — 재시도 금지

이 표에서 유일하게 틀린 대응이 존재하는 줄이다. `PAYMENT_REJECTED`는 재시도
대상이지만 `SETTLEMENT_UNKNOWN`은 "지불자가 이미 청구되었을 수 있다"는 뜻이고,
이 상태의 재시도는 이중 지불이 될 수 있다.

실제 사례가 근거다. GIWA `0x533c5cb2…9964c`(block 31634935)는 지불자에게서
1.00 mUSDC를 실제로 이체했지만 호출자는 거절 응답을 받았다. 이후 판매자는
확정되지 않은 결과에 504를 반환하고, 에이전트는 그것을 이 코드로 매핑한다.

순서:

1. 응답의 tx 해시를 확인한다. 있으면 explorer에서 바로 조회한다.
2. 해시가 없으면 `giwa-mcp-run.evidence.json`의 전후 상태를 본다 — payer mUSDC가
   결제액만큼 줄었는지가 답이다.
3. **둘 다로 확인되기 전에는 다시 실행하지 않는다.**

브로드캐스트는 되돌릴 수 없다. 실패해도 되돌리지 말고 **무엇이 일어났는지 기록**한다.

## 7. 실행 후

- `giwa-mcp-run.evidence.json`의 tx 해시를 `docs/tech-notes.md` 증거표에 추가
- explorer 링크 확인: `https://sepolia-explorer.giwa.io/tx/<hash>`
- 콘솔(`apps/console`)의 영수증 화면에 같은 정산이 뜨는지 확인 — 별도 원장 없이
  `ERC20PeriodTransferEnforcer`의 이벤트에서 직접 읽는다

---

## 부록 — 실제 RPC를 쓰는 forge 명령

```bash
cd contracts

# 공개 RPC로 fork 테스트 (주의: 배포된 컨트랙트를 검사하지 않는다)
forge test --fork-url giwa_sepolia -vvv

# 사설 RPC로. 별칭이 foundry.toml 안에서 ${GIWA_SEPOLIA_RPC_URL}로 확장되므로
# URL이 argv에 노출되지 않는다 — 사설 엔드포인트는 경로에 API 키가 들어 있어
# URL 전체가 크리덴셜이다. 절대 --fork-url에 직접 붙이지 말 것.
GIWA_SEPOLIA_RPC_URL=... forge test --fork-url giwa_sepolia_alt -vvv

# 배포 시뮬레이션 — 라이브 상태를 읽지만 쓰지 않는다
make framework-simulate

# 라이브 배포 검증 — 읽기 전용
make owner-account-verify
```

`[rpc_endpoints]` 별칭은 `contracts/foundry.toml`에 있다.
