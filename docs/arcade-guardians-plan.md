# Arcade Guardians delivery contract

GIWA Sepolia (91342). This document describes the implementation and release gates; it is not a claim that contracts or services have been deployed.

## Product and milestones

1. Enter a real arcade game without a wallet. Trial records stay in the tab and never award verified NFT growth.
2. Connect and sign in when ready to draw a guardian. Pyth Entropy V2 fixes its immutable appearance, temperament and aptitudes. A pending draw survives reload and cannot be cancelled for a new result.
3. Operate up to three owned guardians. Set each guardian's objective, game and bounded test-token allowance. Mapae's existing delegated payments buy each admission; NFT custody never carries another owner's spending authority.
4. Review deterministic server game results, game-specific achievements and earned experience. Submit signed results to put growth onchain. A failed claim does not buy another admission.
5. Return for the daily scenario and operate a different strategy. Report foreground browser activity, authenticated operators, autonomous admissions and distinct chain transactions separately.

Deliver in separate verified commits: existing asset integration; this protocol; guest entry and measurement; contracts and shared traits; authoritative seller results; aptitude mechanics; NFT roster/mint/claim interface; release tooling and end-to-end verification. Each layer must compile and have appropriate tests before its commit. Final integration includes actual browsers and a real GIWA request/reveal canary before live mint enablement.

## Birth and collection

Use official `@pythnetwork/entropy-sdk-solidity` 2.2.1 with Entropy proxy `0x0708325268dF9F66270F1401206434524814508b` and provider `0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344`. Confirm registration, fee and liveness again at release. The official registry and provider config agree on this chain; no successful live callback has yet been established by this project.

Collection: ERC721 with `tokensOfOwner(address)` (at most three IDs, packed into the owner's account slot) and `totalSupply()` instead of ERC721Enumerable, ERC-4906 metadata updates, initial test collection supply limit 10,000, lifetime mint entitlement three per address and maximum three owned tokens (incoming transfers included). One pending draw per owner. These are test product limits, not a uniqueness or anti-Sybil guarantee. Appearance duplicates are allowed; token IDs identify distinct guardians. No burn, reroll, mutable birth traits or administrator-selected random seed.

Deployment: an OpenZeppelin v5.6.1 UUPS `ERC1967Proxy` in front of the `MapaeGuardians` implementation, with token metadata rendered by the linked `GuardianMetadata` library. The proxy address is the collection everywhere (apps, EIP-712 `verifyingContract`, birth seed, Pyth requester). All state lives in the ERC-7201 namespace `mapae.storage.MapaeGuardians`; the Entropy contract and provider are implementation immutables. Only the owner (two-step `Ownable2Step`) can upgrade. An upgrade can change code paths, so it is an administrator power over future rules; birth seeds already revealed are stored state and are not recomputed by an upgrade. Every upgrade emits `BatchMetadataUpdate(1, 10000)`. Requests are keyed by (Entropy, provider, sequence); a birth left pending by an Entropy or provider change is re-requested once by its minter through `rerequestBirth`, which is refused while the current pair can still deliver the original request.

`mint(bytes32 userContribution,uint256 maxFee)` requires the exact current provider fee in `msg.value`; contribution is browser CSPRNG. Reserve/mint the pending token before any result is known; transfer is locked until reveal. Entropy callback authenticates sender and provider, and accepts only the token's latest request (each request records the token's attempt number), stores a seed once and emits metadata changes, without external receiver calls. Recovery always uses the token's latest Entropy request: the mint's `MintRequested`, or the `BirthRerequested` of a re-request after an oracle change.

The stored birth seed is `keccak256(abi.encode(randomNumber, tokenId, block.chainid, address(this), uint32(1)))`. Traits version is 1. For each trait index below, compute `uint256(keccak256(abi.encodePacked(seed, uint8(index)))) % list.length`. The tiny modulo bias is acceptable for cosmetic test traits; no monetary rarity claim is made.

| Index | Ordered values |
| --- | --- |
| 0 zodiac | rat, ox, tiger, rabbit, dragon, snake, horse, goat, monkey, rooster, dog, pig |
| 1 hat | none, topknot, gat, satgat, samo, ikseongwan, jeonrip, paeraengi, headwrap |
| 2 outfit | gonryongpo, minister, official, military, scholar, artisan, hemp, performer |
| 3 shoes | jipsin, namaksin, taesahye, heukhwa, beoseon |
| 4 backdrop | dawn, moon, jade, ember |
| 5 charm | mapae, scroll, pouch, none |
| 6 color | red, jade, ink |
| 7 temperament | curious, bold, calm |
| 8 aptitudes (stamp,race,shop) | (4,5,6), (4,6,5), (5,4,6), (5,6,4), (6,4,5), (6,5,4) |

Every guardian has aptitude total 15. User-selected objective is separate from immutable birth. `traitsHash = keccak256(abi.encode(seed))`. `birth(tokenId)` returns `(bytes32 seed,uint64 sequence,bool revealed)`. `ownershipEpoch(tokenId)` starts at 1 and increases on every transfer. `pendingMint(owner)`, `mintedBy(owner)`, `mintFee()` and owner enumeration support recoverable onboarding.

## Verified growth contract

EIP-712 domain `{name: "Mapae Guardians", version: "1", chainId: 91342, verifyingContract: collection}`. Primary type `Result`, fields in exact order:

