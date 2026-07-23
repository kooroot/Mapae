import {
    createMapaeDelegationProvider,
    isPermissionContext,
    parseDeploymentArtifactJson,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    buildErc7710PaymentPayload,
    encodePaymentHeader,
    fromTokenAmount,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {getAddress, isAddress, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const REQUEST_TIMEOUT_MS = 15_000;

function readUrl(name: string, fallback: string): URL {
    const value = process.env[name]?.trim() || fallback;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error(`${name} must use HTTPS unless it is loopback`);
    }
    return url;
}

function readAgentKey(): Hex {
    const value = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("AGENT_PRIVATE_KEY must be a 32-byte session key");
    }
    return value as Hex;
}

async function readDeployment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`deployment artifact not found: ${path}`);
    return parseDeploymentArtifactJson(await file.text());
}

async function readParentPermissionContext(): Promise<Hex> {
    const path =
        process.env.PARENT_PERMISSION_CONTEXT_PATH ?? "./open-agent.permission.json";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`parent permission file not found: ${path}`);
    const value = (await file.json()) as {permissionContext?: unknown};
    if (!isPermissionContext(value.permissionContext)) {
        throw new Error("parent permissionContext is missing, malformed, or too large");
    }
    return value.permissionContext;
}

async function trustedFacilitators(url: URL): Promise<Address[]> {
    const response = await fetch(new URL("/supported", url), {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`facilitator /supported returned ${response.status}`);
    const body = (await response.json()) as {signers?: Record<string, unknown>};
    const values = body.signers?.[GIWA_SEPOLIA_CAIP2];
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error("facilitator advertised no GIWA signer");
    }
    return values.map((value) => {
        if (typeof value !== "string" || !isAddress(value)) {
            throw new Error("facilitator advertised an invalid signer");
        }
        return getAddress(value);
    });
}

function assertRequirements(value: unknown): Erc7710PaymentRequirements {
    const req = value as Erc7710PaymentRequirements;
    if (
        !req ||
        req.scheme !== "exact" ||
        req.network !== GIWA_SEPOLIA_CAIP2 ||
        req.extra?.assetTransferMethod !== "erc7710"
    ) {
        throw new Error("seller did not offer exact ERC-7710 on GIWA");
    }
    if (!isAddress(req.asset) || getAddress(req.asset) !== MOCK_USDC.address) {
        throw new Error(`unexpected asset ${req.asset}`);
    }
    if (!isAddress(req.payTo)) throw new Error("seller payTo is malformed");
    if (!/^[1-9]\d*$/.test(req.amount)) throw new Error("seller amount is malformed");
    if (
        !Number.isInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds < 1 ||
        req.maxTimeoutSeconds > 300
    ) {
        throw new Error("seller timeout is unsafe");
    }
    return req;
}

async function main(): Promise<void> {
    const account = privateKeyToAccount(readAgentKey());
    const seller = readUrl("SELLER_URL", "http://127.0.0.1:3001");
    const facilitator = readUrl("FACILITATOR_URL", "http://127.0.0.1:8081");
    const resource = process.argv[2] ?? "/delegated/deliverable/inv-001";
    if (!resource.startsWith("/") || resource.startsWith("//") || resource.includes("\\")) {
        throw new Error("resource must be an absolute path on SELLER_URL");
    }
    const target = new URL(resource, seller);
    if (target.origin !== seller.origin) throw new Error("resource escaped SELLER_URL");

    const [deployment, parentPermissionContext, facilitatorAddresses] = await Promise.all([
        readDeployment(),
        readParentPermissionContext(),
        trustedFacilitators(facilitator),
    ]);
    const provider = createMapaeDelegationProvider({
        account,
        environment: deployment.environment,
        parentPermissionContext,
        facilitatorAddresses,
    });

    console.log(`delegated agent ${account.address}`);
    console.log(`target          ${target}`);
    console.log("limit           enforced by parent erc20PeriodTransfer caveat");

    const first = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (first.status !== 402) throw new Error(`expected 402, received ${first.status}`);
    const body = (await first.json()) as PaymentRequired<Erc7710PaymentRequirements>;
    if (body.x402Version !== X402_VERSION) throw new Error("unsupported x402 version");
    const accepted = assertRequirements(body.accepts?.[0]);
    const advertised = accepted.extra.facilitatorAddresses ?? [];
    if (
        !facilitatorAddresses.some((trusted) =>
            advertised.some((candidate) => getAddress(candidate) === trusted),
        )
    ) {
        throw new Error("seller and trusted facilitator signer lists do not overlap");
    }

    console.log(
        `402 → ${fromTokenAmount(BigInt(accepted.amount))} mUSDC to ${accepted.payTo}`,
    );
    const leaf = await provider(accepted);
    if (getAddress(leaf.delegationManager) !== getAddress(deployment.environment.DelegationManager)) {
        throw new Error("provider returned an unexpected DelegationManager");
    }
    const payload = buildErc7710PaymentPayload({
        accepted,
        delegationManager: getAddress(leaf.delegationManager),
        permissionContext: leaf.permissionContext,
        delegator: getAddress(leaf.delegator),
    });

    const second = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {"X-PAYMENT": encodePaymentHeader(payload)},
    });
    const text = await second.text();
    if (!second.ok) {
        // A malicious seller can reflect X-PAYMENT into its response. Never print the
        // body after sending a permission context.
        throw new Error(`payment failed ${second.status}`);
    }
    let receipt: {receipt?: {transaction?: unknown}};
    try {
        receipt = JSON.parse(text) as {receipt?: {transaction?: unknown}};
    } catch {
        throw new Error("seller returned a non-JSON resource after settlement");
    }
    console.log(`OK ${second.status}`);
    console.log(
        `transaction     ${
            typeof receipt.receipt?.transaction === "string"
                ? receipt.receipt.transaction
                : "(not returned)"
        }`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
