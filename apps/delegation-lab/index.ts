import {
    DELEGATION_FRAMEWORK_VERSION,
    ENTRY_POINT_V07,
    OWNER_ACCOUNT_SALT,
    buildFrameworkOwnershipAcceptance,
    buildD3Policies,
    parseDeploymentArtifactJson,
} from "@mapae/delegation";
import {Implementation} from "@metamask/smart-accounts-kit";
import {getCounterfactualAccountData} from "@metamask/smart-accounts-kit/utils";
import {fromTokenAmount, giwaSepolia, redactForLog} from "@mapae/shared";
import {readD3IdentityConfig, readExpectedSignerAddress} from "./runtime-config.js";

async function printPlan(): Promise<void> {
    const identities = readD3IdentityConfig();
    const deployer = readExpectedSignerAddress("DEPLOYER_ADDRESS");
    const relayer = readExpectedSignerAddress("FACILITATOR_SIGNER_ADDRESS");
    const policies = buildD3Policies(identities.case2Vendor);
    const sessionFile = Bun.file("../../deployments/d3-session-addresses.json");
    const sessionAddresses = (await sessionFile.exists())
        ? ((await sessionFile.json()) as Record<string, string>)
        : "not generated";
    console.log(
        JSON.stringify(
            {
                status: "PRE_DEPLOYMENT_REVIEW",
                broadcastEnabled: false,
                chain: {name: giwaSepolia.name, id: giwaSepolia.id},
                framework: {
                    version: DELEGATION_FRAMEWORK_VERSION,
                    entryPoint: ENTRY_POINT_V07,
                    environment: "not deployed",
                },
                operationalIdentities: {
                    frameworkDeployer: deployer,
                    settlementRelayer: relayer,
                    frameworkAdmin: identities.frameworkAdmin,
                },
                caseIdentities: {
                    case1Owner: identities.case1Owner,
                    case2Vendor: identities.case2Vendor,
                },
                delegatedSessionAddresses: sessionAddresses,
                ownerAccountSalt: OWNER_ACCOUNT_SALT,
                policies: Object.fromEntries(
                    Object.entries(policies).map(([role, policy]) => [
                        role,
                        {
                            periodAmount: fromTokenAmount(policy.periodAmount),
                            token: policy.token,
                            periodDurationSeconds: policy.periodDurationSeconds,
                            expiresAfterSeconds: policy.expiresAfterSeconds,
                            recipient: policy.recipient ?? "dynamic",
                        },
                    ]),
                ),
                nextActionsAfterReview: [
                    "deploy Framework v1.3 to GIWA",
                    "deploy owner HybridDeleGator account",
                    "sign root permissions with the account-owner wallet",
                ],
            },
            null,
            2,
        ),
    );
}

async function readDeployment(path: string) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`deployment artifact not found: ${path}`);
    return parseDeploymentArtifactJson(await file.text());
}

async function main(): Promise<void> {
    const command = process.argv[2] ?? "plan";
    if (command === "plan") {
        await printPlan();
        return;
    }

    if (command === "ownership-acceptance") {
        const bootstrapPath =
            process.argv[3] ??
            process.env.DELEGATION_BOOTSTRAP_PATH ??
            "../../deployments/giwa-sepolia.framework.bootstrap.json";
        const bootstrap = await readDeployment(bootstrapPath);
        if (bootstrap.state !== "ownership-pending") {
            throw new Error("ownership acceptance requires an ownership-pending artifact");
        }
        const transaction = buildFrameworkOwnershipAcceptance(
            bootstrap.environment.DelegationManager,
        );
        console.log(
            JSON.stringify(
                {
                    from: bootstrap.admin.pendingOwner,
                    ...transaction,
                    value: "0x0",
                    note: "Review and submit from the Framework-admin wallet; no private key is requested here.",
                },
                null,
                2,
            ),
        );
        return;
    }

    const path =
        process.argv[3] ??
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const deployment = await readDeployment(path);

    if (command === "validate-deployment") {
        console.log(
            JSON.stringify(
                {
                    ok: true,
                    chainId: deployment.chainId,
                    state: deployment.state,
                    compositionId: deployment.compositionId,
                    frameworkVersion: deployment.frameworkVersion,
                    delegationManager: deployment.environment.DelegationManager,
                },
                null,
                2,
            ),
        );
        return;
    }

    if (command === "derive-owner") {
        if (deployment.state !== "active") {
            throw new Error("owner account derivation requires an active Framework artifact");
        }
        const identities = readD3IdentityConfig();
        const result = await getCounterfactualAccountData({
            factory: deployment.environment.SimpleFactory,
            implementations: deployment.environment.implementations,
            implementation: Implementation.Hybrid,
            deployParams: [identities.case1Owner, [], [], []],
            deploySalt: OWNER_ACCOUNT_SALT,
        });
        console.log(
            JSON.stringify(
                {
                    owner: identities.case1Owner,
                    smartAccount: result.address,
                    deployed: false,
                    factory: result.factoryData,
                },
                null,
                2,
            ),
        );
        return;
    }

    throw new Error(`unknown command "${command}"`);
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
