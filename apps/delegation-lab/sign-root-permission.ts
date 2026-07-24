/**
 * Two-step, wallet-free root delegation signing for GIWA.
 *
 *   prepare  <role>   build the unsigned root delegation + EIP-712 typed data
 *   assemble <role>   attach the owner-wallet signature and verify it on-chain
 *
 * The account owner's private key never touches this process. `prepare` prints the
 * exact typed data for the owner wallet (e.g. Rabby) to sign with
 * `eth_signTypedData_v4`, and persists the unsigned delegation so `assemble` signs
 * verbatim what was shown. `assemble` refuses to write the permission unless the
 * deployed owner account's ERC-1271 `isValidSignature` accepts the signature over the
 * exact EIP-712 digest the DelegationManager reconstructs — i.e. unless
 * `redeemDelegations` would accept it.
 *
 * Neither step broadcasts a transaction.
 */
import {
    assembleRootPermission,
    buildRootDelegationTypedData,
    buildD3Policies,
    parseActiveDeploymentArtifactJson,
    prepareRootPermissionSigningRequest,
    throttledHttp,
    type D3Role,
    type PermissionArtifact,
} from "@mapae/delegation";
import {giwaSepolia} from "@mapae/shared";
import {resolve} from "node:path";
import {rename} from "node:fs/promises";
import {
    createPublicClient,
    getAddress,
    hashTypedData,
    isAddress,
    verifyTypedData,
    type Address,
    type Hex,
} from "viem";

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ROLES: readonly D3Role[] = [
    "open-agent",
    "vendor-agent",
    "team-manager",
    "child-a",
    "child-b",
];

interface SigningRequestFile {
    schemaVersion: 1;
    chainId: typeof giwaSepolia.id;
    role: D3Role;
    owner: Address;
    delegator: Address;
    delegate: Address;
    startDate: number;
    digest: Hex;
    unsignedDelegation: unknown;
}

function bigintAwareStringify(value: unknown): string {
    return JSON.stringify(
        value,
        (_key, raw) => (typeof raw === "bigint" ? raw.toString() : raw),
        2,
    );
}

/** The exact `eth_signTypedData_v4` payload: SIGNABLE types plus EIP712Domain. */
function fullSignTypedDataV4(typedData: {
    domain: unknown;
    types: Record<string, unknown>;
    primaryType: string;
    message: unknown;
}): unknown {
    return {
        types: {
            EIP712Domain: [
                {name: "name", type: "string"},
                {name: "version", type: "string"},
                {name: "chainId", type: "uint256"},
                {name: "verifyingContract", type: "address"},
            ],
            ...typedData.types,
        },
        primaryType: typedData.primaryType,
        domain: typedData.domain,
        message: typedData.message,
    };
}

/**
 * A self-contained local page that asks the owner wallet (MetaMask/Rabby) to sign the
 * typed data via `eth_signTypedData_v4`. This is a signature request, not a
 * transaction — nothing is broadcast and no gas is spent. The page embeds only public
 * values; the owner key stays in the wallet. It is opened from the local filesystem in
 * the browser where the wallet extension lives, never published.
 */
