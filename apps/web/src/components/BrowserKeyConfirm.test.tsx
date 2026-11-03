import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {BrowserKeyRequestSummary, confirmInPage} from "./BrowserKeyConfirm";

test("the summary names the SIWE domain and URI, the typed-data type and contract, and a transaction's to and value", () => {
    const message = renderToStaticMarkup(<BrowserKeyRequestSummary locale="ko" request={{kind: "message", domain: "mapae.io", uri: "https://mapae.io/arcade", message: "…"}} />);
    expect(message).toContain("사이트"); expect(message).toContain("mapae.io"); expect(message).toContain("https://mapae.io/arcade");
    const typed = renderToStaticMarkup(<BrowserKeyRequestSummary locale="en" request={{kind: "typed", primaryType: "Delegation", verifyingContract: "0x0000000000000000000000000000000000000011"}} />);
    expect(typed).toContain("Delegation"); expect(typed).toContain("Verifying contract"); expect(typed).toContain("0x0000000000000000000000000000000000000011");
    const tx = renderToStaticMarkup(<BrowserKeyRequestSummary locale="en" request={{kind: "transaction", to: "0x000000000000000000000000000000000000bEEF", valueEth: "0.0005"}} />);
    expect(tx).toContain("0x000000000000000000000000000000000000bEEF"); expect(tx).toContain("0.0005 ETH");
});

test("without a DOM the page confirm declines", async () => {
    expect(await confirmInPage({kind: "transaction", valueEth: "1"})).toBe(false);
});
