import type {
  ChangeRiskAssessment,
  ChangeRiskLevel,
} from "./change-risk-engine.js";

export type VerificationCheck =
  | "typecheck"
  | "test"
  | "build";

export interface ProjectCapabilities {
  packageManager: "npm" | null;
  scripts: VerificationCheck[];
}

export interface VerificationPlan {
  tier: ChangeRiskLevel;
  checks: VerificationCheck[];
  structuralOnly: boolean;
  failClosedIfUnavailable: boolean;
  reason: string;
}

const CHECK_PRIORITY: VerificationCheck[] = [
  "typecheck",
  "test",
  "build",
];

function availableChecks(
  capabilities: ProjectCapabilities,
): VerificationCheck[] {
  return CHECK_PRIORITY.filter((check) =>
    capabilities.scripts.includes(check),
  );
}

export function planVerification(
  risk: ChangeRiskAssessment,
  capabilities: ProjectCapabilities,
): VerificationPlan {
  const available = availableChecks(capabilities);

  if (risk.level === "low") {
    return {
      tier: "low",
      checks: [],
      structuralOnly: true,
      failClosedIfUnavailable: false,
      reason:
        "Low-risk change accepted using deterministic structural analysis only",
    };
  }

  if (risk.level === "medium") {
    /*
     * Spend enough compute to obtain one independent signal,
     * but avoid running the entire verification suite.
     *
     * Prefer tests when present because they give behavioural
     * evidence. Fall back to typecheck, then build.
     */
    const preferred =
      available.includes("test")
        ? "test"
        : available.includes("typecheck")
          ? "typecheck"
          : available.includes("build")
            ? "build"
            : null;

    return {
      tier: "medium",
      checks: preferred ? [preferred] : [],
      structuralOnly: preferred === null,
      failClosedIfUnavailable: false,
      reason: preferred
        ? `Medium-risk change routed to targeted ${preferred} verification`
        : "No executable verification check detected; structural analysis only",
    };
  }

  /*
   * High-risk changes must receive every verification signal
   * available to the platform.
   *
   * If no usable checks exist, later execution must fail closed
   * instead of silently accepting a high-risk mutation.
   */
  return {
    tier: "high",
    checks: available,
    structuralOnly: false,
    failClosedIfUnavailable: available.length === 0,
    reason:
      available.length > 0
        ? `High-risk change routed to full verification: ${available.join(", ")}`
        : "High-risk change has no available executable verification checks",
  };
}
