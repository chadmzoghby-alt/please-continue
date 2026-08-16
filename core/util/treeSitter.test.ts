import path from "node:path";

import { resolveTreeSitterPaths } from "./treeSitter";

describe("resolveTreeSitterPaths", () => {
  const cwd = path.join("repo", "core");
  const moduleDir = path.join("snapshot", "binary", "out");

  it("uses repository test assets for an ordinary test process", () => {
    expect(
      resolveTreeSitterPaths({
        cwd,
        isPackaged: false,
        moduleDir,
        nodeEnv: "test",
      }),
    ).toEqual({
      queryDirectory: path.join(
        cwd,
        "..",
        "extensions",
        "vscode",
        "tree-sitter",
      ),
      wasmDirectory: path.join(cwd, "node_modules", "tree-sitter-wasms", "out"),
    });
  });

  it("uses embedded production assets for a packaged test process", () => {
    expect(
      resolveTreeSitterPaths({
        cwd,
        isPackaged: true,
        moduleDir,
        nodeEnv: "test",
      }),
    ).toEqual({
      queryDirectory: path.join(moduleDir, "..", "tree-sitter"),
      wasmDirectory: path.join(moduleDir, "tree-sitter-wasms"),
    });
  });
});
