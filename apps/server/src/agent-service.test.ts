import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceGuard } from "./workspace-guard.js";
import { type VerificationExecutor, type VerificationResult } from "./container-verifier.js";
import { type VerificationPlan } from "./verification-policy.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FakeVerifier implements VerificationExecutor {
  async verify(
    _workspacePath: string,
    plan: VerificationPlan,
  ): Promise<VerificationResult> {
    return {
      status:
        plan.checks.length === 0
          ? "skipped"
          : "passed",

      passed: true,

      checks: plan.checks.map((check) => ({
        check,
        status: "passed",
        exitCode: 0,
        durationMs: 1,
        output: "fake verification passed",
      })),

      totalDurationMs: plan.checks.length,
    };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
	runner: AgentRunner = new FakeRunner(),
	verifier: VerificationExecutor = new FakeVerifier(),
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new WorkspaceGuard(path.join(root, "data", "safecommit")),
    verifier,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("records a risk assessment for a successful Agent change", async () => {
    const runner: AgentRunner = {
      async run(request) {
	const authDirectory = path.join(
	  request.workspacePath,
	  "src",
	  "auth",
	);

	await mkdir(authDirectory, {
	  recursive: true,
	});

	await writeFile(
	  path.join(authDirectory, "token.ts"),
	  "export const validateToken = () => true;\n",
	  "utf8",
	);

	return {
	  output: "updated authentication code",
	  threadId: "risk-thread",
	  usage: null,
	};
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Risk Test",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "modify authentication",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    const completedRun = service.getRun(run.id);

    expect(completedRun.riskAssessment).toBeDefined();

    expect(
      completedRun.riskAssessment?.level,
    ).toBe("high");

    expect(
      completedRun.riskAssessment?.changedFiles,
    ).toContain("src/auth/token.ts");

    expect(
      completedRun.riskAssessment?.features
	.securitySensitiveChanged,
    ).toBe(true);
  });

  it("rolls back workspace changes when a run is cancelled", async () => {
    let rejectRun!: (error: Error) => void;

    const pending = new Promise<RunnerResult>((_, reject) => {
      rejectRun = reject;
    });

    const runner: AgentRunner = {
      async run(request) {
	await writeFile(
	  path.join(request.workspacePath, "cancelled.txt"),
	  "partial work\n",
	  "utf8",
	);

	return pending;
      },

      async cancel() {
	rejectRun(new RunCancelledError());
	return true;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Cancellation Test",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "make a change",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("running");

    await service.stopAgent(agent.id);

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("cancelled");

    await expect(
      access(
	path.join(
	  agent.workspacePath,
	  "cancelled.txt",
	),
      ),
    ).rejects.toThrow();

    expect(
      service.getAgent(agent.id).status,
    ).toBe("stopped");
  });


  it("rolls back workspace changes when a run fails", async () => {
    const runner: AgentRunner = {
      async run(request) {
	await writeFile(
	  path.join(
	    request.workspacePath,
	    "existing.txt",
	  ),
	  "broken\n",
	  "utf8",
	);

	await writeFile(
	  path.join(
	    request.workspacePath,
	    "partial.txt",
	  ),
	  "partial agent output\n",
	  "utf8",
	);

	throw new Error("simulated runner failure");
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Recovery Test",
    });

    await writeFile(
      path.join(
	agent.workspacePath,
	"existing.txt",
      ),
      "stable\n",
      "utf8",
    );

    const { run } = await service.sendMessage(
      agent.id,
      "break the workspace",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("failed");

    expect(
      await readFile(
	path.join(
	  agent.workspacePath,
	  "existing.txt",
	),
	"utf8",
      ),
    ).toBe("stable\n");

    await expect(
      access(
	path.join(
	  agent.workspacePath,
	  "partial.txt",
	),
      ),
    ).rejects.toThrow();

    expect(
      service.getAgent(agent.id).status,
    ).toBe("ready");

    expect(
      service.getRun(run.id).error,
    ).toContain(
      "workspace rolled back to checkpoint",
    );
  });

  it("keeps workspace changes when a run succeeds", async () => {
    const runner: AgentRunner = {
      async run(request) {
	await writeFile(
	  path.join(
	    request.workspacePath,
	    "success.txt",
	  ),
	  "agent result\n",
	  "utf8",
	);

	return {
	  output: "completed successfully",
	  threadId: "success-thread",
	  usage: null,
	};
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Success Test",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "make a successful change",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    expect(
      await readFile(
	path.join(
	  agent.workspacePath,
	  "success.txt",
	),
	"utf8",
      ),
    ).toBe("agent result\n");
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("uses structural-only verification for low-risk changes", async () => {
    const runner: AgentRunner = {
      async run(request) {
	await writeFile(
	  path.join(request.workspacePath, "README.md"),
	  "# Updated documentation\n",
	  "utf8",
	);

	return {
	  output: "updated documentation",
	  threadId: "low-risk-thread",
	  usage: null,
	};
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Low Risk Test",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "update the documentation",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    const completedRun = service.getRun(run.id);

    expect(completedRun.riskAssessment?.level)
      .toBe("low");

    expect(completedRun.verificationPlan?.checks)
      .toEqual([]);

    expect(completedRun.verificationPlan?.structuralOnly)
      .toBe(true);

    expect(completedRun.verificationResult?.status)
      .toBe("skipped");

    expect(completedRun.verificationResult?.passed)
      .toBe(true);
  });

  it("routes medium-risk source changes to targeted test verification", async () => {
    const runner: AgentRunner = {
      async run(request) {
	const sourceDirectory = path.join(
	  request.workspacePath,
	  "src",
	);

	await mkdir(sourceDirectory, {
	  recursive: true,
	});

	await writeFile(
	  path.join(sourceDirectory, "greeting.ts"),
	  'export const greeting = "hello";\n',
	  "utf8",
	);

	return {
	  output: "updated source code",
	  threadId: "medium-risk-thread",
	  usage: null,
	};
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(runner);

    const agent = await service.createAgent({
      name: "Medium Risk Test",
    });

    // Pre-existing project capability: this belongs to the
    // checkpoint and is not an Agent mutation.
    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify(
	{
	  scripts: {
	    test: "vitest run",
	    typecheck: "tsc --noEmit",
	    build: "tsc",
	  },
	},
	null,
	2,
      ),
      "utf8",
    );

    const { run } = await service.sendMessage(
      agent.id,
      "change normal application logic",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    const completedRun = service.getRun(run.id);

    expect(completedRun.riskAssessment?.level)
      .toBe("medium");

    expect(completedRun.verificationPlan?.checks)
      .toEqual(["test"]);

    expect(completedRun.verificationResult?.status)
      .toBe("passed");

    expect(completedRun.verificationResult?.checks)
      .toHaveLength(1);

    expect(
      completedRun.verificationResult?.checks[0],
    ).toMatchObject({
      check: "test",
      status: "passed",
    });
  });

  it("rolls back a high-risk change when verification fails", async () => {
    let receivedPlan: VerificationPlan | null = null;

    const failingVerifier: VerificationExecutor = {
      async verify(
	_workspacePath,
	plan,
      ): Promise<VerificationResult> {
	receivedPlan = plan;

	return {
	  status: "failed",
	  passed: false,
	  checks: [
	    {
	      check: "typecheck",
	      status: "passed",
	      exitCode: 0,
	      durationMs: 1,
	      output: "typecheck passed",
	    },
	    {
	      check: "test",
	      status: "failed",
	      exitCode: 1,
	      durationMs: 2,
	      output: "authentication test failed",
	    },
	  ],
	  totalDurationMs: 3,
	};
      },
    };

    const runner: AgentRunner = {
      async run(request) {
	const authDirectory = path.join(
	  request.workspacePath,
	  "src",
	  "auth",
	);

	await mkdir(authDirectory, {
	  recursive: true,
	});

	await writeFile(
	  path.join(authDirectory, "token.ts"),
	  "export const validateToken = () => true;\n",
	  "utf8",
	);

	return {
	  output: "changed authentication",
	  threadId: "high-risk-thread",
	  usage: null,
	};
      },

      async cancel() {
	return false;
      },

      async isAvailable() {
	return true;
      },
    };

    const service = await makeService(
      runner,
      failingVerifier,
    );

    const agent = await service.createAgent({
      name: "High Risk Test",
    });

    await writeFile(
      path.join(agent.workspacePath, "package.json"),
      JSON.stringify(
	{
	  scripts: {
	    typecheck: "tsc --noEmit",
	    test: "vitest run",
	    build: "tsc",
	  },
	},
	null,
	2,
      ),
      "utf8",
    );

    const { run } = await service.sendMessage(
      agent.id,
      "modify authentication",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("failed");

    const failedRun = service.getRun(run.id);

    expect(failedRun.riskAssessment?.level)
      .toBe("high");

    expect(receivedPlan?.checks).toEqual([
      "typecheck",
      "test",
      "build",
    ]);

    expect(failedRun.verificationPlan?.checks)
      .toEqual([
	"typecheck",
	"test",
	"build",
      ]);

    expect(failedRun.verificationResult?.status)
      .toBe("failed");

    expect(failedRun.verificationResult?.checks)
      .toHaveLength(2);

    expect(
      failedRun.verificationResult?.checks[1],
    ).toMatchObject({
      check: "test",
      status: "failed",
    });

    // Candidate authentication file must have been rolled back.
    await expect(
      access(
	path.join(
	  agent.workspacePath,
	  "src",
	  "auth",
	  "token.ts",
	),
      ),
    ).rejects.toThrow();

    // The pre-run project state must survive rollback.
    expect(
      await readFile(
	path.join(agent.workspacePath, "package.json"),
	"utf8",
      ),
    ).toContain('"test": "vitest run"');

    expect(service.getAgent(agent.id).status)
      .toBe("ready");

    expect(failedRun.error)
      .toContain(
	"SafeCommit verification rejected the Agent change",
      );

    expect(failedRun.error)
      .toContain(
	"workspace rolled back to checkpoint",
      );
  });
});
