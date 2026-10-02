import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchCategory, matchSupplier, normalizeName, type SafeSupplier } from "../supplier-match.ts";

const suppliers: SafeSupplier[] = [
  { id: "s1", supplierName: "Mega Supplies Sdn. Bhd.", registrationNumber: "201901012345 (1234567-X)", activeStatus: true },
  { id: "s2", supplierName: "CloudHost Pro", registrationNumber: null, activeStatus: true },
  { id: "s3", supplierName: "PrintFast Solutions", registrationNumber: "202002023456", activeStatus: true },
  { id: "s4", supplierName: "PrintFast Solution Enterprise", registrationNumber: null, activeStatus: true },
  { id: "s5", supplierName: "Mega Supplies Old", registrationNumber: "201901012345", activeStatus: false },
];

describe("supplier matching", () => {
  it("matches uniquely by registration number", () => {
    const r = matchSupplier({ name: "Mega Supplies", registrationNumber: "201901012345" }, suppliers);
    assert.equal(r.status, "exact");
    assert.equal(r.supplierId, "s1");
  });

  it("matches uniquely by normalised exact name (legal suffix tolerant)", () => {
    const r = matchSupplier({ name: "MEGA SUPPLIES SDN BHD", registrationNumber: null }, suppliers);
    assert.equal(r.status, "exact");
    assert.equal(r.supplierId, "s1");
  });

  it("never returns an inactive supplier", () => {
    const r = matchSupplier({ name: "Mega Supplies Old", registrationNumber: null }, suppliers);
    assert.notEqual(r.supplierId, "s5");
    assert.ok(r.candidates.every((c) => c.supplierId !== "s5"));
  });

  it("returns ranked candidates (no supplier id) when only similar", () => {
    const r = matchSupplier({ name: "PrintFast Solution", registrationNumber: null }, suppliers);
    assert.equal(r.status, "candidates");
    assert.equal(r.supplierId, null);
    assert.deepEqual(r.candidates.map((c) => c.supplierId).slice(0, 2).sort(), ["s3", "s4"]);
  });

  it("demotes a registration hit with a clearly different name to a candidate", () => {
    const r = matchSupplier({ name: "Totally Unrelated Trading", registrationNumber: "202002023456" }, suppliers);
    assert.equal(r.status, "candidates");
    assert.equal(r.supplierId, null);
    assert.equal(r.candidates[0].reason, "registration_matches_name_differs");
  });

  it("returns none for nothing usable or no similar supplier", () => {
    assert.deepEqual(matchSupplier({ name: null, registrationNumber: null }, suppliers), { status: "none", supplierId: null, candidates: [] });
    assert.equal(matchSupplier({ name: "Zzyzx Quantum Holdings", registrationNumber: null }, suppliers).status, "none");
  });

  it("is ambiguous when two suppliers share the exact normalised name", () => {
    const dup: SafeSupplier[] = [...suppliers, { id: "s6", supplierName: "Cloudhost Pro Sdn Bhd", registrationNumber: null, activeStatus: true }];
    const r = matchSupplier({ name: "CloudHost Pro", registrationNumber: null }, dup);
    assert.equal(r.status, "candidates");
    assert.equal(r.supplierId, null);
  });

  it("works from a projection that has no bank fields", () => {
    for (const s of suppliers) assert.deepEqual(Object.keys(s).filter((k) => /bank/i.test(k)), []);
  });

  it("normalises names", () => {
    assert.equal(normalizeName("Café  Müller & Sons (M) Sdn. Bhd."), "cafe muller and sons");
  });
});

describe("category matching", () => {
  const categories = [{ id: "c1", name: "Office Supplies" }, { id: "c2", name: "Printing & Stationery" }, { id: "c3", name: "Office Equipment" }];
  it("matches exact names case-insensitively", () => {
    assert.deepEqual(matchCategory("office supplies", categories), { status: "exact", categoryId: "c1" });
  });
  it("offers candidates for near matches and none otherwise", () => {
    const near = matchCategory("Office Supply", categories);
    assert.equal(near.status, "candidates");
    assert.equal(matchCategory("Quantum", categories).status, "none");
    assert.equal(matchCategory(null, categories).status, "none");
  });
});
