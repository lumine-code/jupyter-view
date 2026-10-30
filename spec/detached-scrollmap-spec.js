describe("Notebook scrollbar measurement across windows", () => {
  let map, frames, registration;

  afterEach(async () => {
    map?.destroy();
    registration?.dispose();
    frames?.destroy();
    await lumine.workspace.discardEditorWindows();
  });

  it("rebinds its resize observer after its notebook presentation is adopted", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const element = document.createElement("div");
    const cellsContainer = document.createElement("div");
    element.append(cellsContainer);
    const item = { element, getTitle: () => "Notebook measurement" };
    await lumine.workspace.open(item);
    const PresentationFrames = require("../lib/presentation-frames");
    frames = new PresentationFrames(element);
    registration = lumine.views.addWindowParticipant(element, frames);
    const editor = {
      view: { element, cellsContainer },
      requestFrame: (callback) => frames.request(callback),
      cancelFrame: (request) => frames.cancel(request),
      observeNavigationHeaders: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
    };
    class Widget {
      constructor() {
        this.element = document.createElement("div");
      }
      setItems() {}
      destroy() {
        this.element.remove();
      }
    }
    const NotebookScrollmap = require("../lib/scrollmap-integration");
    map = new NotebookScrollmap(editor, Widget);
    const observer = map.resizeObserver;
    const disconnect = spyOn(observer, "disconnect").and.callThrough();
    await lumine.workspace.movePaneItem(item, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    expect(disconnect).toHaveBeenCalled();
  });
});
