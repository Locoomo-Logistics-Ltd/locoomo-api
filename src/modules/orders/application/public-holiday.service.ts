import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { SharedCache } from '../../../common/redis/shared-cache';
import { addWorkingDays } from '../../../common/time/working-days';
import { PublicHolidayEntity } from '../infrastructure/entities/public-holiday.entity';

const CACHE_KEY = 'public-holidays';
const CACHE_SECONDS = 300;

// Collection window length (D15), in working days.
export const COLLECTION_WINDOW_WORKING_DAYS = 7;

export interface PublicHolidayView {
  date: string;
  name: string;
}

// The holiday calendar, and working-day arithmetic that respects it.
// Exported so merchants (and later reminders/fees) count days the same way.
@Injectable()
export class PublicHolidayService {
  constructor(
    @InjectRepository(PublicHolidayEntity)
    private readonly holidays: Repository<PublicHolidayEntity>,
    private readonly cache: SharedCache,
    private readonly audit: AuditService,
  ) {}

  async list(fromDate?: string): Promise<PublicHolidayView[]> {
    const qb = this.holidays.createQueryBuilder('h').orderBy('h.date', 'ASC');
    if (fromDate) {
      qb.where('h.date >= :fromDate', { fromDate });
    }
    return (await qb.getMany()).map((h) => ({ date: h.date, name: h.name }));
  }

  async add(
    date: string,
    name: string,
    adminUserId: string,
    context: AuditRequestContext,
  ): Promise<PublicHolidayView> {
    await this.holidays.upsert({ date, name, createdByUserId: adminUserId }, [
      'date',
    ]);
    await this.cache.del(CACHE_KEY);
    await this.audit.record({
      actor: { type: 'user', id: adminUserId, role: 'admin' },
      action: 'public_holiday.added',
      target: { type: 'public_holiday', id: date },
      after: { date, name },
      context,
    });
    return { date, name };
  }

  async remove(
    date: string,
    adminUserId: string,
    context: AuditRequestContext,
  ): Promise<void> {
    const result = await this.holidays.delete({ date });
    if (!result.affected) {
      throw new EntityNotFoundException('Public holiday', date);
    }
    await this.cache.del(CACHE_KEY);
    await this.audit.record({
      actor: { type: 'user', id: adminUserId, role: 'admin' },
      action: 'public_holiday.removed',
      target: { type: 'public_holiday', id: date },
      context,
    });
  }

  async holidaySet(): Promise<Set<string>> {
    const cached = await this.cache.get<string[]>(CACHE_KEY);
    if (cached) {
      return new Set(cached);
    }
    const dates = (await this.holidays.find({ select: { date: true } })).map(
      (h) => h.date,
    );
    await this.cache.set(CACHE_KEY, dates, CACHE_SECONDS);
    return new Set(dates);
  }

  async addWorkingDays(from: Date, days: number): Promise<Date> {
    return addWorkingDays(from, days, await this.holidaySet());
  }

  async collectionDeadline(shelvedAt: Date): Promise<Date> {
    return this.addWorkingDays(shelvedAt, COLLECTION_WINDOW_WORKING_DAYS);
  }
}
