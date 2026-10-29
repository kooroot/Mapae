# faucet

faucet.mapae.io 뒤에서 faucet 지갑 키를 쥐는 유일한 서비스. 테스트넷
tUSDC(실제 돈 아님)를 지불 계정에 목표 잔액까지 채워 주고, 운영자가 켜면
GIWA Sepolia ETH(테스트넷)를 지갑에 0.0005개씩 보낸다.

브라우저는 이 서비스에 닿지 않는다. faucet Worker(`apps/web/src/faucet/api.ts`)가
SIWE로 지갑 소유를 확인하고, Turnstile을 검사하고, IP·서브넷 키를 HMAC으로 만든
뒤 Bearer `FAUCET_SERVICE_TOKEN`으로 이 서비스를 부른다. 서비스는 loopback에만
바인딩하고, `Origin`이 붙은 요청은 무엇이든 거절한다. 공개 경로는
facilitator.mapae.io 터널의 `^/faucet` 경로 규칙 하나다.

## 무엇을 막는가

| 공격 | 막는 것 |
| --- | --- |
| 남의 지갑으로 받기 | Worker의 SIWE 세션(faucet.mapae.io 오리진에 묶임). ETH는 그 지갑으로만, tUSDC는 그 지갑의 지불 계정으로만 간다 |
| 같은 지갑 반복 | 지갑당 창: tUSDC 24시간, ETH 7일. 진행 중인 청구가 있으면 같은 청구를 돌려준다 |
| 지갑을 바꿔 가며 받기 | ETH는 이더리움 메인넷 거래 기록이 1건 이상 있는 지갑만 — 가짜 지갑마다 실제 가스가 든다. IP(IPv4 주소, IPv6 /64)당 하루 1건, 서브넷(/24, /48)당 3건 |
| 한 기계에서 대량 요청 | Turnstile, Worker의 IP당 10분 10건(D1), tUSDC는 IP당 하루 5건·서브넷 20건 |
| 지갑 비우기 | ETH 하루 wei 상한(`FAUCET_ETH_DAILY_WEI`), 스테이블코인 민팅 가스용 바닥 잔액(`FAUCET_MIN_BALANCE_WEI`) 아래로는 ETH를 보내지 않음, 이미 충분히 가진 지갑은 건너뜀 |
| 재시작으로 한도 초기화 | 원장은 SQLite 파일(`STORE_PATH`). 켜진 상태에서 `:memory:`는 기동 거부 |
| 이중 지급 | 지갑·종류당 진행 중 청구 1건(유니크 인덱스), 서명한 바이트를 방송 전에 기록, 재방송은 같은 바이트(같은 해시) |

tUSDC는 누구나 직접 민팅할 수 있는 테스트 토큰이라 그 한도는 보안이 아니라
faucet 지갑의 가스를 지키는 장치다. ETH가 실제로 노릴 만한 자산이고, 위의
상한과 바닥 잔액이 손실의 끝이다.

## 미션

