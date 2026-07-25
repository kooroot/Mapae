import {
    FRAMEWORK_COMPOSITION_ID,
    OWNER_ACCOUNT_SALT,
    parseActiveDeploymentArtifactJson,
    throttledHttp,
} from "@mapae/delegation";
import {MOCK_USDC, fromTokenAmount, giwaSepolia, redactForLog, toTokenAmount} from "@mapae/shared";
import {Implementation} from "@metamask/smart-accounts-kit";
import {getCounterfactualAccountData} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    getAddress,
    parseAbi,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {readD3IdentityConfig, readExpectedSignerAddress} from "./runtime-config.js";

// The demo payer is the HybridDeleGator owner smart account, not an EOA, so it starts
// with a zero mUSDC balance. MockUSDC.mint is a permissionless testnet faucet; this
// tops the smart account up so a delegated settlement has funds to move. Mainnet-shaped
// tokens have no such faucet — this path is GIWA-Sepolia only.
const APPROVAL = `reviewed-fund-smart-account-chain-91342-${FRAMEWORK_COMPOSITION_ID}`;

function readPrivateKey(): Hex {
    const value = process.env.DEPLOYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readAmount(): {display: string; base: bigint} {
    const raw = process.env.FUND_AMOUNT_MUSDC?.trim() || "30.00";
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
        throw new Error("FUND_AMOUNT_MUSDC must be a decimal mUSDC amount, max 6 dp");
    }
    const base = toTokenAmount(raw);
    if (base <= 0n) throw new Error("FUND_AMOUNT_MUSDC must be positive");
    return {display: raw, base};
}

const ERC20_MINT = parseAbi(["function mint(address to, uint256 value)"]);
const ERC20_READ = parseAbi([
    "function balanceOf(address) view returns (uint256)",
]);

async function deriveOwnerAccount(): Promise<{account: Address; factoryData: Hex}> {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const artifactFile = Bun.file(path);
    if (!(await artifactFile.exists())) throw new Error(`deployment artifact not found: ${path}`);
    const deployment = parseActiveDeploymentArtifactJson(await artifactFile.text());
    const identities = readD3IdentityConfig();
    const accountData = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [identities.case1Owner, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    return {account: getAddress(accountData.address), factoryData: accountData.factoryData as Hex};
}

async function main(): Promise<void> {
    const amount = readAmount();
    const {account} = await deriveOwnerAccount();

    if (!process.argv.includes("--broadcast")) {
        console.log("GIWA smart-account funding preview (MockUSDC faucet mint)");
        console.log(`  token     ${MOCK_USDC.address} (${MOCK_USDC.symbol})`);
        console.log(`  mint to   ${account} (owner smart account / delegation payer)`);
        console.log(`  amount    ${amount.display} ${MOCK_USDC.symbol} (${amount.base} base units)`);
        console.log("  gas payer Framework deployer");
        console.log("  broadcast BLOCKED");
        console.log(`Approval phrase: GIWA_FUNDING_APPROVAL=${APPROVAL}`);
        console.log(`Override amount: FUND_AMOUNT_MUSDC=<decimal> (default 30.00)`);
        return;
    }
    if (process.env.GIWA_FUNDING_APPROVAL !== APPROVAL) {
        throw new Error("funding approval missing; no broadcast made");
    }

    const rpcUrl =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    const deployer = privateKeyToAccount(readPrivateKey());
    const expectedDeployer = readExpectedSignerAddress("DEPLOYER_ADDRESS");
    if (deployer.address !== expectedDeployer) {
        throw new Error(
            `DEPLOYER_PRIVATE_KEY resolves to ${deployer.address}, expected ${expectedDeployer}`,
        );
    }
    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(url.toString()),
    });
    const walletClient = createWalletClient({
        account: deployer,
        chain: giwaSepolia,
        transport: throttledHttp(url.toString()),
    });
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }
    // The payer account must already be deployed; minting to a counterfactual-only
    // address would strand the tokens until it is created.
    const code = await publicClient.getCode({address: account});
    if (!code || code === "0x") {
        throw new Error(`owner smart account ${account} has no code; deploy it before funding`);
    }
    const before = await publicClient.readContract({
        address: MOCK_USDC.address,
        abi: ERC20_READ,
        functionName: "balanceOf",
        args: [account],
    });

    const hash = await walletClient.sendTransaction({
        to: MOCK_USDC.address,
        data: encodeFunctionData({abi: ERC20_MINT, functionName: "mint", args: [account, amount.base]}),
        value: 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error("mint reverted");
    const after = await publicClient.readContract({
        address: MOCK_USDC.address,
        abi: ERC20_READ,
        functionName: "balanceOf",
        args: [account],
    });
    if (after - before !== amount.base) {
        throw new Error(
            `balance delta ${after - before} does not match minted ${amount.base}`,
        );
    }
    console.log("owner smart account funded");
    console.log(`  account     ${account}`);
    console.log(`  minted      ${amount.display} ${MOCK_USDC.symbol}`);
    console.log(`  balance     ${fromTokenAmount(after)} ${MOCK_USDC.symbol}`);
    console.log(`  transaction ${hash}`);
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
