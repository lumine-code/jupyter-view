// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [
    "language-python",
    "jupyter-cells",
    "jupyter-repl",
    "marker",
    "linter",
    "documentation-view",
    "hover",
    "ide",
    "ide-basedpyright",
  ],
  viewport: { width: 1200, height: 950 },
  async before(context) {
    const { lumine } = context;
    lumine.config.set("ide-basedpyright.pythonPath", process.env.LUMINE_DEMO_PYTHON || "python");
    for (const name of ["ide-basedpyright", "linter"])
      if (lumine.packages.isPackageActive(name)) await lumine.packages.deactivatePackage(name);
  },
  async prepare(context) {
    const { lumine, state, fixture, open, profile } = context;
    state.jupyterData = require("path").join(profile, "jupyter");
    const kernel = require("path").join(state.jupyterData, "kernels", "lumine-demo");
    require("fs").mkdirSync(kernel, { recursive: true });
    require("fs").writeFileSync(
      require("path").join(kernel, "kernel.json"),
      JSON.stringify({
        argv: [
          process.env.LUMINE_DEMO_PYTHON || "python",
          "-m",
          "ipykernel_launcher",
          "-f",
          "{connection_file}",
        ],
        display_name: "Python 3",
        language: "python",
      }),
    );
    state.editor = await open("jupyter/signal.py");
    await lumine.project.setPaths([fixture("jupyter")]);
    process.env.JUPYTER_PATH = state.jupyterData;
    lumine.grammars.assignLanguageMode(state.editor.getBuffer(), "source.python");
    await state.editor.getBuffer().getLanguageMode().ready;
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption:
        "Basedpyright underlines a type error inside a notebook cell and explains it in a hover.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor, fixture } = context;
        {
          state.editor.selectAll();
          lumine.commands.dispatch(lumine.views.getView(state.editor), "jupyter-repl:run");
          await waitFor(
            () => document.body.innerText.includes("Mean amplitude: 0.42"),
            "step 1",
            60000,
          );
        }
        {
          state.document = await lumine.workspace.open(fixture("jupyter/signal.ipynb"));
          lumine.commands.dispatch(lumine.views.getView(state.document), "jupyter-view:run-all");
          await waitFor(() => document.body.innerText.includes("Average: 0.42"), "step 2", 60000);
          await waitFor(
            () =>
              document.querySelector(".jupyter-notebook img")?.naturalWidth > 0 &&
              !document.querySelector(".jupyter-notebook .jupyter-cell.running"),
            "completed notebook plot",
            90000,
          );
        }
        {
          for (let n = 0; n < 50; n++) {
            const messages = lumine.packages
              .getActivePackage("linter")
              .mainModule.provideMcpTools()[0]
              .execute({ filePath: state.document.getPath() }).messages;
            if (
              messages.some(
                (m) =>
                  m.linterName === "Basedpyright Language Server" && m.excerpt.includes("float"),
              )
            )
              break;
            await new Promise((r) => setTimeout(r, 500));
          }
          state.cell = state.document.getCellEditorById("analysis");
          if (!state.cell) throw new Error("Missing live notebook cell editor");
          state.document.setActiveCell(1);
          state.cell.setCursorBufferPosition([3, 21]);
        }
      },
      async afterPointerMove(context) {
        const { lumine, state } = context;
        await lumine.packages
          .getActivePackage("hover")
          .mainModule.getManager(lumine.workspace.getMainWindow())
          .showHoverOverlay(state.cell, new (require("lumine").Point)(3, 21), { gutter: true });
      },
      ready() {
        return Boolean(
          document.querySelector("lumine-overlay.hover-overlay")?.innerText.includes("float") &&
          document.body.innerText.includes("Average: 0.42") &&
          document.querySelector(".jupyter-notebook img")?.naturalWidth > 0 &&
          !document.querySelector(".jupyter-notebook .jupyter-cell.running"),
        );
      },
    },
  ],
  async cleanup() {},
};
