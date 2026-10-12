# account-bootstrap

배포 전 서명에서 payer 스마트계정을 대납 배포하는 스폰서 서비스. 테스트넷
tUSDC 받기는 여기서 하지 않는다 — faucet.mapae.io(`apps/faucet`)가 따로 맡는다.

새 사용자는 **아직 존재하지 않는** 계정에 대해 root 위임을 서명한다. 이
서비스가 서명에서 owner를 복원하고, `CREATE2(owner)`가 permission이 지목한
delegator와 일치할 때만 스폰서 가스로 계정을 배포한다. 위임을 만들기 위해 GIWA ETH를 들어야 하는 사람은
아무도 없다.

요청 본문은 `{permissionContext}` 하나다. owner나 salt를 호출자에게 받으면
누구든 우리가 배포비를 낼 주소를 지명할 수 있으므로 받지 않는다 — 이 구조에서
호출자는 키 없이 풀 수 없는 고정점을 풀어야 한다. 응답은 닫힌 거절 enum만
내보내고, 서명은 오프라인에서 canonical 형식(low-s, `v ∈ {27,28}`)까지
검사한다.

## 응답

| 상황 | 응답 |
| --- | --- |
| 계정 배포 | `200 {status: "deployed", account, transaction}` |
| 이미 배포됨 | `200 {status: "already_deployed", account}` — 아무것도 쓰지 않는다 |
| 같은 IP에서 한 시간에 30번을 넘김(본문을 읽기 전) | `429 {reason: "rate_limited"}` |

## 환경 변수

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `BOOTSTRAP_DAILY_WEI` | `500000000000000` | 배포의 하루(UTC) 가스 예산 |
| `BOOTSTRAP_RATE_PER_HOUR` | `30` | IP당 한 시간에 받는 요청 수. IPv6는 /64 단위로 센다. `CF-Connecting-IP`가 없는(loopback) 요청은 세지 않는다 |
| `STORE_PATH` | `./data/bootstrap.sqlite` | 그날 쓴 가스를 남기는 `@mapae/store` 파일. `:memory:`는 드라이런용 |

나머지 변수(스폰서 키·승인 문구·RPC·바인드·오리진·수수료 상한)는
`.env.example`에 있다. 예전 faucet 변수(`BOOTSTRAP_FAUCET_ENABLED`,
`BOOTSTRAP_FAUCET_TARGET_BASE`, `MAX_BOOTSTRAP_MINT_GAS`)가 남아 있으면 기동을
거부한다 — `.env`에서 지운다.

## 기동

```bash
cp .env.example .env   # 스폰서 키·승인 문구·예산 설정
bun run dev
```

서비스는 loopback에만 바인딩하며, 다음 중 하나라도 어긋나면 기동을 거부한다.

- `BOOTSTRAP_ENABLED`와 배포 조합에 묶인 승인 문구가 일치하지 않을 때
- 스폰서 주소가 relayer 또는 deployer와 같을 때 — 인증 없는 인터넷 요청에
  응답하는 키를 정산·배포 키와 공유하면 그리핑이 정산 중단으로 번진다
- 예전 faucet 변수가 설정돼 있을 때

그리핑의 상한은 일일 가스 예산
(`BOOTSTRAP_DAILY_WEI` — 그날 쓴 총액은 `STORE_PATH`에 남아 재시작해도
이어진다), 그리고 일부러 작게 유지하는 스폰서 잔액이다. IP당 상한
(`BOOTSTRAP_RATE_PER_HOUR`, 기본 30/시간)은 그 위에 얹은 과속방지턱이다.
처음의 빡빡한 IP 제한은 키페어가 공짜라 그리퍼를 막지 못하면서 같은 사무실의
두 사람은 막았기에 뺐는데, 상한이 아예 없으면 한 대의 기계가 한 주소에서 새
키페어를 계속 보내 하루 예산을 한 시간 안에 비울 수 있었다(배포 약
1.9e11 wei, 기본 예산으로 약 2,600계정). 30/시간이면 같은 주소가 그 일에
70시간 가까이 걸리고, 사무실 하나는 여전히 통과한다. IPv6는 /64 단위로
세어, 한 대의 기계가 자기 블록의 2^64개 주소를 바꿔 가며 상한을 피하지
못하게 한다. `CF-Connecting-IP`가 없는 요청은 터널을 거치지 않은 loopback이라
세지 않는다. 스폰서에는 위임
권한이 없어 payer 자금·한도·정산에는 닿지 못한다.

## 검증

```bash
cd ../delegation-lab
SUITE_FORK_BLOCK=$(cast block-number --rpc-url "$GIWA_SEPOLIA_RPC_URL") \
  bun run test:e2e:bootstrap   # GIWA fork 14케이스
```

계정을 새로 배포하는 수트라 어떤 캐시에도 없는 상태를 읽는다 — 최근 블록을
`SUITE_FORK_BLOCK`으로 넘겨야 한다.
