import {parseD3IdentityConfig, type D3IdentityConfig} from "@mapae/delegation";

/** Load public D3 role addresses without baking user-specific identities into source. */
export function readD3IdentityConfig(): D3IdentityConfig {
    return parseD3IdentityConfig({
        accountOwner: process.env.ACCOUNT_OWNER_ADDRESS,
        frameworkAdmin: process.env.FRAMEWORK_ADMIN_ADDRESS,
        fixedVendor: process.env.FIXED_VENDOR_ADDRESS,
    });
}
