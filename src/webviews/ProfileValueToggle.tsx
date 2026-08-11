import type { ProfileValueMode } from "./profileValueMode";

interface ProfileValueToggleProps {
  mode: ProfileValueMode;
  onChange?: (mode: ProfileValueMode) => void;
  ariaLabel: string;
  countAriaLabel?: string;
  percentAriaLabel?: string;
  compact?: boolean;
  disabled?: boolean;
}

export function ProfileValueToggle({
  mode,
  onChange,
  ariaLabel,
  countAriaLabel = "Counts",
  percentAriaLabel = "%",
  compact = false,
  disabled = false
}: ProfileValueToggleProps) {
  const controlsDisabled = disabled || !onChange;
  return (
    <div
      className={`segmentedControl profileValueToggle${compact ? " compact" : ""}`}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        aria-label={countAriaLabel}
        aria-pressed={mode === "count"}
        disabled={controlsDisabled}
        onClick={() => onChange?.("count")}
      >
        Counts
      </button>
      <button
        type="button"
        aria-label={percentAriaLabel}
        aria-pressed={mode === "percent"}
        disabled={controlsDisabled}
        onClick={() => onChange?.("percent")}
      >
        %
      </button>
    </div>
  );
}
