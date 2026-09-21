지금은 시험 운영입니다. 들어오는 잔액은 실제 돈이 아니고, 바꿀 수 없습니다. 실제 결제가 열리면 다시 안내드립니다.

# 셀러 가이드 — 10분 안에 GIWA에서 x402 받기

서버가 있는 빌더가 자기 API 경로 하나를 에이전트에게 유료로 여는 절차다.
필요한 것은 Hono 앱, 받을 주소 하나, 그리고 `@mapae/seller` 한 줄이다.
검증·정산·가스는 마패가 운영하는 공개 facilitator가 들고, 결제 자산은
GIWA Sepolia의 테스트넷 자산 tUSDC다 — 실제 돈이 아니다.

에이전트 쪽(사는 쪽)의 절차는 [MCP 연결 가이드](mcp-guide.md)에 있다.
이 문서는 파는 쪽만 다룬다.

---

## 1. 설치

```bash
npm i @mapae/seller hono viem        # 또는 bun add @mapae/seller hono viem
```

peer 의존성은 `hono >=4.13`과 `viem >=2.55`뿐이다. Node 18 이상 또는 Bun에서
돈다 — 패키지는 Bun 전용 API를 쓰지 않고, Node 경로는 포장된 tarball을 npm으로
설치해 node로 돌리는 `bun run smoke:node`가 검증한다.

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
// 매니페스트는 손으로 적지 않는다 — 앱에 올린 페이월에서 나온다(§4).
app.get(MAPAE_MANIFEST_PATH, mapaeManifest({name: "내 리포트 API", app}));

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
| `description` | 에이전트가 402 오퍼와 매니페스트에서 읽는 한 줄 설명 |

`facilitator`(기본 `https://facilitator.mapae.io`), `onSettled`(정산 콜백, §6),
`extensions`(402 본문의 `extensions` 칸 — 확장 이름 → `{info, schema}` 맵이며 `info`가
확장이 선언하는 내용, `schema`는 클라이언트가 에코할 형태를 기술하는 JSON Schema다.
헤더에도 같이 실리니 작게), `paymentIdentifiers`(결제 식별자 바인딩, §6-1),
`baseUrl`(§2-1)은 선택이다.

### 2-1. 경로가 여럿이면 — `createMapae`

페이월마다 facilitator 클라이언트를 따로 만들 이유가 없다. `createMapae`는
`/supported` 캐시 하나를 모든 페이월이 나눠 쓰게 하고, 같은 facilitator에 묶인
매니페스트를 낸다.

```ts
import {MAPAE_MANIFEST_PATH, createMapae} from "@mapae/seller";

const mapae = createMapae({baseUrl: process.env.BASE_URL}); // 예: https://shop.example
app.get("/reports/daily", mapae.paywall({payTo: PAY_TO, price: "0.01", description: "일일 리포트"}), daily);
app.get("/reports/:id", mapae.paywall({payTo: PAY_TO, price: "1.00", description: "리포트 한 건"}), one);
app.get(MAPAE_MANIFEST_PATH, mapae.manifest({name: "내 리포트 API", app}));
```

`baseUrl`은 손님이 실제로 닿는 주소다 — 스킴과 호스트(포트)만, 경로·쿼리·끝 슬래시
없이. 두면 402의 `resource.url`이 요청이 들어온 URL 대신 `baseUrl + 경로`가 된다.
cloudflared·ngrok 같은 터널이나 리버스 프록시 뒤에서 돌 때 `http://127.0.0.1:3000/…`이
아니라 공개 주소를 내보내는 방법이다. `mapaePaywall(options)`는
`createMapae(options).paywall(options)`와 같다 — 세 옵션을 그대로 받는다.

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
   "extra":{"assetTransferMethod":"erc7710","paymentFlow":"upfront",
     "facilitatorAddresses":["0x…"],"delegationManager":"0x…"}}]}
