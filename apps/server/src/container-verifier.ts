import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import type {
  VerificationCheck,
  VerificationPlan,
} from "./verification-policy.js";

const execFileAsync = promisify(execFile);

export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "blocked"
  | "error";

export interface VerificationExecutor {
  verify(
    workspacePath: string,
    plan: VerificationPlan,
  ): Promise<VerificationResult>;
}
  
export interface VerificationCheckResult {
  check: VerificationCheck;
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  passed: boolean;
  checks: VerificationCheckResult[];
  totalDurationMs: number;
}

interface ExecFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

export function buildVerifierRunArgs(
  workspacePath: string,
  check: VerificationCheck,
  config: AppConfig,
): string[] {
  const engineName = config.containerEngine
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase();

  return [
    "run",
    "--rm",
    "--init",

    ...(engineName === "podman"
      ? ["--userns", "keep-id"]
      : []),

    // Verification code must not reach external services.
    "--network",
    "none",

    "--security-opt",
    "no-new-privileges",

    "--cap-drop",
    "ALL",

    "--cpus",
    String(config.containerCpuLimit),

    "--memory",
    config.containerMemoryLimit,

    "--pids-limit",
    String(config.containerPidsLimit),

    "--user",
    config.containerUser,

    // Prevent writes to the container image itself.
    "--read-only",

    // npm and tools still need a temporary writable location.
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",

    "--env",
    "HOME=/tmp",

    "--env",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",

    "--env",
    "NO_COLOR=1",

    "--label",
    "io.codejam.launchpad=safecommit-verifier",

    "--label",
    `io.codejam.instance-id=${config.runtimeInstanceId}`,

    "--mount",
    `type=bind,src=${workspacePath},dst=/workspace-src,readonly`,

    "--tmpfs",
    "/workspace:rw,nosuid,nodev,size=1g",

    "--workdir",
    "/workspace",

    config.containerRuntimeImage,

    "sh",
    "-lc",
    [
      // Copy the candidate workspace but avoid duplicating a potentially
      // huge node_modules tree.
      "find /workspace-src -mindepth 1 -maxdepth 1 ! -name node_modules -exec cp -a -t /workspace {} +",

      // Dependencies remain available but read-only through the source mount.
      "if [ -d /workspace-src/node_modules ]; then ln -s /workspace-src/node_modules /workspace/node_modules; fi",

      `npm run ${check}`,
    ].join(" && "),
  ];
}

export class ContainerVerifier implements VerificationExecutor {
  constructor(private readonly config: AppConfig) {}

  async verify(
    workspacePath: string,
    plan: VerificationPlan,
  ): Promise<VerificationResult> {
    const startedAt = Date.now();

    if (
      plan.failClosedIfUnavailable &&
      plan.checks.length === 0
    ) {
      return {
        status: "blocked",
        passed: false,
        checks: [],
        totalDurationMs: Date.now() - startedAt,
      };
    }

    if (plan.checks.length === 0) {
      return {
        status: "skipped",
        passed: true,
        checks: [],
        totalDurationMs: Date.now() - startedAt,
      };
    }

    const results: VerificationCheckResult[] = [];

    for (const check of plan.checks) {
      const result = await this.runCheck(
        workspacePath,
        check,
      );

      results.push(result);

      /*
       * Once an independent check proves the speculative
       * state unsafe, spending more compute has no benefit.
       */
      if (result.status !== "passed") {
        break;
      }
    }

    const passed =
      results.length === plan.checks.length &&
      results.every(
        (result) => result.status === "passed",
      );

    const last = results.at(-1);

    return {
      status: passed
        ? "passed"
        : last?.status === "failed"
          ? "failed"
          : "error",

      passed,
      checks: results,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  private async runCheck(
    workspacePath: string,
    check: VerificationCheck,
  ): Promise<VerificationCheckResult> {
    const startedAt = Date.now();

    try {
      const { stdout, stderr } =
        await execFileAsync(
          this.config.containerEngine,
          buildVerifierRunArgs(
            workspacePath,
            check,
            this.config,
          ),
          {
            timeout:
              this.config.safeCommitVerifyTimeoutMs,

            maxBuffer:
              this.config
                .safeCommitVerifyMaxOutputBytes,

            // Deliberately do not inherit ARK_API_KEY.
            env: this.childEnvironment(),
          },
        );

      return {
        check,
        status: "passed",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        output: this.combineOutput(
          stdout,
          stderr,
        ),
      };
    } catch (error) {
      const failure = error as ExecFailure;

      const exitCode =
        typeof failure.code === "number"
          ? failure.code
          : null;

      return {
        check,

        // A normal non-zero process exit means the verification
        // check itself failed. Spawn/timeout/buffer failures are
        // verifier errors rather than test failures.
        status:
          exitCode !== null
            ? "failed"
            : "error",

        exitCode,

        durationMs: Date.now() - startedAt,

        output:
          this.combineOutput(
            failure.stdout ?? "",
            failure.stderr ?? "",
          ) ||
          failure.message,
      };
    }
  }

  private combineOutput(
    stdout: string,
    stderr: string,
  ): string {
    return [stdout.trim(), stderr.trim()]
      .filter(Boolean)
      .join("\n");
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};

    /*
     * Only give the Docker/Podman CLI the host values needed
     * to launch. In particular, ARK_API_KEY is intentionally
     * excluded even from this child process environment.
     */
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) {
        environment[name] = process.env[name];
      }
    }

    return environment;
  }
}
