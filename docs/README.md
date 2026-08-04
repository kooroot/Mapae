# Mapae — 마패

> The Mapae was not a token of privilege but a token of limits.
> The engraved horse count was not the authority granted — it was where that authority ended.

[한국어판 →](README.ko.md)

**Give an AI agent an on-chain limit, not a wallet.** Mapae is agentic payment
infrastructure on GIWA Chain that lets an agent pay by itself only within the
limit delegated to it. The owner keeps the funds in a smart account and signs
over a single permission engraved with amount, period, recipient, and expiry.
What the agent's session key can do extends exactly to the point where that
permission ends. You can start before the account even exists — sign first,
and a sponsor deploys the account on your behalf; the user holds no ETH at
any step.

## Three claims

1. **The limit is not a promise in code but a fact enforced by deployed contracts.**
   The period cap, expiry, and pinned recipient are judged by on-chain caveat
   enforcers, not by backend checks. Swap out the entire backend and the limit
   stays.
2. **The payer never touches gas.** The payer smart account's ETH balance is 0
   by design, and transactions are broadcast by the facilitator's relayer. Even
   a fully compromised relayer cannot steal funds, redirect the payment, or
   exceed the cap — [4. Security Considerations](tech/en/04-security.md) proves
   that boundary case by case.
3. **A refusal is evidence too.** An over-cap payment and an expired permission
   are refused before settlement, and the reason is recorded verbatim as the
   revert string the enforcer returned.

## Evidence — GIWA Sepolia

`Mined` is a transaction that entered a block and opens in the explorer;
`Simulation` is an `eth_call` against GIWA's current state. A refusal having no
hash is not a gap but the design — the facilitator screens it out first by
simulation, so no gas is spent on a transaction that would revert anyway.

| Path | Result | Evidence level | Evidence |
|---|---|---|---|
| Delegated payment 1 mUSDC | Settled, payer gas 0 | Mined | [`0xe897fe55…a97d`](https://sepolia-explorer.giwa.io/tx/0xe897fe55048b91c0f6728d0af313e30db2b425af8955ee89f7174a16c6aaa97d) |
| Delegated payment 2.5 mUSDC | Settled | Mined | [`0x71d71442…6ce4`](https://sepolia-explorer.giwa.io/tx/0x71d7144213a04ae7b463f1c0e2b021c672938f10c7d92d5d4fe367e532f46ce4) |
| One MCP tool call — no human in the loop | Settled, payer gas 0 | Mined | [`0x533c5cb2…964c`](https://sepolia-explorer.giwa.io/tx/0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c) |
| Payment exceeding the period cap | Refused, funds untouched | Simulation | `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` |
| Payment with an expired permission | Refused | Simulation | `TimestampEnforcer:expired-delegation` |
| Sponsored onboarding — account deployed from a pre-deployment signature | Deployed, new user gas 0 | Mined | [`0xed21ac71…9902`](https://sepolia-explorer.giwa.io/tx/0xed21ac71881cc587cc742862fea9ce16e5d2a09370a3516118884c66e1599902) |
| Sponsored onboarding — mUSDC float | 3 mUSDC minted | Mined | [`0x9d14588b…baa0`](https://sepolia-explorer.giwa.io/tx/0x9d14588b8bc3e72851b320036696493f668a7675f664b5b812737540a373baa0) |

The full evidence table and sequences are in
[2. Payment Flows](tech/en/02-payment-flows.md); the list of deployed and
verified contracts is in [Deployed Contracts (Korean)](deployed-contracts.md).

## Verify it yourself

The numbers in this document can be reproduced directly with the commands below.

```bash
bun run check                # 키·네트워크 없이 전 계층 회귀 + 문서 게이트
cd apps/delegation-lab
bun run test:negative        # 일회용 체인에 프레임워크를 직접 배포해 거절 케이스를 실행
```

`test:negative` needs no keys, no network, and no separate deployment
artifacts — it runs from a clean clone with nothing but Bun and Foundry. The
suite counts and prints the number of cases itself.

To wire it straight into an agent, follow the
[MCP Connection Guide (Korean)](mcp-guide.md).
To create an account of your own, [app.mapae.io](https://app.mapae.io) is the
shortest path — one signature and a sponsor deploys the account.

## Reading order

| Chapter | Contents |
|---|---|
| [1. System Architecture](tech/en/01-architecture.md) | Components and the rationale behind the language choices |
| [2. Payment Flows](tech/en/02-payment-flows.md) | Direct payment, delegated payment, MCP automation, Studio and revocation — with the evidence table |
| [3. Error Model](tech/en/03-error-model.md) | Failure classification and the reason-return policy |
| [4. Security Considerations](tech/en/04-security.md) | The facilitator trust boundary — an upper bound on the worst-case damage under compromise |
| [5. Verified On-chain Environment](tech/en/05-onchain-environment.md) | A table holding only addresses read and verified directly |
| [6. Verification Status and Roadmap](tech/en/06-roadmap.md) | Current state by verification level and the plan ahead |

Public documentation: [gitbook.mapae.io](https://gitbook.mapae.io) ·
Repository: [github.com/kooroot/Mapae](https://github.com/kooroot/Mapae) ·
Original single-file source: [tech-notes.md](https://github.com/kooroot/Mapae/blob/main/docs/tech-notes.md)
