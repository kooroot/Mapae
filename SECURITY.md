# Security policy

Mapae runs on GIWA Sepolia only. Every balance it moves is testnet tUSDC, and the
facilitator, bootstrap sponsor and revocation sponsor spend testnet ETH from
daily-capped wallets. There is no real money in the system today, and no bug bounty.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
**Security → Report a vulnerability** on <https://github.com/kooroot/Mapae>.
It reaches the maintainer directly and keeps the report out of the public issue
tracker until a fix ships. Please do not open a public issue for anything that
could be exploited against the hosted services.

What helps: the endpoint or page, the request that triggers it, and what an
attacker gains. What is in scope: everything in this repository, the hosted
services on `facilitator.mapae.io` and `seller.mapae.io`, and the Studio on
`app.mapae.io`. Out of scope: GIWA Sepolia itself, the MetaMask Delegation
Framework contracts (report those upstream), and denial of service that only
burns the daily testnet budgets — those caps exist precisely so that an attack
ends at midnight UTC.

## What to expect

Reports are acknowledged within a week. Fixes land on `main` with a commit body
that says what was wrong and why the fix is the fix; the private report is
credited there if you want it to be.

## Where the design lives

- Threat model and key custody: `docs/tech-notes.en.md`, `docs/infra-map.md`
- Rate limits, daily budgets and body caps: the README of each service under `apps/`
- Content Security Policy for the Studio: `apps/web/src/lib/security.ts`
