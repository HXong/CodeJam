export type ChangeRiskLevel = "low" | "medium" | "high";

export interface ChangeRiskFeatures {
  docsOnly: boolean;
  sourceChanged: boolean;
  testsChanged: boolean;
  dependencyManifestChanged: boolean;
  securitySensitiveChanged: boolean;
  persistenceSensitiveChanged: boolean;
  infrastructureChanged: boolean;
  configurationChanged: boolean;
  largeChangeSet: boolean;
}

export interface ChangeRiskAssessment {
  level: ChangeRiskLevel;
  score: number;
  reasons: string[];
  changedFiles: string[];
  features: ChangeRiskFeatures;
}

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
];

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
]);

const SECURITY_TERMS = [
  "auth",
  "authentication",
  "authorization",
  "permission",
  "permissions",
  "acl",
  "oauth",
  "jwt",
  "token",
  "session",
  "credential",
  "secret",
  "crypto",
];

const PERSISTENCE_TERMS = [
  "migration",
  "migrations",
  "schema",
  "database",
  "db/",
  "repository/",
];

const INFRASTRUCTURE_TERMS = [
  "dockerfile",
  "docker-compose",
  ".github/workflows/",
  "k8s/",
  "kubernetes/",
  "helm/",
  "terraform/",
];

function normalize(file: string): string {
  return file.replaceAll("\\", "/").toLowerCase();
}

function containsAny(
  file: string,
  terms: string[],
): boolean {
  return terms.some((term) => file.includes(term));
}

function isDocumentation(file: string): boolean {
  return (
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file.startsWith("documentation/") ||
    file.startsWith("readme")
  );
}

function isTest(file: string): boolean {
  return (
    file.includes(".test.") ||
    file.includes(".spec.") ||
    file.startsWith("test/") ||
    file.startsWith("tests/") ||
    file.includes("/test/") ||
    file.includes("/tests/")
  );
}

function isSource(file: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) =>
    file.endsWith(extension),
  );
}

function isConfiguration(file: string): boolean {
  return (
    file.startsWith(".env") ||
    file.endsWith(".yaml") ||
    file.endsWith(".yml") ||
    file.endsWith(".toml") ||
    file.endsWith(".ini") ||
    file.endsWith(".conf")
  );
}

export function assessChangeRisk(
  files: string[],
): ChangeRiskAssessment {
  const changedFiles = [...new Set(files)]
    .map(normalize)
    .sort();

  if (changedFiles.length === 0) {
    return {
      level: "low",
      score: 0,
      reasons: ["No workspace changes detected"],
      changedFiles,
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

  const docsOnly = changedFiles.every(isDocumentation);

  const sourceChanged = changedFiles.some(isSource);
  const testsChanged = changedFiles.some(isTest);

  const dependencyManifestChanged = changedFiles.some((file) =>
    DEPENDENCY_FILES.has(file.split("/").at(-1) ?? file),
  );

  const securitySensitiveChanged = changedFiles.some((file) =>
    containsAny(file, SECURITY_TERMS),
  );

  const persistenceSensitiveChanged = changedFiles.some((file) =>
    containsAny(file, PERSISTENCE_TERMS),
  );

  const infrastructureChanged = changedFiles.some((file) =>
    containsAny(file, INFRASTRUCTURE_TERMS),
  );

  const configurationChanged =
    changedFiles.some(isConfiguration);

  const largeChangeSet = changedFiles.length >= 10;

  const features: ChangeRiskFeatures = {
    docsOnly,
    sourceChanged,
    testsChanged,
    dependencyManifestChanged,
    securitySensitiveChanged,
    persistenceSensitiveChanged,
    infrastructureChanged,
    configurationChanged,
    largeChangeSet,
  };

  let score = 0;
  const reasons: string[] = [];

  /*
   * Cheap, explainable structural rules.
   *
   * Scores are additive but capped at 100.
   */

  if (docsOnly) {
    score += 5;
    reasons.push("Documentation-only change");
  }

  if (sourceChanged && !docsOnly) {
    score += 35;
    reasons.push("Executable source code changed");
  }

  if (testsChanged) {
    score += 10;
    reasons.push("Test code changed");
  }

  if (configurationChanged) {
    score += 30;
    reasons.push("Configuration changed");
  }

  if (infrastructureChanged) {
    score += 45;
    reasons.push("Infrastructure or deployment files changed");
  }

  if (dependencyManifestChanged) {
    score += 60;
    reasons.push("Dependency manifest or lockfile changed");
  }

  if (persistenceSensitiveChanged) {
    score += 60;
    reasons.push("Persistence or database-sensitive path changed");
  }

  if (securitySensitiveChanged) {
    score += 65;
    reasons.push("Security-sensitive path changed");
  }

  if (changedFiles.length >= 5) {
    score += 10;
    reasons.push(
      `${changedFiles.length} files changed`,
    );
  }

  if (largeChangeSet) {
    score += 10;
    reasons.push("Large change set");
  }

  score = Math.min(score, 100);

  const level: ChangeRiskLevel =
    score >= 60
      ? "high"
      : score >= 30
        ? "medium"
        : "low";

  if (reasons.length === 0) {
    reasons.push("No high-risk structural signals detected");
  }

  return {
    level,
    score,
    reasons,
    changedFiles,
    features,
  };
}
