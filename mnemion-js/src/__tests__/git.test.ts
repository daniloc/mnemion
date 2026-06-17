import { describe, it, expect } from "vitest";
import {
  synthesizeRepo,
  handleInfoRefs,
  buildMarketplaceFiles,
  type FileTree,
  type MarketplacePlugin,
} from "../../shared/IO/git";

describe("synthesizeRepo", () => {
  it("creates objects from a file tree", () => {
    const files: FileTree = {
      "README.md": "# Hello",
      "src/index.ts": "console.log('hi')",
    };
    const { objects, headSha } = synthesizeRepo(files);
    expect(objects.length).toBeGreaterThan(0);
    expect(headSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("produces deterministic SHAs for same content", () => {
    const files: FileTree = { "a.txt": "content" };
    const r1 = synthesizeRepo(files);
    const r2 = synthesizeRepo(files);
    expect(r1.headSha).toBe(r2.headSha);
  });

  it("produces different SHAs for different content", () => {
    const r1 = synthesizeRepo({ "a.txt": "hello" });
    const r2 = synthesizeRepo({ "a.txt": "world" });
    expect(r1.headSha).not.toBe(r2.headSha);
  });

  it("handles nested directories", () => {
    const files: FileTree = {
      "a/b/c/file.txt": "deep",
      "a/b/other.txt": "sibling",
      "top.txt": "root",
    };
    const { objects, headSha } = synthesizeRepo(files);
    expect(objects.length).toBeGreaterThan(0);
    expect(headSha).toBeDefined();
  });

  it("handles empty file content", () => {
    const files: FileTree = { "empty.txt": "" };
    const { objects, headSha } = synthesizeRepo(files);
    expect(headSha).toBeDefined();
  });
});

describe("handleInfoRefs", () => {
  it("returns a valid git info/refs response", () => {
    const sha = "a".repeat(40);
    const response = handleInfoRefs(sha);
    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement"
    );
  });

  it("includes the HEAD sha in the response", async () => {
    const sha = "b".repeat(40);
    const response = handleInfoRefs(sha);
    const body = await response.text();
    expect(body).toContain(sha);
    expect(body).toContain("refs/heads/main");
  });
});

describe("buildMarketplaceFiles", () => {
  it("builds file tree from plugins", () => {
    const plugins: MarketplacePlugin[] = [
      {
        name: "test-plugin",
        description: "A test",
        version: "1.0.0",
        skills: [
          {
            name: "greet",
            description: "Says hello",
            skill_md: "# Greet\nSay hello to the user.",
          },
        ],
      },
    ];

    const files = buildMarketplaceFiles(plugins);
    expect(files[".claude-plugin/marketplace.json"]).toBeDefined();
    expect(files["plugins/test-plugin/.claude-plugin/plugin.json"]).toBeDefined();
    expect(files["plugins/test-plugin/skills/greet/SKILL.md"]).toBeDefined();

    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe("test-plugin");
  });

  it("includes optional plugin files", () => {
    const plugins: MarketplacePlugin[] = [
      {
        name: "full-plugin",
        description: "Has everything",
        version: "2.0.0",
        skills: [],
        claude_md: "# Plugin Instructions",
        mcp_json: '{"mcpServers": {}}',
        settings_json: '{"key": "value"}',
      },
    ];

    const files = buildMarketplaceFiles(plugins);
    expect(files["plugins/full-plugin/CLAUDE.md"]).toBe("# Plugin Instructions");
    expect(files["plugins/full-plugin/.mcp.json"]).toBe('{"mcpServers": {}}');
    expect(files["plugins/full-plugin/settings.json"]).toBe('{"key": "value"}');
  });

  it("generates SKILL.md with frontmatter", () => {
    const plugins: MarketplacePlugin[] = [
      {
        name: "fm-test",
        description: "Frontmatter test",
        version: "1.0.0",
        skills: [
          {
            name: "do-thing",
            description: "Does the thing",
            argument_hint: "[target]",
            skill_md: "Execute the thing on target.",
          },
        ],
      },
    ];

    const files = buildMarketplaceFiles(plugins);
    const skillContent = files["plugins/fm-test/skills/do-thing/SKILL.md"];
    expect(skillContent).toContain("---");
    expect(skillContent).toContain("name: do-thing");
    expect(skillContent).toContain("description: Does the thing");
    expect(skillContent).toContain('argument-hint: "[target]"');
    expect(skillContent).toContain("Execute the thing on target.");
  });

  it("handles empty plugin list", () => {
    const files = buildMarketplaceFiles([]);
    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]);
    expect(marketplace.plugins).toHaveLength(0);
  });

  it("uses custom owner name", () => {
    const files = buildMarketplaceFiles([], "Custom Owner");
    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]);
    expect(marketplace.owner.name).toBe("Custom Owner");
  });
});