```

사람과 `curl`에게 402는 정상이다. `network`는 GIWA Sepolia(`eip155:91342`),
`amount`는 최소 단위(tUSDC는 6자리라 `0.01` = `10000`), `asset`은 tUSDC 컨트랙트다.
`facilitatorAddresses`와 `delegationManager`는 미들웨어가 facilitator의 `/supported`에서
읽어 그대로 복사한다 — 로컬 배포 파일이 필요 없는 이유다. `paymentFlow`는 이 레일이
**정산 후 제공**임을 선언한다 — 마패는 `/verify`와 `/settle`이 모두 성공한 뒤에
핸들러를 부른다. x402 v2 §6.1은 기본값 `authorization`(선제공·후정산)이 아닌 흐름을
반드시 선언하게 하며, 미들웨어가 알아서 싣는다. `resource.url`은 요청이
들어온 URL이고, `baseUrl`을 두었다면 그 주소 + 경로다.

## 4. 매니페스트 — `/.well-known/mapae.json`

`mapaeManifest`가 내는 문서다. 에이전트와 마패 디렉토리가 "이 서버에서 무엇을
얼마에 파는가"를 읽는 자리다.

```json
{"version":1,"name":"내 리포트 API","chain":"eip155:91342",
 "asset":"0xcfeb694719A09caeb80798e2011298F29CDa4e92",
 "facilitator":"https://facilitator.mapae.io",
 "endpoints":[
   {"method":"GET","path":"/reports/:id","price":"1.00","description":"리포트 한 건","payTo":"0x…"},
   {"method":"GET","path":"/reports/daily","price":"0.01","description":"일일 리포트","payTo":"0x…"}]}
```

`endpoints`는 앱에 올린 페이월에서 나온다 — 직접 올렸든, `app.basePath()` 아래든,
`app.route()`로 붙인 하위 앱 안이든, `app.use("/api/*", …)`로 올렸든(이때는
`method`가 `ALL`, `path`가 그 패턴). 항목마다 자기 `payTo`가 있으니 한 서버가 여러
받을 주소를 둘 수 있다. 페이월이 없는 경로는 실리지 않고, 페이월이 있는 경로는
빠지지 않는다. 경로, 그다음 메서드 순으로 정렬된다. 문서는 매니페스트에 첫 요청이
왔을 때 한 번 읽어 두고 그대로 낸다 — Hono는 첫 요청이 매칭된 뒤로는 라우트 추가를
거부하므로, 그때 본 것이 서버가 가진 전부다. `price`·`payTo`·`description`은
페이월을 만드는 시점에 검사한다 — 틀린 값은 손님이 아니라 프로세스를 멈춘다.
디렉토리 등록 절차는 디렉토리가 열릴 때 이 문서에 덧붙인다.

## 5. 에이전트가 보는 것

1. 에이전트가 경로를 부르면 402와 오퍼를 받는다.
2. 오퍼의 `facilitatorAddresses`가 자기가 신뢰하는 목록과 겹치는지 보고, 소유자가
   서명해 둔 기간 한도 안에서 이 결제 하나짜리 leaf 위임을 서명한다.
3. 같은 경로를 `Payment-Signature` 헤더와 함께 다시 부른다.
4. 미들웨어가 facilitator에 `/verify`(시뮬레이션) → `/settle`(브로드캐스트)을 차례로
   묻고, 정산이 확인된 뒤에야 핸들러를 실행한다 — **settle-before-serve**.
5. 응답에는 핸들러의 본문과 `Payment-Response` 헤더(정산 tx 해시, facilitator가
   해시를 주지 않았으면 스펙대로 `""`)가 같이 실린다.

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
        // receipt.replayed    이 호출이 정산한 게 아니다 — facilitator가 자기 기록으로
        //                     답했거나, 결제 식별자 바인딩이 이미 남긴 결제로 답했다
        await ledger.insert(receipt);
    },
});
```

`onSettled`는 핸들러보다 **먼저** 돈다. 잔액은 이미 움직였으므로 콜백이 던져도 손님은
받는다 — 던진 오류는 로그로만 남는다. 장부는 여기서 쓴다. 같은 영수증은 핸들러 안에서
`c.get("mapaeReceipt")`로도 읽을 수 있다.

`receipt.replayed`는 **배송 게이트가 아니다.** 첫 시도가 `settlement_pending`으로 끝나고
나중 호출이 청구를 마무리하면 성공한 답이 전부 `replayed`다 — 그것으로 배송을 막으면
받은 돈의 판매를 거절한다. 중복 배송은 `receipt.intent` 한 건당 한 행으로 막고, 이 값은
"다른 호출이 이 일을 했다"로만 읽는다.

