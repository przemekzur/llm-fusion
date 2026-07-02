import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

let dir = "";
let dataDir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-fusion-fs-"));
  dataDir = mkdtempSync(join(tmpdir(), "llm-fusion-fs-data-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("folder browser", () => {
  it("lists subdirectories, hiding files, dotfolders, and node_modules", async () => {
    mkdirSync(join(dir, "beta"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "file.txt"), "x", "utf8");

    const { app } = createApp({ dataDir });
    const res = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(dir)}`);

    expect(res.status).toBe(200);
    expect(res.body.path.toLowerCase()).toBe(dir.toLowerCase());
    expect(res.body.parent).toBeTruthy();
    expect(res.body.dirs.map((entry: { name: string }) => entry.name)).toEqual(["alpha", "beta"]);
  });

  it("defaults to the home directory and rejects missing paths", async () => {
    const { app } = createApp({ dataDir });

    const home = await request(app).get("/api/fs/dirs");
    expect(home.status).toBe(200);
    expect(home.body.path.length).toBeGreaterThan(2);

    const missing = await request(app).get(`/api/fs/dirs?path=${encodeURIComponent(join(dir, "nope"))}`);
    expect(missing.status).toBe(400);
  });
});
