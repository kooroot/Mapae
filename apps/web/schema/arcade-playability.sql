-- Read-only aggregate of retained wallet records, NOT lifetime analytics.
-- Practice records are client-submitted. Never use these counts for payouts or rankings.
-- No wallet addresses, character names, signatures or token balances leave this query.
WITH visits AS (
    SELECT p.owner, 'stamp' AS game, 'practice' AS source,
        json_extract(r.value,'$.status') = 'complete' AS completed,
        CAST(json_extract(r.value,'$.at') AS INTEGER) AS started_at
    FROM arcade_profiles p, json_each(p.profile,'$.runs') r
    UNION ALL
    SELECT p.owner, json_extract(a.value,'$.game'), json_extract(a.value,'$.source'),
        json_extract(a.value,'$.status') = 'complete',
        CAST(json_extract(a.value,'$.at') AS INTEGER)
    FROM arcade_profiles p, json_each(p.profile,'$.activities') a
), per_wallet AS (
    SELECT owner, game, source, COUNT(*) AS starts, SUM(completed) AS completions
    FROM visits WHERE started_at >= (unixepoch('now') - 7*86400)*1000
    GROUP BY owner, game, source
)
SELECT game, source, COUNT(*) AS wallets, SUM(starts) AS retained_starts,
    SUM(completions) AS completions, SUM(starts-completions) AS unfinished_or_in_progress,
    SUM(starts > 1) AS wallets_with_repeat_play
FROM per_wallet GROUP BY game, source ORDER BY game, source;