- tUSDC 탭: `x_follow_mapae`(https://x.com/mapae_io 팔로우) 고정. 지금은
  `honour` — 페이지에서 링크를 열면 완료로 표시하고 서비스는 그 주장을 받는다.
- ETH 탭: `FAUCET_ETH_MISSIONS`에 레지스트리 id를 쉼표로 적는다. 비어 있으면
  ETH 탭은 꺼져 있고 페이지는 "준비 중"을 보인다. 모르는 id는 기동 거부.
- 실제 확인으로 바꾸려면 `packages/delegation/src/faucet-policy.ts`의
  `FAUCET_MISSIONS`에서 그 미션의 `kind`를 `verified`로 바꾸고
  `createFaucet`의 `verifiers`에 그 id의 검증 함수를 넣는다. 검증 함수가 없는
  `verified` 미션은 기동을 거부한다.

## HTTP

모두 `Authorization: Bearer $FAUCET_SERVICE_TOKEN`이 필요하다.

| 경로 | 응답 |
| --- | --- |
| `GET /faucet/status` | `{musdc:{enabled,targetBase,windowMs,missions}, eth:{enabled,amountWei,windowMs,missions,minMainnetNonce}}`. 잔액은 내보내지 않고, 바닥 잔액 아래면 `enabled`만 끈다 |
| `GET /faucet/claims/:owner` | `{owner, recipients:{musdc, eth}, musdc: ClaimView\|null, eth: ClaimView\|null}` |
| `POST /faucet/claims` `{kind, owner, ipKey, subnetKey, missions}` | `200 ClaimView` 또는 `{reason, nextAt?}`(400/403/429/503) |
| `GET /health` | loopback 전용(터널을 거친 요청은 404). 지갑 주소·잔액·미결 청구 수, `last7Days`(최근 7일 청구 상태별 수, UTC 날짜별 거절 이유 수) |

`ClaimView = {kind, state: "pending"|"confirmed"|"failed"|"already_enough", amount, recipient, transaction?, nextAt?}`.
거절 이유는 `FAUCET_REFUSALS`의 닫힌 집합뿐이다. 거절은 모두 `faucet_refusals`에
이유별로 세고(지갑·IP 없음) `[faucet] eth refused not_eligible owner=0x…` 한 줄을 남긴다.
탭이 아무에게도 지급하지 않으면 `curl -s 127.0.0.1:8084/health`의 `last7Days`부터 본다.

## 청구 상태와 복구

`reserved → signed → sent → confirmed`, 또는 `failed`·`skipped`. 서명한
바이트를 디스크에 쓴 뒤에 방송하므로, 어디서 꺼져도 재조정기(기동 시 + 15초마다)가
마무리한다.

- `reserved`가 2분 넘게 남음 → 서명된 적 없으니 `failed`
- 영수증이 있음 → `confirmed` 또는 `failed`
- 영수증이 없고 체인의 확정 nonce가 이 청구의 nonce를 지남 → 그 사이 채굴됐을 수 있으니 영수증을
  한 번 더 읽고, 그래도 없으면 다른 거래가 가져간 것이라 `failed`
- 그 밖에 마지막 시도 뒤 2분이 지남 → 같은 바이트를 다시 방송
- 진행 중인 청구들의 nonce 아래에 아무도 쥐지 않은 빈 nonce가 있음(앞 청구가 노드에 거절됨) →
  faucet 지갑 자신에게 0 ETH를 보내 채운다. 안 채우면 뒤의 청구가 영원히 줄 서 있다

노드가 오류로 답한 방송은 노드가 받지 않은 것이므로 바로 `failed`로 닫고 nonce를
돌려준다. 타임아웃처럼 모호한 경우만 `signed`로 남긴다. `skipped`와 `failed`는
어떤 창도 소모하지 않는다.

잔액 검사(바닥 + 이번 청구액 + 가스)는 서명과 같은 잠금 안에서 하고, 아직 채굴되지 않은
`signed`·`sent` 청구의 ETH와 건당 최대 가스를 마지막 블록 잔액에서 먼저 뺀다. 동시에 들어온
ETH 청구 여럿이 같은 잔액을 보고 바닥까지 함께 쓰는 일을 막는다.

## 환경 변수

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8084` | loopback만 허용 |
| `FAUCET_ENABLED` | `false` | `"true"`일 때만 켠다. 그 외 값은 기동 거부 |
| `GIWA_SEPOLIA_RPC_URL` | 공개 엔드포인트 | 유료 전용 RPC를 넣는다(`throttledHttp`) |
| `FAUCET_PRIVATE_KEY` / `FAUCET_ADDRESS` | 필수 | 이 서비스 전용 지갑. 둘이 맞지 않으면 기동 거부 |
| `FAUCET_SERVICE_TOKEN` | 필수 | 32자 이상. Worker 비밀과 같은 값 |
| `STORE_PATH` | `./data/faucet.sqlite` | 청구 원장 |
| `FAUCET_ETH_MISSIONS` | 비어 있음 | 비어 있으면 ETH 탭 꺼짐 |
| `FAUCET_ETH_DAILY_WEI` | `50000000000000000` (0.05 ETH = 100건) | ETH 하루 상한 |
| `FAUCET_MIN_BALANCE_WEI` | `20000000000000000` (0.02 ETH) | 스테이블코인 민팅 가스용 바닥. ETH 탭은 이 아래로 보내지 않는다(측정 수수료로 약 200일치 민팅, ETH 청구 40건 몫) |
| `ETH_MAINNET_RPC_URL` | `https://ethereum-rpc.publicnode.com` | ETH 자격 읽기 전용, 5초 타임아웃 |
| `DELEGATION_DEPLOYMENT_PATH` | `../../deployments/giwa-sepolia.framework.json` | 지불 계정 유도용. GIWA Sepolia가 아니면 기동 거부 |
| `BOOTSTRAP_ADDRESS`, `FACILITATOR_SIGNER_ADDRESS`, `DEPLOYER_ADDRESS`, `REVOCATION_SPONSOR_ADDRESS` | 선택 | 넣으면 faucet 지갑과 같은지 검사해 같으면 기동 거부 |

가스 상한(민팅 100k, ETH 전송 50k — EIP-7702로 위임한 지갑은 받을 때 위임 코드를 돌리므로
21k로는 늘 되돌려진다; 일반 지갑은 상한과 상관없이 21k만 쓴다, 빈 nonce 채우기 21k), `maxFeePerGas` 5e7 wei, 팁 1e6 wei, 영수증 대기
30초는 `claims.ts`의 상수다.

## 운영자 절차

1. 지갑을 만든다: `cast wallet new`. 키와 주소를 `.env`의 `FAUCET_PRIVATE_KEY`,
   `FAUCET_ADDRESS`에 넣는다(이 파일은 커밋하지 않는다).
2. 토큰을 만든다: `openssl rand -hex 32` → `.env`의 `FAUCET_SERVICE_TOKEN`, 그리고
   `apps/web`에서 `bunx wrangler secret put FAUCET_SERVICE_TOKEN --env faucet`.
3. `.env`에 전용 RPC를 넣고 `FAUCET_ENABLED=true`, `FAUCET_ETH_MISSIONS`는 비워 둔다.
4. `FAUCET_ADDRESS`에 GIWA Sepolia ETH를 0.03개 이상 보낸다(바닥 0.02 + 민팅 가스).
5. `bun run start`로 띄우고 `curl -s 127.0.0.1:8084/health`로 지갑과 `enabled`를 확인한다.
6. cloudflared 설정에서 호스트 catch-all보다 위에 `facilitator.mapae.io` 경로
   `^/faucet` → `http://127.0.0.1:8084` 규칙을 넣고 cloudflared를 재시작한다.
   `/health`는 터널에 넣지 않는다.
7. 재시작은 프로세스만 다시 띄우면 된다. 원장이 파일에 있어 창과 한도는 이어지고,
   기동 직후 재조정기가 미결 청구를 마무리한다.

ETH 탭을 열 때: `FAUCET_ETH_MISSIONS`에 미션 id를 넣고, 지갑을 바닥 잔액 +
며칠치 `FAUCET_ETH_DAILY_WEI` 이상으로 채운 뒤 재시작한다.

## 검증

```bash
bun test apps/faucet packages/store/src/faucet.test.ts packages/delegation/src/faucet-policy.test.ts
```

엔진 테스트는 메모리 안의 가짜 체인으로 nonce·영수증·재방송까지 돌리며 실제
트랜잭션은 보내지 않는다.
