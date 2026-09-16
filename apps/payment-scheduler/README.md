# 예약 결제 에이전트

같은 판매자 리소스를 고정 간격으로 구매한다. 실행 시간, 수취인, 건당 금액, 누적 금액,
실행 횟수를 모두 명시해야 한다. 실제 결제는 기존 위임 에이전트 runtime과 결제 클라이언트를
사용하므로 부모 위임의 온체인 한도·만료·철회도 그대로 적용된다.

저장소 루트에서 실행한다. 실행에는 `apps/delegated-agent`와 같은 환경 설정과 권한 파일이
필요하다. 아래 관리 명령은 키나 RPC 없이 사용할 수 있다. `SCHEDULER_DB_PATH` 기본값은
`./data/scheduler.sqlite`이며 다른 서비스의 DB와 분리한다.

```bash
bun run apps/payment-scheduler/index.ts add schedule.json
bun run apps/payment-scheduler/index.ts list
bun run apps/payment-scheduler/index.ts runs coffee
bun run apps/payment-scheduler/index.ts cancel coffee
bun run apps/payment-scheduler/index.ts tick  # 현재 도래한 작업을 한 번 처리
bun run apps/payment-scheduler/index.ts run   # 1초 간격 확인, SIGINT/SIGTERM으로 종료
```

`schedule.json` 예시다. 시간은 UTC epoch 밀리초, 금액은 토큰 base 단위(6 decimals)다.
실제 수취인과 시작·종료 시각을 지정한 뒤 등록한다.

```json
{
  "id": "coffee",
  "resourcePath": "/s/demo-cafe/americano",
  "payTo": "0x2000000000000000000000000000000000000001",
  "maxAmountBase": "1000000",
  "maxTotalBase": "5000000",
  "maxRuns": 5,
  "startsAt": 1789344000000,
  "endsAt": 1789948800000,
  "intervalMs": 86400000,
  "maxAttempts": 2,
  "retryDelayMs": 60000
}
```

리소스는 설정된 판매자 origin 안의 단순 경로만 허용한다. 쿼리·자격증명·외부 URL은
저장하지 않는다. 조건은 서명 전에 확인하고, 서명 도중 취소·만료되면 헤더를 전송하지 않는다.
이미 전송 중인 결제는 취소가 되돌릴 수 없으며 결과와 비용은 계속 기록한다.

`maxRuns`는 예약 슬롯 수다. 같은 슬롯의 안전한 재시도는 `maxAttempts`로 제한한다.
밀린 슬롯은 건너뛰며 몰아서 결제하지 않는다. 누적 한도에 다음 건의 최대 금액을 예약할
공간이 없으면 완료 처리한다. 실제 결제 금액이 최대보다 작으면 차액을 돌려놓는다.

실행을 claim하는 순간 DB에 최대 금액을 예약하고 작업을 `paused`, 이력을 `unknown`으로
저장한다. 실행 중 또는 중단 직후에는 `IN_PROGRESS_OR_INTERRUPTED`로 보인다. 결과가
확인되면 실제 금액·거래 해시와 함께 다음 상태를 원자적으로 저장한다. 이 덕분에 두 worker가
같은 작업을 동시에 집어도 한 번만 실행하고, 프로세스가 죽어도 다음 기동이 새 leaf를 만들지
않는다. 비밀키·서명·권한 원문·구매한 리소스는 DB에 저장하지 않는다.

초기 연결 실패(`TRANSPORT_ERROR`)와 결제 거절 전의 일시 불가(`SELLER_UNAVAILABLE`)만
자동 재시도한다. 결제 결과 미확정, 전송 후 응답 해석 실패 또는 실행 중단은 예약을 유지하고
멈춘다. `paused` 작업은 자동 재개하지 않는다. 원래 결제/체인 상태를 확인한 후 기존 작업을
취소하고, 남은 예산으로 새 작업을 명시적으로 등록해야 한다. 새 작업의 한도는 독립적이다.

검증: `bun run test:scheduler`. 공개 체인 송금은 하지 않고 실제 결제 클라이언트의
402→서명→요청 흐름과 파일 DB 재시작·경합·취소·한도·재시도 처리를 검사한다.
