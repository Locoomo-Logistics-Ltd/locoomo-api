export enum UserRole {
  CONSUMER = 'consumer',
  NODE_OPERATOR = 'node_operator',
  RIDER = 'rider',
  ADMIN = 'admin',
  // Invite-only (like ADMIN) — never self-registerable. Granted per-Node by
  // that Node's owner (POST /node-operators/nodes/:nodeId/staff/invite),
  // not by an Admin. Deliberately its own role rather than reusing
  // NODE_OPERATOR + roleAtNode alone: RolesGuard can then exclude staff
  // from owner-only routes structurally, instead of relying on every future
  // owner-only endpoint remembering an extra service-level check.
  NODE_STAFF = 'node_staff',
}
