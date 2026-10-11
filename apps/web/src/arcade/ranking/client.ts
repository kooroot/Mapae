import {useEffect, useState} from "react";
import type {RankingBoard, RankingBoardId, RankingPeriod, RankingStandings} from "@mapae/arcade/ranking";

type Remote<T> = {value: T | null; loading: boolean; error: boolean};
const BOARD_REFRESH_MS = 60_000;

/** The proxy validated every field; the browser keeps no copy of its own, so a refetch reaches the edge cache. */
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`/api/arcade/ranking${path}`, {credentials: "omit", cache: "no-store", redirect: "error", signal});
    if (!response.ok) throw new Error("ranking_unavailable");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("ranking_unavailable");
    return value as T;
}

/** Loads `path` whenever `key` changes, and again on each `tick`; the previous answer stays shown while the next loads. */
function useRemote<T>(path: string | null, key: string): Remote<T> {
    const [state, setState] = useState<Remote<T> & {path: string | null}>({value: null, loading: path !== null, error: false, path});
    if (state.path !== path) setState({value: null, loading: path !== null, error: false, path});
    useEffect(() => {
        if (!path) return;
        const controller = new AbortController();
        setState(s => s.path === path ? {...s, loading: true} : s);
        read<T>(path, controller.signal)
            .then(value => setState(s => s.path === path ? {value, loading: false, error: false, path} : s))
            .catch(() => {if (!controller.signal.aborted) setState(s => s.path === path ? {...s, loading: false, error: true} : s);});
        return () => controller.abort();
    }, [path, key]);
    return {value: state.value, loading: state.loading, error: state.error};
}

/** One board, refreshed every minute while the page is in view and on returning to it. */
export function useRankingBoard(board: RankingBoardId, period: RankingPeriod): Remote<RankingBoard> {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const refresh = () => {if (document.visibilityState === "visible") setTick(t => t + 1);};
        const timer = setInterval(refresh, BOARD_REFRESH_MS);
        document.addEventListener("visibilitychange", refresh);
        return () => {clearInterval(timer); document.removeEventListener("visibilitychange", refresh);};
    }, []);
    return useRemote<RankingBoard>(`/board/${board}/${period}`, String(tick));
}

/**
 * Where the owner's guardians stand. `refreshKey` changes when a verified round lands (the crew's result count), so a rank
 * moves as soon as the outing that earned it reports back.
 */
export function useRankingStandings(tokenIds: readonly string[], refreshKey: number): Remote<RankingStandings> {
    const ids = [...tokenIds].sort((a, b) => Number(a) - Number(b)).join(",");
    return useRemote<RankingStandings>(ids ? `/guardians/${ids}` : null, String(refreshKey));
}
