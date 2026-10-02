import type {Address} from "viem";
import {useEffect, useRef, useState} from "react";
import {useSignMessage} from "wagmi";
import {newArcadeState, type ArcadeState} from "./state";
import {emptyProfile, importDeviceProfile, mergeProfiles, ProfileConflict, profileState, projectProfile, sameProfile, type ProfileSnapshot} from "./profile/model";
import {loginProfile, ProfileError, profileErrorMessage, readProfile, writeProfile} from "./profile/client";
import {preserveDeviceDraft, readDeviceDraft, writeDeviceDraft} from "./profile/device-store";

type SyncStatus = "loading" | "login" | "signing" | "saving" | "synced" | "error" | "conflict";
/** Wallet identity is keyed by the parent. The server is authoritative; local state is a recovery draft. */
export function useArcadeState(owner: Address) {
    const {signMessageAsync} = useSignMessage();
    const [demo, setDemo] = useState<ArcadeState>(() => newArcadeState());
    const [ready, setReady] = useState(false);
    const [status, setStatus] = useState<SyncStatus>("loading");
    const [failure, setFailure] = useState<unknown>(null);
    const current = useRef(demo), base = useRef<ProfileSnapshot | null>(null);
    const alive = useRef(false), initialized = useRef(false), imported = useRef(false);
    const saving = useRef<Promise<void> | null>(null), authenticating = useRef(false), refreshing = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const conflict = useRef<ProfileSnapshot | null>(null);
    const draftStored = useRef(true);
    function cache() {
        draftStored.current = writeDeviceDraft(owner, {state: current.current, base: base.current, pending: !base.current || !sameProfile(projectProfile(current.current), base.current.profile), imported: imported.current});
        return draftStored.current;
    }
    function show(next: ArcadeState) {current.current = next; if (alive.current) setDemo(next);}
    function failed(e: unknown) {
        if (!alive.current) return;
        setFailure(!initialized.current && e instanceof ProfileError && e.code === "login_required" ? null : e);
        setStatus(e instanceof ProfileError && e.code === "login_required" ? "login" : e instanceof ProfileConflict ? "conflict" : "error");
        if (initialized.current) cache();
    }
    async function flush(): Promise<void> {
        if (saving.current) return saving.current;
        if (conflict.current) throw new ProfileConflict();
        const task = async () => {
            if (!base.current) throw new ProfileError("login_required");
            let collisions = 0;
            while (alive.current && !sameProfile(projectProfile(current.current), base.current.profile)) {
                setStatus("saving");
                const sent = projectProfile(current.current), previous = base.current;
                try {
                    const next = await writeProfile(owner, previous.revision, sent);
                    if (!alive.current) return;
                    const merged = mergeProfiles(sent, projectProfile(current.current), next.profile);
                    base.current = next;
                    show(profileState(merged, current.current));
                    cache();
                } catch (e) {
                    if (!(e instanceof ProfileError) || !e.snapshot || ++collisions > 3) throw e;
                    try {
                        const merged = mergeProfiles(previous.profile, projectProfile(current.current), e.snapshot.profile);
                        base.current = e.snapshot; show(profileState(merged, current.current));
                    } catch (mergeError) {conflict.current = e.snapshot; throw mergeError;}
                }
            }
            if (alive.current) {imported.current = true; cache(); setFailure(null); setStatus("synced");}
        };
        saving.current = task().catch(e => {failed(e); throw e;}).finally(() => {saving.current = null;});
        return saving.current;
    }
    async function refresh() {
        if (refreshing.current || saving.current || conflict.current) return;
        refreshing.current = true;
        try {
            const next = await readProfile(owner);
            if (!alive.current || (base.current && next.revision < base.current.revision)) return;
            if (!initialized.current) {
                const draft = readDeviceDraft(owner);
                const local = projectProfile(draft.state);
                let merged = next.profile;
                if (draft.pending || !draft.imported) {
                    try {merged = draft.base ? mergeProfiles(draft.base.profile, local, next.profile) : importDeviceProfile(local, next.profile);}
                    catch (e) {base.current = next; conflict.current = next; show(draft.state); initialized.current = true; setReady(true); throw e;}
                }
                base.current = next; initialized.current = true; imported.current = draft.imported;
                show(profileState(merged, draft.state));
            } else {
                try {
                    const merged = mergeProfiles(base.current?.profile ?? emptyProfile(), projectProfile(current.current), next.profile);
                    base.current = next; show(profileState(merged, current.current));
                } catch (e) {conflict.current = next; throw e;}
            }
            cache(); setReady(true);
            await flush();
        } catch (e) {failed(e);} finally {refreshing.current = false;}
    }
    async function login() {
        if (authenticating.current) return;
        authenticating.current = true; setFailure(null); setStatus("signing");
        try {
            await loginProfile(owner, async message => {
                let signature: string;
                try {signature = await signMessageAsync({account: owner, message});} catch {throw new ProfileError("signature_cancelled");}
                if (!alive.current) throw new ProfileError("wallet_changed");
                return signature;
            });
            if (alive.current) await refresh();
        } catch (e) {if (alive.current) {setFailure(e); setStatus("login");}}
        finally {authenticating.current = false;}
    }
    useEffect(() => {
        alive.current = true; void refresh();
        const resume = () => {if (document.visibilityState === "visible" && !authenticating.current) void refresh();};
        window.addEventListener("focus", resume); window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
        const poll = setInterval(resume, 30_000);
        return () => {alive.current = false; if (timer.current) clearTimeout(timer.current); clearInterval(poll); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume);};
    }, [owner]);
    function update(transform: (value: ArcadeState) => ArcadeState): ArcadeState {
        if (!initialized.current) return current.current;
        const next = transform(current.current);
        show(next); cache();
        // Editing is disabled during a conflict, but an already running game must
        // still retain its result in the recovery draft.
        if (conflict.current) return next;
        if (base.current && !sameProfile(projectProfile(next), base.current.profile)) {
            setStatus("saving");
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {void flush().catch(() => {});}, 250);
        }
        return next;
    }
    async function useServerCopy() {
        if (!conflict.current) return;
        try {
            preserveDeviceDraft(owner, current.current);
            const remote = conflict.current;
            const local = projectProfile(current.current);
            // Choosing server character settings must not discard a game that
            // finished on this device while the editor was in conflict.
            const ids = new Set(remote.profile.characters.map(c => c.id));
            const retained = {...local, characters: local.characters.filter(c => ids.has(c.id)), runs: local.runs.filter(r => ids.has(r.characterId)), activities: local.activities.filter(a => ids.has(a.characterId))};
            base.current = remote; show(profileState(importDeviceProfile(retained, remote.profile), current.current));
            conflict.current = null; await refresh();
        } catch (e) {failed(e);}
    }
    return {demo, ready, saved: status === "synced", update, flush, refresh, login, useServerCopy, status,
        errorMessage: (ko: boolean) => failure ? !draftStored.current
            ? ko ? "서버 저장과 기기 임시 저장에 실패했어요. 이 화면을 유지하고 연결을 확인한 뒤 다시 시도해 주세요." : "Server sync and local recovery storage failed. Keep this page open, check your connection and retry."
            : profileErrorMessage(failure, ko) : ""};
}
