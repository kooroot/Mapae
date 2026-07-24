import {parseD3IdentityConfig, type D3IdentityConfig} from "@mapae/delegation";
import {getAddress, isAddress, zeroAddress, type Address} from "viem";

/** Load public D3 role addresses without baking user-specific identities into source. */
export function readD3IdentityConfig(): D3IdentityConfig {
    return parseD3IdentityConfig({
        case1Owner: process.env.CASE_1_OWNER_ADDRESS,
        case2Vendor: process.env.CASE_2_VENDOR_ADDRESS,
        frameworkAdmin: process.env.FRAMEWORK_ADMIN_ADDRESS,
    });
}

/** Read a public expected signer address used to reject a wrong private key. */
export function readExpectedSignerAddress(name: "DEPLOYER_ADDRESS" | "RELAYER_ADDRESS"): Address {
    const value = process.env[name]?.trim() ?? "";
    if (!isAddress(value)) throw new Error(`${name} must be an EVM address`);
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error(`${name} must not be zero`);
    return address;
}
