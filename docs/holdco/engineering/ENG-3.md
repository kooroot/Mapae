# ENG-3 — DAP report script

`scripts/dap-report.ts` turns an exported facilitator database into daily activated payers per
Korean day, using `countDailyActivatedPayers` (ENG-2) for every counting and exclusion rule.
The header of the script is the reference: data source, payer → owner EOA mapping, funding
facts and the exact live-run command.

## Operator run

```
bun scripts/ops/backup.ts backup /absolute/facilitator.sqlite /backup/fac.enc /private/key
bun scripts/ops/backup.ts restore /backup/fac.enc /tmp/facilitator-export.sqlite /private/key
bun scripts/dap-report.ts /tmp/facilitator-export.sqlite [--seller /tmp/seller-export.sqlite] \
  --chain --public-funders 0xFAUCET --operators 0xOP1,0xOP2 --from 2026-10-01
```

`--funding FILE` replaces `--chain` when the owner map and funding facts are prepared by hand
(`{"owners": {payer: owner}, "funding": [{owner, firstFunder, firstTxAt}], "publicFunders": []}`).

## Output

JSON: `rows[{day, raw, excluded, dap, arcadeDap, agentDap, excludedPayers[{owner, reasons}]}]`,
plus `payers[{payer, owner, ownerResolved}]`, `unresolvedOwners`, `fundingFacts`, `settledPayments`
and, with `--seller`, `seller.settledWithoutOrder`.

## Limits

- Owner via `owner()` on the HybridDeleGator payer; failure keeps owner = payer, `ownerResolved:false`.
- Funding via the explorer's txlist (oldest incoming transfer with value). Internal transfers are not seen.
- Without `--public-funders`, faucet-funded owners read as one shared funder and are excluded.
- `--chain` and the explorer were not exercised live (sessions cannot reach the hosts); tests use a fake client.
