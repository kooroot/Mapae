import {expect, test} from "bun:test";
import {isValidElement, type ReactElement, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {SessionGrant} from "../lib/grant";
import {LocaleProvider} from "../lib/locale";
import {AgentGrantList, DesktopInstall} from "./AgentGrantList";

const privateKey = `0x${"a7".repeat(32)}` as const;
const permissionContext = `0x${"5c".repeat(40)}` as const;
const base = {
    id: "grant-1",
    name: "Shopper",
    source: "signed",
    artifact: {permissionContext, delegate: "0x00000000000000000000000000000000000000d1"},
} as unknown as SessionGrant;
const withKey = {...base, agentKey: {privateKey, address: "0x00000000000000000000000000000000000000d1"}} as SessionGrant;

function card(grant: SessionGrant, locale: "ko" | "en"): string {
    return renderToStaticMarkup(
        <LocaleProvider initial={locale}>
            <AgentGrantList grants={[grant]} selectedContext="" onSelect={() => {}} onCreate={() => {}} onForget={() => {}} onRecover={async () => {}} recovering={false} />
        </LocaleProvider>,
    );
}

function buttons(node: ReactNode, found: ReactElement<Record<string, unknown>>[] = []) {
    if (Array.isArray(node)) for (const child of node) buttons(child, found);
    else if (isValidElement<Record<string, unknown>>(node)) {
        if (node.type === "button") found.push(node);
        buttons(node.props.children as ReactNode, found);
    }
    return found;
}

test("the agent card offers the Desktop download and both paste buttons, in ko and en", () => {
    const ko = card(withKey, "ko");
    expect(ko).toContain('href="/mapae.mcpb" download="mapae.mcpb"');
    expect(ko).toContain("Claude Desktop에 설치");
    expect(ko).toContain("① 에이전트 키 복사");
    expect(ko).toContain("② 권한 코드 복사");
    expect(ko).toContain("MCP 연결 번들 복사");
    expect(ko).not.toMatch(/data-copy="agent-key"[^>]*disabled/);
    const en = card(withKey, "en");
    expect(en).toContain("Install in Claude Desktop");
    expect(en).toContain("① Copy agent key");
    expect(en).toContain("② Copy permission code");
    expect(ko).not.toContain(privateKey.slice(2));
});

test("without the agent key the key button is disabled and the download stays", () => {
    const html = card(base, "en");
    expect(html).toContain('href="/mapae.mcpb" download="mapae.mcpb"');
    expect(html).toMatch(/<button[^>]*data-copy="agent-key"[^>]*disabled=""/);
    expect(html).toContain("held only in the tab that created it");
});

test("the two buttons write exactly the key hex and exactly the permission code", async () => {
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {configurable: true, value: {clipboard: {writeText: async (text: string) => void written.push(text)}}});
    try {
        const copied: string[] = [];
        const tree = DesktopInstall({grant: withKey, locale: "en", copied: undefined, onCopied: (tag) => copied.push(tag), onFault: () => {}});
        const [keyButton, codeButton] = buttons(tree);
        expect(keyButton?.props["data-copy"]).toBe("agent-key");
        expect(codeButton?.props["data-copy"]).toBe("permission-code");
        (keyButton?.props.onClick as () => void)();
        (codeButton?.props.onClick as () => void)();
        await Promise.resolve(); await Promise.resolve();
        expect(written).toEqual([privateKey, permissionContext]);
        expect(copied).toEqual(["desktop-key:grant-1", "desktop-code:grant-1"]);
    } finally {
        if (original) Object.defineProperty(globalThis, "navigator", original);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});
