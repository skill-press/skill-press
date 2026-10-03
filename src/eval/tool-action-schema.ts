/** Fixed trusted schema; never derived from skill or model content. */
export const TOOL_ACTION_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: {
    action: {
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["python"] }, code: { type: "string" } },
          required: ["kind", "code"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["answer"] }, text: { type: "string" } },
          required: ["kind", "text"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["action"],
  additionalProperties: false,
});
