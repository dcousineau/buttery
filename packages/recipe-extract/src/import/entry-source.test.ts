import { describe, expect, it } from "vitest";
import { directoryEntrySource, EntrySourceError, MAX_ENTRIES, MAX_TOTAL_BYTES, memoryEntrySource, normalizeEntryPath } from "./entry-source.ts";
import { isParseFailure, type DroppedFile, type ImportCandidate, type ImportParseFailure } from "./types.ts";

/**
 * A picker-shaped drop: `<input type="file" webkitdirectory>` fills in
 * `File.webkitRelativePath`, and the route copies it onto `DroppedFile.path`.
 */
function pickerFile(path: string, content = "x"): DroppedFile {
  const file = new File([content], path.split("/").at(-1) ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path, configurable: true });
  return { path, file };
}

/**
 * A drag-shaped drop: `FileSystemFileEntry.file()` hands back a `File` whose
 * `webkitRelativePath` is `""`, and the path exists only in what the traversal
 * accumulated. This is the D40 shape.
 */
function dragFile(path: string, content = "x"): DroppedFile {
  const file = new File([content], path.split("/").at(-1) ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: "", configurable: true });
  return { path, file };
}

/** A `File` whose reported `size` is a fiction, so the byte cap can be exercised without
 *  allocating 200 MB in a unit test. `totalBytes()` only ever reads `File.size`. */
function sizedFile(path: string, size: number): DroppedFile {
  const { file } = dragFile(path);
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return { path, file };
}

/** Wraps the two read methods with counters so "constructing reads nothing" is provable. */
function spyFile(path: string, content: string): { entry: DroppedFile; calls: { text: number; arrayBuffer: number } } {
  const entry = dragFile(path, content);
  const calls = { text: 0, arrayBuffer: 0 };
  const realText = entry.file.text.bind(entry.file);
  const realArrayBuffer = entry.file.arrayBuffer.bind(entry.file);
  Object.defineProperty(entry.file, "text", {
    value: () => {
      calls.text += 1;
      return realText();
    },
    configurable: true,
  });
  Object.defineProperty(entry.file, "arrayBuffer", {
    value: () => {
      calls.arrayBuffer += 1;
      return realArrayBuffer();
    },
    configurable: true,
  });
  return { entry, calls };
}

describe("normalizeEntryPath", () => {
  it("collapses duplicate slashes and drops '.' segments", () => {
    expect(normalizeEntryPath("My Recipes//Recipes/./Foo.html")).toBe("My Recipes/Recipes/Foo.html");
    expect(normalizeEntryPath("a/b/")).toBe("a/b");
  });

  it("resolves '..' that stays inside the root — the <img src> case the Paprika walker needs", () => {
    expect(normalizeEntryPath("My Recipes/Recipes/../Images/u/u.jpg")).toBe("My Recipes/Images/u/u.jpg");
  });

  it("rejects a leading '..'", () => {
    expect(() => normalizeEntryPath("../x")).toThrowError(EntrySourceError);
    expect(() => normalizeEntryPath("../x")).toThrowError(/escapes the root/);
  });

  it("rejects an interior '..' run that walks past the root", () => {
    expect(() => normalizeEntryPath("a/../../b")).toThrowError(EntrySourceError);
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeEntryPath("/abs")).toThrowError(/Absolute entry path/);
    expect(() => normalizeEntryPath("\\\\server\\share")).toThrowError(/Absolute entry path/);
  });

  it("rejects a Windows drive-letter path", () => {
    expect(() => normalizeEntryPath("C:/Users/x/My Recipes/index.html")).toThrowError(/Absolute entry path/);
  });

  it("reports 'path_escape' as the code, so the UI can pick copy without matching a message", () => {
    try {
      normalizeEntryPath("../x");
      expect.unreachable();
    } catch (err) {
      expect((err as EntrySourceError).code).toBe("path_escape");
    }
  });
});

