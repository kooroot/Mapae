# MapaeGuardians UUPS audit (2026-10-11)

Internal review of the UUPS-converted guardian collection before its first GIWA Sepolia deployment. The collection is a testnet product and is deployed fresh, so fixes change storage layout and ABI in place without migrations.

## Scope

Base commit `1e8cb4b780cd5fb2a1e51300c8871570d0b0810d` plus the uncommitted UUPS conversion in the working tree. Reviewed files:

- `contracts/src/MapaeGuardians.sol` (implementation behind an OpenZeppelin 5.6.1 `ERC1967Proxy`)
- `contracts/src/GuardianMetadata.sol` (linked library, on-chain `tokenURI`)
- `contracts/src/GuardianTraits.sol` (trait derivation, unchanged)
- `contracts/script/DeployGuardians.s.sol`
- `contracts/test/MapaeGuardians.t.sol`
- Consumers of the ABI: `packages/arcade/src/guardian-abi.ts`, `apps/delegated-seller/guardians/`, `apps/web/src/arcade/nft/useGuardians.ts`, `scripts/arcade-guardians-preflight.ts`

Out of scope: Pyth Entropy contracts and the provider, the OpenZeppelin libraries, the seller's result-signing policy beyond what the contract trusts.

Toolchain: solc 0.8.28 (cancun, optimizer 200 runs), forge 1.7.1, Slither 0.11.5.

## Methodology

Three independent reviews, each with its own lens, produced raw findings and Foundry proof-of-concept tests:

1. Upgrade safety: initialization, proxy and implementation separation, ERC-7201 layout, upgrade authorization, immutables, deploy script.
2. Mint, entropy and economics: Fisher-Yates draw, Pyth request and callback lifecycle, fees and ETH flow, caps.
3. Auth, signatures and metadata: ownership and signer roles, EIP-712 result claims, replay, `tokenURI` JSON, ERC-165.

The lead review deduplicated the findings and tried to refute each one against the code. Every medium and low finding was reproduced by a passing PoC before any fix. Useful PoCs became permanent regression tests in `MapaeGuardians.t.sol`, and the scratch files were deleted. Slither ran on `src/` with `lib/`, `test/` and `script/` filtered. The deploy script was dry-run against a GIWA Sepolia fork with throwaway keys and without `--broadcast`.

## Summary

| ID | Severity | Title | Status |
|---|---|---|---|
| M-01 | Medium | An Entropy or provider change blocks all minting through sequence-number collisions | Fixed |
| L-01 | Low | A birth pending at an Entropy or provider change is stranded with no recovery | Fixed |
| L-02 | Low | Upgrades can change every `tokenURI` without `BatchMetadataUpdate` | Fixed |
| L-03 | Low | Unsolicited transfers can fill a wallet to `MAX_OWNED` and block its mint | Acknowledged |
| I-01 | Info | The upgrade runbook's `forge inspect storageLayout` check is empty under ERC-7201 | Fixed |
| I-02 | Info | The EIP-712 domain depends on the name and version overrides surviving upgrades | Fixed |
| I-03 | Info | Deploy script does not assert paused state, oracle immutables or the implementation slot | Fixed |
| I-04 | Info | `initialize` emits no `MintPauseChanged(true)` | Fixed |
| I-05 | Info | The owner is fully trusted (instant upgrade, can self-issue growth through a fresh signer) | Acknowledged |
| I-06 | Info | Anyone can put their own proxy in front of the official implementation | Acknowledged |
| I-07 | Info | `GuardianMetadata` is reached by DELEGATECALL; a wrong link address runs in proxy storage | Acknowledged |
| I-08 | Info | Minters can choose their token ID (never their traits) | Acknowledged |
| I-09 | Info | `ownershipEpoch` and `actor` are signer attestations, not on-chain checks | Acknowledged |
| I-10 | Info | `ruleset` has only a lower bound | Acknowledged |
| I-11 | Info | Rotating back to a retired signer key revives its unclaimed signatures | Acknowledged |
| I-12 | Info | Scratch PoC files changed the Foundry test count | Fixed |
| G-01 | Gas | ERC721Enumerable bookkeeping dominates mint and transfer | Fixed |
| G-02 | Gas | Progress uses four slots; three of its values are derivable | Fixed |
| G-03 | Gas | `claimedResults` is a redundant fresh SSTORE per claim | Fixed |
| G-04 | Gas | Revealed request entries are never cleared | Fixed (with M-01) |
| G-05 | Gas | The EIP-712 name and version are hashed on every claim | Fixed |
| N-01 | None | Fisher-Yates draw, bounds, fee forwarding, reentrancy | No issue |
| N-02 | None | `tokenURI` JSON escaping and ERC-165 set | No issue |

Duplicate reports were merged: M-01 combines the upgrade lens's L-01 and the economics lens's M-01; L-01 combines the economics L-01 and upgrade I-02; G-01, G-02 and G-05 were each reported by two or three lenses.

## Findings

### M-01 An Entropy or provider change blocks all minting through sequence-number collisions (Medium, Fixed)

