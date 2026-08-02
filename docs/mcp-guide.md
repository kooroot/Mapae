# MCP 연결 가이드

`apps/agent-mcp`는 위임 결제 루프를 MCP(Model Context Protocol) stdio 서버로
노출한다. Claude Code, Claude Desktop 등 MCP를 지원하는 에이전트에 등록하면
tool 호출 한 번으로 402 수신 → leaf 서명 → 재요청 → 정산이 사람 개입 없이
완료된다. 서버 자신은 트랜잭션을 브로드캐스트하지 않는다 — 정산과 가스는
facilitator의 relayer가 담당하고, 지출 한도는 온체인 caveat이 강제한다.

설계 근거는 [기술자료 §2 에이전트 자동화](tech/02-payment-flows.md)에 있고,
이 문서는 설치와 사용만 다룬다.

---

## 1. 제공하는 도구

| tool | 입력 | 반환 |
|---|---|---|
| `mapae_pay_for_resource` | `resource` — 판매자 origin의 절대 경로 (예: `/delegated/deliverable/inv-001`) | 성공: `resourceUrl`·`amount`·`payTo`·`resource`, 그리고 판매자 응답에 있을 때 `transaction`(tx 해시). 실패: `code`·`detail`, 해당 시 `status` |
| `mapae_status` | 없음 | 네트워크, 세션키 주소, seller/facilitator 엔드포인트, DelegationManager, 신뢰 signer 목록, 한도 강제 주체(`limit`) |

`mapae_status`는 키 원문과 서명된 permission context를 반환하지 않는다 — 둘 다
bearer 권한이므로 tool 결과로 내보내지 않도록 설계되어 있다. 응답의
`frameworkVerified`는 도구가 답하는 한 항상 `true`다 — 검증에 실패한 배포는
값이 `false`로 나오는 것이 아니라 `RUNTIME_UNAVAILABLE`로 거절된다.

## 2. 사전 조건

