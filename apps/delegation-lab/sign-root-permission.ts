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
    const startDate = Math.floor(Date.now() / 1000);

    const request = prepareRootPermissionSigningRequest({
        environment: deployment.environment,
        accountOwnerSmartAccount: account,
        delegate,
        policy: policies[role],
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

    console.log(`root permission signing request for role "${role}"`);
    console.log(`  owner wallet must sign   ${owner}`);
    console.log(`  delegator (smart account)${account}`);
    console.log(`  delegate (agent session) ${delegate}`);
    console.log(`  period amount            ${policies[role].periodAmount} base units / ${policies[role].periodDurationSeconds}s`);
    console.log(`  expires after            ${policies[role].expiresAfterSeconds}s from ${startDate}`);
    console.log(`  request saved            ${requestPath(role)}`);
    console.log(`  EIP-712 digest           ${digest}`);
    console.log("");
    console.log("Sign this exact typed data from the owner wallet (eth_signTypedData_v4):");
    console.log(
        bigintAwareStringify({
            types: {
                EIP712Domain: [
                    {name: "name", type: "string"},
                    {name: "version", type: "string"},
                    {name: "chainId", type: "uint256"},
                    {name: "verifyingContract", type: "address"},
                ],
                ...request.typedData.types,
            },
            primaryType: request.typedData.primaryType,
            domain: request.typedData.domain,
            message: request.typedData.message,
        }),
    );
    console.log("");
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

async function main(): Promise<void> {
    const command = process.argv[2];
    if (command === "prepare") return prepare();
    if (command === "assemble") return assemble();
    throw new Error("usage: sign-root-permission.ts <prepare|assemble> <role>");
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
