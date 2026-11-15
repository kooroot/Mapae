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

결과 서명자는 배포자·관리자·결제 에이전트·facilitator 등 자금 역할과 다른 주소여야 하고, 코드가 없는 EOA여야 한다(EIP-7702 위임이 걸린 주소도 거절된다). 배포자는 테스트 ETH가 필요하며, 결과 서명자와 결제 에이전트에 가스를 넣을 필요는 없다. 이미지 base URI는 setter가 없어 업그레이드 없이는 바꿀 수 없으므로 위 서비스 도메인을 먼저 확인한다.

컬렉션은 OpenZeppelin UUPS 프록시다. 스크립트는 세 개를 만든다. 메타데이터 라이브러리 `GuardianMetadata`(CREATE2 결정적 배포자 `0x4e59…956C`로 배포되며 같은 바이트코드면 주소가 같다), 구현 계약 `MapaeGuardians`(생성자 인수는 Pyth Entropy·provider 주소뿐이고 둘 다 immutable), 그리고 `initialize(admin, signer, imageBase)`를 생성자 안에서 원자적으로 실행하는 `ERC1967Proxy`다. **앱·seller·Worker·preflight에 넣는 주소는 항상 프록시 주소다.** 구현 주소로 호출하면 초기화되지 않은 빈 계약이며(`_disableInitializers`), EIP-712 서명 도메인의 `verifyingContract`, birth seed, Pyth 요청자도 모두 프록시 주소다.

비공개 환경을 현재 셸에 로드한 뒤 다음을 실행한다. 첫 명령은 fork 시뮬레이션이며 두 번째만 실제 배포 트랜잭션을 전송한다.

```sh
cd contracts
forge script script/DeployGuardians.s.sol --rpc-url giwa_sepolia -vv
forge script script/DeployGuardians.s.sol --rpc-url giwa_sepolia --broadcast -vv
```

계약은 `mintPaused=true`로 생성된다. 로그의 `Mapae Guardians (proxy, ARCADE_GUARDIAN_ADDRESS)`가 컬렉션 주소이고 `implementation`이 구현 주소다. 두 주소와 `broadcast/DeployGuardians.s.sol/91342/run-latest.json`의 세 트랜잭션(라이브러리 CREATE2, 구현, 프록시)과 `.libraries` 항목을 보관한다. `cast receipt <배포_해시> --rpc-url giwa_sepolia`와 explorer에서 각각 실제 성공을 확인한다.

source verification은 Blockscout에서 세 계약을 각각 수행한다. 값은 위 JSON에서 복사한다.

```sh
cd contracts
VERIFY="--rpc-url giwa_sepolia --verifier blockscout --verifier-url https://sepolia-explorer.giwa.io/api/ --watch"
forge verify-contract $VERIFY <라이브러리_주소> src/GuardianMetadata.sol:GuardianMetadata
forge verify-contract $VERIFY --libraries src/GuardianMetadata.sol:GuardianMetadata:<라이브러리_주소> \
  --constructor-args $(cast abi-encode "f(address,address)" 0x0708325268dF9F66270F1401206434524814508b 0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344) \
  <구현_주소> src/MapaeGuardians.sol:MapaeGuardians
INIT=$(cast calldata "initialize(address,address,string)" <관리자> <결과_서명자> https://mapae.io/api/arcade/guardians/)
forge verify-contract $VERIFY --constructor-args $(cast abi-encode "f(address,bytes)" <구현_주소> $INIT) \
  <프록시_주소> lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy
```

프록시 생성자 인수는 `(구현_주소, initialize 호출 데이터)`이고, `run-latest.json` 프록시 트랜잭션 `input`의 끝부분과 같아야 한다. Blockscout가 프록시를 인식하면 컬렉션 페이지의 Read/Write as Proxy에 구현 ABI가 보인다. 성공 여부를 확인하지 않은 상태에서 verified로 표기하지 않는다.

저장소 루트에서 배포 상태를 읽는다.

```sh
bun --no-env-file scripts/arcade-guardians-preflight.ts --collection <배포한_주소>
```

관리자·결과 서명자·이미지 주소가 의도한 값이고 mint가 paused인지 확인한다. preflight는 ERC-1967 구현 슬롯이 비어 있지 않고 그 주소에 코드가 있는지도 읽어 `implementation`으로 출력한다. 이 값이 배포 로그의 구현 주소와 같아야 한다. 관리자 이전은 2단계(`transferOwnership` 후 새 주소의 `acceptOwnership`)이며, 결과 서명자 주소로는 이전할 수 없다.

## 3. D1와 서버 환경 연결

랜딩·앱·faucet Worker는 같은 `mapae-arcade-profiles` D1을 사용하고, 셋 다 지표를 기록한다. 지표 스키마를 바꾼 변경은 아래 `schema.sql`을 **먼저** 적용한 뒤 세 Worker를 배포한다. 새 표가 없는 동안 새 Worker는 처음 온 브라우저의 기록을 받지 못하고, 그 사이 쌓인 중복 도착 기록 때문에 나중의 적용이 고유 색인에서 실패할 수 있다. 새 지표 테이블만 추가하며 기존 프로필을 삭제하지 않는다.

```sh
cd apps/web
bunx wrangler d1 execute mapae-arcade-profiles --remote --env landing --config wrangler.jsonc --file src/arcade/engagement/schema.sql
bunx wrangler secret put ARCADE_GUARDIAN_ADDRESS --env landing --config wrangler.jsonc
bunx wrangler secret put ARCADE_GUARDIAN_ADDRESS --env app --config wrangler.jsonc
bunx wrangler secret put GIWA_SEPOLIA_RPC_URL --env landing --config wrangler.jsonc
bunx wrangler secret put GIWA_SEPOLIA_RPC_URL --env app --config wrangler.jsonc
```

`GIWA_SEPOLIA_RPC_URL`에는 seller·스폰서가 쓰는 것과 같은 **유료 전용 GIWA RPC** 주소(HTTPS)를 넣는다. 공개 RPC는 Cloudflare 출구 요청을 자주 거절해 이미지 API가 503이 된다(2026-10-12 운영 측정: 실제 토큰 4개 80회 중 54회 실패). 주소에 키가 들어 있을 수 있으므로 반드시 `secret put`으로만 넣고 `VITE_*`나 `wrangler.jsonc` `vars`로 만들지 않는다(`build-guards.ts`가 공개 번들의 비공개 RPC를 막는다). 값이 없으면 공개 RPC로 읽으며 이는 로컬 개발용이다.

두 `ARCADE_GUARDIAN_ADDRESS` 프롬프트에는 같은 **공개 NFT 프록시 주소**만 넣는다. 구현 주소를 넣지 않는다. 이 값은 Worker 런타임 binding으로 저장하며 비밀 키가 아니다. 주소를 `VITE_*`로 만들지 않는다. 기존 `ARCADE_RECEIPT_TOKEN`은 seller와 두 Worker가 공유하는 서버 전용 값으로 유지한다.

seller 비공개 환경에 다음을 설정한다. [seller 예제](../apps/delegated-seller/.env.example)를 참고한다.

```text
ARCADE_OUTINGS_ENABLED=true
ARCADE_GUARDIAN_ADDRESS=<같은 NFT 프록시 주소>
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

두 배포의 Worker version ID를 따로 보관한다. landing Worker의 하루 한 번 cron이 지표 보관 기한을 정리한다. 이미지 API는 `ASSETS` binding에서 기존 WebP를 읽어 독립 SVG에 포함한다. 공개(reveal)된 그림은 seed가 바뀌지 않으므로 Cache API(`mapae-guardian-art`)에 컬렉션·`ART_REVISION` 키로 7일 보관하고, 적중하면 RPC를 읽지 않는다. 레이어 그림이나 합성 방식을 바꾸면 `apps/web/src/arcade/guardian-art/api.ts`의 `ART_REVISION`을 올려 다시 그리게 한다. 대기 그림은 캐시하지 않는다. 없는 토큰 ID는 404(`max-age=30`), RPC·그림 장애만 503(`no-store`, `Retry-After: 5`)이다. seller만 재시작해도 웹 UI나 D1은 업데이트되지 않는다.

## 4. 한 개의 실제 뽑기와 한 번의 외출로 확인

공개 모집을 시작하기 전 테스트 지갑 하나를 사용한다. fixture·개발·canary 지갑은 실제 사용자 성과에서 구분한다.

1. 관리자 지갑에서 컬렉션의 `setMintPaused(false)`를 호출한다. 이는 새 뽑기를 여는 실제 온체인 변경이다. 웹에서 사용자 지갑으로 **한 번만** 뽑는다. 요청 영수증의 `MintRequested(owner,tokenId,sequence,contribution)`을 보관한다.
2. 관리자에서 `setMintPaused(true)`로 다시 닫아 검증 중 추가 뽑기를 제한한다. 중지해도 이미 요청한 콜백은 처리된다. provider가 `BirthRevealed`를 발생시켜 같은 token/sequence를 공개하는지 확인한다.
3. 아래 명령이 safe 블록에서 `revealed=true`와 불변 seed/traits를 읽는지 확인한다. 여기에는 실제 토큰 ID를 넣는다.

   ```sh
   bun --no-env-file scripts/arcade-guardians-preflight.ts --collection <NFT_주소> --token <토큰_ID>
   ```

4. 새로고침·다른 기기에서도 같은 캐릭터가 보이는지, `https://mapae.io/api/arcade/guardians/<토큰_ID>/image.svg`가 실제 캐릭터 SVG인지 확인한다. 전용 RPC와 캐시는 `for i in $(seq 50); do curl -s -o /dev/null -w "%{http_code}\n" https://mapae.io/api/arcade/guardians/<토큰_ID>/image.svg; done | sort | uniq -c`가 50번 모두 `200`인지로 확인한다(app.mapae.io도 같다). `503`이 섞이면 두 Worker의 `GIWA_SEPOLIA_RPC_URL` 비밀부터 확인한다. 난수가 지연되면 기존 sequence의 복구만 사용한다. 재배포·새 요청으로 결과를 바꾸지 않는다.
5. 1 mUSDC 입장 한 번만 허용하고 외출을 보낸다. payer·mUSDC·고정 수취인·정확한 금액을 GIWA 영수증에서 확인한다. 서버 결과가 생긴 뒤 NFT 성장 기록을 요청한다. 결제가 safe 블록에 도달하기 전에는 서명이 지연될 수 있다.
6. `ResultClaimed`와 `progress(tokenId)`에서 플레이 1회·10 XP(승리라면 15 XP)를 대조한다. 같은 결과의 재청구는 추가 성장이나 추가 입장 결제를 만들면 안 된다.
7. 전송한 트랜잭션 확인, 지갑 거절, 예산 중지·회수, NFT 이전 후 이전 소유자의 신규 결제 중단을 확인한다. 소유권이 바뀌어도 이미 제출한 한 건은 원래 권한으로 복구될 수 있다. 새 소유자는 자신의 권한을 따로 서명한다.
8. 지갑 없는 무료 게임도 확인한 다음, 모든 증거가 맞을 때 관리자가 뽑기를 다시 연다.

요청 후 reveal이 오지 않으면 뽑기를 닫고 기존 요청을 유지한다. 임의 seed나 다른 난수 경로로 대체하지 않는다. preflight readiness는 공급자의 장기 가동이나 실제 콜백을 보장하지 않는다.

지갑에서 속도 올리기나 취소로 트랜잭션을 교체했다면 복구 화면에 교체 거래 해시를 입력한다. 같은 발신자·실제 nonce와 확정 영수증을 확인한 경우에만 기존 대기를 해제한다. 원래 거래가 RPC에 한 번도 관측되지 않아 nonce를 보관하지 못했고 이후에도 조회할 수 없는 경우에는 추측으로 기록을 지우지 않는다. 그때는 지갑·explorer에서 원래 거래의 검증 가능한 정보를 먼저 확보해야 한다.

## 구현 업그레이드

업그레이드는 관리자(owner)만 프록시에 `upgradeToAndCall(newImplementation, data)`로 실행한다. 저장 상태(소유자, birth, 성장, 뽑기 풀, 대기 중 요청)는 프록시의 ERC-7201 네임스페이스(`mapae.storage.MapaeGuardians`)에 있어 그대로 유지된다. 모든 업그레이드는 `BatchMetadataUpdate(1, 10000)`를 발생시켜 마켓·인덱서가 전체 메타데이터를 새로 읽게 한다. 절차는 다음과 같다.

1. 새 구현은 `GuardiansStorage` 구조체 끝에만 필드를 추가한다. 기존 필드(`Account`, `Token`, `Growth` 구조체 포함)의 순서·타입을 바꾸거나 지우지 않는다. 네임스페이스 저장소는 `forge inspect ... storageLayout`에 나오지 않으므로 그 비교는 쓰지 않는다. 대신 `test_namespacedStorageLayoutIsPinned`와 `test_storageSlotMatchesErc7201AndPacksHotFields`가 **수정 없이** 새 구현에서 통과해야 하고, 업그레이드 테스트(`test_upgradePreservesStateAndPendingEntropyCallback`)를 새 구현으로 확장한다. `_EIP712Name`/`_EIP712Version`과 `_hashTypedDataV4`의 상수("Mapae Guardians", "1")를 유지해야 이미 발급된 결과 서명이 유효하다. 같은 테스트가 업그레이드 후 `eip712Domain()`을 확인한다.
2. Entropy 주소와 provider는 구현의 immutable이다. 보통은 새 구현도 같은 두 값으로 생성한다. 바꿀 때는 `setMintPaused(true)` 후 업그레이드한다. 요청은 (Entropy, provider, sequence)로 저장되므로 새 provider의 sequence가 예전 번호와 겹쳐도 뽑기가 막히지 않는다. 변경 시점에 대기 중이던 뽑기는 이전 Entropy/provider로는 더 이상 공개되지 않으며, 그 토큰의 민터가 `rerequestBirth(tokenId, contribution, maxFee)`로 새 수수료를 내고 다시 요청한다. 현재 쌍이 기존 요청을 아직 전달할 수 있으면 이 호출은 `PendingDraw`로 거절되므로 한 토큰이 두 개의 유효한 난수 중 하나를 고를 수 없다. 각 요청에는 토큰의 시도 번호가 함께 저장되고 콜백은 가장 최근 시도만 받으므로, 이전 Entropy/provider로 되돌려도 대체된 요청은 공개되지 않는다. 재요청은 `MintRequested`가 아니라 `BirthRerequested`를 내보내며, 보고서는 이를 민트로 세지 않고 웹 복구 화면은 두 이벤트를 모두 읽는다. 웹 복구 화면의 `GUARDIAN_ENTROPY`/`GUARDIAN_PROVIDER` 상수도 함께 바꾼다.
3. 새 구현을 배포·verify한다(생성자 인수 동일). 링크된 `GuardianMetadata` 주소가 이번에 배포·검증한 라이브러리 주소와 같고 런타임 해시도 일치하는지 확인한다. 최초 스크립트의 CREATE2 배포와 별도 업그레이드의 CREATE 배포를 혼동하지 않는다. `tokenURI`는 이 라이브러리를 DELEGATECALL하므로 잘못 링크된 주소는 프록시 저장소에서 실행된다. fork 시뮬레이션에서 `upgradeToAndCall`을 실행해 기존 토큰의 `tokenURI`를 비교한 뒤 관리자 지갑으로 실제 호출한다. 추가 초기화가 필요하면 `reinitializer(2)` 함수를 `data`로 함께 호출한다.
4. `Upgraded(implementation)` 이벤트와 preflight의 `implementation` 출력이 새 주소인지 확인한다. 프록시 주소는 바뀌지 않으므로 Worker·seller 설정은 그대로 둔다.

### 칭호·출석 기록과 묶음 기록(`claim`) 적용

이번 업그레이드는 한 번에 두 가지를 적용한다.

- **묶음 기록.** `claim(results, resultSignatures, honors, honorSignatures)`는 검증된 모험 결과와 전령의 칭호·출석을 한 트랜잭션으로 NFT에 기록한다.
  - 결과와 칭호를 합쳐 최대 32개(`MAX_CLAIM_BATCH`)까지 담는다.
  - 결과를 먼저 기록하고 칭호를 그다음에 기록한다.
  - 하나라도 잘못되면 전체가 되돌려진다.
  - 이미 기록된 결제와 이미 반영된 주차의 칭호는 검사를 통과한 뒤 건너뛴다.
  - 하나도 기록하지 못하면 `AlreadyClaimed`로 되돌려진다.
- **칭호·출석.** 칭호(게임별 장원·급제·입격 횟수)와 최장 출석은 서버가 서명한 누적값이다. 지난주는 화요일 0시(한국 시간)에 확정되고, 그 전에는 컨트랙트가 받지 않는다. `tokenURI`에는 게임별 칭호 3개와 `Longest streak`, `Streak milestone`이 더해진다.

**지워진 함수.** 기존 GIWA 운영 구현의 `claimResult`와 중간 개발 단계의 `claimResults`를 통합 `claim`으로 대체했다. 기존 `claimResult`는 실제 결과 반영에 사용된 배포 이력이 있으므로, 이 업그레이드와 seller·웹을 함께 적용해야 한다. 이 업그레이드 뒤에는 `claim`만 남는다.

**저장 구조.** `GuardiansStorage` 끝에 전령마다 한 칸(`honors`)이 붙는다. 기존 상태와 이미 발급된 결과 서명은 그대로 유효하다.

**바뀐 부분.** 메타데이터 라이브러리 `GuardianMetadata`가 바뀌었다. 그래서 새 라이브러리 배포, 새 구현 배포, `upgradeToAndCall` 한 번이 필요하다. 근거와 가스는 감사 문서의 칭호 부록에 있다.

모든 단계는 운영자가 직접 실행한다. 각 배포 명령은 `--broadcast` 없이 시뮬레이션을 먼저 하고, `--broadcast`가 붙은 두 번째 명령만 실제로 전송한다.

