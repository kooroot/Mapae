/**
 * viem's `ContractFunctionExecutionError.message` is a ~700-character block
 * written for a terminal: the request body, the raw call arguments, a docs URL
 * and the library version. Interpolated into a 390px column with no
 * `white-space` rule it collapsed into one run-on red paragraph roughly twenty
 * lines deep, and carried the full `eth_call` payload into any screenshot. The
 * first line is the only part a console reader can act on.
 */
export function faultLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const first = message.split("\n", 1)[0]?.trim();
    if (!first) return "알 수 없는 오류";
    return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}
