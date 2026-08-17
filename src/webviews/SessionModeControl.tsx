import type { SessionMetadata, SessionMode } from "../shared/protocol";
import { sessionModeAction, sessionModeDescription, sessionModeLabel } from "../shared/sessionMode";

const sessionModeHelpId = "openwrangler-session-mode-help";

interface SessionModeControlProps {
  metadata: SessionMetadata;
  busy: boolean;
  onSwitch: (target: SessionMode, trigger: HTMLButtonElement) => void;
}

export function SessionModeControl({ metadata, busy, onSwitch }: SessionModeControlProps) {
  const action = sessionModeAction(metadata);
  const description = sessionModeDescription(metadata);
  return (
    <>
      {action && (
        <button
          type="button"
          className="toolbarButton"
          data-session-mode-action
          disabled={busy || action.disabledReason !== undefined}
          aria-busy={busy || undefined}
          aria-describedby={sessionModeHelpId}
          title={action.title}
          onClick={(event) => onSwitch(action.target, event.currentTarget)}
        >
          <span
            className={`codicon ${action.target === "editing" ? "codicon-edit" : "codicon-eye"}`}
            aria-hidden="true"
          />{" "}
          {action.label}
        </button>
      )}
      <details className="sessionModeHelp">
        <summary
          aria-describedby={sessionModeHelpId}
          className="sessionBadge modeBadge sessionModeBadge"
          data-session-badge="mode"
        >
          {sessionModeLabel(metadata)}
          <span className="codicon codicon-info" aria-hidden="true" />
        </summary>
        <span id={sessionModeHelpId} className="sessionModeHelpText" role="note">
          {description}
        </span>
      </details>
    </>
  );
}
