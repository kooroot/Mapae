<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->

# 1. System architecture

| Component | Role | Runtime |
|---|---|---|
| `contracts/` | MockUSDC (EIP-3009) | Solidity 0.8.28 / Foundry |
| `facilitator/` | x402 payment verification and settlement broadcast | x402-rs (Rust, operated as a container) |
| `packages/shared` | Chain, token, x402 types, error model | TypeScript |
| `packages/delegation` | Framework environment, caveats, signing, re-delegation, revocation, ERC-7710 | Smart Accounts Kit 1.7 |
| `apps/facilitator-erc7710` | ERC-7710 verify/settle adapter | Bun + viem |
| `apps/delegated-agent` | Builds a payment-specific leaf from a parent delegation | Bun |
| `apps/delegated-seller` | ERC-7710 hosted shop — shop manifests, paywalled tickets, the orders ledger | Bun + Hono |
| `apps/agent-mcp` | Exposes the payment loop as an MCP tool | Bun + MCP SDK (stdio) |
| `apps/revocation-submitter` | Receives an owner-signed revocation UserOp → `handleOps` — two modes: pinned (single payer, loopback) / sponsored (public, sponsor-funded deposit) | Bun + Hono |
| `apps/account-bootstrap` | Recovers the owner from a pre-deployment signature → sponsored CREATE2 deploy of the payer account + mUSDC mint | Bun + Hono |
| `apps/delegation-lab` | Deployment previews, negative-path and e2e suites, fork orchestration | Bun |
| `apps/web` | Public landing + Studio (sponsored onboarding; grant, inspect, and revoke a delegation) | TanStack Start + Cloudflare |

**Language rationale** — The delegation layer depends on MetaMask Smart
Accounts Kit (formerly Delegation Toolkit), the ERC-7710/7715 TS SDK, which is
TypeScript-only, so the application layer is TS. The on-chain Delegation
Framework contracts are a separate artifact from that SDK, deployed on GIWA.
The facilitator's position is to **operate** the x402-rs container rather than
implement its own.
