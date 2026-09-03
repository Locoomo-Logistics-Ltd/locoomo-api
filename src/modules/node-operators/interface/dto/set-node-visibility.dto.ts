import { IsBoolean } from 'class-validator';

export class SetNodeVisibilityDto {
  @IsBoolean()
  isPubliclyVisible!: boolean;
}