1. **검사.** 저장소 루트에서 다음이 모두 통과하는지 확인한다.
   - `make -C contracts test`
   - `(cd contracts && forge fmt --check)`
   - `bun run typecheck`
   - `(cd contracts && forge build --sizes)`: `MapaeGuardians` 런타임이 24,576바이트보다 작아야 한다. 현재 21,002바이트다.
2. **새 라이브러리 배포.** 비공개 환경을 셸에 로드한 뒤 새 `GuardianMetadata`를 배포한다. 출력의 `Deployed to:` 주소를 `<새_라이브러리>`로 기록하고, 위 `forge verify-contract $VERIFY <새_라이브러리> src/GuardianMetadata.sol:GuardianMetadata`로 verify한다. 최초 배포의 라이브러리 주소는 이제 쓰지 않는다. 예전 라이브러리는 새 `Progress` 형식을 모르므로, 예전 주소를 링크하면 `tokenURI`가 깨진다.

   ```sh
   cd contracts
   LIB_ARGS="--rpc-url giwa_sepolia"
   forge create src/GuardianMetadata.sol:GuardianMetadata $LIB_ARGS --private-key "$GUARDIAN_DEPLOYER_PRIVATE_KEY"
   forge create src/GuardianMetadata.sol:GuardianMetadata $LIB_ARGS --private-key "$GUARDIAN_DEPLOYER_PRIVATE_KEY" --broadcast
   ```

3. **새 구현 배포.** 새 라이브러리를 링크해 구현을 배포한다. 생성자 인수는 최초 배포와 같은 Entropy·provider 주소다.

   ```sh
   IMPL_ARGS="--rpc-url giwa_sepolia --libraries src/GuardianMetadata.sol:GuardianMetadata:<새_라이브러리> --constructor-args 0x0708325268dF9F66270F1401206434524814508b 0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344"
   forge create src/MapaeGuardians.sol:MapaeGuardians $IMPL_ARGS --private-key "$GUARDIAN_DEPLOYER_PRIVATE_KEY"
   forge create src/MapaeGuardians.sol:MapaeGuardians $IMPL_ARGS --private-key "$GUARDIAN_DEPLOYER_PRIVATE_KEY" --broadcast
   ```

4. **구현 verify와 확인.** 새 구현 주소를 위 구현용 `forge verify-contract` 명령으로 verify한다. 이때 `--libraries`에는 `<새_라이브러리>`를 넣는다. 그다음 아래 값을 확인한다.
   - `cast call <새_구현> "HONOR_TYPEHASH()(bytes32)" --rpc-url giwa_sepolia`가 `cast keccak "Honor(uint256 tokenId,uint16 week,uint16 longestStreak,uint144 titles)"`와 같아야 한다.
   - `cast call <새_구현> "MAX_CLAIM_BATCH()(uint256)" --rpc-url giwa_sepolia`가 `32`를 돌려줘야 한다.
5. **업그레이드.** 먼저 관리자 주소로 시뮬레이션한다. `cast call <프록시_주소> "upgradeToAndCall(address,bytes)" <새_구현> 0x --from <관리자> --rpc-url giwa_sepolia`가 되돌려지지 않아야 한다. 그다음 관리자 지갑(Rabby 또는 Blockscout의 Write as Proxy)으로 프록시의 `upgradeToAndCall(<새_구현>, 0x)`를 실행한다. 추가 초기화가 없으므로 `data`는 비워 둔다.
6. **사후 확인.** 다음을 차례로 확인한다.
   - **구현 주소와 이벤트.** `bun --no-env-file scripts/arcade-guardians-preflight.ts --collection <프록시_주소>`의 `implementation`이 새 구현 주소여야 한다. explorer에 `Upgraded`와 `BatchMetadataUpdate(1, 10000)` 이벤트가 있어야 한다.
   - **기존 전령의 성장.** `cast call <프록시_주소> "progress(uint256)" <토큰_ID> --rpc-url giwa_sepolia`에서 플레이·승리·최고 점수가 업그레이드 전과 같아야 한다.
   - **`tokenURI`.** 이번에는 업그레이드 전과 같지 않다. 기존 속성은 그대로이고, 칭호·출석 속성 11개가 0으로 새로 보여야 한다.
   - 업그레이드 해시와 새 라이브러리·구현 주소를 배포 기록에 남긴다.
7. **seller 재시작.** seller를 재시작해 새 `progress` 형식과 칭호 서명을 쓰게 한다. 업그레이드 전에 재시작하면 seller가 예전 구현의 `progress`를 읽지 못하므로, 반드시 6단계 뒤에 한다.
8. **웹 배포.** `bun run deploy:landing`, `bun run deploy:app`을 차례로 실행해 두 공개 웹을 함께 배포한다.

**업그레이드 전 웹.** 웹이 `claim`을 호출하는 배포는 업그레이드가 끝난 뒤에 한다. 업그레이드 전 구현에서는 `HONOR_TYPEHASH` 읽기가 되돌려진다. 그러면 모험 기록 화면은 업그레이드 대기 안내만 띄우고, 결과를 하나씩 기록하던 예전 경로로 돌아가지 않는다.

**서명 경로.** seller의 `POST /arcade/guardians/:tokenId/claims`가 서명을 한 번에 돌려준다.
- 결과: 현재 소유자의 아직 기록되지 않은 것을 오래된 순서로.
- 칭호: 체인보다 새 주차의 누적값이 있을 때만 하나.

웹 Worker는 `POST /api/arcade/profile/guardians/:tokenId/claims`로 이를 중계한다.

**순서 요약.** 순서는 다음과 같다.
1. 새 라이브러리 배포
2. 새 구현 배포
3. `upgradeToAndCall`
4. seller 재시작
5. `bun run deploy:app`

seller는 체인에서 기록됨을 확인한 결과를 DB에 표시해 두고 다시 묻지 않는다. 기록된 칭호는 따로 저장하지 않고, 체인의 `progress`에서 마지막으로 기록한 주차를 읽는다.

**확정된 주.** seller는 확정된 주의 게임별 상위 10위를 `arcade_guardian_titles`에 한 번 적어 둔다. 확정된 순위표에서 다시 만들 수 있는 캐시라서 지워도 되고, 표는 재시작 때 저절로 만들어진다. 이 배포부터 지난주 순위표는 마감(화요일 0시) 뒤에 정산된 판을 넣지 않고, 그 주가 끝날 때의 규칙 버전으로 순위를 매긴다. 그래서 규칙 버전을 올려도 지난주 순위와 칭호가 사라지지 않는다.

구현이 UUPS가 아니면(`proxiableUUID` 없음) 업그레이드가 되돌려진다. 업그레이드 권한을 잃지 않도록 관리자 키를 잃어버리거나 `renounceOwnership`을 호출하지 않는다. 호출하면 이후 업그레이드는 불가능하다.

### 시즌 1

시즌은 계약을 바꾸지 않는다. seller가 기존 일별 순위표에서 시즌 점수를 읽을 때 계산하고(저장 없음, 쿼리 한 번), 웹은 seller의 `/arcade/ranking/season` 상태로 단계를 안다.

- **점수.** 시즌 안의 날마다 놀이별 일별 순위표에서 1위 10점, 2위 7점, 3위 5점, 4–10위 3점, 그 밖의 참가 1점(하루 최대 30점). 시즌 안에서 출석 도장 7일을 이어 찍을 때마다 +10점. 봉인된 주(화요일 0시 이후 정산)는 일별 순위표와 똑같이 빠진다. 시즌 합계가 같으면 순위를 나눠 갖는다(같은 순위 안에서는 token 오름차순).
- **단계.** `packages/arcade/src/season.ts`의 `SEASON`이 `{id: 1, start: null, end: null}`이면 준비 중(배너는 규칙 미리 보기, 시즌 탭은 규칙·상품 안내). 날짜를 넣으면 시작 전 `announced`(D-n), 시작일부터 종료일까지 `open`, 그다음 날부터 `closed`(최종 순위, 시계 없음).
- **날짜 설정.** `SEASON`을 `{id: 1, start: "YYYY-MM-DD", end: "YYYY-MM-DD"}`(한국 시간, 종료일 포함)로 바꾸는 커밋 한 건 → mini에서 pull → `bun install --frozen-lockfile` → `io.mapae.delegated-seller` 재시작. 날짜는 seller만 읽으므로 **웹 재배포가 필요 없다**. 시작은 월요일, 종료는 일요일을 권장한다(마지막 주의 봉인 화요일 0시와 맞물린다).
- **배포 순서.** 이 기능이 처음 올라갈 때는 seller 재시작 → `deploy:app`. 재시작 전에는 웹 프록시의 `/api/arcade/ranking/season`과 시즌 보드가 503이라 로비 배너는 보이지 않고 시즌 탭은 오류 안내를 보여 준다. `/guardians/:ids`(내 전령의 자리·로비 도크의 순위 줄)도 `season` 필드가 없어 프록시 검증에서 503이 되므로, 이전 단계처럼 seller 재시작을 먼저 한다. 공개 순위표(일별·주간·꾸준함)만 영향이 없다.
- **상품·문양·명예의 전당.** 상위 3명 커피 기프티콘과 7일 연속 출석 전령 중 추첨 5명은 시즌이 끝난 뒤 수동으로 전달한다(아래 "명예의 전당·상품 전달"). 시즌 한정 문양은 seller가 봉인한 전당에서 웹이 SVG로 그린다 — 계약을 바꾸지 않으므로 온체인 특성이 아니다.

### 공유 카드

오늘 순위와 시즌 점수를 X에 올릴 수 있게 1200×630 PNG 카드와 og 메타가 담긴 공유 페이지를 만든다. 계약·seller 저장소는 바뀌지 않는다: seller는 `/arcade/ranking/card/:game/:day/:tokenId`와 `/arcade/ranking/card/season/:tokenId`로 기존 순위표의 사실(JSON)을 주고, 같은 경로 뒤에 `/png`를 붙이면 `packages/arcade/src/share-card/`의 렌더러로 카드를 직접 그려 준다(외부 폰트·브라우저·이미지 서비스 없음). 웹 Worker는 `apps/web/src/arcade/share/`에서 페이지용 JSON을 검증해 그리고, 카드 PNG는 seller에서 받아 검증·캐시만 한다 — 그리기를 Worker에 두면 캐시 미스 한 번에 ~90ms CPU가 들어 Workers Free(요청당 10ms)에 맞지 않기 때문이다.

- **경로.** 카드 `/api/arcade/share/g/:tokenId/:game/:day/card.png`·`/api/arcade/share/s/:tokenId/card.png`, 페이지 `/share/g/:tokenId/:game/:day`·`/share/s/:tokenId`(앞에 `/ko` 붙이면 한국어). 날짜는 오늘부터 365일 전까지, 그 밖의 날짜·쿼리 문자열·잘못된 형식은 404. 웹 버튼은 `https://x.com/intent/post?text=…&url=<페이지>`와 `카드 저장`(download) 두 가지이며 추적 매개변수는 붙이지 않는다.
- **캐시.** 지난 날 카드와 봉인된 시즌 카드는 가장자리 1시간, 오늘 카드와 열린 시즌 카드는 60초이고, 브라우저에는 페이지와 카드 모두 60초다. 캐시 적중 응답은 존의 Browser Cache TTL(4시간)을 달고 돌아오므로 Worker가 브라우저 수명을 다시 붙인다(`apps/web/src/lib/edge-cache.ts`)(seller가 PNG에 `Cache-Control: public, max-age=3600|60`과 `"card-…"` ETag를 실어 보내고, Worker는 그 둘과 PNG 서명·1200×630 헤더를 확인한 뒤 자기 헤더로 다시 만들어 저장한다 — 그 밖의 응답은 503). 캐시 키에 `CARD_REVISION`이 들어가므로 카드 디자인을 바꿀 때는 `packages/arcade/src/share-card/contract.ts`의 `CARD_REVISION`을 올린다(X는 카드 이미지를 자체 캐시하므로 이미 올린 글의 미리 보기는 바뀌지 않는다). seller가 꺼져 있거나 응답이 검증에 걸리면 503 + `Retry-After: 5`(no-store), seller 404(그날 기록 없음)와 시즌 보드가 아직 없을 때의 시즌 카드(seller 400)는 30초 캐시되는 404. 발행 상한을 넘는 토큰 번호와 1년 밖의 날짜는 seller를 부르지 않고 404.
- **CPU 예산.** Worker는 프록시만 한다(요청당 ~1ms, Workers Free 유지). seller가 캐시 미스마다 레이어 합성·인코드로 약 90ms의 동기 CPU를 쓰며 그동안 이벤트 루프를 잡는다 — 상한은 Worker의 캐시(라이브 카드 60초·확정 카드 1시간)와 IP 예산이고, 이 경로는 Worker만 부른다(bearer).
- **레이어 PNG.** seller는 `ARCADE_ART_DIR`(기본 `apps/web/public/arcade`, 저장소 기준)에서 `share/*.png` 36장(옷장·부적 WebP를 `apps/web/scripts/share-layers.sh`로 320px PNG로 바꾼 것, 약 4.9MB)과 `wardrobe/fit.json`을 첫 카드 때 한 번 읽어 메모리에 올린다(디코드 뒤 약 15MB). **mini에는 에셋 저장소의 `arcade/` 복사본이 그 경로에 있어야 한다**(`apps/web/public/arcade/`는 git 밖; CI도 같은 자리에 복사한다. Worker는 그 36장을 쓰지 않으므로 `apps/web/public/.assetsignore`가 `arcade/share/`를 배포에서 뺀다). 없으면 PNG 경로가 503이라 Worker 카드도 503이고, 파일을 넣으면 재시작 없이 다음 카드부터 읽는다. 테스트는 파일이 있을 때만 실제 레이어를 쓴다.
- **배포 순서.** mini `git pull` → `bun install --frozen-lockfile` → 에셋 복사본 확인 → seller 재시작 → `deploy:landing`(`/share/*` 페이지는 랜딩 Worker가 받는다) → `deploy:app`. 재시작 전의 옛 seller는 `/card/…/png`에 404를 답하므로 새 Worker가 먼저 올라가면 카드가 30초짜리 404로 캐시된다 — seller를 먼저 올린다. 두 Worker 모두 `ARCADE_RECEIPT_TOKEN`이 있어야 seller를 읽는다. WAF나 봇 차단 규칙이 있다면 `Twitterbot`·`facebookexternalhit`·카카오 미리 보기 크롤러가 `/share/*`와 `/api/arcade/share/*`를 읽을 수 있어야 미리 보기가 뜬다.
- **다음 단계.** 카드 글자는 영문 대문자 픽셀 폰트뿐이다. 한글 전령 이름을 카드에 올리려면 한글 글리프 아틀라스를 레이어처럼 에셋 저장소에 넣는 작업(3b)이 따로 필요하다.

### 띠 팀전

전령은 태어난 띠(seed의 첫 특성)대로 열두 팀 중 하나에 속하고, 같은 띠 전령의 점수를 더해 팀끼리 겨룬다. 계약·seller 저장소·테이블은 바뀌지 않는다: seller가 읽을 때마다 `arcade_guardian_ranked`를 한 번 훑어(`SEASON_TOTALS`, 시즌 보드와 같은 질의) `guardian_seed`로 띠를 유도해 묶는다(RPC 없음, seed→띠는 `packages/arcade/src/guardians.ts`의 `guardianZodiac`).

- **계산 규칙.** 팀 점수 = 팀원 점수의 합. `week`는 이번 주 월–일 창의 일별 순위 점수만 더하고(출석 보너스 없음, 시즌과 무관하게 연중), `s<id>`는 시즌 보드의 점수(보너스 포함)를 그대로 묶는다. 순위는 합계로, 동점은 순위를 공유하고 띠 순서(쥐→돼지)로 보여 준다. 팀원은 그 창에 랭크 도전 기록이 한 번이라도 있는 전령이고, `top`은 그 팀에서 점수가 가장 높은 전령(동점이면 낮은 token). 12행이 항상 오고 0명 팀은 `members 0 · top null · points 0`. `/guardians/:ids`의 `weekPoints`는 같은 주간 합에서 내 전령의 몫이다.
- **경로.** seller `GET /arcade/ranking/board/team/<week | s<id>>`(bearer, 페이지 없음, 시즌 전·다른 id는 400, reader 없음 503). 웹 프록시 `/api/arcade/ranking/board/team/<period>`는 보드와 같은 30초 가장자리 캐시·IP 예산이며 사본을 엄격히 검증한다(12띠 각 한 번, 합계 내림차순·순위 공유, `members ≤ points ≤ members×상한`, `top`의 seed가 그 띠, `Σmembers = entrants`). 검증에 걸리면 503.
- **웹.** 랭킹 `#team` 탭(이번 주 | 시즌 N 토글, 시즌이 진행·종료면 시즌이 기본), "우리 팀" 표식과 내 기여 비율, 로비 도크의 "우리 호랑이팀 3위 · 1위까지 120점" 줄(시즌이 열려 있고 참가자가 있을 때만).
- **배포 순서.** **seller 재시작이 먼저**, 그다음 `deploy:app`. 새 웹이 옛 seller를 읽는 동안은 `/guardians/:ids` 사본에 `weekPoints`가 없어 프록시가 503을 내므로 "내 전령의 자리"·도크의 순위 줄이 잠시 비고, 띠 팀전 탭도 503 안내를 띄운다. 공개 보드(`/board/...`)와 시즌 상태는 영향이 없다. 반대 순서(seller만 새것)는 옛 웹이 `weekPoints`를 무시하므로 안전하다.
- **다음 단계.** 1위 팀 전령의 우승 팀 표식은 시즌 봉인 뒤 전당의 `teams`에서 유도해 웹이 그린다(아래). 표식을 NFT 특성으로 남기는 일은 계약 업그레이드 때로 미룬다. 팀 순위 ▲▼ 변동도 이번에는 넣지 않았다.

### 명예의 전당·상품 전달

