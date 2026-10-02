import {test, expect} from "bun:test";
import {healthDeadline, paymentReady} from "./health";
test("readiness requires framework, writable journal, funding and remaining budget", () => {
    expect(paymentReady(true, true, 1n, 1n)).toBe(true);
    expect(paymentReady(false, true, 1n, 1n)).toBe(false);
    expect(paymentReady(true, false, 1n, 1n)).toBe(false);
    expect(paymentReady(true, true, undefined, 1n)).toBe(false);
    expect(paymentReady(true, true, 0n, 1n)).toBe(false);
    expect(paymentReady(true, true, 1n, 0n)).toBe(false);
});
test("a stalled RPC cannot hold the readiness request open indefinitely", async () => {
    await expect(healthDeadline(new Promise(() => {}), 5)).rejects.toThrow("health_timeout");
    expect(await healthDeadline(Promise.resolve(true), 5)).toBe(true);
});
