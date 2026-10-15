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

두 Worker는 같은 `mapae-arcade-profiles` D1을 사용한다. 새 지표 테이블만 추가하며 기존 프로필을 삭제하지 않는다.

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
- **배포 순서.** 이 기능이 처음 올라갈 때는 seller 재시작 → `deploy:app`. 재시작 전에는 웹 프록시의 `/api/arcade/ranking/season`과 시즌 보드가 503이라 로비 배너는 보이지 않고 시즌 탭은 오류 안내를 보여 주며, 기존 순위표는 영향이 없다.
- **상품·문양·명예의 전당.** 상위 3명 커피 기프티콘과 7일 연속 출석 전령 중 추첨 1명은 시즌이 끝난 뒤 수동으로 전달한다. 시즌 한정 문양과 명예의 전당은 다음 단계에서 올린다.

### 신뢰 경계

- 관리자는 모든 상태를 신뢰받는다. 업그레이드는 즉시 적용되고(timelock 없음) birth·성장·소유권을 바꿀 수 있으며, 결과 서명자를 자기 키로 바꿔 성장을 직접 발급할 수도 있다. 관리자/서명자 분리는 서명 키가 유출돼도 관리자 권한을 얻지 못하게 하는 키 위생 규칙이다. 테스트넷 밖에서 쓰기 전에 owner를 multisig(필요하면 TimelockController)로 `transferOwnership` → `acceptOwnership`한다.
- 교체한 결과 서명 키는 폐기된 것으로 본다. 결과에는 만료가 없어서, 예전 키로 되돌리면 그 키가 서명했지만 청구되지 않은 결과가 다시 유효해진다.
- 정식 컬렉션은 `ARCADE_GUARDIAN_ADDRESS`의 프록시 하나뿐이다. 누구나 같은 구현 앞에 자기 프록시를 세워 같은 이름의 토큰을 만들 수 있으므로 마켓·인덱서에는 프록시 주소를 기준으로 안내한다. 서명 domain·birth seed·Pyth 요청자가 모두 프록시 주소에 묶여 있어 다른 프록시로 옮겨지지 않는다.
- 감사 기록: [MapaeGuardians UUPS audit 2026-10-11](audits/mapae-guardians-uups-2026-10-11.md).

## 운영 중 중지와 기록

신규 뽑기는 `setMintPaused(true)`로 중지한다. 외출 문제가 있으면 사용자 UI에서 중지·권한 회수하고 필요 시 `ARCADE_OUTINGS_ENABLED=false`로 seller를 재시작한다. 이미 제출한 결제·결과 DB는 보존한다. 이전 가변 캐릭터 버전으로 되돌려 NFT 작업을 실행하지 않는다.

배포 기록에는 git SHA, 체인 ID, NFT 프록시 주소·구현 주소·라이브러리 주소·배포 해시·관리자·결과 서명자, 업그레이드 해시, 난수 요청/공개 해시와 token/sequence, 입장·성장 해시, D1 적용 시점, seller 재시작 시점, 두 Worker version ID를 남긴다. 개인 키·bearer·권한 원문은 기록하지 않는다. 실제 이용자 성과 보고서는 [파일럿 안내](arcade-guardians-pilot.md)의 읽기 전용 도구로 별도 생성한다.
