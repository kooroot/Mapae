import {x402Client} from "@x402/core/client";
import type {SchemeNetworkServer} from "@x402/core/types";
import {x402Erc7710Client, x402ExactEvmErc7710ServerScheme} from "@metamask/x402";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC} from "@mapae/shared";
import {assertErc7710Offer, type DelegatedLeafProvider} from "../src/payment-client.js";

/**
 * Reference-stack integration, separate from Mapae's hosted seller and agent runtime.
 * MetaMask supplies the ERC-7710 wire implementation; this profile declares the
 * settlement order required by Mapae. The upstream EVM class's flow table currently
 * describes EIP-3009/Permit2 only, even in its MetaMask ERC-7710 subclass.
 */
export function createMapaeReferenceScheme(): SchemeNetworkServer {
    const evm = new x402ExactEvmErc7710ServerScheme();
    return {
        scheme: "exact",
        defaultAssetTransferMethod: "erc7710",
        paymentFlows: {erc7710: {supported: ["upfront"], default: "upfront"}},
        parsePrice: (price, network) => evm.parsePrice(price, network),
        enhancePaymentRequirements: (...args) => evm.enhancePaymentRequirements(...args),
    };
}

/** Explicit asset opt-in preserves the reference client's pre-signing spend controls. */
export function createMapaeReferenceClient(
    provider: DelegatedLeafProvider,
    maxAmountPerPayment: bigint,
): x402Client {
    if (maxAmountPerPayment <= 0n) throw new Error("maxAmountPerPayment must be positive");
    return new x402Client()
        .register(GIWA_SEPOLIA_CAIP2, new x402Erc7710Client({
            delegationProvider: (requirements) => provider(assertErc7710Offer(requirements)),
        }))
        .setSpendControls({
            allowedAssets: [{
                network: GIWA_SEPOLIA_CAIP2,
                asset: MOCK_USDC.address,
                maxAmountPerPayment: maxAmountPerPayment.toString(),
            }],
        });
}
