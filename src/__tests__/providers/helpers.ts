/**
 * Shared test utilities for provider tests.
 * No Jest imports — pure helpers usable in any describe block.
 */

/** Drains an AsyncIterable into an array of tokens. */
export async function collectStream(iter: AsyncIterable<string>): Promise<string[]> {
  const tokens: string[] = [];
  for await (const token of iter) tokens.push(token);
  return tokens;
}

/** Builds a ReadableStream from an array of pre-encoded string chunks. */
export function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * Builds a mock SSE streaming Response.
 * Each item in `lines` becomes one line (a '\n' is appended automatically).
 * Pass empty strings ('') to emit the blank-line SSE event separator.
 */
export function makeSSEResponse(lines: string[], status = 200): Response {
  return new Response(makeStream(lines.map((l) => l + '\n')), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Builds a mock JSON Response (non-streaming).
 */
export function makeJSONResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Builds a mock NDJSON streaming Response (used by Ollama).
 * Each object is serialised to one line.
 */
export function makeNDJSONResponse(objects: object[], status = 200): Response {
  return new Response(makeStream(objects.map((o) => JSON.stringify(o) + '\n')), {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
