import type {Address} from 'viem';
import {useEffect, useRef, useState} from 'react';
import {useSignMessage} from 'wagmi';
import {loginProfile, ProfileError, profileErrorMessage, readSession} from './profile/client';

export type SessionStatus = 'guest' | 'loading' | 'login' | 'signing' | 'ready' | 'error';
export type ArcadeSession = ReturnType<typeof useArcadeSession>;
type Checked = {owner: Address; status: Exclude<SessionStatus, 'guest' | 'loading'>; failure: unknown};

/**
 * SIWE authenticates operations. Characters and growth come exclusively from the NFT APIs.
 * Every answer is recorded with the wallet it was checked for, so a switched wallet reads as loading until its own check returns.
 */
export function useArcadeSession(owner: Address | undefined) {
    const {signMessageAsync} = useSignMessage();
    const [checked, setChecked] = useState<Checked | null>(null);
    const active = useRef<Address | undefined>(undefined), checking = useRef<Address | undefined>(undefined), signing = useRef<Address | undefined>(undefined), retryAt = useRef(0);
    const current = checked?.owner === owner ? checked : null;
    const status: SessionStatus = !owner ? 'guest' : current ? current.status : 'loading';
    async function refresh() {
        const target = owner;
        if (!target || checking.current === target || Date.now() < retryAt.current) return;
        checking.current = target;
        try {
            await readSession(target);
            if (active.current === target) setChecked({owner: target, status: 'ready', failure: null});
        } catch (error) {
            if (active.current === target) {
                if (error instanceof ProfileError) retryAt.current = error.retryAt;
                const loggedOut = error instanceof ProfileError && error.code === 'login_required';
                setChecked({owner: target, status: loggedOut ? 'login' : 'error', failure: loggedOut ? null : error});
            }
        } finally {if (checking.current === target) checking.current = undefined;}
    }
    async function login() {
        const target = owner;
        if (!target || signing.current === target || checking.current === target || Date.now() < retryAt.current) return;
        signing.current = target; setChecked({owner: target, status: 'signing', failure: null});
        try {
            await loginProfile(target, async message => {
                let signature: string;
                try {signature = await signMessageAsync({account: target, message});}
                catch {throw new ProfileError('signature_cancelled');}
                if (active.current !== target) throw new ProfileError('wallet_changed');
                return signature;
            });
            if (active.current === target) await refresh();
        } catch (error) {
            if (active.current === target) {
                if (error instanceof ProfileError) retryAt.current = error.retryAt;
                setChecked({owner: target, status: 'login', failure: error});
            }
        } finally {if (signing.current === target) signing.current = undefined;}
    }
    useEffect(() => {
        if (!owner) return;
        active.current = owner; retryAt.current = 0; void refresh();
        const resume = () => {if (!document.hidden && !signing.current) void refresh();};
        window.addEventListener('focus', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
        const poll = setInterval(resume, 30_000);
        return () => {active.current = undefined; clearInterval(poll); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume);};
    }, [owner]);
    return {ready: status === 'ready', status, refresh, login,
        errorMessage: (ko: boolean) => current?.failure ? profileErrorMessage(current.failure, ko) : ''};
}
