# account-bootstrap

배포 전 서명에서 payer 스마트계정을 대납 배포하고, 테스트넷 잔액을 채워 주는
스폰서 서비스.

새 사용자는 **아직 존재하지 않는** 계정에 대해 root 위임을 서명한다. 이
서비스가 서명에서 owner를 복원하고, `CREATE2(owner)`가 permission이 지목한
delegator와 일치할 때만 스폰서 가스로 계정을 배포한 뒤 테스트넷 tUSDC를
목표 잔액까지 민팅한다. 위임을 만들기 위해 GIWA ETH를 들어야 하는 사람은
아무도 없다.

요청 본문은 `{permissionContext}` 하나다. owner나 salt를 호출자에게 받으면
누구든 우리가 배포비를 낼 주소를 지명할 수 있으므로 받지 않는다 — 이 구조에서
호출자는 키 없이 풀 수 없는 고정점을 풀어야 한다. 응답은 닫힌 거절 enum만
내보내고, 서명은 오프라인에서 canonical 형식(low-s, `v ∈ {27,28}`)까지
검사한다.

## faucet 정책

정책은 `packages/delegation/src/faucet-policy.ts`에 있고 이 서비스는 그것을
적용만 한다.

- **목표 잔액까지 채운다.** 잔액이 1000 tUSDC(테스트넷, 실제 돈 아님) 미만이면
  부족분만큼 민팅해 1000으로 맞춘다. 이미 1000 이상이면 아무것도 하지 않는다.
  새로 배포하는 계정과 이미 배포된 계정 모두 같은 규칙이다 — 카운터팩추얼
  주소도 ERC-20 잔액을 가질 수 있으므로 배포 경로도 잔액을 읽고 부족분만 채운다.
- **계정당 24시간에 한 번.** 민팅이 실제로 확정된 시각부터 24시간이 열린다.
  거절은 아무것도 소모하지 않고, 민팅이 되돌아가거나 확인되지 않으면 창이
  열리지 않는다(실패 뒤 하루를 잠그는 것이 이중 민팅보다 나쁘다). 잔액이 이미
  목표 이상인 계정은 민팅 대상이 아니므로 거절되지 않는다.
- **기본 켬, 체인 핀은 배포 아티팩트에서.** `BOOTSTRAP_FAUCET_ENABLED`는
  `"false"`일 때만 끈다. 그리고 `DELEGATION_DEPLOYMENT_PATH`의 아티팩트가 적은
  `chainId`가 이 서비스가 서명하는 체인(GIWA Sepolia)과 같을 때만 켜진다 —
  코드에 체인 번호 리터럴은 없다.

`POST /bootstrap`의 결과는 세 갈래다.

| 상황 | 응답 |
| --- | --- |
| 계정 배포(+ 부족분 민팅) | `200 {status: "deployed", transaction, fundingTransaction?, mintedBase, targetBase}` |
| 이미 배포됨, 부족분 민팅 | `200 {status: "already_deployed", fundingTransaction, mintedBase, targetBase}` |
| 이미 배포됨, 잔액이 목표 이상 | `200 {status: "already_deployed", mintedBase: "0", targetBase}` |
| 이미 배포됨, 부족하지만 24시간 안에 이미 받음 | `429 {reason: "faucet_recently_used"}` |

`mintedBase`는 이 요청이 민팅한 base 단위(6 decimals) 문자열이고, `targetBase`는
faucet이 맞추는 목표 잔액이다(faucet이 꺼져 있으면 `"0"`). 배포 경로에서는
민팅이 실패해도 배포는 성공이므로 `mintedBase: "0"`으로 보고하고, 이미 배포된
계정에서는 민팅 자체가 요청이므로 예산 소진·스폰서 잔액 부족·민팅 실패를
그대로 거절로 낸다. Studio의 "테스트넷 잔액 받기" 버튼이 이 응답을 읽는다.

## 환경 변수

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `BOOTSTRAP_FAUCET_ENABLED` | `true` | `"false"`일 때만 끈다. 그 외 값은 부팅 거부 |
| `BOOTSTRAP_FAUCET_TARGET_BASE` | `1000000000` (= 1000 tUSDC) | 목표 잔액, base 단위 양의 정수 |
| `MAX_BOOTSTRAP_MINT_GAS` | `100000` | 민팅 1건의 가스 상한. 민팅 가스는 금액과 무관하다 |
| `BOOTSTRAP_DAILY_WEI` | `500000000000000` | 배포와 민팅을 합친 하루(UTC) 가스 예산 |
| `STORE_PATH` | `./data/bootstrap.sqlite` | 그날 쓴 가스를 남기는 `@mapae/store` 파일. `:memory:`는 드라이런용 |

나머지 변수(스폰서 키·승인 문구·RPC·바인드·오리진·수수료 상한)는
`.env.example`에 있다.

## 기동

```bash
cp .env.example .env   # 스폰서 키·승인 문구·예산 설정
bun run dev
```

서비스는 loopback에만 바인딩하며, 다음 중 하나라도 어긋나면 기동을 거부한다.

- `BOOTSTRAP_ENABLED`와 배포 조합에 묶인 승인 문구가 일치하지 않을 때
- 스폰서 주소가 relayer 또는 deployer와 같을 때 — 인증 없는 인터넷 요청에
  응답하는 키를 정산·배포 키와 공유하면 그리핑이 정산 중단으로 번진다
- faucet 스위치나 목표 잔액을 읽을 수 없을 때

그리핑의 상한은 계정당 24시간 1회의 faucet 창, 일일 가스 예산
(`BOOTSTRAP_DAILY_WEI` — 그날 쓴 총액은 `STORE_PATH`에 남아 재시작해도
이어진다), 그리고 일부러 작게 유지하는 스폰서 잔액이다. IP당
제한은 두지 않는다 — 키페어는 공짜이고 IP는 공유되므로 그리퍼를 막지도,
같은 사무실의 두 사람을 통과시키지도 못했다. 스폰서에는 위임 권한이 없어
payer 자금·한도·정산에는 닿지 못한다.

## 검증

```bash
cd ../delegation-lab
SUITE_FORK_BLOCK=$(cast block-number --rpc-url "$GIWA_SEPOLIA_RPC_URL") \
  bun run test:e2e:bootstrap   # GIWA fork 15케이스
```

계정을 새로 배포하는 수트라 어떤 캐시에도 없는 상태를 읽는다 — 최근 블록을
`SUITE_FORK_BLOCK`으로 넘겨야 한다. 정책 자체의 단위 테스트는
`bun test packages/delegation/src/faucet-policy.test.ts`.
