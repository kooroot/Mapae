# 배포된 컨트랙트 (GIWA Sepolia)

Mapae가 **GIWA Sepolia**에 배포한 모든 온체인 컨트랙트의 단일 레퍼런스다.
주소는 정본(正本)에서 그대로 가져온 것이며, 이 파일은 사람이 읽는 사본이다 —
코드/스크립트는 항상 정본을 읽지 이 표를 읽지 않는다.

정본은 **둘**이다:

| 대상 | 정본 |
|---|---|
| Framework 38 유닛, 데모 계정 | `deployments/giwa-sepolia.framework*.json`, `deployments/giwa-sepolia.owner-account.json` |
| **MockUSDC** | **`packages/shared/src/token.ts`** — 배포 아티팩트에 없다 |

MockUSDC가 아티팩트에 없는 것은 누락이다. 이 문서는 오래도록 "모든 주소가 아티팩트에서
온다"고 적어뒀는데 그 하나에 대해서는 참인 적이 없었고, `scripts/check-docs.ts` 를
쓰면서 처음 드러났다. 검사기는 두 정본을 모두 읽는다 — MockUSDC 를 예외 목록에 넣었다면
이 사실이 다시 묻혔을 것이다.

> 값이 바뀌면 이 문서가 아니라 정본이 먼저 바뀐다. 불일치가 보이면 정본이 옳다.
> `bun run check:docs` 가 이 표의 모든 주소를 두 정본에 대조한다.

---

## 네트워크

| | |
|---|---|
| 네트워크 | GIWA Sepolia |
| Chain ID | `91342` (CAIP-2 `eip155:91342`) |
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` (Blockscout) |
| Faucet | `https://faucet.giwa.io` |
| Delegation Framework | v1.3.0 (MetaMask Delegation Framework) |
| Composition ID | `mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795` |
| 배포 방식 | Foundry `DeployDelegationFramework.s.sol` — 결정적(CREATE2) 38-unit exact composition |
| 상태 | `active` (framework owner = admin, unpaused) |

아래 모든 주소는 `https://sepolia-explorer.giwa.io/address/<주소>` 에서 조회된다.

---

## 1. 애플리케이션 계층

Mapae가 직접 작성해 배포한 컨트랙트.

