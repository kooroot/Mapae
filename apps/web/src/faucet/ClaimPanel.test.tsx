import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {NextSteps} from "./ClaimPanel";

test("ETH leads to the guardian draw and the stablecoin to an outing's allowance, Studio second, in the reader's language", () => {
    const eth = renderToStaticMarkup(<NextSteps kind="eth" locale="ko" />);
    expect(eth).toContain('class="fct-action fct-action-primary" href="https://mapae.io/ko/arcade/guardians"');
    expect(eth).toContain("전령 뽑으러 가기");
    expect(eth.indexOf("fct-action-primary")).toBeLessThan(eth.indexOf("fct-action-secondary"));
    const musdc = renderToStaticMarkup(<NextSteps kind="musdc" locale="en" />);
    expect(musdc).toContain('href="https://mapae.io/arcade/outings#arcade-allowance"');
    expect(musdc).toContain("Give an allowance in the arcade");
    expect(musdc).toContain('class="fct-action fct-action-secondary" href="https://app.mapae.io/"');
});
