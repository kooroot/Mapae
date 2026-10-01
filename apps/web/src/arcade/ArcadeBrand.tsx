/** The arcade uses the cleaned Mapae lettering with its original A-arrow motifs. */
export function ArcadeBrand() {
    return <span className="arc-brand-lockup">
        <img className="arc-brand-emblem" src="/arcade/arcade-emblem.webp" width={32} height={36} alt="" />
        <span className="arc-brand-type"><img src="/arcade/wordmark-clean.png" width={900} height={154} alt="MAPAE" decoding="async" /><b>ARCADE</b></span>
    </span>;
}