시즌이 끝나면 seller가 최종 순위를 한 번 봉인하고, 웹은 그 사본으로 명예의 전당·문양·추첨을 보여 준다. 계약은 바뀌지 않는다. 문양은 seller가 봉인한 `participants`·`podium`·`teams`에서 유도해 웹이 SVG로 그리므로 지갑·마켓플레이스에는 보이지 않는다 — 온체인 특성(`uint80 marks` 같은 비트 필드)은 Honor 계약 업그레이드 때 넣는다.

- **봉인.** seller 테이블 `arcade_season_hall(collection, season, sealed_at, data, PK(collection, season))`. 시즌이 닫힌 뒤 마지막 주의 봉인 시각(화요일 0시, `hallSealsAt`)을 지나 처음 읽힐 때 시즌 보드·팀 보드·주간 장원·7일 연속 출석 풀을 모아 한 번만 쓴다. 그 전에는 `/arcade/ranking/hall/s1`이 `{sealed: false, sealsAt}`를 답하고 웹은 "종료 · 최종 집계 중"과 화요일 0시 확정 안내를 보여 준다. 종료 블록은 `seasonEndsAt`(종료일 다음 날 0시 KST) 이후 첫 GIWA 블록을 RPC 이진 탐색(약 25번 `getBlock`)으로 찾는다. RPC가 막히면 봉인하지 않고 다음 읽기에 다시 시도하며, seller 로그에 `[ranking] season N not sealed — close block unavailable`이 남는다. 한 번 봉인되면 `SEASON.id`를 2로 올려도 `/hall/s1`은 테이블에서 답하고, 모르는 시즌은 404.
- **공동 순위.** 시상대는 순위 3 이내 전원이다(동점이면 3명을 넘을 수 있고, 모두 시상대 문양과 기프티콘을 받는다). 팀전 1위가 동점이면 그 팀 모두 우승 팀 표식을 단다. 아무도 참가하지 않은 시즌은 시상대·우승 팀·추첨 없이 봉인된다.
- **추첨 공식.** 풀 = 시즌 안에서 7일 연속 출석을 1회 이상 완주한 전령(token 오름차순). seed = 종료 블록 해시. `i`번째 당첨은 `keccak256(seed ‖ uint256(i)) mod 남은 수`로 고르고 뽑힌 전령은 풀에서 뺀다(5명, 풀이 작으면 그만큼). 공유는 확인할 길이 없어 자격에 넣지 않는다.
- **운영 순서.**
  1. 종료 — 종료일 다음 날 0시 KST에 seller `/season`이 `closed`를 답하고 웹은 집계 중으로 바뀐다. 아무것도 하지 않는다.
  2. 봉인 확인 — 화요일 0시 KST 뒤 `curl https://mapae.io/api/arcade/ranking/hall/s1`에서 `"sealed": true`를 본다. `false`가 이어지면 seller 로그의 RPC 오류를 보고 한 번 더 읽는다(읽기가 곧 재시도).
  3. 추첨 검증 — `bun --no-env-file scripts/season-raffle.ts --season 1`이 공개 RPC에서 종료 블록을 다시 찾고 당첨자를 다시 뽑아 비교한다(불일치면 종료 코드 1 — 그때는 봉인 데이터를 의심하고 공지하지 않는다). JSON 출력(블록 번호·해시·풀·당첨 5명)은 비공개 저장소 `season-1-result.md`에 남기고, X 공지에는 블록 번호와 해시를 적는다.
  4. DM 처리 — 당첨 전령의 주인이 `@mapae_io`에 전령 번호를 DM으로 보내면 `Mapae Arcade Season 1 prize\nGuardian #<id>\nX: @<handle>` 문장을 지갑에서 서명해 달라고 안내하고, `bun --no-env-file scripts/season-raffle.ts verify --collection <전령 계약> --token <id> --handle <handle> --signature 0x…`로 `ownerOf`와 대조한다(가스·트랜잭션 없음). X 계정 하나에 상품 하나. 기록은 token·X 계정·발송일만 남기고 지갑 주소와 서명 본문은 남기지 않는다. 시즌 뒤 양도된 전령은 서명 시점의 소유자가 받는다.
  5. 배포 순서 — seller 재시작 → `deploy:landing` → `deploy:app`. 옛 seller에 새 웹이 붙으면 `/hall/s1`이 404라 프록시가 503을 내고 전당 영역만 오류 안내를 띄운다(순위표·시즌 상태는 그대로). 공유 카드는 `CARD_REVISION` 3으로 봉인 뒤 문양 줄이 더 그려진다.

### 신뢰 경계

- 관리자는 모든 상태를 신뢰받는다. 업그레이드는 즉시 적용되고(timelock 없음) birth·성장·소유권을 바꿀 수 있으며, 결과 서명자를 자기 키로 바꿔 성장을 직접 발급할 수도 있다. 관리자/서명자 분리는 서명 키가 유출돼도 관리자 권한을 얻지 못하게 하는 키 위생 규칙이다. 테스트넷 밖에서 쓰기 전에 owner를 multisig(필요하면 TimelockController)로 `transferOwnership` → `acceptOwnership`한다.
- 교체한 결과 서명 키는 폐기된 것으로 본다. 결과에는 만료가 없어서, 예전 키로 되돌리면 그 키가 서명했지만 청구되지 않은 결과가 다시 유효해진다.
- 정식 컬렉션은 `ARCADE_GUARDIAN_ADDRESS`의 프록시 하나뿐이다. 누구나 같은 구현 앞에 자기 프록시를 세워 같은 이름의 토큰을 만들 수 있으므로 마켓·인덱서에는 프록시 주소를 기준으로 안내한다. 서명 domain·birth seed·Pyth 요청자가 모두 프록시 주소에 묶여 있어 다른 프록시로 옮겨지지 않는다.
- 감사 기록: [MapaeGuardians UUPS audit 2026-10-11](audits/mapae-guardians-uups-2026-10-11.md).

## 운영 중 중지와 기록

신규 뽑기는 `setMintPaused(true)`로 중지한다. 외출 문제가 있으면 사용자 UI에서 중지·권한 회수하고 필요 시 `ARCADE_OUTINGS_ENABLED=false`로 seller를 재시작한다. 이미 제출한 결제·결과 DB는 보존한다. 이전 가변 캐릭터 버전으로 되돌려 NFT 작업을 실행하지 않는다.

seller가 잠깐 닿지 않으면(재시작, 터널 재연결, 미니의 VPN 전환) 웹 순위 프록시는 마지막으로 검증한 사본을 `no-store`로 답한다. 가장자리는 사본을 수명(보드 30초, 내 자리 10초, 시즌·전당 60초, 봉인된 전당 1시간)보다 최대 1시간 더 보관하되, 아직 진행 중인 날을 다루는 사본은 그날 자정(KST)을 넘기지 않는다(이미 끝난 날의 보드와 전당은 바뀌지 않으므로 1시간 그대로). 그래서 새 날에 전날의 남은 도전 수나 순위가 오늘 것처럼 보이지 않는다. 사본이 없는 경로는 그대로 503이다. 공유 카드는 이 대상이 아니다.

배포 기록에는 git SHA, 체인 ID, NFT 프록시 주소·구현 주소·라이브러리 주소·배포 해시·관리자·결과 서명자, 업그레이드 해시, 난수 요청/공개 해시와 token/sequence, 입장·성장 해시, D1 적용 시점, seller 재시작 시점, 두 Worker version ID를 남긴다. 개인 키·bearer·권한 원문은 기록하지 않는다. 실제 이용자 성과 보고서는 [파일럿 안내](arcade-guardians-pilot.md)의 읽기 전용 도구로 별도 생성한다.

## 운영 적용 및 실제 GIWA 검증 — 2026-10-10 KST

Mac mini의 기존 체크아웃에서 `origin/main`의 `e7d196942cb2ea3adb42b5b3c016eaa176ae8f33`을 fast-forward로 받았다. 기존 로컬 변경은 백업·stash와 로컬 보존 커밋 `55dfd7ff2a40d7c0a8d0d253e5776cd6026d7290`에 남겼다. 아래 운영 검증 중 수정한 코드도 로컬에 보존했다. 사용자가 받기만 요청한 뒤 GitHub에 푸시하지 않았다.

공개 주소·거래·canary 구분과 Worker 버전은 [배포 artifact](../deployments/giwa-sepolia.guardians.json)에도 기록했다.

적용 전 활성 외출이 없음을 확인했고, 기존 seller SQLite의 암호화 온라인 백업과 복구 drill, D1 export·무결성 검사를 통과했다. D1의 기존 프로필·인증 테이블을 유지하며 engagement schema를 추가했다. 기존 `STORE_PATH`, 결제 에이전트, `ARCADE_RECEIPT_TOKEN`, RPC 설정을 유지하고 별도 결과 서명 키와 NFT 주소를 연결했다. `system/io.mapae.delegated-seller`를 관리자 인증으로 재시작하고 14:14 KST에 실행 PID 57229, health 200, NFT API 200 및 컬렉션 일치를 확인했다. 다른 세 funded 서비스의 재시작이나 추가 인스턴스 생성은 없었다.

| 항목 | 적용 값 |
| --- | --- |
| 체인 | GIWA Sepolia, 91342 |
| NFT 컬렉션 | `0x0144F8C5cA15D55136542aECf025c656e66cf9A6` |
| 배포자·관리자 | `0x00A7b901abb908ecafEC72973906424c4fDdc100` |
| 별도 결과 서명자 | `0x7B704FD8d96CcA7d441B3114C0B69AbfbE864064` |
| 기존 결제 에이전트 | `0xE50a03A16ee644a584840893362EDaAD66DA67Bc` |
| 이미지 base URI | `https://mapae.io/api/arcade/guardians/` |
| 공유 D1 | `mapae-arcade-profiles` / `4b131cc7-83a4-4980-b53e-1460f7706fc0` |
| D1 적용 후 bookmark | `0000002f-00000006-00005100-48121f7b5826eb361624a4758167e486` |

Forge 시뮬레이션 후 실제 배포에 성공했고, explorer의 계약 소스 검증도 `Pass - Verified`로 확인했다. 계약은 뽑기가 중지된 상태로 배포했다. 테스트 뽑기 한 번만 열었다가 닫고, 아래 검증을 마친 뒤 14:31:59 KST에 공개 뽑기를 다시 열었다.

| 실제 GIWA 거래 | 트랜잭션 해시 |
| --- | --- |
| NFT 계약 배포 | `0x51852793a6bcf542c473e8f1f10babb5c0c0c03cdd7b9b1852a61ef3a4f4b307` |
| NFT #1 뽑기, sequence 1 | `0xd1ba65bcf5ec90141fda486debee117fb1379abe5143b6f562d4cf9a734cb970` |
| 공급자의 자동 `BirthRevealed` | `0x1ac8e98f84cfa7a0da781460430455702398e2738a27fd70d978305d0b09c887` |
| 1 mUSDC 외출 입장 | `0xda1689d2757aeba5f984c088e3082c58fe9429eaef6a6737e871448b22e60ff9` |
| NFT 성장 `ResultClaimed` | `0xa68e08f5143fa79428a557810233224f7e8411770f125658fc05e0b529c24888` |
| 검증 완료 후 뽑기 공개 | `0x2866b03f5285ba89d7f722722a4591d136158d48bde07db0b0e9e1439d7dc3b2` |

테스트 소유자는 `0xd0ECc3ED81e8275F4D9e46242dE0d3B35ddbB317`, 스마트 payer는 `0x40753152109bE6979592EfD986640E872A56dfd4`다. 운영자용 별도 테스트 지갑을 실제 운영 Chrome UI에 연결했다. 개인키는 로컬 서명 프로세스에만 두었으며 브라우저나 웹 Worker로 전달하지 않았다. 관리자 지갑에서 테스트 지갑에 0.001 GIWA 테스트 ETH를 공급했고, 기존 bootstrap은 스마트 계정에 1,000 mUSDC를 준비했다. 사용한 입장료는 정확히 1 mUSDC이며 잔액은 999 mUSDC다.

| 검증 | 실제 결과 |
| --- | --- |
| 뽑기·난수 콜백 | NFT #1 / sequence 1 성공. 공급자의 자동 콜백으로 공개했으며 수동 seed·재추첨을 쓰지 않음 |
| 외형·성향·적성 유지 | 새로고침 전후와 두 운영 도메인에서 동일 seed, 돼지·차분함, 도장 5 / 경주 4 / 상회 6 확인 |
| 1 mUSDC 결제·결과 | 정확한 MockUSDC `Transfer` 1,000,000 기본 단위, 고정 payer/payee, seller paid order와 facilitator journal 대조. payer 가스 부담 0 |
| 성장 | 도장 64,540점·승리 결과. 같은 token/result/payment의 `ResultClaimed`, plays 1·victories 1·experience 15 확인 |
| 외출 재요청 | 같은 서명·외출 ID를 다시 보내도 완료 작업·사용액 1·결과 1건 유지 |
| 성장 재요청 | API 200 / `claimed:true` / 서명 없음. 원래 calldata의 읽기 전용 시뮬레이션은 `AlreadyClaimed`로 거절. 추가 거래를 보내지 않음 |
| 무료 체험 | 지갑 provider가 없는 별도 운영 브라우저에서 60초 게임 완주·58,720점·무료 결과 확인 |

검증 중 발견한 문제도 반영했다. Foundry의 custom Blockscout 설정에서 지원 체인 allowlist를 유발하던 `chain` 항목을 제거하고 실제 소스 검증까지 완료했다. 공개 preflight RPC는 기존 throttled transport로 요청 간격을 조정했다. bootstrap 성공 직후 공개 RPC의 잔액 반영이 늦어 외출이 중단되는 경우에는 잔액을 최대 6회 읽도록 했다. 다시 서명하거나 계정 생성·결제를 반복하지 않는다. 이번 canary는 최초 중단 후 이미 서명된 동일한 1회 한도 root를 복구하여 외출 API에 제출했다. 새 지갑의 전체 버튼 흐름을 수정 후 처음부터 다시 검증한 것으로 계산하지 않는다.

또한 성장 버튼의 POST에 서버가 요구하는 빈 JSON 본문이 빠져 있던 문제를 수정했다. 수정한 운영 버튼에서 실제 성장 거래가 성공했다. 전체 `bun run check`는 TypeScript 1,550건·Foundry 37건과 타입·빌드·문서·저장소·로그·의존성 감사 게이트를 통과했다. 마지막 성장 요청 수정 후 웹 타입 검사와 418 tests / 14,602 expects를 다시 통과했다.

| Worker | 최종 version, 100% | 직전 NFT 버전 | deployment |
| --- | --- | --- | --- |
| `mapae` | `43d9781e-f945-4df7-87cd-e906e09c258e` | `b70ad8d2-a7c0-4f19-b347-9315880c5895` | `863221fa-8e59-4435-bbb3-949b421a6fb0` |
| `mapae-app` | `45df6cde-d93f-4042-8836-fcb9b8c06981` | `bc5d5b1d-0fd7-49c9-8d13-6877bfab70eb` | `bb7f828d-566f-4532-a38e-7e1e9c78d6b4` |

두 Worker는 14:25:56 / 14:26:12 KST에 배포했다. 각 최종 Arcade JS/CSS SHA-256이 로컬 배포 빌드와 일치하고, 두 이미지 API가 기존 WebP를 포함한 독립 SVG를 200으로 반환했다. 기존 도메인·DNS·Tunnel·보안 헤더·시크릿은 유지했다. D1와 ASSETS binding, landing의 `17 15 * * *` cron을 확인했다. 두 도메인에서 인증된 NFT·15 XP와 390px 가로 넘침 없음을 확인했다. `scripts/ops/check.ts` 및 seller/facilitator 원장 대조도 통과했다(3 orders / 3 intents, issues 없음).

증거는 이 Mac의 비공개 `~/.mapae/backups/guardian-release-20261010-135045`에 보관한다. canary 데이터는 실제 사용자 성과와 구분해야 한다. 실물 휴대폰·Rabby/MetaMask 확장 및 앱, 운영 NFT 이전 후 권한 중단·철회 거래는 이번 라이브 검증 범위에 포함하지 않았다. 소유권·재사용·서명 변조 등의 로컬 회귀 검사는 위 전체 검사에 포함된다. 같은 디스크의 백업이며 기기 밖 재해 복구 사본 확보를 대신하지 않는다.

## NFT 세션 전용 웹 업데이트 — 2026-10-10 14:58 KST

`git pull --ff-only origin main`으로 `930b2346a058d83f52ced62b4d22e9b74c0e4453`을 반영했다. 갈라진 로컬 커밋은 `backup/before-forced-ff-20261010-145547`에, 미커밋 변경은 stash와 비공개 백업에 보존한 뒤 로컬 수정도 다시 적용했다. 두 README의 테스트 수 충돌을 현재 1,519 TS / 웹 387 / Foundry 37로 정리했다. 문서뿐 아니라 앞서 검증한 성장 POST 본문·잔액 조회 재시도·preflight 및 Foundry 수정도 유지하고 스테이징했다. 새 커밋과 푸시는 하지 않았다.

`bun install --frozen-lockfile`, 전체 `bun run check`(1,519 TS + 37 Foundry), `bun run deploy:landing`, `bun run deploy:app`을 순서대로 완료했다. 이번 코드는 가변 캐릭터 동기화를 제거하고 `/api/arcade/profile/session`의 지갑 로그인 세션으로 NFT 조회·외출을 인증한다. 운영 점검 도구의 인증 확인 주소도 이 새 경로로 변경했다. 기존 DB 테이블을 삭제하거나 계약을 재배포하지 않았다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `09ca180d-7b36-4960-9aec-8319da8a88a4` | `43d9781e-f945-4df7-87cd-e906e09c258e` | `d379d14d-9150-497b-ba3d-8b698d42951c` |
| `mapae-app` | `946aa7e8-1036-49c5-adee-ebb4869cf8b1` | `45df6cde-d93f-4042-8836-fcb9b8c06981` | `5c50697f-247e-4e7e-ade8-29292d6b9a61` |

