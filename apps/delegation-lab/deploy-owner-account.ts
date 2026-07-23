import {
    OWNER_ACCOUNT_SALT,
    parseDeploymentArtifactJson,
} from "@mapae/delegation";
import {giwaSepolia} from "@mapae/shared";
import {Implementation} from "@metamask/smart-accounts-kit";
import {getCounterfactualAccountData} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    http,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {readD3IdentityConfig} from "./runtime-config.js";

const APPROVAL = "reviewed-owner-account-chain-91342";

function readPrivateKey(): Hex {
    const value = process.env.RELAYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

async function main(): Promise<void> {
    const identities = readD3IdentityConfig();
    if (!process.argv.includes("--broadcast")) {
        console.log("GIWA owner smart-account deployment preview");
        console.log(`  owner     ${identities.accountOwner}`);
        console.log(`  salt      ${OWNER_ACCOUNT_SALT}`);
        console.log("  gas payer current relayer");
        console.log("  broadcast BLOCKED");
        console.log(`Approval phrase: GIWA_ACCOUNT_DEPLOYMENT_APPROVAL=${APPROVAL}`);
        return;
    }
    if (process.env.GIWA_ACCOUNT_DEPLOYMENT_APPROVAL !== APPROVAL) {
        throw new Error("account deployment approval missing; no broadcast made");
    }

    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const artifactFile = Bun.file(path);
    if (!(await artifactFile.exists())) throw new Error(`deployment artifact not found: ${path}`);
    const deployment = parseDeploymentArtifactJson(await artifactFile.text());
    const rpcUrl =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    const relayer = privateKeyToAccount(readPrivateKey());
    const publicClient = createPublicClient({chain: giwaSepolia, transport: http(url.toString())});
    const walletClient = createWalletClient({
        account: relayer,
        chain: giwaSepolia,
        transport: http(url.toString()),
    });
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }

    const accountData = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [identities.accountOwner, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    const existing = await publicClient.getCode({address: accountData.address});
    if (existing && existing !== "0x") {
        console.log(`owner smart account already deployed at ${accountData.address}`);
        return;
    }

    const hash = await walletClient.sendTransaction({
        to: getAddress(deployment.environment.SimpleFactory),
        data: accountData.factoryData,
        value: 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error("smart-account deployment reverted");
    const code = await publicClient.getCode({address: accountData.address});
    if (!code || code === "0x") throw new Error("smart-account address has no code after deployment");
    console.log(`owner smart account deployed ${accountData.address}`);
    console.log(`transaction ${hash}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
