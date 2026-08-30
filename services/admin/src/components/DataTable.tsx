import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type OnChangeFn, type SortingState } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { cn } from "#/lib/utils";

/**
 * The one table every list view in the admin uses.
 *
 * It is a **manual** TanStack Table: pagination, sorting and filtering all
 * happen in Postgres, and this component only renders what the server handed
 * back. That is not premature — `atproto_collection_recipe` grows with the
 * network rather than with our users, so a client-side model over "every row"
 * is a page that gets slower every week and eventually stops loading at all.
 *
 * The consequence to remember when adding a column: a column with no entry in
 * the server's sort enum must set `enableSorting: false`, or its header offers a
 * control that silently does nothing.
 */
export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  rows: T[];
  /** Total matching rows in the database, not on this page. */
  total: number;
  pageIndex: number;
  pageSize: number;
  onPageChange: (pageIndex: number) => void;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  isLoading?: boolean;
  emptyMessage?: string;
  /** Row click target. Rendering a link inside a cell stays the accessible path;
   * this is the convenience on top of it, never the only way in. */
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({ columns, rows, total, pageIndex, pageSize, onPageChange, sorting, onSortingChange, isLoading, emptyMessage, onRowClick }: DataTableProps<T>) {
  // React Compiler cannot memoize a hook that returns functions, so it skips
  // memoizing this component. That is the documented cost of TanStack Table's
  // API and it is fine here: every list view re-renders on a query settling
  // anyway, and the rows are a page of 50.
  // oxlint-disable-next-line react/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting: sorting ?? [] },
    onSortingChange,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    getCoreRowModel: getCoreRowModel(),
  });

  const from = total === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min(total, (pageIndex + 1) * pageSize);
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div className="space-y-3">
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const direction = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder ? null : sortable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-2 h-7 px-2"
                          onClick={header.column.getToggleSortingHandler()}
                          // Screen readers get the state that the arrow icon
                          // conveys visually; `aria-sort` on the cell alone does
                          // not reach a button's accessible name.
                          aria-label={`Sort by ${String(header.column.columnDef.header)}${direction === "asc" ? ", currently ascending" : direction === "desc" ? ", currently descending" : ""}`}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {direction === "asc" ? (
                            <ArrowUp className="size-3.5" />
                          ) : direction === "desc" ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ChevronsUpDown className="size-3.5 opacity-50" />
                          )}
                        </Button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {emptyMessage ?? "No rows."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} onClick={onRowClick ? () => onRowClick(row.original) : undefined} className={cn(onRowClick && "cursor-pointer", isLoading && "opacity-60")}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
        <p aria-live="polite">
          {from}–{to} of {total.toLocaleString()}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onPageChange(pageIndex - 1)} disabled={pageIndex <= 0}>
            Previous
          </Button>
          <span>
            Page {pageIndex + 1} of {lastPage + 1}
          </span>
          <Button variant="outline" size="sm" onClick={() => onPageChange(pageIndex + 1)} disabled={pageIndex >= lastPage}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
