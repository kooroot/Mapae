import {Download, Share2} from 'lucide-react';
import type {RankingStanding, SeasonStanding} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {shareLinks, shareText} from './links';
import type {ShareTarget} from './page';
import './share.css';

/**
 * Share a standing on X with its card, or save the card. The post opens X's own composer; nothing is sent from here and nothing
 * about the viewer rides along. `compact` is the journal's single icon beside a ranked row.
 */
export function ShareActions({target, standing, locale, compact}: {
    target: ShareTarget; standing: Pick<RankingStanding, 'score' | 'rank' | 'entrants'> | SeasonStanding; locale: Locale; compact?: boolean;
}) {
    const ko = locale === 'ko', links = shareLinks(target, shareText(target, standing, locale), locale);
    if (compact) return <a className="share-x" href={links.intent} target="_blank" rel="noopener noreferrer" aria-label={ko ? 'X에 공유' : 'Share on X'} title={ko ? 'X에 공유' : 'Share on X'}><Share2 size={14} aria-hidden="true" /></a>;
    return <p className="share-actions">
        <a className="arc-text-button" href={links.intent} target="_blank" rel="noopener noreferrer"><Share2 size={16} aria-hidden="true" />{ko ? 'X에 공유' : 'Share on X'}</a>
        <a className="arc-text-button" href={links.card} download={links.download}><Download size={16} aria-hidden="true" />{ko ? '카드 저장' : 'Save card'}</a>
    </p>;
}
