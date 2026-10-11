import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {parseRankingIds, validRankingBoard, type RankingPeriod} from '@mapae/arcade/ranking';
import {OutingError} from '../outings/validation';
import type {RankingReader} from './board';

/**
 * Public leaderboards behind the server bearer only: no owner header, because a rank is public. Responses carry token IDs,
 * birth seeds and scores — never an actor, payer, payment or owner.
 */
export function createRankingApp(options: {token?: string; reader?: RankingReader}) {
    const app = new Hono(), digest = (v: string) => createHash('sha256').update(v).digest();
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'private, no-store'); c.header('X-Content-Type-Options', 'nosniff');
        if (!options.token || !timingSafeEqual(digest(c.req.header('Authorization') ?? ''), digest(`Bearer ${options.token}`))) return c.json({error: {code: 'unauthorized'}}, 401);
        await next();
    });
    app.get('/board/:board/:period', c => {
        const {board, period} = c.req.param();
        if (!validRankingBoard(board, period)) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.board(board, period as RankingPeriod));
    });
    app.get('/guardians/:ids', c => {
        const ids = parseRankingIds(c.req.param('ids'));
        if (!ids) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.standings(ids));
    });
    app.onError(error => {
        const code = error instanceof OutingError && error.code === 'invalid_request' ? 'invalid_request' : error instanceof OutingError && error.code === 'disabled' ? 'disabled' : 'ranking_unavailable';
        return Response.json({error: {code}}, {status: code === 'invalid_request' ? 400 : 503, headers: {'Cache-Control': 'private, no-store'}});
    });
    return app;
}