`sequenceToken` was keyed by the bare Pyth sequence number and never cleared. Sequence numbers are unique only per (Entropy contract, provider). The documented way to change either one is to upgrade to an implementation with new immutables. After that, the first new sequence equal to any historical one made `mint` revert with `InvalidEntropyRequest`. The revert also rolled back the provider's counter, so every retry got the same number. The PoC showed three consecutive reverts with the new Entropy's counter stuck at 1. The live GIWA provider reported sequence 4, so this collection would own almost all of the low range.

Fix: the map is now `requestToken`, keyed by `keccak256(abi.encode(entropy, entropyProvider, sequence))`, and the callback deletes the entry on reveal. Regression: `test_entropyChangeKeepsMintingAndRerequestRecoversStrandedBirth` mints three tokens on a fresh Entropy whose sequences restart at 1.

### L-01 A birth pending at an Entropy or provider change is stranded with no recovery (Low, Fixed)

After such an upgrade, the old pair could no longer deliver. The minter's `pendingMint` never cleared, so they could not mint again, and the token could not be transferred. No re-request or admin path existed.

Fix: `rerequestBirth(tokenId, userContribution, maxFee)`. Only the account whose `pendingMint` names the token can call it, it charges the current fee, and it works while minting is paused. It reverts with `PendingDraw` while the current pair can still deliver the existing request. That keeps the reveal unbiased: Fortuna publishes revelations and anyone can call `revealWithCallback`, so allowing a second request while the first is live would let a minter pick the better of two draws. The callback now also requires `provider == entropyProvider` and `sequence == token.sequence`. Without the provider check, a provider change on the same Entropy contract would leave the old provider's request revealable alongside the re-request. Regressions: `test_entropyChangeKeepsMintingAndRerequestRecoversStrandedBirth` and `test_providerChangeRefusesOldProviderAndAllowsOneRerequest`.

### L-02 Upgrades can change every `tokenURI` without `BatchMetadataUpdate` (Low, Fixed)

Rendered metadata (the linked library, trait tables, image base) lives in implementation code. `BatchMetadataUpdate` was declared, and ERC-4906 advertised, but nothing emitted it. Fix: `_authorizeUpgrade` emits `BatchMetadataUpdate(1, MAX_SUPPLY)` on every upgrade. A refresh after an upgrade that changed nothing costs indexers one re-read and is harmless. Regression: the upgrade test expects the event.

### L-03 Unsolicited transfers can fill a wallet to `MAX_OWNED` and block its mint (Low, Acknowledged)

Anyone holding revealed guardians can push them to a victim until the victim holds three, which blocks the victim's mint and incoming transfers until they move tokens out. The attacker gives the tokens away, and each address can mint only three in its lifetime. The receive-side cap is a deliberate product rule (three owned tokens, incoming transfers included), and this is a testnet collection, so the behaviour stays as is.

### I-01 The runbook's storage-layout check is empty under ERC-7201 (Info, Fixed)

`forge inspect MapaeGuardians storageLayout` prints nothing for namespaced storage, so the documented comparison could not detect a reordered field. Fix: `test_namespacedStorageLayoutIsPinned` pins every `GuardiansStorage` field, including the packing of `Account`, `Token` and `Growth`, to its slot inside the namespace. The release runbook now requires this test and `test_storageSlotMatchesErc7201AndPacksHotFields` to pass unchanged against any new implementation.

### I-02 The EIP-712 domain depends on the name and version overrides (Info, Fixed)

`__EIP712_init` is not called, so a future implementation that dropped the overrides would sign under an empty name and version and invalidate every outstanding signature. Fix: the name and version are single private constants shared by `_EIP712Name`, `_EIP712Version`, the precomputed hashes in `_hashTypedDataV4` (G-05), and the ERC-721 name. The upgrade test now checks `eip712Domain()` after the upgrade and claims a result signed before it. The runbook names the coupling.

### I-03 Deploy script post-deploy assertions were incomplete (Info, Fixed)

The script now also requires `mintPaused()`, no pending owner, `entropy()` and `entropyProvider()` equal to the checked constants, and the ERC-1967 implementation slot equal to the deployed implementation. The GIWA fork dry run passes them.

### I-04 `initialize` emits no `MintPauseChanged(true)` (Info, Fixed)

`initialize` now emits it after `ResultSignerChanged`, so a pause indexer built from events starts from an explicit state. Covered in the initialization test.

### I-05 The owner is fully trusted (Info, Acknowledged)

`_authorizeUpgrade` is `onlyOwner` with no timelock. The owner can replace logic and rewrite any state, or rotate the result signer to its own key and issue growth. Ownable2Step is used correctly, and `_transferOwnership` keeps the signer from becoming owner. The separation of owner and signer only means that a leaked signer key gains no admin power. The contract NatSpec no longer calls birth permanent; it says the owner can upgrade. The runbook lists the owner as fully trusted and requires moving ownership to a multisig, and optionally a timelock, before any non-testnet use.

### I-06 Anyone can put their own proxy in front of the official implementation (Info, Acknowledged)

The implementation's own storage is paused and can never be initialized. However, anyone can deploy an `ERC1967Proxy` pointing at it, initialize it and mint look-alike tokens. That proxy's EIP-712 domain, birth seeds and Pyth requester are bound to its own address, so nothing carries over to the official collection. The constructor pause is kept only as hygiene and is not counted as a security fix. The runbook says the proxy at `ARCADE_GUARDIAN_ADDRESS` is the only canonical collection.

