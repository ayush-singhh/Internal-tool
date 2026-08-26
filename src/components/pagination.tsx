import Link from "next/link";
import { buildQuery, type RawParams } from "@/lib/query";

export function Pagination({
  basePath,
  params,
  page,
  pages,
  total,
  pageSize,
}: {
  basePath: string;
  params: RawParams;
  page: number;
  pages: number;
  total: number;
  pageSize: number;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const link = (p: number, label: string, disabled: boolean) =>
    disabled ? (
      <span className="cursor-not-allowed rounded-md border border-line px-2.5 py-1 text-[0.8rem] text-ink-300">
        {label}
      </span>
    ) : (
      <Link
        href={`${basePath}${buildQuery(params, { page: String(p) })}`}
        className="rounded-md border border-line-strong px-2.5 py-1 text-[0.8rem] font-medium text-ink-700 transition hover:bg-ink-50"
      >
        {label}
      </Link>
    );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
      <p className="tnum text-[0.8rem] text-ink-500">
        Showing <span className="font-medium text-ink-800">{first.toLocaleString()}</span>–
        <span className="font-medium text-ink-800">{last.toLocaleString()}</span> of{" "}
        <span className="font-medium text-ink-800">{total.toLocaleString()}</span>
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-1.5">
          {link(page - 1, "Previous", page <= 1)}
          <span className="tnum px-1 text-[0.8rem] text-ink-500">
            Page {page} of {pages}
          </span>
          {link(page + 1, "Next", page >= pages)}
        </div>
      )}
    </div>
  );
}
