import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {WalletPickerOptions} from "./BrowserKeyEntry";

const base = {busy: false, selected: "", error: "", mobileHref: "https://link.metamask.io/dapp/mapae.io/arcade"};
const browserKey = {busy: false, exportState: "idle" as const};

test("with no wallet detected: play-without-installing, the storage warning, export and the MetaMask link render in ko and en", () => {
    const ko = renderToStaticMarkup(<WalletPickerOptions locale="ko" wallets={[]} browserKey={browserKey} {...base} />);
    expect(ko).toContain("설치 없이 바로 놀기");
    expect(ko).toContain("키는 이 브라우저에만 보관돼요. 사이트 데이터를 지우면 사라지니");
    expect(ko).toContain("키 내보내기");
    expect(ko).toContain('href="https://link.metamask.io/dapp/mapae.io/arcade"'); expect(ko).toContain("MetaMask 앱으로 열기");
    const en = renderToStaticMarkup(<WalletPickerOptions locale="en" wallets={[]} browserKey={browserKey} {...base} />);
    expect(en).toContain("Play without installing");
    expect(en).toContain("lost if site data is cleared");
    expect(en).toContain("Export key");
    expect(en).toContain('href="https://link.metamask.io/dapp/mapae.io/arcade"'); expect(en).toContain("Open in MetaMask");
});

test("export asks before copying", () => {
    const html = renderToStaticMarkup(<WalletPickerOptions locale="en" wallets={[]} browserKey={{busy: false, exportState: "confirm"}} {...base} />);
    expect(html).toContain("Anyone with this key controls the wallet"); expect(html).toContain(">Copy<"); expect(html).toContain(">Cancel<");
    expect(html).not.toContain("Export key");
});

test("with an injected wallet detected the browser-key entry is absent and the injected wallet is listed", () => {
    for (const locale of ["ko", "en"] as const) {
        const html = renderToStaticMarkup(<WalletPickerOptions locale={locale} wallets={[{uid: "u1", label: locale === "ko" ? "이 브라우저의 지갑" : "Browser wallet"}]} browserKey={browserKey} {...base} />);
        expect(html).toContain(locale === "ko" ? "이 브라우저의 지갑" : "Browser wallet");
        for (const absent of ["설치 없이 바로 놀기", "Play without installing", "키 내보내기", "Export key", "arc-browser-key"]) expect(html).not.toContain(absent);
    }
});