**같은 가격·같은 `payTo`의 경로 둘을 두지 않는다.** 오퍼에는 경로가 들어 있지 않아,
한 경로에서 산 헤더가 같은 오퍼의 다른 경로도 연다. 경로마다 가격을 다르게 하거나,
`receipt.intent`를 장부와 대조해 한 번 쓴 결제를 거절한다.

### 6-1. 재시도가 두 번 청구되지 않게 — `paymentIdentifiers`

`receipt.intent`는 **서명된 리프 하나**의 이름이다. 손님의 에이전트가 답을 못 받고 다시
낼 때는 새 리프로 서명하므로 intent가 달라지고, 그러면 장부의 한 행도 facilitator의
기록도 두 시도를 같은 결제로 보지 못한다. 두 시도를 잇는 이름이 x402의
`payment-identifier`다.

```ts
mapaePaywall({
    payTo: PAY_TO,
    price: "0.01",
    description: "일일 리포트",
    paymentIdentifiers: {
        // id를 이 요청(지문)과 이 결제(intent)에 묶는다. 정산보다 먼저 불린다.
        //   {kind: "new"}       — 처음 보는 id. 그대로 정산한다
        //   {kind: "conflict"}  — 같은 id에 다른 요청이나 다른 리프 → 409
        //   {kind: "settled"}   — 이미 낸 결제 → 다시 정산하지 않고 그 결과로 답한다
        bind: (payment) => bindings.bind(payment),
        // 정산이 성공한 뒤에만 불린다. 지불자와 해시를 남긴다
        record: (settlement) => bindings.record(settlement),
    },
});
```

포트를 주면 페이월이 402에 확장을 광고하고 실려 온 id를 읽는다. 주지 않으면 광고하지도,
읽지도 않는다 — 지킬 수 없는 약속은 하지 않는다. **저장은 디스크에 한다.** 프로세스와
함께 죽는 가드는 가드가 아니다.

id는 **서명되지 않는다.** 중간에 누가 바꿔 칠 수 있으므로 멱등성 힌트일 뿐 인증이 아니고,
"이 손님이 맞는가"는 언제나 `receipt.intent`와 `receipt.payer`로 판단한다.

## 7. 공개 facilitator — `https://facilitator.mapae.io`

| 경로 | 역할 |
|---|---|
| `GET /supported` | 어떤 체인·방식을 정산하는지. `eip155:91342`와 signer 주소가 돌아오면 정상 |
| `POST /verify` | 위임 시뮬레이션. 아무것도 청구하지 않는다 |
| `POST /settle` | 위임 실행(redeem)과 tUSDC 이전 브로드캐스트 |

- 인증이 없다. 어느 서버든 지금 바로 부를 수 있고, 등록도 키도 필요 없다.
- 정산 tx의 가스는 마패의 relayer가 낸다. 판매자도 손님도 ETH가 필요 없다.
- 건당 상한은 `MAX_SETTLEMENT_AMOUNT` 기본 **10.00 tUSDC**다. 그보다 비싼 `price`는
  `/verify`에서 거절된다(아래 402 오퍼 재발행).
