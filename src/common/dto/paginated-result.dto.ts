export class PaginatedResultDto<T> {
  constructor(
    readonly items: T[],
    readonly page: number,
    readonly limit: number,
    readonly total: number,
  ) {}
}
