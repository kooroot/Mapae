import {MAX_INGEST_BYTES, parseIngest, type IngestPayload} from "@mapae/shared/ops-ingest";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Send one payload to the Worker. It is run through the Worker's own parser first, so a
 * payload the Worker would refuse fails here, loudly, on the machine that built it —
 * not as a 400 the Worker logs and nobody reads.
 *
 * `redirect: "error"`: a redirect would carry the bearer to wherever it points.
 */
export async function postIngest(fetchFn: Fetch, url: string, token: string, payload: IngestPayload): Promise<void> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > MAX_INGEST_BYTES || parseIngest(JSON.parse(body)) === null) {
        throw new Error("ingest_payload_invalid");
    }
    const response = await fetchFn(url, {
        method: "POST",
        headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ingest_rejected: HTTP ${response.status}`);
}
