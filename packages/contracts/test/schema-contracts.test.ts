import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaPaths = [
  new URL("../schemas/candidate.schema.json", import.meta.url),
  new URL("../schemas/creative-system-app-view-model.schema.json", import.meta.url),
  new URL("../schemas/model-response-metadata.schema.json", import.meta.url),
];

describe("JSON Schema contracts", () => {
  it("keeps all public schema roots closed", async () => {
    for (const path of schemaPaths) {
      const schema = JSON.parse(await readFile(path, "utf8"));
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toMatch(/^https:\/\/creative-loop2rsi\.local\/schemas\//);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("excludes secrets and hidden reasoning from model metadata", async () => {
    const path = new URL("../schemas/model-response-metadata.schema.json", import.meta.url);
    const source = await readFile(path, "utf8");
    const normalized = source.toLowerCase();
    expect(normalized.includes("api_key")).toBe(false);
    expect(normalized.includes("apikey")).toBe(false);
    expect(normalized.includes("reasoning_content")).toBe(false);
  });

  it("makes L5 promotion structurally invalid", async () => {
    const path = new URL("../schemas/candidate.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(path, "utf8"));
    const l5Rule = schema.allOf.find((rule: { if?: { properties?: { maturity?: { const?: string } } } }) =>
      rule.if?.properties?.maturity?.const === "L5"
    );
    expect(l5Rule).toBeDefined();
    expect(l5Rule.then.properties.experimental.const).toBe(true);
    expect(l5Rule.then.properties.state.not.const).toBe("PROMOTED");
  });
});
