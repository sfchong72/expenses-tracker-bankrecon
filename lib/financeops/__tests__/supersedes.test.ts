import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePayloadHash } from "../intake";
import { parseBillIntake } from "../schema";
import { metadata } from "./harness";

const SHA = "a".repeat(64);
const codes = (input: unknown) => {
  const r = parseBillIntake(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};

describe("11: supersedes_intake_id is on the exact top-level allow-list (and nothing else is)", () => {
  it("is accepted when well-formed and carried through unchanged", () => {
    const r = parseBillIntake(metadata({ supersedes_intake_id: "fo_bill_UNRESOLVED1" }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.supersedes_intake_id, "fo_bill_UNRESOLVED1");
  });

  it("is omitted (not null) from the parsed intake when the request does not send it, so existing payload hashes are unchanged", () => {
    const r = parseBillIntake(metadata());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal("supersedes_intake_id" in r.value, false);
      const withKey = parseBillIntake(metadata({ supersedes_intake_id: "fo_bill_UNRESOLVED1" }));
      assert.equal(withKey.ok, true);
      if (withKey.ok) assert.notEqual(computePayloadHash(r.value, SHA), computePayloadHash(withKey.value, SHA)); // lineage is part of the hash
    }
  });

  it("is validated strictly: same format as intake_id, a string, never null", () => {
    assert.deepEqual(codes(metadata({ supersedes_intake_id: "short" })), ["supersedes_intake_id:invalid_format"]);
    assert.deepEqual(codes(metadata({ supersedes_intake_id: "has space in it" })), ["supersedes_intake_id:invalid_format"]);
    assert.deepEqual(codes(metadata({ supersedes_intake_id: 12345678 })), ["supersedes_intake_id:invalid_type"]);
    assert.deepEqual(codes(metadata({ supersedes_intake_id: null })), ["supersedes_intake_id:invalid_type"]);
    assert.deepEqual(codes(metadata({ supersedes_intake_id: { id: "x" } })), ["supersedes_intake_id:invalid_type"]);
  });

  it("unknown top-level fields and every prohibited field are still rejected", () => {
    assert.deepEqual(codes(metadata({ supersedes: "fo_bill_UNRESOLVED1" })), ["supersedes:unknown_field"]);
    assert.deepEqual(codes(metadata({ superseded_by: "fo_bill_UNRESOLVED1" })), ["superseded_by:unknown_field"]);
    for (const k of ["created_by", "payment_status", "entity_id", "review_status", "process_state", "supplier_bill_id".replace("supplier_bill_id", "bill_id")]) {
      assert.ok(codes(metadata({ [k]: "x" })).includes(`${k}:forbidden_field`), k);
    }
  });
});
