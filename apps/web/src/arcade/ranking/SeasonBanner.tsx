import {Link} from '@tanstack/react-router';
import {ChevronRight, Flag} from 'lucide-react';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {arcadeSectionLink} from '../sections';
import {useSeasonStatus} from './client';
import {bestSeasonStanding, seasonBannerCopy} from './format';

/**
 * The lobby's one-line season strip: what phase the season is in and, once it is live, where the owner's best guardian stands.
 * It opens the season tab. Nothing shows until the seller has answered, so a seller without the season leaves the lobby as it was.
 */
export function SeasonBanner({desk}: {desk: GuardianDesk}) {
    const {locale} = desk, status = useSeasonStatus();
    if (!status.value) return null;
    const mine = status.value.phase === 'open' ? bestSeasonStanding(desk.ranking.standings, desk.revealed.map(t => t.tokenId)) : null;
    return <Link className="arc-season-banner" {...arcadeSectionLink('ranking', locale, 'season')} data-phase={status.value.phase}>
        <Flag size={16} aria-hidden="true" /><span>{seasonBannerCopy(status.value, mine, locale)}</span><ChevronRight size={16} aria-hidden="true" />
    </Link>;
}
