import { createHash } from "node:crypto";
import type { JsonValue } from "../core/types.js";

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sha256Json(value: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
