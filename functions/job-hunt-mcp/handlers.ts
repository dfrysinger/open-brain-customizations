/**
 * Pure, testable handler functions extracted from the MCP server.
 */

export interface AttributionLogEntry {
  entity_type: "job_posting" | "application";
  entity_id: string;
  action: string;
  actor: string;
  reason: string | null;
}

/**
 * Build attribution log entries for an application update by comparing
 * current state with the incoming updates.
 */
export function buildUpdateApplicationLogs(
  current: {
    status: string;
    resume_path: string | null;
    cover_letter_path: string | null;
  },
  updates: {
    status?: string;
    resume_path?: string | null;
    cover_letter_path?: string | null;
  },
  application_id: string,
  actor: string,
  actor_reason?: string,
): AttributionLogEntry[] {
  const logs: AttributionLogEntry[] = [];

  if (updates.status !== undefined && updates.status !== current.status) {
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action: "status_changed",
      actor,
      reason: actor_reason ?? `${current.status} -> ${updates.status}`,
    });
  }

  if (
    updates.resume_path !== undefined &&
    updates.resume_path !== current.resume_path
  ) {
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action: updates.resume_path === null ? "resume_removed" : "resume_added",
      actor,
      reason: actor_reason ?? null,
    });
  }

  if (
    updates.cover_letter_path !== undefined &&
    updates.cover_letter_path !== current.cover_letter_path
  ) {
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action:
        updates.cover_letter_path === null
          ? "cover_letter_removed"
          : "cover_letter_added",
      actor,
      reason: actor_reason ?? null,
    });
  }

  return logs;
}
