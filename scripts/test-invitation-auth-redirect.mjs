import assert from "node:assert/strict";
import {
  clearAuthRedirect,
  getAuthRedirect,
  setAuthRedirect,
} from "../src/lib/authRedirect.ts";

const storage = new Map();
globalThis.window = {
  sessionStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
};

const token = "A".repeat(43);
const redirect = `/invite#${token}`;
setAuthRedirect(redirect);
assert.equal(getAuthRedirect(), redirect);
clearAuthRedirect("/invite#different-token");
assert.equal(getAuthRedirect(), redirect);
clearAuthRedirect(redirect);
assert.equal(getAuthRedirect(), null);

for (const path of ["/", "/join", "//evil.example", "/invite?token=secret", "/invite#short"]) {
  setAuthRedirect(path);
  assert.equal(getAuthRedirect(), null);
}

storage.set("dm-auth-redirect", "//evil.example");
assert.equal(getAuthRedirect(), null);
console.log("✓ Authentication returns only to the same validated invitation fragment");