### I-07 `GuardianMetadata` is reached by DELEGATECALL (Info, Acknowledged)

`tokenURI` calls the linked library with DELEGATECALL. Forge links it at its deterministic CREATE2 address, which is bound to the library bytecode. A manual `--libraries` link to the wrong address would run foreign code in the proxy's context. The runbook now requires confirming the linked address against the CREATE2 address of the verified library, and comparing `tokenURI` output in the fork simulation before each upgrade.

### I-08 Minters can choose their token ID (Info, Acknowledged)

The draw mixes `prevrandao`, which on an OP Stack L2 is known and stable across many blocks, with a caller-chosen contribution. A contract minter can also reject unwanted IDs in its receiver hook. Traits come only from the later Pyth reveal, so choosing the ID does not let anyone choose the traits. `test_receiverCanChooseIdButNotTraits` records this. If IDs ever carry value, the ID would have to be assigned in the callback instead.

### I-09 `ownershipEpoch` and `actor` are signer attestations (Info, Acknowledged)

The contract rejects only results whose epoch is in the future. It never compares `actor` with any owner, and anyone can relay a signature. This is intended: historical results survive transfer, and growth only increases. `claimResult` NatSpec and the plan doc now say these fields are attestations. `test_epochIsUpperBoundOnlyAndActorIsAnAttestation` records the behaviour.

### I-10 `ruleset` has only a lower bound (Info, Acknowledged)

Ruleset validity above `MIN_RULESET` belongs to the signer. This is documented in `claimResult` NatSpec. No ceiling is added, because new rulesets ship without a contract change.

### I-11 Rotating back to a retired signer key revives its unclaimed signatures (Info, Acknowledged)

Results carry no expiry. The runbook treats a retired signer key as burned. ECDSA malleability is closed: OZ 5.6.1 rejects high-s and 64-byte signatures (`test_signatureMalleabilityRejected`).

### I-12 Scratch PoC files changed the Foundry test count (Info, Fixed)

The PoCs are now regression tests in `MapaeGuardians.t.sol`, the `Audit_*.t.sol` files are deleted, and the README counts are updated (60 Foundry tests).

### G-01 ERC721Enumerable bookkeeping dominates mint and transfer (Gas, Fixed)

The collection now inherits plain `ERC721Upgradeable`. With `MAX_OWNED = 3` and IDs up to 10,000, an owner's IDs fit in 48 bits of the `Account` slot that mint already writes. `_update` maintains these lanes and enforces the receive cap. `tokensOfOwner(address)` replaces `tokenOfOwnerByIndex`, and `totalSupply()` returns the draw counter (there is no burn). The seller roster now reads `tokensOfOwner`. ERC721Enumerable (`0x780e9d63`) is no longer advertised, and `tokenByIndex` is gone. Nothing used it. Regression: `test_ownedLanesTrackEveryOwnershipChange`.

One auditor said this had to be decided before deployment because the layout freezes. That part is refuted: a later upgrade could drop Enumerable and leave its namespace orphaned. The change was still made now, because it is cheapest before any state exists.

### G-02 Progress used four slots (Gas, Fixed)

Plays, victories and experience are derivable: `plays = Σ gamePlays`, `victories = Σ gameVictories`, `experience = 10·plays + 5·victories`, which matches the old increments exactly. Storage is now `Growth { counters; bestScores }`: six 40-bit counters in one slot and three 32-bit best scores in another (`MAX_SCORE < 2^32`). `progress()` returns the same struct as before, computed in memory, so the ABI and TypeScript decoding are unchanged. Overflowing a 40-bit lane would need 2^40 signed paid results. Regressions: `test_firstClaimWritesThreeSlots` and `test_maxScoreAndCountersStayInTheirLanes`.

### G-03 `claimedResults` is redundant (Gas, Fixed)

`resultId` and `paymentTx` are both signed, so `claimedPayments` already rejects any replay of a signature. `claimedResults` only blocked a signer-issued second result reusing a `resultId` with a different payment. The seller ledger keys results by `resultId` and never signs two with the same ID. The mapping and its getter are removed. The seller and the web now check `claimedPayments(result.paymentTx)`. `resultId` stays indexed in `ResultClaimed`.

### G-04 Revealed request entries were never cleared (Gas, Fixed with M-01)

The callback deletes the request entry, which earns a storage refund in the reveal transaction. A second delivery finds no entry and reverts.

### G-05 EIP-712 name and version hashed on every claim (Gas, Fixed)

`_hashTypedDataV4` is overridden to use precomputed `NAME_HASH` and `VERSION_HASH` constants with `block.chainid` and `address(this)` (the proxy). The fixed TypeScript digest vector test (`test_fixedTypeScriptEIP712Vector`) is unchanged and still passes.

### N-01 Draw, bounds, fees and reentrancy (No issue)

