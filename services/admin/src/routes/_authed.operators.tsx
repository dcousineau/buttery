import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { absoluteTime, count, relativeTime } from "#/lib/format";
import { listOperators } from "#/server/operators";

/**
 * Who can get into this tool. Read-only: minting and revoking happen from a
 * shell, because the first write surface an internal tool should grow is not
 * the one that hands out access to itself.
 */
const operatorsQuery = queryOptions({ queryKey: ["operators"], queryFn: () => listOperators() });

export const Route = createFileRoute("/_authed/operators")({
  loader: ({ context }) => context.queryClient.ensureQueryData(operatorsQuery),
  component: Operators,
});

function Operators() {
  const { data } = useSuspenseQuery(operatorsQuery);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operators"
        description={
          <>
            Accounts in <code className="font-mono text-xs">admin.admin_user</code>. Entirely separate from the app&rsquo;s <code className="font-mono text-xs">public.user</code> —
            an operator here is not a Buttery account and vice versa.
          </>
        }
      />

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Active sessions</TableHead>
              <TableHead>Last session</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((operator) => (
              <TableRow key={operator.id}>
                <TableCell className="text-sm">{operator.name}</TableCell>
                <TableCell className="text-sm">{operator.email}</TableCell>
                <TableCell>
                  <Badge variant="outline">{operator.role}</Badge>
                </TableCell>
                <TableCell>
                  {operator.disabled_at ? (
                    <Badge variant="destructive" title={absoluteTime(operator.disabled_at)}>
                      disabled
                    </Badge>
                  ) : (
                    <Badge variant="secondary">active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm">{count(operator.activeSessions)}</TableCell>
                <TableCell className="text-sm" title={absoluteTime(operator.lastSessionAt)}>
                  {relativeTime(operator.lastSessionAt)}
                </TableCell>
                <TableCell className="text-sm" title={absoluteTime(operator.createdAt)}>
                  {relativeTime(operator.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Managing operators</CardTitle>
          <CardDescription>Both operations need shell access to the database. Neither has a button here, on purpose.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Create:{" "}
            <code className="font-mono text-xs">pnpm --filter @buttery/admin admin:create --email you@example.com --password &apos;…&apos; --name &apos;Your Name&apos;</code>
          </p>
          <p>
            Revoke: <code className="font-mono text-xs">update admin.admin_user set disabled_at = now() where email = &apos;…&apos;;</code> — takes effect on their next request,
            not when their session expires.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
