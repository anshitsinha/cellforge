/**
 * A small JSON Schema subset: enough to describe action parameters, to
 * validate them before they touch a workbook, and to hand to a language
 * model as a tool definition (or to constrain its output to). No
 * dependency, no $ref, no formats.
 */

export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "null"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | {
      type: "object";
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
      /** defaults to false: unknown keys are an error */
      additionalProperties?: boolean;
    }
  | { anyOf: readonly JsonSchema[]; description?: string };

/** Returns a list of problems; empty means valid. Paths look like `cells[3].row`. */
export function validate(value: unknown, schema: JsonSchema, path = "params"): string[] {
  if ("anyOf" in schema) {
    for (const s of schema.anyOf) if (validate(value, s, path).length === 0) return [];
    return [`${path}: does not match any allowed shape`];
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [`${path}: expected a string`];
      if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(", ")}`];
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path}: too short`];
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path}: too long`];
      return [];
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected a finite number`];
      if (schema.type === "integer" && !Number.isInteger(value)) return [`${path}: expected an integer`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: must be >= ${schema.minimum}`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: must be <= ${schema.maximum}`];
      return [];
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: expected true or false`];
    case "null":
      return value === null ? [] : [`${path}: expected null`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected an array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) return [`${path}: needs at least ${schema.minItems} items`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return [`${path}: allows at most ${schema.maxItems} items`];
      const out: string[] = [];
      for (let i = 0; i < value.length && out.length < 20; i++) out.push(...validate(value[i], schema.items, `${path}[${i}]`));
      return out;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: expected an object`];
      const obj = value as Record<string, unknown>;
      const out: string[] = [];
      for (const key of schema.required ?? []) if (!(key in obj)) out.push(`${path}.${key}: required`);
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties[key];
        if (prop) out.push(...validate(v, prop, `${path}.${key}`));
        else if (!schema.additionalProperties) out.push(`${path}.${key}: unknown field`);
      }
      return out;
    }
  }
}

// shorthands for writing schemas compactly
export const s = {
  string: (description?: string, extra: { enum?: readonly string[]; minLength?: number; maxLength?: number } = {}): JsonSchema => ({
    type: "string",
    description,
    ...extra,
  }),
  int: (description?: string, minimum?: number, maximum?: number): JsonSchema => ({ type: "integer", description, minimum, maximum }),
  number: (description?: string): JsonSchema => ({ type: "number", description }),
  bool: (description?: string): JsonSchema => ({ type: "boolean", description }),
  null: (): JsonSchema => ({ type: "null" }),
  array: (items: JsonSchema, description?: string, minItems?: number, maxItems?: number): JsonSchema => ({
    type: "array",
    items,
    description,
    minItems,
    maxItems,
  }),
  object: (properties: Record<string, JsonSchema>, required: readonly string[] = Object.keys(properties), description?: string): JsonSchema => ({
    type: "object",
    properties,
    required,
    description,
  }),
  anyOf: (...options: JsonSchema[]): JsonSchema => ({ anyOf: options }),
};
