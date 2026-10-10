# 마패 Guardians: 30명, 14일 파일럿

목표는 실제 사람이 캐릭터를 돌보려고 다시 찾아오는지 확인하는 것이다. 트랜잭션을 늘리는 자동 반복 실행이나 뽑기 보상 경쟁을 성공 조건으로 삼지 않는다. 아래 수치는 이번 실험의 의사결정 기준이며, 가속 프로그램의 공식 평가 기준이나 업계 평균이 아니다. 현재 파일에 실제 모집·이용 성과는 기록되어 있지 않다.

실제 배포와 난수 콜백 확인은 운영자가 [Mac mini 배포 안내](arcade-guardians-release.md)를 실행한다. 배포 canary를 통과한 후에 모집을 시작한다. 이 문서나 보고 도구는 배포·메시지 발송·트랜잭션 전송을 수행하지 않는다.

## 실험과 일정

지갑 경험이 있는 사용자 15명과 없는 사용자 15명을 목표로, 운영자가 연락 가능한 커뮤니티에서 동의한 **실제 사람 30명**을 모집한다. 여러 지갑이나 브라우저를 여러 사람으로 세지 않는다. 30명은 지표 도구가 증명하는 인원수가 아니라 운영자가 확인하는 모집 코호트다. 연락처는 보고서에 넣지 않고 임의 참가 코드와 관찰 기록만 별도 보관한다.

| 시점 | 행동 | 확인할 가설 |
| --- | --- | --- |
| 시작 전 | 5명으로 지갑 없는 무료 게임, 뽑기 비용 이해, 외출 예산·중지 UI를 관찰한다. 이 사전 테스트는 본 코호트와 분리한다. | 첫 체험에서 지갑이 진입을 막지 않는다. |
| 1–2일 | 30명에게 같은 짧은 안내를 제공한다. 무료 게임 → 캐릭터 뽑기 → 한 번의 제한된 외출을 사용자가 선택한다. | 21명 이상이 무료 게임을 완료하고, 15명 이상이 첫 검증된 유료 외출을 완료한다. 자금은 테스트 mUSDC다. |
| 3–7일 | 공개된 성향·게임 적성과 결과를 보고 다음 게임이나 목표를 바꿀 수 있게 한다. 같은 빈도의 한 번짜리 안내만 제공한다. | 성장 기록과 운영 선택이 자발적 재방문 이유가 된다. 성숙한 브라우저 코호트 D1 목표는 35% 이상이다. |
| 8–14일 | 신규 기능·금전 보상을 추가하지 않고 재방문과 실패 이유를 관찰한다. 8–10명에게 돌아온 이유 또는 그만둔 이유를 짧게 묻는다. | 성숙한 브라우저 코호트 D7 목표는 20% 이상, 14일째 `repeatOperatorsLast7Days`는 8개 이상이다. |

목표마다 분자와 분모를 함께 기록한다. 참가자 30명의 활성화는 참가 코드로 확인한 사람 기준이고, 도구의 D1/D7는 브라우저 기준이라 서로 같은 분모가 아니다. 30명 규모에서 통계적 유의성이나 장기 유지율을 주장하지 않는다. 첫 외출 목표를 넘겨도 D7가 낮다면 추가 거래 유도보다 결과 이해·목표 선택·재방문 이유부터 개선한다. 무료 게임 완료가 낮으면 뽑기 홍보를 확대하기 전에 첫 화면을 고친다.

## 지표의 의미

