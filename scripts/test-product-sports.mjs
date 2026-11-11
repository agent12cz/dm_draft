import assert from "node:assert/strict";
import { filterProductsBySport, getProductSport, productSports } from "../src/lib/products.ts";

const products = [
  { id: "legacy", active: true },
  { id: "nhl", sport: "NHL" },
  { id: "nba", sport: "NBA" },
  { id: "nfl", sport: "NFL" },
  { id: "mlb", sport: "MLB" },
  { id: "unknown", sport: "soccer" },
];

assert.deepEqual(productSports, ["NHL", "NBA", "NFL", "MLB"]);
assert.equal(getProductSport(undefined), "NHL");
assert.equal(getProductSport("soccer"), null);
assert.deepEqual(filterProductsBySport(products, "NHL").map(({ id }) => id), ["legacy", "nhl"]);
assert.deepEqual(filterProductsBySport(products, "NBA").map(({ id }) => id), ["nba"]);
assert.deepEqual(filterProductsBySport(products, "NFL").map(({ id }) => id), ["nfl"]);
assert.deepEqual(filterProductsBySport(products, "MLB").map(({ id }) => id), ["mlb"]);
console.log("✓ Product sport filtering and legacy NHL fallback");