배포 API에서 두 버전의 100% 전환, 각 Arcade JS/CSS의 로컬 빌드 SHA-256 일치, NFT 이미지 200을 확인했다. 읽기 전용 지갑 provider와 기존 SIWE 세션을 사용한 운영 브라우저에서 두 도메인의 session·NFT API 200, 기존 가변 profile API 404, NFT #1의 모험 1회·15 XP 유지, 390px 가로 넘침과 런타임 예외 없음을 확인했다. 이번 업데이트 확인에서는 새 서명·결제·민팅 거래를 전송하지 않았다. 세부 증거와 pull 전 복구본은 `~/.mapae/backups/git-pull-20261010-145547`에 보관했다.

## 랜딩·Studio·아케이드 디자인 배포 — 2026-10-11 10:53 KST

`origin/main`의 `e8086469a1be3203ded771e13067a82473986e7c`까지 fast-forward로 반영했다. 기존 로컬 수정과 스테이징 상태는 별도 branch·stash·patch로 보존한 뒤 복원했다. README의 테스트 수 충돌만 현재 수로 정리했다. 성장 요청의 빈 JSON 본문, 잔액 반영 대기, 운영 점검 경로 등 기존 수정도 유지했다. `bun install --frozen-lockfile`와 전체 `bun run check`(TypeScript 1,653개, 웹 491개 포함 / Foundry 37개)가 통과했다.

랜딩의 조판·대비·공통 헤더와 모바일 메뉴, Studio의 계정 칩·버튼 위계·한글 제목, 아케이드의 입구·전령단·무료 게임 전환 및 모션을 새 코드로 배포했다. 웹에서 MetaMask 키트의 opt-out 값 `doNotTrack=1`도 확인했다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `efc9449e-385d-4213-b503-897dfb8855d3` | `09ca180d-7b36-4960-9aec-8319da8a88a4` | `48715970-ef8c-4133-b03e-f25b21a117e7` |
| `mapae-app` | `7b70328f-6514-492e-88ad-a9ae0f333b6e` | `946aa7e8-1036-49c5-adee-ebb4869cf8b1` | `6644e574-d192-4d76-82a2-61dd527dff4b` |

각 도메인의 배포 API를 재조회하고 클라이언트 JS/CSS 14개씩, 총 28개 응답의 SHA-256을 해당 배포 빌드와 대조했다. 기존 D1·ASSETS·시크릿·도메인과 landing cron을 유지했다. 한영 랜딩·Studio·양쪽 아케이드의 320/390/1440px 총 24개 운영 화면에서 가로 넘침·이미지 실패·브라우저 오류가 없었다. 모바일 랜딩 메뉴 열기와 Escape 닫기, 주요 화면 스크린샷을 확인했다.

기존 SIWE 세션과 읽기 전용 지갑 provider를 사용해 양쪽 NFT 화면의 API 200, NFT #1의 모험 1회·15 XP 유지, 390px 가로 넘침 없음을 확인했다. 운영 상태 점검도 통과했다. 이번 디자인 적용의 검수는 데스크톱 Chrome viewport 기반이며 새 지갑 서명·GIWA 거래를 만들지 않았다. 로컬 변경은 스테이징한 상태로 유지하고 커밋·푸시하지 않았다. 소스 복구본·빌드·검사 로그·브라우저 증거는 `~/.mapae/backups/design-release-20261011-105126`에 보관했다.

지갑 없는 운영 무료 체험에서 입구→연습 로비→도장찍기 60초 완주→결과 화면 전환도 확인했다. 실제 UI 클릭으로 진행했으며 결과 화면의 무료 표시, 390px 가로 넘침 없음과 콘솔 오류 0개를 확인했다.

## 고유 이름·랜덤 토큰 컬렉션 재배포 — 2026-10-11 11:56 KST

Mac mini의 기존 체크아웃에 `4588ef4c8baac1df6895a2a1d7f840c1a48189bc`를 fast-forward로 반영했다. 기존 로컬 수정은 branch·stash·patch에 보관한 뒤 복원하고 스테이징했다. README 테스트 수 충돌을 현재 수로 정리했으며 커밋·푸시는 하지 않았다. `bun install --frozen-lockfile`와 전체 `bun run check`가 통과했다(TypeScript 1,658개, 웹 491개 포함 / Foundry 39개).

기존 관리자 지갑으로 Forge 시뮬레이션 후 GIWA Sepolia에 새 `MapaeGuardians`를 배포하고 explorer 소스 검증까지 완료했다. 새 컬렉션은 민팅 시 1–10,000 중 사용하지 않은 번호를 뽑으며, 번호의 고유 이름과 Pyth가 정하는 외형·성향·적성은 별개다. 이름 선택용 번호는 편향을 시도할 수 있으며 공정한 경품 추첨 수단으로 검증한 것이 아니다.

| 항목 | 값 |
| --- | --- |
| 새 컬렉션 | `0x26Cb90dA20a58955D497d2e8be53Ff68aC4A5eFc` |
| 배포자·관리자 | `0x00A7b901abb908ecafEC72973906424c4fDdc100` |
| 결과 서명자 | `0x7B704FD8d96CcA7d441B3114C0B69AbfbE864064` |
| 배포 거래 | `0xee4df1c511a94c3b85c14b97df2ddd3d436baa9007100f25b326c8c516d66e28` |
| 배포 블록 | `38341491` |
| 테스트 전령 | 토큰 `9279`, `장터 가는 금동이` / `Market-Bound Geumdongi`, 토끼 |
| 자동 난수 공개 | sequence `3`, 도장 6 / 경주 5 / 상회 4 |

기존 seller의 활성·미확정 외출이 없음을 확인했다. 서비스 중지 전과 중지 후 SQLite 암호화 백업·복구 drill을 수행하고, 완료된 예전 `#N` 외출 2건은 비공개 파일로 보관한 뒤 목록에서 정리했다. 기존 paid orders 8건과 guardian results 6건은 보존했다. `.env`의 NFT 주소만 변경하고 동일한 `system/io.mapae.delegated-seller`를 재시작해 11:46 KST에 health·NFT API 200과 새 주소를 확인했다. `STORE_PATH`, 영수증 토큰, 결제·결과 서명 키와 RPC 설정은 유지했다. D1은 export·무결성 검사 후 기존 스키마를 유지했으며 이번 변경에 새 마이그레이션은 없다.

| Worker | 최종 version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `f269fca8-9a13-4347-aa35-f3705399a70e` | `efc9449e-385d-4213-b503-897dfb8855d3` | `f3eb32b9-dbc9-406c-9b42-6111f8013e85` |
| `mapae-app` | `ec0f9a0c-c007-4c2a-ba10-4b442bd015ea` | `7b70328f-6514-492e-88ad-a9ae0f333b6e` | `ec0cd690-6b1d-4d1d-8855-f763aef20f1d` |

두 Worker의 `ARCADE_GUARDIAN_ADDRESS`를 새 주소로 설정하고 각각 빌드·dry-run·배포했다. D1·ASSETS 바인딩, landing cron, 도메인·시크릿·보안 헤더는 유지했다. 최종 클라이언트 JS/CSS 28개 응답의 SHA-256이 해당 로컬 배포 빌드와 일치했다. 이미지 에셋 변경은 없다.

| 실제 GIWA 검증 | 거래·결과 |
| --- | --- |
| 민팅 | `0x2be5e455b43f6c8f3130fbcd78e7fc9a4f9377a5e15961b93c183a4bf05b8668` |
| 자동 `BirthRevealed` | `0xdb3f8f9298c85e6cc4ca0fcecd64a384ba639cc43cf12ed15a79c1d7b1fbcc63` |
| 1 mUSDC 입장 | `0x234da66a813ae1a78d218a479696a3fb539aac66ee2b4a6b2acb877fa257eee3` |
| `ResultClaimed` | `0x05de10af04d43178c65b0de32b98ce1065837ea29d81c0caece8768cf3e1532c` |
| 검증 후 민팅 공개 | `0x83c393385719bf6db4bc5d3ee6b804d446e10de350bf728e9d1290f0a2c634d1` |

기존 별도 운영자 테스트 지갑으로 실제 운영 UI에서 새 전령을 뽑고 1회 한도 외출을 시작했다. 새 bootstrap·추가 충전 없이 스마트 계정 잔액은 999→998 mUSDC, native 잔액은 0을 유지했다. 정확한 1,000,000 기본 단위 Transfer·고정 payer/payee·seller order·facilitator journal을 대조했고 입장 결제의 payer 가스 부담은 0이다. 결과는 도장 64,260점·승리이며 같은 token/result/payment의 성장 이벤트와 모험 1회·승리 1회·15 XP를 확인했다. 민팅·성장 거래의 네트워크 비용은 테스트 지갑이 부담했다.

동일한 외출 요청과 성장 API를 재전송했을 때 기존 완료 결과와 `claimed:true`, 서명 없음이 반환됐다. 원래 성장 calldata의 읽기 전용 시뮬레이션은 `AlreadyClaimed`로 거절됐다. 추가 청구 거래는 전송하지 않았다. 최종 원장에는 기존 자료에 각각 1건만 추가되어 orders 9건·results 7건이며, seller/facilitator 대조는 9 orders / 9 intents, issues 없음이다.

초기 성장 요청은 거래 전송에 이르지 못했고 같은 결과를 다시 요청해 성공했다. 공개 RPC의 safe 블록이 민팅 전 상태를 가리키던 초기 preflight는 `birth` 조회에서 실패했으며, safe 블록이 공개 거래를 지난 뒤 공식 명령의 `revealed:true`와 `PREFLIGHT_READ_ONLY_OK`를 확인했다. 운영 NFT 이미지 API도 초기 503 이후 두 도메인에서 이름을 포함한 427,249자 standalone SVG를 200으로 재확인했다. 503의 원인은 확정하지 않았다. 임시 진단 로깅은 제거하고 landing을 최종 재배포했다. 실패한 요청을 민팅·결제 성공으로 계산하지 않았다.

양쪽 도메인의 한국어·영어 운영 UI에서 고유 이름, 동일 seed·외형·적성, 15 XP와 새로고침 후 유지, 390px 가로 넘침 없음을 확인했다. 지갑 provider가 없는 별도 운영 브라우저에서 무료 도장찍기 60초 완주·결과와 콘솔 오류 없음을 확인했다. 이는 자동화한 데스크톱 Chrome과 로컬 테스트 서명기 검수이며 실물 휴대폰·지갑 확장 프로그램 검수를 대신하지 않는다.

이전 컬렉션은 새 민팅을 중지했다. 기존 NFT는 이전 계약에 그대로 남으며 새 컬렉션으로 이전하지 않았다. 현재 artifact는 [새 배포 기록](../deployments/giwa-sepolia.guardians.json), 이전 기록은 [2026-10-10 artifact](../deployments/giwa-sepolia.guardians.2026-10-10.json)에 보존했다. 운영 증거·암호화 DB·환경 파일 백업은 `~/.mapae/backups/guardian-random-release-20261011-114042`에 비공개로 보관했다. 같은 디스크 복구본이며 별도 기기 재해 복구 사본은 아니다. 웹과 seller의 컬렉션 주소는 함께 유지해야 하며 이전 Worker 버전만 단독으로 되돌리지 않는다.

## 서버 유휴 시간 수정·네 서비스 재시작 — 2026-10-11 13:18 KST

`git pull --ff-only origin main`으로 `1e8cb4b780cd5fb2a1e51300c8871570d0b0810d`를 받았다. 기존 스테이징 변경은 pull 전후 binary diff가 바이트 단위로 같음을 확인했다. 네 서비스의 `.env`와 SQLite를 비공개 백업하고 각각 암호화 백업·복구 drill을 통과했다. `bun install --frozen-lockfile`, 전체 `bun run check`(1,658 TS / 39 Foundry), 두 운영 웹 빌드와 Wrangler dry-run이 통과했다.

이번 수정은 Bun의 기본 10초 유휴 제한보다 영수증 대기가 긴 경우 응답이 끊기는 문제를 다룬다. 현재 운영 설정에서 account-bootstrap·revocation-submitter의 `idleTimeout`은 각각 135초, facilitator-erc7710은 30초다. 웹의 계정 생성·후원 회수 요청 제한은 150초로 변경됐다. 진행 중인 외출과 미확정 정산이 0건인 상태를 재확인하고, 관리자 인증 후 기존 system LaunchDaemon 네 개를 순서대로 재시작했다.

| 서비스 | 이전 PID | 재시작 PID | 확인 |
| --- | --- | --- | --- |
| facilitator-erc7710 | 55326 | 64886 | active / health 200, ok true |
| revocation-submitter | 55328 | 64889 | active / health 200, ok true |
| account-bootstrap | 55330 | 64892 | active / health 200, ok true |
| delegated-seller | 63547 | 64895 | active / health 200, ok true |

네 환경 파일은 변경 전과 정확히 같고 기존 DB 경로·RPC·영수증 토큰·NFT 주소를 유지했다. 회수 후원 사용액은 재시작 전후 `7045611083848` wei로 동일하며 계정 생성의 당일 사용액 0도 유지했다. 로컬 TCP 요청에서 빈 JSON의 마지막 바이트를 12초 뒤에 보내 세 서버가 10초에 연결을 닫지 않는지 확인했다. 계정 생성·회수는 400, facilitator 검증은 200 / `isValid:false`로 잘못된 입력을 거절했다. 이 검사는 지갑 권한이나 체인 거래를 만들지 않으며 실제 장시간 체인 정산 성공을 뜻하지 않는다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `2fcdbd87-04b0-4f3a-b6c8-3b11996cef29` | `f269fca8-9a13-4347-aa35-f3705399a70e` | `4d401bbb-a3f1-49bb-9672-7074fe76052c` |
| `mapae-app` | `57e0516d-d9b5-4642-af94-d46e3ddcf4fa` | `ec0f9a0c-c007-4c2a-ba10-4b442bd015ea` | `0edd6475-42da-43d8-baa2-592ba1fafb33` |

두 웹 배포의 클라이언트 JS/CSS 28개 해시와 운영 응답을 대조하고 한영 아케이드·CSP, 기존 NFT 조회를 확인했다. 실제 설정의 `facilitator.mapae.io`에서 `/bootstrap`·`/revoke`의 두 웹 origin 사전 요청은 모두 204였다. 운영 점검과 seller/facilitator 원장 대조도 통과했다. NFT 이미지 API에서는 간헐적인 503이 다시 관찰됐고 제한된 재시도에서 두 도메인 모두 200과 기존 이름·이미지를 확인했다. 해당 간헐 오류의 원인을 해결한 것으로 계산하지 않는다. 별도 계약·D1 변경·민팅·결제는 수행하지 않았다. 로컬 변경과 이번 배포 기록은 스테이징만 하고 커밋·푸시하지 않았다. 증거는 `~/.mapae/backups/server-update-20261011-041553`에 비공개로 보관한다.

## UUPS 프록시 전환·실제 GIWA 검증 — 2026-10-11 14:40 KST

Mac mini의 기존 체크아웃을 `ada0f4aa7be19e533f534601bbd8e8bb5b2a4d68`까지 fast-forward로 갱신했다. 기존 로컬 변경은 branch·stash·binary patch로 보존한 뒤 복원했다. README 테스트 수, 배포 문서와 preflight import 충돌을 정리하고, 성장 POST의 빈 JSON 본문·잔액 조회 대기·운영 점검 수정은 유지했다. 새 OpenZeppelin upgradeable 서브모듈은 고정 커밋 `7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf`로 초기화했다. 기존 외부 라이브러리를 정리하거나 삭제하지 않았다.

`bun install --frozen-lockfile`, 전체 `bun run check`(TypeScript 1,659개, 웹 491개 포함 / Foundry 61개), Forge 포맷·크기 검사와 두 웹 운영 빌드·dry-run을 통과했다. 구현 runtime은 18,877 bytes다. 이번 적용은 [내부 감사 보고서](audits/mapae-guardians-uups-2026-10-11.md)의 수정 코드를 배포한 것이며 외부 감사 인증은 아니다.

기존 관리자 지갑으로 Forge 시뮬레이션을 통과한 뒤 GIWA Sepolia에 아래 세 계약을 배포했다. 프록시 생성 거래의 initializer calldata, ERC-1967 구현 슬롯과 세 runtime을 로컬 산출물에 대조했다. 프록시와 구현의 재초기화는 각각 `InvalidInitialization`, 비소유자의 업그레이드 호출은 `OwnableUnauthorizedAccount`로 거절되는 것을 읽기 전용 호출로 확인했다. EIP-712 검증 주소도 프록시이며 체인은 91342다.

| 계약 | 주소 | 실제 배포 거래 |
| --- | --- | --- |
| GuardianMetadata | `0x69577b8106CD852a304aD7EffF866689A38fF553` | `0x8b423da56bfe0bdb4f7566acd6ff9b4a912a29e586f97471194c6b72c0940f09` |
| MapaeGuardians 구현 | `0x7652F9E57CC5A52b7e723A4aD517a37Be3AB7174` | `0x2453b4fa6ac96fc7d2267c6d64c7616b3a3da8e9cc84215291bdfcd86e230810` |
| ERC1967Proxy — 앱의 컬렉션 주소 | `0x2b968116411C7413F83df461CD7eaB0792AAC2C0` | `0x4f807c29b5896cc327be19488e28e24a3cacd00e4e796b32436a8ad47320c5ee` |

세 거래는 모두 블록 `38351379`에서 성공했다. Foundry broadcast JSON의 구현·프록시 거래 라벨과 해시 연결이 뒤바뀐 부분은 실제 거래의 발신자·nonce·input과 receipt의 생성 주소로 대조했다. 위 표와 공개 artifact는 이 대조 결과를 사용하며 원본 broadcast 파일도 보존했다. 같은 배포를 다시 브로드캐스트하지 않았다.

