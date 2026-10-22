import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { Env } from '../../../../config/env.validation';
import { LogisticsProviderRegistry } from '../../application/logistics-provider.registry';
import {
  DeliveryEventType,
  DeliveryLegStatus,
  VehicleClass,
} from '../../domain/delivery-leg';
import {
  CreateDeliveryRequest,
  LogisticsProviderError,
} from '../../domain/ports/logistics-provider.port';
import type { SendiiDelivery } from './sendii-api.types';
import { SendiiProvider } from './sendii.provider';

const SECRET = 'whsec_test_secret';

function provider(env: Partial<Record<keyof Env, unknown>> = {}) {
  const values: Record<string, unknown> = {
    NODE_ENV: 'development',
    SENDII_API_KEY: 'sk_test_key',
    SENDII_WEBHOOK_SECRET: SECRET,
    SENDII_BASE_URL: 'https://api.sendii.test/partner/v1',
    ...env,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService<Env, true>;
  return new SendiiProvider(new LogisticsProviderRegistry(), config);
}

const delivery = (overrides: Partial<SendiiDelivery> = {}): SendiiDelivery => ({
  id: 'del_1',
  delivery_id: null,
  status: 'pending',
  sequence: 1,
  fee: 2400,
  surcharge: 0,
  currency: 'NGN',
  external_ref: 'leg-1',
  rider: null,
  pickup_code: null,
  delivery_code: null,
  tracking_code: null,
  tracking_url: null,
  cancel_reason: null,
  created_at: '2026-10-21T10:00:00Z',
  updated_at: '2026-10-21T10:00:00Z',
  picked_up_at: null,
  delivered_at: null,
  ...overrides,
});

const request: CreateDeliveryRequest = {
  legId: 'leg-1',
  trackingCode: 'LCM-4F2K-9XPT',
  pickup: {
    nodeId: 'yaba',
    name: 'Yaba Node',
    address: '1 Herbert Macaulay Way',
    city: 'Lagos',
    state: 'Lagos',
    latitude: 6.5,
    longitude: 3.37,
    contactName: 'Yaba Node (Locoomo station)',
    contactPhone: '+2348030000001',
  },
  dropoff: {
    nodeId: 'lekki',
    name: 'Lekki Node',
    address: '45 Admiralty Way',
    city: 'Lagos',
    state: 'Lagos',
    latitude: 6.44,
    longitude: 3.47,
    contactName: 'Lekki Node (Locoomo station)',
    contactPhone: '+2348030000002',
  },
  vehicleClass: null,
  description: 'Locoomo parcel LCM-4F2K-9XPT (small)',
  otherActiveQuotedKobo: 0,
};

const ok = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });
const fail = (status: number, code: string) =>
  Response.json(
    { success: false, error: { code, message: code.toLowerCase() } },
    { status },
  );
const quote = () =>
  ok({
    quote_id: 'q_1',
    fee: 2400,
    currency: 'NGN',
    distance_m: 9200,
    eta_minutes: 27,
    expires_at: '2026-10-21T10:10:00Z',
  });
const wallet = (available: number) =>
  ok({
    balance: available,
    held: 0,
    available,
    environment: 'test',
    dva: null,
  });

