// Minimal runtime surface used by our entrypoints, for local tsc without Deno.
// Native Deno deployment resolves the pinned imports in each deno.json/lock.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};
