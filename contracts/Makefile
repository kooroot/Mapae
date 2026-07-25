-include .env

RPC_URL      := https://sepolia-rpc.giwa.io
VERIFIER     := blockscout
VERIFIER_URL := https://sepolia-explorer.giwa.io/api/
RPC          := giwa_sepolia
TARGET       := src/MockUSDC.sol:MockUSDC

.PHONY: build test fmt deploy verify json clean \
	framework-prepare framework-test framework-simulate framework-deploy \
	framework-import framework-accept framework-finalize owner-account-deploy \
	owner-account-verify

build:
	forge build

test:
	forge test -vvv

fmt:
	forge fmt

## Pinned npm bytecodes -> local Forge-readable bundle. No key or RPC is used.
framework-prepare:
	cd ../apps/delegation-lab && bun run forge:prepare

## Deploy all 38 units + owner proxy locally and verify constructor/library wiring.
framework-test: framework-prepare
	forge test --match-contract DeployDelegationFrameworkTest -vvv

## Full GIWA fork simulation. Requires the same gated env as broadcast, but makes no RPC write.
framework-simulate: framework-prepare
	FRAMEWORK_FORGE_ADDRESS_PATH=./generated/framework-simulation-addresses.json \
		forge script script/DeployDelegationFramework.s.sol \
		--rpc-url giwa_sepolia -vv

## 38 creations + transferOwnership(). This is the explicit GIWA write boundary.
framework-deploy: framework-prepare
	forge script script/DeployDelegationFramework.s.sol \
		--rpc-url giwa_sepolia --broadcast -vvvv

## Read-only import of run-latest.json + independent RPC evidence verification.
# `@` is load-bearing, not cosmetic. Make echoes each logical recipe line *after*
# variable expansion, so without it the whole command — including the expanded
# GIWA_SEPOLIA_RPC_URL — is printed to stdout and into any CI log. A private RPC
# endpoint carries its API key in the URL path, which makes that echo a credential
# disclosure. Verified with a replica Makefile: the unsilenced form printed the full
# URL before running.
framework-import:
	@cd ../apps/delegation-lab && \
		FRAMEWORK_ADMIN_ADDRESS='$(FRAMEWORK_ADMIN_ADDRESS)' \
		GIWA_SEPOLIA_RPC_URL='$(GIWA_SEPOLIA_RPC_URL)' \
		bun run forge:import

## Optional Forge route. Rabby/multisig acceptOwnership() is also supported.
framework-accept:
	forge script script/AcceptFrameworkOwnership.s.sol \
		--rpc-url giwa_sepolia --broadcast -vvvv

## Read-only transition from ownership-pending evidence to the active artifact.
framework-finalize:
	@test -n "$(ACCEPT_TX)" || (echo "ACCEPT_TX=0x... is required"; exit 1)
	@cd ../apps/delegation-lab && \
		CASE_1_OWNER_ADDRESS='$(CASE_1_OWNER_ADDRESS)' \
		CASE_2_VENDOR_ADDRESS='$(CASE_2_VENDOR_ADDRESS)' \
		FRAMEWORK_ADMIN_ADDRESS='$(FRAMEWORK_ADMIN_ADDRESS)' \
		GIWA_SEPOLIA_RPC_URL='$(GIWA_SEPOLIA_RPC_URL)' \
		FRAMEWORK_OWNERSHIP_ACCEPTANCE_TX='$(ACCEPT_TX)' \
		bun run finalize:framework

## Active Framework only: deploy and verify the owner HybridDeleGator proxy.
owner-account-deploy: framework-prepare
	forge script script/DeployOwnerAccount.s.sol \
		--rpc-url giwa_sepolia --broadcast -vvvv

## Read-only live RPC verification. Fails instead of simulating a missing account.
owner-account-verify: framework-prepare
	OWNER_ACCOUNT_VERIFY_ONLY=true forge script script/DeployOwnerAccount.s.sol \
		--rpc-url giwa_sepolia -vvvv

## 배포 + 검증 (한 번에)
deploy:
	forge script script/DeployMockUSDC.s.sol \
		--rpc-url $(RPC) \
		--broadcast \
		--verify \
		--verifier $(VERIFIER) \
		--verifier-url $(VERIFIER_URL) \
		-vvvv

## 배포 중 verify가 실패했을 때 따로 실행: make verify ADDR=0x...
## --rpc-url을 쓰면 체인 ID를 노드에서 읽어 [etherscan] 설정 조회를 건너뜀
verify:
	@test -n "$(ADDR)" || (echo "ADDR=0x... 를 지정하세요"; exit 1)
	forge verify-contract \
		--rpc-url $(RPC_URL) \
		--verifier $(VERIFIER) \
		--verifier-url '$(VERIFIER_URL)' \
		--watch \
		$(ADDR) $(TARGET)

## CLI가 Cloudflare에 막힐 때 웹 UI 업로드용 standard JSON 생성
json:
	forge verify-contract --show-standard-json-input $(ADDR) $(TARGET) > verify-input.json
	@jq 'has("sources")' verify-input.json

clean:
	forge clean