```
bytes32 resultId
uint256 tokenId
address actor
uint64 ownershipEpoch
bytes32 paymentTx
bytes32 traitsHash
bytes32 inputsHash
uint32 ruleset
uint32 seed
uint8 game
uint32 score
bool victory
```

`game` indexes stamp=0, race=1, shop=2. Current ruleset is bumped when aptitude mechanics ship. `inputsHash` commits to canonical server inputs, including objective and starting shop memory. Contract checks immutable traits hash, nonzero IDs/actor, epoch between 1 and current epoch, valid game/ruleset/bounded score and the dedicated result signer. The payment transaction is permanently replay protected on-chain (one growth per payment); result IDs are unique in the seller ledger and indexed through `ResultClaimed`. `actor`, the departure epoch, ruleset validity above the minimum, `seed` and `inputsHash` are signer attestations that the contract does not check further. `claim(Result[],bytes[],Honor[],bytes[])` is permissionless: submission cannot change any entry's token or payload. No claim deadline strands an earned result. A signer rotation invalidates old unclaimed signatures; server can reissue the same canonical result under the new signer, with replay guards unchanged.

Historical valid results remain claimable after transfer: actor/epoch document the original departure and the server attests it. Claim does not require current owner==actor. Growth attaches to the token, while payment history remains with its actor. Server checks owner and epoch before every new payment; already submitted work reconciles once. This check is not atomic with an independent payment transaction, so a transfer during dispatch may allow that already bounded payment to finish.

An unresolved earlier epoch must not block the new owner indefinitely. One operation per current token epoch is allowed; earlier operations are stopped for new admissions while their exact submitted payment remains privately recoverable. A delayed older chain snapshot cannot replace a newer operation. Stopping recovery reserves at most its one outstanding admission, separately from the three current operation slots; the overall 256 active/recovery job bound still applies.

Progress stores total plays, victories, experience (10 per completed admission, plus 5 for a victory), and per-game plays, victories and best score. Level is `1 + experience / 100`. Stamp victory means chief defeated; race victory means first in the completed three-race season; shop victory means a profitable completed shop session. These are game achievements, not financial returns. Results contain typed achievement fields, never interpreted translated labels.

## Server and client boundary

Shared `@mapae/arcade/guardians` owns trait mapping and typed result DTO. `@mapae/arcade/guardian-abi` owns the Solidity ABI. Seller verifies chain ownership/birth and builds the simulation profile. An outing request accepts `{id, tokenId, goal, locale, choice, admissions, permissionContext}`; no client temperament, aptitude, score or starting shop memory. Persist a birth/owner/epoch/ruleset snapshot with the job. UI character ID is `nft-${tokenId}`, solely a presentation key.

Permanent SQLite result rows and job advancement commit together; globally unique payment transaction/result ID/admission prevent double growth. Store canonical receipt block hash/number and wait for a safe/finalized canonical payment before signing. Resolve uncertain payments using the original durable header. Server results remain queryable after browser profile/history truncation. A dedicated unfunded result key signs attestations; the payment-session key stays separate. Users submit growth claims, so no new funded automatic relayer is required.

Authenticated profile routes proxy only the fixed private seller: owned roster, token results and exact result claim. Owner comes from SIWE session. Current owner may view public token gameplay; original actor retains private payment recovery. Profile edits, guest scores, analytics, and mint previews never authorize growth.

## Measurement and release

First-party bounded D1 events measure deliberate guest interaction and authenticated foreground operation. Polling and autonomous runs never count as human return visits. Raw event IDs are idempotent, bodies allowlisted, storage/rates/retention bounded. D1/D7 uses Asia/Seoul calendar days, exact return day and mature cohort denominators. Report browser identity limitations and distinct wallets, not inferred people. Chain transaction counts deduplicate `(chainId, hash)` and distinguish mint/payment/growth; test-token volume is not revenue.

The post-launch pilot is 30 recruited users over two weeks. Implementation provides the funnel and report; fixtures and canary wallets are not adoption evidence. No outreach is sent without instruction.

Release requires contract adversarial tests, shared trait vectors, recovery/transfer/idempotency integration tests, all three deterministic engines, real guest and authenticated browsers, repository checks, reviewed staged commits and separate deployment receipts for collection, seller and both Workers. Drain old mutable-character outings before switching rulesets; never backfill untrusted profile scores. Unknown credentials, provider failures or unavailable funding remain explicit incomplete live gates. Back up the seller ledger before runtime changes and preserve the unrelated dirty delegation-framework submodule.

The user explicitly owns Mac mini deployment and the real GIWA request/reveal check after pulling this implementation. Local delivery finishes with verified commits, a pushed revision and the [release runbook](arcade-guardians-release.md); it must report actual deployment and canary as not executed by the implementation session.

Sources checked 2026-10-10: [Pyth registry](https://github.com/pyth-network/pyth-crosschain/blob/709e742bfbc6025b1c7b36aa78ecd912cf372c2b/contract_manager/src/store/contracts/EvmEntropyContracts.json), [Entropy protocol](https://docs.pyth.network/entropy/protocol-design), [GIWA GASOK](https://giwa.io/gasok). The supplied GASOK slide specifies category-dependent KPIs; it does not guarantee selection based on transaction count.
