import { UserRole } from '../../domain/user-role.enum';
import { UserStatus } from '../../domain/user-status.enum';
import { UserEntity } from '../../infrastructure/entities/user.entity';

export class UserResponseDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
  phone!: string;
  role!: UserRole;
  status!: UserStatus;
  emailVerifiedAt!: Date | null;
  createdAt!: Date;

  static fromEntity(user: UserEntity): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.firstName = user.firstName;
    dto.lastName = user.lastName;
    dto.phone = user.phone;
    dto.role = user.role;
    dto.status = user.status;
    dto.emailVerifiedAt = user.emailVerifiedAt;
    dto.createdAt = user.createdAt;
    return dto;
  }
}