탐색기에서 라이브러리·구현·프록시 각각의 소스 검증을 완료했다. 프록시 검증의 첫 `already verified` 응답은 구현 검증만으로 충분하지 않아 `--skip-is-verified-check`로 프록시 자체를 명시적으로 검증했다. 최종 explorer API에서 세 주소 모두 `is_verified:true`, 각각 GuardianMetadata·MapaeGuardians·ERC1967Proxy로 확인했다.

네 서비스의 환경 파일·SQLite 암호화 백업과 복구 drill, D1 export·무결성 검사를 통과했다. seller 중지 후에도 별도 DB 백업을 만들고, `.env`의 `ARCADE_GUARDIAN_ADDRESS`만 프록시로 변경해 동일한 system 서비스를 재시작했다(PID 66445). 기존 완료 외출 1건·주문 9건·성장 결과 7건을 보존했으며 삭제한 행은 0건이다. 다른 세 서비스의 환경 파일과 실행 PID는 그대로다. 기존 DB 경로·RPC·영수증 토큰·결제 에이전트·결과 서명 키와 이전 유휴 시간 수정도 유지했다. 이번 변경에는 D1 마이그레이션이 필요하지 않았다.

| Worker | 최종 version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `4bfa12c4-7cb8-4f19-87b9-71a183fcbd59` | `2fcdbd87-04b0-4f3a-b6c8-3b11996cef29` | `075514db-245a-49a7-8c6f-63597d2a6794` |
| `mapae-app` | `052db4f8-17b5-4997-8f58-70337c86daef` | `57e0516d-d9b5-4642-af94-d46e3ddcf4fa` | `0e30a92b-2ea9-41dc-a3bb-b35e5525ba1b` |

두 Worker의 NFT 설정도 같은 프록시로 변경하고 14:32 KST에 배포했다. 기존 D1·ASSETS·시크릿·보안 헤더·landing cron·DNS·Tunnel을 유지했다. 운영 클라이언트 JS/CSS 28개 응답의 SHA-256이 최종 로컬 배포 빌드와 일치한다. 새 이미지 에셋 변경은 없다.

새 컬렉션은 민팅 중지 상태로 배포했다. 테스트 민팅 한 번을 열어 아래 canary를 만든 뒤 다시 중지하고, 결제·성장·재전송·브라우저 검증을 모두 마친 뒤 14:39:51 KST에 공개 민팅을 열었다.

| 실제 GIWA 검증 | 거래·결과 |
| --- | --- |
| NFT 민팅 | `0xbaca89551e67111107260f51971bb91aac172c2f265fea09321d09710f7e4eba` |
| Pyth 자동 BirthRevealed | `0x26bbe7710f12922ccc076b444297d1fbbc397ed1e79894289c70c0b1404fe7cc` |
| 1 mUSDC 입장 | `0x0fadf705ca7734655b7d5cd6bfcd50618f22c4065dad613853d2e6d04eaebd18` |
| ResultClaimed | `0xb7b1f234388a6992d8bb037276ce1e76c8723560e439f225100e18f99c786de8` |
| 검증 완료 후 공개 민팅 | `0x6a74e8600ea6ed398418231fe9ca48c5e8199d6caaebf91f44b83e694c63fe1d` |

테스트 전령은 토큰 `3261`, sequence `4`, `휘파람 부는 옥이` / `Whistling Ogi`다. 자동 난수 콜백으로 말·호기심 성향·도장 4 / 경주 6 / 상회 5가 공개됐다. 이전과 같은 별도 테스트 지갑으로 운영 UI의 민팅·1회 한도 승인·외출·성장 버튼을 사용했다. 개인키는 로컬 서명기에만 두었으며 브라우저나 Worker에 전달하지 않았다.

이번 승인 흐름에서는 기존 bootstrap faucet이 부족분 2 mUSDC를 자동 보충했다(`0x93ad2bcd65aaebde8d6d67dfbcc6911a040592fddf5a1a21a1df0ff96ed80056`). 따라서 실제 잔액은 998 → 1,000 → 999 mUSDC다. 충전 Transfer와 입장료 1,000,000 기본 단위 Transfer를 분리해 확인했다. 입장료의 payer·payee·토큰, seller의 paid order와 facilitator의 settled journal이 일치하며 payer native 잔액 0과 입장 결제 가스 부담 0을 확인했다. 민팅·성장 거래의 네트워크 비용은 테스트 소유자 지갑이 부담했다.

도장찍기 결과 43,020점·승리에 대해 같은 token/result/payment의 ResultClaimed가 발생했고 모험 1회·승리 1회·15 XP가 반영됐다. tokenURI의 성장 수치도 갱신되고 타고난 특성은 그대로다. 동일 외출 요청 재전송은 기존 완료 결과를 반환했고, 성장 API는 `claimed:true`와 서명 없음으로 응답했다. 같은 성장 calldata의 읽기 전용 재실행은 `AlreadyClaimed`로 거절됐다. 재전송 후에도 주문·성장 결과는 정확히 1건씩만 늘어 총 10건·8건이며, seller/facilitator 대조도 10 orders / 10 intents, issues 없음이다.

양쪽 도메인의 한영 UI를 새로 열어 동일 seed·이름·15 XP 유지와 390px 가로 넘침·런타임 예외 없음을 확인했다. 지갑 provider가 없는 별도 운영 Chrome에서 무료 도장찍기 60초 완주·4,750점·무료 결과를 확인했다. 공식 preflight는 초기 RPC/provider 오류 뒤 재실행에서 safe 블록의 `revealed:true`와 `PREFLIGHT_READ_ONLY_OK`를 반환했다. 실패 요청을 성공으로 계산하지 않았다. NFT 이미지 API는 landing에서 200, app에서 503 두 번 뒤 200으로 이름을 포함한 standalone SVG를 반환했다. 이 간헐적 503의 원인은 여전히 미확정이다. 실물 휴대폰과 Rabby/MetaMask 확장·앱 검수는 이번 범위에 포함하지 않았다.

기존 비프록시 컬렉션 `0x26Cb90dA20a58955D497d2e8be53Ff68aC4A5eFc`는 민팅을 중지했다(`0x1187af5095618d3d95388d1e1bed1a5c4a70c4de27c2286cad12bf2eea2c315f`). 기존 NFT는 그 계약에 남으며 새 프록시로 이전하지 않았다. 이번 작업은 새 UUPS 컬렉션의 최초 배포이며 실제 구현 업그레이드를 수행한 것은 아니다. 업그레이드 후 상태 보존은 로컬 컨트랙트 테스트 범위다. 현재 소유자는 기존 테스트넷 배포 EOA이며 메인넷 이전에 멀티시그 이전이 필요하다.

현재 주소·세 배포 거래·canary·Worker 기록은 [현재 artifact](../deployments/giwa-sepolia.guardians.json), 직전 비프록시 기록은 [전환 전 artifact](../deployments/giwa-sepolia.guardians.2026-10-11-pre-uups.json)에 보존했다. 비공개 증거는 `~/.mapae/backups/guardian-uups-release-20261011-052544`에 있으며 canary 후 seller·facilitator·bootstrap의 암호화 백업과 복구 drill도 통과했다. 같은 디스크 복구본이며 기기 밖 사본을 대신하지 않는다. 이전 Worker만 단독으로 롤백하지 않고 seller·웹·계약 호환성을 함께 확인해야 한다. 로컬 변경은 보존·스테이징했으며 커밋·푸시는 하지 않았다.

## 공통 오락실·전령단 탭 웹 배포 — 2026-10-11 16:12 KST

`git pull --ff-only origin main`으로 `1e0c12fc6f1f0d3c7b19ad40a5e4b91d1f305f6d`까지 6개 커밋을 받았다. 기존 로컬 변경은 branch·stash·binary patch로 보존했다. 변경되지 않은 파일은 stash의 내용과 바이트 단위로 같으며, 두 훅의 로컬 성장 POST 본문·잔액 대기는 새 코드와 병합한 뒤 스테이징 상태를 복원했다. 커밋·푸시는 하지 않았다.

지갑 연결 여부와 관계없이 공통 오락실에서 시작하고 오락실·나의 전령단 탭으로 이동하는 화면을 반영했다. 방문자 상태에 맞춘 도크, 전령 도크의 두 영역, 전령 연습의 머리말과 한국어 전령단 머리 글귀도 포함한다. `bun install --frozen-lockfile`, 전체 `bun run check`(1,659 TS / 61 Foundry), 두 운영 빌드·Wrangler dry-run을 통과한 뒤 `bun run deploy:landing`, `bun run deploy:app`을 완료했다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `30683095-9519-4079-807f-11f4d3b78838` | `4bfa12c4-7cb8-4f19-87b9-71a183fcbd59` | `8943cb59-4a23-4302-ae7f-4db7f6c0c94c` |
| `mapae-app` | `0c0f1a6d-a1f5-4de9-be54-a7382e08dfef` | `052db4f8-17b5-4997-8f58-70337c86daef` | `3fc53a66-5c09-4800-b41c-21a5de01da83` |

두 운영 도메인의 한영 아케이드 HTTP 200·보안 헤더, 최종 JS/CSS 28개 응답의 로컬 SHA-256 일치와 100% 배포를 확인했다. 지갑 없는 브라우저의 320/390/1440px, 두 탭, 두 언어·두 도메인 총 24개 화면에서 가로 넘침·이미지 실패·콘솔 오류가 없었다. 기존 SIWE 세션과 읽기 전용 provider로 양쪽 한영 화면에서 전령 도크의 두 영역, UUPS 컬렉션·토큰 3261·15 XP 유지, 390px 가로 넘침 없음을 확인했다. 전령 무료 연습 진입 후 공통 머리말도 확인했다. 별도 지갑 없는 운영 브라우저에서는 새 도크의 무료 게임 버튼으로 진입해 60초 완주·무료 결과와 콘솔 오류 없음을 확인했다. 이는 자동화한 데스크톱 Chrome 검수다.

운영 상태 점검도 통과했다. 이번 작업은 웹 배포이며 기존 프록시·seller·DB·결제 설정을 유지했다. 새 지갑 서명·민팅·GIWA 결제 거래를 전송하지 않았다. 로컬 보존본·검사 로그·배포 산출물·브라우저 증거는 `~/.mapae/backups/web-refresh-20261011-161051`에 비공개로 보관했다.

## 다섯 구역 경로·모바일 메뉴 웹 배포 — 2026-10-11 17:01 KST

`git pull --ff-only origin main`으로 `3f5593510e2a060aa30a2d79cc7b2036931a0cb9`까지 15개 커밋을 받았다. 로컬 변경과 스테이징은 branch·stash·binary patch에 보존한 뒤 복원했다. README 두 파일의 테스트 수 충돌만 실제 1,662 TS / 웹 494 / Foundry 61로 정리했으며 나머지 기존 수정은 바이트 단위로 보존했다. 커밋·푸시는 하지 않았다.

오락실·나의 전령단·외출·모험 기록·지갑/승인을 각각 `/arcade`, `/arcade/guardians`, `/arcade/outings`, `/arcade/journal`, `/arcade/wallet`과 한국어 경로로 분리했다. 좁은 화면의 서랍 메뉴, 넓은 화면의 링크 내비게이션과 구역별 안내·게임 복귀 동작을 포함한다. `bun install --frozen-lockfile`, 전체 `bun run check`(1,662 TS / 61 Foundry), 두 운영 빌드·Wrangler dry-run을 통과한 뒤 두 웹을 배포했다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `fbcf908b-6e7d-4caa-b81d-d1d424131e7e` | `30683095-9519-4079-807f-11f4d3b78838` | `b662cfc3-1f12-4504-bbc4-9d7d3def6a82` |
| `mapae-app` | `53b28a81-8928-42b9-a483-c86b22dda937` | `0c0f1a6d-a1f5-4de9-be54-a7382e08dfef` | `3fbe2a0a-df7b-4d7f-b22a-3b26ce38fce4` |

두 도메인·두 언어의 구역 20개를 직접 열어 HTTP 200, 존재하지 않는 구역 4개는 404, 각 CSP nonce와 보안 헤더를 확인했다. 배포된 JS/CSS 28개 해시가 로컬 빌드와 일치한다. 실제 운영 브라우저에서 구역 5개 × 두 도메인 × 두 언어 × 320/390/1440px, 총 60개 화면에 가로 넘침·이미지 실패·콘솔 오류가 없었다. 모바일 메뉴의 링크 5개, 메뉴 안 포커스, Escape 닫기·링크 이동 후 닫기·뒤로/앞으로 가기를 확인했다.

기존 SIWE 세션과 읽기 전용 지갑 provider를 사용한 네 인증 구역의 한영·두 도메인 16개 화면에서도 가로 넘침이 없었다. 현재 UUPS 컬렉션과 토큰 3261, 모험 기록의 15 XP 유지 및 기존 영수증을 확인했다. 전령단에서 도장·경주·상회 연습을 각각 열었을 때 화면 맨 위에서 시작하고 같은 전령단 주소로 복귀했다. 별도 지갑 없는 무료 도장찍기를 60초 완주하고 오락실 주소로 복귀하는 흐름도 통과했다. 새 지갑 서명·결제·민팅 없이 수행한 데스크톱 Chrome 검수이며 실물 기기 검수는 아니다. 운영 상태 점검도 통과했다.

기존 NFT 주소·seller·DB·D1·결제 설정·웹 바인딩을 유지했다. 적용 증거와 로컬 복구본은 `~/.mapae/backups/web-sections-20261011-165919`에 비공개로 보관하고 공개 Worker 버전·소스 커밋은 [현재 artifact](../deployments/giwa-sepolia.guardians.json)에 갱신했다.

## 랭킹 보안 검토·서버 적용·웹 배포 — 2026-10-11 20:54 KST

`git pull --ff-only origin main`으로 `64f27537eff19a6b2b11069aaa040921fdc3071a`까지
16개 커밋을 받았다. 기존 로컬 변경은 branch·stash·patch로 보존해 복원했다.
README의 테스트 수 충돌을 정리했고, 기존 코드 수정은 그대로 유지했다.

서버 점수 원장·차수 제한·중복 처리·인증·공개 응답·캐시를 검토했다.
잘못된 날짜가 검증 함수에서 예외를 일으키는 문제를 재현해 수정하고 회귀 테스트 2개를
추가했다. 자세한 범위와 결과는 [랭킹 내부 검토](audits/arcade-ranking-2026-10-11.md)에 있다.
`bun install --frozen-lockfile`, 전체 `bun run check`(1,710 TS / 웹 510 / Foundry 61),
두 운영 빌드·Wrangler dry-run을 통과했다.

seller DB를 암호화 백업하고 복원 사본에서 스키마 추가를 두 번 검증했다. 기존
13개 테이블의 데이터·schema version과 integrity가 유지됐다. 진행 중인 외출과
미확정 정산이 모두 0인 것을 확인한 뒤 적용 직전 백업을 추가했다. 사용자 관리자
인증 후 기존 `system/io.mapae.delegated-seller`를 재시작했다(PID 66445 → 70528).
기존 `.env`는 바이트 단위로 동일하며, 주문·외출·성장 원장의 행과 해시도 유지됐다.
새 `arcade_guardian_ranked` 테이블과 4개 인덱스는 기존 SQLite에 자동 추가된다.
예전 기록은 랭킹에 소급 반영하지 않으며 새 외출부터 집계한다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `efab1566-5cb1-40ae-a17e-2525505554b0` | `fbcf908b-6e7d-4caa-b81d-d1d424131e7e` | `3c50eebc-c16e-46db-bebb-c055a3ac3051` |
| `mapae-app` | `ee5ed522-a358-4f8e-ac6f-faf19255a4ba` | `53b28a81-8928-42b9-a483-c86b22dda937` | `00d5d2e0-59b1-4b5f-aa6f-05847ea1152c` |

배포 API에서 100% 전환과 기존 D1·ASSETS·두 secret 바인딩, 호환 날짜·Node 플래그·
정적 보안 헤더를 확인했다. 공개 JS/CSS 28개 응답의 SHA-256이 최종 빌드와 일치한다.
두 도메인 각각 13종 순위표와 전령 순위는 200이며 공개 스키마·30초/10초 캐시를
통과했다. 잘못된 경로·ID·쿼리·메서드 12건은 400/404/405로 거절하고 캐시하지 않았다.
seller의 인증 없는 직접 조회는 401이며, 기존 토큰을 사용한 loopback/공개 조회는 200이다.

지갑 없는 운영 Chrome에서 구역 6개 × 두 도메인 × 한영 × 320/390/1440px, 총 72개
화면의 가로 넘침·이미지 실패·콘솔 오류가 없었다. 메뉴의 6개 링크, Escape·포커스·
뒤로/앞으로 가기와 13종 순위표 전환을 각 언어·도메인에서 확인했다. 기존 SIWE와
읽기 전용 provider로 랭킹·모험 기록 8개 화면을 별도 재검수해 UUPS 컬렉션,
토큰 3261·15 XP 유지와 새 랭킹의 빈 초기 상태를 확인했다. 앞선 빠른 연속 검수 중
전령 목록 응답에서 컬렉션이 누락된 경우가 한 번 있었다. 당시 응답 코드는 수집하지
못했으므로 원인은 확정하지 않았다. 이후 같은 API 200과 속도를 낮춘 전체 8개 화면을
재확인했다. 운영 서비스 상태 점검도 통과했다.

이번 검수에서 실제 GIWA 결제·민팅·성장 거래는 보내지 않았다. 새 랭킹으로 결제부터
순위 반영까지 이어지는 운영 검증은 아직 수행하지 않았다. 실물 모바일 검수도 아니다.
D1 마이그레이션·계약 재배포·키 교체는 필요하지 않았으며 실행하지 않았다.
복구본·검사·배포·브라우저 증거는 `~/.mapae/backups/ranking-release-20261011-204544`에
비공개 보관했다. 로컬 수정과 배포 기록은 스테이징했으며 커밋·푸시는 하지 않았다.

## 웹 재배포 — 2026-10-11 22:02 KST

