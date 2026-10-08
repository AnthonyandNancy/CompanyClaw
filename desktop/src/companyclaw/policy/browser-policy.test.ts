import { describe, expect, it } from "vitest";
import {
  BrowserPolicy,
  classifyBrowserAction,
  isDomainAllowed,
  normalizeDomain,
} from "./browser-policy";

describe("normalizeDomain", () => {
  it("lowercases and strips a trailing dot", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
  });

  it("rejects an empty or malformed host", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("not a host")).toBeNull();
    expect(normalizeDomain("http://example.com")).toBeNull();
  });

  it("accepts an IPv4 literal and a bracketed IPv6 literal", () => {
    expect(normalizeDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeDomain("[::1]")).toBe("[::1]");
  });
});

describe("isDomainAllowed", () => {
  const allowed = ["oa.example.com", "intranet.example.cn"];

  it("allows an exact host", () => {
    expect(isDomainAllowed("oa.example.com", allowed)).toBe(true);
  });

  it("allows a subdomain of an allowed host", () => {
    expect(isDomainAllowed("workflow.oa.example.com", allowed)).toBe(true);
  });

  it("refuses a host that merely ends with the allowed text", () => {
    // "evil-oa.example.com" must not pass as a subdomain of oa.example.com.
    expect(isDomainAllowed("evil-oa.example.com", allowed)).toBe(false);
    expect(isDomainAllowed("oa.example.com.evil.net", allowed)).toBe(false);
  });

  it("refuses everything when the allow list is empty", () => {
    expect(isDomainAllowed("oa.example.com", [])).toBe(false);
  });

  it("refuses an unparseable host", () => {
    expect(isDomainAllowed("http://oa.example.com", allowed)).toBe(false);
  });
});

describe("classifyBrowserAction", () => {
  it("treats navigation, reading and searching as read-only candidates", () => {
    for (const action of ["navigate", "read", "search", "snapshot", "screenshot"] as const) {
      expect(classifyBrowserAction(action)).toBe("read");
    }
  });

  it("treats submission-like actions as writes", () => {
    for (const action of [
      "click-submit",
      "fill-form",
      "upload",
      "download",
      "edit-field",
    ] as const) {
      expect(classifyBrowserAction(action)).toBe("write");
    }
  });

  it("treats an unrecognised action as a write, never as a read", () => {
    // A generic click can save a record; it must not slip through as read-only.
    expect(classifyBrowserAction("click")).toBe("write");
    expect(classifyBrowserAction("unknown-action")).toBe("write");
  });

  it("classifies destructive actions as high risk", () => {
    for (const action of ["delete", "publish", "pay"] as const) {
      expect(classifyBrowserAction(action)).toBe("high-risk");
    }
  });
});

describe("BrowserPolicy", () => {
  const policy = new BrowserPolicy({
    allowedDomains: ["oa.example.com"],
    allowDownloads: false,
    allowUploads: false,
  });

  it("allows navigation to an approved domain", () => {
    expect(
      policy.authorize({ action: "navigate", url: "https://oa.example.com/tickets" }),
    ).toEqual({ allowed: true, risk: "read" });
  });

  it("refuses navigation to any other domain", () => {
    expect(policy.authorize({ action: "navigate", url: "https://evil.net/" })).toEqual({
      allowed: false,
      reason: "domain-not-allowed",
    });
  });

  it("refuses a non-http(s) scheme", () => {
    expect(policy.authorize({ action: "navigate", url: "file:///C:/Windows/System32" })).toEqual({
      allowed: false,
      reason: "unsupported-scheme",
    });
    expect(policy.authorize({ action: "navigate", url: "javascript:alert(1)" })).toEqual({
      allowed: false,
      reason: "unsupported-scheme",
    });
  });

  it("refuses an unparseable url", () => {
    expect(policy.authorize({ action: "navigate", url: "http://" })).toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });

  it("reports a write on an approved domain as requiring approval", () => {
    expect(
      policy.authorize({ action: "fill-form", url: "https://oa.example.com/tickets" }),
    ).toEqual({ allowed: true, risk: "write" });
  });

  it("refuses a download while downloads are disabled, even on an approved domain", () => {
    expect(
      policy.authorize({ action: "download", url: "https://oa.example.com/report.xlsx" }),
    ).toEqual({ allowed: false, reason: "downloads-disabled" });
  });

  it("refuses an upload while uploads are disabled", () => {
    expect(policy.authorize({ action: "upload", url: "https://oa.example.com/" })).toEqual({
      allowed: false,
      reason: "uploads-disabled",
    });
  });

  it("reports a destructive action on an approved domain as high risk", () => {
    expect(policy.authorize({ action: "delete", url: "https://oa.example.com/tickets/1" })).toEqual({
      allowed: true,
      risk: "high-risk",
    });
  });

  it("refuses a destructive action on an unapproved domain", () => {
    expect(policy.authorize({ action: "delete", url: "https://evil.net/x" })).toEqual({
      allowed: false,
      reason: "domain-not-allowed",
    });
  });

  it("refuses a private-address target while the domain is unapproved", () => {
    // The allow list is what makes intranet access explicit; a bare IP must not
    // be usable to reach arbitrary hosts.
    expect(policy.authorize({ action: "navigate", url: "http://192.168.1.10/admin" })).toEqual({
      allowed: false,
      reason: "domain-not-allowed",
    });
  });
});