- 수취는 `payTo`로 직접 간다. 마패는 자금을 보관하지도, 환전하지도 않는다.
- `/verify`와 `/settle`은 호출자 주소별로 요청을 제한한다. `facilitator`가 루프백에
  있으면 — 자기 주소를 볼 수 없는 유일한 호출자 — 페이월이 손님의 `CF-Connecting-IP`를
  `X-Mapae-Client-IP`로 두 호출에 실어 보내 서버가 아니라 손님으로 센다. 원격
  facilitator(`facilitator.mapae.io` 포함)에는 손님에 대해 아무것도 알리지 않는다.

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
| `402` (헤더 없음) | 결제 헤더가 없다 | 정상. 에이전트가 낼 차례다 |
| `400 malformed_payment` | 헤더가 ERC-7710 결제가 아니거나, `payment-identifier`가 `[A-Za-z0-9_-]` 16–128자가 아니다. 영수증은 `invalid_payload`를 대고, 헤더 자체가 읽힌 경우에만 지불자를 댄다 | 에이전트 쪽 문제. `detail`이 사람이 읽을 이유를 말한다 |
| `409 payment_identifier_conflict` | 이 `payment-identifier`가 이미 다른 요청이나 다른 리프에 묶여 있다(`detail`이 어느 쪽인지 말한다). 청구된 것은 없고 오퍼도 다시 싣지 않는다 | 에이전트는 새 id로 낸다. 같은 id로는 무엇을 내도 같은 답이다 |
| `503 facilitator_unavailable` | `/supported` 또는 `/verify`에 닿지 못했거나, facilitator가 결제를 보지 않았다 — 요청 제한, 또는 실패한 준비 검사 — `/verify`든 `/settle`이든. 청구된 것은 없다 | `curl -s https://facilitator.mapae.io/supported`로 확인하고 같은 결제로 다시 시도 |
| `402` (오퍼 재발행) | facilitator가 위임을 거절했거나(만료, 한도 초과, 상한 10.00 초과, 오퍼 불일치), 아무도 청구되지 않은 정산 실패다. 새 leaf로 다시 낼 수 있으므로 오퍼를 다시 싣는다 | 손님의 위임을 확인. 가격이 상한 안인지 확인 |
| `504 settlement_unknown` | 결과가 확정되지 않았다 — 응답 유실, `settlement_pending`, `unexpected_settle_error`, 또는 채굴 실패 낱말이 아닌 사유로 해시를 댄 실패. **청구됐을 수 있다** | 영수증 헤더의 tx를 탐색기에서 확인. 에이전트에게 다시 서명시키지 않는다 |
| `502 settlement_misdirected` | 정산이 채굴됐지만 `payTo`가 아닌 곳을 채웠다. **청구됐을 수 있다** | 영수증 헤더의 tx를 탐색기에서 확인. 오퍼를 다시 주지 않는다 |
| `404` | 페이월 뒤에 핸들러가 없다 | 미들웨어는 아무도 안 받는 경로에 값을 매기지 않는다. 라우트를 확인 |

결제를 **읽은** 뒤 거절하는 응답은 모두 x402 v2 `SettleResponse`를
`Payment-Response` 헤더(base64 UTF-8 JSON)에 함께 싣는다 — `success: false`와 §9 낱말
하나(`invalid_payload`, `settlement_pending`, `rate_limited`, `delegation_rejected` …).
성공 영수증과 실패 영수증은 모양이 다르다: `payer`는 성공에 항상 있고(움직인 돈이 누가
냈는지 모를 수는 없다) 실패에서는 없을 수 있다 — 헤더가 읽히지 않은 400은 지불자의
이름도 그 글자 안에 있었기 때문이다. `errorReason`은 그 거울상으로 실패에 항상 있고
성공에는 없다. 칸은 상태로 읽고 낱말로 읽지 않는다: `invalid_payload`는 400의 낱말이면서
facilitator가 오퍼와 어긋나는 `accepted`에 답하는 낱말이기도 해서, 지불자를 실은 402로
돌아오기도 한다.

영수증이 아예 없는 응답은 둘이다: 결제 헤더를 보내지 않은 요청(영수증이 될 결제가 없다),
그리고 `404` — 헤더를 읽기 전에 떠나므로 결제를 실은 요청도 여기서는 영수증을 받지 못한다.
어차피 그 결제를 받아 줄 핸들러가 없었기 때문이다. 모든 응답에 — 404까지 —
`Cache-Control: no-store`와 `Vary: Payment-Signature`도 붙어, 캐시가 결제한 본문을
미결제 요청에 주는 일이 없다.

해시를 댄 실패에는 오퍼를 다시 싣지 않는다. `vendor_not_credited`는 502, 그 밖은 504다 —
402 칸에 닿을 수 있는 낱말은 모두 "브로드캐스트 전에 거절됐다"고 주장하는데 해시는 그래도
무언가 나갔다고 말하기 때문이다. 예외는 `settlement_reverted` 하나로, 채굴된 revert라
자산이 움직이지 않았다.

부팅이 `payTo must be…`, `price must be…`, `description must not be empty`,
`facilitator must use HTTPS…`, `baseUrl must be an origin…`으로 멈추면 옵션 값의
문제다. facilitator URL은 루프백이 아닌 한 HTTPS여야 하고, `baseUrl`은 경로·쿼리 없는
origin이어야 한다.

## 10. 참고

- 참조 구현: `apps/delegated-seller` — 이 패키지 위에서 도는 두 상품짜리 셀러.
- 배포 주소: [배포 컨트랙트](deployed-contracts.md). tUSDC와 DelegationManager가 있다.
- 흐름의 근거: [기술자료 §2 결제 흐름](tech/02-payment-flows.md).
