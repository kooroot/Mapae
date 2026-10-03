import {stampChallenges, stampAdvice, type Game} from "./game";

export function StampChallenges({game, locale, early = false, result = false}: {game: Game; locale: "ko" | "en"; early?: boolean; result?: boolean}) {
    const ko = locale === "ko";
    return <div className={`stamp-challenges ${game.practice === "boss" ? "stamp-drill-challenges" : ""}`} aria-label={game.practice === "boss" ? ko ? "대장 연습 도전" : "Chief drill challenges" : ko ? "한 판 도전" : "Round challenges"}>
        {stampChallenges(game, early).map(goal => <div key={goal.id} className={goal.done ? "stamp-challenge-done" : ""}>
            <span aria-hidden="true">{goal.done ? "✦" : "◇"}</span><strong>{goal[locale]}</strong><small>{goal.done ? ko ? "달성!" : "DONE!" : result ? ko ? "다음 판에 도전" : "TRY NEXT ROUND" : goal.id === "courier" ? game.mistakes ? ko ? "다음 판에 도전" : "TRY NEXT ROUND" : ko ? "끝까지 지켜요" : "KEEP THEM SAFE" : `${goal.progress} / ${goal.target}`}</small>
        </div>)}
    </div>;
}

export function StampCoach({game, locale, early = false}: {game: Game; locale: "ko" | "en"; early?: boolean}) {
    return <aside className="game-coach"><strong>{locale === "ko" ? "다음 판의 한 수" : "YOUR NEXT MOVE"}</strong><p>{stampAdvice(game, early, locale)}</p></aside>;
}
