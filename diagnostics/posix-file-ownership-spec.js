const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform === "linux")
  describe("native POSIX file ownership", () => {
    let main, directory, editors, ImageNavigator;

    beforeEach(async () => {
      for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
        spyOn(lumine.shell, method).and.resolveTo();
      spyOn(lumine.application, "openWindow").and.resolveTo();
      for (const name of ["language-json", "language-python", "language-text"])
        await (
          await lumine.packages.activatePackage(name)
        ).resourceLoadPromise;
      main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
      const imageRoot = process.env.LUMINE_TEST_IMAGE_EDITOR_PATH;
      if (!imageRoot || !path.isAbsolute(imageRoot))
        throw new Error("Owned Image Editor checkout required");
      ImageNavigator = require(path.join(imageRoot, "lib/navigation"));
      directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "posix-ownership-owned-")));
      editors = [];
    });

    afterEach(async () => {
      for (const editor of editors) editor.destroy();
      await lumine.packages.deactivatePackage("jupyter-view");
      await lumine.fileWatchClient.settlePendingTeardown();
      const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Unsafe POSIX scratch");
      fs.rmSync(directory, { recursive: true, force: true });
      main = directory = editors = ImageNavigator = null;
    });

    function notebook(name, source) {
      const file = path.join(directory, name);
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              id: "owned",
              cell_type: "code",
              source: [source],
              metadata: {},
              outputs: [],
              execution_count: null,
            },
          ],
        }),
      );
      return file;
    }

    async function open(file) {
      const editor = await main.openNotebook(file);
      editors.push(editor);
      await lumine.workspace.open(editor);
      await editor._sourceEditorSetupPromise;
      return editor;
    }

    it("opens two case-distinct notebook files as their own documents", async () => {
      const upper = notebook("A.ipynb", "upper source");
      const lower = notebook("a.ipynb", "lower source");
      expect(fs.statSync(upper).ino).not.toBe(fs.statSync(lower).ino);
      const first = await open(upper);
      const second = await open(lower);
      expect(second.getPath()).toBe(lower);
      expect(second.document).not.toBe(first.document);
      expect(second.document.getCell(0).source).toBe("lower source");
    });

    it("locates both case-distinct image filenames in the native folder listing", async () => {
      const upper = path.join(directory, "A.png");
      const lower = path.join(directory, "a.png");
      fs.writeFileSync(upper, "owned upper listing entry");
      fs.writeFileSync(lower, "owned lower listing entry");
      expect(fs.statSync(upper).ino).not.toBe(fs.statSync(lower).ino);
      const navigator = new ImageNavigator();
      const first = await navigator.getFileList(upper);
      const second = await navigator.getFileList(lower);
      expect(first.files[first.currentIndex]).toBe(upper);
      expect(second.files[second.currentIndex]).toBe(lower);
    });

    it("keeps ordinary distinct notebook and image filenames", async () => {
      const first = await open(notebook("first.ipynb", "first source"));
      const second = await open(notebook("second.ipynb", "second source"));
      expect(second.document).not.toBe(first.document);
      expect(second.document.getCell(0).source).toBe("second source");
      const image = path.join(directory, "first.png");
      fs.writeFileSync(image, "owned ordinary listing entry");
      const listing = await new ImageNavigator().getFileList(image);
      expect(listing.files[listing.currentIndex]).toBe(image);
    });
  });
