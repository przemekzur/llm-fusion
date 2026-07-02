import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function dataDir(): string {
  return resolve(process.env.LLM_FUSION_DATA_DIR || join(process.cwd(), "data"));
}

export function dataPath(...parts: string[]): string {
  const root = dataDir();
  mkdirSync(root, { recursive: true });
  return join(root, ...parts);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
