import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGuard } from "./workspace-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
		recursive: true,
		force: true,
	})));
});

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("WorkspaceGuard", () => {
	it("restores the workspace to a checkpoint", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "safecommit-test-"));
		temporaryDirectories.push(root);
		
		const workspace = path.join(root, "workspace");
		const guardRoot = path.join(root, "guard");
		
		await mkdir(workspace, { recursive: true });
		await writeFile(path.join(workspace, ".gitignore"), ["node_modules/", "dist/", ""].join("\n"), "utf8");
		
		await writeFile(path.join(workspace, "hello.txt"), "before\n", "utf8");
		
		// Ignored files should survive rollback.
		await mkdir(path.join(workspace, "node_modules"), {recursive: true});
		
		await writeFile(path.join(workspace, "node_modules", "dependency.txt"), "keep me\n", "utf8");
		
		const guard = new WorkspaceGuard(guardRoot);
		await guard.initialize();
		
		const checkpoint = await guard.checkpoint("agent-1", "run-1", workspace);
		
		// Simulate an Agent modifying an existing file...
		await writeFile(path.join(workspace, "hello.txt"), "after\n", "utf8");
		
		// ...and creating a completely new file.
		await writeFile(path.join(workspace, "broken.txt"), "agent-created\n", "utf8");
		
		expect(
			await guard.changedFiles("agent-1", workspace, checkpoint),
		).toEqual(["broken.txt", "hello.txt"]);
		
		await guard.rollback("agent-1", workspace, checkpoint);
		
		expect(
			await readFile(path.join(workspace, "hello.txt"), "utf8")
		).toBe("before\n");
		
		expect(
			await exists(path.join(workspace, "broken.txt"))
		).toBe(false);
		
		// node_modules is ignored, so SafeCommit does not unnecessarily
		// destroy dependency caches during rollback.
		
		expect(
			await readFile(path.join(workspace, "node_modules", "dependency.txt"), "utf8")
		).toBe("keep me\n");
	});
	
	it("rejects a checkpoint belonging to another Agent", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "safecommit-test-"));
		
		temporaryDirectories.push(root);
		const workspace = path.join(root, "workspace");
		await mkdir(workspace);
		
		await writeFile(path.join(workspace, "hello.txt"), "hello\n", "utf8");
		
		const guard = new WorkspaceGuard(path.join(root, "guard"));
		
		const checkpoint = await guard.checkpoint("agent-a", "run-1", workspace);
		
		await expect(
			guard.rollback("agent-b", workspace, checkpoint, ),
		).rejects.toThrow(/belongs to Agent agent-a/);
	});
});

