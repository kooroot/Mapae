# ENG-9 — Browser-key wallet ("설치 없이 바로 놀기 / Play without installing")

RES-3 option F, implemented in `apps/web` only. A visitor whose browser has no injected wallet can create a key on the device and use it as the owner wallet for sign-in, the sponsored delegation and minting on GIWA Sepolia (91342).

## What changed

| File | Change |
|---|---|
| `apps/web/src/lib/browser-key-connector.ts` | `browserKey()` wagmi connector (`createConnector`, id `browser-key`, name `브라우저 키 · Browser key`) and its EIP-1193 provider |
| `apps/web/src/lib/wagmi.ts` | connectors: `[injected(), browserKey({confirm: confirmInPage})]` (dialog loaded lazily); header comment updated |
| `apps/web/src/components/BrowserKeyConfirm.tsx` | in-page confirm dialog (ko/en) mounted on its own React root per request |
| `apps/web/src/components/BrowserKeyEntry.tsx` | presentational picker body: `WalletPickerOptions` + `BrowserKeyEntry` (props only) |
| `apps/web/src/components/WalletPicker.tsx` | browser-key excluded from `named`; renders `WalletPickerOptions`; connect and export handlers |
| `apps/web/src/components/wallet-picker.css` | styles for the entry, warning, export confirm and the request summary |
| tests | `browser-key-connector.test.ts` (8), `BrowserKeyEntry.test.tsx` (3), `BrowserKeyConfirm.test.tsx` (2) |
| `README.md`, `README.ko.md` | test-count digits only (2015 → 2028, web 613 → 626) |

The hooks that sign (`giwa-wallet.ts`, `useGuardians.ts`, `useGiwaTickets.ts`, `useArcadeSession.ts`), `siwe-session.ts`, `server.ts`, `packages/delegation`, `apps/account-bootstrap`, contracts, deployments, every `package.json` and `bun.lock` are untouched. No new dependency.

## Storage

- Key: `localStorage["mapae.browser-key.v1"]` (`BROWSER_KEY_STORAGE_KEY`) on the page's origin.
- Value: exactly the 0x-prefixed 32-byte hex private key from `generatePrivateKey()`. Nothing else is stored by this connector except wagmi's own `browser-key.disconnected` flag in wagmi storage (a boolean, no key material).
- `disconnect()` keeps the key. Only clearing site data removes it. Export copies it (after a confirm) and does not delete it.

## Provider behaviour

- `eth_chainId` → `0x164ce`; `eth_accounts` → `[]` until a key exists; `eth_requestAccounts` loads or generates the key.
- `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`: wait on the confirm; decline → error `4001`, nothing sent. Signed locally with `privateKeyToAccount` (65-byte canonical ECDSA). The transaction is signed locally and only `eth_sendRawTransaction` reaches the RPC.
- `wallet_switchEthereumChain` → `null` for 91342, error `4902` otherwise.
- `eth_sign`, `eth_signTransaction`, `eth_signTypedData`/`_v1`/`_v3` and other `wallet_*` → error `4200`, never forwarded. Every other method is forwarded to `http(rpcUrl)` from `apps/web/src/lib/config.ts`.

## Threat notes (from RES-3) and where the UI shows them

| Risk | Note | Where the visitor sees it |
|---|---|---|
| Storage loss | Clearing site data, private windows or browser eviction destroys the key and with it the owner of the guardians, unless exported | Picker warning line under the button: "키는 이 브라우저에만 보관돼요. 사이트 데이터를 지우면 사라지니 먼저 내보내 두세요." / "The key is kept in this browser only and is lost if site data is cleared — export it first." |
| XSS on the origin | Any script running on the origin can read `localStorage` and take the key | Export confirm: "키를 아는 사람은 이 지갑을 쓸 수 있어요" / "Anyone with this key controls the wallet". The CSP (nonce-only scripts) is the mitigation; there is no further one in this design |
| Test assets only | Acceptable only because GIWA Sepolia assets are test assets; the connector refuses every chain but 91342 (`4902`) | Transaction confirm states "GIWA Sepolia … test ETH" |

## The key never appears in logs or network bodies

The connector contains no logging. The provider returns addresses, signatures, hashes and forwarded RPC results; the only function that returns the key is `exportBrowserKey()`, used by the picker's export confirm. Test (g) in `browser-key-connector.test.ts` records every request body sent to the in-process fake RPC and the JSON of every provider result across `eth_chainId`, `eth_accounts`, `eth_requestAccounts`, `personal_sign`, `eth_sendTransaction` and a forwarded `eth_getBalance`, and asserts none contains the key's hex (case-insensitive); it then asserts `exportBrowserKey` returns it. Test (f) asserts a declined confirm makes no RPC request at all.

## What this moves, what it does not

The mint still needs test ETH (RES-1 blocker #2). With this ticket a visitor without a wallet reaches an owner address and the sponsored delegation; the drop-off moves to the faucet step (OPE-1 §6, held by the Operator).

## How tested

- `bun run test:web`: 626 pass, 0 fail (with the gitignored `apps/web/public/arcade/` assets present; without them 4 pre-existing arcade suites fail on missing `fit.json`, unrelated to this ticket).
- `bun run typecheck && bun run check:docs`: pass.
- `bun run check:counts`: pass with the arcade assets present (the counter collects the same suites).
- `build:web`: `vite build` exits 0. In the senior's sandbox the script form failed with EPERM writing vite's config temp into the shared `node_modules`; `vite build --configLoader runner` built both environments.

## Rollback

`git revert` of the merge commit. The app Worker is deployed by the Operator by hand (`deploy:app`), so nothing is live until that deploy; reverting before it changes nothing for visitors. Keys already created in visitors' browsers stay in their localStorage and remain importable into MetaMask.

## Assumptions

1. Export does not delete the key. The ticket's "only the export action or clearing site data removes it" was read as "nothing in the app deletes it": deleting on a failed or misplaced clipboard copy would lose the guardians.
2. Storage is `localStorage` (one key, versioned `.v1`), not IndexedDB or a non-extractable WebCrypto key: secp256k1 is not a WebCrypto curve, and the ticket requires exporting the raw hex.
3. The confirm dialog reads the locale from `<html lang>` because it mounts on its own root outside the route tree (no file outside the allowed list could host it).
4. A `personal_sign` that is not an EIP-4361 message still opens the confirm, showing "Unknown (not a sign-in message)" for the domain.
5. Signing-shaped methods other than the three named are refused with `4200` rather than forwarded.
6. The picker's markup moved into the presentational `WalletPickerOptions` so the "injected wallet hides the entry" rule is testable with `renderToStaticMarkup`; the visible markup for the injected path is unchanged.
7. `eth_sendTransaction` fills missing nonce, gas and fees through viem's `sendTransaction` against the same transport (`eth_getTransactionCount`, `eth_estimateGas`, block/fee reads), forwarded as read-only calls.
