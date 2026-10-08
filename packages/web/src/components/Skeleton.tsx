/** Placeholder rows shown while a list loads, so the page keeps its shape. */
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}
    </div>
  );
}
