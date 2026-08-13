const NotebookDocumentRegistry = require("../lib/notebook-document-registry");

// The registry is observable so a consumer — ide-jupyter feeding notebooks to
// language servers — can follow documents opening and closing instead of
// polling. Registration precedes loading, so a document arrives live and fills
// in through its own events.
describe("NotebookDocumentRegistry observation", () => {
  let registry;

  beforeEach(() => {
    registry = new NotebookDocumentRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it("replays current documents and reports later ones through observeDocuments", async () => {
    const first = await registry.createUntitledDocument();

    const seen = [];
    const subscription = registry.observeDocuments((document) => seen.push(document));
    expect(seen).toEqual([first]);

    const second = await registry.createUntitledDocument();
    expect(seen).toEqual([first, second]);

    subscription.dispose();
    await registry.createUntitledDocument();
    expect(seen).toEqual([first, second]);
  });

  it("reports a destroyed document through onDidRemoveDocument", async () => {
    const removed = [];
    registry.onDidRemoveDocument((document) => removed.push(document));

    const document = await registry.createUntitledDocument();
    expect(removed).toEqual([]);

    document.destroy();
    expect(removed).toEqual([document]);
    expect(registry.getDocuments()).toEqual([]);
  });

  it("hands every split view's editor back through the service facade", async () => {
    const main = require("../lib/main");
    const document = await registry.createUntitledDocument();
    const facade = main.provideJupyterNotebook();
    // No notebook editors are open in this spec window; the facade answers
    // with an empty list rather than throwing.
    expect(facade.getNotebookEditors(document)).toEqual([]);
  });
});
