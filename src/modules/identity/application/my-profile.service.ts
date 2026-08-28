import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { UpdateProfileDto } from '../interface/dto/update-profile.dto';
import { UserResponseDto } from '../interface/dto/user-response.dto';

// The authenticated "me" surface every role shares — deliberately generic
// (no @Roles beyond being logged in) since phone-completion applies to
// Consumer/NodeOperator/Rider alike, unlike riders'/node-operators' own
// role-specific GET me (profile data those roles carry that Consumer
// doesn't).
@Injectable()
export class MyProfileService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async getMine(userId: string): Promise<UserResponseDto> {
    const user = await this.findOrThrow(userId);
    return UserResponseDto.fromEntity(user);
  }

  async updateMine(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    const user = await this.findOrThrow(userId);
    user.phone = dto.phone;
    const saved = await this.users.save(user);
    return UserResponseDto.fromEntity(saved);
  }

  private async findOrThrow(userId: string): Promise<UserEntity> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }
    return user;
  }
}