Confirmed: draw slots stay in range; a zero lane decodes to `slot + 1` and never to the sentinel; the vacated last lane is never read again; IDs fit 16-bit lanes; and `drawn` stops at 10,000. `test_fullDrainIsAPermutation` mints all 10,000 IDs exactly once and rejects the 10,001st. The fee must equal the quote and stay at or below `maxFee`, and it is forwarded in full. There is no `receive` or `fallback`; `test_noEthRetained` covers this. The transient reentrancy guard blocks reentry into `mint` from the receiver hook. Pending tokens cannot move, so the callback's `_ownerOf` is always the minter. The callback uses about 57k of its 500k gas limit.

### N-02 `tokenURI` escaping and ERC-165 (No issue)

`imageBaseURI` is the only free-form string and passes through `Strings.escapeJSON` (`test_imageBaseIsEscapedInMetadata`). ERC-165 advertises ERC165, ERC721, ERC721Metadata and ERC4906 and rejects `0xffffffff`.

## Gas, before and after the fixes

Measured with each call as its own transaction (`forge test --isolate`, `vm.lastCallGas`), using the same scenario on both sides.

| Path | Before | After | Change |
|---|---|---|---|
| mint (new account) | 332,471 | 263,584 | −68,887 (−20.7%) |
| mint (returning account) | 320,971 | 229,704 | −91,267 (−28.4%) |
| claimResult (first, victory) | 188,368 | 118,545 | −69,823 (−37.1%) |
| claimResult (later) | 110,354 | 81,073 | −29,281 (−26.5%) |
| transferFrom (to a new holder) | 102,690 | 98,635 | −4,055 (−3.9%) |
| Pyth callback transaction (test double) | 75,158 | 75,858 | +700 |

The callback costs slightly more because it hashes the request key and checks the provider and the sequence. The refund from deleting the entry partly offsets that. The Pyth fee is priced on the fixed 500k callback limit, so users do not pay for this difference. Implementation runtime size: 18,547 bytes (6,029 bytes under EIP-170). `GuardianMetadata` is 7,572 bytes.

## Static analysis

Slither 0.11.5, 101 detectors, `src/` only. Remaining results, all accepted:

- `uninitialized-local`: `tokensOfOwner`'s counter `n` relies on the zero default. This is intentional.
- `unused-return`: the third return value of `ECDSA.tryRecover` (the error argument) is ignored. The error enum is checked, and the argument only adds detail.
- `assembly`: the ERC-7201 storage pointer in `_guardians()`.
- `naming-convention`: `_EIP712Name` and `_EIP712Version` are OpenZeppelin's override names.

## Residual risks and trust assumptions

- **Owner.** The owner can upgrade instantly and so controls every piece of state. It can also self-issue growth by rotating the signer. `renounceOwnership` freezes the logic for good.
- **Result signer.** The signer alone decides which results grow guardians, including `actor`, the departure epoch, ruleset validity and score, up to `MAX_SCORE`. A leaked key can forge growth until it is rotated. Claimed forged growth cannot be removed without an upgrade.
- **Pyth.** Trait randomness assumes the provider does not collude with the sequencer, which is the standard Pyth Entropy trust assumption. Liveness depends on the provider. If the keeper stalls, anyone, including the web recovery screen, can reveal with the published revelation. If the provider dies, the owner changes it by upgrade and minters call `rerequestBirth`.
- **Mint-time ID predictability.** Token IDs can be chosen (I-08). Traits cannot.
- **Sybil.** The three-per-address limits are not a sybil boundary. About 0.15 testnet ETH in Pyth fees could mint the whole supply from fresh addresses. Pausing is the only control.
- **Reporting.** `rerequestBirth` emits `BirthRerequested`, not `MintRequested`, so `scripts/arcade-guardians-report.ts` does not count a re-request as a mint (re-audit R-05).

## Deployment checklist

1. Run `make -C contracts test`, `forge fmt --check`, `forge build --sizes`, `bun run typecheck` and `bun run check`. Confirm the ABI in `packages/arcade/src/guardian-abi.ts` matches `forge inspect`.
2. Deploy with `DeployGuardians.s.sol`: the library through the CREATE2 deployer, then the implementation, then an `ERC1967Proxy` that runs `initialize` in its constructor. Initialization is atomic and cannot be front-run. The script's post-deploy checks (paused, owner, signer, oracle, implementation slot) must pass. Dry-run on a fork without `--broadcast` first.
3. Verify the library, the implementation (with `--libraries`) and the proxy on Blockscout. Confirm that the linked library address equals the CREATE2 address of the verified library bytecode.
4. Record the proxy, implementation and library addresses, the deploy hashes, the admin and the signer. Set `ARCADE_GUARDIAN_ADDRESS` to the proxy.
5. Run the single request and reveal canary from the release runbook before calling `setMintPaused(false)` for the public.
6. Before any non-testnet use, transfer ownership to a multisig (optionally behind a TimelockController) with `transferOwnership` and `acceptOwnership`, and keep the result signer on a separate key.

## Re-audit (post-fix)

After the fixes above, a second pass reviewed the unreviewed changes: the custom owned-ID index that replaced `ERC721Enumerable`, the two-slot `Progress`, the removal of `claimedResults`, the `(entropy, provider, sequence)` request keys with `rerequestBirth`, the upgrade-time `BatchMetadataUpdate`, and the precomputed EIP-712 hashes. Each finding was checked against the code before it was accepted.

