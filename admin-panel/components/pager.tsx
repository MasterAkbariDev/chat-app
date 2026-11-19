import Link from "next/link";
import { PAGE_SIZE } from "@/lib/constants";

/** Previous / next links that keep the current filters in the query string. */
export function Pager({
  basePath,
  params,
  page,
  total,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        search.set(key, value);
      }
    }
    if (target > 1) {
      search.set("page", String(target));
    }
    const qs = search.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="pager">
      {page > 1 ? (
        <Link className="button secondary" href={href(page - 1)}>
          Previous
        </Link>
      ) : null}
      <span className="muted">
        Page {page} of {pages} · {total} total
      </span>
      {page < pages ? (
        <Link className="button secondary" href={href(page + 1)}>
          Next
        </Link>
      ) : null}
    </div>
  );
}
