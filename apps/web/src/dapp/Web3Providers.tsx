import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {type ReactNode} from "react";
import {WagmiProvider} from "wagmi";
import {wagmiConfig} from "../lib/wagmi";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

export function Web3Providers({children}: {children: ReactNode}) {
    return (
        <QueryClientProvider client={queryClient}>
            <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
        </QueryClientProvider>
    );
}
