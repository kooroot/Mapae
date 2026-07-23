import {
    DELEGATION_FRAMEWORK_VERSION,
    ENTRY_POINT_V07,
    OWNER_ACCOUNT_SALT,
    buildD3Policies,
    parseDeploymentArtifactJson,
} from "@mapae/delegation";
import {Implementation} from "@metamask/smart-accounts-kit";
import {getCounterfactualAccountData} from "@metamask/smart-accounts-kit/utils";
import {fromTokenAmount, giwaSepolia} from "@mapae/shared";
import {readD3IdentityConfig} from "./runtime-config.js";

async function printPlan(): Promise<void> {
    const identities = readD3IdentityConfig();
    const policies = buildD3Policies(identities.fixedVendor);
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
                identities,
                sessionAddresses,
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
        const identities = readD3IdentityConfig();
        const result = await getCounterfactualAccountData({
            factory: deployment.environment.SimpleFactory,
            implementations: deployment.environment.implementations,
            implementation: Implementation.Hybrid,
            deployParams: [identities.accountOwner, [], [], []],
            deploySalt: OWNER_ACCOUNT_SALT,
        });
        console.log(
            JSON.stringify(
                {
                    owner: identities.accountOwner,
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
