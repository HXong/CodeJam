import { describe, expect, it } from "vitest";
import type { ChangeRiskAssessment } from "./change-risk-engine.js";
import {
  planVerification,
  type ProjectCapabilities,
} from "./verification-policy.js";

function risk(
  level: "low" | "medium" | "high",
): ChangeRiskAssessment {
  return {
    level,
    score:
      level === "low"
        ? 5
        : level === "medium"
          ? 35
          : 80,
    reasons: [],
    changedFiles: [],
    features: {
      docsOnly: false,
      sourceChanged: false,
      testsChanged: false,
      dependencyManifestChanged: false,
      securitySensitiveChanged: false,
      persistenceSensitiveChanged: false,
      infrastructureChanged: false,
      configurationChanged: false,
      largeChangeSet: false,
    },
  };
}

const fullProject: ProjectCapabilities = {
  packageManager: "npm",
  scripts: ["typecheck", "test", "build"],
};

describe("planVerification", () => {
  it("uses structural-only verification for low risk", () => {
    const plan = planVerification(
      risk("low"),
      fullProject,
    );

    expect(plan.checks).toEqual([]);
    expect(plan.structuralOnly).toBe(true);
    expect(plan.failClosedIfUnavailable).toBe(false);
  });

  it("runs only tests for a medium-risk project with tests", () => {
    const plan = planVerification(
      risk("medium"),
      fullProject,
    );

    expect(plan.checks).toEqual(["test"]);
    expect(plan.structuralOnly).toBe(false);
  });

  it("falls back to typecheck for medium risk", () => {
    const plan = planVerification(
      risk("medium"),
      {
        packageManager: "npm",
        scripts: ["typecheck", "build"],
      },
    );

    expect(plan.checks).toEqual(["typecheck"]);
  });

  it("runs every available strong check for high risk", () => {
    const plan = planVerification(
      risk("high"),
      fullProject,
    );

    expect(plan.checks).toEqual([
      "typecheck",
      "test",
      "build",
    ]);

    expect(plan.failClosedIfUnavailable).toBe(false);
  });

  it("fails closed when high risk has no executable checks", () => {
    const plan = planVerification(
      risk("high"),
      {
        packageManager: null,
        scripts: [],
      },
    );

    expect(plan.checks).toEqual([]);
    expect(plan.failClosedIfUnavailable).toBe(true);
  });
});
