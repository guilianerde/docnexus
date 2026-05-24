import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(toStableValue(value), null, 2);
}

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const stableItem = toStableValue(item);
      return stableItem === undefined ? null : stableItem;
    });
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const stableItem = toStableValue(value[key]);
        if (stableItem !== undefined) {
          result[key] = stableItem;
        }
        return result;
      }, {});
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
