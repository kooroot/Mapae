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
| `MAX_SETTLEMENT_AMOUNT` | `10.00` | 한 번에 정산하는 결제 금액 상한(tUSDC). 온체인 caveat이 본 통제고, 이것은 백스톱이다 |

나머지 변수(서명자 키·주소, RPC, 바인드, 가스 상한, 영수증 타임아웃)는
`.env.example`에 있다.

## 일일 가스 예산

온체인 caveat은 payer의 돈을 묶지만 서명자의 가스는 묶지 못한다 — 유효한 위임을 든
payer는 위임이 허락하는 만큼 정산을 요구할 수 있다. 그래서 `/settle`은 가스 견적 뒤,
브로드캐스트 전에 `가스 × maxFeePerGas`를 그날 예산에서 먼저 잡는다.

| 상황 | 예산 처리 | 응답 |
| --- | --- | --- |
| 예산이 모자람 | 아무것도 잡지 않음, 브로드캐스트 없음 | `200 {success: false, errorReason: "budget_exhausted"}`, 원장에 `rejected` |
| 영수증 도착 | 영수증의 실제 비용(L1 데이터 수수료 포함)으로 정산 | 정상 흐름 |
| 브로드캐스트가 해시를 못 냄 | `0` 정산(예약 해제) | `settlement_unconfirmed` |
| 해시는 있는데 영수증이 없음 | 예약 전액을 그대로 청구 | `settlement_unconfirmed` |

거절은 다른 정산 실패와 같은 모양(200 + `success: false`)으로 나간다. 판매자
클라이언트는 2xx가 아닌 응답을 "답을 잃었다"로 읽고 구매자에게 결제 상태를 *unknown*으로
알리는데, 아무것도 브로드캐스트하지 않은 거절은 그렇게 불려선 안 된다.

그날 쓴 총액은 `STORE_PATH`에 남아 재시작해도 이어진다. 죽였다 살린 뒤 `/metrics`가
같은 값을 내는지는 `restart.test.ts`가 파일 스토어를 닫고 다시 열어 확인한다.

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

`/health`는 공개 엔드포인트라 예산을 내보내지 않는다 — "오늘 얼마나 남았나"는 하루를
말리는 게 남는 장사인지 재는 숫자다.

## 기동

```bash
cp .env.example .env   # 서명자 키·주소, METRICS_TOKEN
bun run dev
```

## 검증

```bash
bun test apps/facilitator-erc7710   # /metrics 순수 함수 + 재시작 증명
```
