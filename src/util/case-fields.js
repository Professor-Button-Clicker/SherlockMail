// A project's evidence ID and custodian live in two places: projects keep them in the evidence_id and
// custodian_name columns from creation, and edits used to write them only to config. Where
// both are set, config is the later value and wins, exactly as the project screens have always shown it.
// Everything that reports these two fields reads them through here, so reports, audit entries and
// export manifests show the same values as the screen.
export function caseFields(project) {
  let config = {};
  try { config = JSON.parse(project?.config || '{}'); } catch { config = {}; }
  return {
    evidenceId: config.evidenceId || project?.evidence_id || null,
    custodianName: config.custodianName || project?.custodian_name || null,
  };
}
