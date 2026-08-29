import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceCheckpoint {
  agentId: string;
  runId: string;
  commitSha: string;
  createdAt: string;
}

export class WorkspaceGuard {
	constructor(private readonly root: string) {}

	async initialize(): Promise<void> {
		await mkdir(this.root, { recursive: true });
	}

	async checkpoint(agentId: string, runId: string, workspacePath: string): Promise<WorkspaceCheckpoint> {
		await this.ensureRepository(agentId);

		//add in snapshots of all relevant workspace files. The .gitignore excludes dependencies, build outputs, .env files, etc
		await this.git(agentId, workspacePath, ["add", "-A"]);

		// --allow-empty gives every Run its own checkpoint even when the workspace has not changed since the previous Run
		await this.git(agentId, workspacePath, ["-c", "user.name=SafeCommit", "-c", "user.email=safecommit@local", "commit", "--allow-empty", "-m", `checkpoint ${runId}`,]);

		const commitSha = (await this.git(agentId, workspacePath, ["rev-parse", "HEAD"])).trim();

		return {agentId, runId, commitSha, createdAt: new Date().toISOString()};
	}

	async changedFiles(agentId: string, workspacePath: string, checkpoint: WorkspaceCheckpoint): Promise<string[]> {
		this.assertCheckpointOwner(agentId, checkpoint);

		const tracked = await this.git(agentId, workspacePath, ["diff", "--name-only", checkpoint.commitSha, "--"]);
		const untracked = await this.git(agentId, workspacePath, ["ls-files", "--others", "--exclude-standard"]);

		return [...new Set([...this.lines(tracked), ...this.lines(untracked)])].sort();
	}

	async rollback(agentId: string, workspacePath: string, checkpoint: WorkspaceCheckpoint): Promise<void> {
		this.assertCheckpointOwner(agentId, checkpoint);

		//Restoring tracked files exactly to this checkpoint
		await this.git(agentId, workspacePath, ["reset", "--hard", checkpoint.commitSha]);

		//Removing files created after the checkpoint while respecting ignored paths such as node_modules and build artefacts
		await this.git(agentId, workspacePath, ["clean", "-fd"]);
	}

	async removeAgent(agentId: string): Promise<void> {
		await rm(this.repositoryPath(agentId), {
			recursive: true,
			force: true,
		});
	}

	private async ensureRepository(agentId: string): Promise<void> {
		await mkdir(this.root, { recursive: true });
		
		const repository = this.repositoryPath(agentId);
		try {
			await access(join(repository, "HEAD"));
			return;
		} catch {
			// Repository has not been initialized yet.
		}
		
		await execFileAsync("git", ["init", "--bare", repository]);
	}

	private async git(agentId: string, workspacePath: string, args: string[]): Promise<string> {
		const repository = this.repositoryPath(agentId);
		const { stdout } = await execFileAsync(
			"git",
			[`--git-dir=${repository}`, `--work-tree=${workspacePath}`, ...args],
			{maxBuffer: 2 * 1024 * 1024},
		);
		return stdout;
	}

	private repositoryPath(agentId: string): string {
		return join(this.root, `${agentId}.git`);
	}

	private lines(value: string): string[] {
		return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	}

	private assertCheckpointOwner(agentId: string, checkpoint: WorkspaceCheckpoint): void {
		if (checkpoint.agentId !== agentId) {
			throw new Error(`Checkpoint belongs to Agent ${checkpoint.agentId}, not ${agentId}`);
		}
	}

}

