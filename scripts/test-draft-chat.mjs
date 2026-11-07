import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const playerPath = new URL("../src/components/PlayerDraftPage.tsx", import.meta.url);
const playerSource = ts.createSourceFile(
  playerPath.pathname, readFileSync(playerPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);
assert.equal(playerSource.parseDiagnostics.length, 0);
const chats = [];
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(playerSource) === "DraftChat") {
    chats.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(playerSource);
assert.equal(chats.length, 1);
const chat = chats[0];
assert.equal(ts.isJsxElement(chat.parent), true);
const column = chat.parent;
assert.equal(column.children.filter((node) =>
  ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node) || ts.isJsxExpression(node),
)[0], chat);
assert.match(column.getText(playerSource), /Moje týmy/);
assert.doesNotMatch(column.openingElement.getText(playerSource), /hidden|mobileTab|sidebarTab/);
assert.doesNotMatch(chat.getText(playerSource), /\bkey=|mobileTab|sidebarTab/);
assert.doesNotMatch(readFileSync(playerPath, "utf8"), /set(?:Mobile|Sidebar)Tab\("chat"\)/);
console.log("✓ Exactly one unconditionally mounted chat precedes My Teams outside the tab panels");

const adminPath = new URL("../src/app/draft/[code]/page.tsx", import.meta.url);
const adminSource = ts.createSourceFile(
  adminPath.pathname, readFileSync(adminPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);
assert.equal(adminSource.parseDiagnostics.length, 0);
const adminChats = [];
function visitAdmin(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(adminSource) === "DraftChat") {
    adminChats.push(node);
  }
  ts.forEachChild(node, visitAdmin);
}
visitAdmin(adminSource);
assert.equal(adminChats.length, 1);
const adminChat = adminChats[0];
assert.equal(ts.isJsxElement(adminChat.parent), true);
const adminChatCard = adminChat.parent;
assert.equal(ts.isJsxElement(adminChatCard.parent), true);
const adminTopGrid = adminChatCard.parent;
assert.match(adminTopGrid.openingElement.getText(adminSource), /xl:grid-cols/);
const adminTopPanels = adminTopGrid.children.filter((node) =>
  ts.isJsxElement(node) && node.openingElement.tagName.getText(adminSource) === "Card",
);
assert.equal(adminTopPanels.length, 3);
assert.match(adminTopPanels[0].getText(adminSource), /Administrace draftu/);
assert.match(adminTopPanels[1].getText(adminSource), /Draft ještě nezačal/);
assert.equal(adminTopPanels[2], adminChatCard);
assert.match(adminChat.getText(adminSource), /isEmbedded/);
assert.match(adminChat.getText(adminSource), /h-80/);
assert.doesNotMatch(adminTopGrid.getText(adminSource), /<details/);
console.log("✓ Admin chat is always mounted once in the bounded top panel beside the draft controls and turn");

