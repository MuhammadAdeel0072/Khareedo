// Unit tests — SSRF guard for server-side fetches of admin-supplied URLs
// (banner image import). Loopback, private, CGNAT and link-local ranges
// (including the cloud metadata endpoint) must be blocked by literal and by
// DNS resolution; only public http(s) URLs may pass.
import { describe, expect, it } from "vitest";
import { isPrivateAddress, assertPublicHttpUrl, SsrfBlockedError } from "@/lib/ssrf-guard";

describe("isPrivateAddress — IPv4 ranges", () => {
  it("blocks loopback", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.8.8.8")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
  });

  it("blocks CGNAT and link-local (incl. cloud metadata)", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("169.254.0.1")).toBe(true);
  });

  it("blocks reserved and documentation ranges", () => {
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("240.0.0.1")).toBe(true);
    expect(isPrivateAddress("255.255.255.255")).toBe(true);
    expect(isPrivateAddress("192.0.2.1")).toBe(true);
    expect(isPrivateAddress("198.51.100.7")).toBe(true);
    expect(isPrivateAddress("203.0.113.9")).toBe(true);
    expect(isPrivateAddress("198.18.0.2")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateAddress("100.128.0.1")).toBe(false); // just outside CGNAT
  });
});

describe("isPrivateAddress — IPv6", () => {
  it("blocks loopback, unspecified, unique-local and link-local", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});

describe("assertPublicHttpUrl — scheme, credentials and DNS", () => {
  it("rejects non-http schemes outright", async () => {
    await expect(assertPublicHttpUrl("javascript:alert(1)")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects URLs with embedded credentials", async () => {
    await expect(assertPublicHttpUrl("https://user:pass@example.com/x.png")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("rejects unparseable URLs", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks literal private/metadata hosts", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1:5434/x.png")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
    await expect(assertPublicHttpUrl("http://192.168.1.10/admin")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows literal public hosts", async () => {
    const url = await assertPublicHttpUrl("https://8.8.8.8/image.jpg");
    expect(url.hostname).toBe("8.8.8.8");
  });

  it("blocks named hosts that resolve to private addresses (localhost)", async () => {
    await expect(assertPublicHttpUrl("http://localhost:3000/storage/x.png")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("allows named public hosts (real DNS)", async () => {
    const url = await assertPublicHttpUrl("https://example.com/a.jpg");
    expect(url.protocol).toBe("https:");
  });
});
