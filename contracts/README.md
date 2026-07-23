# mapae/contracts

Mapae 정산에 쓰이는 컨트랙트. D1 범위는 **MockUSDC (EIP-3009)** 하나.

## 셋업

⚠️ **`forge init`을 쓰지 말 것.** `--force`가 `foundry.toml`을 기본값으로 덮어쓰고 `Counter.sol`을 심습니다.
폴더 구조는 이미 있으므로 의존성만 설치합니다.

```bash
cd contracts
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts   # v5 계열 필요
```

`remappings.txt`:
```
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
forge-std/=lib/forge-std/src/
```

```bash
forge build && forge test -vvv
```

- `forge install`은 git submodule을 씁니다. 루트에서 `git init`을 했으므로 `contracts/lib/...` 경로로 잡히는 게 정상. 작업 트리가 더러우면 먼저 커밋할 것.
- **OZ는 v5 이상.** 테스트에서 `ECDSA.tryRecover`를 3-튜플로 받는데 v4.9까지는 2-튜플이라 컴파일이 깨집니다.

`.env`:
```bash
cp .env.example .env
chmod 600 .env
```

`PRIVATE_KEY`는 GIWA Sepolia 전용 배포자 키만 사용하고, `TEST_USER`는 반드시
배포자와 다른 지불자 주소로 설정합니다. 배포 스크립트가 체인 ID와 두 역할의
분리를 강제합니다.

## 테스트

```bash
forge test -vvv
```

D1 통과 기준 — 아래 네 축이 전부 초록:

| 테스트 | 무엇을 막는가 |
|---|---|
| `test_rejects_signatureFromWrongSigner` / `test_rejects_tamperedAmount` | 서명 위조·필드 변조 |
| `test_rejects_replayOfSameNonce` / `test_cancelAuthorization_*` | 리플레이 |
| `test_rejects_beforeValidAfter` / `test_rejects_afterExpiry` | 시간 창 |
| `test_acceptsSmartAccountSignature_eip1271` | **D3~D4 블로커** — 스마트어카운트 결제 |

## 배포

```bash
forge script script/DeployMockUSDC.s.sol \
  --rpc-url giwa_sepolia --broadcast --verify -vvvv
```

배포 후 **소스 verify 확인**. 익스플로러에서 소스 코드가 보여야 합니다.

## ⚠️ facilitator에 등록할 값

x402 토큰 설정과 아래가 **정확히** 일치해야 합니다. 불일치하면 전부 "invalid signature"로 떨어집니다.

| 항목 | 값 |
|---|---|
| EIP-712 `name` | `Mock USDC` |
| EIP-712 `version` | `2` |
| `decimals` | `6` |
| `chainId` | GIWA Sepolia |
| `verifyingContract` | 배포 주소 |

디버깅 순서: 클라이언트가 계산한 domain separator ↔ 온체인 `DOMAIN_SEPARATOR()` 비교. 여기서 대부분 끝납니다.

## 설계 메모

- **EIP-1271**: 서명 검증을 OZ `SignatureChecker`로 태워서 EOA와 스마트어카운트를 모두 받습니다. `ecrecover`만 쓰면 D3에서 payer가 4337 계정이 되는 순간 조용히 깨집니다.
- **decimals 6**: 실제 USDC와 맞춤. 다르면 x402 금액 처리에서 10¹² 오차.
- **`mint` 무제한**: 테스트넷 전용. 메인넷에 이 형태로 올리지 말 것.
- **`transferWithAuthorization` 프론트런**: 관찰자가 mempool에서 authorization을 추출해 먼저 제출할 수 있음. 자금은 여전히 `to`로 가므로 절도가 아니라 순서 문제. 수취 사실에 로직을 거는 컨트랙트는 `receiveWithAuthorization`을 쓸 것.
- **`evm_version = "cancun"`**: MCOPY 관련 리버트가 나면 `shanghai`로 내릴 것.

## 다음 단계 (D1 범위 아님)

- 3단계: EAS 계약/영수증 스키마 + OnchainVerifiable 리졸버
- 위임·세션키는 MetaMask Delegation Toolkit 쪽에서 처리 (컨트랙트 직접 작성 아님)
