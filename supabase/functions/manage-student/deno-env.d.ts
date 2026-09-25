// Minimal ambient declarations used ONLY to type-check this function with plain
// `tsc` where the Deno CLI is not installed. No module imports this file and
// the Deno runtime/bundler never loads it; under `deno check` the real Deno
// types apply instead. Keep it limited to the APIs the function uses.

declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

// getEnv() also reads process.env so Node-based tests can configure the function.
declare const process: { env: Record<string, string | undefined> } | undefined;
