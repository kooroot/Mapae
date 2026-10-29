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
3. 새 구현을 배포·verify한다(생성자 인수 동일). 링크된 `GuardianMetadata` 주소가 검증된 라이브러리 bytecode의 CREATE2 주소와 같은지 확인한다. `tokenURI`는 이 라이브러리를 DELEGATECALL하므로 잘못 링크된 주소는 프록시 저장소에서 실행된다. fork 시뮬레이션에서 `upgradeToAndCall`을 실행해 기존 토큰의 `tokenURI`를 비교한 뒤 관리자 지갑으로 실제 호출한다. 추가 초기화가 필요하면 `reinitializer(2)` 함수를 `data`로 함께 호출한다.
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

**지워진 함수.** `claimResult`와 `claimResults`는 배포된 적이 없어 지웠다. 이 업그레이드 뒤에는 `claim`만 남는다.

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
8. **웹 배포.** `bun run deploy:app`으로 웹을 배포한다.

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

배포 기록에는 git SHA, 체인 ID, NFT 프록시 주소·구현 주소·라이브러리 주소·배포 해시·관리자·결과 서명자, 업그레이드 해시, 난수 요청/공개 해시와 token/sequence, 입장·성장 해시, D1 적용 시점, seller 재시작 시점, 두 Worker version ID를 남긴다. 개인 키·bearer·권한 원문은 기록하지 않는다. 실제 이용자 성과 보고서는 [파일럿 안내](arcade-guardians-pilot.md)의 읽기 전용 도구로 별도 생성한다.
