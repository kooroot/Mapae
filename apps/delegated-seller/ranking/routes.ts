import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono, type Context} from 'hono';
import {isRankingDay, parseRankingIds, parseRankingPageOffset, RANKED_GAMES, validRankingBoard, validRankingTokenId, type RankingPeriod} from '@mapae/arcade/ranking';
import {SEASON} from '@mapae/arcade/season';
import {validTeamPeriod} from '@mapae/arcade/team';
import type {GameId} from '@mapae/arcade';
import type {RankedCard, SeasonCard} from '@mapae/arcade/ranking';
import {OutingError} from '../outings/validation';
import type {RankingReader} from './board';
import {cardEtag, cardSettled, renderCardPng, type ShareCardArtSource} from './share-card';

/**
 * Public leaderboards behind the server bearer only: no owner header, because a rank is public. Responses carry token IDs,
 * birth seeds and scores — never an actor, payer, payment or owner.
 */
export function createRankingApp(options: {token?: string; reader?: RankingReader; art?: ShareCardArtSource}) {
    const app = new Hono(), digest = (v: string) => createHash('sha256').update(v).digest();
    app.use('*', async (c, next) => {
        c.header('Cache-Control', 'private, no-store'); c.header('X-Content-Type-Options', 'nosniff');
        if (!options.token || !timingSafeEqual(digest(c.req.header('Authorization') ?? ''), digest(`Bearer ${options.token}`))) return c.json({error: {code: 'unauthorized'}}, 401);
        await next();
    });
    /** The season's id, dates and phase today: the web shows the phase from here and never needs a deploy for a date change. */
    app.get('/season', c => {
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.seasonStatus());
    });
    /** The season whose board exists: the reader's, which a test may set; the shipped one until a reader is wired. */
    const season = () => options.reader?.season ?? SEASON;
    /** The twelve zodiac teams this week or this season; registered before the generic board so `team` never reads as a board id. */
    app.get('/board/team/:period', c => {
        const period = c.req.param('period');
        if (!validTeamPeriod(period, season())) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.teamBoard(period));
    });
    app.get('/board/:board/:period', c => {
        const {board, period} = c.req.param();
        if (!validRankingBoard(board, period, season())) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.board(board, period as RankingPeriod));
    });
    /** The whole board below the top rows, a page at a time: from an offset, or around the caller's guardians (one to three). */
    app.get('/board/:board/:period/:by/:at', c => {
        const {board, period, by, at} = c.req.param();
        const offset = by === 'from' ? parseRankingPageOffset(at) : null, around = by === 'around' ? parseRankingIds(at) : null;
        if (!validRankingBoard(board, period, season()) || (offset === null && !around)) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.page(board, period as RankingPeriod, around ? {around} : {offset: offset!}));
    });
    app.get('/guardians/:ids', c => {
        const ids = parseRankingIds(c.req.param('ids'));
        if (!ids) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return c.json(options.reader.standings(ids));
    });
    /** The facts behind a share card: one guardian on one day's board of one game (404 without a record there), or its season standing. */
    const dayCard = (c: Context): RankedCard => {
        const {game, day, tokenId} = c.req.param();
        if (!RANKED_GAMES.includes(game as GameId) || !isRankingDay(day) || !validRankingTokenId(tokenId)) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return options.reader.card(game as GameId, day, tokenId);
    };
    const seasonCard = (c: Context): SeasonCard => {
        const tokenId = c.req.param('tokenId');
        if (!validRankingTokenId(tokenId)) throw new OutingError('invalid_request');
        if (!options.reader) throw new OutingError('disabled');
        return options.reader.seasonCard(tokenId);
    };
    /**
     * The card itself, drawn here rather than on the web Worker, which the Free plan's CPU budget would cut off: the layer art
     * loads once, then each card is about 90ms of synchronous CPU that holds this event loop — bounded by the Worker's edge
     * cache (a minute per live card, an hour per settled one) and its per-IP budget, which is why only the Worker calls this.
     * The Cache-Control here is the life the Worker gives the edge copy; the middleware's no-store is overridden on these two
     * routes only, and the PNG carries nothing the JSON card does not.
     */
    const cardPng = async (c: Context, card: RankedCard | SeasonCard) => {
        if (!options.art) throw new OutingError('disabled');
        const png = await renderCardPng(card, await options.art.load());
        return c.body(png, 200, {'Content-Type': 'image/png', 'Content-Length': String(png.byteLength), ETag: cardEtag(card), 'Cache-Control': cardSettled(card) ? 'public, max-age=3600' : 'public, max-age=60'});
    };
    // Registered before the day card: `/card/season/1/png` would otherwise read as game `season`, day `1`, token `png`.
    app.get('/card/season/:tokenId/png', c => cardPng(c, seasonCard(c)));
    app.get('/card/:game/:day/:tokenId/png', c => cardPng(c, dayCard(c)));
    app.get('/card/:game/:day/:tokenId', c => c.json(dayCard(c)));
    app.get('/card/season/:tokenId', c => c.json(seasonCard(c)));
    app.onError(error => {
        const code = error instanceof OutingError && (error.code === 'invalid_request' || error.code === 'disabled' || error.code === 'not_found') ? error.code : 'ranking_unavailable';
        return Response.json({error: {code}}, {status: code === 'invalid_request' ? 400 : code === 'not_found' ? 404 : 503, headers: {'Cache-Control': 'private, no-store'}});
    });
    return app;
}
