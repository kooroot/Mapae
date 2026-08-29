지금은 시험 운영입니다. 들어오는 잔액은 실제 돈이 아니고, 바꿀 수 없습니다. 실제 결제가 열리면 다시 안내드립니다.

# 셀러 가이드 — 10분 안에 GIWA에서 x402 받기

서버가 있는 빌더가 자기 API 경로 하나를 에이전트에게 유료로 여는 절차다.
필요한 것은 Hono 앱, 받을 주소 하나, 그리고 `@mapae/seller` 한 줄이다.
검증·정산·가스는 마패가 운영하는 공개 facilitator가 들고, 결제 자산은
GIWA Sepolia의 테스트넷 USDC(tUSDC)다 — 실제 돈이 아니다.

에이전트 쪽(사는 쪽)의 절차는 [MCP 연결 가이드](mcp-guide.md)에 있다.
이 문서는 파는 쪽만 다룬다.

---

## 1. 설치

```bash
bun add @mapae/seller        # 또는 npm i @mapae/seller
```

peer 의존성은 `hono >=4.13`과 `viem >=2.55`뿐이다. Node 20 이상 또는 Bun에서
돈다 — 패키지는 Bun 전용 API를 쓰지 않는다.

## 2. 한 줄

```ts
import {Hono} from "hono";
import {MAPAE_MANIFEST_PATH, mapaeManifest, mapaePaywall} from "@mapae/seller";

const PAY_TO = process.env.PAY_TO!; // 받을 주소. 개인키가 아니다.
const app = new Hono();

app.get(
    "/api/report",
    mapaePaywall({payTo: PAY_TO, price: "0.01", description: "일일 리포트"}),
    (c) => c.json({report: "…"}),
);
app.get(
    MAPAE_MANIFEST_PATH,
    mapaeManifest({
        name: "내 리포트 API",
        payTo: PAY_TO,
        endpoints: [{path: "/api/report", price: "0.01", description: "일일 리포트"}],
    }),
);

export default {fetch: app.fetch, port: 3000, idleTimeout: 45}; // Bun
```

Node라면 마지막 줄 대신 `@hono/node-server`의 `serve({fetch: app.fetch, port: 3000})`를
쓴다. Bun의 `idleTimeout`은 반드시 45 이상으로 둔다 — 기본값 10초는 정산 호출(최대
35초)보다 짧아서, 서버가 자기 정산을 기다리다 먼저 끊는다.

옵션은 셋이 필수다.

| 옵션 | 뜻 |
|---|---|
| `payTo` | tUSDC를 받을 GIWA 주소. 정산은 이 주소로 **직접** 간다 — 마패는 자금을 거치지 않는다 |
| `price` | tUSDC 십진 문자열. 0보다 크고 소수점 아래 6자리까지. `"0.01"`, `"1.00"` |
| `description` | 에이전트가 402 오퍼에서 읽는 한 줄 설명 |

`facilitator`(기본 `https://facilitator.mapae.io`)와 `onSettled`(정산 콜백, §6)는 선택이다.

## 3. `curl`로 402 확인

```bash
curl -si http://127.0.0.1:3000/api/report
```

```
HTTP/1.1 402 Payment Required
Payment-Required: eyJ4NDAyVmVyc2lvbiI6Miwi…
{"x402Version":2,"resource":{"url":"http://127.0.0.1:3000/api/report","description":"일일 리포트"},
 "accepts":[{"scheme":"exact","network":"eip155:91342","amount":"10000",
   "payTo":"0x…","asset":"0xcfeb694719A09caeb80798e2011298F29CDa4e92",
   "extra":{"assetTransferMethod":"erc7710","facilitatorAddresses":["0x…"],"delegationManager":"0x…"}}]}
```

사람과 `curl`에게 402는 정상이다. `network`는 GIWA Sepolia(`eip155:91342`),
`amount`는 최소 단위(tUSDC는 6자리라 `0.01` = `10000`), `asset`은 tUSDC 컨트랙트다.
`facilitatorAddresses`와 `delegationManager`는 미들웨어가 facilitator의 `/supported`에서
읽어 그대로 복사한다 — 로컬 배포 파일이 필요 없는 이유다.

## 4. 매니페스트 — `/.well-known/mapae.json`

`mapaeManifest`가 내는 문서다. 에이전트와 마패 디렉토리가 "이 서버에서 무엇을
얼마에 파는가"를 읽는 자리다.

```json
{"version":1,"name":"내 리포트 API","chain":"eip155:91342",
 "asset":"0xcfeb694719A09caeb80798e2011298F29CDa4e92","payTo":"0x…",
 "facilitator":"https://facilitator.mapae.io",
 "endpoints":[{"path":"/api/report","price":"0.01","description":"일일 리포트"}]}
```

`price`와 `payTo`는 부팅 시점에 검사한다 — 틀린 값은 손님이 아니라 프로세스를 멈춘다.
디렉토리 등록 절차는 디렉토리가 열릴 때 이 문서에 덧붙인다.

## 5. 에이전트가 보는 것

1. 에이전트가 경로를 부르면 402와 오퍼를 받는다.
2. 오퍼의 `facilitatorAddresses`가 자기가 신뢰하는 목록과 겹치는지 보고, 소유자가
   서명해 둔 기간 한도 안에서 이 결제 하나짜리 leaf 위임을 서명한다.
