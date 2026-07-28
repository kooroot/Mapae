<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 5. 확인된 온체인 환경

| 항목 | 값 |
|---|---|
| 네트워크 | GIWA Sepolia (`eip155:91342`) |
| RPC | `https://sepolia-rpc.giwa.io` |
| MockUSDC | `0xcfeb694719A09caeb80798e2011298F29CDa4e92` |
| EIP-712 도메인 | name `Mock USDC` / version `2` / decimals `6` |
| EntryPoint | canonical v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Delegation Framework v1.3 | **GIWA 배포·검증 완료** — DelegationManager `0xF2F782Fa…F40C` (active, owner=admin, unpaused), 38-unit exact composition |
| owner 스마트계정 (payer) | `0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382` (HybridDeleGator, owner=Case1) |
| ERC20PeriodTransferEnforcer | `0x700330288f6f094780121ea54cd2eDEfe45b3625` |

이 표는 **주소를 갖고 우리가 직접 읽어 확인한 것만** 담는다. Dojang은 등급2 계획에
등장하지만 이 저장소가 주소를 확인한 적이 없어 여기 넣지 않는다 — 확인한 것과 계획한
것을 같은 표에 두면 표 전체의 값어치가 계획 수준으로 내려간다.
