const { TextBuffer } = require("lumine");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("notebook source JSON codec", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.unlinkSync(path.join(directory, "text.json"));
      fs.rmdirSync(directory);
    }
  });
  const codec = () => require("../lib/notebook-json");
  const root = (text) => {
    const buffer = new TextBuffer(text);
    const source = buffer.getTextSnapshot();
    buffer.destroy();
    return source;
  };
  const plain = (value) => {
    if (value && typeof value.subtext === "function") return value.toString();
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
    return value;
  };

  it("matches native boxed primitives, toJSON keys, omissions and sparse array values", async () => {
    function values() {
      const callable = () => {};
      callable.toJSON = (key) => `function:${key}`;
      const number = new Number(2);
      number.valueOf = () => 7;
      const string = new String("initial");
      string.toString = () => "converted";
      const array = [undefined, () => {}, Symbol("x")];
      array.length++;
      array.push({
        toJSON(key) {
          return key;
        },
      });
      return {
        number,
        string,
        boolean: new Boolean(false),
        date: new Date("2020-01-02T03:04:05Z"),
        invalidDate: new Date(NaN),
        nan: NaN,
        infinity: Infinity,
        negativeZero: -0,
        omit: {
          toJSON() {
            return undefined;
          },
        },
        callable,
        nested: {
          toJSON(key) {
            return {
              key,
              answer: 42,
              toJSON() {
                return "wrong second invocation";
              },
            };
          },
        },
        absent: undefined,
        functionValue() {},
        symbol: Symbol("omitted"),
        array,
      };
    }
    const expected = JSON.parse(JSON.stringify(values()));
    expect(JSON.parse((await codec().stringifySource(values())).toString())).toEqual(expected);
    expect(
      JSON.parse((await codec().stringifySource(codec().captureValue(values()))).toString()),
    ).toEqual(expected);
    expect(await codec().stringifySource(undefined)).toBeUndefined();
    expect(codec().stringifySmall(new String("x".repeat(200000)))).toBeNull();
    await expectAsync(codec().stringifySource({ bigint: Object(1n) })).toBeRejectedWithError(
      TypeError,
    );
  });

  it("does not inspect unrelated non-enumerable metadata accessors while recognizing sources", async () => {
    const metadata = { ordinary: true };
    Object.defineProperty(metadata, "chunks", {
      get() {
        throw new Error("Not a text source");
      },
    });
    expect(JSON.parse((await codec().stringifySource({ metadata })).toString())).toEqual({
      metadata: { ordinary: true },
    });
    expect(codec().captureValue({ metadata })).toEqual({ metadata: { ordinary: true } });
  });

  it("captures repeated getters independently and retains immutable source roots", async () => {
    let count = 0;
    const shared = {
      get value() {
        return ++count;
      },
    };
    const source = root("old source");
    const input = { a: shared, b: shared, cells: [{ source }], metadata: { state: "old" } };
    const captured = codec().captureValue(input);
    input.metadata.state = "new";
    expect(captured.a.value).toBe(1);
    expect(captured.b.value).toBe(2);
    expect(captured.cells[0].source).toBe(source);
    expect(JSON.parse((await codec().stringifySource(captured)).toString()).metadata.state).toBe(
      "old",
    );
  });

  it("round trips source arrays, escapes, CRLF, split Unicode and lone surrogates", async () => {
    const text = "a".repeat(32767) + '\ud83d\ude00\r\n\r\t\0\\"\ud800x\udc00';
    const first = root(text.slice(0, 32768));
    const source = first.replace(first.length, first.length, text.slice(32768));
    const input = {
      cells: [{ source }, { source: [source.subtext(0, 32768), source.subtext(32768)] }],
      metadata: { source: ["ordinary", 42] },
    };
    const encoded = await codec().stringifySource(input, { lineEnding: "\r\n" });
    const native = JSON.parse(encoded.toString());
    expect(native.cells[0].source).toBe(text);
    expect(native.cells[1].source.join("")).toBe(text);
    const decoded = await codec().parseSource(encoded);
    expect(decoded.cells[0].source.toString()).toBe(text);
    expect(decoded.cells[1].source.map((part) => part.toString()).join("")).toBe(text);
    expect(decoded.metadata.source).toEqual(["ordinary", 42]);
    expect(plain(await codec().parseSource('{"__proto__":{"safe":true},"a":1,"a":2}'))).toEqual(
      JSON.parse('{"__proto__":{"safe":true},"a":1,"a":2}'),
    );
  });

  it("handles sparse sources beyond the runtime string limit without flattening", async () => {
    jasmine.useRealClock();
    let source = root("a".repeat(32768));
    while (source.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
      source = source.replace(source.length, source.length, source);
    const cache = new WeakMap();
    const encoded = await codec().stringifySource({ cells: [{ source }] }, { cache, indent: 0 });
    expect(encoded.length).toBeGreaterThan(source.length);
    expect(encoded.slice(0, 21)).toBe('{"cells":[{"source":"');
    const decoded = await codec().parseSource(encoded);
    expect(decoded.cells[0].source.length).toBe(source.length);
    expect(decoded.cells[0].source.equals(source)).toBe(true);
    expect(codec().stringifySmall({ cells: [{ source }] })).toBeNull();
  }, 15000);

  it("keeps source chunk counts outside the metadata value budget", async () => {
    jasmine.useRealClock();
    const json = root('{"cells":[{"source":[' + '"",'.repeat(1000000) + '"x"]}]}');
    const decoded = await codec().parseSource(json);
    expect(decoded.cells[0].source[0].toString()).toBe("x");
  }, 15000);

  it("rejects invalid source types and malformed JSON without partial results", async () => {
    for (const source of [null, false, 12, {}, [12], [[]], [{}]])
      await expectAsync(
        codec().parseSource(JSON.stringify({ cells: [{ source }] })),
      ).toBeRejectedWithError(SyntaxError);
    for (const text of [
      "",
      "[1,]",
      '{"a":1,}',
      '{"a" 1}',
      '"\\u12x4"',
      '"\\x20"',
      '"unterminated',
      '"a\nb"',
      "true false",
      "01",
      "1.",
      "NaN",
      "[}",
    ])
      await expectAsync(codec().parseSource(text)).toBeRejectedWithError(SyntaxError);
    const hugeNumber = '{"number":1' + "0".repeat(10000) + "}";
    expect(await codec().parseSource(hugeNumber)).toEqual(JSON.parse(hugeNumber));
  });

  it("enforces metadata/depth and encoder option budgets explicitly", async () => {
    let deep = {};
    for (let i = 0; i < 260; i++) deep = { next: deep };
    expect(() => codec().captureValue(deep)).toThrowMatching(
      (error) => error.code === "ERR_NOTEBOOK_METADATA_LIMIT",
    );
    await expectAsync(
      codec().stringifySource({ metadata: "x".repeat(32 * 1024 * 1024 + 1) }),
    ).toBeRejectedWith(jasmine.objectContaining({ code: "ERR_NOTEBOOK_METADATA_LIMIT" }));
    for (const options of [
      { indent: -1 },
      { indent: 11 },
      { indent: 1.5 },
      { lineEnding: "bad" },
      { sortKeys: "yes" },
      { cache: new Map() },
    ])
      await expectAsync(codec().stringifySource({}, options)).toBeRejectedWithError(TypeError);
    const cyclic = {};
    cyclic.self = cyclic;
    await expectAsync(codec().stringifySource(codec().captureValue(cyclic))).toBeRejectedWithError(
      TypeError,
    );
  });

  it("cancels encoding, decoding and file reads while preserving input", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = root("a".repeat(200000));
    await expectAsync(
      codec().stringifySource({ cells: [{ source }] }, { signal: controller.signal }),
    ).toBeRejected();
    await expectAsync(
      codec().parseSource('{"cells":[{"source":"a"}]}', { signal: controller.signal }),
    ).toBeRejected();
    let checks = 0;
    const encoded = await codec().stringifySource({ cells: [{ source }] });
    await expectAsync(
      codec().parseSource(encoded, { isCurrent: () => ++checks < 4 }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-notebook-json-")),
      file = path.join(directory, "text.json");
    const text = "a".repeat(65535) + "😀é\r\n";
    directories.push(directory);
    fs.writeFileSync(file, text);
    expect((await codec().readFileSource(file)).toString()).toBe(text);
    await expectAsync(codec().readFileSource(file, { signal: controller.signal })).toBeRejected();
    expect(source.length).toBe(200000);
  });
});
