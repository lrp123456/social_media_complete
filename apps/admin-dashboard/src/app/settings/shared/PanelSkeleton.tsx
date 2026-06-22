export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="p-inner-component-padding space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 rounded animate-shimmer"
          style={{
            background: 'linear-gradient(90deg, #edeeef 25%, #e7e8e9 50%, #edeeef 75%)',
            backgroundSize: '1000px 100%',
          }}
        />
      ))}
    </div>
  );
}
