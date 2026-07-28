import {Link} from "@tanstack/react-router";
import {useEffect, useState} from "react";
import {formatEther} from "viem";
import {Lockup, Wordmark} from "../brand/marks";
import {accounts, publicClient} from "../lib/config";

export function Nav() {
    return (
        <header className="nav">
            <div className="wrap nav-inner">
                <Link to="/" aria-label="Mapae 홈">
                    <Lockup />
                </Link>
                <nav className="nav-links">
                    <a href="/#how">작동 방식</a>
                    <a href="/#engraved">새겨진 것</a>
                    <a href="/#evidence">증거</a>
                </nav>
                <Link to="/app" className="btn">
                    콘솔 열기
                </Link>
            </div>
        </header>
    );
}

/**
 * The payer's native balance, read from the chain.
 *
 * This is the one number on the landing page that is fetched rather than
 * written, and it is fetched precisely because it is the product's central
 * claim: the account that holds the funds holds no gas, and the relayer carries
 * every transaction. A zero you can watch arrive is evidence; a zero typed into
 * a marketing page is a slogan.
 *
 * It renders a skeleton until it has an answer and never a literal `0` before
 * one. A prerendered `0` that later turns out to be wrong is worse than no
 * number at all — the visitor has already read it, and the correction arrives
 * after they have moved on.
 */
export function PayerGas() {
    const [state, setState] = useState<
        {kind: "loading"} | {kind: "ok"; wei: bigint} | {kind: "unreachable"}
    >({kind: "loading"});

    useEffect(() => {
        let live = true;
        publicClient
            .getBalance({address: accounts.payer})
            .then((wei) => live && setState({kind: "ok", wei}))
            .catch(() => live && setState({kind: "unreachable"}));
        return () => {
            live = false;
        };
    }, []);

    if (state.kind === "loading") {
        return <span className="numeral skeleton" aria-hidden="true" />;
    }
    if (state.kind === "unreachable") {
        return (
            <span className="numeral dim" title="GIWA 노드에 닿지 못했습니다">
                —
            </span>
        );
    }
    return (
        <span className="numeral">
            {formatEther(state.wei)}
            <span className="numeral-unit">ETH</span>
        </span>
    );
}

export function Footer() {
    return (
        <footer className="foot">
            <div className="wrap foot-inner">
                <div>
                    <Wordmark height={20} />
                    <p className="label foot-motto">
                        마패는 특권의 증표가 아니라 <span style={{color: "var(--ink)"}}>한계의 증표다</span>.
                        새겨진 말의 수는 권한이 끝나는 지점이었다.
                    </p>
                </div>
                <div className="label">
                    <p>GIWA Sepolia · eip155:91342</p>
                    <p>테스트넷 자산으로만 동작합니다.</p>
                </div>
            </div>
        </footer>
    );
}