| 보고 필드 | 집계와 해석 |
| --- | --- |
| `engagement.daily[].browser_dau` | 의도적인 화면 상호작용을 보고한 고유 1차 브라우저 ID. 클라이언트 보고이므로 실제 사람 수를 보장하지 않는다. |
| `engagement.daily[].owner_dau` | 인증된 세션에서 사람의 화면 조작 또는 전면 SIWE 로그인을 기록한 지갑 수. 백그라운드 에이전트 실행과 폴링은 제외한다. 여러 지갑을 가진 사람은 중복될 수 있다. |
| `engagement.matureRetention.d1/d7` | 최초 관측일 코호트의 정확히 다음 날/7일 뒤 재방문. Asia/Seoul 기준 목표 날짜 전체가 끝나야 분모에 넣는다. 분모가 없으면 `rate:null`이며, 미성숙 코호트는 `immatureVisitors`로 따로 나온다. |
| `autonomous.daily[].autonomousOwnerWallets` | seller의 영구 결과 원장에 완료된 유료 입장이 있는 NFT 당시 소유자 수. 사람이 그날 접속했다는 의미가 아니다. |
| `repeatOperatorsLast7Days` | 최근 7개 서울 날짜 중 서로 다른 2일 이상 인증된 `operator_action`이 있고, 같은 기간 검증된 유료 외출 결과도 있는 지갑 수. 사람·NFT·거래 수와 분리한다. |
| `autonomous.sellerReportedPaidTransactions` | 해당 기간 seller의 모든 Arcade 결제 원장에서 중복 해시를 합친 수. NFT 외출만을 뜻하지 않는다. 블록체인 safe 확인 전 원장 증거다. |
| `autonomous.paidTransactionsWithoutCompletedResult` | 기간 내 paid 거래 중 같은 기간 NFT 외출 완료 결과가 없는 수. 일반 Arcade 결제나 기간 경계도 포함되므로 모두 장애라고 해석하지 않는다. |
| `chain.completeCounts` | 요청한 컬렉션 블록 구간과 제공한 결제 원장을 끝까지 확인했을 때만 제공하는 safe·정규 체인 집계. 불완전하면 `null`이다. |
| `chain.observedConfirmed` | 실제 확인한 mint 요청·난수 공개·성장 claim·결제 거래. 실패나 조회 제한이 있으면 확인한 일부만 담는다. `mintedTokens`와 `mintTransactions`는 다를 수 있다. |
| `chain.*.distinctTransactions` | `(chainId, transaction hash)`의 합집합. 하나의 거래가 결제·성장 등에 함께 나타나도 한 번만 센다. 난수 공개 거래는 `revealTransactions`로도 따로 표시한다. |
| `autonomous.testTokenPaidVolumeBaseUnits` | 해시 중복을 제거한 mUSDC 입장 금액. mUSDC는 소수 6자리이며 이 값은 매출이 아니다. |

기간은 오늘을 포함한 29개 서울 날짜이며 오늘은 부분 집계다. 원본 이벤트는 35일, 일별 이벤트 합계는 400일 보관한다. `engagement.totals`는 장기 이벤트 합계이고 DAU·유지율이 아니다. 실제 사람 확인, 유입 채널의 인과효과, NFT 구매 전환의 개인별 연결, 중복 계정 제거는 이 도구의 범위 밖이다.

`complete:true`는 제공한 자료와 **명시한 블록 구간**의 확인 완료만 뜻한다. 운영 canary·팀원·개발 활동은 같은 자료에 있으면 포함된다. 본 파일럿 모집 전후의 기록과 운영자 참가 기록을 대조하고, 혼합된 집계를 투자자용 “실사용자 30명”으로 제시하지 않는다. 테스트 fixture는 운영 DB에 넣지 않는다.

## 읽기 전용 보고서 만들기

Bun과 기존 저장소 의존성을 사용한다. 별도 패키지나 서버 API가 필요하지 않다. D1 내보내기는 로그인된 Wrangler가 있는 운영 환경에서 실행하며 운영 DB를 변경하지 않는다. 아래 절대 경로를 개인용 작업 디렉터리로 바꾼다. 원본에는 가명 브라우저 ID와 지갑이 있으므로 공유하지 않는다. JSON 보고서에는 지갑·브라우저·세션·토큰·거래 식별자를 출력하지 않는다.

1. `umask 077`을 설정하고 빈 개인용 디렉터리를 만든다. 저장소 루트에서 다음과 같이 세 테이블의 데이터만 내보낸다. 두 Worker가 같은 D1을 쓰므로 한 번만 추출한다.

   ```sh
   umask 077
   mkdir -p /absolute/private/guardian-pilot
   cd apps/web
   bun --no-env-file x wrangler d1 export ARCADE_DB --env landing --remote --no-schema --table arcade_engagement_visitors --table arcade_engagement_events --table arcade_engagement_daily --output /absolute/private/guardian-pilot/engagement.sql
   cd ../..
   ```

2. seller는 배포 안내의 SQLite `.backup` 절차로 **현재 시점의 일관된 사본**을 새 경로에 만든다. 실행 중인 SQLite 파일 하나만 `cp`하면 WAL의 결제가 빠질 수 있다. 이미 암호화한 최신 백업이 있다면 기존 복구 도구로 새로운 사본을 만든다. 운영 DB를 목적지로 지정하지 않는다.

   ```sh
   bun --no-env-file scripts/ops/backup.ts restore /absolute/private/seller-latest.enc /absolute/private/guardian-pilot/seller.sqlite /absolute/private/backup-key.txt
   ```

