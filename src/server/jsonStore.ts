import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";

export interface JsonStore<T> {
  read(): T;
  write(value: T): void;
  update(mutator: (current: T) => T): T;
}

export function createJsonStore<T>(filePath: string, fallback: T, schema?: ZodType<T>): JsonStore<T> {
  const normalize = (value: unknown): T => (schema ? schema.parse(value) : (value as T));
  const fallbackValue = (): T => normalize(structuredClone(fallback));

  return {
    read(): T {
      if (!existsSync(filePath)) return fallbackValue();
      const text = readFileSync(filePath, "utf8").trim();
      if (!text) return fallbackValue();
      return normalize(JSON.parse(text));
    },

    write(value: T): void {
      const parsed = normalize(value);
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8");
      renameSync(tmp, filePath);
    },

    update(mutator: (current: T) => T): T {
      const next = mutator(this.read());
      this.write(next);
      return next;
    },
  };
}
