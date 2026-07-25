#!/usr/bin/env bash
# Verify all 38 Framework units on GIWA Sepolia Blockscout.
#
# 33 need only the compiler profile; 5 need --constructor-args and one of those
# (HybridDeleGatorImpl) also needs --libraries. Addresses and constructor arguments
# are cross-checked against deployments/giwa-sepolia.framework-manifest.json — that
# file is authoritative, NOT framework.json, whose `environment` omits SCL_RIP7212.
#
# Expect PARTIAL match on every unit. That is the correct outcome, not a failure:
# the deployed code is MetaMask's audited npm bytecode, so the 32-byte IPFS metadata
# digest differs while every executable byte matches. MockUSDC is already in that
# same state.
#
# Run order matters in one place: SCL_RIP7212 must be verified before
# HybridDeleGatorImpl, or the explorer cannot resolve the linked library.
#
# No private key is used or needed — verification only publishes source.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd /Users/kooroot/Desktop/dev/mapae/contracts/lib/delegation-framework

# Guard: must be the exact deployed revision, or the bytecode will not correspond.
EXPECTED_REV=d0ebab5386503824730fdc0e48924f362d8290d0
ACTUAL_REV=$(git rev-parse HEAD)
if [ "$ACTUAL_REV" != "$EXPECTED_REV" ]; then
  echo "ABORT: submodule at $ACTUAL_REV, expected $EXPECTED_REV" >&2
  exit 1
fi

VU='https://sepolia-explorer.giwa.io/api/'
CV='v0.8.23+commit.f704f362'

# address <space> path:ContractName
read -r -d '' UNITS <<'EOF' || true
0xbED01c51285771437154B01D7EB1E942B96A30b2 src/utils/SimpleFactory.sol:SimpleFactory
0x9C8fb08f2F00F474B1A3F1d02988a7b498f31165 src/enforcers/AllowedCalldataEnforcer.sol:AllowedCalldataEnforcer
0x412aEB6daB5f782d133F14f756f4E191f90E4C32 src/enforcers/AllowedTargetsEnforcer.sol:AllowedTargetsEnforcer
0x637DcE9006b58C99446A43B326DECC22756A53a7 src/enforcers/AllowedMethodsEnforcer.sol:AllowedMethodsEnforcer
0x7985846b0b9f4f1641774a9323bDc4e1dbbe29bD src/enforcers/ApprovalRevocationEnforcer.sol:ApprovalRevocationEnforcer
0xf371d6cA846362D0c5342d4182e12f248Abb0878 src/enforcers/ArgsEqualityCheckEnforcer.sol:ArgsEqualityCheckEnforcer
0x3fc13b47b7E7D2DbF257070c89395AAc43D22115 src/enforcers/DeployedEnforcer.sol:DeployedEnforcer
0xEE818d86Ec7642335c1B6d90b529F3c5060D9fb8 src/enforcers/TimestampEnforcer.sol:TimestampEnforcer
0xAF723E03725cEFC4B2Ee74f8aFb4044Be722584A src/enforcers/BlockNumberEnforcer.sol:BlockNumberEnforcer
0x416b79119A766bee45e1F9bE1A0955F921CFe34d src/enforcers/LimitedCallsEnforcer.sol:LimitedCallsEnforcer
0x6105728F5895fCa116bC9fB17Df64138b3310B67 src/enforcers/ERC20BalanceChangeEnforcer.sol:ERC20BalanceChangeEnforcer
0x6e2023356bd37a4DA70DAB3e1374B9fFd44bbc0e src/enforcers/ERC20TransferAmountEnforcer.sol:ERC20TransferAmountEnforcer
0xBd1A645E76cB748616f3aB89755b7cc66147c344 src/enforcers/ERC20StreamingEnforcer.sol:ERC20StreamingEnforcer
0xF3BA7dA29d9285533a40DE6044fe4118A786D7e9 src/enforcers/ERC721BalanceChangeEnforcer.sol:ERC721BalanceChangeEnforcer
0xAf3B31e662F4413935ef0ccA69126DA622A1Ef72 src/enforcers/ERC721TransferEnforcer.sol:ERC721TransferEnforcer
0x3686051360cDbC512Fe6d783E8916Ce882A176af src/enforcers/ERC1155BalanceChangeEnforcer.sol:ERC1155BalanceChangeEnforcer
0x321b7D61c67Ea0B650aEE19231bFc2adFb334316 src/enforcers/IdEnforcer.sol:IdEnforcer
0xBf24097FbB32346C05d0829e27e6041d2CDFbaFf src/enforcers/NonceEnforcer.sol:NonceEnforcer
0x7EA4d8d14aC4Bcff8e1D3C785de1FA529f421Ce5 src/enforcers/ValueLteEnforcer.sol:ValueLteEnforcer
0x5E2f42d305C674F0761E41D3DA77F8A3601748c8 src/enforcers/NativeTokenTransferAmountEnforcer.sol:NativeTokenTransferAmountEnforcer
0x097c6b710bC38E60797E1F9F396BC1782cC12714 src/enforcers/NativeBalanceChangeEnforcer.sol:NativeBalanceChangeEnforcer
0xBD52B958DaF25Df3751601E31edbEa89191ACfaA src/enforcers/NativeTokenStreamingEnforcer.sol:NativeTokenStreamingEnforcer
0x0f423B5DB18c66178eEd4cA4a7e3021067b4E294 src/enforcers/OwnershipTransferEnforcer.sol:OwnershipTransferEnforcer
0xA44561Ac0b3d7Bc465c9E5177F63E1AB3622dDfe src/enforcers/RedeemerEnforcer.sol:RedeemerEnforcer
0xc2dCDaaBec97C4b3118075641A852D5884Da4e74 src/enforcers/SpecificActionERC20TransferBatchEnforcer.sol:SpecificActionERC20TransferBatchEnforcer
0x700330288f6f094780121ea54cd2eDEfe45b3625 src/enforcers/ERC20PeriodTransferEnforcer.sol:ERC20PeriodTransferEnforcer
0x40b6f626a1e6D1e17625277d2Db9F2E87Ea0138d src/enforcers/NativeTokenPeriodTransferEnforcer.sol:NativeTokenPeriodTransferEnforcer
0x157BC93Be05c899E44d6836a95A25385531b67c9 src/enforcers/ExactCalldataBatchEnforcer.sol:ExactCalldataBatchEnforcer
0x8823B75199671aC4C6d20438921680c18c9B4D90 src/enforcers/ExactCalldataEnforcer.sol:ExactCalldataEnforcer
0xcF3F6cA8323C0450C2Eb913f85c2EBcd4efB2389 src/enforcers/ExactExecutionEnforcer.sol:ExactExecutionEnforcer
0xE696A7c90a4a94FA1417CeEAbB108024884A03Bf src/enforcers/ExactExecutionBatchEnforcer.sol:ExactExecutionBatchEnforcer
0x937848926405a71502f36B59F00669Ddb4987762 src/enforcers/MultiTokenPeriodEnforcer.sol:MultiTokenPeriodEnforcer
0x9c4A2911359a900F1b713576e3B7FAbe4367fA72 lib/SCL/src/lib/libSCL_RIP7212.sol:SCL_RIP7212
EOF

