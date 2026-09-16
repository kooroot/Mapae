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
| `RELAYER_PAYER_DAILY_WEI` | `RELAYER_DAILY_WEI / 10` | payer 한 명이 하루에 쓰게 하는 가스 몫, wei. `RELAYER_DAILY_WEI`보다 크면 기동을 거부하고, `RELAYER_DAILY_WEI`가 10 wei 미만이면 기본값이 없으므로 직접 정해야 한다 |
| `FACILITATOR_RATE_PER_HOUR` | `600` | 한 IP가 한 시간에 `/verify`와 `/settle`을 합쳐 부를 수 있는 횟수 |
| `MAX_SETTLEMENT_AMOUNT` | `10.00` | 한 번에 정산하는 결제 금액 상한(tUSDC). 온체인 caveat이 본 통제고, 이것은 백스톱이다 |

나머지 변수(서명자 키·주소, RPC, 바인드, 가스 상한, 영수증 타임아웃)는
`.env.example`에 있다.

## 일일 가스 예산

온체인 caveat은 payer의 돈을 묶지만 서명자의 가스는 묶지 못한다 — 유효한 위임을 든
payer는 위임이 허락하는 만큼 정산을 요구할 수 있다. 그래서 `/settle`은 가스 견적 뒤,
브로드캐스트 전에 `가스 × maxFeePerGas`를 예산에서 먼저 잡는다.

총액(`RELAYER_DAILY_WEI`)과 payer별 몫(`RELAYER_PAYER_DAILY_WEI`)을 검사하고,
결제 기록·nonce·두 예약을 하나의 SQLite 트랜잭션으로 저장한다. 어느 한도가 부족하거나
쓰기 하나가 실패하면 전부 롤백하고 전송하지 않는다. 재시작해도 미확정 예약이 남는다.

| 상황 | 예산 처리 | 응답 |
| --- | --- | --- |
| 시뮬레이션·가스 견적·수수료 견적 중 RPC가 답하지 않음 | 예약 전, 브로드캐스트 없음 | `200 {success: false, errorReason: "facilitator_not_ready"}`, 원장에 행 없음 — 판정이 없었다 |
| 시뮬레이션이 revert하거나 가스 상한을 넘음 | 예약 전, 브로드캐스트 없음 | `200 {success: false, errorReason: "delegation_rejected"}`, 원장에 `rejected` |
| payer 몫이 모자람 | 아무것도 잡지 않음, 브로드캐스트 없음 | `200 {success: false, errorReason: "payer_budget_exhausted"}`, 원장에 `rejected` |
| 그날 총액이 모자람 | 두 예약과 결제 기록 모두 저장하지 않고 브로드캐스트 없음 | `200 {success: false, errorReason: "budget_exhausted"}`, 원장에 `rejected` |
| 영수증 도착 | 영수증의 실제 비용(L1 데이터 수수료 포함)을 두 예산에 같이 정산 | 정상 흐름 |
| RPC 전송 응답을 잃음 | 전송 전에 로컬에서 계산한 해시와 예약 전액을 보존 | 해시를 포함한 `settlement_unconfirmed`, 복구 기록을 미확정으로 유지 |
| 해시는 있는데 영수증이 없음 | 예약 전액을 두 예산에 그대로 청구 | `settlement_unconfirmed`, 복구 기록을 미확정으로 유지 |
| 채굴된 거래가 revert | 실제 가스 비용 정산 | `settlement_reverted`, 해시·가스를 포함한 `error` 원장 |
| 채굴됐는데 영수증에 판매자 앞 `Transfer`가 없음 | 영수증의 실제 비용을 청구 | `vendor_not_credited`, 원장에 `error` |

거절은 다른 정산 실패와 같은 모양(200 + `success: false`)으로 나간다. 판매자
클라이언트는 2xx가 아닌 응답을 "답을 잃었다"로 읽고 구매자에게 결제 상태를 *unknown*으로
알리는데, 아무것도 브로드캐스트하지 않은 거절은 그렇게 불려선 안 된다.

