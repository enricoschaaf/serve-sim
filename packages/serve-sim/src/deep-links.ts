import { readFileSync } from "fs";

export interface DeepLinkDefinition {
  group: string;
  title: string;
  url: string;
  requiresAuthentication: boolean;
  description?: string;
  parameters?: DeepLinkParameterDefinition[];
}

export interface DeepLinkParameterDefinition {
  name: string;
  label?: string;
  placeholder?: string;
  default?: string;
}

export interface DeepLinkManifest {
  scheme: string;
  bundleId?: string;
  links: DeepLinkDefinition[];
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Deep link ${name} must be a non-empty string`);
  }
  return value.trim();
}

function placeholders(url: string): string[] {
  return [...new Set([...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!))];
}

export function parseDeepLinkManifest(value: unknown): DeepLinkManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deep link manifest must be an object");
  }
  const input = value as { scheme?: unknown; bundleId?: unknown; links?: unknown };
  const scheme = nonEmptyString(input.scheme, "scheme").replace(/:\/\/$/, "");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
    throw new Error("Deep link manifest has an invalid scheme");
  }
  const bundleId = input.bundleId === undefined
    ? undefined
    : nonEmptyString(input.bundleId, "bundleId");
  if (bundleId && !/^[A-Za-z0-9.-]+$/.test(bundleId)) {
    throw new Error("Deep link manifest has an invalid bundleId");
  }
  if (!Array.isArray(input.links)) throw new Error("Deep link manifest links must be an array");
  const links = input.links.map((entry, index): DeepLinkDefinition => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Deep link ${index + 1} must be an object`);
    }
    const link = entry as Record<string, unknown>;
    const description = link.description === undefined
      ? undefined
      : nonEmptyString(link.description, `${index + 1} description`);
    if (link.requiresAuthentication !== undefined && typeof link.requiresAuthentication !== "boolean") {
      throw new Error(`Deep link ${index + 1} requiresAuthentication must be a boolean`);
    }
    const url = nonEmptyString(link.url, `${index + 1} URL`);
    const urlParameters = placeholders(url);
    for (const name of urlParameters) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`Deep link ${index + 1} has an invalid parameter name: ${name}`);
      }
    }
    const normalizedUrl = url.replace(/\{[^{}]+\}/g, "value");
    let protocol = "";
    try {
      protocol = new URL(normalizedUrl).protocol.slice(0, -1);
    } catch {
      throw new Error(`Deep link ${index + 1} URL must be absolute`);
    }
    if (protocol.toLowerCase() !== scheme.toLowerCase()) {
      throw new Error(`Deep link ${index + 1} URL must use the ${scheme} scheme`);
    }

    let parameters: DeepLinkParameterDefinition[] | undefined;
    if (link.parameters !== undefined) {
      if (!Array.isArray(link.parameters)) {
        throw new Error(`Deep link ${index + 1} parameters must be an array`);
      }
      parameters = link.parameters.map((entry, parameterIndex) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`Deep link ${index + 1} parameter ${parameterIndex + 1} must be an object`);
        }
        const input = entry as Record<string, unknown>;
        const name = nonEmptyString(input.name, `${index + 1} parameter ${parameterIndex + 1} name`);
        if (!urlParameters.includes(name)) {
          throw new Error(`Deep link ${index + 1} parameter ${name} is not present in its URL`);
        }
        const optionalString = (key: "label" | "placeholder" | "default") => input[key] === undefined
          ? undefined
          : nonEmptyString(input[key], `${index + 1} parameter ${name} ${key}`);
        const label = optionalString("label");
        const placeholder = optionalString("placeholder");
        const defaultValue = optionalString("default");
        return {
          name,
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(defaultValue ? { default: defaultValue } : {}),
        };
      });
      const names = parameters.map((parameter) => parameter.name);
      if (new Set(names).size !== names.length) {
        throw new Error(`Deep link ${index + 1} contains duplicate parameter metadata`);
      }
    }
    return {
      group: nonEmptyString(link.group, `${index + 1} group`),
      title: nonEmptyString(link.title, `${index + 1} title`),
      url,
      requiresAuthentication: link.requiresAuthentication !== false,
      ...(description ? { description } : {}),
      ...(parameters?.length ? { parameters } : {}),
    };
  });
  return { scheme, ...(bundleId ? { bundleId } : {}), links };
}

export function readDeepLinkManifest(path: string): DeepLinkManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read deep link manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDeepLinkManifest(value);
}
