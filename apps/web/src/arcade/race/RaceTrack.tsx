import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from "react";
import {raceEndTime, raceFrameAt, raceLiveRank, raceTerrain, RACE_HABITS, RACE_BURST_SECONDS, RACE_CHECKPOINTS, RACE_ROUTE_SECONDS, type RaceCommand, type RaceSimulation} from "@mapae/arcade/race";
import {RaceRunners} from "./RaceRunners";
import {flipRank, photoFinish, pickAnnouncement, RaceAnnouncer, rankShift, START_BEATS} from "./race-fx";
import type {Color} from "../state";
import type {MotionTier} from "../motion";
import type {ArcadeSound} from "../sound";
import type {Locale} from "../../lib/i18n";
import "./race-scene.css";

/** A headwind's ink streaks and ginkgo leaves; CSS places and times each one, the runners' loop sets their pace from the gust. */
const WIND_STREAKS = [0, 1, 2, 3], WIND_LEAVES = [0, 1, 2, 3, 4, 5];

/**
 * One shared course; positions and weather are projections of the deterministic simulation.
 * `progress` paces the text at the HUD rate; `clock` is the live simulation time the runners follow every frame.
 */
export function RaceTrack({race, commands, rivalId, progress, clock, ended, locale, color, reducedMotion, running, tier, sound, playback, signal = null}: {
    race: RaceSimulation; commands: RaceCommand[]; rivalId: string; progress: number; clock: RefObject<number>; locale: Locale;
    color: Color; reducedMotion: boolean; running: boolean; ended: boolean; tier: MotionTier; sound: ArcadeSound; playback: number;
    /** The start signal's beat (0 "셋", 1 "둘", 2 "출발!"), or null when there is none: horses stand at the gate until the last beat. */
    signal?: number | null;
}) {
    const ko = locale === "ko";
    const track = useRef<HTMLDivElement>(null);
    const meter = useRef<HTMLSpanElement>(null);
    const weather = useRef<HTMLDivElement>(null);
    // The race's one live region: moments from the event list, at most one per 1.5s, written straight to the node (no render).
    const said = useRef<HTMLParagraphElement>(null);
    const [announcer] = useState(() => new RaceAnnouncer(text => {if (said.current) said.current.textContent = text;}));
    useEffect(() => () => announcer.stop(), [announcer]);
    const board = useRef<HTMLDivElement>(null);
    const places = useRef(new Map<string, number>());
    const held = useRef<Animation[]>([]);
    const halted = !running && !ended;
    const holding = signal !== null && signal < START_BEATS - 1;
    useEffect(() => {track.current?.scrollIntoView({block: "start", behavior: "instant"});}, [race.course.round]);
    // `[data-halted]` pauses CSS motion only: a halt pauses the race's scripted moments too, and resuming plays exactly those.
    useEffect(() => {
        if (halted) {
            held.current = (track.current?.getAnimations({subtree: true}) ?? []).filter(animation => animation.playState === "running" && !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition));
            for (const animation of held.current) animation.pause();
            return;
        }
        for (const animation of held.current) if (animation.playState === "paused") animation.play();
        held.current = [];
    }, [halted]);
    const frame = raceFrameAt(race, ended ? raceEndTime(race) / race.seconds : reducedMotion ? Math.floor(progress * race.seconds / 2) * 2 / race.seconds : progress);
    const raceProgress = ended ? 1 : Math.min(1, progress * race.seconds / raceEndTime(race));
    const owner = frame.positions.find(p => p.id === "owner");
    const latestCall = commands.findLast(c => c.at <= frame.time);
    const anchor = raceFrameAt(race, (latestCall?.at ?? 0) / race.seconds);
    const rank = raceLiveRank(race, frame, "owner");
    const gained = raceLiveRank(race, anchor, "owner") - rank;
    const energyUsed = Math.max(0, (anchor.positions.find(p => p.id === "owner")?.stamina ?? 100) - (owner?.stamina ?? 100));
    const call = commands.findLast(command => frame.time >= command.at && frame.time < command.at + RACE_ROUTE_SECONDS);
    const terrain = call ? raceTerrain(race.course, RACE_CHECKPOINTS.indexOf(call.at as typeof RACE_CHECKPOINTS[number])) : null;
    const tired = (frame.positions.find(p => p.id === "owner")?.stamina ?? 0) < 25;
    const ownerBurst = race.bursts.find(burst => burst.id === "owner" && frame.time >= burst.at && frame.time < burst.at + RACE_BURST_SECONDS);
    const rival = race.entrants.find(runner => runner.id === rivalId);
    const rivalBurst = race.bursts.find(burst => burst.id === rivalId && frame.time >= burst.at && frame.time < burst.at + RACE_BURST_SECONDS);
    const draftingName = race.entrants.find(runner => runner.id === owner?.draftingId)?.name;
    const pass = race.frames.findLast(item => item.time <= frame.time && item.time > frame.time - 3
        && item.positions.some(position => position.id === "owner" && position.overtakingId))?.positions.find(position => position.id === "owner");
    const passedName = race.entrants.find(runner => runner.id === pass?.overtakingId)?.name;
    const routeStatus = ended ? ko ? "순위 확정! 다음 경기도 함께 달려요" : "Places settled! Ready for the next race?" : owner?.blockedBy ? ko ? `${draftingName} 뒤에서 막혔어요 · 바깥길로 나가야 추월해요` : `Blocked behind ${draftingName} · Move outside to pass`
        : passedName ? ko ? `바깥으로 ${passedName} 추월!` : `Passed ${passedName} on the outside!`
        : owner?.draftingId ? ko ? `${draftingName} 뒤를 따라가요 · 체력 소모 −40%` : `Drafting ${draftingName} · Energy drain −40%`
        : ownerBurst ? ko ? "승부수! 지금 추월을 노려요" : "BURST! Make your move!" : rivalBurst ? ko ? `${rival?.name}의 승부수!` : `${rival?.name} makes a move!` : call ? call.route === "wide" ? ko ? "바깥 추월 · 속도 −6%, 앞말에 막히지 않아요" : "Outer pass · Speed −6%, clear to overtake"
        : terrain === "mud" && call.pace === "push" ? ko ? "진흙에 미끄러져요!" : "Losing traction in the mud!"
        : terrain === "hill" && tired ? ko ? "고개를 넘기엔 체력이 부족해요" : "Too tired for the steep shortcut"
        : ko ? "지름길 · 앞을 향해 가속!" : "Shortcut · Gaining ground!" : owner?.path === "wide" ? ko ? "바깥 추월 · 속도 −6%, 막힘 없이 달려요" : "Outside · Speed −6%, clear running" : ko ? "안쪽 · 앞말이 멀면 따라가기 이득이 없어요" : "Inside · No nearby horse, no draft bonus";
    const standing = race.entrants.map(runner => ({runner, position: frame.positions.find(item => item.id === runner.id)!, place: raceLiveRank(race, frame, runner.id)}));
    // The board at the HUD's pace: stamina bars scale (no style attribute: the CSP allows none) and a changed place rolls over.
    useLayoutEffect(() => {
        // The field leaves the gate sharing first place: spreading out from it is no place change, so it rolls nothing.
        const gate = [...places.current.values()].every(place => place === 1);
        standing.forEach(({runner, position, place}, index) => {
            const row = board.current?.children[index];
            const fill = row?.querySelector<HTMLElement>(".race-stamina>span");
            if (fill) fill.style.transform = `scaleX(${position.stamina / 100})`;
            const shift = rankShift(places.current.get(runner.id), place);
            places.current.set(runner.id, place);
            const number = row?.querySelector("b");
            if (shift && number && !gate) flipRank(number, shift, tier);
        });
    });
    const finishGap = (race.finish[1]?.seconds ?? race.finish[0]!.seconds) - race.finish[0]!.seconds;
    const closeFinish = ended && photoFinish(race);
    return <div ref={track} className={`race-world race-weather-${race.course.weather} ${ended || reducedMotion || holding ? "" : "race-world-moving"}`} data-tier={tier} data-halted={halted ? "" : undefined}>
        <div className="race-world-hud"><span>{ko ? "제" : "ROUND"} {race.course.round + 1}{ko ? "경기" : ""}</span><strong>{ko ? {clear: "맑은 날", rain: "비 오는 날", wind: "바람 부는 날"}[race.course.weather] : race.course.weather.toUpperCase()}</strong><span>{Math.round(raceProgress * 100)}%</span></div>
        <div className="race-distance-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(raceProgress * 100)} aria-label={ko ? "경주 진행" : "Race progress"}><span ref={meter} /></div>
        <div className="race-world-scene">
            <img src="/arcade/race-course.webp" width={1536} height={1024} alt="" className="race-world-art" draggable={false} />
            <div ref={weather} className="race-weather-fx" aria-hidden="true">{race.course.weather === "wind" && <>{WIND_STREAKS.map(i => <i key={`streak-${i}`} className="race-wind-streak" />)}{WIND_LEAVES.map(i => <i key={`leaf-${i}`} className="race-wind-leaf" />)}</>}</div>
            <RaceRunners race={race} frame={frame} rivalId={rivalId} color={color} locale={locale} clock={clock} meter={meter} weather={weather} follow={!ended && !reducedMotion} live={running && !ended && !reducedMotion && !holding} tier={tier} sound={sound} playback={playback}
                say={(events, photo) => announcer.offer(pickAnnouncement(events, photo, race, rivalId, locale))} />
            {signal !== null && <div className="race-start-signal" aria-hidden="true"><span key={signal}>{(ko ? ["셋", "둘", "출발!"] : ["3", "2", "GO!"])[signal]}</span></div>}
            {closeFinish && <div className="race-close-finish"><strong>{finishGap < 1e-7 ? ko ? "공동 우승!" : "A DEAD HEAT!" : ko ? "결승선 접전!" : "PHOTO FINISH!"}</strong><span>{finishGap < 1e-7 ? ko ? "같은 기록, 같은 점수" : "Equal times, equal points" : ko ? `${finishGap.toFixed(2)}초가 가른 승부` : `Decided by ${finishGap.toFixed(2)} seconds`}</span></div>}
            <div className="race-route-ribbon">{routeStatus}</div>
        </div>
        {owner && <div className={`race-live-callout ${gained > 0 ? "race-gaining" : ""}`}>
            <strong>{ended ? ko ? `${rank}위 확정` : `PLACE ${rank} CONFIRMED` : owner.distance >= race.course.distance ? ko ? "완주!" : "FINISHED!" : gained > 0 ? ko ? `${gained}자리 추월!` : `UP ${gained} PLACE${gained > 1 ? "S" : ""}!` : owner.stamina < 25 ? ko ? "체력 경고 · 속도가 떨어져요" : "LOW ENERGY · LOSING SPEED" : rank === 1 ? ko ? "선두를 달리고 있어요!" : "YOU'RE IN THE LEAD!" : ko ? "앞말을 따라잡아 봐요!" : "CHASE THE HORSES AHEAD!"}</strong>
            {!ended && <span>{ko ? `남은 거리 ${Math.ceil(race.course.distance - owner.distance)}m` : `${Math.ceil(race.course.distance - owner.distance)}m to go`}</span>}
            {latestCall && <small>{ko ? `이번 작전 이후 체력 −${Math.round(energyUsed)}%` : `Energy since your call: −${Math.round(energyUsed)}%`}</small>}
        </div>}
        <p ref={said} className="sr-only" role="status" />
        {rival && <p className="race-habit-strip"><strong>{rival.name} · {ko ? "라이벌" : "RIVAL"}</strong> {RACE_HABITS[rival.strategy][locale]}</p>}
        <div ref={board} className="race-runners-board" aria-label={ko ? "실시간 순위와 체력" : "Live positions and stamina"}>
            {standing.map(({runner, position, place}) => {
                const finish = race.finish.find(item => item.id === runner.id)!;
                const energy = Math.round(position.stamina);
                return <div key={runner.id} className={runner.id === "owner" ? "race-runner-you" : ""}>
                    <b>{place}<small>{ko ? "위" : ""}</small></b>
                    <div><strong>{runner.name}{runner.id === rivalId && <small className="race-rival-tag">{ko ? "라이벌" : "RIVAL"}</small>}</strong><span className="race-energy">{ko ? "체력" : "Energy"} <span className={`race-stamina ${position.stamina < 25 ? "race-stamina-low" : ""}`} role="meter" aria-label={`${runner.name} ${ko ? "체력" : "energy"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={energy} aria-valuetext={`${energy}%`}><span /></span> {energy}%</span>{!ended && <small>{position.blockedBy ? ko ? "앞말에 막힘" : "Blocked" : position.draftingId ? ko ? "따라가기 · 소모 −40%" : "Draft · −40% drain" : position.path === "wide" ? ko ? "바깥 · 자유 추월" : "Outside · Clear to pass" : ko ? "안쪽 · 앞길 열림" : "Inside · Clear ahead"}</small>}{ended && <small>{finish.seconds <= raceEndTime(race) ? `${finish.seconds.toFixed(2)}s` : ko ? "순위 확정" : "Place confirmed"} · +{finish.points}{ko ? "점" : " pts"}</small>}</div>
                </div>;
            })}
        </div>
    </div>;
}