그날 쓴 총액은 `STORE_PATH`에 남아 재시작해도 이어진다. 죽였다 살린 뒤 `/metrics`가
같은 값을 내는지는 `restart.test.ts`가 파일 스토어를 닫고 다시 열어 확인한다.

## 재시작 후 정산 복구

`settlement_intents`에 거래 해시와 서명하지 않은 거래 필드(nonce, gas, 수수료,
chain, signer)를 전송 전에 저장한다. 서명 원문·permission context·개인키는 저장하지 않는다.
동일 결제가 다시 제시되면 먼저 원래 영수증을 조회한다. 없으면 제시된 결제와 저장한 필드로
재서명하고, **해시가 원래 값과 정확히 같을 때만** 동일 거래를 재전송한다. 기록 후 전송 전
프로세스가 죽어도 이 경로로 복구한다. 재시작 시 노드가 모르는 예약 nonce도 재사용하지 않는다.

재요청의 `/verify`는 기록된 결제를 재시뮬레이션하지 않는다. `/settle`은 영수증 상태와
판매자 앞 정확한 `Transfer`를 확인한다. 성공·채굴 revert·미입금 결과 모두 원장에 한 번만
기록하고, 실제 비용(L1 수수료 포함)을 **최초 예약한 UTC 날짜**의 두 예산에 원자적으로
반영한다. 자정이나 재시작 뒤에도 같다. 원장 쓰기 실패는 미확정 기록을 남겨 재시도한다.

영수증·저장소·재구성 해시를 확인할 수 없으면 `settlement_unconfirmed`다. `/verify`에서도
이유를 명시하며 판매자는 504 `settlement_unknown`으로 전달한다. 새 leaf로 재결제하지 않는다.
미확정 상태는 terminal 원장을 늘리지 않는다. 복구는 같은 결제를 다시 제시해야 실행되며,
원문을 저장하지 않으므로 입력 없이 백그라운드에서 재전송하지 않는다. 결제 기록은 만료되지
않고, 같은 signer는 한 facilitator 프로세스에서만 사용한다. 다른 서비스와 키를 공유하지 않는다.

## 저장소와 배포

현재 저장소는 **스키마 6**다. 이전 파일을 자동 변환하거나 초기화하지 않으며,
이전 스키마를 지정하면 기동을 거부한다. 운영 DB 교체는 기존 원장·주문·예산 보존과
미확정 정산 처리를 먼저 결정해야 한다. 기존 파일을 삭제하면 과거 티켓 조회와
가스 예산, 재결제 방지 근거를 잃으므로 배포 명령에 삭제를 넣지 않는다.
새 인스턴스의 `STORE_PATH`는 처음부터 스키마 6로 생성된다.

환경변수는 `FACILITATOR_SIGNER_ADDRESS`와 `FACILITATOR_SIGNER_PRIVATE_KEY`만
사용한다. `RELAYER_ADDRESS`·`RELAYER_PRIVATE_KEY`가 남아 있으면 기동을 거부한다.

## 요청 제한

`POST /verify`와 `POST /settle`은 본문을 읽기 전, 프레임워크 검증보다 먼저 IP별 고정
창(한 시간, `FACILITATOR_RATE_PER_HOUR`회)을 센다. 키는 `CF-Connecting-IP` 헤더 —
터널이 유일한 공개 경로고 cloudflared가 늘 붙이므로, 헤더 없는 요청은 루프백에서 온
것이다. 루프백에서 공개 인터넷을 대신 부르는 호출자(같은 머신의 호스티드 상점)는
구매자의 `CF-Connecting-IP`를 `X-Mapae-Client-IP`에 실어 보내고 그 구매자로 센다.
`CF-Connecting-IP`가 있으면 그 헤더는 무시하므로 터널을 거친 요청이 남을 사칭할 수는
없다. 아무도 이름 대지 않은 루프백 요청은 우리 서비스라 세지 않는다. IPv6 주소는 /64
단위로 센다 — 회선 하나가 받는 최소 할당이 /64라, 그 안에서 주소를 돌리면 매 요청이
새 키가 되어 한도에 닿지 않는다. 결제 하나는 `/verify` 한 번과 `/settle`
한 번이라 기본값 600회는 IP당 시간 결제 300건 — 그날 가스 예산이 정산할 수 있는
수보다 많다.

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

