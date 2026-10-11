import { describe, expect, it } from "vitest";
import { renderPageShell } from "./shell.js";

describe("renderPageShell — navigation chrome", (): void => {
  it("renders the sidebar, active item, model and uptime", (): void => {
    const html = renderPageShell({
      title: "Plugins",
      content: "<h1>Content</h1>",
      nav: { active: "plugins", model: "claude-opus-5-5", uptime: "2 hours, 42 minutes" },
    });

    expect(html).toContain('href="/assets/sb.css"');
    expect(html).toContain('class="sb-nav-item is-active" href="/settings/plugins"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("claude-opus-5-5");
    expect(html).toContain("Online · 2 hours, 42 minutes");
    expect(html).toContain("<h1>Content</h1>");
  });

  it("renders the desktop navigation items in order", (): void => {
    const html = renderPageShell({
      title: "Overview",
      content: "",
      nav: { active: "overview", model: "m", uptime: "" },
    });

    const hrefs = ["/", "/settings/allowlist", "/settings/plugins", "/explorer", "/settings/config", "/settings"];
    let previousIndex = -1;
    for (const href of hrefs) {
      const index = html.indexOf(`href="${href}"`);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(html).toContain("Online");
    expect(html).not.toContain("Online ·");
  });

  it("marks the desktop Settings item active on the settings hub", (): void => {
    const html = renderPageShell({
      title: "Settings",
      content: "",
      nav: { active: "settings", model: "m", uptime: "" },
    });

    expect(html).toContain('class="sb-nav-item is-active" href="/settings"');
    expect(html).toContain('class="sb-tab is-active" href="/settings"');
  });

  it("renders the five mobile tabs and keeps Settings active for Config", (): void => {
    const html = renderPageShell({
      title: "Config",
      content: "",
      nav: { active: "config", model: "m", uptime: "5 minutes" },
    });

    expect(html).toContain('class="sb-tab is-active" href="/settings"');
    expect(html).toContain('href="/settings/allowlist"');
    expect(html).toContain('href="/settings/plugins"');
    expect(html).toContain('href="/explorer"');
    expect(html).toContain('href="/"');
    expect(html).toContain("sb-tabbar");
    expect(html).toContain("sb-m-header");
  });
});

describe("renderPageShell — no navigation", (): void => {
  it("renders a centered card without sidebar or tab bar", (): void => {
    const html = renderPageShell({
      title: "Log in",
      content: '<div class="sb-card">Sign in</div>',
    });

    expect(html).toContain('<div class="sb-centered"><div class="sb-auth-card">');
    expect(html).toContain("Sign in");
    expect(html).not.toContain("sb-sidebar");
    expect(html).not.toContain("sb-tabbar");
  });
});

describe("renderPageShell — escaping", (): void => {
  it("escapes the title and model instead of injecting markup", (): void => {
    const html = renderPageShell({
      title: '<script>alert("x")</script>',
      content: "",
      nav: { active: "overview", model: "<b>m</b>", uptime: "a & b" },
    });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;m&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
  });
});
