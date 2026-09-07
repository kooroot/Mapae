# facilitator-erc7710

ERC-7710 위임 결제의 검증·정산 서비스. 판매자가 `/verify`로 넘긴 결제를 시뮬레이션하고,
`/settle`에서 `redeemDelegations`를 대신 브로드캐스트해 가스를 낸다. 정산 결과는
`@mapae/store` 파일에 원장으로 남고, 그날 쓴 가스도 같은 파일에 남는다.

## 환경 변수

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `STORE_PATH` | `./data/facilitator.sqlite` | 정산 원장과 그날 쓴 가스를 남기는 `@mapae/store` 파일. `:memory:`는 드라이런용 — 재시작하면 아무것도 남지 않는다 |
| `METRICS_TOKEN` | (없음) | 없으면 `GET /metrics`는 `503 metrics_disabled`. 16자 이상으로 두면 `Authorization: Bearer <token>`에 답한다 |
| `RELAYER_DAILY_WEI` | `500000000000000` (0.0005 ETH) | 정산 서명자가 하루(UTC)에 쓸 수 있는 가스 상한, wei |
| `RELAYER_PAYER_DAILY_WEI` | `RELAYER_DAILY_WEI / 10` | payer 한 명이 하루에 쓰게 하는 가스 몫, wei. `RELAYER_DAILY_WEI`보다 크면 기동을 거부한다 |
| `FACILITATOR_RATE_PER_HOUR` | `600` | 한 IP가 한 시간에 `/verify`와 `/settle`을 합쳐 부를 수 있는 횟수 |
| `MAX_SETTLEMENT_AMOUNT` | `10.00` | 한 번에 정산하는 결제 금액 상한(tUSDC). 온체인 caveat이 본 통제고, 이것은 백스톱이다 |

나머지 변수(서명자 키·주소, RPC, 바인드, 가스 상한, 영수증 타임아웃)는
`.env.example`에 있다.

## 일일 가스 예산

온체인 caveat은 payer의 돈을 묶지만 서명자의 가스는 묶지 못한다 — 유효한 위임을 든
payer는 위임이 허락하는 만큼 정산을 요구할 수 있다. 그래서 `/settle`은 가스 견적 뒤,
브로드캐스트 전에 `가스 × maxFeePerGas`를 예산에서 먼저 잡는다.

예산은 둘이다. payer별 몫(`RELAYER_PAYER_DAILY_WEI`)을 먼저 잡고, 그다음 그날 총액
(`RELAYER_DAILY_WEI`)을 잡는다. 총액 하나만 있던 동안은 `/settle`이 누구의 어떤 결제든
받으므로, 무료 테스트넷 tUSDC로 자기 자신에게 결제하는 payer 하나가 그날치(약 1,500건)를
공짜로 다 쓰고 다른 판매자 전부가 UTC 자정까지 `budget_exhausted`를 받았다. 몫이 있으면
하루를 말리는 데 자금 든 위임 열 개가 필요하고, 아홉 개까지는 남들 자리가 남는다.
payer별 몫도 `STORE_PATH`의 `payer:<주소>` 시리즈에 남아 재시작을 견디고, 하루 동안
정산이 없는 payer는 메모리에서 비운다(다음 결제 때 파일에서 다시 읽는다).

| 상황 | 예산 처리 | 응답 |
| --- | --- | --- |
| payer 몫이 모자람 | 아무것도 잡지 않음, 브로드캐스트 없음 | `200 {success: false, errorReason: "payer_budget_exhausted"}`, 원장에 `rejected` |
| 그날 총액이 모자람 | payer 몫의 예약을 `0`으로 풀고 브로드캐스트 없음 | `200 {success: false, errorReason: "budget_exhausted"}`, 원장에 `rejected` |
| 영수증 도착 | 영수증의 실제 비용(L1 데이터 수수료 포함)을 두 예산에 같이 정산 | 정상 흐름 |
| 브로드캐스트가 해시를 못 냄 | 두 예산 모두 `0` 정산(예약 해제) | `settlement_unconfirmed` |
| 해시는 있는데 영수증이 없음 | 예약 전액을 두 예산에 그대로 청구 | `settlement_unconfirmed` |

거절은 다른 정산 실패와 같은 모양(200 + `success: false`)으로 나간다. 판매자
클라이언트는 2xx가 아닌 응답을 "답을 잃었다"로 읽고 구매자에게 결제 상태를 *unknown*으로
알리는데, 아무것도 브로드캐스트하지 않은 거절은 그렇게 불려선 안 된다.

그날 쓴 총액은 `STORE_PATH`에 남아 재시작해도 이어진다. 죽였다 살린 뒤 `/metrics`가
같은 값을 내는지는 `restart.test.ts`가 파일 스토어를 닫고 다시 열어 확인한다.

