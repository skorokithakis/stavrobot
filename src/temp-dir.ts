// Ephemeral files created by the agent (e.g. manage_files writes, plugin tool output)
// are placed here so the send tools can identify them for auto-deletion without
// risking deletion of user-uploaded files that also live under /tmp.
export const TEMP_ATTACHMENTS_DIR = "/tmp/stavrobot-temp";

// Each plugin or Python run writes its returned files into its own output directory
// with this prefix. Directories are never deleted at call start (so the agent can use
// files from earlier calls); the scheduler removes them once they are old enough.
export const OUTPUT_DIR_PREFIX = "output-";

export function createOutputDirPath(): string {
  return `${TEMP_ATTACHMENTS_DIR}/${OUTPUT_DIR_PREFIX}${crypto.randomUUID()}`;
}
