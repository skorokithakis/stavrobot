import { describe, expect, it } from "vitest";
import { renderPageShell } from "./shell.js";

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