사용자 요청으로 검증된 `64f2753`과 로컬 보안 수정이 포함된 현재 작업 트리에서 `bun run deploy:landing`, `bun run deploy:app`을 실행했다. 기존 로컬 변경과 설정을 보존했다. 두 환경 빌드·배포와 API의 100% 전환을 확인했다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `6c6621a5-8c52-48d5-89ec-e547e03c4766` | `efab1566-5cb1-40ae-a17e-2525505554b0` | `0636b332-1240-4320-94fa-af9ddf93b45b` |
| `mapae-app` | `8498f101-7d1e-43c7-ba09-0a21e0cc7c7d` | `ee5ed522-a358-4f8e-ac6f-faf19255a4ba` | `f47d172c-da6c-4923-9724-f4824b69636c` |

운영 홈페이지·앱과 한영 아케이드 경로의 응답, 보안 헤더, 두 도메인의 JS/CSS 28개 SHA-256을 확인했다. 새 번들의 JS/CSS는 전체 검사를 통과한 직전 랭킹 배포와 동일하다. 각 도메인의 13종 순위표·전령 순위 조회와 잘못된 요청 거절도 재확인했다. 서버·DB·계약 변경 없이 웹만 재배포했다. 배포 증거는 `~/.mapae/backups/web-redeploy-20261011-220103`에 비공개 보관했다.

## 외출 적성 표시 최신 코드 반영 — 2026-10-11 23:39 KST

직전 웹 재배포는 로컬 `64f2753`을 사용해 `13c4b58`의 적성 표시가 빠져 있었다. 운영 두 도메인의 JS에서 예전 안내 문구가 있고 새 문구가 없는 것을 독립 확인했다. `git fetch origin main` 후 `git pull --ff-only origin main`으로 `13c4b589ab6cc71281101c5ae1ea1a33ed6c6f33`을 받았다. 기존 스테이징·미스테이징 변경은 백업 후 바이트 단위로 보존했다. 변경은 RankLine·외출 화면·랭킹 CSS 세 파일이다.

`bun install --frozen-lockfile`, 웹 타입 검사·510개 테스트, landing/app 빌드와 Wrangler dry-run을 통과했다. 각 빌드에서 새 문구와 `.rank-aptitude.is-best` 스타일이 있고 예전 문구가 없는 것을 확인한 뒤 두 Worker를 배포했다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `4f8e8fb8-eef7-4e1f-8e24-2556aad1761d` | `6c6621a5-8c52-48d5-89ec-e547e03c4766` | `72d06e6a-e57e-45ee-8751-b115238793f8` |
| `mapae-app` | `2516f57f-2373-4b9e-9bb0-80920b40bf63` | `8498f101-7d1e-43c7-ba09-0a21e0cc7c7d` | `d799c91e-cd17-4078-924b-a420667f3e38` |

두 운영 도메인의 한영 페이지·CSP·`Cache-Control: no-store`와 JS/CSS 28개 응답의 SHA-256이 최종 로컬 빌드와 일치했다. 내려받은 JS에는 `가장 잘해요`가 있고 `타고난 적성은 나의 전령단에서 볼 수 있어요`는 없으며 적성 스타일도 존재한다.

실제 운영 `/ko/arcade/outings`·`/arcade/outings`에서 기존 SIWE와 읽기 전용 지갑 provider를 사용했다. 전령 3261의 서버 응답에서 읽은 birth seed로 계산한 도장 4/6·경주 6/6·상회 5/6과 화면 수치가 일치했다. 최고 적성인 경주 배지는 초록색(`rgb(45, 100, 87)`)이며 보낼 놀이 드롭다운에도 세 적성과 최고 적성 문구가 표시된다. 두 도메인 × 한영 × 320/390/1440px 총 12개 경우에서 배지·드롭다운·넘침 없음·콘솔 오류 없음과 Escape 닫기를 확인했다. 검수기의 최초 DOM 존재 검사 대신 닫힌 팝업의 0×0 크기와 `aria-expanded=false`를 확인했다(Base UI는 닫힌 DOM을 유지한다).

웹 배포이며 seller·DB·계약은 변경하지 않았고 새 지갑 서명·결제 거래는 보내지 않았다. 기존 로컬 보안 수정은 그대로 유지했다. 검수는 데스크톱 Chrome의 뷰포트 검수이며 실물 모바일 검수는 아니다. 배포·브라우저 증거는 `~/.mapae/backups/aptitude-release-20261011-233248`에 비공개 보관했다. 로컬 수정과 배포 기록은 스테이징했으며 커밋·푸시는 하지 않았다.

## 칭호·묶음 기록 업그레이드와 최신 웹 배포 — 2026-10-12

`13c4b58`에서 `12a7d8d`를 받고, 작업 재개 때 `git pull --ff-only origin main`으로 최신 `c13d5fa2ca9c3b59e02d41a78284e7866c34f0c2`까지 반영했다. 기존 로컬 수정은 비공개 패치·stash·백업 브랜치에 보존했다. 첫 통합에서 README 검사 수와 랭킹 테스트를 합쳤고, 지갑 잔액 재확인·랭킹 날짜 검증 등 로컬 보안 수정을 유지했다. 이전 단건 claim 훅은 새 묶음 claim 흐름으로 대체했다. 커밋·푸시는 하지 않았다.

기존 프록시 `0x2b968116411C7413F83df461CD7eaB0792AAC2C0`를 유지하고 새 라이브러리와 구현을 배포했다. 관리자·결과 서명자·Entropy/provider·소유 NFT와 기존 환경 설정은 그대로다.

| 작업 | 주소 | GIWA 거래 |
| --- | --- | --- |
| 새 GuardianMetadata | `0xe585a052f720206d9d7089ff758f4d5c3ccf8565` | `0x728a0c4cacf7b3a264666edea81683dc2cac1b330c89b25346504ed9d34cdd97` |
| 새 MapaeGuardians 구현 | `0x901e9c042a05d53b1c986c9012b1df2110dc9de6` | `0xd15867df04dc0dd6ba16c6bda2c02901e154d19a1124ea2bf6437a20acb678d9` |
| 기존 프록시 upgradeToAndCall | 같은 프록시 | `0x2d1fe621f6a609e588b235eac1783687bb0d5d8f04d50cda60e277235e6504e1` |

두 새 계약의 Blockscout 소스 검증을 완료했다. 구현 런타임은 21,002바이트다. GIWA 포크에서 먼저 업그레이드했고, 실제 업그레이드 후에도 기존 전령 3195·3261·7098·8192의 소유권·birth·적성·성장·승인·보유 목록과 컬렉션 설정이 보존됨을 대조했다. `Upgraded`·`BatchMetadataUpdate(1,10000)`와 구현 슬롯을 확인했다. 메타데이터의 기존 속성은 유지되고 칭호·출석 11개 속성이 0으로 추가됐다.

최초 업그레이드 확인 과정은 성공 영수증을 받은 뒤 RPC 응답 디코딩 오류로 중단돼 seller 재시작 전에 멈췄다. 재개 시 저장된 동일 거래 해시를 조회해 성공과 상태 보존을 확인했다. 새 nonce의 업그레이드나 중복 배포를 전송하지 않았다. 이번 실제 관리자 거래는 위 세 건이다.

seller SQLite의 온라인 암호화 백업과 복원 검사를 완료했다. 복원본에 새 스키마를 두 번 적용해 멱등성과 무결성을 확인했다. 실행 중인 외출과 미확정 정산이 0인 상태에서 기존 `system/io.mapae.delegated-seller`를 재시작했다(PID 75244). 재시작 직후 기존 14개 테이블의 전체 행 해시가 백업과 같았고, 칭호 캐시 2개 테이블과 `ranked_week` 인덱스가 추가됐다. `.env`는 바이트 단위로 동일하다. D1 마이그레이션은 필요 없었다. 다른 세 서비스·DNS·Tunnel·키는 변경하지 않았다.

`12a7d8d` 통합본의 전체 `bun run check`는 TypeScript 1,741개(웹 519개 포함)·Foundry 78개와 타입·문서·보안 게이트를 통과했다. `forge fmt --check`, 계약 크기 검사, 두 운영 빌드/dry-run도 통과했다. 최종 `c13d5fa`의 로비 TSX/CSS 변경 후 웹 타입 검사·519개 테스트와 두 운영 빌드를 다시 통과했다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `13bd94e2-94f6-4247-8733-fa56e2791444` | `4f8e8fb8-eef7-4e1f-8e24-2556aad1761d` | `3241df69-401b-46fb-b72a-9fea9001f25f` |
| `mapae-app` | `0452fa99-d174-460d-841e-511657bbb8cb` | `2516f57f-2373-4b9e-9bb0-80920b40bf63` | `6b12944c-8372-4f2e-9df3-0fc5d231f08b` |

두 도메인의 28개 경로 응답·CSP·no-store·nosniff와 JS/CSS 28개 해시를 확인했다. 각 도메인의 순위표 13종·전령 순위·잘못된 요청 6종도 검증했다. 기존 bindings·시크릿·호환 설정을 유지했다. `bun scripts/ops/check.ts`와 업그레이드 후 전령 3261의 `PREFLIGHT_READ_ONLY_OK`가 통과했다.

운영 Chrome 검수:

- 지갑 없는 한영 6개 섹션 × 두 도메인 × 320/390/1440px, 총 72개 화면에서 가로 넘침·콘솔 오류 없음. 메뉴 포커스·Escape·이동·뒤로/앞으로 가기를 확인했다.
- 기존 SIWE와 읽기 전용 지갑 provider로 적성 4/6·6/6·5/6, 초록색 최고 적성, 드롭다운 문구와 닫기를 12개 경우에서 확인했다.
- 두 도메인의 한영 모험 기록에서 기존 1건·15 XP·기록됨 상태와 기록 대기 없음이 표시됐다. body 없는 새 `/claims` POST는 이미 반영된 결과에 대해 빈 claims와 null honor를 반환했다. 새 결제·성장 거래는 보내지 않았다.
- 검수 당시 해당 전령의 실제 이번 주 순위는 없었다. 별도 브라우저 응답 fixture로만 주간 1위·지난주 대비 ▲2를 주입해 로비의 한영 12개 화면에서 표시와 넘침 없음을 확인했다. 서버 순위·결제 데이터는 변경하지 않았고 fixture를 제거했다. 이것은 실제 순위 획득 검증이 아니다.

이번 검수에서 신규 민팅·난수 콜백·1 mUSDC 결제·묶음 결과/칭호의 실제 기록은 다시 실행하지 않았다. 기존 canary 거래는 이전 배포 이력이며 이번 결제 성공으로 계산하지 않는다. 실물 모바일 검수도 아니다. 계약 소유자는 기존 테스트넷 EOA로 유지된다.

공개 기록은 `deployments/giwa-sepolia.guardians.json`, 변경 전 기록은 `deployments/giwa-sepolia.guardians.2026-10-12-pre-honors.json`에 있다. 비공개 백업·빌드·브라우저 증거는 `~/.mapae/backups/web-update-20261012-114413`에 보관했다. 예전 웹·seller는 단건 claim ABI를 사용하므로 프록시를 그대로 둔 채 이전 웹 버전만으로 되돌리는 것은 호환되는 복구가 아니다.

## 전체 순위 페이지 배포 — 2026-10-12

최신 `5f3566581279c87a32ef284eb8f8a3d4cbaddaf8`을 `git pull --ff-only origin main`으로 받았다. 기존 로컬 변경은 백업 브랜치·비공개 패치·stash로 보존했다. README 검사 수와 랭킹 테스트 import의 충돌은 기존 날짜 검증 회귀와 새 페이지 테스트를 모두 유지해 해결했다. 통합본의 실제 검사 수로 README를 갱신했다. 커밋·푸시는 하지 않았다.

`bun install --frozen-lockfile`, 전체 `bun run check`를 통과했다. TypeScript 1,748개는 공통/서버 1,189개·MCP 3개·웹 521개·문서 35개이며, Foundry는 78개다. 타입·문서·저장소·로그·의존성 감사 게이트와 앱/랜딩 운영 빌드·Wrangler dry-run도 통과했다. 페이지 offset 격자·상한, 정렬된 최대 3개 토큰 ID, seller bearer 인증, 응답 공개 필드 투영과 요청 제한을 확인했다. 기존 날짜 검증 수정도 유지된다.

seller DB 온라인 암호화 백업과 복원 검사를 마친 뒤, 외출·미확정 정산이 0인 상태에서 기존 `system/io.mapae.delegated-seller`를 재시작했다(PID 76459). 재시작 전후 16개 테이블의 스키마는 동일했고, 임시 lease 테이블을 제외한 15개 테이블의 행 해시가 같았다. seller `.env`도 바이트 단위로 같았다. 다른 세 서비스·키·DB 경로·계약·D1은 변경하지 않았다. 직전 칭호 업그레이드가 적용된 프록시를 그대로 사용하며 이번에는 GIWA 거래를 전송하지 않았다.

로컬과 공개 seller에서 각각 정상 경로 39개(13개 순위표의 상위 10명·첫 페이지·전령 위치 조회)와 비정상/미인증 요청 11개를 검증한 뒤, 사용자 안내대로 앱 → 랜딩 순서로 배포했다. seller의 최종 캐시 헤더는 공통 미들웨어가 설정한 `no-store`다. 검수기의 초기 `private, no-store` 기대값을 실제 공통 정책에 맞춰 정정했으며 서버 코드는 바꾸지 않았다.

| Worker | version, 100% | 변경 전 version | deployment |
| --- | --- | --- | --- |
| `mapae-app` | `e71ad171-d935-4f49-a7e6-4bada9958fb0` | `0452fa99-d174-460d-841e-511657bbb8cb` | `33c3bd33-89c6-47fb-be2f-91cb067d84ee` |
| `mapae` | `b610185f-c4e0-4c2e-8441-29e9e55c536a` | `13bd94e2-94f6-4247-8733-fa56e2791444` | `892da1aa-55e1-46c9-bab8-d61c01a56839` |

두 Worker의 100% 전환을 재조회했다. 공개 두 웹에서는 각각 정상 API 39개·비정상 요청 13개, 전체 28개 페이지 경로와 CSP·no-store·nosniff, JS/CSS 28개 SHA-256 일치를 확인했다. `bun scripts/ops/check.ts`도 통과했다. 도메인·Tunnel·D1 바인딩·시크릿·호환 설정은 유지했다.

운영 Chrome의 지갑 없는 한영 6개 섹션 × 두 도메인 × 320/390/1440px, 총 72개 화면에서 가로 넘침과 콘솔 오류가 없었고 메뉴 포커스·Escape·이동·뒤로/앞으로가기를 확인했다. 실제 순위표의 검수 당시 참가자는 3명이라 전체 순위 버튼이 숨겨져 있었다. 새 기능은 참가자가 10명을 넘을 때 표시된다.

별도 격리된 브라우저에만 137명 순위 응답 fixture를 주입했다. 실제 서버 순위·DB는 변경하지 않았으며 지갑 provider는 읽기 전용이었다. 두 도메인 × 한영 × 놀이/기간 13종, 총 52개 경우에서 다음을 확인했다.

- 11–60·61–110·111–137번째 항목의 50/50/27개 페이지와 127개 고유 이름, 동점이 페이지 경계에 걸친 꾸준함 순위.
- 내 전령이 있는 페이지로 직접 이동, 초록 테두리·내 전령 표시·키보드 포커스와 스크롤 이동.
- 탭 변경 시 접힘, 지연된 이전 탭 응답 무시, 오류 뒤 재시도, 어제/지난주에서 하위 순위에 내 전령이 없다는 안내.
- 1개 페이지만 남을 때 쪽 버튼 숨김, 참가자 10명으로 초기화된 뒤 페이지 요청 중단.
- 320/390/1440px의 한영 12개 집중 화면에서 넘침 없음과 초상화·이름·점수·변동 표시. 콘솔 오류 없음.

fixture는 검수 후 제거했다. 이는 137명이 실제 참가했다는 뜻이 아니며 실물 모바일·실제 지갑 서명·결제 검수도 아니다. 상위 10명과 각 페이지는 독립적으로 30초 캐시되므로 경계 순위가 바뀐 직후 잠시 중복되거나 누락될 수 있는 기존 설계를 유지한다. 비공개 배포·브라우저 증거는 `~/.mapae/backups/full-ranking-20261012-144337`에 보관했다.

## 전용 faucet 도입과 웹 배포 — 2026-10-12

`git pull --ff-only origin main`으로 `218ef8675adc95362377ddf25b6b0da0b6ed8627`을 받았다.
기존 로컬 보안 수정·배포 기록은 백업 브랜치, 비공개 패치와 stash로 보존했다.
README 세 곳의 충돌은 새 faucet 안내와 기존 운영 설정을 함께 유지해 해결했다.
커밋·푸시는 하지 않았다.

Cloudflare의 기존 OAuth 권한으로 `faucet.mapae.io` 전용 Managed Turnstile 위젯을
생성했다. 새 faucet 키는 `apps/faucet/.env`에 0600으로 보관하고 기존 후원자·배포자와
주소가 다름을 확인했다. 공개 주소는 `0x2B07E3e5E00363a496224DE18cE345dE57A6bB21`이다.
기존 배포 지갑에서 GIWA Sepolia ETH 0.03개를 보낸 거래
`0xbd065b279f9e6ed3351f12a39f5058d32298bcf3718246b225a1275f148ed2f8`의 성공 영수증과
수취 잔액을 확인했다. 영수증 직후 한 RPC 읽기는 잔액 0을 반환했지만 후속 조회는
0.03개였으며, 추가 충전 거래는 보내지 않았다. 실제 가치 토큰은 사용하지 않았다.

`system/io.mapae.faucet`을 loopback 8084, 영구 SQLite와 사용자 `kooroot`로 등록했다
(PID 78300). 원격 관리 Tunnel에 `facilitator.mapae.io`의 `^/faucet` 규칙만 추가했고
기존 경로는 보존했다. 실행 중인 cloudflared가 설정을 받아 공개 경로가 정상 응답했다.
ETH 지급 미션은 비워 둬 ETH 탭은 비활성이다. Worker의 Turnstile 두 값·서비스 토큰·
IP salt를 비밀 바인딩으로 넣었고, landing/app에는 기존 전용 RPC를 서버 비밀로 설정했다.
개인키·RPC 자격 증명은 클라이언트 설정으로 복사하지 않았다.

