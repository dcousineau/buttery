// `services/worker/.env`, loaded exactly once for the whole process.
//
// This lives in its own module — rather than at the top of `config.ts` — because
// more than one module needs the file to have been read before it runs, and ESM
// evaluation order is decided by the import graph, not by the order a file lists
// its imports. Any module that reads `process.env` imports this one; whichever
// of them is evaluated first pulls the file in, and the rest get the cached
// module.
//
// Resolved relative to this file, not the cwd, so a run from the repo root
// behaves the same — `process.loadEnvFile()` does NOT walk up looking for one.
// Absent on Railway, where the platform's environment stands alone, and an
// already-set variable always wins because loadEnvFile never overwrites.
//
// Note what does NOT import this: anything under a `workflow.ts`. Workflow code
// runs in a deterministic sandbox with no `process` at all, and reading the
// environment from it would be a replay hazard even if it were possible.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file present — rely on the ambient environment.
}

// Nothing to export: importing this module for its side effect is the point.
// The empty export keeps it an ES module rather than a script.
export {};