| 컨트랙트 | 주소 | 비고 |
|---|---|---|
| MockUSDC | [`0xcfeb694719A09caeb80798e2011298F29CDa4e92`](https://sepolia-explorer.giwa.io/address/0xcfeb694719A09caeb80798e2011298F29CDa4e92) | EIP-3009 테스트 스테이블코인. EIP-712 도메인 `Mock USDC` / `2` / 6 decimals. `mint`는 무권한 faucet |

---

## 2. 핵심 프로토콜

Delegation Framework의 코어. `DelegationManager`가 위임 서명 검증과
`redeemDelegations` 실행의 진입점이다.

| 컨트랙트 | 주소 | 비고 |
|---|---|---|
| DelegationManager | [`0xF2F782FafBB278eBe46a4F4004B6d45d125EF40C`](https://sepolia-explorer.giwa.io/address/0xF2F782FafBB278eBe46a4F4004B6d45d125EF40C) | EIP-712 도메인 `DelegationManager` / `1`. Mapae가 배포·소유 |
| SimpleFactory | [`0xbED01c51285771437154B01D7EB1E942B96A30b2`](https://sepolia-explorer.giwa.io/address/0xbED01c51285771437154B01D7EB1E942B96A30b2) | DeleGator 스마트계정 CREATE2 팩토리 |
| EntryPoint (v0.7) | [`0x0000000071727De22E5E9d8BAf0edAc6f37da032`](https://sepolia-explorer.giwa.io/address/0x0000000071727De22E5E9d8BAf0edAc6f37da032) | ERC-4337 canonical. 우리가 배포한 게 아니라 체인에 이미 있는 표준 주소 |

---

## 3. DeleGator 구현체

스마트계정 프록시가 위임(delegate)하는 로직 구현체. 사용자의 payer 계정은
`HybridDeleGator` 프록시다.

| 컨트랙트 | 주소 | 비고 |
|---|---|---|
| HybridDeleGatorImpl | [`0xDd64e5D75aBe21Ea4f2a69c35dA23e09A37D8185`](https://sepolia-explorer.giwa.io/address/0xDd64e5D75aBe21Ea4f2a69c35dA23e09A37D8185) | EOA + P256 하이브리드 소유권. Mapae payer 계정이 이 구현을 가리킴 |
| MultiSigDeleGatorImpl | [`0x0e7F86337C3FA93E53658Fee0E9D42Bbd9b886B5`](https://sepolia-explorer.giwa.io/address/0x0e7F86337C3FA93E53658Fee0E9D42Bbd9b886B5) | 멀티시그 소유권 (미사용) |
| EIP7702StatelessDeleGatorImpl | [`0x393AE8400430F9E3e1aa97Beb57D98f98003BE5D`](https://sepolia-explorer.giwa.io/address/0x393AE8400430F9E3e1aa97Beb57D98f98003BE5D) | EIP-7702 EOA 위임 구현 (미사용) |
| SCL_RIP7212 | [`0x9c4A2911359a900F1b713576e3B7FAbe4367fA72`](https://sepolia-explorer.giwa.io/address/0x9c4A2911359a900F1b713576e3B7FAbe4367fA72) | P256(secp256r1) 검증 라이브러리. Hybrid의 passkey 경로 의존성 |

---

## 4. Caveat 인포서 (32)

각 인포서는 위임에 붙는 온체인 제약이다. `redeemDelegations` 실행 전후에
`beforeHook`/`afterHook`으로 강제된다. **Mapae 위임 결제 흐름이 실제로 쓰는 것**은
`Mapae` 열에 ✓ 표시했다 — 나머지는 Framework가 함께 배포한 표준 인포서로, 등급2의
복합 caveat에서 쓰일 수 있다.

| 인포서 | 주소 | Mapae | 강제하는 것 |
|---|---|:---:|---|
| ERC20PeriodTransferEnforcer | [`0x700330288f6f094780121ea54cd2eDEfe45b3625`](https://sepolia-explorer.giwa.io/address/0x700330288f6f094780121ea54cd2eDEfe45b3625) | ✓ | 주기별 ERC-20 전송 상한 (마패의 핵심 지출 한도) |
| ERC20TransferAmountEnforcer | [`0x6e2023356bd37a4DA70DAB3e1374B9fFd44bbc0e`](https://sepolia-explorer.giwa.io/address/0x6e2023356bd37a4DA70DAB3e1374B9fFd44bbc0e) | ✓ | 1회용 정확 금액 허용 (결제별 leaf, 재사용 차단) |
| TimestampEnforcer | [`0xEE818d86Ec7642335c1B6d90b529F3c5060D9fb8`](https://sepolia-explorer.giwa.io/address/0xEE818d86Ec7642335c1B6d90b529F3c5060D9fb8) | ✓ | 위임 유효 시작/만료 시각 |
| RedeemerEnforcer | [`0xA44561Ac0b3d7Bc465c9E5177F63E1AB3622dDfe`](https://sepolia-explorer.giwa.io/address/0xA44561Ac0b3d7Bc465c9E5177F63E1AB3622dDfe) | ✓ | 허용된 redeemer(facilitator)만 상환 가능 |
| AllowedCalldataEnforcer | [`0x9C8fb08f2F00F474B1A3F1d02988a7b498f31165`](https://sepolia-explorer.giwa.io/address/0x9C8fb08f2F00F474B1A3F1d02988a7b498f31165) | ✓ | calldata 특정 구간 고정 (고정 수취인 vendor 위임) |
| ValueLteEnforcer | [`0x7EA4d8d14aC4Bcff8e1D3C785de1FA529f421Ce5`](https://sepolia-explorer.giwa.io/address/0x7EA4d8d14aC4Bcff8e1D3C785de1FA529f421Ce5) | ✓ | 네이티브 value 상한 (전송당 0 강제) |
| AllowedTargetsEnforcer | [`0x412aEB6daB5f782d133F14f756f4E191f90E4C32`](https://sepolia-explorer.giwa.io/address/0x412aEB6daB5f782d133F14f756f4E191f90E4C32) | | 호출 가능 대상 컨트랙트 allowlist |
| AllowedMethodsEnforcer | [`0x637DcE9006b58C99446A43B326DECC22756A53a7`](https://sepolia-explorer.giwa.io/address/0x637DcE9006b58C99446A43B326DECC22756A53a7) | | 호출 가능 셀렉터 allowlist |
| ArgsEqualityCheckEnforcer | [`0xf371d6cA846362D0c5342d4182e12f248Abb0878`](https://sepolia-explorer.giwa.io/address/0xf371d6cA846362D0c5342d4182e12f248Abb0878) | | 인자 값 일치 검사 |
| ExactCalldataEnforcer | [`0x8823B75199671aC4C6d20438921680c18c9B4D90`](https://sepolia-explorer.giwa.io/address/0x8823B75199671aC4C6d20438921680c18c9B4D90) | | calldata 전체 정확 일치 |
| ExactCalldataBatchEnforcer | [`0x157BC93Be05c899E44d6836a95A25385531b67c9`](https://sepolia-explorer.giwa.io/address/0x157BC93Be05c899E44d6836a95A25385531b67c9) | | 배치 calldata 정확 일치 |
| ExactExecutionEnforcer | [`0xcF3F6cA8323C0450C2Eb913f85c2EBcd4efB2389`](https://sepolia-explorer.giwa.io/address/0xcF3F6cA8323C0450C2Eb913f85c2EBcd4efB2389) | | 실행(target·value·calldata) 정확 일치 |
| ExactExecutionBatchEnforcer | [`0xE696A7c90a4a94FA1417CeEAbB108024884A03Bf`](https://sepolia-explorer.giwa.io/address/0xE696A7c90a4a94FA1417CeEAbB108024884A03Bf) | | 배치 실행 정확 일치 |
| SpecificActionERC20TransferBatchEnforcer | [`0xc2dCDaaBec97C4b3118075641A852D5884Da4e74`](https://sepolia-explorer.giwa.io/address/0xc2dCDaaBec97C4b3118075641A852D5884Da4e74) | | 특정 액션 + ERC-20 전송 배치. **소스 미검증 — 38개 중 유일. 사유는 [아래](#소스-검증-상태--38-유닛-중-37).** Mapae 정책 경로에서 쓰지 않음 |
| DeployedEnforcer | [`0x3fc13b47b7E7D2DbF257070c89395AAc43D22115`](https://sepolia-explorer.giwa.io/address/0x3fc13b47b7E7D2DbF257070c89395AAc43D22115) | | 대상 컨트랙트 배포 여부 |
| ApprovalRevocationEnforcer | [`0x7985846b0b9f4f1641774a9323bDc4e1dbbe29bD`](https://sepolia-explorer.giwa.io/address/0x7985846b0b9f4f1641774a9323bDc4e1dbbe29bD) | | ERC-20 approval 취소 강제 |
| OwnershipTransferEnforcer | [`0x0f423B5DB18c66178eEd4cA4a7e3021067b4E294`](https://sepolia-explorer.giwa.io/address/0x0f423B5DB18c66178eEd4cA4a7e3021067b4E294) | | 소유권 이전 제약 |
| BlockNumberEnforcer | [`0xAF723E03725cEFC4B2Ee74f8aFb4044Be722584A`](https://sepolia-explorer.giwa.io/address/0xAF723E03725cEFC4B2Ee74f8aFb4044Be722584A) | | 블록 번호 유효 구간 |
| LimitedCallsEnforcer | [`0x416b79119A766bee45e1F9bE1A0955F921CFe34d`](https://sepolia-explorer.giwa.io/address/0x416b79119A766bee45e1F9bE1A0955F921CFe34d) | | 총 상환 횟수 상한 |
| NonceEnforcer | [`0xBf24097FbB32346C05d0829e27e6041d2CDFbaFf`](https://sepolia-explorer.giwa.io/address/0xBf24097FbB32346C05d0829e27e6041d2CDFbaFf) | | nonce 기반 일괄 무효화 |
| IdEnforcer | [`0x321b7D61c67Ea0B650aEE19231bFc2adFb334316`](https://sepolia-explorer.giwa.io/address/0x321b7D61c67Ea0B650aEE19231bFc2adFb334316) | | 위임 id 기반 다회 사용 관리 |
| MultiTokenPeriodEnforcer | [`0x937848926405a71502f36B59F00669Ddb4987762`](https://sepolia-explorer.giwa.io/address/0x937848926405a71502f36B59F00669Ddb4987762) | | 다중 토큰 주기 상한 |
| ERC20StreamingEnforcer | [`0xBd1A645E76cB748616f3aB89755b7cc66147c344`](https://sepolia-explorer.giwa.io/address/0xBd1A645E76cB748616f3aB89755b7cc66147c344) | | ERC-20 스트리밍(선형 해제) |
| ERC20BalanceChangeEnforcer | [`0x6105728F5895fCa116bC9fB17Df64138b3310B67`](https://sepolia-explorer.giwa.io/address/0x6105728F5895fCa116bC9fB17Df64138b3310B67) | | 실행 전후 ERC-20 잔액 변화 한도 |
| ERC721TransferEnforcer | [`0xAf3B31e662F4413935ef0ccA69126DA622A1Ef72`](https://sepolia-explorer.giwa.io/address/0xAf3B31e662F4413935ef0ccA69126DA622A1Ef72) | | 특정 ERC-721 토큰 전송 |
| ERC721BalanceChangeEnforcer | [`0xF3BA7dA29d9285533a40DE6044fe4118A786D7e9`](https://sepolia-explorer.giwa.io/address/0xF3BA7dA29d9285533a40DE6044fe4118A786D7e9) | | ERC-721 잔량 변화 한도 |
| ERC1155BalanceChangeEnforcer | [`0x3686051360cDbC512Fe6d783E8916Ce882A176af`](https://sepolia-explorer.giwa.io/address/0x3686051360cDbC512Fe6d783E8916Ce882A176af) | | ERC-1155 잔량 변화 한도 |
| NativeTokenTransferAmountEnforcer | [`0x5E2f42d305C674F0761E41D3DA77F8A3601748c8`](https://sepolia-explorer.giwa.io/address/0x5E2f42d305C674F0761E41D3DA77F8A3601748c8) | | 네이티브 토큰 누적 전송 상한 |
| NativeTokenPeriodTransferEnforcer | [`0x40b6f626a1e6D1e17625277d2Db9F2E87Ea0138d`](https://sepolia-explorer.giwa.io/address/0x40b6f626a1e6D1e17625277d2Db9F2E87Ea0138d) | | 네이티브 토큰 주기 상한 |
| NativeTokenStreamingEnforcer | [`0xBD52B958DaF25Df3751601E31edbEa89191ACfaA`](https://sepolia-explorer.giwa.io/address/0xBD52B958DaF25Df3751601E31edbEa89191ACfaA) | | 네이티브 토큰 스트리밍 |
| NativeTokenPaymentEnforcer | [`0x2224e1e92bCddAc18530557880B78f04655e2836`](https://sepolia-explorer.giwa.io/address/0x2224e1e92bCddAc18530557880B78f04655e2836) | | 상환 대가로 네이티브 지불 강제 |
| NativeBalanceChangeEnforcer | [`0x097c6b710bC38E60797E1F9F396BC1782cC12714`](https://sepolia-explorer.giwa.io/address/0x097c6b710bC38E60797E1F9F396BC1782cC12714) | | 네이티브 잔액 변화 한도 |

> 38-unit = 위 핵심 프로토콜(EntryPoint 제외) 5 + DeleGator 구현체 4 + Caveat 인포서 32 −
> DelegationManager·SimpleFactory 중복 없이 정리하면: DelegationManager 1 + SimpleFactory 1 +
> 구현체 3(Hybrid/MultiSig/EIP7702) + SCL_RIP7212 1 + 인포서 32 = **38**. EntryPoint는
> 체인의 canonical 주소라 카운트에서 제외된다.

---

## 5. 데모 계정 (공개 주소)

컨트랙트는 아니지만 배포/데모를 이해하는 데 필요한 **공개 주소**들. 모두 주소일 뿐
키가 아니다.

| 역할 | 주소 | 설명 |
|---|---|---|
| Deployer | [`0x5Ea1FB5f222572c03220356cb2914Da2b5acc0DE`](https://sepolia-explorer.giwa.io/address/0x5Ea1FB5f222572c03220356cb2914Da2b5acc0DE) | Framework 38-unit을 브로드캐스트한 배포자. 가스 지불 |
| Framework Admin | [`0x00A7b901abb908ecafEC72973906424c4fDdc100`](https://sepolia-explorer.giwa.io/address/0x00A7b901abb908ecafEC72973906424c4fDdc100) | 2단계 ownership 이전으로 `DelegationManager` 소유권 인수 |
| Payer 스마트계정 | [`0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382`](https://sepolia-explorer.giwa.io/address/0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382) | 지출 주체. HybridDeleGator 프록시, 가스 0 by design |
| Payer 소유 EOA | [`0x011234B8959c1e5Ae9eB833764FaA861C24dB901`](https://sepolia-explorer.giwa.io/address/0x011234B8959c1e5Ae9eB833764FaA861C24dB901) | 위 스마트계정의 owner. root 위임에 ERC-1271로 서명 |

### 세션 키 (delegate 주소)

owner가 각 역할에 위임한 세션 키. 개별 지출 한도의 수신자다.

| 역할 | 주소 | 정책 |
|---|---|---|
| open-agent | [`0xA350522aE469DFA53a117aFD268a60C0e322a321`](https://sepolia-explorer.giwa.io/address/0xA350522aE469DFA53a117aFD268a60C0e322a321) | 3 mUSDC / 60s, 수취인 자유 |
| vendor-agent | [`0xd44b1EcfEFCbe138eA3A82bDc403B8bB84143dAc`](https://sepolia-explorer.giwa.io/address/0xd44b1EcfEFCbe138eA3A82bDc403B8bB84143dAc) | 5 mUSDC / 60s, 고정 수취인 |
| team-manager | [`0xdCe2C20dd5B5BfeaF83012eDb83186e0E498c599`](https://sepolia-explorer.giwa.io/address/0xdCe2C20dd5B5BfeaF83012eDb83186e0E498c599) | 6 mUSDC / 60s 합산 버킷, child에게 재위임 |
| child-a | [`0x953Cfd1cB09daD4db489316C99E5E289471D68bb`](https://sepolia-explorer.giwa.io/address/0x953Cfd1cB09daD4db489316C99E5E289471D68bb) | 4 mUSDC / 60s (manager 버킷 소비) |
| child-b | [`0x0267944a1B4F6c7A6ee26d8cBcD028F02f2EE239`](https://sepolia-explorer.giwa.io/address/0x0267944a1B4F6c7A6ee26d8cBcD028F02f2EE239) | 4 mUSDC / 60s (manager 버킷 소비) |

> **relayer(facilitator 서명자)와 `payTo`(수취인)는 운영 시점에 `.env`로 주입되는
> 값이라 이 표에 고정하지 않는다.** relayer는 정산 트랜잭션의 `msg.sender`이자 가스
> 대납자이고, `payTo`는 판매자의 수취 주소다. 둘 다 공개 주소지만 배포 산출물이 아니라
> 배포/운영 환경 설정에 속한다.

---

## 소스 검증 상태 — 38 유닛 중 37

익스플로러에서 실측한 값이다(2026-07-25, Blockscout `/api/v2/smart-contracts/<주소>`):

| 상태 | 수 | 뜻 |
|---|---|---|
| partial match | 36 | **정상 결과다.** 32바이트 IPFS 메타데이터 다이제스트만 다르고 실행 바이트는 전부 일치한다 — 배포된 코드가 MetaMask의 감사받은 npm 바이트코드이기 때문이다. MockUSDC도 같은 상태 |
| full match | 1 | `ApprovalRevocationEnforcer` |
| **미검증** | **1** | `SpecificActionERC20TransferBatchEnforcer` ([`0xc2dCDaaB…4Da4e74`](https://sepolia-explorer.giwa.io/address/0xc2dCDaaBec97C4b3118075641A852D5884Da4e74)) |

재확인 (읽기 전용, 39개 주소를 한 번에 — 38 유닛 + MockUSDC):

```bash
bun run verify:explorer
```

2026-07-26 재측정에서 위 표 그대로였다. 이 명령이 생기기 전의 재확인 절차는 주소당
`curl` 한 번이었고, 39번을 돌려 손으로 집계해야 했다 — 그래서 아무도 다시 돌리지
않는 종류의 확인이었다. 한 건만 볼 때는 여전히 이쪽이 빠르다:

```bash
curl -s https://sepolia-explorer.giwa.io/api/v2/smart-contracts/<주소> \
  | jq '{name, is_verified, is_partially_verified}'
```

`verify:explorer` 는 **읽기만** 한다. 소스를 게시하는 것은
`scripts/verify-framework.sh` 이고, 그건 제3자 서비스에 쓰는 동작이라 별개로
의도해서 실행하는 것이다. 미검증 1건이 있어도 이 명령은 0으로 끝난다 —
익스플로러의 상태를 보고하는 도구가 남의 서비스 장애를 우리 실패로 만들면 안 된다.

### 그 하나가 검증되지 않는 이유

**핀한 서브모듈 소스와 배포된 바이트코드가 서로 다른 리비전이다.** 서브모듈은
`d0ebab5`에 고정돼 있고 거기에는 업스트림 PR **#145**(`72d9305`,
"refactor: add value to specific action erc20 transfer enforcer", 2025-09-03)가
들어 있다. 배포된 코드는 그 이전 버전이다.

#145가 바꾼 것 — 전부 `terms` **인코딩**이다:

| | #145 이전 (배포된 것) | #145 이후 (서브모듈 소스) |
|---|---|---|
| 최소 terms 길이 | 92바이트 (20+20+32+20) | **124바이트** (+32) |
| 첫 실행의 value 검사 | `executions_[0].value != 0` | `!= terms_.firstValue` |
| `firstCalldata` 시작 | `_terms[92:]` | `_terms[124:]` |
| `TermsData` 필드 수 | 5 | 6 (`firstValue` 추가) |

**`terms`는 `bytes`이므로 외부 ABI가 바뀌지 않았다.** 이게 이 건이 헷갈리는
이유다 — 익스플로러에서 ABI는 맞아떨어지는데 바이트코드만 어긋난다. 로컬 컴파일
runtime은 3333바이트, 배포된 것은 3279바이트로 **54바이트 짧다.**

바이트 수는 정황이고, 결정적 증거는 배포된 컨트랙트의 동작이다. 92바이트 terms를
넣어 읽어보면 확정된다(읽기 전용):

```bash
T92=0x$(python3 -c "print('11'*20 + '22'*20 + '33'*32 + '44'*20)")
cast call 0xc2dCDaaBec97C4b3118075641A852D5884Da4e74 "getTermsInfo(bytes)" "$T92" \
  --rpc-url https://sepolia-rpc.giwa.io
```

실측 결과: **revert하지 않고 필드 5개를 돌려준다**(`firstValue` 없음). #145 이후
코드였다면 `SpecificActionERC20TransferBatchEnforcer:invalid-terms-length`로
거절했어야 한다. 124바이트를 넣으면 여분 32바이트가 `firstValue`가 아니라
`firstCalldata`로 해석된다 — 배포된 것이 pre-#145임을 다시 확인해 준다.

배포 시점의 `@metamask/delegation-abis`가 소스 저장소보다 뒤처져 있었고,
결정적(CREATE2) 컴포지션은 그 시점 바이트코드로 굳었다.

### 그래서 이게 문제인가 — 아니다

**Mapae는 이 enforcer를 정책 경로에서 쓰지 않는다.** 자기 NatSpec이 *정확히 2건짜리
배치*(`a batch of exactly 2 transactions`), *배치 실행 콜타입 전용*, *1회용*
(`can only be executed once`)을 요구하는데, Mapae의 x402 결제는 단일 실행
(`ExecutionMode.SingleDefault`)이고 주기 한도는 재사용된다 — 구조적으로 맞지 않는다.

소스 전체에서 이 이름이 나오는 곳은 배포 목록 3군데뿐이고, 어떤 caveat 조립
경로에도 등장하지 않는다:

```
packages/delegation/src/composition.ts:39          배포 유닛 이름 목록
packages/delegation/src/composition.ts:182         기대 constructor 인자
contracts/script/DeployDelegationFramework.s.sol:253   배포 스크립트
```

38-unit exact composition을 배포한 이유는 **컴포지션 해시가 감사받은 조합과 정확히
일치해야 하기 때문**이지, 38개를 다 쓰기 때문이 아니다. 하나를 빼면 그건 다른
컴포지션이다.

고치려면 서브모듈을 배포 시점 리비전으로 내리거나 이 유닛만 그 리비전으로
검증 제출해야 하는데, 둘 다 나머지 37개의 검증을 흔든다. **미검증 1건을 사유와
함께 적어두는 쪽을 택했다.**

---

## 검증 · 출처

| | |
|---|---|
| 정본 아티팩트 | `deployments/giwa-sepolia.framework.json`, `deployments/giwa-sepolia.framework-forge-addresses.json` |
| Ownership 이전 tx | [`0x1e9fde1a…89531fc`](https://sepolia-explorer.giwa.io/tx/0x1e9fde1ad06f6f803ee70e204f24da07e2dc03261cb184901f0b1c45f89531fc) |
| Ownership 수락 tx | [`0x2b5eaf94…399b8d8`](https://sepolia-explorer.giwa.io/tx/0x2b5eaf94df6e9a9126a5813ff171d6ce2087a4fd92c5ff0c32fe3573b399b8d8) |
| 검증 블록 | `31520346` |
| 배포 절차 | `contracts/script/DeployDelegationFramework.s.sol` + `contracts/Makefile` (`make framework-deploy`) |
| Negative-path 검증 | `apps/delegation-lab/negative-path-suite.ts` — 이 컨트랙트들을 실제 GIWA fork(`SUITE_TARGET=fork`)와 ephemeral 양쪽에서 상환·거절 실증 |

주소가 배포 결과와 일치하는지 확인하려면 아티팩트를 직접 비교한다:

```bash
# 리포지토리 루트에서 실행
jq '.environment' deployments/giwa-sepolia.framework.json
```
