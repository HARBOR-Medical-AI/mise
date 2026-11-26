import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { CubeVfsDispatcher } from "../src/vfs/dispatcher.js";
import { NativeVfsProvider } from "../src/vfs/providers/native.js";
import { PacsVfsProvider } from "../src/vfs/providers/pacs.js";
import { Result, Ok } from "@fnndsc/cumin";
import { VFSItem } from "../src/vfs/provider.js";

describe("VFSDispatcher Path Resolution Hook", () => {
  let dispatcher: CubeVfsDispatcher;
  let listSpy: any;
  let cpSpy: any;

  beforeEach(() => {
    dispatcher = new CubeVfsDispatcher();
    listSpy = jest.spyOn(NativeVfsProvider.prototype, "list").mockResolvedValue(
      Ok<VFSItem[]>([
        {
          name: "data.txt",
          type: "file",
          size: 100,
          owner: "rudolph",
          date: "2026-05-27T00:00:00Z",
        },
      ])
    );
    cpSpy = jest.spyOn(NativeVfsProvider.prototype, "cp").mockResolvedValue({ ok: true, value: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should list using original path when no pathResolver is registered", async () => {
    const res = await dispatcher.list("/home/rudolph/public");
    expect(res.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledWith("/home/rudolph/public", undefined);
  });

  it("should map logical to physical path via registered resolver for list()", async () => {
    dispatcher.pathResolver_register(async (logicalPath: string): Promise<string> => {
      if (logicalPath === "/home/rudolph/public") {
        return "/PUBLIC";
      }
      return logicalPath;
    });

    const res = await dispatcher.list("/home/rudolph/public");
    expect(res.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledWith("/PUBLIC", undefined);
  });

  it("should fall back cleanly to original path if resolver throws", async () => {
    dispatcher.pathResolver_register(async (): Promise<string> => {
      throw new Error("Resolution failed");
    });

    const res = await dispatcher.list("/home/rudolph/public");
    expect(res.ok).toBe(true);
    expect(listSpy).toHaveBeenCalledWith("/home/rudolph/public", undefined);
  });

  it("should map paths in cp() using registered resolver", async () => {
    dispatcher.pathResolver_register(async (logicalPath: string): Promise<string> => {
      if (logicalPath === "/home/rudolph/public/file.txt") {
        return "/PUBLIC/file.txt";
      }
      if (logicalPath === "/home/rudolph/shared/file.txt") {
        return "/SHARED/file.txt";
      }
      return logicalPath;
    });

    const success = await dispatcher.cp(
      "/home/rudolph/public/file.txt",
      "/home/rudolph/shared/file.txt",
      {}
    );
    expect(success.ok).toBe(true);
    expect(cpSpy).toHaveBeenCalledWith(
      "/PUBLIC/file.txt",
      "/SHARED/file.txt",
      {}
    );
  });

  it("hands a copy out of PACS into a feed folder to the PACS mount, the destination resolved as a CUBE path", async () => {
    const pacsCp = jest.spyOn(PacsVfsProvider.prototype, "cp").mockResolvedValue({ ok: true, value: true });
    dispatcher.pathResolver_register(async (logicalPath: string): Promise<string> => (logicalPath === "/home/rudolph/feed" ? "/home/rudolph/feeds/feed_7" : logicalPath));

    expect(new PacsVfsProvider().copiesOut).toBe(true);
    expect((await dispatcher.cp("/net/pacs/queries/q1", "/home/rudolph/feed", {})).ok).toBe(true);
    expect(pacsCp).toHaveBeenCalledWith("/net/pacs/queries/q1", "/home/rudolph/feeds/feed_7", {});
    expect(cpSpy).not.toHaveBeenCalled();
  });

  it("refuses a copy from a CUBE folder onto a projection, and one out of a mount that offers none", async () => {
    const pacsCp = jest.spyOn(PacsVfsProvider.prototype, "cp").mockResolvedValue({ ok: true, value: true });

    expect(await dispatcher.cp("/home/rudolph/a.txt", "/etc/a.txt", {})).toMatchObject({ ok: false, errno: "EXDEV" });
    expect(await dispatcher.cp("/etc/cube.json", "/home/rudolph/cube.json", {})).toMatchObject({ ok: false, errno: "EXDEV" });
    expect(await dispatcher.cp("/home/rudolph/a.txt", "/proc", {})).toMatchObject({ ok: false, errno: "EXDEV" });
    expect(await dispatcher.cp("/net/pacs/queries/q1", "/net", {})).toMatchObject({ ok: false, errno: "EXDEV" });
    expect(cpSpy).not.toHaveBeenCalled();
    expect(pacsCp).not.toHaveBeenCalled();
  });
});
