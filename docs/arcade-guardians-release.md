# Guardian NFT 배포 — Mac mini 적용 순서

이 변경은 `git pull`과 재시작만으로 활성화되지 않는다. GIWA Sepolia NFT 계약, 별도 결과 서명 키, D1 테이블, seller와 두 웹 Worker가 함께 필요하다. 실제 배포와 난수 콜백 확인은 운영자가 수행한다. 로컬 테스트·브라우저 fixture 결과는 실배포 증거가 아니다.

구현 계약은 [arcade-guardians-plan.md](arcade-guardians-plan.md), 모집·성과 측정은 [arcade-guardians-pilot.md](arcade-guardians-pilot.md)를 따른다. 자금은 GIWA 테스트 ETH와 mUSDC만 사용한다. 기존 가변 캐릭터의 점수를 NFT 성장으로 이관하지 않는다.

## 기존 캐릭터 동기화 제거 후 웹 갱신

이미 NFT 배포·연결을 마친 환경에서 이번 정리는 웹 코드만 갱신한다. 저장소 루트에서 `git pull --ff-only`, `bun install --frozen-lockfile`, `bun run deploy:landing`, `bun run deploy:app` 순서로 실행하고 열려 있던 아케이드 탭을 새로고침한다. 이 정리 때문에 seller를 재시작하거나 NFT 계약을 다시 배포할 필요는 없다. 최초 NFT 배포가 아직이면 아래 전체 절차를 따른다.

로그인 서명은 지갑 인증에만 사용한다. `/api/arcade/profile/session`은 소유자 주소만 반환하며, 옛 캐릭터 프로필 GET/PUT과 `/checkout` 경로는 제거됐다. 기기에 남은 `mapae.arcade.wallet.v1.*`, `mapae.arcade.sync.*` 기록과 D1의 옛 캐릭터는 불러오거나 NFT로 변환하지 않는다. 기존 DB 행은 자동 삭제하지 않으며 결제 대조용으로 보존한다. 아직 미확인인 구형 단건 결제는 업데이트 전에 운영 도구와 원래 영수증으로 대조한다.

갱신 후에는 `캐릭터 만들기`·`1 / 12` 화면 대신 `나의 전령단`·`온체인으로 전령 뽑기`가 보여야 한다. 보유 NFT가 없으면 빈 전령단을, NFT 서비스가 준비되지 않았으면 준비 안내와 무료 게임을 보여준다. 무료 연습에서도 캐릭터 생성·외형 편집은 제공하지 않는다. NFT 외출 요청과 민팅·성장 거래는 기존 요청 ID와 거래 해시로 복구한다.

## 1. 기존 작업 정리와 백업

기존 웹에서 진행 중인 외출을 중지하고, 응답이 불확실한 입장권은 같은 요청으로 복구한다. 중지는 이미 제출한 결제 한 건을 취소하지 않는다. 이전 형식의 활성 작업이 남아 있으면 새 seller가 시작을 거절한다. 해당 행이나 결제 헤더를 삭제해서 우회하지 않는다.

실제 `STORE_PATH`를 확인하고 SQLite의 backup 기능으로 백업한다. 실행 중인 WAL 데이터베이스를 파일 하나만 복사하지 않는다. 예시의 절대 경로는 현재 운영 경로로 바꾼다.

```sh
sqlite3 /absolute/path/seller.sqlite ".backup '/absolute/path/backup/seller-before-guardians.sqlite'"
```

백업에는 유효한 제한 권한이 포함될 수 있다. 운영 계정만 읽을 수 있도록 보관한다. 서비스 이름은 다음 읽기 전용 조회로 확인한다.

```sh
python3 scripts/ops/inventory.py
git status --short
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun --no-env-file scripts/arcade-guardians-preflight.ts
```

독립적으로 수정한 submodule이나 환경 파일을 덮어쓰지 않는다. preflight는 공개 RPC의 체인 ID, 최신·safe 블록, Entropy 배포와 공급자, 현재 수수료·잔여 시퀀스와 readiness만 읽는다. 성공해도 콜백까지 입증하지 않는다. 출력 JSON을 배포 기록에 보관한다.

## 2. 계약과 서명 역할 준비

[contracts/.env.guardians.example](../contracts/.env.guardians.example)의 항목을 운영자의 비공개 환경 관리 절차로 준비한다. 예제 파일에는 키가 없다. 환경값을 출력하거나 채팅·커밋·프런트엔드 `VITE_*`에 넣지 않는다.

