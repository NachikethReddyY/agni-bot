import { describe, expect, test } from "bun:test";
import { dotStuff, sendEmail, checkHeaderValue, normalizeRecipients } from "../src/mail/smtp";
import { imapQuote } from "../src/mail/imap";
import { buildSearchCriteria, parseAccount } from "../src/tools/mail";

const cfg = { host: "127.0.0.1", port: 1, user: "u", pass: "p" };

describe("mail injection", () => {
  test("body is CRLF-normalised and dot-stuffed", () => {
    expect(dotStuff("hi\r\n.\r\nMAIL FROM:<x>")).toBe("hi\r\n..\r\nMAIL FROM:<x>");
    expect(dotStuff("a\n.b")).toBe("a\r\n..b");
  });
  test("CRLF in subject/from/to rejected before connecting", async () => {
    expect(() => checkHeaderValue("subject", "x\r\nBcc: e@v.il")).toThrow();
    expect((await sendEmail(cfg, "a@b.c", ["x@y.z"], "s\r\nBcc: e@v.il", "b")).ok).toBe(false);
    expect((await sendEmail(cfg, "a@b.c\r\nX: y", ["x@y.z"], "s", "b")).ok).toBe(false);
    expect((await sendEmail(cfg, "a@b.c", ["x@y.z\nRCPT TO:<e@v.il>"], "s", "b")).ok).toBe(false);
  });
  test("recipients: string wrapped, non-array rejected, bad addr rejected", () => {
    expect(normalizeRecipients("a@b.c")).toEqual(["a@b.c"]);
    expect(() => normalizeRecipients({ length: 1 })).toThrow();
    expect(() => normalizeRecipients(["a b@c.d"])).toThrow();
    expect(() => normalizeRecipients(["<a@b.c>"])).toThrow();
  });
  test("IMAP quoting", () => {
    expect(imapQuote('pa"ss\\x')).toBe('"pa\\"ss\\\\x"');
    expect(() => imapQuote("a\r\nA9 STORE 1 +FLAGS (\\Deleted)")).toThrow();
    expect(() => imapQuote("a\0b")).toThrow();
    expect(() => buildSearchCriteria("x\r\nA9 STORE")).toThrow();
  });
  test("account must be exactly agent|owner", () => {
    expect(parseAccount(undefined)).toBe("agent");
    expect(parseAccount(" owner ")).toBe("owner");
    expect(parseAccount("Owner")).toBeNull();
    expect(parseAccount("other")).toBeNull();
  });
});
