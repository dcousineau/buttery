import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "#/config.ts";

/**
 * A Temporal client, for the code that talks to the cluster rather than polls it
 * — `schedules-sync.ts` today.
 *
 * Not the connection the worker uses: `@temporalio/worker` needs a
 * `NativeConnection` (the Rust core's own gRPC channel, which the polling loop
 * lives on), while this is the plain grpc-js one. They are not interchangeable.
 *
 * `withClient` exists because a connection keeps the event loop alive, and a
 * short-lived command that forgets to close one hangs forever after printing its
 * result.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const connection = await Connection.connect({
    address: config.address,
    tls: config.tls,
    apiKey: config.apiKey,
  });
  try {
    return await fn(new Client({ connection, namespace: config.namespace }));
  } finally {
    await connection.close();
  }
}
