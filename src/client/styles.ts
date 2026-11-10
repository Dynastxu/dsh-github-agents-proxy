/** Minimal stylesheet for the GitHub App settings page, using DSH theme tokens. */

export const STYLE_MARKER = 'dsh-github-agents-proxy'

export const CSS = `
.ghapp-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.ghapp-heading { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ghapp-intro, .ghapp-note, .ghapp-hint, .ghapp-loading { color: var(--dsw-alias-label-secondary); }
.ghapp-intro, .ghapp-note { margin: 0; line-height: 1.5; }
.ghapp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.ghapp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ghapp-field-wide { grid-column: 1 / -1; }
.ghapp-label { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }
.ghapp-hint { margin: 0; font-size: 12px; line-height: 1.45; }
.ghapp-input, .ghapp-select {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  padding: 6px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  color-scheme: inherit;
}
.ghapp-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.ghapp-input:focus, .ghapp-select:focus {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.ghapp-check { flex-direction: row; align-items: center; gap: 8px; }
.ghapp-check input { accent-color: var(--dsw-alias-state-business-primary); }
.ghapp-check > span { display: flex; flex-direction: column; gap: 2px; }
.ghapp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ghapp-button {
  min-height: 34px;
  padding: 6px 14px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.ghapp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ghapp-button:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.ghapp-button-primary {
  background: var(--dsw-alias-button-primary-fill);
  box-shadow: none;
  color: var(--dsw-alias-label-primary-foreground);
}
.ghapp-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ghapp-button:disabled { cursor: not-allowed; opacity: 0.4; }
.ghapp-status { font-size: 13px; }
.ghapp-status-ok { color: var(--dsw-alias-state-success-primary); }
.ghapp-status-error { color: var(--dsw-alias-state-error-primary); }
.ghapp-details {
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-lg, var(--dsw-radius-md));
}
.ghapp-details > summary { cursor: pointer; color: var(--dsw-alias-label-primary); font-weight: 500; }
.ghapp-details[open] > summary { margin-bottom: 12px; }
@media (max-width: 640px) { .ghapp-grid { grid-template-columns: 1fr; } }
`