FAILED=()
while read -r ADDR TARGET; do
  [ -z "${ADDR:-}" ] && continue
  echo "=== ${TARGET#*:}  $ADDR"
  if ! forge verify-contract "$ADDR" "$TARGET" \
      --chain 91342 \
      --verifier blockscout \
      --verifier-url "$VU" \
      --compiler-version "$CV" \
      --num-of-optimizations 200 \
      --watch; then
    echo "!!! FAILED: $TARGET"
    FAILED+=("$TARGET")
  fi
  sleep 3   # Blockscout allows 300 req/min; this is well under
done <<< "$UNITS"

echo "--- 33 no-arg units submitted ---"

# ---------------------------------------------------------------------------
# The 5 units that carry constructor arguments.
#
# Deployment names differ from source names for two of these: the manifest calls
# them HybridDeleGatorImpl / MultiSigDeleGatorImpl, but `path:Name` must use the
# SOURCE name (HybridDeleGator / MultiSigDeleGator) or forge cannot find the unit.
# ---------------------------------------------------------------------------
MANAGER=0xF2F782FafBB278eBe46a4F4004B6d45d125EF40C
OWNER=0x5Ea1FB5f222572c03220356cb2914Da2b5acc0DE
ENTRYPOINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032
ARGS_EQ=0xf371d6cA846362D0c5342d4182e12f248Abb0878
SCL=0x9c4A2911359a900F1b713576e3B7FAbe4367fA72

verify_with_args() {
  local addr="$1" target="$2" args="$3"; shift 3
  echo "=== ${target#*:}  $addr"
  if ! forge verify-contract "$addr" "$target" \
      --chain 91342 \
      --verifier blockscout \
      --verifier-url "$VU" \
      --compiler-version "$CV" \
      --num-of-optimizations 200 \
      --constructor-args "$args" \
      "$@" \
      --watch; then
    echo "!!! FAILED: $target"
    FAILED+=("$target")
  fi
  sleep 3
}

verify_with_args "$MANAGER" src/DelegationManager.sol:DelegationManager \
  "$(cast abi-encode 'constructor(address)' "$OWNER")"

verify_with_args 0x2224e1e92bCddAc18530557880B78f04655e2836 \
  src/enforcers/NativeTokenPaymentEnforcer.sol:NativeTokenPaymentEnforcer \
  "$(cast abi-encode 'constructor(address,address)' "$MANAGER" "$ARGS_EQ")"

# SCL_RIP7212 is index 34 and already went through the loop above — it must be
# verified before this one so the explorer can resolve the link.
verify_with_args 0xDd64e5D75aBe21Ea4f2a69c35dA23e09A37D8185 \
  src/HybridDeleGator.sol:HybridDeleGator \
  "$(cast abi-encode 'constructor(address,address)' "$MANAGER" "$ENTRYPOINT")" \
  --libraries "lib/SCL/src/lib/libSCL_RIP7212.sol:SCL_RIP7212:$SCL"

verify_with_args 0x0e7F86337C3FA93E53658Fee0E9D42Bbd9b886B5 \
  src/MultiSigDeleGator.sol:MultiSigDeleGator \
  "$(cast abi-encode 'constructor(address,address)' "$MANAGER" "$ENTRYPOINT")"

verify_with_args 0x393AE8400430F9E3e1aa97Beb57D98f98003BE5D \
  src/EIP7702/EIP7702StatelessDeleGator.sol:EIP7702StatelessDeleGator \
  "$(cast abi-encode 'constructor(address,address)' "$MANAGER" "$ENTRYPOINT")"

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All 38 submitted. Expect 'partial match' on each — that is the correct result."
else
  printf 'FAILED (%d):\n' "${#FAILED[@]}"; printf '  %s\n' "${FAILED[@]}"
fi

# Spot-check what the explorer recorded:
#   curl -sS 'https://sepolia-explorer.giwa.io/api/v2/smart-contracts/0x7EA4d8d14aC4Bcff8e1D3C785de1FA529f421Ce5' \
#     | jq '{name,is_verified,is_partially_verified,is_fully_verified,compiler_version,evm_version}'