3. 같은 경로를 `Payment-Signature` 헤더와 함께 다시 부른다.
4. 미들웨어가 facilitator에 `/verify`(시뮬레이션) → `/settle`(브로드캐스트)을 차례로
   묻고, 정산이 확인된 뒤에야 핸들러를 실행한다 — **settle-before-serve**.
5. 응답에는 핸들러의 본문과 `Payment-Response` 헤더(정산 tx 해시)가 같이 실린다.

에이전트는 호출마다 서명하지 않아도 되는 손님이다 — 소유자가 정한 기간 한도 안에서
반복 결제한다. 그 손님을 만드는 쪽의 절차가 [MCP 연결 가이드](mcp-guide.md)다.

## 6. 첫 정산 — `onSettled`

```ts
mapaePaywall({
    payTo: PAY_TO,
    price: "0.01",
    description: "일일 리포트",
    onSettled: async (receipt) => {
        // receipt.intent      이 결제의 고유 키(facilitator의 재생 캐시와 같은 값)
        // receipt.payer       낸 쪽의 루트 위임자 주소
        // receipt.amount      "0.01"  (tUSDC)
        // receipt.transaction GIWA tx 해시 — https://sepolia-explorer.giwa.io/tx/<해시>
        await ledger.insert(receipt);
    },
});
```

`onSettled`는 핸들러보다 **먼저** 돈다. 잔액은 이미 움직였으므로 콜백이 던져도 손님은
받는다 — 던진 오류는 로그로만 남는다. 장부는 여기서 쓴다. 같은 영수증은 핸들러 안에서
`c.get("mapaeReceipt")`로도 읽을 수 있다.

**같은 가격의 경로 둘을 두지 않는다.** 오퍼에는 경로가 들어 있지 않아, 한 경로에서 산
헤더가 같은 가격의 다른 경로도 연다. 경로마다 가격을 다르게 하거나, `receipt.intent`를
장부와 대조해 한 번 쓴 결제를 거절한다.

## 7. 공개 facilitator — `https://facilitator.mapae.io`

| 경로 | 역할 |
|---|---|
| `GET /supported` | 어떤 체인·방식을 정산하는지. `eip155:91342`와 signer 주소가 돌아오면 정상 |
| `POST /verify` | 위임 시뮬레이션. 아무것도 청구하지 않는다 |
| `POST /settle` | 위임 실행(redeem)과 tUSDC 이전 브로드캐스트 |

- 인증이 없다. 어느 서버든 지금 바로 부를 수 있고, 등록도 키도 필요 없다.
- 정산 tx의 가스는 마패의 relayer가 낸다. 판매자도 손님도 ETH가 필요 없다.
- 건당 상한은 `MAX_SETTLEMENT_AMOUNT` 기본 **10.00 tUSDC**다. 그보다 비싼 `price`는
  `/verify`에서 거절된다(아래 403).
- 수취는 `payTo`로 직접 간다. 마패는 자금을 보관하지도, 환전하지도 않는다.

```bash
curl -s https://facilitator.mapae.io/supported
```

## 8. 실제 돈이 아니다

들어오는 것은 GIWA Sepolia의 테스트넷 잔액(tUSDC)이다. 바꿀 수 없고, 원화 환전·정산
일정·세금계산서를 약속하지 않는다. "돈을 받았다"고 말하지 않는다 — "테스트넷 잔액이
들어왔다", "결제 n건"이 정확한 말이다.

## 9. 문제가 생기면

| 응답 | 뜻 | 할 일 |
|---|---|---|
| `402` | 결제 헤더가 없다 | 정상. 에이전트가 낼 차례다 |
| `503 facilitator_unavailable` | `/supported` 또는 `/verify`에 닿지 못했다. 청구된 것은 없다 | `curl -s https://facilitator.mapae.io/supported`로 확인하고 다시 시도 |
| `400 malformed_payment` | 헤더가 ERC-7710 결제가 아니다 | 에이전트 쪽 문제. `detail`이 이유를 말한다 |
| `403 delegation_rejected` | facilitator가 위임을 거절했다 — 만료, 한도 초과, 상한(10.00) 초과, 오퍼 불일치 | 손님의 위임을 확인. 가격이 상한 안인지 확인 |
| `504 settlement_unknown` | 브로드캐스트됐을 수 있으나 영수증을 못 봤다. **청구됐을 수 있다** | 탐색기에서 tx를 확인. 에이전트에게 다시 서명시키지 않는다 |
| `422 settlement_failed` | 이전이 일어나지 않았다. 청구된 것은 없다 | 다시 시도 |
| `404` | 페이월 뒤에 핸들러가 없다 | 미들웨어는 아무도 안 받는 경로에 값을 매기지 않는다. 라우트를 확인 |

부팅이 `payTo must be…`, `price must be…`, `facilitator must use HTTPS…`로 멈추면
옵션 값의 문제다. facilitator URL은 루프백이 아닌 한 HTTPS여야 한다.

## 10. 참고

- 참조 구현: `apps/delegated-seller` — 이 패키지 위에서 도는 두 상품짜리 셀러.
- 배포 주소: [배포 컨트랙트](deployed-contracts.md). tUSDC와 DelegationManager가 있다.
- 흐름의 근거: [기술자료 §2 결제 흐름](tech/02-payment-flows.md).
