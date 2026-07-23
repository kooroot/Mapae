-include .env

RPC_URL      := https://sepolia-rpc.giwa.io
VERIFIER     := blockscout
VERIFIER_URL := https://sepolia-explorer.giwa.io/api/
RPC          := giwa_sepolia
TARGET       := src/MockUSDC.sol:MockUSDC

.PHONY: build test fmt deploy verify json clean

build:
	forge build

test:
	forge test -vvv

fmt:
	forge fmt

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
