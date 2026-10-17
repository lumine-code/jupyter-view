const etch = require("@lumine-code/etch");
const { NotebookChrome } = require("../lib/notebook-chrome");

// Capture the loading chrome's own import boundary before the full notebook
// view can configure this Etch copy and hide an earlier unscheduled render.
const schedulerAfterChromeLoad = etch.getScheduler();

describe("notebook loading chrome scheduler", () => {
  it("configures the package's Etch copy before the first loading or error render", async () => {
    expect(schedulerAfterChromeLoad).toBe(lumine.views);
    const chrome = new NotebookChrome();
    try {
      await chrome.update({ error: "Notebook could not be loaded" });
      expect(chrome.element.textContent).toBe(
        "Failed to load notebook: Notebook could not be loaded",
      );
      expect(etch.getScheduler()).toBe(lumine.views);
    } finally {
      chrome.destroy();
    }
  });
});