## 원장 보존

`/settle`이 거절한 서명된 결제는 원장에 `rejected` 행으로 남는다. 요청 제한은 그 행이
쌓이는 속도를 묶지 개수를 묶지 않아, 느긋한 공격자는 sqlite 파일을 끝없이 키울 수 있었다.
그래서 `rejected` 행은 7일(`REJECTED_SETTLEMENT_RETENTION_MS`)만 두고, 그 안에서도 최신
50,000건(`REJECTED_SETTLEMENTS_KEPT`)까지만 둔다. 개수는 요청 제한의 최악에서 잰 것이다 —
IP 하나(IPv6는 /64 하나)가 하루에 600회/시 × 24시간 = 14,400행, 행당 약 200 B로 3 MB쯤이니
50,000건은 그런 IP-일 셋 반, 약 10 MB이고, 지속되는 홍수 아래서는 일주일이 아니라 개수가
먼저 묶는다. 제한의 키는 payer가 아니라 IP라 개수 상한이 필요한 것이다 — 주소 많은 payer
하나는 창 여럿이다. `settled`와 `error` 행은 절대 지우지 않는다 — 돈이 움직였거나 움직였을 수 있고,
원장이 그 유일한 기록이다.

기동 때 한 번, 그 뒤 매시간(`unref`된 타이머라 프로세스를 붙들지 않는다)
`rejectedRetention(now)`(`metrics.ts`)이 계산한 컷오프와 상한으로 `Ledger.prune`을
부르고, 지운 행이 있을 때만 `[ledger] pruned N rejected settlement events`를 남긴다.
지우기가 실패해도(파일 잠김, 디스크 가득) 서비스는 내려가지 않고 로그만 남는다 —
못 쓴 원장 행과 같은 취급이다.

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
  `succeeded`·`volumeByPayTo`·`uniquePayers`는 두 창 모두 빠짐없이 세지만, `failed`와
  `total`은 `rejected` 행을 보존 범위(위 "원장 보존": 7일, 최대 50,000건) 안에서만 센다 —
  두 창 다 그렇다. 일주일보다 오래된 거절은 `allTime`에서 빠지고, 지속되는 홍수 아래서는
  개수가 먼저 묶인다: 600회/시 한도의 IP 넷이면 하루에 57,600행이라 매시간 지우기가
  하루도 안 된 행을 잘라 `last24h`도 실제보다 적게 센다.
- `budget.day` — 수치가 속한 UTC 날짜. `spentWei`는 실제 비용과 미확정 예약의 합이다. `remainingWei`는
  `max(0, limit - spent)`로 계산한다. 마지막
  영수증이 예약보다 비싸면 `spentWei`가 `limitWei`를 넘고 `remainingWei`는 `"0"`이다.

## `/health`

터널을 통해 공개된 엔드포인트. 프레임워크 검증 실패 이유는 닫힌 집합으로만 나가고,
가린 원문은 운영자 로그(`[readiness]`)에 남는다 — 자유 문장이던 동안 RPC 호스트명과
viem 버전 문구가 그대로 새어 나갔다.

| `frameworkError` | 뜻 |
| --- | --- |
| `null` | 검증 통과 |
| `rpc_unreachable` | RPC가 답하지 않았다(전송 실패, 타임아웃, 재시도를 넘긴 rate limit) |
| `owner_mismatch` | 배포 아티팩트의 관리자가 `FRAMEWORK_ADMIN_ADDRESS`와 다르거나, 라이브 owner가 그와 다르거나, 소유권 이전이 걸려 있다(pending owner) |
| `framework_paused` | DelegationManager가 멈춰 있다 |
| `verification_failed` | 그 밖의 모든 것 — 체인 ID, 런타임 코드, NAME/VERSION |