3. 두 추출의 시작·종료 시각과 git SHA를 운영 기록에 남긴다. `--as-of`는 추출을 마친 뒤의 명시적 ISO 시각으로 바꾼다. 아래 시각은 사용법 예시다. 스냅샷이 그 시각까지 수집되었다는 것은 운영자의 확인 사항이며, 두 소스의 추출 시차나 수집 중단은 별도로 설명해야 한다. 과거 시각을 지정해 미래 이벤트가 들어간 D1 사본을 소급 분석하려 하면 도구가 거부한다.

   ```sh
   bun --no-env-file scripts/arcade-guardians-report.ts --engagement-sql /absolute/private/guardian-pilot/engagement.sql --seller-db /absolute/private/guardian-pilot/seller.sqlite --as-of 2026-10-20T12:00:00+09:00 > /absolute/private/guardian-pilot/report.json
   ```

   D1의 일관된 SQLite 사본이 있으면 `--engagement-sql` 대신 `--engagement-db /absolute/private/engagement.sqlite`를 사용한다. SQL 덤프는 실행하지 않고 허용된 테이블의 리터럴 INSERT만 임시 메모리 DB에 읽는다. 스키마·트리거·임의 SQL이 섞인 덤프는 거부한다. 입력 파일에는 쓰지 않는다. SQL은 64 MiB·50만 행, seller 기간 내 각 원장은 50만 행까지 처리한다.

4. 체인 증거가 필요하면 배포 기록의 컬렉션 주소와 **확인할 블록 범위**를 지정한다. `FROM_BLOCK`은 해당 컬렉션 배포 블록 또는 설명 가능한 보고 시작 블록, `TO_BLOCK`은 조회 시점 safe 블록 이하로 정한다. safe 블록 번호는 다음 읽기 전용 명령으로 확인할 수 있다.

   ```sh
   cast block safe --field number --rpc-url https://sepolia-rpc.giwa.io
   bun --no-env-file scripts/arcade-guardians-report.ts --engagement-sql /absolute/private/guardian-pilot/engagement.sql --seller-db /absolute/private/guardian-pilot/seller.sqlite --as-of 2026-10-20T12:00:00+09:00 --chain --collection <배포한_NFT_주소> --from-block <FROM_BLOCK> --to-block <TO_BLOCK> > /absolute/private/guardian-pilot/report-chain.json
   ```

   공개 GIWA RPC만 읽는다. 지정 구간은 최대 100만 블록이며 2천 블록씩 조회한다. 한 구간 2만 로그 또는 결제 영수증 2천 개를 넘기면 완료로 표시하지 않는다. safe 이전의 정규 블록·성공 영수증·mUSDC의 정확한 payer/수취인/금액을 대조한다. 범위 밖 컬렉션 이벤트는 조사하지 않고 결제는 제공한 seller 원장에서 확인한다. 블록 시간으로 보고 기간 밖 이벤트도 제외한다. 전체 파일럿을 주장하려면 지정 범위가 파일럿 전체를 포함해야 한다. 제한 때문에 나눠 조사했다면 각 범위를 그대로 명시하고, 겹친 보고서의 거래·DAU·유지율을 단순 합산하지 않는다.

종료 코드는 `0`=모든 제공·요청 범위 확인 완료, `2`=JSON은 생성했지만 소스 누락 또는 불완전, `1`=명령 사용 오류다. 체인 확인을 생략한 3번 명령은 의도적으로 `2`를 반환한다. 먼저 `sources`, `chain.coverage`, `latestObservedEventAt`, 미성숙 분모를 확인한다. 소스 누락은 `null`이며 이용자 0명으로 해석하지 않는다.

## 14일째 결정

결과에는 모집한 실제 인원, 무료 게임·첫 외출 활성화 인원, 성숙한 D1/D7 분자·분모, 재방문 운영자 지갑 수, 확인한 거래와 조회 범위, 운영 장애, 돌아온 이유 3개를 함께 기록한다. 초기 1–2일 모집 코호트의 D7는 14일째 관측할 수 있지만 늦게 참여한 사람은 여전히 미성숙할 수 있다. 대상 30명 전체를 억지로 D7 분모에 넣지 않는다.

재방문 목표가 충족되고 사용자 인터뷰에서도 성향 선택과 성장 기록이 이유로 반복될 때 다음 100명 실험을 검토한다. 거래는 많지만 사람의 재방문이 적으면 자율 실행 빈도를 높이지 않고 게임 선택·성장 피드백을 다시 설계한다. 보고서와 참가 관찰 기록은 검토 후 보관 기한을 정해 삭제하고, 다음 실험에는 수집 목적에 필요한 항목만 남긴다.
