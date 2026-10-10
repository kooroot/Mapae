import {useEffect, useRef, useState} from 'react';
import {guestUpdate, newGuestState, readGuestState} from './store';
import type {PracticeStore} from '../PracticeArcade';

export function useGuestPractice(): PracticeStore {
    const [demo, setDemo] = useState(newGuestState), [ready, setReady] = useState(false);
    const current = useRef(demo);
    useEffect(() => {
        current.current = readGuestState();
        setDemo(current.current); setReady(true);
    }, []);
    return {demo, ready, update(transform) {const next = guestUpdate(current, transform); setDemo(next); return next;}};
}