| 역할 | 설정 | 용도 |
| --- | --- | --- |
| 배포자 | `GUARDIAN_DEPLOYER_PRIVATE_KEY`, `GUARDIAN_DEPLOYER_ADDRESS` | NFT 계약 배포용 테스트 ETH |
| 관리자 | `GUARDIAN_ADMIN_ADDRESS` | 뽑기 중지/재개, 결과 서명자 변경 |
| 결과 서명자 | `GUARDIAN_RESULT_SIGNER_ADDRESS`, seller의 `ARCADE_RESULT_PRIVATE_KEY` | 검증된 결과에 서명. 자금·가스 불필요 |
| 결제 에이전트 | `SESSION_ACCOUNT`, seller의 `ARCADE_AGENT_PRIVATE_KEY` | 사용자별 제한된 외출 권한. 결과 서명자와 다른 키 |
| 이미지 주소 | `GUARDIAN_IMAGE_BASE_URI` | `https://mapae.io/api/arcade/guardians/` |

결과 서명자는 배포자·관리자·결제 에이전트·facilitator 등 자금 역할과 다른 주소여야 한다. 배포자는 테스트 ETH가 필요하며, 결과 서명자와 결제 에이전트에 가스를 넣을 필요는 없다. 이미지 base URI는 배포 후 변경할 수 없으므로 위 서비스 도메인을 먼저 확인한다.

비공개 환경을 현재 셸에 로드한 뒤 다음을 실행한다. 첫 명령은 fork 시뮬레이션이며 두 번째만 실제 배포 트랜잭션을 전송한다.

```sh
cd contracts
forge script script/DeployGuardians.s.sol --rpc-url giwa_sepolia -vv
forge script script/DeployGuardians.s.sol --rpc-url giwa_sepolia --broadcast -vv
```

계약은 `mintPaused=true`로 생성된다. 출력한 컬렉션 주소와 `broadcast/DeployGuardians.s.sol/91342/run-latest.json`의 배포 트랜잭션을 보관한다. `cast receipt <배포_해시> --rpc-url giwa_sepolia`와 explorer에서 실제 성공을 확인한다. source verification은 배포 주소·생성자 인수를 사용해 `forge verify-contract`로 별도로 수행한다. 성공 여부를 확인하지 않은 상태에서 verified로 표기하지 않는다.

저장소 루트에서 배포 상태를 읽는다.

```sh
bun --no-env-file scripts/arcade-guardians-preflight.ts --collection <배포한_주소>
```

관리자·결과 서명자·이미지 주소가 의도한 값이고 mint가 paused인지 확인한다.

## 3. D1와 서버 환경 연결

두 Worker는 같은 `mapae-arcade-profiles` D1을 사용한다. 새 지표 테이블만 추가하며 기존 프로필을 삭제하지 않는다.

```sh
cd apps/web
bunx wrangler d1 execute mapae-arcade-profiles --remote --env landing --config wrangler.jsonc --file src/arcade/engagement/schema.sql
bunx wrangler secret put ARCADE_GUARDIAN_ADDRESS --env landing --config wrangler.jsonc
bunx wrangler secret put ARCADE_GUARDIAN_ADDRESS --env app --config wrangler.jsonc
```

두 `secret put` 프롬프트에는 같은 **공개 NFT 계약 주소**만 넣는다. 이 값은 Worker 런타임 binding으로 저장하며 비밀 키가 아니다. 주소를 `VITE_*`로 만들지 않는다. 기존 `ARCADE_RECEIPT_TOKEN`은 seller와 두 Worker가 공유하는 서버 전용 값으로 유지한다.

seller 비공개 환경에 다음을 설정한다. [seller 예제](../apps/delegated-seller/.env.example)를 참고한다.

```text
ARCADE_OUTINGS_ENABLED=true
ARCADE_GUARDIAN_ADDRESS=<같은 NFT 계약 주소>
ARCADE_RESULT_PRIVATE_KEY=<별도 결과 서명 키>
GUARDIAN_DEPLOYER_ADDRESS=<배포자 공개 주소>
GUARDIAN_ADMIN_ADDRESS=<관리자 공개 주소>
```

기존 `STORE_PATH`, `ARCADE_AGENT_PRIVATE_KEY`, `ARCADE_RECEIPT_TOKEN`은 보존한다. 새 임시 DB나 두 번째 seller를 만들지 않는다. 서버 시작 시 잘못된 키 재사용을 거부하고, 결과 서명자와 체인 설정이 맞지 않으면 NFT API가 실패하도록 되어 있다.

확인한 기존 seller 서비스만 재시작한다. inventory에서 이름이 실제로 `system/io.mapae.delegated-seller`일 때의 명령은 다음과 같다.

```sh
sudo launchctl kickstart -k system/io.mapae.delegated-seller
```

이어서 저장소 루트에서 두 웹 배포를 수행한다.

```sh
bun run deploy:landing
bun run deploy:app
```