describe("directoryEntrySource", () => {
  it("maps DroppedFile.path onto paths() for a picker-shaped drop", () => {
    const source = directoryEntrySource([pickerFile("My Recipes/index.html"), pickerFile("My Recipes/Recipes/Beef Bourguignon.html")]);
    expect([...source.paths()].sort()).toEqual(["My Recipes/Recipes/Beef Bourguignon.html", "My Recipes/index.html"]);
  });

  it("maps DroppedFile.path onto paths() for a drag-shaped drop, whose File has no webkitRelativePath (D40)", () => {
    const dropped = [dragFile("My Recipes/index.html"), dragFile("My Recipes/Recipes/Arroz con Pollo.html")];
    // The regression this guards: reducing the input to File[] and reading
    // webkitRelativePath would yield two empty paths here.
    expect(dropped.map((d) => (d.file as File & { webkitRelativePath: string }).webkitRelativePath)).toEqual(["", ""]);

    const source = directoryEntrySource(dropped);
    expect([...source.paths()].sort()).toEqual(["My Recipes/Recipes/Arroz con Pollo.html", "My Recipes/index.html"]);
  });

  it("normalizes the stored paths and accepts an un-normalized lookup", async () => {
    const source = directoryEntrySource([pickerFile("Outer//My Recipes/./Recipes/Foo.html", "<h1>Foo</h1>")]);
    expect(source.paths()).toEqual(["Outer/My Recipes/Recipes/Foo.html"]);
    await expect(source.text("Outer/My Recipes/Recipes/../Recipes/Foo.html")).resolves.toBe("<h1>Foo</h1>");
  });

  it("reads nothing at construction — File handles stay lazy", async () => {
    const a = spyFile("My Recipes/Recipes/A.html", "<h1>A</h1>");
    const b = spyFile("My Recipes/Recipes/B.html", "<h1>B</h1>");

    const source = directoryEntrySource([a.entry, b.entry]);
    source.paths();
    source.totalBytes();
    expect(a.calls).toEqual({ text: 0, arrayBuffer: 0 });
    expect(b.calls).toEqual({ text: 0, arrayBuffer: 0 });

    await expect(source.text("My Recipes/Recipes/A.html")).resolves.toBe("<h1>A</h1>");
    expect(a.calls).toEqual({ text: 1, arrayBuffer: 0 });
    expect(b.calls).toEqual({ text: 0, arrayBuffer: 0 }); // still untouched

    await expect(source.bytes("My Recipes/Recipes/B.html")).resolves.toEqual(new TextEncoder().encode("<h1>B</h1>"));
    expect(b.calls).toEqual({ text: 0, arrayBuffer: 1 });
  });

  it("sums File.size for totalBytes without reading any content", () => {
    const source = directoryEntrySource([sizedFile("a.html", 10), sizedFile("b.html", 32)]);
    expect(source.totalBytes()).toBe(42);
  });

  it("rejects — never throws synchronously — for an entry it does not hold", async () => {
    const source = directoryEntrySource([pickerFile("My Recipes/index.html")]);
    await expect(source.bytes("My Recipes/Images/nope.jpg")).rejects.toThrowError(/No such entry/);
    await expect(source.text("My Recipes/Recipes/nope.html")).rejects.toThrowError(/No such entry/);
  });

  it("rejects an entry whose path escapes the root", () => {
    expect(() => directoryEntrySource([pickerFile("My Recipes/index.html"), pickerFile("../../etc/passwd")])).toThrowError(EntrySourceError);
  });

  it("rejects more than MAX_ENTRIES entries", () => {
    const files = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => sizedFile(`Recipes/${i}.html`, 1));
    try {
      directoryEntrySource(files);
      expect.unreachable();
    } catch (err) {
      expect((err as EntrySourceError).code).toBe("too_many_entries");
    }
  });

  it("rejects a total larger than MAX_TOTAL_BYTES", () => {
    const half = MAX_TOTAL_BYTES / 2;
    try {
      directoryEntrySource([sizedFile("a.bin", half), sizedFile("b.bin", half), sizedFile("c.bin", 1)]);
      expect.unreachable();
    } catch (err) {
      expect((err as EntrySourceError).code).toBe("too_large");
    }
  });

  it("accepts a total exactly at MAX_TOTAL_BYTES", () => {
    const source = directoryEntrySource([sizedFile("a.bin", MAX_TOTAL_BYTES)]);
    expect(source.totalBytes()).toBe(MAX_TOTAL_BYTES);
  });
});

describe("memoryEntrySource", () => {
  it("round-trips text and bytes for both string and Uint8Array entries", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const source = memoryEntrySource(
      new Map<string, string | Uint8Array>([
        ["My Recipes/Recipes/Foo.html", "<h1>Foo</h1>"],
        ["My Recipes/Recipes/Images/u/u.jpg", jpeg],
      ]),
    );

    await expect(source.text("My Recipes/Recipes/Foo.html")).resolves.toBe("<h1>Foo</h1>");
    await expect(source.bytes("My Recipes/Recipes/Images/u/u.jpg")).resolves.toEqual(jpeg);
    await expect(source.bytes("My Recipes/Recipes/Foo.html")).resolves.toEqual(new TextEncoder().encode("<h1>Foo</h1>"));
  });

  it("counts UTF-8 bytes, not code units, in totalBytes", () => {
    const source = memoryEntrySource(new Map([["a.txt", "é"]]));
    expect(source.totalBytes()).toBe(2);
  });

  it("runs the same path-escape guard as directoryEntrySource", () => {
    expect(() => memoryEntrySource(new Map([["a/../../b.html", ""]]))).toThrowError(EntrySourceError);
    expect(() => memoryEntrySource(new Map([["/abs.html", ""]]))).toThrowError(EntrySourceError);
  });

  it("runs the same entry-count guard as directoryEntrySource", () => {
    const entries = new Map(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [`Recipes/${i}.html`, ""] as const));
    try {
      memoryEntrySource(entries);
      expect.unreachable();
    } catch (err) {
      expect((err as EntrySourceError).code).toBe("too_many_entries");
    }
  });

  it("rejects — never throws synchronously — for an entry it does not hold", async () => {
    const source = memoryEntrySource(new Map([["a.html", "x"]]));
    await expect(source.text("b.html")).rejects.toThrowError(/No such entry/);
    await expect(source.bytes("b.html")).rejects.toThrowError(/No such entry/);
  });
});

describe("isParseFailure", () => {
  it("discriminates on the explicit kind tag", () => {
    const failure: ImportParseFailure = { kind: "failure", clientId: "1", entryName: "Foo.html", message: "no recipe markup" };
    const candidate = { kind: "candidate", clientId: "2", entryName: "Bar.html" } as unknown as ImportCandidate;

    expect(isParseFailure(failure)).toBe(true);
    expect(isParseFailure(candidate)).toBe(false);
  });
});
