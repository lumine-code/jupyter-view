describe("notebook metadata", () => {
  let registry, editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const pack = await lumine.packages.activatePackage(name);
      await pack.resourceLoadPromise;
    }
    const Registry = require("../lib/notebook-document-registry");
    registry = new Registry();
    editor = await registry.buildEditor(null);
    await editor._sourceEditorSetupPromise;
  });

  afterEach(() => {
    editor?.destroy();
    registry?.destroy();
  });

  it("uses live unsaved notebook metadata and counts without exposing arbitrary JSON", async () => {
    const changes = jasmine.createSpy("metadata changed");
    const lease = editor.onDidChangeMetadata(changes);
    try {
      editor.document.updateMetadata({
        kernelspec: { display_name: "Test kernel", language: "python" },
        language_info: { name: "python", version: "3.14" },
        private_data: { large: "must not appear" },
      });
      editor.document.insertCell(1, "markdown");
      const [notebook] = await editor.getMetadata();
      expect(notebook.id).toBe("notebook");
      expect(notebook.rows.find((row) => row.id === "kernel").value).toBe("Test kernel");
      expect(notebook.rows.find((row) => row.id === "language-version").value).toBe("3.14");
      expect(notebook.rows.find((row) => row.id === "cells").value).toBe(2);
      expect(notebook.rows.find((row) => row.id === "markdown-cells").value).toBe(1);
      expect(JSON.stringify(notebook)).not.toContain("must not appear");
      expect(changes).toHaveBeenCalled();
      lease.dispose();
      changes.calls.reset();
      editor.document.updateMetadata({});
      expect(changes).not.toHaveBeenCalled();
    } finally {
      lease.dispose();
    }
  });

  it("labels backing source sections and invalidates when their metadata changes", async () => {
    const sections = await editor.getMetadata();
    expect(sections.some((section) => section.id.startsWith("notebook-source-"))).toBe(true);
    expect(
      sections
        .filter((section) => section.id.startsWith("notebook-source-"))
        .every((section) => section.title.startsWith("Notebook source · ")),
    ).toBe(true);
    const changed = jasmine.createSpy("source metadata changed");
    const lease = editor.onDidChangeMetadata(changed);
    try {
      editor.sourceEditor.setGrammar(lumine.grammars.nullGrammar);
      expect(changed).toHaveBeenCalled();
    } finally {
      lease.dispose();
    }
  });

  it("discards a source metadata read after its item closes and respects aborts", async () => {
    let release;
    spyOn(editor.sourceEditor, "getMetadata").and.returnValue(
      new Promise((resolve) => (release = resolve)),
    );
    const reading = editor.getMetadata();
    editor.destroy();
    release([{ id: "text", title: "Text", rows: [] }]);
    expect(await reading).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expectAsync(editor.getMetadata({ signal: controller.signal })).toBeRejected();
  });
});
