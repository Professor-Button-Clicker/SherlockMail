import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class FolderSnapshotService {

  static captureSnapshot(projectId, folders, acquisitionId, snapshotType) {
    const folderData = folders.map(f => ({
      path: f.path || f.name,
      name: f.name,
      totalMessages: f.total_messages || f.totalMessages || 0,
      unseenMessages: f.unseen_messages || f.unseenMessages || 0,
      flags: typeof f.flags === 'string' ? JSON.parse(f.flags) : (f.flags || []),
      delimiter: f.delimiter || '/',
    }));

    const totalFolders = folderData.length;
    const totalMessages = folderData.reduce((sum, f) => sum + f.totalMessages, 0);

    // The hash covers path, counts and flags in a stable order, so two identical states hash the same.
    const canonical = JSON.stringify([...folderData].sort((a, b) => String(a.path).localeCompare(String(b.path))).map(f => [f.path, f.totalMessages, f.unseenMessages, f.flags]));
    const hashSha256 = crypto.createHash('sha256').update(canonical).digest('hex');

    return {
      id: uuidv4(),
      projectId,
      acquisitionId: acquisitionId || null,
      snapshotType,
      folderData,
      totalFolders,
      totalMessages,
      hashSha256,
    };
  }

  static compareSnapshots(preSnapshot, postSnapshot) {
    const foldersOf = s => (typeof s.folder_data === 'string' ? JSON.parse(s.folder_data) : s.folderData || s.folder_data);
    const preFolders = foldersOf(preSnapshot);
    const postFolders = foldersOf(postSnapshot);

    const preMap = new Map(preFolders.map(f => [f.path, f]));
    const postMap = new Map(postFolders.map(f => [f.path, f]));

    const added = [];
    const removed = [];
    const changed = [];
    const unchanged = [];

    for (const [path, folder] of postMap) {
      if (!preMap.has(path)) {
        added.push({ path, folder });
      } else {
        const pre = preMap.get(path);
        if (pre.totalMessages !== folder.totalMessages || pre.unseenMessages !== folder.unseenMessages) {
          changed.push({ path, before: pre.totalMessages, after: folder.totalMessages, delta: folder.totalMessages - pre.totalMessages, unseenBefore: pre.unseenMessages, unseenAfter: folder.unseenMessages });
        } else {
          unchanged.push(path);
        }
      }
    }
    for (const path of preMap.keys()) {
      if (!postMap.has(path)) removed.push(path);
    }

    const preTotalMessages = typeof preSnapshot.total_messages === 'number' ? preSnapshot.total_messages : (preSnapshot.totalMessages || 0);
    const postTotalMessages = typeof postSnapshot.total_messages === 'number' ? postSnapshot.total_messages : (postSnapshot.totalMessages || 0);

    return {
      foldersAdded: added,
      foldersRemoved: removed,
      foldersChanged: changed,
      foldersUnchanged: unchanged.length,
      totalMessagesBefore: preTotalMessages,
      totalMessagesAfter: postTotalMessages,
      messageDelta: postTotalMessages - preTotalMessages,
      snapshotIntegrity: {
        preHash: preSnapshot.hash_sha256 || preSnapshot.hashSha256,
        postHash: postSnapshot.hash_sha256 || postSnapshot.hashSha256,
      },
    };
  }
}
