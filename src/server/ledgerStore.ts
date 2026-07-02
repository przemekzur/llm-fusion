import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerEventSchema, type LedgerEvent } from "../shared/types.js";

export interface LedgerStore {
  append(event: LedgerEvent): void;
  list(missionId?: string): LedgerEvent[];
}

export function createLedgerStore(filePath: string): LedgerStore {
  return {
    append(event: LedgerEvent): void {
      const parsed = LedgerEventSchema.parse(event);
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
    },

    list(missionId?: string): LedgerEvent[] {
      if (!existsSync(filePath)) return [];
      return readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => LedgerEventSchema.parse(JSON.parse(line)))
        .filter((event) => !missionId || event.missionId === missionId);
    },
  };
}
