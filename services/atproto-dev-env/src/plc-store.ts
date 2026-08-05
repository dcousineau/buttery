// File-backed PLC database for the local dev-env.
//
// `@atproto/dev-env` boots its PLC with `plc.Database.mock()`, which keeps every
// operation in memory. That is why the seed account's `did:plc` changed on every
// restart: the DID document lived only in that map, so a reboot left buttery's
// Postgres full of rows keyed to DIDs nothing could resolve any more.
//
// `MockDatabase` already implements the whole `PlcDatabase` interface against a
// public `contents` map, so persistence is just snapshotting that map. We
// subclass it, load the map at boot, and write it back after each accepted
// operation. Registrations are rare (one per account) and the file is tiny, so
// writing the whole snapshot per op is cheaper than any incremental scheme.
//
// Node runs this `.ts` directly (type-stripping) — keep everything erasable
// (no enum/namespace/param-props), and import local files with explicit `.ts`.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MockDatabase } from "@did-plc/server";
import { CID } from "multiformats/cid";
import type * as plc from "@did-plc/lib";

/**
 * On-disk shape. `cid` is a {@link CID} instance in memory and `createdAt` a
 * `Date`; both are flattened to strings here and rehydrated on load, because
 * `validateAndAddOp` compares CIDs with `.equals()` and would silently stop
 * nullifying operations if handed plain strings.
 */
interface StoredOp {
  did: string;
  operation: plc.CompatibleOpOrTombstone;
  cid: string;
  nullified: boolean;
  createdAt: string;
}

interface Snapshot {
  version: 1;
  contents: Record<string, StoredOp[]>;
}

export class FilePlcDatabase extends MockDatabase {
  readonly path: string;
  /** Serializes writes so overlapping registrations cannot interleave. */
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super();
    this.path = path;
  }

  /** Load a snapshot, or start empty when the file does not exist yet. */
  static async open(path: string): Promise<FilePlcDatabase> {
    const db = new FilePlcDatabase(path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return db;
      throw err;
    }
    const snapshot = JSON.parse(raw) as Snapshot;
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported PLC snapshot version ${snapshot.version} at ${path}. Delete the file to start fresh.`);
    }
    for (const [did, ops] of Object.entries(snapshot.contents)) {
      db.contents[did] = ops.map((op) => ({
        did: op.did,
        operation: op.operation,
        cid: CID.parse(op.cid),
        nullified: op.nullified,
        createdAt: new Date(op.createdAt),
      }));
    }
    return db;
  }

  /** Number of DIDs restored — used for the boot banner. */
  get didCount(): number {
    return Object.keys(this.contents).length;
  }

  override async validateAndAddOp(did: string, proposed: plc.OpOrTombstone): Promise<void> {
    await super.validateAndAddOp(did, proposed);
    await this.flush();
  }

  private async flush(): Promise<void> {
    const snapshot: Snapshot = { version: 1, contents: {} };
    for (const [did, ops] of Object.entries(this.contents)) {
      snapshot.contents[did] = ops.map((op) => ({
        did: op.did,
        operation: op.operation,
        cid: op.cid.toString(),
        nullified: op.nullified,
        createdAt: op.createdAt.toISOString(),
      }));
    }
    const body = JSON.stringify(snapshot, null, 2);
    // Write-then-rename so a crash mid-write cannot leave a truncated snapshot
    // that would strand every DID in it.
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.path);
    });
    await this.writing;
  }
}
