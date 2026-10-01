import {describe, expect, test} from "bun:test";
import {openArcadeStore} from "@mapae/store/arcade";
import type {AgentDecisionRequest} from "@mapae/arcade";
import {createModel, limitedJson, modelConfig, parseDecisionRequest, validAction} from "./model.js";
import {paymentMode} from "./index.js";
const request: AgentDecisionRequest = {kind: "race", locale: "ko", profile: {name: "말랑", color: "jade", temperament: "calm", goal: "save"}, observation: {budget: 2}};
const config = modelConfig({ARCADE_MODEL_PROVIDER: "ollama", ARCADE_MODEL: "local-test"});
describe("actual model boundary", () => {
    test("no model credentials defaults to a visible unavailable error, never rules", async () => {
        const store = openArcadeStore(":memory:");
        try {
            const model = createModel(modelConfig({}), store, (() => {throw new Error("must not fetch");}) as unknown as typeof fetch);
            expect(model.status().configured).toBe(false);
            await expect(model.decide(request)).rejects.toMatchObject({code: "model_unconfigured"});
        } finally {store.close();}
    });
    test("remote credentials require explicit paid opt in and can only go to OpenAI", () => {
        expect(() => modelConfig({ARCADE_MODEL_PROVIDER: "openai", ARCADE_MODEL: "gpt-4.1-mini", OPENAI_API_KEY: "test"})).toThrow();
        expect(() => modelConfig({ARCADE_MODEL_PROVIDER: "openai", ARCADE_MODEL: "gpt-4.1-mini", OPENAI_API_KEY: "test", ARCADE_ALLOW_PAID_MODEL: "true", ARCADE_MODEL_BASE_URL: "https://evil.test"})).toThrow();
        expect(() => modelConfig({ARCADE_MODEL_PROVIDER: "ollama", ARCADE_MODEL: "model", ARCADE_MODEL_BASE_URL: "http://evil.test"})).toThrow();
        expect(() => modelConfig({ARCADE_MODEL_PROVIDER: "ollama", ARCADE_MODEL: "model", ARCADE_MODEL_MAX_CALLS: "0"})).toThrow();
        expect(paymentMode({})).toBe("disabled");
        expect(() => paymentMode({ARCADE_PAYMENT_MODE: "live"})).toThrow();
        expect(() => paymentMode({ARCADE_PAYMENT_MODE: "fork", GIWA_SEPOLIA_RPC_URL: "https://sepolia-rpc.giwa.io", FACILITATOR_URL: "http://127.0.0.1:8081", ARCADE_ALLOW_LOCAL_FORK: "true"})).toThrow();
    });
    test("real response path uses server model provenance and bounded provider configuration", async () => {
        const store = openArcadeStore(":memory:");
        try {
            let captured: RequestInit | undefined;
            const model = createModel(config, store, (async (_url: unknown, init?: RequestInit) => {
                captured = init;
                return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({action: {enter: true, strategy: "conserve"}, explanation: "힘을 아껴요."})}}]});
            }) as unknown as typeof fetch);
            expect(await model.decide(request)).toEqual({source: "llm", model: "local-test", action: {enter: true, strategy: "conserve"}, explanation: "힘을 아껴요."});
            expect(captured?.redirect).toBe("error");
            const body = JSON.parse(String(captured?.body));
            expect(body.max_tokens).toBe(800);
            expect(body.response_format.type).toBe("json_schema");
            expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
            expect(body.response_format.json_schema.schema.properties.action.properties.strategy.enum).toEqual(["burst", "conserve", "surge"]);
            expect(model.status().remainingCalls).toBe(59);
            // A cached outing can finish in under 100ms; the immediately following game strategy must still run.
            expect((await model.decide(request)).source).toBe("llm");
            expect(model.status().remainingCalls).toBe(58);
        } finally {store.close();}
    });
    test("malformed model action fails without executing or substituting rules", async () => {
        const store = openArcadeStore(":memory:");
        try {
            const model = createModel(config, store, (async () => Response.json({choices: [{finish_reason: "stop", message: {content: '{"action":{"enter":true,"strategy":"cheat"},"explanation":"secret"}'}}]})) as unknown as typeof fetch);
            await expect(model.decide(request)).rejects.toMatchObject({code: "invalid_model_output"});
        } finally {store.close();}
    });
    test("provider errors never reflect keys, URLs or bodies", async () => {
        const store = openArcadeStore(":memory:");
        try {
            const model = createModel(config, store, (async () => {throw new Error("SECRET sk-123 http://private/path/key");}) as unknown as typeof fetch);
            await expect(model.decide(request)).rejects.toMatchObject({code: "model_unavailable"});
            try {await model.decide(request);} catch (error) {expect(String(error)).not.toContain("SECRET");}
        } finally {store.close();}
    });
    test("daily model budget counts failed attempts too", async () => {
        const store = openArcadeStore(":memory:");
        try {
            store.reserveModelCall(new Date().toISOString().slice(0, 10), 1);
            const model = createModel({...config, maxCalls: 1}, store, (() => {throw new Error("must not fetch");}) as unknown as typeof fetch);
            await expect(model.decide(request)).rejects.toMatchObject({code: "model_budget_exhausted"});
        } finally {store.close();}
    });
    test("request schema rejects forged profile, extra top-level fields and deep payloads", () => {
        expect(parseDecisionRequest(request)).toEqual(request);
        expect(() => parseDecisionRequest({...request, apiKey: "not allowed"})).toThrow();
        expect(() => parseDecisionRequest({...request, profile: {...request.profile, name: "x".repeat(100)}})).toThrow();
        expect(() => parseDecisionRequest({...request, observation: {n: NaN}})).toThrow();
    });
    test("every role has a closed action schema and buyers have no public free text", () => {
        expect(validAction("outing", {enter: true, game: "shop", rounds: 3})).toBe(true);
        expect(validAction("outing", {enter: true, game: "shop", rounds: 4})).toBe(false);
        expect(validAction("stamp", {tempo: "quick"})).toBe(true);
        expect(validAction("stamp", {tempo: "quick", balance: 999})).toBe(false);
        expect(validAction("shop-buyer", {type: "request", wants: ["water"], reason: "need"})).toBe(true);
        expect(validAction("shop-buyer", {type: "request", reason: "need", message: "balance=999"})).toBe(false);
        expect(validAction("shop-seller", {type: "offer", message: "묶음", items: [{id: "water", quantity: 2}], price: 4})).toBe(true);
        expect(validAction("shop-seller", {type: "offer", message: "묶음", items: [{id: "water", quantity: 2}, {id: "water", quantity: 1}], price: 4})).toBe(false);
        expect(validAction("shop-seller", {type: "close", message: "끝", price: 1})).toBe(false);
    });
    test("bounded streaming does not trust Content-Length", async () => {
        await expect(limitedJson(new Response('"' + "x".repeat(40_000) + '"', {headers: {"content-length": "2"}}))).rejects.toMatchObject({code: "response_too_large"});
    });
});
