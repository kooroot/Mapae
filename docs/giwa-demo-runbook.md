# GIWA 실행 런북 — MCP 결제 1건

에이전트가 GIWA Sepolia에서 스스로 결제하는 것을 증명하는 절차. fork가 아니라 실제 체인이다.

> **이 문서의 마지막 단계는 실제 브로드캐스트다.** 저장소의 상시 규칙상 매번 별도 승인이
> 필요하며, 승인이 코드에 도달하는 지점은 `--broadcast` 플래그 하나뿐이다.

---

## 0. 무엇이 증명되고 무엇이 안 되는가

| 명령 | 실제 체인을 읽나 | 무엇을 증명하나 |
|---|---|---|
| `forge test` | ❌ | 컨트랙트 로직. 로컬 EVM에서 새로 배포해서 검사 |
| `forge test --fork-url giwa_sepolia` | 베이스 상태만 | **배포된 컨트랙트에 대해서는 아무것도.** 테스트가 fork 안에 자기 사본을 새로 배포한다 |
| `bun run verify:framework` | ✅ | 38개 유닛의 **라이브 런타임 바이트코드**와 CREATE 주소 일치 |
| `make owner-account-verify` | ✅ | owner 스마트계정이 실제로 배포돼 있고 owner가 맞음 |
| `bun run preflight:giwa` | ✅ | 결제 한 건이 성공할 조건 17가지 |
| `bun run run:giwa -- --broadcast` | ✅ **쓰기** | 에이전트가 GIWA에서 실제로 결제함 |

`forge test --fork-url`의 함정은 조용하다는 것이다. 통과하고, 주소를 출력하고, 그 주소는
실제 GIWA 주소가 아니다 — fork 안에서 방금 만들어진 것이다. 라이브 배포를 검사하는 것은
`verify:framework` 쪽이다.

---

## 1. 사전 조건

- `apps/facilitator-erc7710/.env` — `RELAYER_PRIVATE_KEY` (가스 지불), `RELAYER_ADDRESS`
- `apps/delegated-seller/.env` — `PAY_TO` (공개 주소)
- `apps/delegated-agent/.env` — `AGENT_PRIVATE_KEY` (세션키), `PARENT_PERMISSION_CONTEXT_PATH`
- 서명된 root permission이 유효창 안에 있을 것
- payer 스마트계정에 mUSDC, relayer에 GIWA ETH

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

17개 조건 전부 ✅ 여야 다음으로 간다. 이 스크립트는 loopback RPC를 **거부**한다 —
fork를 상대로 통과한 GO는 GO가 아니라 거짓 안심이기 때문이다. (`mcp-e2e.ts`가 loopback만
허용하는 것과 정확히 대칭인 가드다.)

확인 항목: head block · 38-unit 구성 · 위임 체인 회수/유효창/주기 잔량 · 결제액이 잔량
안인지 · payer mUSDC · payer ETH(0이어야 정상) · relayer ETH가 최악 가스비보다 큰지 ·
facilitator가 광고하는 signer가 `RELAYER_ADDRESS`와 같은지 · 판매자 402의 금액/네트워크/payTo.

## 4. 드라이런

```bash
bun run run:giwa
```

MCP를 호출하지 않는다. 무엇이 일어날지만 출력하고 끝난다.

## 5. 실행 — **여기가 브로드캐스트 경계**

```bash
bun run run:giwa -- --broadcast
```

일어나는 일:

1. 판매자에게 리소스를 요청 → **402**
2. MCP 서버가 부모 permission에서 이 결제 전용 leaf를 파생해 세션키로 서명
3. facilitator가 `redeemDelegations`를 GIWA에 브로드캐스트 — **가스는 relayer가 낸다**
4. 판매자가 리소스를 내준다

사람은 명령 한 번 외에 개입하지 않는다. 그것이 D5의 완료 판정이다.

스크립트는 전후 상태를 각각 독립적으로 읽어 네 가지를 대조한다:

- payer mUSDC가 정확히 결제액만큼 감소
- vendor mUSDC가 정확히 결제액만큼 증가
- **payer ETH가 변하지 않음** — 가스리스
- relayer nonce가 정확히 1 증가

하나라도 어긋나면 실패로 끝난다. 증거는 `giwa-mcp-run.evidence.json`에 남는다.

## 6. 실패 시

| 증상 | 원인 | 대응 |
|---|---|---|
| `LIMIT_EXCEEDED` | 이번 주기 잔량 부족 | 60초 기다렸다 재실행. **이건 정상 동작이다** |
| `PERMISSION_INACTIVE` | 만료/미개시/회수 | permission 재서명 필요 |
| `AA21` / relayer 잔고 | relayer ETH 고갈 | 충전 |
| 대조 실패 | 같은 블록에 다른 결제가 섞임 | 증거 JSON과 explorer로 수동 확인 |

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
# URL 전체가 크리덴셜이다. 절대 --fork-url 에 직접 붙이지 말 것.
GIWA_SEPOLIA_RPC_URL=... forge test --fork-url giwa_sepolia_alt -vvv

# 배포 시뮬레이션 — 라이브 상태를 읽지만 쓰지 않는다
make framework-simulate

# 라이브 배포 검증 — 읽기 전용
make owner-account-verify
```

`[rpc_endpoints]` 별칭은 `contracts/foundry.toml`에 있다.