function buildSigningPage(input: {
    role: string;
    owner: Address;
    delegator: Address;
    delegate: Address;
    chainId: number;
    digest: Hex;
    humanSummary: string;
    typedData: unknown;
}): string {
    const embedded = JSON.stringify({
        role: input.role,
        owner: input.owner,
        chainId: input.chainId,
        digest: input.digest,
        typedData: input.typedData,
    });
    // The embedded JSON is injected into a <script type="application/json"> block, so it
    // cannot break out into executable context; the page parses it with JSON.parse.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mapae — sign root permission (${input.role})</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 16px 18px; margin: 16px 0; }
  code { font-family: ui-monospace, monospace; word-break: break-all; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid #8886; cursor: pointer; background: #2563eb; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .row { margin: 6px 0; }
  .k { display: inline-block; min-width: 130px; color: #888; }
  .ok { color: #16a34a; } .bad { color: #dc2626; } .warn { color: #d97706; }
  textarea { width: 100%; min-height: 70px; font-family: ui-monospace, monospace; font-size: 13px; }
  #status { white-space: pre-wrap; }
</style>
</head>
<body>
<h1>Sign root permission — <code>${input.role}</code></h1>
<p>This is an <b>EIP-712 signature</b> (<code>eth_signTypedData_v4</code>), <b>not</b> a transaction. Nothing is sent on chain and no gas is spent.</p>
<div class="card">
  <div class="row"><span class="k">Owner must sign</span><code>${input.owner}</code></div>
  <div class="row"><span class="k">Smart account</span><code>${input.delegator}</code></div>
  <div class="row"><span class="k">Agent session</span><code>${input.delegate}</code></div>
  <div class="row"><span class="k">Grant</span>${input.humanSummary}</div>
  <div class="row"><span class="k">EIP-712 digest</span><code>${input.digest}</code></div>
</div>
<div class="card">
  <div class="row"><button id="connect">1. Connect wallet</button> <span id="acct"></span></div>
  <div class="row"><button id="sign" disabled>2. Sign</button></div>
  <div id="status" class="row"></div>
  <div class="row"><textarea id="sig" readonly placeholder="signature appears here"></textarea></div>
  <div class="row"><button id="copy" disabled>Copy signature</button></div>
  <div class="row" id="next" style="display:none">Then run:<br><code>ROOT_PERMISSION_SIGNATURE=<span id="sigcmd"></span> bun run permission:assemble ${input.role}</code></div>
</div>
<script type="application/json" id="payload">${embedded}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("payload").textContent);
  var statusEl = document.getElementById("status");
  var acctEl = document.getElementById("acct");
  var signBtn = document.getElementById("sign");
  var copyBtn = document.getElementById("copy");
  var sigEl = document.getElementById("sig");
  var account = null;
  // EIP-6963: collect wallets that announce themselves so this works with MetaMask
  // and Rabby side by side. window.ethereum stays the primary path.
  var discovered = [];
  window.addEventListener("eip6963:announceProvider", function (ev) {
    if (ev && ev.detail && ev.detail.provider) discovered.push(ev.detail.provider);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  function set(msg, cls) { statusEl.textContent = msg; statusEl.className = "row " + (cls || ""); }
  function eth() {
    if (window.ethereum) return window.ethereum;
    if (discovered.length) return discovered[0];
    if (location.protocol === "file:") {
      set("No wallet detected because this page is opened as a file:// URL — browser extensions cannot inject a provider there. Serve it over loopback instead: run  bun run permission:serve " + data.role + "  and open the printed http://127.0.0.1 URL.", "bad");
    } else {
      set("No wallet detected. Open this page in the browser where MetaMask/Rabby is installed and enabled.", "bad");
    }
    return null;
  }
  document.getElementById("connect").onclick = async function () {
    var e = eth(); if (!e) return;
    try {
      var accounts = await e.request({ method: "eth_requestAccounts" });
      account = (accounts[0] || "").toLowerCase();
      acctEl.textContent = "";
      var codeEl = document.createElement("code");
      codeEl.textContent = account;
      acctEl.appendChild(document.createTextNode("connected "));
      acctEl.appendChild(codeEl);
      var chainId = await e.request({ method: "eth_chainId" });
      var onGiwa = parseInt(chainId, 16) === data.chainId;
      if (account !== data.owner.toLowerCase()) {
        set("Connected account is not the required owner " + data.owner + ". Switch account in the wallet.", "bad");
        signBtn.disabled = true; return;
      }
      if (!onGiwa) {
        set("Wallet is on chain " + parseInt(chainId,16) + ", but this signature is for GIWA Sepolia (" + data.chainId + "). Switch the wallet network to GIWA Sepolia, then reconnect.", "warn");
        signBtn.disabled = true; return;
      }
      set("Ready: owner and network match.", "ok");
      signBtn.disabled = false;
    } catch (err) { set("Connect failed: " + (err && err.message || err), "bad"); }
  };
  signBtn.onclick = async function () {
    var e = eth(); if (!e || !account) return;
    try {
      set("Waiting for wallet signature...", "warn");
      var signature = await e.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(data.typedData)] });
      sigEl.value = signature;
      document.getElementById("sigcmd").textContent = signature;
      document.getElementById("next").style.display = "";
      copyBtn.disabled = false;
      set("Signed. Copy the signature and run the assemble command.", "ok");
    } catch (err) { set("Signature rejected or failed: " + (err && err.message || err), "bad"); }
  };
  copyBtn.onclick = async function () {
    try { await navigator.clipboard.writeText(sigEl.value); set("Signature copied.", "ok"); }
    catch (e) { sigEl.select(); set("Select the text and copy manually.", "warn"); }
  };
})();
</script>
</body>
</html>
`;
}

function readRole(): D3Role {
    const value = (process.argv[3] ?? "open-agent").trim();
    if (!ROLES.includes(value as D3Role)) {
        throw new Error(`role must be one of ${ROLES.join(", ")}`);
    }
    return value as D3Role;
}

function readRpcUrl(): string {
    const value =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    return url.toString();
}

async function readJson(path: string, label: string): Promise<unknown> {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`${label} not found: ${path}`);
    return file.json();
}

async function readActiveEnvironment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`active Framework artifact not found: ${path}`);
    return parseActiveDeploymentArtifactJson(await file.text());
}

async function readOwnerAccount(): Promise<{account: Address; owner: Address; manager: Address}> {
    const path =
        process.env.OWNER_ACCOUNT_FORGE_PATH ??
        "../../deployments/giwa-sepolia.owner-account.json";
    const raw = (await readJson(path, "owner-account artifact")) as Record<string, unknown>;
    const account = raw.account;
    const owner = raw.owner;
    const manager = raw.DelegationManager;
    if (
        typeof account !== "string" || !isAddress(account) ||
        typeof owner !== "string" || !isAddress(owner) ||
        typeof manager !== "string" || !isAddress(manager)
    ) {
        throw new Error("owner-account artifact is missing account/owner/DelegationManager");
    }
    return {account: getAddress(account), owner: getAddress(owner), manager: getAddress(manager)};
}

async function readDelegate(role: D3Role): Promise<Address> {
    const override = process.env.DELEGATE_ADDRESS?.trim();
    if (override) {
        if (!isAddress(override)) throw new Error("DELEGATE_ADDRESS must be an EVM address");
        return getAddress(override);
    }
    const path =
        process.env.D3_SESSION_ADDRESSES_PATH ??
        "../../deployments/d3-session-addresses.json";
    const sessions = (await readJson(path, "session addresses")) as Record<string, unknown>;
    const value = sessions[role];
    if (typeof value !== "string" || !isAddress(value)) {
        throw new Error(`session address for ${role} is missing or malformed`);
    }
    return getAddress(value);
}

function readVendor(): Address {
    const value = process.env.CASE_2_VENDOR_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("CASE_2_VENDOR_ADDRESS must be an EVM address");
    return getAddress(value);
}

async function writeAtomically(pathInput: string, contents: string): Promise<void> {
    const path = resolve(pathInput);
    const temporary = `${path}.tmp-${process.pid}`;
    await Bun.write(temporary, contents);
    await rename(temporary, path);
}

/**
 * The committed policy default is a conservative 30-minute session-key window
 * (BASE_POLICY.expiresAfterSeconds). For a repeatable demo or pitch that window is
 * impractical — it expires mid-run — so PERMISSION_TTL_SECONDS lets an operator widen
 * it without weakening the default. The real spending control is the per-period cap,
 * which is unaffected; this only extends how long the session key stays valid.
 */
function applyPermissionTtlOverride<T extends {expiresAfterSeconds: number}>(base: T): T {
    const raw = process.env.PERMISSION_TTL_SECONDS?.trim();
    if (!raw) return base;
    const ttl = Number(raw);
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 7 * 24 * 3600) {
        throw new Error("PERMISSION_TTL_SECONDS must be a positive integer up to 604800 (7 days)");
    }
    return {...base, expiresAfterSeconds: ttl};
}

function requestPath(role: D3Role): string {
    return process.env.ROOT_PERMISSION_REQUEST_PATH?.trim() || `./${role}.permission.request.json`;
}

function permissionPath(role: D3Role): string {
    return process.env.PARENT_PERMISSION_CONTEXT_PATH?.trim() || `./${role}.permission.json`;
}

async function prepare(): Promise<void> {
    const role = readRole();
    const deployment = await readActiveEnvironment();
    const {account, owner, manager} = await readOwnerAccount();
    if (getAddress(deployment.environment.DelegationManager) !== manager) {
        throw new Error("owner-account manager does not match the active Framework artifact");
    }
    const delegate = await readDelegate(role);
    const policies = buildD3Policies(readVendor());
    const policy = applyPermissionTtlOverride(policies[role]);
    const startDate = Math.floor(Date.now() / 1000);

    const request = prepareRootPermissionSigningRequest({
        environment: deployment.environment,
        accountOwnerSmartAccount: account,
        delegate,
        policy,
        startDate,
    });
    const digest = hashTypedData(request.typedData);

    const requestFile: SigningRequestFile = {
        schemaVersion: 1,
        chainId: giwaSepolia.id,
        role,
        owner,
        delegator: account,
        delegate,
        startDate,
        digest,
        unsignedDelegation: request.unsignedDelegation,
    };
    await writeAtomically(requestPath(role), `${bigintAwareStringify(requestFile)}\n`);

    const humanSummary =
        `${policy.periodAmount} base units per ${policy.periodDurationSeconds}s, ` +
        `expires ${policy.expiresAfterSeconds}s after ${startDate}` +
        (policy.recipient ? `, only to ${policy.recipient}` : "");
    const fullTypedData = fullSignTypedDataV4(request.typedData);
    const pageContents = buildSigningPage({
        role,
        owner,
        delegator: account,
        delegate,
        chainId: giwaSepolia.id,
        digest,
        humanSummary,
        // The page needs a bigint-free payload (JSON.parse-able in the browser).
        typedData: JSON.parse(bigintAwareStringify(fullTypedData)),
    });
    const pagePath = process.env.ROOT_PERMISSION_PAGE_PATH?.trim() || `./${role}.sign.html`;
    await writeAtomically(pagePath, pageContents);

    console.log(`root permission signing request for role "${role}"`);
    console.log(`  owner wallet must sign   ${owner}`);
    console.log(`  delegator (smart account)${account}`);
    console.log(`  delegate (agent session) ${delegate}`);
    console.log(`  period amount            ${policy.periodAmount} base units / ${policy.periodDurationSeconds}s`);
    console.log(`  expires after            ${policy.expiresAfterSeconds}s from ${startDate}`);
    console.log(`  request saved            ${requestPath(role)}`);
    console.log(`  EIP-712 digest           ${digest}`);
    console.log("");
    console.log("Serve the page over loopback (browser wallets do not inject on file:// URLs):");
    console.log(`  bun run permission:serve ${role}`);
    console.log("then open the printed http://127.0.0.1 URL in the browser with your wallet, and Connect + Sign.");
    console.log(`  page file: ${resolve(pagePath)}`);
    console.log("");
    console.log("It is a signature (eth_signTypedData_v4), not a transaction — no gas, nothing on chain.");
    console.log("Then: ROOT_PERMISSION_SIGNATURE=0x... bun run permission:assemble " + role);
}

async function assemble(): Promise<void> {
    const role = readRole();
    const signature = process.env.ROOT_PERMISSION_SIGNATURE?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error("ROOT_PERMISSION_SIGNATURE must be a 65-byte owner-wallet signature");
    }

    const request = (await readJson(requestPath(role), "signing request")) as SigningRequestFile;
    if (request.role !== role || request.chainId !== giwaSepolia.id) {
        throw new Error("signing request does not match the requested role/chain");
    }
    const deployment = await readActiveEnvironment();
    const {account, owner, manager} = await readOwnerAccount();
    if (
        getAddress(request.delegator) !== account ||
        getAddress(request.owner) !== owner ||
        getAddress(deployment.environment.DelegationManager) !== manager
    ) {
        throw new Error("signing request no longer matches the deployed owner account");
    }

    // Rebuild the typed data from the persisted unsigned delegation and re-derive the
    // digest, then confirm it equals the digest recorded at prepare time. This detects
    // any tampering with the request file between the two steps.
    const unsigned = request.unsignedDelegation as Parameters<typeof buildRootDelegationTypedData>[1];
    const typedData = buildRootDelegationTypedData(manager, unsigned);
    const digest = hashTypedData(typedData);
    if (digest !== request.digest) {
        throw new Error("recomputed EIP-712 digest does not match the signing request");
    }

    // Offline sanity: the signature must recover to the account owner over this data.
    const recoversToOwner = await verifyTypedData({
        address: owner,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: signature as Hex,
    });
    if (!recoversToOwner) {
        throw new Error("signature does not recover to the configured account owner");
    }

    // Definitive check: the deployed owner account's ERC-1271 must accept this exact
    // digest+signature. This is byte-for-byte what redeemDelegations verifies, so a
    // pass here means the delegation is redeemable on chain.
    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(readRpcUrl()),
    });
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }
    const magic = await publicClient.readContract({
        address: account,
        abi: [
            {
                type: "function",
                name: "isValidSignature",
                stateMutability: "view",
                inputs: [
                    {name: "hash", type: "bytes32"},
                    {name: "signature", type: "bytes"},
                ],
                outputs: [{name: "", type: "bytes4"}],
            },
        ],
        functionName: "isValidSignature",
        args: [digest, signature as Hex],
    });
    if (magic.toLowerCase() !== ERC1271_MAGIC_VALUE) {
        throw new Error(`owner account rejected the signature (ERC-1271 returned ${magic})`);
    }

    const artifact: PermissionArtifact = assembleRootPermission({
        role,
        unsignedDelegation: unsigned,
        signature: signature as Hex,
        createdAt: request.startDate,
    });
    await writeAtomically(permissionPath(role), `${JSON.stringify(artifact, null, 2)}\n`);

    console.log(`root permission verified on chain and assembled for role "${role}"`);
    console.log(`  delegator   ${artifact.delegator}`);
    console.log(`  delegate    ${artifact.delegate}`);
    console.log(`  ERC-1271    ${magic} (accepted)`);
    console.log(`  written     ${permissionPath(role)}`);
    console.log("No transaction was broadcast.");
}

/**
 * Serve the one signing page over loopback so a browser wallet extension can inject a
 * provider — MetaMask/Rabby inject on http://127.0.0.1 but not on file:// URLs. Only the
 * requested `<role>.sign.html` is exposed; the directory also holds `.env` (chmod 600)
 * and `*.permission.request.json`, so a directory server would leak them.
 */
function serve(): void {
    const role = readRole();
    const pagePath = resolve(
        process.env.ROOT_PERMISSION_PAGE_PATH?.trim() || `./${role}.sign.html`,
    );
    const basename = pagePath.split("/").pop() ?? `${role}.sign.html`;
    const hostname = "127.0.0.1";
    const port = Number(process.env.SIGN_SERVER_PORT ?? "8899");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("SIGN_SERVER_PORT must be a valid TCP port");
    }
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname,
            port,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname !== "/" && url.pathname !== `/${basename}`) {
                    return new Response("not found", {status: 404});
                }
                const file = Bun.file(pagePath);
                if (!(await file.exists())) {
                    return new Response(
                        `run \`bun run permission:prepare ${role}\` first`,
                        {status: 404},
                    );
                }
                return new Response(file, {
                    headers: {
                        "content-type": "text/html; charset=utf-8",
                        "cache-control": "no-store",
                    },
                });
            },
        });
    } catch (error) {
        throw new Error(
            `could not bind ${hostname}:${port} (${error instanceof Error ? error.message : String(error)}); set SIGN_SERVER_PORT to a free port`,
        );
    }
    console.log(`serving the "${role}" signing page over loopback (this one file only):`);
    console.log(`  http://${hostname}:${server.port}/`);
    console.log("");
    console.log("Open that URL in the browser where MetaMask/Rabby is installed, then Connect + Sign.");
    console.log("Wallet extensions inject on http://127.0.0.1 but not on file:// URLs — that is why this exists.");
    console.log("Press Ctrl+C once you have copied the signature.");
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === "prepare") return prepare();
    if (command === "assemble") return assemble();
    if (command === "serve") return serve();
    throw new Error("usage: sign-root-permission.ts <prepare|assemble|serve> <role>");
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
