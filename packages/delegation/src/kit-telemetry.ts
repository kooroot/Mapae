/**
 * `@metamask/smart-accounts-kit` reports every SDK call to MetaMask's analytics endpoint
 * unless a Do Not Track signal is present; it has no other switch. Mapae sends no
 * third-party telemetry, so this module raises the kit's own opt-out. The kit reads the
 * signal on its first tracked call, so evaluating this anywhere before that call is
 * enough: every module here that imports the kit imports this first, and the web router
 * imports it for the kit calls the app makes directly.
 */
const optOut = globalThis as {process?: {env?: Record<string, string | undefined>}; doNotTrack?: string | null};
if (optOut.process?.env) optOut.process.env["DO_NOT_TRACK"] ??= "1";
if (typeof window !== "undefined") optOut.doNotTrack ??= "1";
