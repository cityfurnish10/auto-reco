// Every route handler answers in JSON, including the ways it was never meant
// to fail.
//
// WHAT WENT WRONG WITHOUT THIS. A handler that threw — a missing env var, a
// client constructed against a URL that isn't there, any unanticipated null —
// escaped to the framework, which replies 500 with an EMPTY BODY. The browser
// then does `res.json()` on nothing and raises
//
//     Failed to execute 'json' on 'Response': Unexpected end of JSON input
//
// which is what the dashboard printed at warehouse staff. Note the shape of it:
// the client's own fallback (`json.error ?? \`HTTP ${status}\``) could never fire,
// because reading the body is what threw. Every careful bit of error handling on
// the client was dead code as long as the server could answer with nothing.
//
// So the contract is: a JSON body ALWAYS, on every path. The routes' own
// `NextResponse.json({ error })` returns are unaffected — this only catches what
// would otherwise have escaped.
//
// The message is passed through rather than replaced with "Internal error".
// This is an internal operations tool used by five warehouse teams and read by
// the person who will be asked to fix it; a generic string just means the next
// step is opening Vercel logs. It is not a public API.

import { NextResponse } from "next/server";

/**
 * Wrap a route handler so an unexpected throw becomes a JSON 500.
 *
 * Used as `export const GET = jsonRoute("variances", async (req) => {...})`.
 * The name is what the UI shows after "Could not load…", so it should read as
 * the thing being fetched, not as a file path.
 */
export function jsonRoute<A extends unknown[]>(
  name: string,
  handler: (...args: A) => Promise<Response>
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Server-side so it reaches the platform logs; the client only gets the
      // envelope below.
      console.error(`[api:${name}]`, e);
      return NextResponse.json({ error: message, route: name }, { status: 500 });
    }
  };
}
