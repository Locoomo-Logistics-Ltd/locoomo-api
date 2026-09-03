export interface NodeStaffRow {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  joinedAt: Date;
}

// Deliberately excludes phone — not needed for an owner deciding who to
// remove, keeps the PII surface on this view minimal.
export class NodeStaffResponseDto {
  userId!: string;
  firstName!: string;
  lastName!: string;
  email!: string;
  joinedAt!: Date;

  static fromRow(row: NodeStaffRow): NodeStaffResponseDto {
    const dto = new NodeStaffResponseDto();
    dto.userId = row.userId;
    dto.firstName = row.firstName;
    dto.lastName = row.lastName;
    dto.email = row.email;
    dto.joinedAt = row.joinedAt;
    return dto;
  }
}
