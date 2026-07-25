import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {WagmiProvider} from "wagmi";
import App from "./App";
import {wagmiConfig} from "./wagmi";
import "./styles.css";

const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: 1, refetchOnWindowFocus: false}},
});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
    // WagmiProvider wraps QueryClientProvider's *children*, not the other way round:
    // wagmi's hooks are built on TanStack Query, so the query client has to be above them.
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <WagmiProvider config={wagmiConfig}>
                <App />
            </WagmiProvider>
        </QueryClientProvider>
    </StrictMode>,
);
