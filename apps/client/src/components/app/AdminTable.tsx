"use client";

import { Select } from "@/components/ui/Select";
import { useState, type ReactNode } from "react";
import { Empty, ErrorState, Pager, SkeletonRows, useDebounced } from "@/components/ui/primitives";
import { useAdminListQuery } from "@/store/api";

export type Row = Record<string, unknown>;

export interface Column {
  label: string;
  right?: boolean;
  render: (r: Row) => ReactNode;
}

export function AdminTable({
  resource,
  columns,
  filters,
  searchable,
  onRowClick,
}: {
  resource: string;
  columns: Column[];
  filters?: { key: string; label: string; options: [string, string][] }[];
  searchable?: boolean;
  onRowClick?: (r: Row) => void;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 350);
  const [values, setValues] = useState<Record<string, string>>({});
  const params: Record<string, string | number | undefined> = { page, limit: 25, search: searchable && q ? q : undefined };
  for (const [k, v] of Object.entries(values)) if (v) params[k] = v;
  const { data, isLoading, isFetching, isError, error, refetch } = useAdminListQuery({ resource, params });

  return (
    <>
      {searchable || filters?.length ? (
        <div className="toolbar">
          {searchable ? <input className="input sm grow" placeholder="Search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} aria-label="Search" /> : null}
          {filters?.map((f) => (
            <Select key={f.key} className="select" value={values[f.key] ?? ""} onChange={(e) => (setValues((v) => ({ ...v, [f.key]: e.target.value })), setPage(1))} aria-label={f.label}>
              <option value="">{f.label}</option>
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          ))}
        </div>
      ) : null}
      <div className="tbl-wrap glass" style={{ opacity: isFetching && !isLoading ? 0.7 : 1 }}>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={6} />
        ) : data.data.length ? (
          <>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.label} className={c.right ? "right" : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((r, i) => (
                    <tr key={String(r.id ?? i)} className={onRowClick ? "click" : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                      {columns.map((c) => (
                        <td key={c.label} className={c.right ? "num-cell" : undefined}>
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} limit={25} total={data.meta.total ?? 0} onPage={setPage} />
          </>
        ) : (
          <Empty icon="list" title="Nothing here" />
        )}
      </div>
    </>
  );
}