| ID | Finding | Severity | Status |
|---|---|---|---|
| R-01 | Unsolicited transfers can fill a holder's three owned lanes | Low | Acknowledged (same as L-03) |
| R-02 | Growth lanes and the owned-lane removal loop have no explicit bound | Info | Fixed (loop) / Documented (lanes) |
| R-03 | `MAX_OWNED` is tied to the `uint48 owned` width | Info | Documented |
| R-04 | A superseded request is accepted if an old Entropy or provider is reinstated | Low | Fixed |
| R-05 | `rerequestBirth` emits `MintRequested`, which the report counts as a mint | Info | Fixed |
| R-06 | Entropy and upgrade paths checked with no issue found | Info | No issue |

### R-01 Unsolicited transfers can fill a holder's three owned lanes (Low, Acknowledged)

Confirmed. `_update` refuses a receive when `_freeLane(owned) == MAX_OWNED`, and `mint` needs a free lane. The behaviour is the same as at HEAD (`balanceOf(to) >= MAX_OWNED`), so the custom index did not introduce it. It is the receive-side cap already acknowledged in L-03. No change.

### R-02 Growth lanes and the owned-lane removal loop have no explicit bound (Info, Fixed / Documented)

Confirmed as hardening only. The sender-lane scan in `_update` is now `while (lane < MAX_OWNED && ...)` followed by `assert(lane < MAX_OWNED)`, so a corrupt index fails with a Panic instead of running out of gas. The `Growth` NatSpec now says a 40-bit lane carry is excluded by assumption, not checked. A carry needs 2**40 signer-attested results, each with a unique `paymentTx`.

### R-03 `MAX_OWNED` is tied to the `uint48 owned` width (Info, Documented)

Confirmed. The `Account` NatSpec now says that raising `MAX_OWNED` in an upgrade must widen `owned` to `MAX_OWNED * 16` bits. `owned` is the slot's last field, so widening it is layout-safe. Solidity has no static assertion that could enforce this at compile time. The upgrade checklist still applies: run `test_namespacedStorageLayoutIsPinned` against a V2 implementation after `upgradeToAndCall` from V1 state.

### R-04 A superseded request is accepted if an old Entropy or provider is reinstated (Low, Fixed)

Confirmed by PoC before the fix. The callback compared only `token.sequence`, and Pyth sequence counters restart on a fresh Entropy or provider. A re-requested birth (B, 2) could therefore carry the same number as the request it replaced (A, 2). After a rollback to A, `requestToken[key(A, 2)]` still named the token and the sequence matched, so the superseded draw revealed it. `rerequestBirth` was also refused, because the stale key looked live.

Fix: `Token` slot 1 now also holds `uint32 attempt` (bits 136..167 after `revealed`). `_requestBirth` increments it and stores `requestToken[key] = tokenId | attempt << 16`. The callback decodes the token ID from the low 16 bits and requires the stored attempt to equal `token.attempt`. That replaces the bare sequence comparison. The `rerequestBirth` liveness check compares the full packed value. A superseded request can never reveal the token under any reinstated pair, and a re-request is allowed exactly when the latest request cannot be delivered by the current pair. The NatSpec on `entropyCallback` and the contract header now describe this check.

Regression: `test_reinstatedOldPairCannotDeliverSupersededRequestOnSequenceCollision` turns the PoC into a permanent test. It shows A refusing the superseded (A, 2) and then allowing one re-request on A. A second re-request is refused, B's request (attempt 2) is refused after switching to B again, and the latest request on A reveals the token. `test_namespacedStorageLayoutIsPinned` now pins the attempt bits and the packed `requestToken` value. The scratch file `contracts/test/ReAudit_1.t.sol` was deleted.

### R-05 `rerequestBirth` emits `MintRequested`, which the report counts as a mint (Info, Fixed)

Confirmed. `mint` still emits `MintRequested`. `rerequestBirth` now emits the new `BirthRerequested(owner, tokenId, sequence, contribution)` event. `scripts/arcade-guardians-report.ts` counts it as a distinct collection transaction but not as a mint, and a report test covers this. The web recovery screen (`apps/web/src/arcade/nft/useGuardians.ts`) reads the contribution from either event, so it can also recover a re-requested birth. `packages/arcade/src/guardian-abi.ts` was regenerated from the Foundry artifact. The release runbook and the plan now describe the new event.

### R-06 Entropy and upgrade paths checked with no issue found (Info, No issue)

The callback authorization, the single-live-draw rule for `rerequestBirth`, fee forwarding with no ETH retained, `BatchMetadataUpdate` emitted from proxy context, the EIP-712 domain and `eip712Domain()`, the ERC-7201 slot, and the deploy script's dry run were all reviewed again. All hold. The operational limit remains: if the current provider stops revealing and the pair is unchanged, pending births wait until the owner upgrades to a new pair.

### Post-fix verification

