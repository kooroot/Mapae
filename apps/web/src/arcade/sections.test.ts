import {describe, expect, test} from "bun:test";
import {ARCADE_SECTIONS, arcadeSectionFromParam, arcadeSectionFromPath, arcadeSectionPath, isArcadeSubsection, outingStatusLabel, SECTION_COPY} from "./sections";

describe("arcade sections", () => {
    test("reads the section from a pathname in either locale", () => {
        expect(arcadeSectionFromPath("/arcade")).toBe("lobby");
        expect(arcadeSectionFromPath("/arcade/")).toBe("lobby");
        expect(arcadeSectionFromPath("/ko/arcade")).toBe("lobby");
        expect(arcadeSectionFromPath("/arcade/outings")).toBe("outings");
        expect(arcadeSectionFromPath("/ko/arcade/wallet")).toBe("wallet");
        expect(arcadeSectionFromPath("/ko/arcade/journal/")).toBe("journal");
        expect(arcadeSectionFromPath("/arcade/ranking")).toBe("ranking");
    });

    test("anything else is not an arcade page", () => {
        for (const path of ["/", "/ko", "/arcadex", "/arcade/nope", "/arcade/lobby", "/arcade/wallet/extra", "/korea/arcade", "/app"]) {
            expect(arcadeSectionFromPath(path)).toBeNull();
        }
    });

    test("the lobby is the bare path; sub-sections round-trip in both locales", () => {
        expect(arcadeSectionPath("lobby", "en")).toBe("/arcade");
        expect(arcadeSectionPath("lobby", "ko")).toBe("/ko/arcade");
        for (const section of ARCADE_SECTIONS) {
            for (const locale of ["en", "ko"] as const) expect(arcadeSectionFromPath(arcadeSectionPath(section, locale))).toBe(section);
        }
        expect(arcadeSectionPath("wallet", "ko")).toBe("/ko/arcade/wallet");
    });

    test("route params name only the five sub-sections", () => {
        expect(ARCADE_SECTIONS.filter(isArcadeSubsection)).toEqual(["guardians", "outings", "ranking", "journal", "wallet"]);
        expect(isArcadeSubsection("guardians")).toBe(true);
        expect(isArcadeSubsection("lobby")).toBe(false);
        expect(isArcadeSubsection("arcade-icon.png")).toBe(false);
        expect(arcadeSectionFromParam(undefined)).toBe("lobby");
        expect(arcadeSectionFromParam("journal")).toBe("journal");
    });

    test("every section has copy in both locales and only known outing states get a label", () => {
        for (const locale of ["en", "ko"] as const) {
            for (const section of ARCADE_SECTIONS) expect(SECTION_COPY[locale][section].label.length).toBeGreaterThan(0);
        }
        expect(outingStatusLabel("running", "ko")).toBe("외출 중");
        expect(outingStatusLabel("complete", "en")).toBeNull();
    });
});
