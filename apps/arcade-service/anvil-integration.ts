import {ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbi, publicActions, toBytes, type Abi, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {Implementation, toMetaMaskSmartAccount} from "@metamask/smart-accounts-kit";
import {deploySmartAccountsEnvironment, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {DELEGATION_FRAMEWORK_VERSION, ENTRY_POINT_V07, FRAMEWORK_COMPOSITION_ID, FrameworkDeploymentRecorder, GIWA_ENTRY_POINT_V07_IDENTITY,
    buildD3Policies, createRecordingWalletClient, finalizeFrameworkDeploymentManifest, preparePeriodDelegation, verifyOwnerSmartAccount, withDelegationSignature} from "@mapae/delegation";
import {giwaSepolia, MOCK_USDC, redactForLog} from "@mapae/shared";
import {openStore} from "@mapae/store";
import {openArcadeStore} from "@mapae/store/arcade";
import {assertAnvil, createFork} from "./fork.js";
import {createPayments} from "./payments.js";

// No .env or production artifacts are consumed. Every identity and contract is made on this disposable local node.
async function main() {
    const dir = mkdtempSync(join(tmpdir(), "mapae-arcade-evm-"));
    const portProbe = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response(null)});
    const port = portProbe.port!;
    portProbe.stop(true);
    const rpc = `http://127.0.0.1:${port}`;
    const anvil = Bun.spawn(["anvil", "--host", "127.0.0.1", "--port", String(port), "--chain-id", String(giwaSepolia.id), "--silent"], {stdout: "ignore", stderr: "ignore", env: {PATH: process.env.PATH}});
    const store = openStore(join(dir, "payments.sqlite")), admissions = openArcadeStore(join(dir, "admissions.sqlite"));
    try {
        for (let attempt = 0; ; attempt++) {
            await Bun.sleep(100);
            if (anvil.exitCode !== null) throw new Error("Anvil exited before startup");
            try {await assertAnvil(rpc); break;} catch {if (attempt > 40) throw new Error("Anvil did not start");}
        }
        const transport = http(rpc, {fetchOptions: {redirect: "error"}, retryCount: 0});
        const client = createPublicClient({chain: giwaSepolia, transport, pollingInterval: 10});
        async function mutate(method: string, params: unknown[]) {
            await assertAnvil(rpc);
            return client.request({method, params} as never);
        }
        const deployer = privateKeyToAccount(generatePrivateKey()), admin = privateKeyToAccount(generatePrivateKey());
        const owner = privateKeyToAccount(generatePrivateKey()), agentKey = generatePrivateKey(), agent = privateKeyToAccount(agentKey);
        const payTo = privateKeyToAccount(generatePrivateKey()).address;
        await mutate("anvil_setBalance", [deployer.address, "0x56bc75e2d63100000"]);
        await mutate("anvil_setBalance", [admin.address, "0x56bc75e2d63100000"]);
        const wallet = createWalletClient({account: deployer, chain: giwaSepolia, transport}).extend(publicActions);
        const adminWallet = createWalletClient({account: admin, chain: giwaSepolia, transport});
        async function receipt(hash: Hex) {return client.waitForTransactionReceipt({hash, pollingInterval: 10});}

        const entryPointFixture = await Bun.file(new URL("./fixtures/entrypoint-v07.json", import.meta.url)).json() as {code: Hex};
        assert.equal(keccak256(entryPointFixture.code), GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash, "canonical EntryPoint runtime fingerprint");
        await mutate("anvil_setCode", [ENTRY_POINT_V07, entryPointFixture.code]);
        console.log("[arcade EVM] canonical EntryPoint runtime verified");

        const named = {EntryPoint: ENTRY_POINT_V07};
        const recorder = new FrameworkDeploymentRecorder();
        const environment = await deploySmartAccountsEnvironment(createRecordingWalletClient(wallet, recorder), client, giwaSepolia, named);
        const manifest = await finalizeFrameworkDeploymentManifest(recorder, client, named, deployer.address);
        const adminAbi = parseAbi(["function transferOwnership(address)", "function acceptOwnership()"]);
        const transferred = await receipt(await wallet.writeContract({address: getAddress(environment.DelegationManager), abi: adminAbi, functionName: "transferOwnership", args: [admin.address]}));
        const accepted = await receipt(await adminWallet.writeContract({address: getAddress(environment.DelegationManager), abi: adminAbi, functionName: "acceptOwnership"}));
        const deploymentPath = join(dir, "deployment.json"), manifestPath = join(dir, "manifest.json"), parentPath = join(dir, "parent.permission.json");
        await Bun.write(manifestPath, JSON.stringify(manifest));
        await Bun.write(deploymentPath, JSON.stringify({schemaVersion: 2, chainId: giwaSepolia.id, frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
            compositionId: FRAMEWORK_COMPOSITION_ID, environment, state: "active", admin: {deployer: deployer.address, owner: admin.address, pendingOwner: null,
                ownershipTransferTransaction: transferred.transactionHash, ownershipAcceptanceTransaction: accepted.transactionHash, verificationBlock: accepted.blockNumber.toString()}}));
        console.log(`[arcade EVM] ${manifest.deploymentCount} pinned Framework units deployed, two-step ownership complete`);

        const tokenArtifact = await Bun.file(new URL("../../contracts/out/MockUSDC.sol/MockUSDC.json", import.meta.url)).json() as {abi: Abi; bytecode: {object: Hex}};
        const tokenDeploy = await receipt(await wallet.deployContract({abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object}));
        assert(tokenDeploy.contractAddress);
        await mutate("anvil_setCode", [MOCK_USDC.address, await client.getCode({address: tokenDeploy.contractAddress})]);
        const payer = await toMetaMaskSmartAccount({client, implementation: Implementation.Hybrid, signer: {account: owner}, environment,
            deployParams: [owner.address, [], [], []], deploySalt: `0x${"00".repeat(32)}`});
        const factory = await payer.getFactoryArgs();
        assert(factory.factory && factory.factoryData);
        await receipt(await wallet.sendTransaction({to: factory.factory, data: factory.factoryData}));
        await verifyOwnerSmartAccount({publicClient: client, account: payer.address, expectedOwner: owner.address, environment});
        await receipt(await wallet.writeContract({address: MOCK_USDC.address, abi: tokenArtifact.abi, functionName: "mint", args: [payer.address, 10n * ARCADE_TICKET_AMOUNT]}));
        const tokenAbi = parseAbi(["function balanceOf(address) view returns(uint256)"]);
        const balance = (address: `0x${string}`) => client.readContract({address: MOCK_USDC.address, abi: tokenAbi, functionName: "balanceOf", args: [address]});
        const policy = {...buildD3Policies(payTo)["open-agent"], periodAmount: 2n * ARCADE_TICKET_AMOUNT, lifetimeTotalAmount: 4n * ARCADE_TICKET_AMOUNT,
            periodDurationSeconds: 3600, expiresAfterSeconds: 10800};
        const unsigned = preparePeriodDelegation({environment, delegator: payer.address, delegate: agent.address, policy, startDate: Number((await client.getBlock()).timestamp) - 1});
        const signed = await payer.signDelegation({delegation: unsigned, chainId: giwaSepolia.id});
        await Bun.write(parentPath, JSON.stringify({permissionContext: encodeDelegations([withDelegationSignature(unsigned, signed)])}));
        const forkEnv = {GIWA_SEPOLIA_RPC_URL: rpc, ARCADE_PAY_TO: payTo, FRAMEWORK_ADMIN_ADDRESS: admin.address,
            DELEGATION_DEPLOYMENT_PATH: deploymentPath, DELEGATION_MANIFEST_PATH: manifestPath, PARENT_PERMISSION_CONTEXT_PATH: parentPath, AGENT_PRIVATE_KEY: agentKey};
        const options = await createFork(store, forkEnv);
        const service = createPayments(store, admissions, options);
        const initial = await balance(payer.address);
        const requestId = crypto.randomUUID();
        const ticket = await service.buy("race", requestId);
        assert.equal(ticket.source, "mapae-fork");
        assert.equal(ticket.ticket.status, "ready");
        assert.equal(await balance(payer.address), initial - ARCADE_TICKET_AMOUNT);
        assert.equal(await balance(payTo), ARCADE_TICKET_AMOUNT);
        assert.equal(await client.getBalance({address: payer.address}), 0n);
        assert.equal(store.orders.listBySeller("mapae-arcade").length, 1);
        assert.equal(store.settlements.get(store.orders.listBySeller("mapae-arcade")[0]!.paymentIntentId)?.terminal?.outcome, "settled");
        assert.deepEqual(await service.buy("race", requestId), ticket);
        assert.equal(await balance(payTo), ARCADE_TICKET_AMOUNT);
        const run = crypto.randomUUID();
        assert.equal(service.consume(ticket.ticket.id, run).ticket.status, "consumed");
        assert.equal(service.consume(ticket.ticket.id, run).ticket.runId, run);
        assert.throws(() => service.consume(ticket.ticket.id, crypto.randomUUID()), /ticket_already_consumed/);
        console.log("[arcade EVM] 402 → signed leaf → EVM transfer → journal/order → replay recovery → single consumption passed; payer gas=0");

        await service.buy("stamp", crypto.randomUUID());
        assert.equal(await balance(payTo), 2n * ARCADE_TICKET_AMOUNT);
        await assert.rejects(service.buy("shop", crypto.randomUUID()), /delegated payment was refused/);
        assert.equal(await balance(payTo), 2n * ARCADE_TICKET_AMOUNT);
        const noPreflight = createPayments(store, admissions, {...options, client: {...options.client, preflight: undefined}});
        await assert.rejects(noPreflight.buy("shop", crypto.randomUUID()), /delegated payment was refused/);
        assert.equal(await balance(payTo), 2n * ARCADE_TICKET_AMOUNT);
        console.log("[arcade EVM] signed parent spending cap rejects the third ticket, including with client preflight disabled");

        // A separately signed fresh grant isolates the unresolved-receipt scenario from the intentionally exhausted first grant.
        const fresh = preparePeriodDelegation({environment, delegator: payer.address, delegate: agent.address, policy,
            salt: keccak256(toBytes("arcade-unknown-receipt-scenario")), startDate: Number((await client.getBlock()).timestamp) - 1});
        await Bun.write(parentPath, JSON.stringify({permissionContext: encodeDelegations([withDelegationSignature(fresh, await payer.signDelegation({delegation: fresh, chainId: giwaSepolia.id}))])}));
        const pendingOptions = await createFork(store, forkEnv);
        const pendingService = createPayments(store, admissions, pendingOptions);
        const unknownId = crypto.randomUUID();
        await mutate("evm_setAutomine", [false]);
        console.log("[arcade EVM] mining paused; checking an actually submitted transaction with no receipt (20s bounded wait)");
        await assert.rejects(pendingService.buy("shop", unknownId), /Settlement is unresolved/);
        const unresolved = admissions.reserve(unknownId, "shop").admission;
        assert.equal(unresolved.status, "unknown");
        assert.equal(store.settlements.get(unresolved.intent as Hex)?.terminal, null);
        assert.equal(await balance(payTo), 2n * ARCADE_TICKET_AMOUNT);
        await assert.rejects(pendingService.buy("race", crypto.randomUUID()), /unresolved_payment/);
        assert.throws(() => pendingService.consume(unresolved.id, crypto.randomUUID()), /no confirmed order/);
        await mutate("evm_mine", []);
        await mutate("evm_setAutomine", [true]);
        const reconciled = await pendingService.buy("shop", unknownId);
        assert.equal(reconciled.ticket.status, "ready");
        assert.equal(await balance(payTo), 3n * ARCADE_TICKET_AMOUNT);
        assert.equal(await balance(payer.address), initial - 3n * ARCADE_TICKET_AMOUNT);
        assert.equal(await client.getBalance({address: payer.address}), 0n);
        assert.deepEqual(await pendingService.buy("shop", unknownId), reconciled);
        assert.equal(await balance(payTo), 3n * ARCADE_TICKET_AMOUNT);
        console.log("[arcade EVM] missing receipt blocked admission/recharge; mining then same-request reconciliation recovered exactly one ticket");
        console.log("[arcade EVM] PASS (local Anvil only; no upstream RPC or GIWA broadcast)");
    } finally {
        store.close(); admissions.close(); anvil.kill(); await anvil.exited; rmSync(dir, {recursive: true, force: true});
    }
}

if (import.meta.main) main().catch((error: unknown) => {
    console.error("[arcade EVM] FAILED", redactForLog(error));
    process.exitCode = 1;
});
