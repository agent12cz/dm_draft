import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as rankings from "../src/lib/rankings.ts";
import * as products from "../src/lib/products.ts";
import * as sportsTeams from "../src/lib/sportsTeams.ts";
import * as snakeDraft from "../src/lib/snakeDraft.ts";

const source = readFileSync(new URL("../src/app/rankings/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport { RankingsPageContent as TestContent };`, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const state = [];
let stateIndex = 0;
const jsx = (type, props, key) => ({ type, props: { ...props, key } });
const wrapper = ({ children, ...props }) => jsx("div", { ...props, children });
const testModule = { exports: {} };

runInNewContext(compiled, {
  module: testModule,
  exports: testModule.exports,
  require(name) {
    if (name === "react") {
      return {
        useEffect: () => {},
        useMemo: (callback) => callback(),
        useState(initial) {
          const index = stateIndex++;
          if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
          return [state[index], (value) => {
            state[index] = typeof value === "function" ? value(state[index]) : value;
          }];
        },
      };
    }
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
    if (name === "next/link") return { __esModule: true, default: wrapper };
    if (name === "@/components/Navbar") return { Navbar: () => null };
    if (name === "@/components/PageContainer") return { PageContainer: wrapper };
    if (name === "@/components/Card") return { Card: wrapper };
    if (name === "@/components/TeamLogo") return { TeamLogo: wrapper };
    if (name === "@/app/auth-guard") return { __esModule: true, default: wrapper };
    if (name === "@/lib/rankings") return rankings;
    if (name === "@/lib/products") return products;
    if (name === "@/lib/sportsTeams") return sportsTeams;
    if (name === "@/lib/snakeDraft") return snakeDraft;
    if (name === "@/lib/firebase") return { getFirebaseClient: async () => ({}) };
    if (name === "@/lib/firestoreWorker") return { callFirestoreWorker: async () => ({}) };
    throw new Error(`Unexpected dependency: ${name}`);
  },
});

function resolve(node) {
  if (Array.isArray(node)) return node.map(resolve);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return resolve(node.type(node.props));
  return { ...node, props: { ...node.props, children: resolve(node.props.children) } };
}

function render() {
  stateIndex = 0;
  return resolve(testModule.exports.TestContent());
}

function findNodes(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, predicate, matches));
  } else if (node && typeof node === "object") {
    if (predicate(node)) matches.push(node);
    findNodes(node.props?.children, predicate, matches);
  }
  return matches;
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node?.props ? textContent(node.props.children) : "";
}

let tree = render();
let tabs = findNodes(tree, (node) => node.type === "button" && node.props.role === "tab");
assert.deepEqual(tabs.map((tab) => tab.props.children), ["NHL", "NBA", "NFL", "MLB"]);
assert.equal(tabs[0].props["aria-selected"], true);
assert.equal(tabs[0].props.disabled, false);

tabs[1].props.onClick();
tree = render();
tabs = findNodes(tree, (node) => node.type === "button" && node.props.role === "tab");
assert.equal(tabs[1].props["aria-selected"], true);
assert.equal(tabs[0].props["aria-selected"], false);
assert.ok(findNodes(tree, (node) => node.type === "h1").some((node) =>
  textContent(node) === "Žebříčky atraktivity týmů NBA",
));

tabs[2].props.onClick();
tree = render();
tabs = findNodes(tree, (node) => node.type === "button" && node.props.role === "tab");
assert.equal(tabs[2].props["aria-selected"], true);
assert.ok(findNodes(tree, (node) => node.type === "h1").some((node) =>
  textContent(node) === "Žebříčky atraktivity týmů NFL",
));
console.log("✓ Admin ranking tabs switch selected sports and update the displayed ranking");
