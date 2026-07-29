# mapae/facilitator

GIWA Sepolia용 x402 facilitator. [x402-rs](https://github.com/x402-rs/x402-rs) 이미지를 설정만 바꿔 구동합니다.

## 실행

```bash
cp .env.example .env
# 편집기로 전용 테스트넷 릴레이어 키 입력
chmod 600 .env
docker compose up -d
docker compose logs -f
```

`config.json` 에는 키가 없고 `$EVM_PRIVATE_KEY` 참조만 있으므로 그대로 커밋합니다. 키는 `.env` 로만 주입하고 gitignore.

facilitator API에는 애플리케이션 인증이 없으므로 Compose 포트는
`127.0.0.1:8080`에만 바인딩합니다. 외부 배포 시에도 공인 포트로 직접
노출하지 말고 seller와 같은 사설 네트워크에 두어야 합니다.

> `docker compose config`는 `.env`의 릴레이어 키를 렌더링해 터미널·CI 로그에
> 노출할 수 있습니다. 구성 검증은 출력 없는 `docker compose config --quiet`만
> 사용합니다.

## 기동 확인

```bash
curl -s localhost:8080/supported | jq
```

응답에 `eip155:91342` 와 exact 스킴이 보이면 정상입니다.

## 설정 메모

| 항목 | 값 | 이유 |
|---|---|---|
| chain key | `eip155:91342` | GIWA Sepolia (CAIP-2) |
| rpc | `https://sepolia-rpc.giwa.io` | 공개 RPC |
| `eip1559` | `true` | OP Stack |
| `flashblocks` | `false` | Base 전용 기능 |
| `signers` | `["$EVM_PRIVATE_KEY"]` | 개인키 배열. `$` 접두사로 환경변수 참조 |
| schemes | `v1/v2-eip155-exact` | `eip155:*` 와일드카드라 GIWA 자동 포함 |

- Solana 체인·스킴 제거 (사용 안 함)
- `v2-eip155-upto` 는 MVP 스코프 아님
- **토큰 등록 섹션 없음** — 판매자가 402 응답에 asset 주소를 직접 명시하는 구조

## 릴레이어 지갑

정산 트랜잭션 가스를 이 지갑이 냅니다. GIWA ETH 잔액을 넉넉히 유지할 것 (`https://faucet.giwa.io`).

## 연결된 토큰

| 항목 | 값 |
|---|---|
| MockUSDC | `0xcfeb694719A09caeb80798e2011298F29CDa4e92` |
| EIP-712 name | `Mock USDC` |
| EIP-712 version | `2` |
| decimals | `6` |

> 이 name/version 문자열이 클라이언트 서명과 정확히 일치해야 합니다. 불일치하면 결제 서명이 전부 invalid signature로 떨어집니다.
