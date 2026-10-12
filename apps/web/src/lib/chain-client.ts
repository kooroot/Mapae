import {parseActiveDeploymentArtifactJson} from "@mapae/delegation/config";
import frameworkArtifact from "../../../../deployments/giwa-sepolia.framework.json";
import {createPublicClient, http} from "viem";
import {chain, rpcUrl} from "./config";

// Only chain-reading screens instantiate this client; the document and landing do not.
export const publicClient = createPublicClient({chain, transport: http(rpcUrl)});

/**
 * The committed deployment artifact is the source of truth for enforcer and
 * manager addresses. `docs/deployed-contracts.md` mirrors it for humans; code
 * reads the JSON so the two cannot drift apart silently.
 */
export const deployment = parseActiveDeploymentArtifactJson(JSON.stringify(frameworkArtifact));

