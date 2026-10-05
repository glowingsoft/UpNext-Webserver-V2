function asStringId(value) {
  return String(value);
}

function getUserRoom(userId) {
  return `user:${asStringId(userId)}`;
}

function getDirectRoom(subjectId, objectId) {
  const roomId = [asStringId(subjectId), asStringId(objectId)].sort().join("_");
  return `direct:${roomId}`;
}

function getGroupRoom(groupId) {
  return `group:${asStringId(groupId)}`;
}

function getSessionRoom(sessionId) {
  return `session:${asStringId(sessionId)}`;
}

function resolveConversationRoom({ subjectId, objectId, type }) {
  if (type === "group") {
    return getGroupRoom(objectId);
  }

  if (type === "session") {
    return getSessionRoom(objectId);
  }

  if (type === "direct") {
    return getDirectRoom(subjectId, objectId);
  }

  return null;
}

module.exports = {
  getUserRoom,
  getDirectRoom,
  getGroupRoom,
  getSessionRoom,
  resolveConversationRoom,
};
