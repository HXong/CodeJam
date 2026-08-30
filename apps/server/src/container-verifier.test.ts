import {
  chmod,
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
import { loadConfig } from "./config.js";
import {
  buildVerifierRunArgs,
  ContainerVerifier,
} from "./container-verifier.js";
import type { VerificationPlan } from "./verification-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
    ),
  );
});

const lowPlan: VerificationPlan = {
  tier: "low",
  checks: [],
  structuralOnly: true,
  failClosedIfUnavailable: false,
  reason: "low risk",
};

const blockedPlan: VerificationPlan = {
  tier: "high",
  checks: [],
  structuralOnly: false,
  failClosedIfUnavailable: true,
  reason: "no high-risk verifier available",
};

async function fakeEngine(
  exitCode: number,
): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "safecommit-engine-"),
  );

  temporaryDirectories.push(root);

  const executable = path.join(
    root,
    "fake-engine.sh",
  );

  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "",
      'if [ -n "$ARK_API_KEY" ]; then',
      '  echo "ARK_API_KEY leaked" >&2',
      "  exit 99",
      "fi",
      "",
      'echo "verification output"',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    "utf8",
  );

  await chmod(executable, 0o755);

  return executable;
}

describe("ContainerVerifier", () => {
  it("builds a credential-free network-isolated invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "totally-real-api-key",
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "1000:1000",
      RUNTIME_INSTANCE_ID: "verify-test",
    });

    const args = buildVerifierRunArgs(
      "/tmp/workspace",
      "test",
      config,
    );

    expect(args).toContain("none");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("ALL");
    expect(args).toContain("--read-only");
    expect(args).toContain(
      "type=bind,src=/tmp/workspace,dst=/workspace",
    );
    expect(args).toContain("runtime:test");

    expect(
      args.slice(-3),
    ).toEqual(["npm", "run", "test"]);

    expect(args).not.toContain("ARK_API_KEY");
    expect(args).not.toContain("totally-real-api-key");
    expect(args).not.toContain("CODEX_HOME=/codex-home");
  });

  it("skips execution for structural-only verification", async () => {
    const verifier = new ContainerVerifier(
      loadConfig({
        NODE_ENV: "test",
        CONTAINER_ENGINE:
          "/definitely/not/a/real/container-engine",
      }),
    );

    const result = await verifier.verify(
      "/tmp/workspace",
      lowPlan,
    );

    expect(result.status).toBe("skipped");
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it("fails closed for high risk without executable checks", async () => {
    const verifier = new ContainerVerifier(
      loadConfig({
        NODE_ENV: "test",
        CONTAINER_ENGINE:
          "/definitely/not/a/real/container-engine",
      }),
    );

    const result = await verifier.verify(
      "/tmp/workspace",
      blockedPlan,
    );

    expect(result.status).toBe("blocked");
    expect(result.passed).toBe(false);
  });

  it("records a passing verification check", async () => {
    const engine = await fakeEngine(0);

    const verifier = new ContainerVerifier(
      loadConfig({
	NODE_ENV: "test",
	ARK_API_KEY: "totally-real-api-key",
	ARK_MODEL: "ep-test",
	CONTAINER_ENGINE: engine,
      }),
    );

    const result = await verifier.verify(
      "/tmp/workspace",
      {
	tier: "medium",
	checks: ["test"],
	structuralOnly: false,
	failClosedIfUnavailable: false,
	reason: "test",
      },
    );

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);

    expect(result.checks).toHaveLength(1);

    expect(result.checks[0]).toMatchObject({
      check: "test",
      status: "passed",
      exitCode: 0,
    });

    expect(
      result.checks[0]?.output,
    ).toContain("verification output");
  });

  it("stops after the first failed check", async () => {
    const engine = await fakeEngine(7);

    const verifier = new ContainerVerifier(
      loadConfig({
	NODE_ENV: "test",
	CONTAINER_ENGINE: engine,
      }),
    );

    const result = await verifier.verify(
      "/tmp/workspace",
      {
	tier: "high",
	checks: [
	  "typecheck",
	  "test",
	  "build",
	],
	structuralOnly: false,
	failClosedIfUnavailable: false,
	reason: "full verification",
      },
    );

    expect(result.status).toBe("failed");
    expect(result.passed).toBe(false);

    // First failed check proves the candidate unsafe;
    // test/build are never invoked.
    expect(result.checks).toHaveLength(1);

    expect(result.checks[0]).toMatchObject({
      check: "typecheck",
      status: "failed",
      exitCode: 7,
    });
  });
});