- `make -C contracts test`: exit 0, 61 Foundry tests passed (47 `MapaeGuardiansTest`, 11 + 3 in the other suites).
- `forge fmt --check`: exit 0. `forge build --sizes`: exit 0. `MapaeGuardians` runtime is 18,877 bytes (5,699 under EIP-170). `GuardianMetadata` is 7,572 bytes.
- Slither 0.11.5, 101 detectors: 7 results, the same accepted categories as listed under Static analysis.
- `bun run typecheck`: exit 0. `bun run check`: exit 0 (1657 TypeScript tests: 1130 + 3 MCP + 489 web + 35 docs, then 61 Foundry). The README counts were updated.


## Addendum: batched result claims (2026-10-11)

The journal could record growth only one result per transaction, so a guardian with many verified outings needed one wallet confirmation and one transaction each. The implementation adds `claimResults(Result[] results, bytes[] signatures) returns (uint256 applied)` and the constant `MAX_CLAIM_BATCH = 32`. This is a pure implementation upgrade of the deployed proxy: `GuardiansStorage`, `Account`, `Token` and `Growth` are unchanged, and the EIP-712 domain, `RESULT_TYPEHASH` and every existing signature stay valid.

### Semantics

- `claimResult` and `claimResults` share one private `_claim`. Each entry gets exactly the single-claim checks: the token exists and is revealed, every field is valid (nonzero IDs and actor, epoch between 1 and the current epoch, game, ruleset floor, score cap, traits hash), and the signature recovers to the current result signer.
- Any entry that fails a check reverts the whole batch with the single-claim error (`ERC721NonexistentToken`, `PendingDraw`, `InvalidResult`, `InvalidResultSignature`).
- An entry whose `paymentTx` is already claimed, either before the transaction or earlier in the same batch, is skipped. The skip happens only after that entry's own fields and signature have verified, so a forged or tampered entry can never hide behind a claimed payment.
- The batch reverts with `AlreadyClaimed` when nothing was applied, the same as a repeated single claim, so a relayer is never charged for a no-op that looks successful.
- An empty batch, more than 32 entries, or a signature count that differs from the result count reverts with `InvalidBatch`.
- Each applied result emits `ResultClaimed` and `MetadataUpdate`, exactly as a single claim does. Skipped entries emit nothing.
- `claimResult` keeps its ABI and behaviour. It now verifies the signature before checking the payment, so a repeated claim with a bad signature reports `InvalidResultSignature` instead of `AlreadyClaimed`. Nothing else is observable.

### Why skip claimed payments instead of reverting

The journal, another tab or a relayer can claim the same result while a batch is pending. With all-or-nothing replay protection, one such race would revert a 32-result batch and waste its gas. Replay protection is unchanged: a payment still grows a guardian at most once. Skipping keeps the batch useful, and full verification before the skip keeps invalid input loud.

### Threat analysis

| Concern | Result |
|---|---|
| Replay within a batch | `claimedPayments` is written before the next entry runs, so a repeated `paymentTx` in the same batch is skipped. Covered by `test_claimResultsSkipsAlreadyClaimedAndInBatchDuplicates`. |
| Hidden invalid entries | A claimed payment is skipped only after its signature and fields verify. Covered by `test_claimResultsRevertsWholeBatchOnAnyInvalidEntry`, which pairs a claimed payment with a forged signature. |
| Partial application | Any failure reverts the entire transaction. The same test asserts that no `paymentTx` is marked after each failing call and that the fixed batch then applies in full. |
| Gas griefing and block limits | The cap of 32 bounds a batch at about 1.4M gas (`test_claimResultsBoundsBatchSize` asserts under 2M), far below the GIWA block gas limit. The caller pays for its own batch, and nobody else's claims are blocked. |
| Mixed tokens and owners | Entries may name different tokens. Each is checked against its own token and epoch, and historical results stay valid after a transfer, as with single claims (I-09). |
| Reentrancy | `claimResults` is `nonReentrant`, and `_claim` makes no external calls. Only the `ecrecover` precompile is called. |
| Mint pause | Claims were never gated by `mintPaused`, and batches are not either. Pausing stops new draws, not growth from paid results. |
| Signer rotation | Each entry must carry a signature from the current signer, including entries that would be skipped. After a rotation, clients fetch reissued signatures as they already do for single claims (I-11 is unchanged). |
| Storage layout | No field was added, removed or reordered. `test_namespacedStorageLayoutIsPinned` and `test_storageSlotMatchesErc7201AndPacksHotFields` pass unchanged. `test_upgradeToBatchClaimImplementationPreservesState` claims a result singly, transfers the token, upgrades the proxy to a new implementation and checks owner, signer, pause, ownership epoch, traits, `tokenURI` and `claimedPayments`. It then batches the pre-upgrade signatures and gets 2 applied and 1 skipped. |

### Gas

`test_gasClaimResultsVersusSingleClaims` counts whole-transaction gas: 21,000 base, plus EIP-2028 calldata, plus execution with the proxy's storage cooled before each transaction (`vm.cool`). Both sides start from the same state and use one guardian.

| Results | N single claims | One batch | Change |
|---|---|---|---|
| 1 | 116,831 | 118,185 | +1,354 (+1.2%) |
| 8 | 694,900 | 399,818 | −295,082 (−42.5%) |
| 32 | 2,681,648 | 1,373,926 | −1,307,722 (−48.8%) |

