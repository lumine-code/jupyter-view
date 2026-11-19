"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { NotebookNavigation } = require("../lib/notebook-navigation");

function heading(text, level, cellIndex, cellRow = 0) {
  return { text, level, cellIndex, cellRow, classList: [] };
}

function fixture() {
  return [
    heading("First", 1, 2),
    heading("Nested", 2, 3),
    heading("Deep", 3, 4),
    heading("Last", 1, 6),
  ];
}

test("retains a complete tree and its entry identities during current and visibility updates", () => {
  const navigation = new NotebookNavigation();
  const headings = fixture();
  const initial = navigation.update(headings, 4, [3, 4]);
  const first = initial.headers[0];
  const nested = first.children[0];
  const deep = nested.children[0];
  const last = initial.headers[1];
  assert.equal(initial.stateChanges, undefined);
  assert.equal(first.stackCount, 1);
  assert.equal(nested.stackCount, 1);
  assert.equal(deep.currentCount, 1);

  const update = navigation.update(headings, 6, [6]);
  assert.equal(update.headers, null);
  assert.equal(navigation.headers, initial.headers);
  assert.equal(navigation.headers[0], first);
  assert.equal(first.children[0], nested);
  assert.equal(nested.children[0], deep);
  assert.equal(navigation.headers[1], last);
  assert.deepEqual(update.stateChanges, [
    { path: [1], currentCount: 1, stackCount: 1, visibility: 1 },
    { path: [0], currentCount: 0, stackCount: 0, visibility: 0 },
    { path: [0, 0], currentCount: 0, stackCount: 0, visibility: 0 },
    { path: [0, 0, 0], currentCount: 0, stackCount: 0, visibility: 0 },
  ]);
  assert.equal(last.currentCount, 1);
  assert.equal(deep.visibility, 0);
  assert.deepEqual(navigation.update(headings, 6, [6]).stateChanges, []);
});

test("keeps two observers independent while sharing immutable heading descriptions", () => {
  const headings = fixture();
  const panel = new NotebookNavigation();
  const scrollmap = new NotebookNavigation();
  panel.update(headings, 4, [4]);
  scrollmap.update(headings, 4, [4]);
  assert.notEqual(panel.headers, scrollmap.headers);
  assert.notEqual(panel.headers[0].children[0], scrollmap.headers[0].children[0]);
  const panelUpdate = panel.update(headings, 6, [6]);
  assert.equal(scrollmap.headers[1].currentCount, 0);
  assert.deepEqual(scrollmap.update(headings, 6, [6]), panelUpdate);
  assert.ok(headings.every((item) => item.currentCount === undefined && !item.children));
});

test("replaces the snapshot and nested paths when headings are edited, removed or reordered", () => {
  const navigation = new NotebookNavigation();
  const headings = fixture();
  const initial = navigation.update(headings, 4, [4]);
  const replacement = [heading("Last renamed", 1, 1), heading("New child", 2, 2)];
  const rebuilt = navigation.update(replacement, 2, [2]);
  assert.notEqual(rebuilt.headers, initial.headers);
  assert.equal(rebuilt.stateChanges, undefined);
  assert.equal(rebuilt.headers.length, 1);
  assert.equal(rebuilt.headers[0].text, "Last renamed");
  assert.equal(rebuilt.headers[0].children[0].currentCount, 1);
  assert.deepEqual(navigation.update(replacement, 1, [1]).stateChanges, [
    { path: [0], currentCount: 1, stackCount: 1, visibility: 1 },
    { path: [0, 0], currentCount: 0, stackCount: 0, visibility: 0 },
  ]);
});

test("keeps boundary-only updates independent of a later active heading", () => {
  const navigation = new NotebookNavigation();
  const headings = fixture();
  assert.equal(navigation.update(headings, 6, [0]).scrollBoundary, "start");
  const boundary = navigation.update(headings, 6, [1]);
  assert.equal(boundary.headers, null);
  assert.equal(boundary.scrollBoundary, "start");
  assert.deepEqual(boundary.stateChanges, []);
  const gap = navigation.update(headings, 6, [5]);
  assert.equal(gap.scrollBoundary, null);
  assert.deepEqual(gap.stateChanges, []);
  assert.equal(navigation.update(headings, 6, []).scrollBoundary, null);
});

test("publishes empty and bounded outlines as complete snapshots without losing sentinel metadata", () => {
  const navigation = new NotebookNavigation();
  assert.deepEqual(navigation.update([], 0, []).headers, []);
  const sentinel = {
    ...heading("Outline incomplete — more text remains", 1, 8, 127),
    incomplete: true,
    classList: ["text-subtle"],
  };
  const headings = [heading("Preview…", 1, 3), sentinel];
  const snapshot = navigation.update(headings, 3, [3]);
  assert.equal(snapshot.headers[1].incomplete, true);
  assert.equal(snapshot.headers[1].cellRow, 127);
  assert.deepEqual(snapshot.headers[1].classList, ["text-subtle"]);
  assert.equal(navigation.update(headings, 8, [8]).headers, null);
  assert.equal(navigation.headers[1].currentCount, 1);
});
