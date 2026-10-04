import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {getAddress, isAddress, type Address} from 'viem';
import type {OutingStatus} from '@mapae/arcade/outings';
import {OutingStore, fingerprint, publicJob} from './store';
import {ID, OutingError, parseStart, validatePermission} from './validation';
import type {OutingRunner} from './runner';

export const OUTING_BODY_LIMIT = 65_536;
export function createOutingApp(options: {token?: string; store?: OutingStore; runner?: OutingRunner;
    now?: () => number; validate?: typeof validatePermission}) {
    const app = new Hono<{Variables: {owner: Address}}>();
    const now = options.now ?? Date.now, validate = options.validate ?? validatePermission;
    const digest = (s: string) => createHash('sha256').update(s).digest();
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        if (!options.token || !timingSafeEqual(digest(c.req.header('Authorization') ?? ''), digest(`Bearer ${options.token}`))) return c.json({error: {code: 'unauthorized'}}, 401);
        const owner = c.req.header('X-Mapae-Owner');
        if (!owner || !isAddress(owner)) return c.json({error: {code: 'unauthorized'}}, 401);
        c.set('owner', getAddress(owner));
        await next();
    });
    const status = (owner: Address): OutingStatus => ({enabled: !!options.runner, agent: options.runner?.agent ?? null, jobs: options.store?.list(owner).map(publicJob) ?? []});
    app.get('/', c => c.json(status(c.get('owner'))));
    app.post('/', async c => {
        if (!options.runner || !options.store) throw new OutingError('disabled');
        const declared = Number(c.req.header('Content-Length') ?? 0);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > OUTING_BODY_LIMIT) return c.json({error: {code: 'invalid_request'}}, 413);
        if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw new OutingError('invalid_request');
        // The server also bounds the raw HTTP body. This streaming limit covers tests,
        // internal adapters and chunked requests without trusting Content-Length.
        const reader = c.req.raw.body?.getReader();
        if (!reader) throw new OutingError('invalid_request');
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {const {done, value} = await reader.read(); if (done) break; size += value.length;
            if (size > OUTING_BODY_LIMIT) {await reader.cancel(); return c.json({error: {code: 'invalid_request'}}, 413);} chunks.push(value);}
        let value: unknown;
        try {value = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new OutingError('invalid_request');}
        const start = parseStart(value), owner = c.get('owner'), prior = options.store.get(start.id);
        if (prior) {if (prior.fingerprint !== fingerprint(owner, start)) throw new OutingError('conflict'); return c.json(status(owner));}
        const permission = await validate(owner, start, options.runner.agent, now());
        options.store.insert(owner, start, permission, options.runner.agent, now());
        return c.json(status(owner), 201);
    });
    app.post('/:id/:action', c => {
        if (!options.runner) throw new OutingError('disabled');
        const {id, action} = c.req.param();
        if (!ID.test(id) || !['stop','resume'].includes(action)) throw new OutingError('invalid_request');
        options.runner.control(c.get('owner'), id, action as 'stop' | 'resume');
        return c.json(status(c.get('owner')));
    });
    app.onError(error => {
        const code = error instanceof OutingError ? error.code : 'storage_unavailable';
        const status = code === 'unauthorized' ? 401 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'busy' ? 429 :
            ['disabled','storage_unavailable'].includes(code) ? 503 : 400;
        return Response.json({error: {code}}, {status, headers: {'Cache-Control': 'no-store'}});
    });
    return app;
}
