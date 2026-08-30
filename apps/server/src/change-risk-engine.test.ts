import { describe, expect, it } from "vitest";
import { assessChangeRisk } from "./change-risk-engine.js";

describe("assessChangeRisk", () => {
  it("classifies documentation-only changes as low risk", () => {
    const result = assessChangeRisk([
      "README.md",
      "docs/setup.md",
    ]);

    expect(result.level).toBe("low");
    expect(result.score).toBe(5);
    expect(result.features.docsOnly).toBe(true);
    expect(result.reasons).toContain(
      "Documentation-only change",
    );
  });

  it("classifies ordinary source changes as medium risk", () => {
    const result = assessChangeRisk([
      "src/greeting.ts",
    ]);

    expect(result.level).toBe("medium");
    expect(result.score).toBe(35);
    expect(result.features.sourceChanged).toBe(true);
  });

  it("classifies authentication changes as high risk", () => {
    const result = assessChangeRisk([
      "src/auth/token.ts",
    ]);

    expect(result.level).toBe("high");
    expect(result.features.securitySensitiveChanged)
      .toBe(true);

    expect(result.reasons).toContain(
      "Security-sensitive path changed",
    );
  });

  it("classifies dependency changes as high risk", () => {
    const result = assessChangeRisk([
      "package.json",
      "package-lock.json",
    ]);

    expect(result.level).toBe("high");

    expect(
      result.features.dependencyManifestChanged,
    ).toBe(true);
  });

  it("classifies persistence changes as high risk", () => {
    const result = assessChangeRisk([
      "src/database/migrations/001-users.ts",
    ]);

    expect(result.level).toBe("high");

    expect(
      result.features.persistenceSensitiveChanged,
    ).toBe(true);
  });

  it("reports no changes as low risk", () => {
    const result = assessChangeRisk([]);

    expect(result.level).toBe("low");
    expect(result.score).toBe(0);
    expect(result.changedFiles).toEqual([]);
  });
});
