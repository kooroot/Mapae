# account-bootstrap

배포 전 서명에서 payer 스마트계정을 대납 배포하는 스폰서 서비스.

새 사용자는 **아직 존재하지 않는** 계정에 대해 root 위임을 서명한다. 이
서비스가 서명에서 owner를 복원하고, `CREATE2(owner)`가 permission이 지목한
delegator와 일치할 때만 스폰서 가스로 계정을 배포한 뒤 테스트넷 mUSDC를
민팅한다. 위임을 만들기 위해 GIWA ETH를 들어야 하는 사람은 아무도 없다.

요청 본문은 `{permissionContext}` 하나다. owner나 salt를 호출자에게 받으면
누구든 우리가 배포비를 낼 주소를 지명할 수 있으므로 받지 않는다 — 이 구조에서
호출자는 키 없이 풀 수 없는 고정점을 풀어야 한다. 응답은 닫힌 거절 enum만
내보내고, 서명은 오프라인에서 canonical 형식(low-s, `v ∈ {27,28}`)까지
검사한다.

## 기동

```bash
cp .env.example .env   # 스폰서 키·승인 문구·예산 설정
bun run dev
```

서비스는 loopback에만 바인딩하며, 다음 중 하나라도 어긋나면 기동을 거부한다.

- `BOOTSTRAP_ENABLED`와 배포 조합에 묶인 승인 문구가 일치하지 않을 때
- 스폰서 주소가 relayer 또는 deployer와 같을 때 — 인증 없는 인터넷 요청에
  응답하는 키를 정산·배포 키와 공유하면 그리핑이 정산 중단으로 번진다

그리핑의 상한은 IP당 rate limit, 일일 가스 예산(`BOOTSTRAP_DAILY_WEI`),
그리고 일부러 작게 유지하는 스폰서 잔액이다. 스폰서에는 위임 권한이 없어
payer 자금·한도·정산에는 닿지 못한다.

## 검증

```bash
cd ../delegation-lab
SUITE_FORK_BLOCK=$(cast block-number --rpc-url "$GIWA_SEPOLIA_RPC_URL") \
  bun run test:e2e:bootstrap   # GIWA fork 15케이스
```

계정을 새로 배포하는 수트라 어떤 캐시에도 없는 상태를 읽는다 — 최근 블록을
`SUITE_FORK_BLOCK`으로 넘겨야 한다.
