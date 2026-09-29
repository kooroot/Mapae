# 최신 x402 참조 스택 연결

마패의 호스팅 seller는 `@mapae/seller`를 사용한다. 이 가이드는 별도 서버나 에이전트를
공식 x402 스택으로 연결하려는 개발자를 위한 것이다. 실제 구현은
[`reference-x402.ts`](../packages/delegation/examples/reference-x402.ts), 검증은
[`x402-reference.test.ts`](../packages/delegation/src/x402-reference.test.ts)에 있다.

## 검증한 조합

| 패키지 | 버전 |
|---|---|
| `@metamask/smart-accounts-kit` | 2.0.0 |
| `@metamask/delegation-abis` | 2.0.0 |
| `@metamask/x402` | 1.0.0 |
| `@x402/core`, `@x402/evm`, `@x402/hono`, `@x402/fetch` | 2.27.0 |

참조 패키지는 `packages/delegation`의 개발 의존성이다. 예제는 저장소 안에서 타입체크와
테스트를 거치며 `@mapae/seller` npm 패키지에 포함되는 API가 아니다.

## 1. 서버의 결제 흐름 선언

MetaMask의 `x402ExactEvmErc7710ServerScheme`는 ERC-7710 오퍼를 만들지만, 상속한
`paymentFlows`에는 EIP-3009와 Permit2만 들어 있다. 최신 참조 HTTP 서버는 라우트를
구성할 때 이 표를 검사하므로 클래스를 그대로 등록하면 `erc7710`을 거절한다.

예제의 `createMapaeReferenceScheme()`는 공식 구현의 가격 변환·오퍼 생성을 사용하고,
마패 프로필을 `erc7710`·`upfront`로 선언한다. 이 프로필은 `authorization`·`escrow`를
지원한다고 광고하지 않는다.

서버 연결은 다음과 같다. `PAY_TO`는 검증된 수취 주소, `environment`는 마패의 검증된
GIWA 배포 환경이다. 아래 코드는 예제 모듈을 가져온 통합 프로젝트의 구성 부분이다.

```ts
import {Hono} from "hono";
import {HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer} from "@x402/core/server";
import {paymentMiddlewareFromHTTPServer} from "@x402/hono";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC} from "@mapae/shared";
import {createMapaeReferenceScheme} from "./reference-x402.js";

const server = new x402ResourceServer(new HTTPFacilitatorClient({
    url: "https://facilitator.mapae.io",
})).register(GIWA_SEPOLIA_CAIP2, createMapaeReferenceScheme());

const httpServer = new x402HTTPResourceServer(server, {
    "GET /paid": {
        accepts: {
            scheme: "exact",
            network: GIWA_SEPOLIA_CAIP2,
            payTo: PAY_TO,
            price: {asset: MOCK_USDC.address, amount: "1000000"},
            extra: {
                assetTransferMethod: "erc7710",
                paymentFlow: "upfront",
                delegationManager: environment.DelegationManager,
            },
        },
        mimeType: "application/json",
    },
});

await httpServer.initialize();
const app = new Hono();
app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
app.get("/paid", (c) => c.json({paid: true}));
```

GIWA의 테스트 토큰은 참조 스택의 기본 자산 목록에 없으므로 가격은 달러 문자열 대신
토큰 주소와 최소 단위 정수로 지정한다. `1000000`은 6자리 토큰 1개다.
`delegationManager`도 검증된 배포 환경에서 명시한다. MetaMask의 오퍼 확장 함수는
`/supported`에서 `facilitatorAddresses`만 복사하며 manager를 대신 선택하지 않는다.

참조 `upfront` 서버는 `/verify` 호출 없이 `/settle`을 먼저 호출한다. 마패 facilitator의
`/settle`은 앞선 `/verify`를 신뢰하지 않고 독립적으로 검증·시뮬레이션한다. 호스팅
`@mapae/seller`의 `/verify → /settle` 순서와 HTTP 호출 수는 다르지만, 둘 다 정산이
성공하기 전에 리소스 핸들러를 실행하지 않는다.

## 2. 클라이언트의 자산 허용과 상한

최신 `x402Client`는 기본 자산이 아닌 토큰을 서명 전에 거절한다.
`createMapaeReferenceClient(provider, maxAmountPerPayment)`는 GIWA와 해당 토큰을
명시적으로 허용하고 건당 최소 단위 상한을 설정한다. 상한은 양수여야 한다.

```ts
import {wrapFetchWithPayment} from "@x402/fetch";
import {createMapaeDelegationProvider} from "@mapae/delegation/x402";
import {createMapaeReferenceClient} from "./reference-x402.js";

// sessionAccount, parentPermissionContext, environment and facilitatorAddresses
// come from the owner's grant and the operator's trusted configuration.
const provider = createMapaeDelegationProvider({
    account: sessionAccount,
    environment,
    parentPermissionContext,
    facilitatorAddresses,
});
const client = createMapaeReferenceClient(provider, 1_000_000n);
const paidFetch = wrapFetchWithPayment(fetch, client);
const response = await paidFetch(resourceUrl, {redirect: "error"});
```

별도 토큰과 `1000001` 이상 오퍼는 provider가 호출되기 전에 거절된다. 이 로컬 상한은
owner가 서명한 온체인 기간·총액 제한을 대체하지 않는다. `spendControls: false`로
보호를 끌 필요도 없다. 서명된 결제 헤더를 다른 오리진으로 전달하지 않도록 예제처럼
리다이렉트를 거절한다.

## 3. 미확정 결제와 검증 범위

참조 서버는 `settlement_pending`과 트랜잭션 해시를 받으면 **동일 payload로 한 번**
`/settle`을 재조회한다. 마패의 journal에는 같은 intent로 도달한다. 이 재조회에서
새 leaf를 서명하지 않는다. 여전히 미확정이거나 정산이 실패하면 리소스는 제공하지 않는다.
호출자가 결제 결과를 모른 채 새 결제를 시작해서는 안 된다.

`x402-reference.test.ts`는 실제 참조 fetch·Hono 어댑터, 오퍼 구성, 클라이언트 선택,
세션키 leaf 서명, 마패 payload 검증, 응답 헤더를 함께 실행한다. 체인 경계는 stub이며
root 서명은 테스트 값이다. 따라서 이 테스트는 온체인 정산 성공을 대신 증명하지 않는다.
기존 Framework/EVM 테스트가 그 경계를 별도로 검증한다.

```bash
cd packages/delegation
bun test src/x402-reference.test.ts
```

SDK·ABI 버전은 위 표처럼 갱신했지만 배포된 Framework 1.3.0의 composition ID·주소·
원본 패키지 integrity는 배포 증거다. `assertInstalledFrameworkBytecodes`와
`make -C contracts framework-test`가 새 설치본의 bytecode를 기존 구성과 대조한다.
SDK 버전 변경만으로 컨트랙트를 재배포하거나 권한을 다시 서명하지 않는다.

공식 자료:

- [x402 core 변경 기록](https://github.com/x402-foundation/x402/blob/main/typescript/packages/core/CHANGELOG.md)
- [MetaMask x402 구현](https://github.com/MetaMask/smart-accounts-kit/tree/main/packages/x402)
- [ERC-7710](https://ercs.ethereum.org/ERCS/erc-7710): 위임 상환 인터페이스
- [ERC-7715](https://ercs.ethereum.org/ERCS/erc-7715): 지갑 권한 요청 API; 마패는 현재 직접 EIP-712 서명 사용
