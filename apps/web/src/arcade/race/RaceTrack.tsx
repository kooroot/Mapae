import {useEffect, useRef, useState} from "react";
import {raceEndTime, raceFrameAt, raceLiveRank, raceTerrain, RACE_HABITS, RACE_BURST_SECONDS, RACE_CHECKPOINTS, RACE_ROUTE_SECONDS, type RaceCommand, type RaceSimulation} from "@mapae/arcade/race";
import type {Color} from "../state";
import type {Locale} from "../../lib/i18n";
import "./race-scene.css";

/** One shared course; positions and weather are projections of the deterministic simulation. */
export function RaceTrack({race, commands, rivalId, progress, ended, locale, color, reducedMotion, running}: {
    race: RaceSimulation; commands: RaceCommand[]; rivalId: string; progress: number; locale: Locale;
    color: Color; reducedMotion: boolean; running: boolean; ended: boolean;
}) {
    const ko = locale === "ko";
    const track = useRef<HTMLDivElement>(null);
    const scene = useRef<SVGSVGElement>(null);
    const [size, setSize] = useState({width: 800, height: 440});
    useEffect(() => {track.current?.scrollIntoView({block: "start", behavior: "instant"});}, [race.course.round]);
    useEffect(() => {
        const observer = new ResizeObserver(entries => {
            const box = entries[0]?.contentRect;
            if (box && box.width > 0 && box.height > 0) setSize({width: box.width, height: box.height});
        });
        if (scene.current) observer.observe(scene.current);
        return () => observer.disconnect();
    }, []);
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
    const finishGap = (race.finish[1]?.seconds ?? race.finish[0]!.seconds) - race.finish[0]!.seconds;
    const closeFinish = ended && race.finish.length > 1 && finishGap < .8;
    const pony = size.width < 500 ? 60 : 76;
    const row = size.height * .14;
    const startY = size.height * .36;
    const runnerPoint = (id: string) => {
        const position = frame.positions.find(item => item.id === id)!;
        return {x: 8 + position.distance / race.course.distance * Math.max(0, size.width - pony - 34),
            y: startY + race.entrants.findIndex(runner => runner.id === id) * row + (position.path === "wide" ? 12 : -5)};
    };
    const runnerColor = (id: string, index: number) => id === "owner" ? color : (["jade", "ink", "red"] as const)[index % 3]!;
    return <div ref={track} className={`race-world race-weather-${race.course.weather} ${running && !reducedMotion ? "race-world-moving" : ""}`}>
        <div className="race-world-hud"><span>{ko ? "제" : "ROUND"} {race.course.round + 1}{ko ? "경기" : ""}</span><strong>{ko ? {clear: "맑은 날", rain: "비 오는 날", wind: "바람 부는 날"}[race.course.weather] : race.course.weather.toUpperCase()}</strong><span>{Math.round(raceProgress * 100)}%</span></div>
        <progress className="race-distance-meter" value={raceProgress} max={1} aria-label={ko ? "경주 진행" : "Race progress"} />
        <div className="race-world-scene">
            <img src="/arcade/race-course.webp" width={1536} height={1024} alt="" className="race-world-art" draggable={false} />
            <div className="race-weather-fx" aria-hidden="true" />
            <svg ref={scene} className="race-world-runners" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={ko ? `한 코스에서 달리는 ${race.entrants.length}마리 말. 아래에서 순위와 체력을 확인하세요.` : `${race.entrants.length} horses on one course. Positions and stamina are listed below.`}>
                <g className="race-finish-post" transform={`translate(${size.width - 28} ${startY - 48})`}>
                    <path d={`M0 0V${row * 4 + 36}`} stroke="#ffefc8" strokeWidth="7" strokeDasharray="7 7" />
                    <path d="M-14 -12h28v25h-28z" fill="#2e4938" stroke="#f4d592" strokeWidth="2" />
                    <path d="M-10 -8h8v8h-8zm16 0h5v8H6zM-2 0h8v8h-8z" fill="#fceaca" />
                </g>
                {frame.positions.filter(position => position.draftingId).map(position => {
                    const from = runnerPoint(position.id), to = runnerPoint(position.draftingId!);
                    return <g key={`draft-${position.id}`} className="race-draft-link" aria-hidden="true">
                        <path d={`M${from.x + pony * .8} ${from.y - 18} Q${Math.max(from.x, to.x) + pony} ${(from.y + to.y) / 2} ${to.x + pony * .45} ${to.y - 6}`} fill="none" stroke={position.blockedBy ? "#ffb573" : "#d5f7b2"} strokeWidth="3" strokeDasharray="5 4" />
                    </g>;
                })}
                {race.entrants.map((runner, index) => {
                    const position = frame.positions.find(item => item.id === runner.id)!;
                    const arrived = position.distance >= race.course.distance;
                    const {x, y} = runnerPoint(runner.id);
                    const owner = runner.id === "owner";
                    const tone = runnerColor(runner.id, index);
                    const bursting = race.bursts.some(burst => burst.id === runner.id && frame.time >= burst.at && frame.time < burst.at + RACE_BURST_SECONDS);
                    const rival = runner.id === rivalId;
                    return <g key={runner.id} className={`${owner ? "race-our-runner" : "race-other-runner"} ${arrived ? "race-arrived" : ""} ${bursting ? "race-runner-bursting" : ""}`} transform={`translate(${x} ${y})`}>
                        <path d={`M-4 22H${pony + 6}`} stroke={position.path === "wide" ? "#ffd39d" : "#cce8a8"} strokeWidth="3" strokeDasharray={position.path === "wide" ? "8 4" : undefined} opacity=".9" />
                        <text className="race-path-label" x={pony / 2} y="34" textAnchor="middle" fill="#fff4d9" fontSize="9" fontWeight="800">{position.blockedBy ? ko ? "막힘" : "BLOCKED" : position.draftingId ? ko ? "따라가기 −40%" : "DRAFT −40%" : position.path === "wide" ? ko ? "바깥 추월" : "OUTSIDE" : ko ? "안쪽" : "INSIDE"}</text>
                        <ellipse cx={pony * .52} cy="16" rx={pony * .38} ry="6" fill="#54301b" opacity=".25" />
                        <g className="race-dust" fill="#fff0bd"><circle cx="8" cy="8" r="7" /><circle cx="0" cy="13" r="4" /><circle cx="-8" cy="7" r="3" /></g>
                        {bursting && <ellipse cx={pony * .5} cy={-pony * .32} rx={pony * .5} ry={pony * .4} fill="#ffd274" opacity=".35" />}
                        <g className="race-pony-bounce"><image href={`/arcade/race-pony-${tone}-512.webp`} x="0" y={-pony + 18} width={pony} height={pony} /></g>
                        <g transform={`translate(${owner ? pony / 2 : pony - 2} ${owner ? -pony + 10 : 2})`}><rect x="-19" y="-17" width="38" height="18" rx="9" fill={owner ? "#2a523d" : "#362a20"} stroke={owner ? "#ffe29a" : "#d3b17c"} /><text textAnchor="middle" y="-5" fill="#fff0c8" fontSize="10" fontWeight="800">{owner ? ko ? "내 말" : "YOU" : rival ? ko ? "맞수" : "RIVAL" : index + 1}</text></g>
                    </g>;
                })}
            </svg>
            {closeFinish && <div className="race-close-finish" role="status"><strong>{finishGap < 1e-7 ? ko ? "공동 우승!" : "A DEAD HEAT!" : ko ? "결승선 접전!" : "PHOTO FINISH!"}</strong><span>{finishGap < 1e-7 ? ko ? "같은 기록, 같은 점수" : "Equal times, equal points" : ko ? `${finishGap.toFixed(2)}초가 가른 승부` : `Decided by ${finishGap.toFixed(2)} seconds`}</span></div>}
            <div className="race-route-ribbon" role="status">{routeStatus}</div>
        </div>
        {owner && <div className={`race-live-callout ${gained > 0 ? "race-gaining" : ""}`}>
            <strong role="status">{ended ? ko ? `${rank}위 확정` : `PLACE ${rank} CONFIRMED` : owner.distance >= race.course.distance ? ko ? "완주!" : "FINISHED!" : gained > 0 ? ko ? `${gained}자리 추월!` : `UP ${gained} PLACE${gained > 1 ? "S" : ""}!` : owner.stamina < 25 ? ko ? "체력 경고 · 속도가 떨어져요" : "LOW ENERGY · LOSING SPEED" : rank === 1 ? ko ? "선두를 달리고 있어요!" : "YOU'RE IN THE LEAD!" : ko ? "앞말을 따라잡아 봐요!" : "CHASE THE HORSES AHEAD!"}</strong>
            {!ended && <span>{ko ? `남은 거리 ${Math.ceil(race.course.distance - owner.distance)}m` : `${Math.ceil(race.course.distance - owner.distance)}m to go`}</span>}
            {latestCall && <small>{ko ? `이번 작전 이후 체력 −${Math.round(energyUsed)}%` : `Energy since your call: −${Math.round(energyUsed)}%`}</small>}
        </div>}
        {rival && <p className="race-habit-strip"><strong>{rival.name} · {ko ? "라이벌" : "RIVAL"}</strong> {RACE_HABITS[rival.strategy][locale]}</p>}
        <div className="race-runners-board" aria-label={ko ? "실시간 순위와 체력" : "Live positions and stamina"}>
            {race.entrants.map((runner) => {
                const position = frame.positions.find(item => item.id === runner.id)!;
                const finish = race.finish.find(item => item.id === runner.id)!;
                const rank = raceLiveRank(race, frame, runner.id);
                return <div key={runner.id} className={runner.id === "owner" ? "race-runner-you" : ""}>
                    <b>{rank}<small>{ko ? "위" : ""}</small></b>
                    <div><strong>{runner.name}{runner.id === rivalId && <small className="race-rival-tag">{ko ? "라이벌" : "RIVAL"}</small>}</strong><label>{ko ? "체력" : "Energy"} <meter min={0} max={100} value={position.stamina} /> {Math.round(position.stamina)}%</label>{!ended && <small>{position.blockedBy ? ko ? "앞말에 막힘" : "Blocked" : position.draftingId ? ko ? "따라가기 · 소모 −40%" : "Draft · −40% drain" : position.path === "wide" ? ko ? "바깥 · 자유 추월" : "Outside · Clear to pass" : ko ? "안쪽 · 앞길 열림" : "Inside · Clear ahead"}</small>}{ended && <small>{finish.seconds <= raceEndTime(race) ? `${finish.seconds.toFixed(2)}s` : ko ? "순위 확정" : "Place confirmed"} · +{finish.points}{ko ? "점" : " pts"}</small>}</div>
                </div>;
            })}
        </div>
    </div>;
}