describe('SendiiProvider', () => {
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('createDelivery', () => {
    it('quotes, checks the wallet, then creates with the leg id as external_ref', async () => {
      fetchSpy
        .mockResolvedValueOnce(quote())
        .mockResolvedValueOnce(wallet(50_000))
        .mockResolvedValueOnce(ok(delivery(), 201));

      const result = await provider().createDelivery(request);

      expect(result).toEqual({
        externalId: 'del_1',
        status: DeliveryLegStatus.REQUESTED,
        providerStatus: 'pending',
        quotedKobo: 240_000,
        trackingUrl: null,
        etaMinutes: 27,
        distanceMeters: 9200,
      });

      const quoteUrl = new URL(fetchSpy.mock.calls[0][0] as string);
      expect(quoteUrl.pathname).toBe('/partner/v1/quote');
      expect(quoteUrl.searchParams.get('vehicle_type')).toBe('motorbike');
      expect(quoteUrl.searchParams.get('pickup_lat')).toBe('6.5');

      const [createUrl, createInit] = fetchSpy.mock.calls[2];
      expect(createUrl).toBe('https://api.sendii.test/partner/v1/deliveries');
      expect(createInit?.method).toBe('POST');
      expect(
        (createInit?.headers as Record<string, string>).Authorization,
      ).toBe('Bearer sk_test_key');
      const body = JSON.parse(createInit?.body as string) as Record<
        string,
        string
      >;
      expect(body).toEqual({
        quote_id: 'q_1',
        external_ref: 'leg-1',
        description: 'Locoomo parcel LCM-4F2K-9XPT (small)',
        recipient_name: 'Lekki Node (Locoomo station)',
        recipient_phone: '+2348030000002',
        pickup_contact_name: 'Yaba Node (Locoomo station)',
        pickup_contact_phone: '+2348030000001',
      });
    });

    it('treats a 409 replay as success, returning the existing delivery', async () => {
      fetchSpy
        .mockResolvedValueOnce(quote())
        .mockResolvedValueOnce(wallet(50_000))
        .mockResolvedValueOnce(
          Response.json(
            {
              success: false,
              error: { code: 'CONFLICT', message: 'exists' },
              data: delivery({ status: 'assigned' }),
            },
            { status: 409 },
          ),
        );

      const result = await provider().createDelivery(request);
      expect(result.externalId).toBe('del_1');
      expect(result.status).toBe(DeliveryLegStatus.ASSIGNED);
    });

    it('refuses without calling Sendii when it cannot carry the job', async () => {
      await expect(
        provider().createDelivery({
          ...request,
          vehicleClass: VehicleClass.VAN,
        }),
      ).rejects.toMatchObject({ retryable: false });
      await expect(
        provider().createDelivery({
          ...request,
          dropoff: { ...request.dropoff, contactPhone: null },
        }),
      ).rejects.toMatchObject({ retryable: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back (non-retryable) when the wallet lacks headroom for surcharges', async () => {
      // Fee ₦2,400 needs ₦3,840 with 60% headroom, plus 60% of ₦5,000 in flight.
      fetchSpy
        .mockResolvedValueOnce(quote())
        .mockResolvedValueOnce(wallet(6_000));

      const error = await provider()
        .createDelivery({ ...request, otherActiveQuotedKobo: 500_000 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LogisticsProviderError);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).toContain(
        'INSUFFICIENT_WALLET_HEADROOM',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('refuses (non-retryable) a quote above the cost cap, before checking the wallet', async () => {
      fetchSpy.mockResolvedValueOnce(quote());

      const error = await provider()
        .createDelivery({ ...request, maxCostKobo: 200_000 })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).toContain('QUOTE_ABOVE_LIMIT');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      [402, 'INSUFFICIENT_BALANCE', false],
      [403, 'DELIVERIES_DISABLED', false],
      [400, 'VALIDATION_ERROR', false],
      [503, 'INTERNAL_ERROR', true],
    ])('maps HTTP %i %s to retryable=%s', async (status, code, retryable) => {
      fetchSpy.mockResolvedValue(fail(status, code));

      await expect(
        provider().createDelivery({
          ...request,
          otherActiveQuotedKobo: undefined,
        }),
      ).rejects.toMatchObject({ retryable });
    });
  });

  it('normalises a delivery snapshot, in kobo, charging the fee only once settled', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok(
        delivery({
          status: 'delivered',
          sequence: 5,
          surcharge: 480,
          rider: {
            name: 'Musa A.',
            phone: '+2348031112222',
            vehicle: 'motorbike',
          },
        }),
      ),
    );

    expect(await provider().getDelivery('del_1')).toEqual({
      externalId: 'del_1',
      status: DeliveryLegStatus.DELIVERED,
      providerStatus: 'delivered',
      sequence: 5,
      courier: {
        name: 'Musa A.',
        phone: '+2348031112222',
        vehicle: 'motorbike',
      },
      trackingUrl: null,
      actualKobo: 240_000,
      surchargeKobo: 48_000,
      failureReason: null,
    });
  });

  it('reports a cancel after pickup as non-retryable', async () => {
    fetchSpy.mockResolvedValueOnce(fail(409, 'CONFLICT'));
    await expect(provider().cancel('del_1')).rejects.toMatchObject({
      retryable: false,
    });
  });

  describe('webhooks', () => {
    const body = Buffer.from(
      JSON.stringify({
        webhook_id: 'wh_1',
        event: 'delivery.picked_up',
        created_at: '2026-10-21T10:30:00Z',
        livemode: false,
        data: delivery({ status: 'picked_up', sequence: 3 }),
      }),
    );
    const sign = (raw: Buffer, secret = SECRET) =>
      createHmac('sha512', secret).update(raw).digest('hex');

    it('accepts only a valid HMAC-SHA512 of the raw body', () => {
      const sendii = provider();
      expect(
        sendii.verifyWebhook(body, { 'x-sendii-signature': sign(body) }),
      ).toBe(true);
      expect(
        sendii.verifyWebhook(body, {
          'x-sendii-signature': sign(body, 'other'),
        }),
      ).toBe(false);
      expect(sendii.verifyWebhook(body, {})).toBe(false);
      expect(
        provider({ SENDII_WEBHOOK_SECRET: undefined }).verifyWebhook(body, {
          'x-sendii-signature': sign(body),
        }),
      ).toBe(false);
    });

    it('parses the event into the normalised vocabulary', () => {
      expect(provider().parseWebhook(body)).toMatchObject({
        eventId: 'wh_1',
        externalId: 'del_1',
        event: DeliveryEventType.PICKED_UP,
        snapshot: { status: DeliveryLegStatus.PICKED_UP, sequence: 3 },
      });
    });

    it('treats a ping as carrying no delivery event', () => {
      const ping = Buffer.from(
        JSON.stringify({
          webhook_id: 'wh_ping',
          event: 'ping',
          created_at: '2026-10-21T10:30:00Z',
          livemode: false,
          data: { message: 'hello' },
        }),
      );
      expect(provider().parseWebhook(ping)).toEqual({
        eventId: 'wh_ping',
        externalId: null,
        event: null,
        snapshot: null,
      });
    });
  });
});