The batch saves the per-transaction base cost and cold storage access for every entry after the first. The growth slots, the token slot and the signer slot stay warm. Per-entry cost at the cap is about 43k gas.

`MapaeGuardians` runtime is now 19,507 bytes (5,069 under EIP-170). Slither 0.11.5 (101 detectors, `src/MapaeGuardians.sol`) reports the same accepted categories as before and nothing new.

### Verification

- `make -C contracts test`: 68 Foundry tests passed (54 `MapaeGuardiansTest`, including 7 new batch and upgrade tests, plus 11 + 3 in the other suites).
- `forge fmt --check`: exit 0.
- `packages/arcade/src/guardian-abi.ts` was regenerated from the Foundry artifact. The only additions are `claimResults`, `MAX_CLAIM_BATCH` and the `InvalidBatch` error.

## Addendum: guardian honors (2026-10-12)

Weekly ranking titles (장원 #1, 급제 #2–3, 입격 #4–10 per game) and attendance were computed off-chain on every read and never reached the NFT. This change records them in `tokenURI`. It ships in the same pending upgrade as the batch claim above, and that upgrade has not been applied yet, so the batch ABI never went live. `claimResult` and `claimResults` are therefore removed outright. The single entry point is now:

```solidity
function claim(Result[] results, bytes[] resultSignatures, Honor[] honors, bytes[] honorSignatures)
    returns (uint256 applied)
struct Honor { uint256 tokenId; uint16 week; uint16 longestStreak; uint144 titles; }
// HONOR_TYPEHASH = keccak256("Honor(uint256 tokenId,uint16 week,uint16 longestStreak,uint144 titles)")
```

`InvalidResultSignature` is renamed `InvalidSignature` because results and honors share it. `GuardianMetadata` changes too, so the upgrade also needs a new library deployment.

### Semantics

- **Storage.** One new `mapping(uint256 => uint256) honors` is appended to `GuardiansStorage` (namespace slot base+8). Each token's word has 16-bit lanes:
  - lane 0: the week of the latest applied honor (0 = none);
  - lane 1: the longest attendance streak in days;
  - lane `2 + game * 3 + tier`: weekly titles won.

  Lanes 11–15 stay zero. `Honor.titles` holds lanes 2–10 shifted down by 32 bits.
- **Week index.** `(daysSinceEpoch(Monday) - 4) / 7`. Week 0 starts Monday 1970‑01‑05, and week 2961 is 2026‑10‑05 to 10‑11 KST. A `uint16` lasts until about the year 3226.
- **Cumulative honors.** The signer attests one honor per token: the totals as of the latest sealed week. The newest honor covers every older one, so skipped or out-of-order weeks lose nothing, and the stored week doubles as the replay guard. No per-week claimed map is needed.
- **Lane maximum.** An honor is applied only when its week is newer than the stored one. The contract then keeps the lane-wise maximum of the stored and incoming values. Title counts and the longest streak never shrink, so a correct honor is never below the stored value, and a wrong one can never lower anything.
- **Seal.** The contract refuses week 0 and any week before `(week * 7 + 11) days - 9 hours + HONOR_GRACE`, which is Tuesday 00:00 KST after the week closes (`HONOR_GRACE = 1 days`). A signer bug can therefore never attest an open week. Week 2961 seals at unix 1791817200.
- **Milestones.** These are not stored. `GuardianMetadata` derives the highest of 3/7/14/30/100 reached from the longest streak, mirroring `STREAK_MILESTONES`. The 28-day devotion rank is left out because it is a rolling rank that can fall, so there is no final value to attest.
- **Checks per honor, in order.**
  1. The token exists and is revealed (`ERC721NonexistentToken`, `PendingDraw`).
  2. The week is sealed (`InvalidHonor`).
  3. The signature recovers to the current result signer (`InvalidSignature`).
  4. A week not newer than the stored one is skipped. As with claimed results, the skip happens only after the checks above pass.
- **Ownership.** Honors carry no ownership epoch. They belong to the token and survive transfer.
- **Claim order and limits.**
  - `claim` applies all results first, then all honors.
  - `MAX_CLAIM_BATCH = 32` counts both kinds together.
  - An empty claim, more than 32 entries, or a signature list whose length differs from its entries reverts `InvalidBatch`.
  - Any invalid entry reverts the whole call.
  - The call reverts `AlreadyClaimed` when nothing was applied.
- **Events.** An applied honor emits `HonorRecorded(tokenId, week)` and `MetadataUpdate(tokenId)`.
- **`progress()`.** The return value gains `honorWeek`, `longestStreak`, `champion[3]`, `podium[3]` and `top10[3]`, so clients read honors without an extra call.
- **`tokenURI`.** For revealed tokens, each game gets `"<Game> champion titles"`, `"<Game> podium titles"` and `"<Game> top 10 titles"` after its best score. These are followed by `"Longest streak"` and `"Streak milestone"`. That makes 11 new attributes, all at zero until an honor is recorded.

### Threat analysis

| Concern | Result |
|---|---|
| Replay | The stored week is the guard. Replaying an honor, or another honor of the same or an older week, is skipped, and the call reverts `AlreadyClaimed` when it applies nothing else. Covered by `test_honorStaleSameWeekSkippedAndAloneReverts`. |
| Out of order | An older week after a newer one is a no-op. A newer honor with one lower lane keeps the stored maximum and still raises the other lanes. Covered by `test_honorOutOfOrderKeepsLaneMaxima`. |
| Open week or grace period | The contract checks the seal itself, from week 0, one second before the seal, at the seal and for the next open week. Covered by `test_honorRejectsZeroOpenAndGraceWeeks`. |
| Signer bug | A wrong honor can only raise lanes, never lower them, and it cannot name an open week. The signer is already trusted for results (I-09), and the owner can rotate it. |
| Permissionless griefing | Anyone may relay a signed honor, as with results. The worst a front-runner can do is record a true value early. The owner's own call then skips that honor and still applies its results; it reverts only if nothing else was applied. Covered by `test_honorIsPermissionlessAndSurvivesTransfer`. |
| Tampering and malleability | Every field is bound by the digest. Wrong signers, malformed signatures, high-s twins and EIP-2098 compact signatures are refused. Result and honor typehashes differ, so neither signature verifies as the other. Covered by `test_honorForgedTamperedWrongSignerRejected`. |
| Signer rotation | Outstanding honor signatures stop verifying, as for results (I-11 applies unchanged). |
| Ruleset bump during grace | This is enforced off-chain. The seller freezes a closed week's board at its seal (`created_at <` cutoff), and it uses the ruleset that week was played under. A deploy that bumps the ruleset during the grace day therefore cannot rewrite last week's titles. |
| Reentrancy | `claim` is `nonReentrant`. `_honor` makes no external calls. |

### Storage layout and upgrade

The only layout change is the appended `honors` mapping. The pinned layout test keeps every earlier assertion and adds one: after an honor, `keccak256(abi.encode(id, base + 8))` holds exactly `week | streak << 16 | lane L << (32 + 16L)`.

`test_firstHonorWritesOneSlot` confirms that a first honor writes a single slot. `test_upgradeToHonorsImplementationPreservesState` upgrades a proxy that already holds a claimed result and a transferred token. It checks that every piece of state and `tokenURI` are unchanged, that the honors slot reads zero, and that results signed before the upgrade claim afterwards in the same call as a first honor (3 applied).

That test upgrades to the same source. The live implementation predates the batch claim. Its `GuardiansStorage` is the first eight fields unchanged and never writes the base+8 mapping, so the two upgrades are equivalent for layout.

### Gas and size

Gas is measured by `test_gasBatchedClaimVersusSingleClaims` and counts the whole transaction: 21,000 base, EIP-2028 calldata, and cold-storage execution.

| Results | N one-result `claim`s | One `claim` | One `claim` plus a first honor |
|---|---|---|---|
| 1 | 119,521 | 119,524 | 156,139 |
| 8 | 716,725 | 401,627 | 438,409 |
| 31 | 2,687,508 | 1,338,942 | 1,377,103 |

A first honor adds about 37k gas, most of it the zero-to-nonzero write of its slot. A full claim of 31 results and one honor stays under 1.4M gas. `test_claimBoundsCombinedBatch` asserts under 2M.

| Contract | Runtime before | Runtime after |
|---|---|---|
| `MapaeGuardians` | 19,507 B | 21,002 B (3,574 under EIP-170) |
| `GuardianMetadata` | 7,572 B | 8,496 B |

Slither 0.11.5 (101 detectors, `src/MapaeGuardians.sol`) adds one result: `timestamp` on the seal check. It is accepted, because the bound is a day wide and validator drift cannot move a week across it.

### Verification

- `make -C contracts test`: 78 Foundry tests passed (64 `MapaeGuardiansTest`, plus 11 + 3 in the other suites). The new tests are:
  - `test_claimRecordsHonorAndRendersAttributes`, which covers all 11 attributes and the milestones at streaks of 2, 3, 6, 7, 13, 14, 29, 99 and 100;
  - the five honor tests named in the threat table;
  - `test_honorRequiresRevealedExistingToken`;
  - `test_claimMixedBatchAppliesResultsThenHonors`;
  - `test_claimBoundsCombinedBatch`;
  - `test_firstHonorWritesOneSlot`;
  - `test_fixedTypeScriptHonorVector`.

  The batch tests now run through `claim`.
- `test_fixedTypeScriptHonorVector` pins this vector (cross-checked with viem `hashTypedData`):
  - Domain: "Mapae Guardians", "1", chain 91342, verifying contract `0x1111…1111`.
  - Honor: `{tokenId: 1, week: 2961, longestStreak: 7, titles: 0x500000004000000030000000200000001}`, which is lanes `[1,0,2,0,3,0,4,0,5]`.
  - Digest: `0x001abf80aceaef48a8dde8319e0edab78ddb0a02f99e6dd7b3933d374e6d568c`.
- `forge fmt --check`: exit 0.
- `packages/arcade/src/guardian-abi.ts` was regenerated from the Foundry artifact.
  - Removed: `claimResult`, `claimResults` and `InvalidResultSignature`.
  - Added: `claim`, `honorDigest`, `HONOR_TYPEHASH`, `HONOR_GRACE`, `HonorRecorded`, `InvalidHonor`, `InvalidSignature` and the new `progress` fields.