첫 faucet 공개 확인에서 503을 발견했다. workerd에서 기본 `fetch`를 객체 메서드로
호출하면 `Illegal invocation`이 발생하는 것을 재현했고, 전역 호출을 유지하는 함수로
감쌌다. 상태 조회와 Turnstile 경로를 함께 다루는 회귀를 추가했고 실제 faucet API를
workerd에 넣은 검사도 200을 반환했다. 임시 검수 코드는 배포 경로 밖에 있다.

최종 `bun run check`: TypeScript 1,840개(공통/서버 1,241·MCP 3·웹 561·문서 35),
Foundry 78개, 타입·문서·저장소·로그·의존성 감사·빌드 통과. 세 운영 빌드/dry-run을
확인하고 faucet → app → landing 순서로 배포했다.

| Worker | version, 100% | 배포 전 version | deployment |
| --- | --- | --- | --- |
| `mapae-faucet` | `4e74e7ad-cd87-4452-bd88-bfc69fb9b7e5` | 신규 Worker | `8042921d-08f9-450a-a999-d41ffa0b406f` |
| `mapae-app` | `e26f9ad9-aeb7-4da2-93b8-043f19da78af` | `e71ad171-d935-4f49-a7e6-4bada9958fb0` | `044be7eb-fc50-46f3-88de-354a2da74567` |
| `mapae` | `155a7da6-c04b-4a59-8cd9-7fbdea856dbb` | `b610185f-c4e0-4c2e-8441-29e9e55c536a` | `3511eeec-0504-48b6-82af-a5b8c2f41703` |

세 Worker의 100% 전환과 기존 두 Worker의 바인딩·호환 설정 보존을 API로 재조회했다.
문서 14개와 JS/CSS 66개 해시, 출처별 리디렉션과 CSP를 확인했다. Turnstile 허용은
faucet 출처에만 있다. 각 기존 도메인의 NFT 3261 이미지는 50회씩 총 100회 모두 200이었다.
이 검사는 부하 테스트가 아니다.

운영 API 25개 검사에서 임시 검수 지갑의 SIWE 로그인·챌린지 재사용 거절·소유자 일치·
로그아웃, 잘못된 Turnstile 거절과 upstream bearer·Origin 경계를 확인했다. 지급 요청은
유효한 Turnstile 없이 거절되어 faucet 지급 거래는 발생하지 않았다. 실제 Chrome에서
faucet 한영 두 탭과 두 아케이드의 faucet 입구를 320/390/1440px, 총 24개 상태로 확인했다.
가로 넘침·이미지 실패·콘솔 오류가 없었다. 새 도메인은 공개 DNS에서 해석되지만 이 Mac은
도메인 생성 전 NXDOMAIN을 캐시해, 검수 연결에는 공개 DNS 결과를 사용하고 원래 호스트와
TLS 인증서 검증을 유지했다. 시스템 DNS 설정은 변경하지 않았다.

웹 확인 후 bootstrap `.env`의 `BOOTSTRAP_FAUCET_ENABLED`,
`BOOTSTRAP_FAUCET_TARGET_BASE`, `MAX_BOOTSTRAP_MINT_GAS`를 제거했다. 그 외 값은 유지했다.
암호화 DB 백업·복원 검사 후 기존 `system/io.mapae.account-bootstrap`을 재시작했다
(PID 79269). 재시작 직전·직후 10개 테이블의 스키마와 행 해시가 같았다. 예산과 이전
faucet 기록은 삭제하지 않았다. D1의 기존 세션 테이블을 재사용해 마이그레이션하지 않았다.
seller·facilitator·revocation 서비스, NFT 계약과 기존 결제 설정은 유지했다.

실제 사용자 지갑 확장 프로그램·정상 Turnstile 해결·테스트 토큰 수령까지 이어지는
브라우저 검수는 사용자 확인이 남아 있다. 새 NFT 민팅·1 mUSDC 결제·성장 거래는
이번 배포에서 실행하지 않았다. 운영 상태 점검은 통과했다. 비공개 증거·복구본은
`~/.mapae/backups/faucet-release-20261012-182229`에 보관했다.

## 첫 화면 로딩·전용 faucet 디자인 웹 배포 — 2026-10-13

`git pull --ff-only origin main`으로 `dde5d93a7e9b9af671b3763208ba11db95e32870`을 받았다.
기존 로컬 보안 수정과 배포 기록은 비공개 패치·백업 브랜치·stash로 보존했다.
README 검사 수 충돌은 실제 통합 검사 수로 맞췄고, faucet의 동일한 기본 fetch 수정은
upstream을 사용하며 기존 상태/Turnstile 회귀와 upstream 회귀를 모두 유지했다.
커밋·푸시는 하지 않았다.

`bun install --frozen-lockfile`, 전체 `bun run check` 통과: TypeScript 1,843개
(공통/서버 1,243·MCP 3·웹 562·문서 35), Foundry 78개, 타입·문서·저장소·로그·
의존성 감사·빌드. 세 운영 빌드와 Wrangler dry-run, 서버 렌더링의 HTML/CSS 검사도
통과한 뒤 faucet → app → landing 순서로 배포했다.

| Worker | version, 100% | 배포 직전 실제 version | deployment |
| --- | --- | --- | --- |
| `mapae-faucet` | `b5ca73cb-7905-405b-b791-5b814be1ca3d` | `6981394f-0567-4e26-84f7-6883b6d41cfb` | `a806f7bf-2ea1-4eb7-84c9-798c7d467a19` |
| `mapae-app` | `b5dab528-9936-4b94-a75f-d5c1feb07816` | `95c401f7-aa8c-463c-b0e4-9274b62428e4` | `e1488344-d7b2-4ed4-8a49-9ce0aae6ed9e` |
| `mapae` | `e6aa2acf-5f0d-4048-a2bd-d4039e382340` | `604d2688-45e2-450b-bc52-28a784b3272a` | `e25a4f37-d211-485c-8c8a-14bedba27d72` |

배포 전 API에서 읽은 실제 운영 버전을 복구 대상으로 기록했고, 최종 100% 전환을
다시 조회했다. 각 Worker의 기존 바인딩·시크릿 이름·호환 날짜·플래그를 보존했다.
웹 `.env.production`, seller와 faucet `.env`는 작업 전 백업과 바이트 단위로 같다.
DNS·Tunnel·D1·계약·개인키는 변경하지 않았다.

운영 확인:

- 세 도메인의 문서 14개, JS/CSS 152개 SHA-256이 로컬 최종 빌드와 일치했다.
  CSP nonce·no-store·nosniff·출처별 리디렉션을 확인했고 Turnstile은 faucet만 허용된다.
  두 아케이드의 NFT 이미지 읽기 요청은 각각 3회 모두 200이었다.
- 저장소의 `check-loading.mjs`를 세 운영 도메인에서도 실행해 HTML에 본문과 페이지별
  CSS가 포함되고 공유 숨김 스타일·폰트 분할이 유지됨을 확인했다.
- 격리 Chrome에서 JavaScript를 끈 한영 320/390/1440px의 첫 화면 18개가 표시됐다.
  같은 검사는 배포 전 로컬 운영 빌드에서도 통과했다.
- faucet의 한영 두 탭과 두 아케이드의 faucet 입구, 총 24개 화면에서 가로 넘침·
  이미지 실패·콘솔 오류가 없었다. 이 Mac의 일반 DNS 연결도 정상이다.
- 실제 공개 무료 연습에서 도장·경주·상점을 두 도메인에 걸쳐 6회 진입했다.
  시작 전 게임 엔진을 받지 않고 시작 후 선택한 엔진 하나만 받으며 헤더가 유지됐다.
  한글 390px·영문 1440px에서 가로 넘침과 콘솔 오류가 없었다.
  게임 완주·결제·실물 휴대폰 검수는 이번 확인 범위가 아니다.
- `bun scripts/ops/check.ts`에서 웹·seller·facilitator·인증 경계·입장권 견적·디스크 점검이 통과했다.

이번 요청은 웹 재배포이므로 seller와 다른 서버 프로세스는 재시작하지 않았다.
함께 받은 seller의 미확정 영수증 처리와 칭호 확정 10분 여유 수정은 서비스 재시작이
별도로 필요하다. docs Worker도 이번에는 배포하지 않았다. 지갑 서명·faucet 지급·
GIWA 트랜잭션은 실행하지 않았다. 비공개 증거와 복구본은
`~/.mapae/backups/web-release-20261013-095918`에 보관했다.

## 시즌 1 기능·공유 카드·ETH faucet 배포 — 2026-10-16

코드를 `5948667716fa14a338f46af2406997de1b70d20e`까지 fast-forward했고, 기존 로컬
보안 수정과 기록은 백업 브랜치·패치·stash로 보존했다. 에셋 저장소는
`17811d4513458c7e86cddbd7f00b0c55289b54fb`까지 받고 README 절차에 따라 동기화했다.
150개 체크섬, 공유 PNG 레이어 36개와 `wardrobe/fit.json`을 확인했다.
사용자 요청대로 시즌 시작·종료일은 모두 `null`로 유지했다. 커밋·푸시는 하지 않았다.

실제 앱 조합 검사에서 seller 공통 미들웨어가 PNG의 캐시 정책을 `no-store`로 덮어써
웹 프록시가 정상 공유 카드를 503으로 거절하는 문제를 재현했다. 정확한 공유 PNG 경로의
성공 GET/HEAD 응답에만 기존 60/3600초 정책을 유지하도록 수정했다. 미인증·오류·JSON·
결제 응답의 `no-store`와 보안 헤더는 유지된다. 실제 `createShopApp`과 랭킹 라우터를
조합한 회귀가 수정 전 실패, 수정 후 통과했다.

`bun install --frozen-lockfile`, 전체 `bun run check` 통과: TypeScript 1,946개
(공통/서버 1,309·MCP 3·웹 599·문서 35), Foundry 78개, 타입·빌드·문서·저장소·
로그·의존성 감사 게이트. 세 운영 빌드와 Wrangler dry-run도 통과했다.

사용자가 faucet 지갑 `0x2B07E3e5E00363a496224DE18cE345dE57A6bB21`에 GIWA Sepolia ETH를
충전했고, 잔액 1.02999981173476514 ETH를 읽기 전용으로 확인했다. 이번 작업에서 에이전트는
충전 거래를 보내지 않았다. faucet `.env`는 `FAUCET_ETH_MISSIONS=x_follow_mapae`만
변경하고 0600 권한과 기존 키·토큰·한도를 유지했다. 운영 상태 API에서 ETH 지급 활성,
1회 0.005 테스트 ETH·7일 간격·메인넷 nonce 최소 1 조건을 확인했다. 실제 수령은 미검증이다.

seller·faucet SQLite의 온라인 암호화 백업과 복원 검사를 완료하고, 재시작 직전에도
새 백업을 만들었다. 외출·미확정 정산·faucet 대기 지급이 없는 상태에서 기존 system
서비스를 재시작했다. faucet PID 97205, seller PID 97265다. seller의 기존 15개 비 lease
테이블과 faucet 기존 테이블의 행 해시·스키마를 보존했고, seller에는 빈
`arcade_season_hall` 테이블이 자동 생성됐다. 무결성·외래 키 검사도 통과했다.
seller `.env`와 웹 `.env.production`은 백업과 바이트 단위로 같다. 이전 배포에서
재시작을 기다리던 미확정 영수증 처리·칭호 확정 10분 여유 수정도 이번에 적용됐다.

faucet 서비스 → faucet 웹 → seller 서비스 → landing 웹 → app 웹 순서로 적용했다.

| Worker | version, 100% | 배포 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae-faucet` | `08bf6075-f410-441e-a7fc-417374283cee` | `b5ca73cb-7905-405b-b791-5b814be1ca3d` | `795909e1-f727-49eb-af2e-dc00f4c0778c` |
| `mapae` | `33ecccd5-a5bd-4d9c-aaa9-19e6572721d9` | `e6aa2acf-5f0d-4048-a2bd-d4039e382340` | `1103213d-b559-491b-841b-1e79880a9434` |
| `mapae-app` | `03001ac2-1d78-48c6-9a33-9ad58c9d4051` | `b5dab528-9936-4b94-a75f-d5c1feb07816` | `af1d5b14-3c71-4e66-8a98-ed11dac81f1a` |

세 Worker의 100% 전환과 기존 바인딩·시크릿 이름·호환 날짜·플래그를 API로 재확인했다.
공유 원본 레이어는 `.assetsignore`로 제외했고 업로드 로그에도 없었다.
DNS·Tunnel·D1·NFT 계약·기존 키는 변경하지 않았다. 다른 서버와 docs Worker는 유지했다.

운영 확인:

- 세 도메인의 문서 14개와 JS/CSS 152개 SHA-256, CSP nonce·no-store·nosniff·출처별
  리디렉션을 확인했다. Turnstile 허용은 faucet만 유지된다. NFT 이미지 읽기 6회 모두 200.
- 두 아케이드에서 시즌 `pending`, 날짜 미정과 12개 팀 순위를 확인했다. 실제 기존 일일
  공유 카드 `/api/arcade/share/g/3195/shop/2026-10-16/card.png`는 200·1200×630·
  ETag 끝 `-3"`·캐시 60초다. 시즌 카드 `/api/arcade/share/s/3195/card.png`의 404는
  시즌 미정에 따른 정상 결과이며, 시즌 활성화를 검증한 것으로 계산하지 않는다.
- 한영 공유 페이지는 Twitterbot User-Agent 요청에서 200과 OG 이미지·큰 카드 메타데이터를
  반환했고 차단 챌린지가 없었다. robots.txt에도 차단 규칙이 없었다. 이는 UA 모의 요청이며
  실제 X 크롤링·잠금 계정 게시 성공은 아니다. 사용자 요청대로 게시 테스트는 남겨 뒀다.
- 공유 원본 `/arcade/share/head-dog.png`는 공개 두 도메인에서 404, 직접 seller의 미인증
  공유 카드 요청은 401이었다. 잘못된 토큰 카드도 거절됐다.
- 격리 Chrome의 한영 320/390/1440px 등 44개 운영 화면에서 ETH 탭, 시즌 대기·팀 순위·
  공유 이미지 표시와 가로 넘침·이미지 실패·콘솔 오류 없음을 확인했다.
- 종료 시즌은 메모리 DB와 격리 브라우저 응답 fixture로 별도 확인했다. 세 참가자의 전당·
  추첨·문양과 1200×630 카드, 두 운영 번들의 한영 12개 화면에서 문양·전당·최종 순위·
  변동 표시 제거를 확인했다. fixture는 제거했으며 운영 DB·시즌·체인에 쓰지 않았다.
- `bun scripts/ops/check.ts`의 웹·seller·facilitator·인증 경계·입장권 견적·디스크 검사가 통과했다.

실제 faucet 수령·새 NFT 민팅·1 mUSDC 외출·성장 기록·X 게시와 실물 휴대폰 검수는
이번 배포에서 수행하지 않았다. 실제 시즌 봉인과 공개 블록 기반 추첨 재계산은 시즌 종료 후
런북에 따라 진행해야 한다. 비공개 백업과 배포·브라우저 증거는
`~/.mapae/backups/season1-release-20261016-014017`에 보관했다.

## 공유 카드·캐시·의존성 보안 패치 웹 배포 — 2026-10-29

`git pull --ff-only origin main`으로 `5948667`에서 `c16a28a`까지 받았다.
기존 로컬 수정과 배포 기록은 비공개 패치·백업 브랜치·stash로 보존했다. 충돌한 README의
검사 수와 faucet 테스트는 새 캐시 회귀와 기존 기본 fetch/Turnstile 회귀를 모두 유지해
정리했다. 커밋·푸시는 하지 않았다. 에셋 저장소는 기존 `17811d4`가 최신이며, README대로
동기화한 웹 에셋 150개 체크섬이 모두 일치했다.

이번 upstream 변경은 공동 최고 점수의 2위 이하 공유 페이지 허용, edge cache 적중 뒤
브라우저 캐시 수명 복원, 의존성 보안 패치와 감사 실패 차단이다. 기존 seller 공유 PNG
미들웨어 수정과 지갑 잔액 재확인 등 로컬 수정은 보존했다. 실행 중인 다섯 서비스의
의존성 그래프에는 바뀐 패키지 버전이 없고, seller 소스 변경도 주석뿐이다.
서버 재시작은 필요하지 않아 기존 PID를 유지했다.

새로 명시된 빌드 환경에 맞춰 공식 배포 파일의 SHA-256을 검증하고 Bun 1.4.4와
Node 24.22.1을 `~/.mapae/tools`에 별도 설치했다. 실행 중인 서비스의 기존 런타임이나
전역 PATH는 변경하지 않았다. 해당 도구로 `bun install --frozen-lockfile`과 전체
`bun run check`를 통과했다: TypeScript 1,948개(공통/서버 1,310·MCP 3·웹 600·문서 35),
Foundry 78개와 타입·문서·저장소·로그·의존성 감사·빌드. 세 운영 빌드와 Wrangler
dry-run도 통과한 뒤 기존 OAuth 인증으로 faucet → landing → app 순서로 배포했다.