`frameworkPaused`는 이 분류에서 끌어낸다 — 검증은 멈춘 관리자에서 던지므로 통과했으면
`false`, `frameworkError`가 `framework_paused`면 `true`, 그 밖의 실패는 멈춤에 대해
아무 말도 못 하므로 `null`. 검증이 던진 뒤에는 읽을 플래그가 없어서, 전에는 운영자가
일부러 당긴 멈춤이 이 필드에서만 `null`이었다.

프레임워크 검증과 서명자 잔고는 각각 5초 창에 한 번만 읽고, 진행 중인 읽기는 그때 온
호출자들이 함께 쓴다. 잔고 읽기는 실패도 값처럼 캐시한다 — 공개 경로에 요청 제한이 없는
대신 창당 프로브 하나가 RPC 큐에 들어가는 전부다. 프레임워크 검증의 실패는 그 프로브를
함께 기다린 호출자에게만 가고 다음 호출자는 다시 읽는다: 열 번의 읽기 중 하나가 타임아웃난
것이 5초 동안 모든 판매자를 거절하는 일이 되어선 안 된다.

프로브가 실패한 호출자는 판정 없이 돌려보낸다 — 위임을 본 적이 없으니
`delegation_rejected`라 부르지 않는다. 판매자 사다리는 둘 다 503 `facilitator_unavailable`
(청구된 것 없음, 나중에 같은 결제로 재시도)로 읽는다.

| 경로 | 응답 |
| --- | --- |
| `/verify` | `503 {isValid: false, invalidReason: "facilitator_not_ready"}` — 2xx가 아니면 판매자는 unavailable로 읽는다 |
| `/settle` | `200 {success: false, network, errorReason: "facilitator_not_ready"}` — 2xx가 아니면 "답을 잃었다"가 되므로 본문으로 말한다 |

프로브를 통과한 뒤 시뮬레이션·가스 견적·수수료 견적 중에 RPC가 죽어도 같은 답이다
(`beforeBroadcast`가 그 단계의 전송 실패를 `RpcUnreachableBeforeBroadcast`로 올린다).
브로드캐스트 전이라 청구된 것이 없고 판정도 없으므로 두 경로 모두 위 표대로 답하고,
`/settle`은 원장에 아무 행도 남기지 않는다 — 준비 프로브가 막은 요청과 똑같이. 전에는
`/settle`이 이것을 `delegation_rejected`와 `rejected` 행으로 답해, 아무도 거절하지 않은
위임을 구매자가 다시 서명하러 갔다. `sendRawTransaction`부터는 다르다: 노드가 트랜잭션을
받았을 수 있으므로 거기서의 전송 실패는 `settlement_unconfirmed`로 남는다.

예산은 내보내지 않는다 — "오늘 얼마나 남았나"는 하루를 말리는 게 남는 장사인지 재는
숫자라 `/metrics` 토큰 뒤에 둔다.

## 기동

```bash
cp .env.example .env   # 서명자 키·주소, METRICS_TOKEN
bun run dev
```

## 검증

```bash
bun test apps/facilitator-erc7710   # 요청 제한·payer 몫·정산 실패 분류·/health 분류 + /metrics 순수 함수·원장 보존 + 재시작 증명
```

실제 프로세스 장애 검증은 저장소 루트에서 `bun run test:e2e:recovery`로 실행한다.
Anvil의 공개 테스트 키와 루프백 RPC만 사용하며 HTTP 라우트·복구·가스 회계를 검사한다.
이 fixture의 송금은 native ETH다. 위임/토큰 권한 검증 자체는 delegation-lab의
`bun run test:negative`가 별도로 검증한다. 둘 다 CI에서 실행한다.
