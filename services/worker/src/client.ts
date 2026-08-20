import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "#/config.ts";

/**
 * A Temporal client for the processes that *talk to* the cluster rather than
 * poll it: `run-once.ts` and `schedules-sync.ts`.
 *
 * Deliberately not the connection the worker uses. `@temporalio/worker` needs a
 * `NativeConnection` (the Rust core's own gRPC channel, which the polling loop
 * lives on); a `Connection` here is the plain grpc-js one. They are not
 * interchangeable, and sharing one would mean either the CLI dragging in the
 * native worker or the worker polling through JavaScript.
 *
 * `withClient` exists because a Temporal connection keeps the event loop alive.
 * A short-lived command that forgets to close one hangs forever after printing
 * its result, which is a maddening way to learn about it.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { temporal } = loadConfig();
  const connection = await Connection.connect({
    address: temporal.address,
    tls: temporal.tls,
    apiKey: temporal.apiKey,
  });
  try {
    return await fn(new Client({ connection, namespace: temporal.namespace }));
  } finally {
    await connection.close();
  }
}
