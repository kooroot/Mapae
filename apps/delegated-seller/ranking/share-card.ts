import {join} from 'node:path';
import {parseGuardianFitting} from '@mapae/arcade/guardian-art';
import type {RankedCard, SeasonCard} from '@mapae/arcade/ranking';
import {renderRankedCard, renderSeasonCard, SHARE_LAYER_NAMES, type ShareCardArt} from '@mapae/arcade/share-card';
import {CARD_REVISION} from '@mapae/arcade/share-card/contract';
import {decodePng, encodePng} from '@mapae/arcade/share-card/png';

/** A 320px layer PNG is well under 200KB; a file near this is not one of ours. */
const MAX_LAYER_BYTES = 512 * 1024;

export type ShareCardArtSource = {load(): Promise<ShareCardArt>};
/**
 * The share card's art under `dir` — the asset repository's `arcade/`: `share/*.png` (36 layers) and `wardrobe/fit.json` —
 * read and decoded once, at the first card, and held in memory (about 15MB decoded) for every card after. Concurrent first
 * requests share one read; a failed read is forgotten so the next card tries again after the files are put in place.
 */
export function shareCardArt(dir: string): ShareCardArtSource {
    let held: Promise<ShareCardArt> | undefined;
    return {load() {
        if (held) return held;
        const loading = (async (): Promise<ShareCardArt> => {
            const fitting = parseGuardianFitting(await Bun.file(join(dir, 'wardrobe', 'fit.json')).json());
            const images = new Map(await Promise.all(SHARE_LAYER_NAMES.map(async name => {
                const file = Bun.file(join(dir, 'share', `${name}.png`));
                if (file.size > MAX_LAYER_BYTES) throw new Error(`Share layer ${name} exceeds ${MAX_LAYER_BYTES} bytes`);
                return [name, await decodePng(await file.bytes())] as const;
            })));
            return {fitting, images};
        })();
        held = loading;
        loading.catch(() => {held = undefined;});
        return loading;
    }};
}

/** A settled day or a closed season never changes: the Worker keeps that card an hour at the edge, a live one a minute. */
export const cardSettled = (card: RankedCard | SeasonCard): boolean => 'game' in card ? card.final : card.status.phase === 'closed';
/** The tag the Worker stores and echoes: the card's identity and standing, so a changed score is a new card. */
export function cardEtag(card: RankedCard | SeasonCard): string {
    const standing = 'game' in card ? `${card.score}-${card.rank}-${card.entrants}-${card.season?.points ?? '-'}-${card.season?.rank ?? '-'}` : `${card.season.points}-${card.season.rank}-${card.season.entrants}-${card.marks.length}`;
    return `"card-${card.tokenId}-${'game' in card ? `${card.game}-${card.day}` : 'season'}-${standing}-${CARD_REVISION}"`;
}
export const renderCardPng = (card: RankedCard | SeasonCard, art: ShareCardArt): Promise<Uint8Array<ArrayBuffer>> =>
    encodePng('game' in card ? renderRankedCard(card, art) : renderSeasonCard(card, art));