const slots = [];
const effects = [];
let cursor = 0;
const hooks = {
  useState(initial) {
    const index = cursor++;
    slots[index] ??= { value: initial };
    return [slots[index].value, (value) => {
      slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
    }];
  },
  useRef(initial) {
    const index = cursor++;
    slots[index] ??= { current: initial };
    return slots[index];
  },
  useEffect(callback, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
      previous?.cleanup?.();
      const effect = { dependencies };
      slots[index] = effect;
      effects.push(() => { effect.cleanup = callback(); });
    }
  },
};
const listeners = new Map();
let subscriptions = 0;
let unsubscriptions = 0;
const writes = [];
const firestoreApi = {
  doc: (_, collection, id) => `${collection}/${id}`,
  collection: (_, collection, id, child) => `${collection}/${id}/${child}`,
  orderBy: () => null,
  query: (path) => path,
  onSnapshot(path, callback) {
    subscriptions += 1;
    listeners.set(path, callback);
    return () => {
      unsubscriptions += 1;
      listeners.delete(path);
    };
  },
  serverTimestamp: () => "server-time",
  addDoc: async (path, data) => { writes.push({ path, data }); },
};
const chatPath = new URL("../src/components/DraftChat.tsx", import.meta.url);
const compiled = ts.transpileModule(readFileSync(chatPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const chatModule = { exports: {} };
runInNewContext(compiled, {
  module: chatModule,
  exports: chatModule.exports,
  require: (name) => {
    if (name === "react") return hooks;
    if (name === "@/lib/firebase") return { getFirebaseClient: async () => ({ db: {}, firestoreApi }) };
    if (name === "@/lib/firestoreWorker") return {
      callFirestoreWorker: async (operation, payload) => {
        writes.push({ operation, payload });
        return { status: "sent" };
      },
      getDraftPrivateAccess: async () => ({ authorized: true }),
    };
    return require(name);
  },
  console,
  Intl,
  window: { setInterval: () => 1, clearInterval: () => {} },
});
const { DraftChat } = chatModule.exports;
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  return predicate(node) ? node : find(node.props.children, predicate);
}
const scrolls = [];
const container = {
  scrollHeight: 1000, scrollTop: 800, clientHeight: 200,
  scrollTo: (options) => scrolls.push(options),
};
const props = {
  draftId: "ABCDE", draftCode: "ABCDE",
  currentUser: { uid: "player-1", displayName: "Player One" },
  currentUserRole: "participant",
};
function render() {
  cursor = 0;
  const tree = DraftChat(props);
  const log = find(tree, (node) => node.props.role === "log");
  if (log) log.props.ref.current = container;
  effects.splice(0).forEach((effect) => effect());
  return tree;
}
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
render();
await settle();
assert.equal(subscriptions, 1);
let tree = render();
const textarea = () => find(tree, (node) => node.type === "textarea");
textarea().props.onChange({ target: { value: "Rozpracovaná zpráva" } });
for (let index = 0; index < 10; index += 1) {
  emitMessages(`Draft update ${index}`);
  await settle();
}
assert.equal(textarea().props.value, "Rozpracovaná zpráva");
assert.equal(subscriptions, 1);
assert.equal(unsubscriptions, 0);
scrolls.length = 0;
console.log("✓ Chat updates preserve the composer and keep one message listener");

function emitMessages(text) {
  listeners.get("publicDrafts/ABCDE/messages")({
    docs: [{
      id: text,
      data: (options) => {
        assert.equal(options.serverTimestamps, "estimate");
        return {
          userId: "admin-1", displayName: "Admin One", role: "admin", text,
          createdAt: { toDate: () => new Date("2026-11-02T12:34:00Z") },
        };
      },
    }],
  });
  tree = render();
}
emitMessages("První zpráva");
assert.equal(scrolls.length, 1);
assert.equal(scrolls[0].top, container.scrollHeight);
const html = renderToStaticMarkup(tree);
assert.match(html, /Admin One/);
assert.match(html, /Admin/);
assert.match(html, /12:34/);
assert.match(html, /overflow-y-auto/);
assert.match(html, /max-h-\[65dvh\]/);
console.log("✓ Live messages preserve names, ADMIN, timestamps and scroll only the bounded message list");

find(tree, (node) => node.props.role === "log").props.onScroll({
  currentTarget: { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 },
});
emitMessages("Druhá zpráva");
assert.equal(scrolls.length, 1);
find(tree, (node) => node.props.role === "log").props.onScroll({ currentTarget: container });
emitMessages("Třetí zpráva");
assert.equal(scrolls.length, 2);
assert.equal(textarea().props.value, "Rozpracovaná zpráva");
console.log("✓ Reading older messages suspends auto-scroll; returning to the bottom resumes it");

let prevented = false;
textarea().props.onKeyDown({ key: "Enter", shiftKey: true, preventDefault: () => { prevented = true; } });
assert.equal(writes.length, 0);
assert.equal(prevented, false);
textarea().props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } });
await settle();
tree = render();
assert.equal(prevented, true);
assert.equal(writes.length, 1);
assert.equal(writes[0].operation, "draft.message");
assert.equal(writes[0].payload.draftId, "ABCDE");
assert.equal(writes[0].payload.text, "Rozpracovaná zpráva");
assert.equal(textarea().props.value, "");
slots.forEach((slot) => slot?.cleanup?.());
assert.equal(unsubscriptions, 1);
assert.equal(listeners.size, 0);
console.log("✓ Enter sends through the authorized Worker, Shift+Enter does not, and unmount cleans up listeners");
console.log("\nALL DRAFT CHAT REGRESSION TESTS PASSED!");
