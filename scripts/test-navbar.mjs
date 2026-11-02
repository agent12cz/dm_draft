import assert from "node:assert/strict";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { AuthProvider } from "../src/components/AuthProvider.tsx";
import { Navbar, NavbarAccountMenu } from "../src/components/Navbar.tsx";

function menu(overrides = {}) {
  return NavbarAccountMenu({
    loading: false,
    userLabel: null,
    isLoggingOut: false,
    logoutError: null,
    onLogout: () => {},
    ...overrides,
  });
}

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    return node.map((child) => findElement(child, predicate)).find(Boolean);
  }
  if (!isValidElement(node)) return undefined;
  return predicate(node) ? node : findElement(node.props.children, predicate);
}

{
  const html = renderToStaticMarkup(menu());
  assert.match(html, /href="\/register"/);
  assert.match(html, /Registrovat/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /Přihlásit/);
  assert.doesNotMatch(html, /Odhlásit se/);
  console.log("✓ Signed-out users see both authentication links");
}

for (const userLabel of ["Hráč draftu", "player@example.test", "Uživatel"]) {
  const element = menu({ userLabel });
  const html = renderToStaticMarkup(element);
  assert.equal(findElement(element, (node) => node.type === "span").props.children, userLabel);
  assert.match(html, /Odhlásit se/);
  assert.doesNotMatch(html, /href="\/(?:register|login)"/);
  assert.doesNotMatch(element.props.className, /(?:^|\s)(?:hidden|md:flex|md:hidden)(?:\s|$)/);
  console.log(`✓ Signed-in account menu displays ${userLabel} on mobile and desktop`);
}

for (const userLabel of [null, "Přihlášený hráč"]) {
  const html = renderToStaticMarkup(menu({ loading: true, userLabel }));
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /href="\/(?:register|login)"|Odhlásit se/);
}
console.log("✓ Pending authentication never renders the signed-out controls");

{
  const html = renderToStaticMarkup(createElement(
    AppRouterContext.Provider,
    { value: { replace: () => {} } },
    createElement(AuthProvider, null, createElement(Navbar)),
  ));
  assert.match(html, /Načítám přihlášení/);
  assert.doesNotMatch(html, /href="\/(?:register|login)"/);
  console.log("✓ The complete navbar initially renders loading through the existing AuthProvider");
}

{
  let signedOut = false;
  const element = menu({
    userLabel: "Hráč",
    onLogout: () => { signedOut = true; },
  });
  const logout = findElement(element, (node) => node.type === "button");
  assert.equal(logout.props.disabled, false);
  logout.props.onClick();
  assert.equal(signedOut, true);
  const html = renderToStaticMarkup(menu({ userLabel: signedOut ? null : "Hráč" }));
  assert.match(html, /Registrovat/);
  assert.match(html, /Přihlásit/);
  assert.doesNotMatch(html, /Odhlásit se/);
  console.log("✓ Logout invokes the supplied action and signed-out state restores both links");
}

{
  const element = menu({ userLabel: "Hráč", isLoggingOut: true });
  const logout = findElement(element, (node) => node.type === "button");
  assert.equal(logout.props.disabled, true);
  assert.match(renderToStaticMarkup(element), /Odhlašuji/);
  console.log("✓ Pending logout disables repeated submissions");
}

{
  const element = menu({ userLabel: "Hráč", logoutError: "Nepodařilo se odhlásit." });
  const html = renderToStaticMarkup(element);
  assert.match(html, /role="alert"/);
  assert.match(html, /Nepodařilo se odhlásit/);
  assert.match(html, /Odhlásit se/);
  assert.doesNotMatch(html, /href="\/(?:register|login)"/);
  console.log("✓ Logout errors remain visible without pretending the user is signed out");
}

console.log("\nALL NAVBAR RENDERING TESTS PASSED!");
