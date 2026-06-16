// Minimal undici-MockAgent-compatible shim over globalThis.fetch.
//
// @cloudflare/vitest-pool-workers v0.16 (vitest 4) removed the `fetchMock`
// export from `cloudflare:test`; the sanctioned replacement is mocking
// `globalThis.fetch`. Rather than rewrite every call site, this reimplements the
// exact subset of the MockAgent API the tests use, so the existing
// `.get(origin).intercept({...}).reply(...)` calls work unchanged.
//
// Supported: activate(), deactivate(), disableNetConnect(), get(origin) →
// intercept({ path: string|RegExp, method?, headers? }) → reply(status, body,
// { headers }). Interceptors are consumed once (undici default). String paths
// match url.pathname; RegExp paths match url.pathname + url.search.

interface InterceptOptions {
  path: string | RegExp;
  method?: string;
  headers?: Record<string, string>;
}

interface Interceptor {
  origin: string;
  opts: InterceptOptions;
  reply?: { status: number; body: string; headers?: Record<string, string> };
}

class FetchMock {
  private originalFetch: typeof fetch | null = null;
  private interceptors: Interceptor[] = [];
  private netConnect = true;

  activate(): void {
    if (!this.originalFetch) this.originalFetch = globalThis.fetch;
    this.interceptors = [];
    this.netConnect = true;
    globalThis.fetch = ((input: any, init?: any) => this.handle(input, init)) as typeof fetch;
  }

  deactivate(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
    this.interceptors = [];
    this.netConnect = true;
  }

  disableNetConnect(): void {
    this.netConnect = false;
  }

  enableNetConnect(): void {
    this.netConnect = true;
  }

  get(origin: string) {
    return {
      intercept: (opts: InterceptOptions) => {
        const interceptor: Interceptor = { origin, opts };
        this.interceptors.push(interceptor);
        return {
          reply: (status: number, body: string, replyOpts?: { headers?: Record<string, string> }) => {
            interceptor.reply = { status, body, headers: replyOpts?.headers };
            return interceptor;
          },
        };
      },
    };
  }

  private matches(i: Interceptor, url: URL, method: string, headers: Headers): boolean {
    if (i.origin !== url.origin) return false;
    if (i.opts.method && i.opts.method.toUpperCase() !== method.toUpperCase()) return false;
    const p = i.opts.path;
    if (typeof p === "string") {
      if (url.pathname !== p) return false;
    } else if (!p.test(url.pathname + url.search)) {
      return false;
    }
    if (i.opts.headers) {
      for (const [name, value] of Object.entries(i.opts.headers)) {
        if (headers.get(name) !== value) return false;
      }
    }
    return true;
  }

  private async handle(input: any, init?: any): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method ?? (typeof input === "object" ? input.method : undefined) ?? "GET") as string;
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));

    const idx = this.interceptors.findIndex(
      (i) => i.reply && this.matches(i, url, method, headers)
    );
    if (idx !== -1) {
      const { reply } = this.interceptors[idx];
      this.interceptors.splice(idx, 1); // consume once
      return new Response(reply!.body, { status: reply!.status, headers: reply!.headers });
    }
    if (!this.netConnect) {
      throw new Error(`fetch-mock: no interceptor for ${method} ${url.href} (net connect disabled)`);
    }
    return this.originalFetch!(input, init);
  }
}

export const fetchMock = new FetchMock();
