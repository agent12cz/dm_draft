import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { DraftBoxGallery } from "../src/components/DraftBoxGallery.tsx";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(`${source}\nexport { HomeContent as TestContent };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

let fixtures = [];
let stateIndex = 0;
const container = ({ children, className }) => React.createElement("div", { className }, children);
const link = ({ children, ...props }) => React.createElement("a", props, children);
const testModule = { exports: {} };
runInNewContext(compiled, {
  module: testModule,
  exports: testModule.exports,
  require(name) {
    if (name === "react") return {
      useState(initial) {
        const index = stateIndex++;
        return [index === 0 ? fixtures : index === 1 ? false : initial, () => {}];
      },
      useEffect: () => {},
      useMemo: (callback) => callback(),
    };
    if (name === "next/link") return { __esModule: true, default: link };
    if (name === "next/navigation") return { useRouter: () => ({}) };
    if (name === "@/components/AuthProvider") return { useAuth: () => ({ user: { uid: "test-owner" } }) };
    if (name === "@/components/DraftBoxGallery") return { DraftBoxGallery };
    if (name === "@/components/Navbar") return { Navbar: () => null };
    if (name === "@/components/PageContainer") return { PageContainer: container };
    if (name === "@/components/Card") return { Card: container };
    if (name === "@/components/PrimaryButton") return { PrimaryButton: link };
    if (name === "@/app/auth-guard") return { __esModule: true, default: container };
    if (name.startsWith("@/lib/")) return {};
    return require(name);
  },
  console,
});

const extended = {
  productId: "extended",
  productName: "Extended Series",
  productSeason: "2025/26",
  productImageUrl: "/catalog/extended.png",
  boxPrice: 100,
  boxCount: 1,
};
const spx = { ...extended, productId: "spx", productName: "SPx", productImageUrl: "/catalog/spx.png" };

function draft(overrides = {}) {
  return {
    id: "test",
    code: "ABC123",
    title: "Testovaci draft s dlouhym nazvem pro mobilni zobrazeni",
    sport: "NHL",
    status: "waiting",
    participantCount: 8,
    participants: [{ name: "Test participant" }],
    pickOrder: [0],
    productName: "Extended Series + SPx",
    productSeason: "2025/26",
    productImageUrl: "/catalog/legacy.png",
    boxCount: 99,
    boxes: [extended],
    ...overrides,
  };
}

export function renderHome(drafts) {
  fixtures = drafts;
  stateIndex = 0;
  return renderToStaticMarkup(React.createElement(testModule.exports.TestContent));
}

const cases = [
  { label: "one box", boxes: [extended], images: [extended.productImageUrl], grid: "grid-cols-1", size: "h-60 sm:h-72" },
  { label: "two identical boxes", boxes: [{ ...extended, boxCount: 2 }], images: Array(2).fill(extended.productImageUrl), grid: "grid-cols-2", size: "h-40 sm:h-44" },
  { label: "two different boxes", boxes: [extended, spx], images: [extended.productImageUrl, spx.productImageUrl], grid: "grid-cols-2", size: "h-40 sm:h-44" },
  { label: "mixed break with repeated boxes", boxes: [{ ...extended, boxCount: 2 }, spx], images: [extended.productImageUrl, extended.productImageUrl, spx.productImageUrl], grid: "repeat(auto-fit,minmax(min(100%,100px),1fr))", size: "h-28" },
  { label: "large break without hidden boxes", boxes: [{ ...extended, boxCount: 12 }, { ...spx, boxCount: 6 }], images: [...Array(12).fill(extended.productImageUrl), ...Array(6).fill(spx.productImageUrl)], grid: "repeat(auto-fit,minmax(min(100%,100px),1fr))", size: "h-28" },
];
const statusLabels = {
  waiting: "Čeká na spuštění",
  drafting: "Probíhá",
  paused: "Pozastaven",
  completed: "Dokončen",
};

for (const status of ["waiting", "drafting", "paused", "completed"]) {
  for (const test of cases) {
    const fixture = draft({ boxes: test.boxes, status });
    const html = renderHome([fixture]);
    assert.deepEqual([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]), test.images);
    assert.ok(html.includes(test.grid));
    assert.ok(html.includes(test.size));
    assert.ok(html.includes(`aria-label="Boxy v draftu: ${test.images.length}"`));
    assert.ok(html.includes(fixture.title));
    assert.ok(html.includes(statusLabels[status]));
    assert.match(html, /Účastníci:<\/span> 8/);
    assert.match(html, /ABC123/);
    assert.match(html, /href="\/draft\/ABC123"/);
    assert.match(html, /Smazat/);
    assert.match(html, /Duplikovat/);
    assert.match(html, status === "drafting" || status === "paused" ? /Pokračovat v draftu/ : /Otevřít/);
    assert.match(html, /flex-wrap items-center gap-2/);
    assert.doesNotMatch(html, /pr-24|whitespace-nowrap|lg:grid-cols-\[45%_55%\]/);
    if (status !== "completed") assert.match(html, /Test participant/);
    console.log(`✓ ${status}: ${test.label}, metadata and actions preserved`);
  }
}

for (const boxes of [undefined, []]) {
  for (const boxCount of [undefined, 1, 2, 4]) {
    const html = renderHome([draft({ boxes, boxCount })]);
    assert.equal((html.match(/src="\/catalog\/legacy.png"/g) ?? []).length, boxCount ?? 1);
  }
}
console.log("✓ Legacy drafts use the saved image and quantity");

{
  const html = renderHome([draft({ boxes: [{ ...extended, boxCount: 2, productImageUrl: "" }, spx] })]);
  assert.equal((html.match(/Fotografie není k dispozici/g) ?? []).length, 2);
  assert.equal((html.match(/<img/g) ?? []).length, 1);
  assert.match(html, /aria-label="Boxy v draftu: 3"/);
  assert.doesNotMatch(html, /src="\/catalog\/legacy.png"/);
}
console.log("✓ Missing photos retain their box slots without using an unrelated image");

console.log("\nALL HOME DRAFT BOX RENDERING TESTS PASSED!");
