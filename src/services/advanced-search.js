import { v4 as uuidv4 } from 'uuid';

// How much of each folder a differential collection would still have to fetch, from the folder counts the
// last collection read from the server and what has been collected since.
export function computeDifferentialPlan(existingMessages, serverFolders) {
  const collectedByFolder = new Map();
  for (const m of existingMessages) {
    collectedByFolder.set(m.folder || '', (collectedByFolder.get(m.folder || '') || 0) + 1);
  }

  const plan = {
    id: uuidv4(),
    type: 'differential',
    existingMessageCount: existingMessages.length,
    folders: [],
    estimatedNewMessages: 0,
    basis: 'Folder counts from the last collection compared with what was collected. Start a differential collection to read the current counts.',
  };

  for (const folder of serverFolders) {
    const folderPath = folder.path || folder.name;
    const serverTotal = folder.total_messages || 0;
    const existingCount = collectedByFolder.get(folderPath) || 0;
    const estimatedNew = Math.max(0, serverTotal - existingCount);
    plan.folders.push({ path: folderPath, serverTotal, existingCount, estimatedNew, needsCollection: estimatedNew > 0 });
    plan.estimatedNewMessages += estimatedNew;
  }

  return plan;
}
