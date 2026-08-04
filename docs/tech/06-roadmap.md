<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->

# 6. 검증 상태와 로드맵

무엇이 어느 수준까지 검증되었는지를 증거 수준과 함께 기록한다. §2 증거표와 같은
규칙으로, 채굴된 것·fork에서 완주한 것·시뮬레이션으로 확인한 것을 같은 문장에
섞지 않는다.

- **위임 결제 파이프라인 — GIWA 채굴** — Framework 배포, owner account 배포,
  root 위임 서명(ERC-1271 검증), 정상 정산까지 GIWA에 채굴됨. 한도·만료 거절은
  GIWA 현재 상태를 상대로 한 시뮬레이션이며 채굴된 트랜잭션이 아니다(§2 증거표)
- **에이전트 자동화 — GIWA 채굴** — MCP tool 한 번으로 사람 개입 없이 정산한
  `0x533c…9964c`가 block 31634935에 채굴됐고 payer 가스 지출은 `0`이다
- **스폰서드 온보딩 — GIWA 채굴** — 배포 전 서명에서 복원한 owner로 계정
  `0x15286FE9…3301`이 대납 배포되고(`0xed21ac71…9902`), 3 mUSDC가
  민팅됐으며(`0x9d14588b…baa0`), 라이브 ERC-1271이 그 사전 서명에 `0x1626ba7e`를
  답했다. 새 사용자의 가스 지출은 `0`. 서비스 자체의 검증은 GIWA fork
  15케이스(`test:e2e:bootstrap`)
- **negative-path 수트 — 일회용 체인·GIWA fork** — `negative-path-suite.ts`가
  동일한 케이스 집합(정상·주기 cap·주기 reset·만료·wrong-redeemer·수취인
  불일치·replay·facilitator 변조 6종 + 대조군·payer mismatch·root 취소·회수
  UserOp 4종·제출 엔드포인트 2종·manager 합산)을 일회용 체인과 GIWA fork
  양쪽에서 체인 파라미터화로 실행하며, 각 케이스의 온체인 revert 사유까지
  대조한다. 케이스 수는 수트가 스스로 세어 출력한다
- **회수 제출 엔드포인트 — GIWA fork + 라이브 1건** — 실제 GIWA 상태·배포
  바이트코드를 고정한 fork에서 브라우저 CORS leg를 포함해 제출기 E2E와
  EntryPoint 회수를 완주했고, 2026-08-04에는 공개 스폰서드 경로로 **첫 라이브
  회수가 GIWA에 채굴됐다** — 지갑(MetaMask) 승인 화면을 실제 사람이 통과한
  건이기도 하다. 자력(핀 모드) 경로의 선예치는 여전히 소유자 몫으로 남아 있다
- **상시 게이트 — 로컬 + GIWA 읽기 전용** — 타입·테스트·문서·의존성 게이트를
  묶은 `bun run check` 전체 통과. Framework는 실행 bytecode·결정 주소 38/38 재검증.
  익스플로러 소스 검증은 39개(38유닛 + MockUSDC) 중 38이며, 유일한 미검증
  유닛은 MetaMask SDK artifact/source 리비전 차이로 현재 소스와 일치하지 않고
  Mapae 정책 경로에서 사용되지 않는다(세부 근거는
  [배포 컨트랙트](../deployed-contracts.md))
- **공개 웹의 수치 규율** — 공개 웹(`apps/web`)이 표시하는 수치의 출처는 세
  가지로 제한한다: 체인 직접 읽기, 채굴된 해시, negative-path 수트가 대조한
  revert 사유

앞으로 만들 것:

- **정산 두뇌** — 트리거·스케줄러, 복합 위임(수취인·주기·상한), 원장, 재시도
- **KYC·증명 검증 경로** — Dojang KYC 게이트 + EAS 계약/영수증 스키마 + 리졸버
- **이행검증** — optimistic 구조(기본 통과·이의제기 창·본드). 최종 판정자가
  재실행이 아닌 중재이므로 trustless가 아님을 전제로 설계
