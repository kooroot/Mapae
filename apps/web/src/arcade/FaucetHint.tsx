import {Droplets, ExternalLink} from 'lucide-react';
import type {Locale} from '../lib/i18n';
import {FAUCET_HINT, faucetHintUrl} from './faucet-hint';

/** One line before the first cost: what the arcade needs, that it is free, and the follow that unlocks it. `compact` keeps only the unlock and the link. */
export function FaucetHint({locale, kind = 'eth', compact = false}: {locale: Locale; kind?: 'eth' | 'musdc'; compact?: boolean}) {
    const hint = FAUCET_HINT[locale];
    return <div className="arc-faucet-hint">
        <span><Droplets size={14} aria-hidden="true" />{compact ? hint.unlock : `${hint.need} ${hint.unlock}`}</span>
        <a className="arc-inline-link" href={faucetHintUrl(locale, kind)}>{hint.action}<ExternalLink size={14} aria-hidden="true" /></a>
    </div>;
}
