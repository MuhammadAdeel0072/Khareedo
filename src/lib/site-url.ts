// Deployment URL helpers (Phase 2, area F).
//
// The app must know whether it is served over HTTPS to set the Secure flag
// on its cookies. The only reliable signal available to the application is
// NEXTAUTH_URL: it is the operator-configured canonical origin. When it
// starts with https://, the deployment is HTTPS; anything else (unset,
// http://localhost:3000, a preview http URL) is not treated as HTTPS, so
// cookies stay readable over plain HTTP in dev/preview — where Secure
// would silently break sign-in and the guest cart.
//
// This is a deployment signal, not a request signal: it does not read
// X-Forwarded-Proto (client-controlled unless a trusted proxy overwrites
// it — see src/lib/trusted-proxy.ts).
export function isHttpsDeployment(env: { NEXTAUTH_URL?: string } = process.env): boolean {
  return (env.NEXTAUTH_URL ?? "").startsWith("https://");
}
