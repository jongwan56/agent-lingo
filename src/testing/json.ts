import { expect } from "bun:test";
import type { JsonObject, JsonValue } from "../core/types.js";

export function objectValue(value: unknown): JsonObject {
  expect(value).toBeObject();
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
}

export function arrayValue(value: unknown): JsonValue[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonValue[];
}

export function stringValue(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

export function numberValue(value: unknown): number {
  expect(typeof value).toBe("number");
  return value as number;
}
