import type {Address} from 'viem';
import {useEffect, useRef, useState} from 'react';
import {useSignMessage} from 'wagmi';
import {loginProfile, ProfileError, profileErrorMessage, readSession} from './profile/client';

/** SIWE authenticates operations. Characters and growth come exclusively from the NFT APIs. */
export function useArcadeSession(owner: Address) {
    const {signMessageAsync} = useSignMessage();
    const [status, setStatus] = useState<'loading' | 'login' | 'signing' | 'ready' | 'error'>('loading');
    const [failure, setFailure] = useState<unknown>(null);
    const [reducedMotion, setReducedMotion] = useState(false);
    const alive = useRef(false), checking = useRef(false), signing = useRef(false), retryAt = useRef(0);
    async function refresh() {
        if (checking.current || Date.now() < retryAt.current) return;
        checking.current = true;
        try {
            await readSession(owner);
            if (alive.current) {setFailure(null); setStatus('ready');}
        } catch (error) {
            if (alive.current) {
                if (error instanceof ProfileError) retryAt.current = error.retryAt;
                const loggedOut = error instanceof ProfileError && error.code === 'login_required';
                setFailure(loggedOut ? null : error); setStatus(loggedOut ? 'login' : 'error');
            }
        } finally {checking.current = false;}
    }
    async function login() {
        if (signing.current || checking.current || Date.now() < retryAt.current) return;
        signing.current = true; setFailure(null); setStatus('signing');
        try {
            await loginProfile(owner, async message => {
                let signature: string;
                try {signature = await signMessageAsync({account: owner, message});}
                catch {throw new ProfileError('signature_cancelled');}
                if (!alive.current) throw new ProfileError('wallet_changed');
                return signature;
            });
            if (alive.current) await refresh();
        } catch (error) {
            if (alive.current) {
                if (error instanceof ProfileError) retryAt.current = error.retryAt;
                setFailure(error); setStatus('login');
            }
        } finally {signing.current = false;}
    }
    useEffect(() => {
        alive.current = true; void refresh();
        const media = matchMedia('(prefers-reduced-motion: reduce)');
        const motion = () => setReducedMotion(media.matches); motion(); media.addEventListener('change', motion);
        const resume = () => {if (!document.hidden && !signing.current) void refresh();};
        window.addEventListener('focus', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
        const poll = setInterval(resume, 30_000);
        return () => {alive.current = false; clearInterval(poll); media.removeEventListener('change', motion); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume);};
    }, [owner]);
    return {ready: status === 'ready', status, reducedMotion, refresh, login,
        errorMessage: (ko: boolean) => failure ? profileErrorMessage(failure, ko) : ''};
}
