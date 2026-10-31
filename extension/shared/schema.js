// Structured-output schema for the tidy request (output_config.format).
// Kept static so the API can cache the compiled grammar. Structured outputs do not support
// minLength/maxLength/maxItems or per-run enums, so plan.js enforces those limits itself.

import { ICONS } from "./icons.js";

// Frozen all the way down, the icon enum included: no caller can add a per-run value or edit the
// shared schema in place, which would recompile the grammar for every later request.
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const PLAN_SCHEMA = deepFreeze({
  type: "object",
  properties: {
    groups: {
      type: "array",
      description: "Groups in display order (related groups next to each other).",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short topic name, at most 32 characters, no emoji." },
          icon: { type: "string", enum: [...ICONS] },
          existing_group: {
            type: "integer",
            description: "Number of the existing group these tabs join, or 0 for a new group.",
          },
          place_after: {
            type: "integer",
            description: "For a new group: number of the most related existing group, or 0.",
          },
          // Before tab_ids on purpose: the model names the group's one subject before it picks the tabs. With Haiku on
          // 236 real tabs it cut tabs from unrelated fields from 26 to 10 per tidy (fewer tabs grouped, too: 87% to
          // 71%). plan.js doesn't read it.
          about: { type: "string", description: "One short sentence: the single subject every tab in this group is about." },
          tab_ids: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "icon", "existing_group", "place_after", "about", "tab_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
});
