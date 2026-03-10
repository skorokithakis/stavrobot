export function getBaseStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }

    :root {
      --color-bg: #f8f9fa;
      --color-surface: #fff;
      --color-text: #1a1a1a;
      --color-text-secondary: #666;
      --color-text-muted: #888;
      --color-text-faint: #999;
      --color-text-disabled: #9ca3af;
      --color-accent: #d97706;
      --color-accent-hover: #b45309;
      --color-accent-light: #fff7ed;
      --color-accent-glow: rgba(217,119,6,0.1);
      --color-border: #ddd;
      --color-border-light: #f0f0f0;
      --color-border-medium: #eee;
      --color-success: #15803d;
      --color-error: #dc2626;
      --color-error-bg: #fef2f2;
      --color-error-border: #fca5a5;
      --color-shadow: rgba(0,0,0,0.08);
      --color-shadow-secondary: rgba(0,0,0,0.06);
      --color-code-bg: #f5f5f5;
      --color-user-bubble: #fef3c7;
      --color-agent-bubble: #f3f4f6;
      --color-input-disabled-bg: #f9fafb;
      --color-btn-disabled-bg: #e5e7eb;
      --color-modal-backdrop: rgba(0, 0, 0, 0.45);
      --color-table-header-bg: #fafafa;
      --color-table-header-border: #ddd;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --color-bg: #1a1a1a;
        --color-surface: #2a2a2a;
        --color-text: #e8e8e8;
        --color-text-secondary: #a0a0a0;
        --color-text-muted: #888;
        --color-text-faint: #707070;
        --color-text-disabled: #555;
        --color-accent: #f59e0b;
        --color-accent-hover: #fbbf24;
        --color-accent-light: #2d1f00;
        --color-accent-glow: rgba(245,158,11,0.15);
        --color-border: #444;
        --color-border-light: #333;
        --color-border-medium: #3a3a3a;
        --color-success: #22c55e;
        --color-error: #f87171;
        --color-error-bg: #2d1515;
        --color-error-border: #7f1d1d;
        --color-shadow: rgba(0,0,0,0.4);
        --color-shadow-secondary: rgba(0,0,0,0.3);
        --color-code-bg: #333;
        --color-user-bubble: #3d2e00;
        --color-agent-bubble: #333;
        --color-input-disabled-bg: #222;
        --color-btn-disabled-bg: #3a3a3a;
        --color-modal-backdrop: rgba(0, 0, 0, 0.7);
        --color-table-header-bg: #333;
        --color-table-header-border: #444;
      }
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--color-bg);
      color: var(--color-text);
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 24px;
    }

    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .section {
      background: var(--color-surface);
      box-shadow: 0 1px 3px var(--color-shadow), 0 1px 2px var(--color-shadow-secondary);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .btn {
      padding: 8px 16px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }

    .btn-primary {
      background: var(--color-accent);
      color: #fff;
      border-color: var(--color-accent);
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--color-accent-hover);
      border-color: var(--color-accent-hover);
    }

    .btn-danger {
      color: var(--color-error);
      border-color: var(--color-error-border);
    }

    input:focus,
    textarea:focus,
    select:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 3px var(--color-accent-glow);
    }

    .status-success {
      color: var(--color-success);
    }

    .status-error {
      color: var(--color-error);
    }

    @media (max-width: 480px) {
      body { padding: 12px; }
    }
  `;
}
