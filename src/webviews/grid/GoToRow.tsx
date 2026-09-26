import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface GoToRowProps {
  rowCount: number;
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  onGoToRow(rowIndex: number): void;
}

// Accepts digits with any locale's grouping separators, such as "1,234", "1.234" or "1 234".
export function parseRowNumber(text: string, rowCount: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d[\d\s,.'\u00a0\u202f]*$/u.test(trimmed)) return undefined;
  const row = Number(trimmed.replace(/\D/gu, ""));
  return Number.isSafeInteger(row) && row >= 1 && row <= rowCount ? row : undefined;
}

export function GoToRow({ rowCount, open, busy, onOpenChange, onGoToRow }: GoToRowProps) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonFocus = useRef(false);
  const errorId = useId();
  const range = `1 to ${rowCount.toLocaleString()}`;

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (restoreButtonFocus.current) {
      restoreButtonFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  const close = (restoreFocus: boolean) => {
    restoreButtonFocus.current = restoreFocus;
    setInvalid(false);
    onOpenChange(false);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const row = parseRowNumber(text, rowCount);
    if (row === undefined) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    close(false);
    onGoToRow(row - 1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  if (!open) {
    return (
      <button
        ref={buttonRef}
        type="button"
        className="gridNavigationButton"
        aria-label="Go to row"
        aria-keyshortcuts="Control+G"
        title="Go to row (Ctrl+G)"
        disabled={rowCount === 0}
        onClick={() => onOpenChange(true)}
      >
        <span className="codicon codicon-search" aria-hidden="true" />
      </button>
    );
  }

  return (
    <form
      className="goToRowForm"
      aria-label="Go to row"
      onSubmit={submit}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) close(false);
      }}
    >
      <input
        ref={inputRef}
        className="goToRowInput"
        aria-label="Row number"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        autoComplete="off"
        inputMode="numeric"
        placeholder={range}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
      />
      <button type="submit" className="gridNavigationButton goToRowSubmit" disabled={busy}>
        Go
      </button>
      {invalid && (
        <span id={errorId} className="goToRowError" role="alert">
          Enter a row from {range}.
        </span>
      )}
    </form>
  );
}
