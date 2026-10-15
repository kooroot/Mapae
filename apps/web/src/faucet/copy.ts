import type {FaucetKind, FaucetMissionId} from "@mapae/delegation/faucet-policy";
import {MOCK_USDC} from "@mapae/shared";
import {formatUnits} from "viem";
import type {Locale} from "../lib/i18n";
import type {FaucetPageError} from "./client";

/**
 * Every word faucet.mapae.io shows, in both languages.
 *
 * Two rules from the rest of the product hold here too. A testnet token is always named
 * as one — the symbol never stands alone where a reader could take it for money. And an
 * error is one of a closed set: the page maps each code to a plain sentence and shows
 * nothing it was not given a sentence for.
 */

const SYM = MOCK_USDC.symbol;
/** The stablecoin's name wherever an amount is read: symbol plus "testnet, not real money". */
export const TESTNET_TOKEN: Record<Locale, string> = {ko: `${SYM}(테스트넷, 실제 돈 아님)`, en: `${SYM} (testnet, not real money)`};

/** A base-unit or wei amount as a short decimal: "1000", "0.005". */
export function formatAmount(raw: string | bigint, kind: FaucetKind): string {
    const value = formatUnits(BigInt(raw), kind === "musdc" ? MOCK_USDC.decimals : 18);
    return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** Time until `nextAt`, to the minute and never below one: "3시간 12분", "6 d 2 h". */
export function formatWait(ms: number, locale: Locale): string {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
    const parts = locale === "ko"
        ? [days && `${days}일`, hours && `${hours}시간`, !days && rest && `${rest}분`]
        : [days && `${days} d`, hours && `${hours} h`, !days && rest && `${rest} min`];
    return parts.filter(Boolean).join(" ");
}

export const MISSION_COPY: Record<FaucetMissionId, Record<Locale, {title: string; detail: string; action: string}>> = {
    x_follow_mapae: {
        ko: {title: "@mapae_io 팔로우", detail: "팔로우가 받기의 값이에요. 받을 때마다 한 번 열어요.", action: "팔로우"},
        en: {title: "Follow @mapae_io", detail: "The follow is the price of every claim.", action: "Follow"},
    },
};

export const ERROR_COPY: Record<FaucetPageError, Record<Locale, string>> = {
    faucet_off: {ko: "지금은 faucet이 쉬고 있어요. 잠시 뒤 다시 와 주세요.", en: "The faucet is resting right now. Please come back a little later."},
    login_required: {ko: "지갑으로 다시 로그인해 주세요. 받기를 누르면 로그인 서명을 다시 요청해요.", en: "Please sign in again. Pressing the button asks your wallet for a new sign-in signature."},
    mission_incomplete: {ko: "@mapae_io 팔로우를 먼저 마쳐 주세요.", en: "Follow @mapae_io first."},
    turnstile_failed: {ko: "사람 확인을 통과하지 못했어요. 다시 시도해 주세요.", en: "The human check did not pass. Please try again."},
    rate_limited: {ko: "요청이 많아요. 잠시 후 다시 시도해 주세요.", en: "Too many requests. Please try again shortly."},
    cooldown: {ko: "아직 다시 받을 수 없어요.", en: "You can’t claim again yet."},
    not_eligible: {ko: "이 지갑은 받을 수 없어요. 스마트 계정이 아닌 일반 지갑이고, 이더리움 메인넷 거래 기록이 1건 이상 있어야 해요.", en: "This wallet can’t claim. It must be a regular wallet, not a smart account, with at least one Ethereum mainnet transaction."},
    eligibility_unavailable: {ko: "지갑 조건을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.", en: "We couldn’t check this wallet’s eligibility. Please try again shortly."},
    budget_exhausted: {ko: "오늘 나눠 줄 몫이 모두 나갔어요. 내일 다시 와 주세요.", en: "Today’s share has run out. Please come back tomorrow."},
    faucet_empty: {ko: "faucet 지갑이 비었어요. 다시 채워지면 열려요.", en: "The faucet wallet is empty. It reopens once refilled."},
    fee_too_high: {ko: "지금 GIWA 수수료가 높아요. 잠시 후 다시 시도해 주세요.", en: "GIWA fees are high right now. Please try again shortly."},
    malformed_request: {ko: "요청을 처리하지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.", en: "The request couldn’t be processed. Refresh the page and try again."},
    unavailable: {ko: "지금은 faucet에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.", en: "The faucet can’t be reached right now. Please try again shortly."},
    signature_cancelled: {ko: "로그인 서명이 완료되지 않았어요. 지갑에서 요청을 확인하고 다시 시도해 주세요.", en: "Sign-in was not completed. Check the request in your wallet and try again."},
    turnstile_unavailable: {ko: "사람 확인을 불러오지 못했어요. 광고 차단 기능을 끄거나 새로고침해 주세요.", en: "The human check couldn’t load. Turn off content blockers for this page or refresh."},
    network: {ko: "네트워크에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.", en: "Couldn’t reach the network. Check your connection and try again."},
    invalid_response: {ko: "응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.", en: "The reply couldn’t be verified. Please try again shortly."},
};

export interface FaucetCopy {
    title: string;
    titleEnd: string;
    intro: string;
    /** The hero button: the follow is the price of the tokens, said before anything else. */
    followHero: string;
    followDone: string;
    followNote: string;
    /** "Price: follow @mapae_io" beside the amount on each tab. */
    price: string;
    explore: {arcade: string; studio: string};
    tokenUse: Record<FaucetKind, string>;
    amountLabel: Record<FaucetKind, string>;
    destination: Record<FaucetKind, string>;
    cadence: (wait: string) => string;
    testnet: string;
    faqIntro: string;
    subline: string;
    nav: {arcade: string; studio: string};
    tabs: Record<FaucetKind, string>;
    tabsLabel: string;
    steps: {connect: string; missions: string; claim: string};
    connected: string;
    disconnect: string;
    wrongChain: string;
    switchChain: string;
    missionDone: string;
    soon: string;
    soonMission: string;
    claim: Record<FaucetKind, (amount: string) => string>;
    claimHint: Record<FaucetKind, (amount: string) => string>;
    needConnect: string;
    needMissions: string;
    signing: string;
    signingNote: string;
    checking: string;
    sending: string;
    recipient: Record<FaucetKind, string>;
    balance: string;
    explorer: string;
    pending: string;
    pendingNote: string;
    pendingLong: string;
    success: string;
    successAmount: Record<FaucetKind, (amount: string) => string>;
    viewTx: string;
    toArcade: string;
    toStudio: string;
    cooldown: (wait: string) => string;
    lastTx: string;
    alreadyEnough: Record<FaucetKind, (amount: string) => string>;
    failedBefore: string;
    musdcOff: {title: string; body: string};
    ethSoon: {title: string; body: (amount: string) => string};
    ethRules: {title: string; items: (amount: string) => string[]};
    howTo: {title: string; items: {id: string; q: string; a: string}[]};
    watchAsset: string;
    watchAssetNote: string;
    watchAssetDone: string;
    footer: string;
}

export const FAUCET_COPY: Record<Locale, FaucetCopy> = {
    ko: {
        title: "@mapae_io를 팔로우하면",
        titleEnd: "테스트 토큰이 열려요.",
        intro: `팔로우 한 번이 이 faucet의 값이에요. 전령을 뽑는 GIWA Sepolia ETH와 놀이에 쓰는 ${SYM} — 둘 다 테스트넷 토큰이고 실제 돈이 아니에요.`,
        followHero: "@mapae_io 팔로우하고 받기",
        followDone: "@mapae_io 팔로우 완료",
        followNote: "받을 때마다 팔로우 창을 한 번 열어요. 이미 팔로우 중이면 그대로 닫으면 돼요.",
        price: "값: @mapae_io 팔로우",
        explore: {arcade: "캐릭터와 함께하는 작은 모험", studio: "나만의 에이전트를 만드는 곳"},
        tokenUse: {musdc: "아케이드 · 에이전트 결제", eth: "네트워크 가스비"},
        amountLabel: {musdc: "이 잔액까지 채워드려요", eth: "한 번에 받을 수 있어요"},
        destination: {musdc: "지불 계정으로 충전", eth: "연결한 지갑으로 전송"},
        cadence: (wait) => `${wait}마다`,
        testnet: "테스트넷 전용",
        faqIntro: "첫 충전 전, 알아두면 좋은 것들.",
        subline: "GIWA Sepolia 테스트넷 토큰이에요. 실제 돈이 아니에요.",
        nav: {arcade: "아케이드", studio: "Studio"},
        tabs: {musdc: SYM, eth: "ETH"},
        tabsLabel: "받을 토큰",
        steps: {connect: "지갑 연결", missions: "@mapae_io 팔로우 — 토큰을 여는 열쇠", claim: "테스트 토큰 받기"},
        connected: "연결됨",
        disconnect: "연결 해제",
        wrongChain: "지갑이 다른 네트워크에 있어요.",
        switchChain: "GIWA Sepolia로 바꾸기",
        missionDone: "완료",
        soon: "준비 중",
        soonMission: "미션은 곧 공개돼요",
        claim: {musdc: (amount) => `${amount} ${SYM}까지 받기`, eth: (amount) => `${amount} ETH 받기`},
        claimHint: {
            musdc: (amount) => `지불 계정 잔액이 ${amount} ${TESTNET_TOKEN.ko}가 되도록 채워요. 하루에 한 번이에요.`,
            eth: (amount) => `연결한 지갑에 ${amount} ETH(테스트넷)를 보내요. 7일에 한 번이에요.`,
        },
        needConnect: "먼저 지갑을 연결해 주세요.",
        needMissions: "@mapae_io를 팔로우하면 받기 버튼이 켜져요.",
        signing: "지갑에서 로그인 서명을 확인해 주세요…",
        signingNote: "로그인 서명은 결제 권한이 아니고, 가스비도 들지 않아요.",
        checking: "사람인지 확인하는 중…",
        sending: "보내는 중…",
        recipient: {musdc: "지불 계정(스마트 계정)으로 들어와요", eth: "연결한 지갑으로 들어와요"},
        balance: "지금 잔액",
        explorer: "탐색기에서 보기",
        pending: "GIWA에서 확인 중",
        pendingNote: "보통 몇 초면 끝나요. 이 페이지를 닫아도 받기는 계속돼요.",
        pendingLong: "확인이 늦어지고 있어요. 잠시 뒤 새로고침하면 결과가 보여요.",
        success: "받았어요",
        successAmount: {musdc: (amount) => `${amount} ${TESTNET_TOKEN.ko}를 지불 계정에 넣었어요.`, eth: (amount) => `${amount} ETH(테스트넷)를 지갑에 보냈어요.`},
        viewTx: "트랜잭션 보기",
        toArcade: "아케이드로 가서 용돈 주기",
        toStudio: "Studio 열기",
        cooldown: (wait) => `다음 받기까지 ${wait}`,
        lastTx: "지난 받기 트랜잭션",
        alreadyEnough: {musdc: (amount) => `이미 ${amount} ${TESTNET_TOKEN.ko} 이상 있어요. 쓰고 나서 다시 와 주세요.`, eth: (amount) => `이미 ${amount} ETH 이상 있어요. 쓰고 나서 다시 와 주세요.`},
        failedBefore: "지난 요청은 보내지 못했어요. 다시 받아 보세요.",
        musdcOff: {title: "지금은 쉬고 있어요", body: "faucet을 점검하는 중이에요. 잠시 뒤 다시 와 주세요."},
        ethSoon: {title: "준비 중이에요", body: (amount) => `곧 열려요. @mapae_io를 팔로우하면 7일에 한 번 ${amount} ETH(테스트넷)를 받아요.`},
        ethRules: {title: "받을 수 있는 지갑", items: (amount) => [
            "이더리움 메인넷 거래 기록이 1건 이상 있는 지갑",
            "스마트 계정이 아닌 일반 지갑(EOA)",
            `7일에 한 번, ${amount} ETH(테스트넷) — 값은 @mapae_io 팔로우`,
        ]},
        howTo: {title: "자주 묻는 질문", items: [
            {id: "follow", q: "왜 팔로우해야 하나요?", a: "팔로우가 이 faucet의 값이에요. 받을 때마다 @mapae_io 팔로우 링크를 열어야 받기 버튼이 켜지고, 그 대가로 테스트넷 토큰을 보내요. 마패 소식도 거기서 먼저 나와요."},
            {id: "use", q: "어디에 쓰나요?", a: `${SYM}는 아케이드에서 가디언에게 주는 용돈과, Studio에서 만든 에이전트의 결제 연습에 써요. 가디언과 에이전트가 테스트넷에서 돈을 쓰는 흉내를 내는 토큰이에요.`},
            {id: "where", q: "어디로 들어오나요?", a: `${SYM}는 지갑 주소에서 정해지는 지불 계정(스마트 계정)으로 들어와요. 아케이드와 Studio가 결제할 때 쓰는 계정이고, 아직 만들어지지 않았어도 미리 받아 둘 수 있어요. GIWA Sepolia ETH는 연결한 지갑으로 들어와요.`},
            {id: "often", q: "얼마나 자주 받을 수 있나요?", a: `${SYM}는 하루에 한 번, 잔액이 1000이 되도록 채워요. 이미 1000 이상이면 보내지 않아요. GIWA Sepolia ETH는 7일에 한 번 0.005개예요.`},
            {id: "wallet", q: "지갑에 안 보여요", a: `${SYM}는 지갑 주소가 아니라 지불 계정에 들어가요. 위의 지불 계정 주소를 누르면 탐색기에서 잔액을 볼 수 있어요. 지갑에서 토큰을 옮기거나 볼 때를 위해 ${SYM}를 지갑에 추가해 둘 수도 있어요.`},
            {id: "eth", q: "ETH는 누가 받을 수 있나요?", a: "이더리움 메인넷 거래 기록이 1건 이상 있는 일반 지갑이 @mapae_io를 팔로우하면 받아요. 한 사람이 지갑을 여러 개 만들어 모두 가져가지 못하게 하려는 조건이에요."},
            {id: "money", q: "실제 돈인가요?", a: "아니요. GIWA Sepolia 테스트넷에서만 쓰는 토큰이라 팔거나 바꿀 수 없어요."},
        ]},
        watchAsset: `지갑에 ${SYM} 추가`,
        watchAssetNote: "지갑 주소의 잔액이 보여요. 지불 계정 잔액은 탐색기에서 확인하세요.",
        watchAssetDone: "지갑에 추가했어요.",
        footer: "Mapae · GIWA Sepolia 테스트넷",
    },
    en: {
        title: "Follow @mapae_io,",
        titleEnd: "and the faucet opens.",
        intro: `One follow is the price of this faucet. GIWA Sepolia ETH to draw a guardian and ${SYM} to play — both testnet tokens, not real money.`,
        followHero: "Follow @mapae_io to claim",
        followDone: "Following @mapae_io",
        followNote: "Each claim opens the follow page once. Already following? Just close it.",
        price: "Price: follow @mapae_io",
        explore: {arcade: "A little adventure with your character", studio: "A place to build your own agents"},
        tokenUse: {musdc: "Arcade & agent payments", eth: "Network gas fees"},
        amountLabel: {musdc: "Top up your balance to", eth: "Receive per claim"},
        destination: {musdc: "To your payer account", eth: "To your connected wallet"},
        cadence: (wait) => `Every ${wait}`,
        testnet: "Testnet only",
        faqIntro: "A few things to know before you go.",
        subline: "GIWA Sepolia testnet tokens. They are not real money.",
        nav: {arcade: "Arcade", studio: "Studio"},
        tabs: {musdc: SYM, eth: "ETH"},
        tabsLabel: "Token to receive",
        steps: {connect: "Connect wallet", missions: "Follow @mapae_io — this unlocks the tokens", claim: "Get test tokens"},
        connected: "Connected",
        disconnect: "Disconnect",
        wrongChain: "Your wallet is on another network.",
        switchChain: "Switch to GIWA Sepolia",
        missionDone: "Done",
        soon: "Coming soon",
        soonMission: "Missions are announced soon",
        claim: {musdc: (amount) => `Top up to ${amount} ${SYM}`, eth: (amount) => `Get ${amount} ETH`},
        claimHint: {
            musdc: (amount) => `Fills your payer account up to ${amount} ${TESTNET_TOKEN.en}. Once a day.`,
            eth: (amount) => `Sends ${amount} ETH (testnet) to your connected wallet. Once every 7 days.`,
        },
        needConnect: "Connect your wallet first.",
        needMissions: "Follow @mapae_io to turn the claim button on.",
        signing: "Confirm the sign-in signature in your wallet…",
        signingNote: "Signing in grants no payment authority and costs no gas.",
        checking: "Checking you’re human…",
        sending: "Sending…",
        recipient: {musdc: "Arrives in your payer account (smart account)", eth: "Arrives in your connected wallet"},
        balance: "Balance now",
        explorer: "View on explorer",
        pending: "Confirming on GIWA",
        pendingNote: "This usually takes a few seconds. Closing the page does not stop it.",
        pendingLong: "Confirmation is taking longer than usual. Refresh in a moment to see the result.",
        success: "Received",
        successAmount: {musdc: (amount) => `${amount} ${TESTNET_TOKEN.en} is in your payer account.`, eth: (amount) => `${amount} ETH (testnet) is in your wallet.`},
        viewTx: "View transaction",
        toArcade: "Give an allowance in the arcade",
        toStudio: "Open Studio",
        cooldown: (wait) => `Next claim in ${wait}`,
        lastTx: "Last claim transaction",
        alreadyEnough: {musdc: (amount) => `You already hold ${amount} ${TESTNET_TOKEN.en} or more. Come back after you spend some.`, eth: (amount) => `You already hold ${amount} ETH or more. Come back after you spend some.`},
        failedBefore: "Your last request wasn’t sent. Please try again.",
        musdcOff: {title: "Resting for now", body: "The faucet is under maintenance. Please come back a little later."},
        ethSoon: {title: "Coming soon", body: (amount) => `Opening soon. Follow @mapae_io to receive ${amount} ETH (testnet) once every 7 days.`},
        ethRules: {title: "Who can claim", items: (amount) => [
            "A wallet with at least one Ethereum mainnet transaction",
            "A regular wallet (EOA), not a smart account",
            `${amount} ETH (testnet) once every 7 days — the price is a follow of @mapae_io`,
        ]},
        howTo: {title: "Questions", items: [
            {id: "follow", q: "Why do I have to follow?", a: "The follow is the price. Every claim asks you to open the @mapae_io follow link before the button turns on, and the testnet tokens are what you get for it. Mapae news lands there first."},
            {id: "use", q: "What is it for?", a: `${SYM} is the allowance you give guardians in the arcade, and practice money for agents you create in Studio. It lets them act out spending on a testnet.`},
            {id: "where", q: "Where does it go?", a: `${SYM} goes to your payer account — a smart account derived from your wallet address that the arcade and Studio pay from. It can receive tokens before it is deployed. GIWA Sepolia ETH goes to your connected wallet.`},
            {id: "often", q: "How often can I claim?", a: `${SYM} tops your balance up to 1000 once a day, and sends nothing if you already hold 1000. GIWA Sepolia ETH is 0.005 once every 7 days.`},
            {id: "wallet", q: "I don’t see it in my wallet", a: `${SYM} lands in your payer account, not your wallet address. Tap the payer account address above to see its balance on the explorer. You can still add ${SYM} to your wallet for when you move tokens there.`},
            {id: "eth", q: "Who can get ETH?", a: "A regular wallet with at least one Ethereum mainnet transaction, once it follows @mapae_io. The rule stops one person from draining the faucet with many new wallets."},
            {id: "money", q: "Is this real money?", a: "No. These tokens exist only on the GIWA Sepolia testnet and cannot be sold or exchanged."},
        ]},
        watchAsset: `Add ${SYM} to wallet`,
        watchAssetNote: "Shows your wallet address’s balance. Check the payer account on the explorer.",
        watchAssetDone: "Added to your wallet.",
        footer: "Mapae · GIWA Sepolia testnet",
    },
};
