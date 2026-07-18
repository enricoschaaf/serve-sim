import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { resolve } from "path";
import { parseDeepLinkManifest, readDeepLinkManifest } from "../deep-links";
import { simMiddleware } from "../middleware";
import {
  groupDeepLinksByAuthentication,
  resolveDeepLink,
} from "../client/components/deep-links-panel";

const DEVICE = "12345678-1234-1234-1234-123456789ABC";
const TOKEN = "deep-link-token";
const opened: Array<{ device: string; url: string }> = [];
const middleware = simMiddleware({
  basePath: "/",
  device: DEVICE,
  execToken: TOKEN,
  openDeepLink: async (device, url) => { opened.push({ device, url }); },
});
const server = createHttpServer((req, res) => void middleware(req, res));
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("deep link manifests", () => {
  test("ships only relevant V2 routes grouped by authentication requirement", () => {
    const manifest = readDeepLinkManifest(resolve(import.meta.dir, "../../manifests/green-got-v2.json"));
    expect(manifest.links).toHaveLength(52);
    expect(new Set(manifest.links.map((link) => link.url)).size).toBe(52);
    expect(manifest.links.every((link) => link.url.startsWith("green-got-staging://v2"))).toBe(true);
    expect(manifest.links.some((link) => link.group === "Debug")).toBe(false);
    expect(manifest.links.filter((link) => !link.requiresAuthentication).map((link) => link.url)).toEqual([
      "green-got-staging://v2/login",
      "green-got-staging://v2/onboarding",
    ]);
    expect(manifest.links.filter((link) => link.requiresAuthentication)).toHaveLength(50);
  });

  test("puts public routes before authenticated routes while retaining feature groups", () => {
    const manifest = readDeepLinkManifest(resolve(import.meta.dir, "../../manifests/green-got-v2.json"));
    const sections = groupDeepLinksByAuthentication(manifest.links);
    expect(sections.map(({ title }) => title)).toEqual([
      "Available without authentication",
      "Requires authentication",
    ]);
    expect(sections[0]?.groups.flatMap(([, links]) => links).map((link) => link.title)).toEqual([
      "Login",
      "V2 onboarding",
    ]);
    expect(sections[1]?.groups.some(([group]) => group === "Cards")).toBe(true);
  });

  test("validates inventory entries and resolves URL-encoded parameters", () => {
    const manifest = parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Cards",
        title: "Card details",
        url: "green-got-staging://v2/card/{id}",
      }],
    });
    expect(resolveDeepLink(manifest.links[0]!, { id: "card / 42" }))
      .toBe("green-got-staging://v2/card/card%20%2F%2042");
    expect(resolveDeepLink(manifest.links[0]!, {})).toBeNull();
    expect(manifest.links[0]?.requiresAuthentication).toBe(true);
  });

  test("uses parameter defaults and preserves human-readable field metadata", () => {
    const manifest = parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Debug",
        title: "Custom setup",
        url: "green-got-staging://v2/custom-setup?channel={channel}&mock={mock}&next={next}",
        parameters: [
          { name: "channel", label: "Expo channel", placeholder: "agent/my-branch" },
          { name: "mock", label: "Mock mode", default: "0" },
          { name: "next", label: "Open after setup", default: "/v2/onboarding" },
        ],
      }],
    });
    const link = manifest.links[0]!;
    expect(link.parameters?.[0]).toEqual({
      name: "channel",
      label: "Expo channel",
      placeholder: "agent/my-branch",
    });
    expect(resolveDeepLink(link, { channel: "agent/my branch" })).toBe(
      "green-got-staging://v2/custom-setup?channel=agent%2Fmy%20branch&mock=0&next=%2Fv2%2Fonboarding",
    );
  });

  test("rejects non-boolean authentication metadata", () => {
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Onboarding",
        title: "Onboarding",
        url: "green-got-staging://v2/onboarding",
        requiresAuthentication: "no",
      }],
    })).toThrow("requiresAuthentication must be a boolean");
  });

  test("rejects malformed, cross-scheme, and inconsistent manifest entries", () => {
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{ group: "Debug", title: "Bad", url: "/v2/onboarding" }],
    })).toThrow("URL must be absolute");
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{ group: "Debug", title: "Bad", url: "https://example.test/v2" }],
    })).toThrow("must use the green-got-staging scheme");
    expect(() => parseDeepLinkManifest({
      scheme: "green-got-staging",
      links: [{
        group: "Debug",
        title: "Bad",
        url: "green-got-staging://v2/{id}",
        parameters: [{ name: "missing" }],
      }],
    })).toThrow("parameter missing is not present");
  });
});

describe("deep link endpoint", () => {
  test("opens the URL on the selected simulator", async () => {
    opened.length = 0;
    const url = "green-got-staging://v2/onboarding";
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    expect(response.status).toBe(200);
    expect(opened).toEqual([{ device: DEVICE, url }]);
  });

  test("does not expose simulator control without the preview token", async () => {
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects cross-origin and non-JSON simulator control requests", async () => {
    const crossOrigin = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(crossOrigin.status).toBe(403);

    const text = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ url: "green-got-staging://v2/onboarding" }),
    });
    expect(text.status).toBe(415);
  });

  test("rejects malformed URLs before invoking simulator control", async () => {
    opened.length = 0;
    const response = await fetch(`${origin}/api/deep-links/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "/v2/onboarding" }),
    });
    expect(response.status).toBe(400);
    expect(opened).toEqual([]);
  });
});
