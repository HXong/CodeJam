import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectCapabilities,
  VerificationCheck,
} from "./verification-policy.js";

const SUPPORTED_SCRIPTS: VerificationCheck[] = [
  "typecheck",
  "test",
  "build",
];

export async function detectProjectCapabilities(
  workspacePath: string,
): Promise<ProjectCapabilities> {
  const packageJsonPath = path.join(
    workspacePath,
    "package.json",
  );

  try {
    const raw = await readFile(packageJsonPath, "utf8");

    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, unknown>;
    };

    const scripts = parsed.scripts ?? {};

    return {
      packageManager: "npm",
      scripts: SUPPORTED_SCRIPTS.filter(
        (script) =>
          typeof scripts[script] === "string" &&
          scripts[script].trim().length > 0,
      ),
    };
  } catch {
    return {
      packageManager: null,
      scripts: [],
    };
  }
}
