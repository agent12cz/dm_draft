import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/TeamLogo.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

let failed = false;
const testModule = { exports: {} };
runInNewContext(compiled, {
  module: testModule,
  exports: testModule.exports,
  require(name) {
    if (name === "react") {
      return {
        useState(initial) {
          return [failed || initial, (value) => {
            failed = value;
          }];
        },
        useEffect() {},
      };
    }
    if (name === "react/jsx-runtime") {
      return {
        jsx: (type, props) => ({ type, props }),
      };
    }
    if (name === "@/lib/snakeDraft" || name === "@/lib/sportsTeams") return {};
    if (name === "@/lib/products") return { isProductSport: (sport) => ["NHL", "NBA", "NFL", "MLB"].includes(sport) };
    throw new Error(`Unexpected dependency: ${name}`);
  },
});

const team = {
  id: "nba-boston-celtics",
  name: "Boston Celtics",
  abbreviation: "BOS",
  sport: "NBA",
  logo: "/logos/nba/BOS.png",
};
const props = { team, className: "h-7 w-7" };

const image = testModule.exports.TeamLogo(props);
assert.equal(image.type, "img");
assert.equal(image.props.src, "/logos/nba/BOS.png");
image.props.onError();

const fallback = testModule.exports.TeamLogo(props);
assert.equal(fallback.type, "span");
assert.equal(fallback.props.children, "BOS");
assert.equal(fallback.props["aria-label"], "Boston Celtics (BOS)");
console.log("✓ Missing team logo falls back to the team abbreviation");
