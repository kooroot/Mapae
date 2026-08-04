<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->

# 5. Verified on-chain environment

| Item | Value |
|---|---|
| Network | GIWA Sepolia (`eip155:91342`) |
| RPC | `https://sepolia-rpc.giwa.io` |
| MockUSDC | `0xcfeb694719A09caeb80798e2011298F29CDa4e92` |
| EIP-712 domain | name `Mock USDC` / version `2` / decimals `6` |
| EntryPoint | canonical v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Delegation Framework v1.3 | **Deployed and verified on GIWA** — DelegationManager `0xF2F782Fa…F40C` (active, owner=admin, unpaused), 38-unit exact composition |
| Owner smart account (payer) | `0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382` (HybridDeleGator, owner EOA `0x011234B8…B901`) |
| ERC20PeriodTransferEnforcer | `0x700330288f6f094780121ea54cd2eDEfe45b3625` |
| First sponsored onboarding account | `0x15286FE9A48d52504607bEaaa021B29194353301` (a pre-deployment signature returned `0x1626ba7e` from live ERC-1271, mUSDC balance 3.0) |

This table holds only entries verified by reading them directly, address in
hand. Dojang appears in the roadmap, but this repository has never verified its
addresses, so it is not included here — what is verified and what is planned do
not share a table.
