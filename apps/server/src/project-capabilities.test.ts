import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { detectProjectCapabilities } from "./project-capabilities.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "safecommit-capabilities-"),
  );

  temporaryDirectories.push(root);
  return root;
}

describe("detectProjectCapabilities", () => {
  it("detects supported npm scripts", async () => {
    const root = await workspace();

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest run",
          typecheck: "tsc --noEmit",
          build: "tsc",
          dev: "vite",
        },
      }),
      "utf8",
    );

    const result =
      await detectProjectCapabilities(root);

    expect(result).toEqual({
      packageManager: "npm",
      scripts: ["typecheck", "test", "build"],
    });
  });

  it("returns no executable capabilities when package.json is absent", async () => {
    const root = await workspace();

    expect(
      await detectProjectCapabilities(root),
    ).toEqual({
      packageManager: null,
      scripts: [],
    });
  });
});