| 항목 | 비고 |
|---|---|
| [Bun](https://bun.sh) | 서버 런타임. 저장소 클론 후 `bun install` |
| 판매자·facilitator 엔드포인트 | 기본 경로는 Mapae가 운영하는 호스팅 엔드포인트다 — 판매자 `https://seller.mapae.io`, facilitator `https://facilitator.mapae.io`. 서비스를 직접 띄울 필요 없이 §3의 URL 변수 두 개만 지정한다. 직접 운영은 이 절 끝의 "직접 띄우기" 참조 |
| 서명된 parent permission | 소유자 지갑이 서명한 JSON 파일 (아래 참조) |
| 세션키 | 에이전트 전용 키. `apps/delegation-lab`에서 `bun run sessions:generate`로 생성 가능 |

호스팅 facilitator가 살아 있는지는 등록 전에 한 줄로 확인할 수 있다:

```bash
curl -s https://facilitator.mapae.io/supported
```

`eip155:91342`와 signer 주소가 돌아오면 정상이다.

parent permission은 소유자 지갑으로 서명한다. `apps/delegation-lab`의
`bun run permission:prepare`가 지갑(예: Rabby)이 `eth_signTypedData_v4`로 서명할
typed data를 출력하고, `bun run permission:assemble`이 서명을 붙여 배포된 owner
계정의 ERC-1271 `isValidSignature`가 수락하는 경우에만 파일로 기록한다. 소유자
키는 이 과정 어디에도 닿지 않으며, 두 단계 모두 브로드캐스트하지 않는다.

`permission:assemble`은 파일을 자기 실행 디렉터리(`apps/delegation-lab`)에
기록한다. MCP 서버는 이 파일을 `apps/delegated-agent` 기준의
`PARENT_PERMISSION_CONTEXT_PATH`로 읽으므로, 파일을 그 위치로 옮기거나 변수에
실제 경로를 지정해야 한다.

### 직접 띄우기 (셀프호스팅)

판매자와 facilitator를 직접 운영하는 경우, 두 서비스는 각자의 디렉터리에서
`bun run index.ts`로 기동하며 각자 자기 `.env`를 읽는다 — facilitator는
`RELAYER_PRIVATE_KEY`·`RELAYER_ADDRESS`, 판매자는 `PAY_TO`(공개 주소). 두
서비스 모두 loopback에만 바인딩하므로 외부 노출은 별도의 TLS 프록시나 터널이
필요하다. 필요한 값과 기대 로그는
[GIWA 데모 런북 §1–2](giwa-demo-runbook.md)에 있다.

## 3. 환경 변수

`apps/delegated-agent/.env.example`을 같은 디렉터리의 `.env`로 복사한 뒤 값을
채운다. 서버는 시작 디렉터리의 `.env`를 읽는다(Bun 자동 로드).

호스팅 엔드포인트를 쓰는 경우 `SELLER_URL`과 `FACILITATOR_URL` 두 값을 호스팅
URL로 지정한다. 표의 기본값은 loopback으로, 셀프호스팅(§2)에 맞춰져 있다.

| 변수 | 필수 | 기본값 |
|---|---|---|
| `AGENT_PRIVATE_KEY` | ✓ | — 32바이트 세션키. `.env`에만 둔다 |
| `FRAMEWORK_ADMIN_ADDRESS` | ✓ | — 배포 검증에 쓰는 Framework admin 주소. GIWA Sepolia 값은 [배포 컨트랙트](deployed-contracts.md)의 Framework Admin 항목이다 — `.env.example`의 `0x3333…`은 자리표시자다 |
| `SELLER_URL` | | `http://127.0.0.1:3001` — 호스팅 사용 시 `https://seller.mapae.io` |
| `FACILITATOR_URL` | | `http://127.0.0.1:8081` — 호스팅 사용 시 `https://facilitator.mapae.io` |
| `GIWA_SEPOLIA_RPC_URL` | | `https://sepolia-rpc.giwa.io` |
| `DELEGATION_DEPLOYMENT_PATH` | | `../../deployments/giwa-sepolia.framework.json` |
| `DELEGATION_MANIFEST_PATH` | | `../../deployments/giwa-sepolia.framework-manifest.json` |
| `PARENT_PERMISSION_CONTEXT_PATH` | | `./open-agent.permission.json` |

URL 값은 loopback이 아니면 HTTPS를 강제하고, userinfo가 든 URL은 거부한다.
경로 기본값은 실행 디렉터리 기준 상대 경로다.

## 4. 클라이언트 등록

실행 명령은 `bun <저장소>/apps/agent-mcp/index.ts` 하나다. 작업 디렉터리를
`apps/delegated-agent`로 두는 것이 규약이다 — 그 위치의 `.env`가 자동 로드되어
세션키가 클라이언트 설정 파일에 들어가지 않고, 경로 기본값이 그대로 맞는다.

Claude Code:

```bash
claude mcp add mapae -- sh -c 'cd /path/to/Mapae/apps/delegated-agent && exec bun ../agent-mcp/index.ts'
```

Claude Desktop 등 JSON 설정 클라이언트 (`mcpServers`):

```json
{
  "mcpServers": {
    "mapae": {
      "command": "sh",
      "args": ["-c", "cd /path/to/Mapae/apps/delegated-agent && exec bun ../agent-mcp/index.ts"]
    }
  }
}
```

자주 발생하는 문제는 다음 두 가지다.

- **`bun`이 PATH에 없을 수 있다.** 로그인 셸을 거치지 않고 스폰하는 클라이언트가
  있으므로, 실패하면 `bun`을 절대 경로(예: `~/.bun/bin/bun`)로 적는다.
- **환경 변수를 클라이언트 설정의 `env` 블록에 넣는 방식도 동작하지만**, 그 경우
  `AGENT_PRIVATE_KEY`가 클라이언트 설정 파일에 남는다. `.env` 방식이 기본이다.

기동 확인: 서버는 stderr에 `mapae agent MCP server running on stdio`를 출력한다.
클라이언트에서 `mapae_status`를 호출하면 세션키 주소와 엔드포인트, Framework
검증 여부가 돌아온다.

## 5. 동작 특성

- **런타임은 lazy 로딩이고 성공만 캐시한다.** 부팅 시 env·네트워크 문제가 있어도
  프로세스는 종료되지 않고, 첫 tool 호출이 `RUNTIME_UNAVAILABLE`과 원인을 반환한다.
  환경을 고치고 다시 호출하면 재시작 없이 복구된다.
- **로딩 시점에 검증이 실행된다.** 배포 아티팩트의 38유닛 Framework를 체인
  바이트코드와 대조하고, facilitator `/supported`에서 신뢰할 signer 목록을
  가져온다. 전부 읽기 전용이다.
- **서명 전에 온체인 pre-flight가 실행된다.** enforcer의 회계를 직접 읽어 성공할 수
  없는 결제를 서명 전에 거르고, 사유를 체인의 값으로 말한다
  (`payment of 2500000 exceeds 2000000 left in this period`).
- **tool 호출 타임아웃은 50초다.** 안쪽의 판매자(45초)·facilitator(35초)·영수증
  대기(25초)보다 길고, 일반적인 MCP 클라이언트의 60초 한도보다 짧다 — 바깥
  계층일수록 길어야 정산 중인 결제를 끊고도 결과를 모르는 상태가 생기지 않는다
  ([§3 에러 모델](tech/03-error-model.md)).
- **stdout은 JSON-RPC 채널이다.** 서버 로그는 전부 stderr로 나간다.

## 6. 실패 코드

`mapae_pay_for_resource`가 반환하는 주요 `code`와 대응:

| code | 뜻 | 대응 |
|---|---|---|
| `RUNTIME_UNAVAILABLE` | env·파일·네트워크·배포 검증 실패 | `detail`이 지목한 항목을 고치고 재호출 |
| `INVALID_RESOURCE` | 경로가 판매자 origin을 벗어남 | `/`로 시작하는 절대 경로로 수정 |
| `LIMIT_EXCEEDED` | 이번 주기 잔량 부족 | 주기가 돌아온 뒤 재시도 — 정상 동작이다 |
| `PERMISSION_INACTIVE` | 회수·만료·미개시 | permission 재서명 또는 체인 상태 확인 |
| `PAYMENT_REJECTED` | 판매자·facilitator가 명시적으로 거절 | 자금 불변. `detail` 확인 |
| `SETTLEMENT_UNKNOWN` | 정산 결과 미확인 | **재시도 금지.** [GIWA 런북 6장](giwa-demo-runbook.md) 절차로 확인 |

permission 파일이 위임 0개로 디코드되는 경우는 이 서버에서는 부팅 검증이
잡으므로 `RUNTIME_UNAVAILABLE`
(`parent permissionContext decodes to no delegations`)로 나타난다 — 서명 절차를
다시 밟아 아티팩트를 재생성한다.

## 7. 검증

클라이언트 없이 전체 루프를 확인하려면:

```bash
cd apps/delegation-lab
bun run test:e2e:mcp
```

GIWA fork 위에 판매자·facilitator를 실제로 띄우고 MCP 클라이언트로 접속해
정산 완주 → 한도 초과 거절 → pause 거절 → 회수 후 거절까지 왕복한다. 자식
프로세스는 loopback RPC에 고정되고, 종료 후 실제 GIWA relayer nonce가 불변임을
다시 읽어 확인한다.

필요한 것: `anvil`(Foundry), fork를 뜨기 위한 아웃바운드 RPC 접근, 서명된
permission 파일, `apps/delegation-lab/.env`의 `RELAYER_ADDRESS`, 그리고
facilitator·판매자 각각의 `.env`. 빠진 항목은 수트가 시작 시점에 이름을 지목해
거절한다.

실제 GIWA에서의 결제 실행은 [GIWA 데모 런북](giwa-demo-runbook.md)의 절차와
승인 경계를 따른다.

## 8. 보안

- 세션키가 탈취되어도 지출은 온체인 caveat의 주기 한도·만료·수취인 제약 안에
  갇힌다 — 최대 피해의 상한은 [§4 보안 고려](tech/04-security.md)가 케이스로
  증명한다.
- 서명된 permission context는 bearer 권한이다. 로그·채팅·이슈에 붙여넣지 않는다.
- tool 결과의 에러 메시지는 URL을 origin까지만 남기고 경로를 `/<redacted>`로
  치환해 반환한다 — 경로에 API 키가 든 사설 RPC를 쓰더라도 클라이언트 쪽
  에이전트에게 키가 전달되지 않는다.
