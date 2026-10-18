import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { DocNexusError } from "./errors.js";

export function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DocNexusError("invalid_params", `${key} requires a value`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }

  return options;
}

/** Rejects any `--option` outside `allowed`; values sit at the odd positions. */
export function requireKnownOptions(args: string[], allowed: readonly string[], message: (option: string) => string): void {
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.includes(args[index])) throw new DocNexusError("invalid_params", message(args[index]));
  }
}

/** Splits a boolean flag out of the argument list so the rest parse as key/value pairs. */
export function takeFlag(args: string[], flag: string): [present: boolean, rest: string[]] {
  return [args.includes(flag), args.filter((arg) => arg !== flag)];
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new DocNexusError("invalid_params", `${name} must be a positive integer`);
  }
  return number;
}

export function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}

export async function readProjectFile(projectRoot: string, path: string): Promise<string> {
  return readFile(await projectContainedPath(projectRoot, path), "utf8");
}

export async function projectContainedPath(projectRoot: string, path: string): Promise<string> {
  const root = await realpath(projectRoot);
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path));
  const inside = relative(root, target);
  if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    throw new DocNexusError("invalid_params", `input path must be inside the project: ${path}`);
  }
  return target;
}