두 배포의 Worker version ID를 따로 보관한다. landing Worker의 하루 한 번 cron이 지표 보관 기한을 정리한다. 이미지 API는 `ASSETS` binding에서 기존 WebP를 읽어 독립 SVG에 포함한다. seller만 재시작해도 웹 UI나 D1은 업데이트되지 않는다.

## 4. 한 개의 실제 뽑기와 한 번의 외출로 확인

공개 모집을 시작하기 전 테스트 지갑 하나를 사용한다. fixture·개발·canary 지갑은 실제 사용자 성과에서 구분한다.

1. 관리자 지갑에서 컬렉션의 `setMintPaused(false)`를 호출한다. 이는 새 뽑기를 여는 실제 온체인 변경이다. 웹에서 사용자 지갑으로 **한 번만** 뽑는다. 요청 영수증의 `MintRequested(owner,tokenId,sequence,contribution)`을 보관한다.
2. 관리자에서 `setMintPaused(true)`로 다시 닫아 검증 중 추가 뽑기를 제한한다. 중지해도 이미 요청한 콜백은 처리된다. provider가 `BirthRevealed`를 발생시켜 같은 token/sequence를 공개하는지 확인한다.
3. 아래 명령이 safe 블록에서 `revealed=true`와 불변 seed/traits를 읽는지 확인한다. 여기에는 실제 토큰 ID를 넣는다.

   ```sh
   bun --no-env-file scripts/arcade-guardians-preflight.ts --collection <NFT_주소> --token <토큰_ID>
   ```

4. 새로고침·다른 기기에서도 같은 캐릭터가 보이는지, `https://mapae.io/api/arcade/guardians/<토큰_ID>/image.svg`가 실제 캐릭터 SVG인지 확인한다. 난수가 지연되면 기존 sequence의 복구만 사용한다. 재배포·새 요청으로 결과를 바꾸지 않는다.
5. 1 mUSDC 입장 한 번만 허용하고 외출을 보낸다. payer·mUSDC·고정 수취인·정확한 금액을 GIWA 영수증에서 확인한다. 서버 결과가 생긴 뒤 NFT 성장 기록을 요청한다. 결제가 safe 블록에 도달하기 전에는 서명이 지연될 수 있다.
6. `ResultClaimed`와 `progress(tokenId)`에서 플레이 1회·10 XP(승리라면 15 XP)를 대조한다. 같은 결과의 재청구는 추가 성장이나 추가 입장 결제를 만들면 안 된다.
7. 전송한 트랜잭션 확인, 지갑 거절, 예산 중지·회수, NFT 이전 후 이전 소유자의 신규 결제 중단을 확인한다. 소유권이 바뀌어도 이미 제출한 한 건은 원래 권한으로 복구될 수 있다. 새 소유자는 자신의 권한을 따로 서명한다.
8. 지갑 없는 무료 게임도 확인한 다음, 모든 증거가 맞을 때 관리자가 뽑기를 다시 연다.

요청 후 reveal이 오지 않으면 뽑기를 닫고 기존 요청을 유지한다. 임의 seed나 다른 난수 경로로 대체하지 않는다. preflight readiness는 공급자의 장기 가동이나 실제 콜백을 보장하지 않는다.

지갑에서 속도 올리기나 취소로 트랜잭션을 교체했다면 복구 화면에 교체 거래 해시를 입력한다. 같은 발신자·실제 nonce와 확정 영수증을 확인한 경우에만 기존 대기를 해제한다. 원래 거래가 RPC에 한 번도 관측되지 않아 nonce를 보관하지 못했고 이후에도 조회할 수 없는 경우에는 추측으로 기록을 지우지 않는다. 그때는 지갑·explorer에서 원래 거래의 검증 가능한 정보를 먼저 확보해야 한다.

## 운영 중 중지와 기록

신규 뽑기는 `setMintPaused(true)`로 중지한다. 외출 문제가 있으면 사용자 UI에서 중지·권한 회수하고 필요 시 `ARCADE_OUTINGS_ENABLED=false`로 seller를 재시작한다. 이미 제출한 결제·결과 DB는 보존한다. 이전 가변 캐릭터 버전으로 되돌려 NFT 작업을 실행하지 않는다.

배포 기록에는 git SHA, 체인 ID, NFT 주소·배포 해시·관리자·결과 서명자, 난수 요청/공개 해시와 token/sequence, 입장·성장 해시, D1 적용 시점, seller 재시작 시점, 두 Worker version ID를 남긴다. 개인 키·bearer·권한 원문은 기록하지 않는다. 실제 이용자 성과 보고서는 [파일럿 안내](arcade-guardians-pilot.md)의 읽기 전용 도구로 별도 생성한다.
