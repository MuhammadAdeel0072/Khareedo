// Route-level tests for login brute-force protection (Phase 2, area A).
//
// These go through the real NextAuth route handler, because the authorize
// function the app passes to CredentialsProvider only becomes the live
// `provider.authorize` after NextAuth's parseProviders merge (the raw
// `authOptions.providers[0].authorize` is the library's `() => null` stub,
// so calling it directly proves nothing). The handler is re-imported per
// test (vi.resetModules) so the in-memory limiter starts empty.
//
// The exported handler is called in its pages-router form — handler(req,
// res) with plain objects — because the App Router form reads cookies and
// headers through next/headers, which cannot run outside a request scope
// in a unit test. The core AuthHandler (and therefore authorize and the
// limiter) is identical either way.
//
// Flow: GET /api/auth/csrf for a token + cookie, then POST
// /api/auth/callback/credentials with a form body. A wrong password
// answers with error=CredentialsSignin; a rate-limited attempt answers
// with error=TooManyLoginAttempts — even with the right password.
import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { LOGIN_EMAIL_LIMIT } from "@/lib/login-rate-limit";

const { mockFindUserByEmail } = vi.hoisted(() => ({
  mockFindUserByEmail: vi.fn(),
}));

vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));

type PagesHandler = (req: Record<string, unknown>, res: Record<string, unknown>) => Promise<unknown>;

let handler: PagesHandler;

async function freshHandler() {
  vi.resetModules();
  process.env.NEXTAUTH_SECRET = "test-nextauth-secret-32-chars-long!!";
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  const mod = (await import("@/app/api/auth/[...nextauth]/route")) as {
    POST: PagesHandler;
  };
  handler = mod.POST;
}

function mockRes() {
  const res: Record<string, unknown> & {
    statusCode: number;
    headers: Record<string, string | string[]>;
    body: string;
  } = {
    statusCode: 200,
    headers: {},
    body: "",
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    getHeader(name: string) {
      return res.headers[name];
    },
    setHeader(name: string, value: string | string[]) {
      res.headers[name] = value;
      return res;
    },
    json(data: unknown) {
      res.body = JSON.stringify(data);
      return res;
    },
    send(data: unknown) {
      res.body = typeof data === "string" ? data : JSON.stringify(data);
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

async function csrfToken() {
  const req = {
    query: { nextauth: ["csrf"] },
    method: "GET",
    cookies: {},
    headers: {},
    body: undefined,
  };
  const res = mockRes();
  await handler(req, res);
  expect(res.statusCode).toBe(200);
  const { csrfToken } = JSON.parse(res.body) as { csrfToken: string };
  const setCookie = res.headers["Set-Cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string];
  // The csrf cookie is "name=token|hash" (URL-encoded, so the "|" arrives
  // as %7C — decode it, as a browser's cookie parser would, before
  // sending it back). Other cookies (e.g. callback-url) are ignored.
  const cookieHeader = cookies.find((c) => c.startsWith("next-auth.csrf-token="));
  expect(cookieHeader).toBeTruthy();
  const [pair] = (cookieHeader as string).split(";");
  const [name, rawValue] = pair.split("=");
  const value = decodeURIComponent(rawValue);
  expect(csrfToken).toBeTruthy();
  expect(name).toContain("next-auth.csrf-token");
  return { csrfToken, name, value };
}

async function signIn(
  email: string,
  password: string,
  ip: string,
  csrf: { csrfToken: string; name: string; value: string },
) {
  const req = {
    query: { nextauth: ["callback", "credentials"] },
    method: "POST",
    body: {
      csrfToken: csrf.csrfToken,
      email,
      password,
      callbackUrl: "http://localhost:3000/account",
      json: "true",
    },
    cookies: { [csrf.name]: csrf.value },
    headers: { "x-forwarded-for": ip, cookie: `${csrf.name}=${csrf.value}` },
  };
  const res = mockRes();
  await handler(req, res);
  const data = JSON.parse(res.body || "{}") as { url?: string };
  return { status: res.statusCode, url: data.url ?? "" };
}

describe("login rate limiting (route level)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await freshHandler();
  });

  it("returns TooManyLoginAttempts after the email budget is exhausted", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 4);
    mockFindUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "victim@example.com",
      name: "Victim",
      passwordHash,
      emailVerified: new Date(),
      role: "CUSTOMER",
    });
    const csrf = await csrfToken();
    const email = `route-${Date.now()}@example.invalid`;
    const ip = "203.0.113.201";
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      const res = await signIn(email, "wrong-password", ip, csrf);
      expect(res.url).toContain("error=CredentialsSignin");
    }
    // The next attempt — even with the RIGHT password — is refused by the
    // limiter before the database lookup / bcrypt.
    const limited = await signIn(email, "correct-password", ip, csrf);
    expect(limited.url).toContain("error=TooManyLoginAttempts");
    // The database was consulted only for the five real failures: the
    // limited attempt never reached it.
    expect(mockFindUserByEmail).toHaveBeenCalledTimes(LOGIN_EMAIL_LIMIT);
  });

  it("does not consume the budget on a successful sign-in", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 4);
    mockFindUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "victim@example.com",
      name: "Victim",
      passwordHash,
      emailVerified: new Date(),
      role: "CUSTOMER",
    });
    const csrf = await csrfToken();
    const email = `route-ok-${Date.now()}@example.invalid`;
    const ip = "203.0.113.202";
    const ok = await signIn(email, "correct-password", ip, csrf);
    expect(ok.url).not.toContain("error=");
    // A success consumes nothing: five failures are still needed to lock
    // this email out, and the fifth failure is still CredentialsSignin.
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      const res = await signIn(email, "wrong-password", ip, csrf);
      expect(res.url).toContain("error=CredentialsSignin");
    }
    const limited = await signIn(email, "wrong-password", ip, csrf);
    expect(limited.url).toContain("error=TooManyLoginAttempts");
  });
});
