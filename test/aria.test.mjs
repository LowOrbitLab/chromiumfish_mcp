import assert from "node:assert/strict";
import test from "node:test";
import { implicitAriaRole, snapshotRole } from "../dist/aria.js";

const role = (overrides) => implicitAriaRole({
  tag: "input",
  type: "",
  hasList: false,
  multiple: false,
  size: 0,
  ...overrides,
});

test("maps the elements snapshot enumerates to implicit ARIA roles", () => {
  assert.equal(role({ tag: "a" }), "link");
  assert.equal(role({ tag: "button" }), "button");
  assert.equal(role({ tag: "textarea" }), "textbox");
  assert.equal(role({ tag: "input", type: "text" }), "textbox");
  assert.equal(role({ tag: "input", type: "email" }), "textbox");
  assert.equal(role({ tag: "input", type: "search" }), "searchbox");
  assert.equal(role({ tag: "input", type: "checkbox" }), "checkbox");
  assert.equal(role({ tag: "input", type: "radio" }), "radio");
  assert.equal(role({ tag: "input", type: "range" }), "slider");
  assert.equal(role({ tag: "input", type: "number" }), "spinbutton");
  for (const type of ["button", "submit", "reset", "image"]) {
    assert.equal(role({ tag: "input", type }), "button");
  }
});

test("select maps by multiple and size", () => {
  assert.equal(role({ tag: "select" }), "combobox");
  assert.equal(role({ tag: "select", size: 1 }), "combobox");
  assert.equal(role({ tag: "select", multiple: true }), "listbox");
  assert.equal(role({ tag: "select", size: 4 }), "listbox");
});

test("a datalist-bound text input is a combobox", () => {
  assert.equal(role({ tag: "input", type: "text", hasList: true }), "combobox");
  assert.equal(role({ tag: "input", type: "search", hasList: true }), "combobox");
});

test("returns empty for input types and tags HTML gives no role", () => {
  for (const type of ["password", "file", "color", "date", "datetime-local", "month", "time", "week"]) {
    assert.equal(role({ tag: "input", type }), "", `input[type=${type}] should have no role`);
  }
  assert.equal(role({ tag: "div" }), "");
  assert.equal(role({ tag: "span" }), "");
});

test("snapshotRole prefers an explicit role, then HTML, then the tag", () => {
  const base = { tag: "div", type: "", hasList: false, multiple: false, size: 0 };
  assert.equal(snapshotRole({ ...base, explicitRole: "button" }), "button");
  assert.equal(snapshotRole({ ...base, tag: "a", explicitRole: "" }), "link");
  // No explicit role and no HTML mapping: the tag is still more useful than nothing.
  assert.equal(snapshotRole({ ...base, explicitRole: "" }), "div");
  assert.equal(snapshotRole({ ...base, tag: "input", type: "password", explicitRole: "" }), "input");
});
