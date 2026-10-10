/**
 * `@metamask/smart-accounts-kit` reports every SDK call to MetaMask's analytics endpoint
 * unless a Do Not Track signal is present; it has no other switch. Mapae sends no
 * third-party telemetry, and the CSP would only turn those calls into console errors,
 * so this module raises the kit's own opt-out before any kit function runs.
 * Imported first by the router entry, which both the worker and the browser load.
 */
const optOut = globalThis as {process?: {env?: Record<string, string | undefined>}; doNotTrack?: string | null};
if (optOut.process?.env) optOut.process.env["DO_NOT_TRACK"] ??= "1";
if (typeof window !== "undefined") optOut.doNotTrack ??= "1";
