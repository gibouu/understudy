/**
 * Upstash's REST pipeline, in memory: the commands the app sends (GET, INCRBY,
 * DECRBY, RPUSH, ZADD NX), behind a stubbed fetch and the integration's env
 * vars. `down` makes every request fail as a network error would; a command
 * named in `refuse` answers an error, as a full store does. No test
 * reaches a real store.
 */
import { vi } from "vitest";

export type FakeRedis = { data: Map<string, unknown>; requests: unknown[][]; down: boolean; refuse: string[] };

export function fakeRedis(): FakeRedis {
  const r: FakeRedis = { data: new Map(), requests: [], down: false, refuse: [] };
  vi.stubEnv("KV_REST_API_URL", "https://fake-store.test");
  vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith("https://fake-store.test")) return real(url, init);
    if (r.down) throw new TypeError("fetch failed");
    const commands = JSON.parse(String(init?.body)) as (string | number)[][];
    r.requests.push(commands);
    return Response.json(commands.map((c) => (r.refuse.includes(String(c[0])) ? { error: "OOM command not allowed" } : run(r.data, c))));
  });
  return r;
}

function run(data: Map<string, unknown>, [name, key, ...args]: (string | number)[]): { result?: unknown; error?: string } {
  const k = String(key);
  switch (name) {
    case "GET":
      return { result: data.has(k) ? String(data.get(k)) : null };
    case "INCRBY":
    case "DECRBY": {
      const n = Number(data.get(k) ?? 0) + (name === "INCRBY" ? 1 : -1) * Number(args[0]);
      data.set(k, n);
      return { result: n };
    }
    case "RPUSH": {
      const list = (data.get(k) as unknown[] | undefined) ?? [];
      list.push(...args);
      data.set(k, list);
      return { result: list.length };
    }
    case "ZADD": {
      const set = (data.get(k) as Map<string, number> | undefined) ?? new Map<string, number>();
      const [nx, score, member] = args;
      if (nx !== "NX") return { error: "ERR the fake knows ZADD NX only" };
      const added = !set.has(String(member));
      if (added) set.set(String(member), Number(score));
      data.set(k, set);
      return { result: added ? 1 : 0 };
    }
    default:
      return { error: `ERR unknown command ${name}` };
  }
}