| Worker | version, 100% | 배포 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae-faucet` | `402b9229-1ca2-4cb6-86e2-d014f06d5c5e` | `08bf6075-f410-441e-a7fc-417374283cee` | `5d8abe2c-5ea9-4ff3-8a8c-1951b58286a3` |
| `mapae` | `828ba938-c172-4899-9064-e97edf821fde` | `33ecccd5-a5bd-4d9c-aaa9-19e6572721d9` | `2a3304b7-4311-438e-9b9f-6606ed9c935f` |
| `mapae-app` | `0c313d19-d4ce-49a5-a1aa-56e76ef46aee` | `03001ac2-1d78-48c6-9a33-9ad58c9d4051` | `6538c50e-9dc5-4fed-9930-cd659c6b6cdb` |

최종 100% 전환과 바인딩·시크릿 이름·호환 날짜·플래그 보존을 API로 재확인했다.
공유 원본 레이어의 업로드는 없었다. seller/faucet `.env`, 웹 `.env.production`은
작업 전 백업과 바이트 단위로 같으며, 시즌 날짜·DB·D1·계약·DNS·Tunnel은 유지했다.

운영 확인:

- 세 도메인의 문서 14개, JS/CSS 152개 SHA-256과 로컬 최종 빌드가 일치했다.
  CSP nonce·no-store·nosniff·출처별 리디렉션, NFT 이미지 6회 모두 200을 확인했다.
- 반복 GET과 지원 경로의 HEAD를 포함한 32개 요청에서 캐시 수명을 확인했다:
  faucet/팀 순위 30초, 전령 순위 10초, 시즌/공유 페이지/PNG 60초, 공개 전령 SVG
  86400초·immutable. HEAD 본문은 비어 있다. 캐시 적중 경로 자체는 조작된 Cache API
  응답을 사용하는 회귀 테스트로도 검증했다.
- 두 도메인의 기존 일일 공유 PNG는 200·1200×630·ETag 끝 `-3"`다. 한영 공유 페이지의
  Twitterbot User-Agent 요청은 200과 OG 메타데이터를 반환했다. 실제 X 게시 검수는 아니다.
- 시즌은 여전히 `pending`과 날짜 미정이며 시즌 카드 404는 정상 결과다. ETH faucet의
  기존 0.005 테스트 ETH 지급 설정과 12개 팀 순위를 확인했다. 공유 원본 레이어는 공개
  404, 직접 seller의 미인증 PNG는 401이었다.
- 격리 Chrome의 한영·320/390/1440px 등 44개 화면에서 ETH 탭·시즌 대기·팀 순위·
  공유 이미지와 가로 넘침·이미지 실패·콘솔 오류 없음을 확인했다.
- `bun scripts/ops/check.ts`의 웹·seller·facilitator·인증 경계·입장권 견적·디스크 검사가 통과했다.

docs Worker는 배포하지 않았다. 새 지갑 서명·faucet 지급·결제·민팅·성장 거래나
실제 X 게시·실물 휴대폰 테스트는 실행하지 않았다. 비공개 복구본과 검증 증거는
`~/.mapae/backups/web-release-20261029-133103`에 보관했다.

## faucet 자격 미리 확인·지급액·거절 집계 적용 — 2026-10-29

`c16a28a`에서 최신 `049e5c7cd3b500188b20e89553e800e1cfe69bdc`까지 fast-forward했다.
기존 로컬 변경은 비공개 패치·백업 브랜치·stash로 보존했다. README 검사 수 충돌은
로컬 회귀를 포함한 실제 수로 정리했고 커밋·푸시는 하지 않았다.

사용자의 최종 순서 지시에 따라 **faucet 웹을 먼저 배포하고, 그다음 Mac mini의 기존
faucet 서비스를 재시작**했다. 앞서 대기 중이던 재시작 요청은 종료하고 실행 방지 표식을
남겼다. 랜딩·앱 Worker는 이전 `c16a28a` 배포를 유지하며 faucet만 이번 커밋을 사용한다.
`deployments/giwa-sepolia.guardians.json`의 `surfaceSources`에 출처별 커밋을 구분했다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae-faucet` | `2d35964e-9e33-4e37-be92-dabca06cebbc` | `402b9229-1ca2-4cb6-86e2-d014f06d5c5e` | `30ac48ba-4c26-4388-bb20-391525a98d4a` |

faucet `.env`와 LaunchDaemon에 `FAUCET_ETH_DAILY_WEI` override가 없음을 확인했다.
환경 파일은 변경하지 않았으며 재시작 후 서비스 로그의 일일 상한은
`50000000000000000` wei(0.05 테스트 ETH), 운영 상태 API의 건당 지급액은
`500000000000000` wei(0.0005 테스트 ETH)다. 일일 최대 100건, 기존 7일 지갑 간격과
잔액 바닥·자격 조건은 유지한다.

SQLite 온라인 암호화 백업과 복원 검사를 완료했다. 복원본에 새 스키마를 두 번 적용해
기존 청구 14건과 기존 스키마 보존을 확인했다. 재시작 직전에도 미결 청구 0을 확인하고
새 백업·복원 검사를 했다. 실제 재시작 후 원장 전체 행 해시가 동일했고
`faucet_refusals`만 추가됐다. `system/io.mapae.faucet`의 새 PID는 64680이다.
코드의 런타임 요구에 맞춰 LaunchDaemon의 실행 파일만 별도 설치된 Bun 1.4.4로 바꿨다.
기존 작업 디렉터리·사용자·환경·키·DB 경로와 다른 네 서비스 PID는 유지했다.

ETH 미지급 조사:

- 전체 원장 집계는 ETH `skipped` 3건, mUSDC `confirmed` 11건이다. 코드의 `skipped`
  전환은 수취 지갑 잔액이 이미 기준 이상이라 지급액이 0으로 계산된 경우다.
- 기존 stdout/stderr에 `eligibility read failed`는 없었다. 이전 버전의 청구 예약 전
  거절은 집계되지 않았으므로 모든 과거 거절 사유를 소급해서 확정할 수는 없다.
- 재시작 후 `/health.last7Days`는 ETH `skipped` 1건, mUSDC `confirmed` 2건,
  `refusals: []`였다. 새 거절 집계는 적용 시점부터 쌓이며 과거 값을 만들지 않았다.

검증:

- 전체 `bun run check`: TypeScript 1,962개(공통/서버 1,318·MCP 3·웹 606·문서 35),
  Foundry 78개와 타입·문서·보안·빌드 게이트 통과. faucet 운영 빌드/dry-run도 통과했다.
- 서비스의 기존 자격 충족 지갑/이력이 없는 주소에 대한 읽기 전용 자격 조회가 각각
  `eligible: true/false`를 반환했다. 미인증·잘못된 주소·Origin·터널 health 경계도 확인했다.
  조회 전후 청구·거절 집계는 동일했다.
- 공개 자격 조회의 정상/누락/잘못된 주소/타 Origin 네 경우와 `private, no-store`를
  확인했다. 한영 문서 2개와 공개 JS/CSS 48개 SHA-256이 최종 빌드와 일치했다.
- 실제 Chrome의 지갑 없는 한영·320/390/1440px 두 탭 12개 화면에서 새 지급액과
  넘침·콘솔 오류 없음을 확인했다. 별도 읽기 전용 지갑 provider fixture의 6개 화면에서는
  실제 공개 자격 API를 사용해 서명 전 미달 안내·공식 GIWA faucet 링크를 확인했다.
  미션 선택 후에도 지급 버튼은 비활성이었으며 서명·로그인·청구 요청은 보내지 않았다.
- 새 faucet 점검을 포함한 `bun scripts/ops/check.ts`가 통과했다. Cloudflare에서 faucet의
  100% 전환과 기존 바인딩·시크릿·호환 설정, 랜딩·앱의 이전 버전 유지를 재확인했다.

GitHub Monitor는 `active`, 매시 07/37분 설정이며 수동 실행 `40870258661`은 성공했다.
이 확인은 예약 실행의 실패 메일 도착을 검증한 것은 아니다. GitHub의 자동 비활성 기준은
공개 저장소에 활동이 없는 60일이며, 7일이 아니다.
[GitHub 예약 실행 안내](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

실제 지급·민팅·외출 결제·성장·X 게시는 실행하지 않았다. DB 기존 기록·D1·계약·시즌
날짜·DNS·Tunnel과 환경 파일은 유지했다. 비공개 증거와 복구본은
`~/.mapae/backups/faucet-release-20261029-210927`에 보관했다.

## 유입 출처·무료 오락실 안내 띠 배포 — 2026-10-30

최신 main `bcfe0b8d7583b77785afc2f7ab84f4540f763428`을 fast-forward로 받았다.
기존 로컬 변경은 패치·백업 브랜치·stash로 보존하고 복원했다. README 검사 수는
로컬 회귀를 포함한 실제 결과로 갱신했으며 커밋·푸시는 하지 않았다.

**원격 D1 스키마를 먼저 적용하고 landing → app → faucet 순서로 배포했다.**
적용 전 D1 전체를 내보내 별도 SQLite에 복원하고 무결성·외래 키를 검사했다.
암호화 백업의 복원 검사와 스키마 두 번 적용 검사를 통과했다. 원격의 도착 이벤트
중복이 0임을 확인한 뒤 `src/arcade/engagement/schema.sql`을 적용했다.
`arcade_engagement_sources`와 `arcade_engagement_session_arrival`이 추가됐고,
적용 직후 기존 스키마와 이벤트 수는 그대로였다. 이후 세 Worker를 아래 버전으로
100% 전환했다. 기존 바인딩·시크릿·호환 날짜·Node 플래그를 보존했다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae` | `15bd8a29-4b90-4994-bd57-d962bd910fa8` | `828ba938-c172-4899-9064-e97edf821fde` | `42a86835-9e4f-4f6a-9752-a1c9d29ac17e` |
| `mapae-app` | `cc6eb8f6-1c9a-4758-b817-1d4678804886` | `0c313d19-d4ce-49a5-a1aa-56e76ef46aee` | `c43f2e98-6c3c-40ae-8c30-f64b14976f78` |
| `mapae-faucet` | `3703cad3-861b-4646-a208-9e29f69d8bed` | `2d35964e-9e33-4e37-be92-dabca06cebbc` | `4c4f5eb0-f630-4ca8-b296-e6b4dc35c324` |

검증:

- 전체 `bun run check`: TypeScript 1,962개(공통/서버 1,316·MCP 3·웹 608·문서 35),
  Foundry 78개와 타입·문서·보안·빌드 게이트 통과. 세 운영 빌드/dry-run도 통과했다.
- 세 도메인의 문서 14개와 JS/CSS 153개 SHA-256이 최종 빌드와 일치했다.
  CSP nonce·no-store·nosniff, 출처별 리디렉션, NFT 이미지 6회 HTTP 200을 확인했다.
  기존 아트 에셋 체크섬 150개가 일치했고 공유 원본 레이어는 업로드하지 않았다.
- 격리 Chrome에서 한영·320/390/1440px의 24개 화면을 검사했다. 새 무료 오락실 띠와
  두 링크, 무료 오락실 진입, faucet ETH 탭의 0.0005 표시가 정상이며 가로 넘침·
  이미지 실패·콘솔 오류가 없었다. 실물 휴대폰 검수는 아니다.
- 정상 익명 QA 방문으로 만들어진 호스트별 방문자 3개를 D1에서 대조했다. 랜딩·앱의
  최초 출처는 `direct`, 랜딩 링크로 연 faucet은 `landing`이다. 나중에 `?ref=x`로
  돌아와도 기존 첫 출처는 유지됐다. 반복 방문·언어 전환 뒤에도 세 호스트의 도착
  이벤트는 합계 4건으로 중복되지 않았다. 이 QA 방문은 방문 통계에 포함되지만
  deliberate 이벤트는 0이므로 DAU·재방문 코호트를 만들지 않는다. QA 식별 자료는
  비공개 증거에만 보관했다. 운영 DB에 가짜 플레이·지급 기록은 넣지 않았다.
- 세 도메인에서 GET·다른 Origin·옛 source 누락 요청·서버 전용 지급 이벤트 위조
  12건이 각각 405/403/400/400으로 거절됐다. 방문 쿠키의 HttpOnly·Secure·
  SameSite=Strict도 확인했다. 비동기 faucet 기록의 실패 격리는 회귀 테스트로 검증했다.
- `bun scripts/ops/check.ts`의 웹·seller·facilitator·인증 경계·입장권 견적·faucet·
  디스크 점검이 통과했다.

웹 배포 후 사용자 OS 관리자 인증으로 기존 `system/io.mapae.faucet`을 재시작했다
(09:51 KST, PID 19811). 직전 미결 청구가 0임을 확인하고 SQLite 온라인 암호화 백업과
복원 검사를 했다. 재시작 전후 DB 모든 행의 해시와 스키마가 같으며 기존 ETH skipped
3건·mUSDC confirmed 12건을 보존했다. 환경 파일·LaunchDaemon·다른 네 서비스 PID도
유지됐다. 이번 검수에서 지급 요청은 보내지 않았다.

직접 인증한 서버 상태에서 Ethereum L1 nonce 조건 제거와 옛 자격 조회 경로의 404를
확인했다. mUSDC·ETH는 활성이고 건당 0.0005 테스트 ETH·일일 0.05 테스트 ETH 상한은
그대로다. 미결 청구는 0이며 미인증·Origin·터널 health 경계 세 건이 401/403/404로
거절됐다. 재시작 후 공개 faucet 상태와 전체 운영 점검도 통과했다.

이미 열려 있던 탭은 새로고침해야 새 기록 형식을 사용한다. 보고서용 D1 내보내기에는
`arcade_engagement_sources`를 포함한다. 시즌 날짜는 미정으로 유지했고 새 계약 배포·
실제 faucet 지급·지갑 서명·민팅·외출 결제·성장·X 게시는 실행하지 않았다.
비공개 복구본과 검증 증거는 `~/.mapae/backups/engagement-release-20261030-093553`에 있다.

## 순위 응답 복구·판매자 health 수정 적용 — 2026-11-02

최신 main `4672807`까지 fast-forward했다(추가 커밋 `8f41318`, `4672807`).
기존 로컬 수정은 비공개 패치·백업 브랜치·stash로 보존해 복원했다. README의 검사 수
충돌은 실제 수집 결과로 정리했으며, 이전 배포 수정과 기록을 유지했다. 커밋·푸시는 없다.

10월 30일의 2단계 배포가 이미 완료됐음을 Cloudflare API로 재확인했다. 원격 D1의
`arcade_engagement_sources`와 `arcade_engagement_session_arrival`이 있고 세 Worker가
당시 기록된 버전으로 100% 서비스 중이었다. 이번 변경에는 D1 수정이 없으므로
스키마를 다시 적용하지 않았다. 사용자 지시대로 앱 Worker와 판매자만 갱신했다.
랜딩·faucet은 `bcfe0b8` 배포를 유지하며 `surfaceSources`에 구분했다.

| Worker | version, 100% | 직전 version | deployment |
| --- | --- | --- | --- |
| `mapae-app` | `05e5e251-779f-453d-9fdd-b74490a5ee3a` | `cc6eb8f6-1c9a-4758-b817-1d4678804886` | `885bb392-5842-4a18-8aeb-b54f566b8888` |

전체 `bun run check`는 TypeScript 1,965개(공통/서버 1,317·MCP 3·웹 610·문서 35),
Foundry 78개와 타입·문서·보안·빌드 게이트를 통과했다. 앱 운영 빌드와 Wrangler
배포 dry-run도 통과했다. 이전 공유 PNG 캐시 수정은 보존했다.

앱 배포 후 사용자 OS 관리자 인증으로 기존 `system/io.mapae.delegated-seller`를
재시작했다(PID 74034). DB 경로는 실행 중 프로세스에서 확인한 기존
`apps/delegated-seller/data/seller.sqlite`다. 사전 및 재시작 직전 온라인 암호화 백업과
복원 검사를 완료했다. 재시작 전후 스키마와 모든 영구 데이터의 행 해시가 동일했다.
변하는 실행 잠금 `arcade_outing_lease`만 행 비교에서 제외했다. 환경 파일·LaunchDaemon과
다른 네 서비스 PID는 유지했다.

재시작 직전 실행·대기 외출과 facilitator 미결 정산은 각각 0건이었다. 별도로 기존
`paused/payment_unresolved` 복구 기록 12건이 있었고, 서명 헤더를 가진 이 기록들은
재시작 시 자동 실행되지 않음을 코드에서 확인한 뒤 그대로 보존했다. 소유자의 재개
요청이나 결제 재전송은 실행하지 않았다. seller 주문과 facilitator 원장을 읽기 전용으로
대조한 2,472건은 일치했다. 이 대조만으로 12건의 결제 복구 문제가 해결된 것은 아니다.

운영 검증:

- 앱 문서 6개와 JS/CSS 48개 SHA-256이 최종 빌드와 일치한다. CSP nonce·no-store·
  nosniff를 유지했고 공유 원본 레이어 업로드는 없었다.
- 순위·팀·내 위치·시즌 API의 반복 조회 12건이 유효한 JSON과 30/10/60초 캐시 수명을
  반환했다. 내부 `X-Mapae-Fresh-Until`과 쿠키는 응답에 노출되지 않았다. 잘못된
  메서드·쿼리·페이지 요청 3건도 405/400/400과 no-store로 거절됐다.
- 판매자의 직접/공개 `/health`가 200, DB·facilitator 준비 상태가 모두 true다.
  실제 정산 facilitator 설정은 loopback이고, health에 표시되는 공개 주소는 유지한다.
  미인증 순위 요청은 직접/공개 양쪽 모두 401이다.
- 판매자 실패 시 검증된 캐시 사본으로 답하는 처리와 새 응답으로 교체하는 처리는
  회귀 테스트로 확인했다. 운영 서비스에 의도적인 장애를 주는 시험은 하지 않았다.
- 전체 운영 점검과 Cloudflare 배포 API 재조회가 통과했다. 앱은 새 버전 100%,
  랜딩·faucet은 기존 버전 그대로다. 이번 변경은 화면 코드 수정이 없어 별도 브라우저
  시각 검수를 추가하지 않았다.

시즌 날짜는 미정으로 유지했다. 새 계약 배포·에셋 갱신·지갑 서명·실제 결제·지급은
실행하지 않았다. 비공개 복구본과 증거는
`~/.mapae/backups/ranking-health-release-20261102-171604`에 보관했다.
