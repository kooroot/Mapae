import {describe, expect, test} from "bun:test";
import {findStorageWrites, STORE_MODULE} from "./check-storage";

describe("findStorageWrites", () => {
    test("flags a localStorage write", () => {
        const found = findStorageWrites(`window.localStorage.setItem("k", v);`);
        expect(found).toHaveLength(1);
        expect(found[0]?.api).toBe("localStorage");
    });

    test("flags the bare global too, not only the window-qualified form", () => {
        // `localStorage.setItem(...)` is the shorter and likelier spelling.
        expect(findStorageWrites(`localStorage.setItem("k", v);`)).toHaveLength(1);
    });

    test("flags sessionStorage and indexedDB", () => {
        expect(findStorageWrites(`sessionStorage.setItem("k", v)`)[0]?.api).toBe(
            "sessionStorage",
        );
        expect(findStorageWrites(`indexedDB.open("db")`)[0]?.api).toBe("indexedDB");
    });

    test("flags a cookie write, which is storage by another name", () => {
        expect(findStorageWrites(`document.cookie = "a=b";`)[0]?.api).toBe("document.cookie");
    });

    test("reading is not writing — a read cannot leak what was never put there", () => {
        // getItem/key/length are reads. The invariant is about what reaches the disk.
        expect(findStorageWrites(`const raw = localStorage.getItem("k");`)).toEqual([]);
        expect(findStorageWrites(`if (window.localStorage) {}`)).toEqual([]);
    });

    test("removal is allowed — forgetting is the mitigation, not the risk", () => {
        expect(findStorageWrites(`localStorage.removeItem("k")`)).toEqual([]);
    });

    test("a mention inside a comment or string is not a call", () => {
        expect(findStorageWrites(`// never localStorage.setItem here`)).toEqual([]);
        expect(findStorageWrites(`const note = "localStorage.setItem is refused";`)).toEqual([]);
    });

    test("the sanctioned module is named, and it is the grant store", () => {
        // If this moves, the allowance moves with it deliberately — a renamed file must
        // not silently inherit permission to write secrets to disk.
        expect(STORE_MODULE).toBe("apps/web/src/lib/grant-store.ts");
    });
});
