import assert from "node:assert/strict";
import test from "node:test";

import { USE_CASE_PRESETS } from "../lib/swarm/use-cases.mjs";

test("four self-contained presets fit the existing input contract", () => {
  assert.equal(USE_CASE_PRESETS.length, 4);
  assert.equal(new Set(USE_CASE_PRESETS.map((preset) => preset.id)).size, 4);
  for (const preset of USE_CASE_PRESETS) {
    assert.deepEqual(Object.keys(preset), [
      "id",
      "title",
      "description",
      "objective",
      "acceptanceCriteria",
    ]);
    assert.match(preset.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(preset.title.length > 3);
    assert.ok(preset.description.length > 12);
    assert.ok(preset.objective.length >= 12 && preset.objective.length <= 700);
    assert.ok(preset.acceptanceCriteria.length >= 12 && preset.acceptanceCriteria.length <= 700);
    assert.match(preset.objective, /Using only/i);
    assert.doesNotMatch(
      `${preset.objective} ${preset.acceptanceCriteria}`,
      /browse|web search|external research|upload|attachment/i,
    );
    assert.equal(Object.isFrozen(preset), true);
  }
});
