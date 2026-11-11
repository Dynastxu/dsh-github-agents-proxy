/** Settings-page styles, expressed with DSH theme tokens. */

export const STYLE_MARKER = 'dsh-github-agents-proxy'

export const CSS = `
.ghapp-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 22px;
}
.ghapp-card {
  padding: 4px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.ghapp-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 12px 16px;
  box-sizing: border-box;
}
.ghapp-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  corner-shape: round;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-skeleton);
}
.ghapp-avatar-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ghapp-identity-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ghapp-identity-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.ghapp-identity-actions .ghapp-status {
  font-size: 12px;
  line-height: 18px;
  text-align: right;
}
.ghapp-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.ghapp-token-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.ghapp-status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.ghapp-token-status[data-tone='active'] { color: var(--dsw-alias-state-success-primary); }
.ghapp-token-status[data-tone='warning'] { color: var(--dsw-alias-state-warn-label); }
.ghapp-token-status[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.ghapp-rows {
  display: flex;
  flex-direction: column;
}
.ghapp-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.ghapp-rows > .ghapp-row:last-child {
  border-bottom: none;
}
.ghapp-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 24px;
}
.ghapp-row-title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.ghapp-row-desc {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.ghapp-row-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.ghapp-row-control {
  flex: 0 0 260px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ghapp-row-control-end {
  justify-content: flex-end;
}
.ghapp-card-title {
  margin: 0;
  padding: 12px 0 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.ghapp-input {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
}
.ghapp-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ghapp-input:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.ghapp-input:disabled { opacity: 0.5; cursor: not-allowed; }
.ghapp-file-control {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.ghapp-file-control .ghapp-input {
  flex: 1;
  width: auto;
  min-width: 0;
}
.ghapp-icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .ghapp-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.ghapp-icon-button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.ghapp-icon-button:disabled { opacity: 0.5; cursor: not-allowed; }
.ghapp-select-wrap {
  position: relative;
  display: flex;
  width: 100%;
}
.ghapp-select {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 0 32px 0 12px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.ghapp-select:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.ghapp-select:disabled { opacity: 0.5; cursor: not-allowed; }
.ghapp-select-chevron {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--dsw-alias-label-secondary);
}
.ghapp-switch {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  margin: 0;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
}
.ghapp-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.ghapp-switch:disabled { cursor: default; opacity: 0.5; }
.ghapp-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.ghapp-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.ghapp-switch[aria-checked='false'] .ghapp-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.ghapp-switch[aria-checked='true'] .ghapp-switch-thumb { transform: translateX(16px); }
.ghapp-note {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.ghapp-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.ghapp-button {
  flex: none;
  height: 36px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
@media (hover: hover) {
  .ghapp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.ghapp-button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.ghapp-button:disabled { cursor: not-allowed; opacity: 0.4; }
.ghapp-button-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 500;
}
@media (hover: hover) {
  .ghapp-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
}
.ghapp-loading {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.ghapp-status { font-size: 13px; }
.ghapp-status-ok { color: var(--dsw-alias-state-success-primary); }
.ghapp-status-error { color: var(--dsw-alias-state-error-primary); }
@media (max-width: 767px) {
  .ghapp-row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .ghapp-row-text { padding-right: 0; }
  .ghapp-row-control { flex: none; }
  .ghapp-row-control-end { justify-content: flex-start; }
}
@media (pointer: coarse) {
  .ghapp-input, .ghapp-select { font-size: 16px; }
}
`
