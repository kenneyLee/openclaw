import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateProvider, createFileStateProvider } from "../file-state-provider.js";

describe("FileStateProvider", () => {
  const tmpDirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  describe("construction", () => {
    it("has id 'file'", () => {
      const provider = createFileStateProvider();
      expect(provider.id).toBe("file");
    });

    it("bootstrap is defined", () => {
      const provider = createFileStateProvider();
      expect(provider.bootstrap).toBeDefined();
    });

    it("is an instance of FileStateProvider", () => {
      const provider = createFileStateProvider();
      expect(provider).toBeInstanceOf(FileStateProvider);
    });
  });

  describe("FileBootstrapProvider.loadBootstrapFiles", () => {
    it("returns files with content for a workspace with SOUL.md", async () => {
      const dir = await makeTmpDir();
      await fs.writeFile(path.join(dir, "SOUL.md"), "You are a helpful assistant.");
      await fs.writeFile(path.join(dir, "AGENTS.md"), "# Agents config");

      const provider = createFileStateProvider();
      const files = await provider.bootstrap.loadBootstrapFiles({ workspaceDir: dir });

      expect(files.length).toBeGreaterThan(0);

      const soulFile = files.find((f) => f.name === "SOUL.md");
      expect(soulFile).toBeDefined();
      expect(soulFile!.missing).toBe(false);
      expect(soulFile!.content).toBe("You are a helpful assistant.");

      const agentsFile = files.find((f) => f.name === "AGENTS.md");
      expect(agentsFile).toBeDefined();
      expect(agentsFile!.missing).toBe(false);
      expect(agentsFile!.content).toBe("# Agents config");
    });

    it("returns missing: true for files that don't exist", async () => {
      const dir = await makeTmpDir();
      // Empty directory — no bootstrap files

      const provider = createFileStateProvider();
      const files = await provider.bootstrap.loadBootstrapFiles({ workspaceDir: dir });

      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.missing).toBe(true);
      }
    });

    it("throws when workspaceDir is not provided", async () => {
      const provider = createFileStateProvider();
      await expect(provider.bootstrap.loadBootstrapFiles({})).rejects.toThrow(
        "FileBootstrapProvider requires workspaceDir",
      );
    });
  });

  describe("FileBootstrapProvider.loadExtraBootstrapFiles", () => {
    it("returns empty array for empty patterns", async () => {
      const dir = await makeTmpDir();

      const provider = createFileStateProvider();
      const files = await provider.bootstrap.loadExtraBootstrapFiles({ workspaceDir: dir }, []);

      expect(files).toEqual([]);
    });

    it("throws when workspaceDir is not provided", async () => {
      const provider = createFileStateProvider();
      await expect(provider.bootstrap.loadExtraBootstrapFiles({}, ["SOUL.md"])).rejects.toThrow(
        "FileBootstrapProvider requires workspaceDir",
      );
    });
  });
});
