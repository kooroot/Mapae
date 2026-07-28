import {readDelegationStatus} from "@mapae/delegation/delegation-status";
import {fromTokenAmount} from "@mapae/shared";
import {createFileRoute} from "@tanstack/react-router";
import {useEffect, useMemo, useState} from "react";
import {Footer, Nav} from "../components/Shell";
import {
    chain,
    deployment,
    explorerAddressUrl,
    publicClient,
    submitterAvailability,
} from "../lib/config";
import {short, struckPercent, tickCount} from "../lib/dial";
import {parsePermissionContext, type ParsedPermission} from "../lib/permission";

export const Route = createFileRoute("/app")({component: Console});

/*
 * The console reads one permission and says what it can still do.
 *
 * It is deliberately read-only over the network it is published on. Revocation
 * needs the submitter, the submitter holds a funded relayer key and refuses any
 * non-loopback bind, and so a page served from Cloudflare has no submitter to
 * talk to. The honest thing is to say that where the button would be, rather
 * than render a control that fails on click — a dead button teaches a visitor
 * that the product is broken, while an absent one with a reason teaches them how
 * it is deployed.
 */

function Console() {
    const [raw, setRaw] = useState("");
    const parsed = useMemo(() => parsePermissionContext(raw), [raw]);
    const submitter = submitterAvailability();

    return (
        <>
            <Nav />
            <main className="console">
                <div className="wrap-narrow">
                    <div className="console-head">
                        <div>
                            <span className="eyebrow">콘솔</span>
                            <h1 className="display-2">지금 새겨져 있는 것</h1>
                        </div>
                        <span className="badge">
                            {chain.name} · {chain.id}
                        </span>
                    </div>

                    <div className="field">
                        <label htmlFor="ctx">permission context</label>
                        <textarea
                            id="ctx"
                            value={raw}
                            spellCheck={false}
                            placeholder="0x…"
                            onChange={(event) => setRaw(event.target.value)}
                        />
                        <p className="label field-help">
                            소유자가 서명한 루트 권한의 인코딩 값입니다. 여기 붙여넣으면 체인에서
                            현재 상태를 읽습니다. 서명이나 개인키는 필요하지 않고, 요청하지도
                            않습니다.
                        </p>
                    </div>

                    {parsed.kind === "invalid" && (
                        <div className="state">
                            <p className="body" style={{color: "var(--red-ink)"}}>
                                읽을 수 없습니다 — {parsed.reason}
                            </p>
                        </div>
                    )}

                    {parsed.kind === "ok" && <Pass parsed={parsed} />}

                    <div className="state">
                        <span className="eyebrow">회수</span>
                        {submitter.kind === "configured" ? (
                            <p className="body">
                                로컬 제출기가 설정되어 있습니다. 소유자 지갑으로 서명한 회수를
                                제출할 수 있습니다.
                            </p>
                        ) : (
                            <p className="body">
                                이 배포본에는 회수 제출기가 없습니다
                                {submitter.kind === "refused" ? ` — ${submitter.reason}` : ""}.
                                제출기는 릴레이어 키를 들고 있고 앱 인증이 없어서 loopback에서만
                                동작합니다. 회수는 저장소를 내려받아 로컬에서 실행하세요.
                            </p>
                        )}
                    </div>
                </div>
            </main>
            <Footer />
        </>
    );
}

function Pass({parsed}: {parsed: Extract<ParsedPermission, {kind: "ok"}>}) {
    const [state, setState] = useState<
        | {kind: "loading"}
        | {kind: "error"; reason: string}
        | {kind: "ok"; status: Awaited<ReturnType<typeof readDelegationStatus>>}
    >({kind: "loading"});

    useEffect(() => {
        let live = true;
        setState({kind: "loading"});
        readDelegationStatus({
            publicClient,
            environment: deployment.environment,
            delegation: parsed.root,
        })
            .then((status) => live && setState({kind: "ok", status}))
            .catch(() => live && setState({kind: "error", reason: "체인에서 읽지 못했습니다"}));
        return () => {
            live = false;
        };
    }, [parsed.context, parsed.root]);

    if (state.kind === "loading") {
        return (
            <div className="state">
                <p className="body">체인에서 읽는 중…</p>
            </div>
        );
    }
    if (state.kind === "error") {
        return (
            <div className="state">
                <p className="body" style={{color: "var(--red-ink)"}}>
                    {state.reason}
                </p>
            </div>
        );
    }

    const {status} = state;
    const halt = status.revoked
        ? "회수됨"
        : status.expired
          ? "만료됨"
          : status.notYetActive
            ? "미개시"
            : undefined;

    // Before the first period opens the enforcer reports zero available, and that
    // zero is not a balance. The cap is what *will* be available, so that is the
    // headline — reading the enforcer's zero literally renders an untouched
    // permission as fully drained.
    const started = (status.currentPeriod ?? 0n) > 0n;
    const cap = status.limit?.periodAmount;
    const remaining = status.remaining;
    const headline = cap === undefined ? undefined : started ? remaining : cap;

    return (
        <div className="pass">
            <span className="eyebrow">이 권한으로 지금 쓸 수 있는 금액</span>
            {headline === undefined || cap === undefined ? (
                <p className="body" style={{color: "var(--on-obsidian-dim)"}}>
                    이 위임에는 주기 한도 caveat이 없습니다.
                </p>
            ) : (
                <>
                    <div className="pass-figure">
                        <span className="amount">{fromTokenAmount(headline)}</span>
                        <span className="unit">mUSDC</span>
                    </div>
                    <Marks cap={cap} remaining={remaining ?? cap} />
                    <div className="legend">
                        <span>
                            {started
                                ? `이번 주기 사용 ${fromTokenAmount(
                                      cap > (remaining ?? cap) ? cap - (remaining ?? cap) : 0n,
                                  )}`
                                : "아직 시작 전"}
                        </span>
                        <span>
                            한도 {fromTokenAmount(cap)} / {String(status.limit?.periodDuration)}초
                        </span>
                    </div>
                </>
            )}

            {halt && (
                <p className="halted">{halt} · 이 위임으로는 더 이상 결제할 수 없습니다</p>
            )}

            <dl className="terms">
                <div className="term">
                    <dt>권한 단계</dt>
                    <dd>{parsed.links}단</dd>
                </div>
                <div className="term">
                    <dt>돈이 나가는 지갑</dt>
                    <dd>
                        <a
                            className="mono-link"
                            style={{color: "var(--on-obsidian)"}}
                            href={explorerAddressUrl(parsed.root.delegator)}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {short(parsed.root.delegator)}
                        </a>
                    </dd>
                </div>
                <div className="term">
                    <dt>쓰는 쪽</dt>
                    <dd>{short(parsed.root.delegate)}</dd>
                </div>
                <div className="term">
                    <dt>현재 회차</dt>
                    <dd>{started ? `#${String(status.currentPeriod)}` : "미개시"}</dd>
                </div>
            </dl>
        </div>
    );
}

/** The cap as a channel with the spent portion struck into it. */
function Marks({cap, remaining}: {cap: bigint; remaining: bigint}) {
    const ticks = tickCount(cap);
    const struck = struckPercent(cap, remaining);
    return (
        <div className="marks">
            <div className="struck" style={{width: `${struck}%`}} />
            {Array.from({length: Math.max(ticks - 1, 0)}, (_, index) => (
                <div
                    key={index}
                    className="tick"
                    style={{left: `${((index + 1) / ticks) * 100}%`}}
                />
            ))}
        </div>
    );
}
