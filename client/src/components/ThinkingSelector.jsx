export default function ThinkingSelector({ thinking, value, onChange, disabled = false }) {
  const levels = thinking?.levels || [];
  if (!levels.length) return null;

  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
      <span className="font-semibold uppercase tracking-wider">Thinking Level</span>
      <select
        aria-label="Thinking level"
        value={value || thinking.defaultLevel || ""}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="w-full min-w-0 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-foreground disabled:opacity-60"
      >
        {levels.map(level => (
          <option key={level} value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
        ))}
      </select>
    </label>
  );
}