## 요청 제한

`POST /verify`와 `POST /settle`은 본문을 읽기 전, 프레임워크 검증보다 먼저 IP별 고정
창(한 시간, `FACILITATOR_RATE_PER_HOUR`회)을 센다. 키는 `CF-Connecting-IP` 헤더 —
터널이 유일한 공개 경로고 cloudflared가 늘 붙이므로, 헤더 없는 요청은 루프백에서 온
것(같은 머신의 호스티드 상점)이라 세지 않는다. 결제 하나는 `/verify` 한 번과 `/settle`
한 번이라 기본값은 IP당 시간 300건 — 그날 가스 예산이 정산할 수 있는 수보다 많다.

넘친 요청은 RPC 큐에 아무것도 넣지 않고 원장에도 남지 않으며, 다른 거절처럼 200으로 답한다.

| 경로 | 응답 |
| --- | --- |
| `/verify` | `200 {isValid: false, invalidReason: "rate_limited"}` |
| `/settle` | `200 {success: false, network, errorReason: "rate_limited"}` |

본문 크기는 두 번 잰다. Bun의 `maxRequestBodySize`(200,000바이트)는 Content-Length가
상한을 넘으면 핸들러 전에 빈 `413`을 내고, Content-Length 없는 청크 본문은 상한에서 읽기를
끊어(`c.req.text()`가 거부) 역시 `413`을 낸다 — 버퍼링을 없애는 게 아니라 200 KB로 묶는
것이고, 없으면 Bun 기본값 128 MB까지 쌓인다. 읽은 뒤의 150,000자 검사는 `JSON.parse`에
넘길 문자열을 재고 200 본문으로 거절한다.
결제 본문은 ASCII라 문자 상한 아래면 바이트 상한 아래이므로, 413은 이 서비스의 어떤
클라이언트도 만들지 않는 본문에만 나간다.

## `/metrics`

`METRICS_TOKEN`으로 잠긴 운영자 엔드포인트. 모든 수는 십진 문자열이다.

```json
{
  "last24h": {"total": 12, "succeeded": 11, "failed": 1, "volumeByPayTo": {"0x…": "1100000"}, "uniquePayers": 3},
  "allTime": {"total": 240, "succeeded": 231, "failed": 9, "volumeByPayTo": {"0x…": "23100000"}, "uniquePayers": 17},
  "budget": {"day": "2026-09-01", "limitWei": "500000000000000", "spentWei": "12345000000000", "remainingWei": "487655000000000"}
}
```

- `last24h` / `allTime` — 원장 요약. `volumeByPayTo`는 정산된 금액(base 단위)을 수취인별로 합한 것.
- `budget.day` — 수치가 속한 UTC 날짜. `spentWei`는 영수증이 청구한 합, `remainingWei`는
  진행 중인 예약까지 뺀 값이라 브로드캐스트 도중에는 `limit - spent`와 다르다. 마지막
  영수증이 예약보다 비싸면 `spentWei`가 `limitWei`를 넘고 `remainingWei`는 `"0"`이다.

## `/health`

터널을 통해 공개된 엔드포인트. 프레임워크 검증 실패 이유는 닫힌 집합으로만 나가고,
가린 원문은 운영자 로그(`[readiness]`)에 남는다 — 자유 문장이던 동안 RPC 호스트명과
viem 버전 문구가 그대로 새어 나갔다.

| `frameworkError` | 뜻 |
| --- | --- |
| `null` | 검증 통과 |
| `rpc_unreachable` | RPC가 답하지 않았다(전송 실패, 타임아웃, 재시도를 넘긴 rate limit) |
| `owner_mismatch` | 배포 아티팩트의 관리자가 `FRAMEWORK_ADMIN_ADDRESS`와 다르다 |
| `framework_paused` | DelegationManager가 멈춰 있다 |
| `verification_failed` | 그 밖의 모든 것 — 체인 ID, 런타임 코드, NAME/VERSION, 라이브 관리자 상태 |

프레임워크 검증과 서명자 잔고는 각각 5초 창에 한 번만 읽고, 실패도 값처럼 캐시한다.
공개 경로에 요청 제한이 없는 대신 창당 프로브 하나가 RPC 큐에 들어가는 전부다.
예산은 내보내지 않는다 — "오늘 얼마나 남았나"는 하루를 말리는 게 남는 장사인지 재는
숫자라 `/metrics` 토큰 뒤에 둔다.

## 기동

```bash
cp .env.example .env   # 서명자 키·주소, METRICS_TOKEN
bun run dev
```

## 검증

```bash
bun test apps/facilitator-erc7710   # 요청 제한·payer 몫·/health 분류 + /metrics 순수 함수 + 재시작 증명
```
