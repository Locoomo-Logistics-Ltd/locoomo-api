import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../../../config/env.validation';
import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';
import {
  PaymentInitializeParams,
  PaymentInitializeResult,
  PaymentProvider,
  PaymentRefundResult,
  PaymentVerificationResult,
  PaymentWebhookEvent,
} from '../domain/ports/payment-provider.port';

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; reference: string };
}

interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    status: string;
    amount: number;
    currency: string;
    paid_at: string | null;
    reference: string;
  };
}

interface PaystackRefundResponse {
  status: boolean;
  message: string;
  data: { status: string; id: number };
}

@Injectable()
export class PaystackPaymentProvider implements PaymentProvider {
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly configService: ConfigService<Env, true>) {}

  private get secretKey(): string {
    return this.configService.get('PAYSTACK_SECRET_KEY', { infer: true });
  }

  async initialize(
    params: PaymentInitializeParams,
  ): Promise<PaymentInitializeResult> {
    const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amountKobo,
        reference: params.reference,
        callback_url: params.callbackUrl,
        currency: 'NGN',
        metadata: {
          consumer_id: params.metadata.consumerId,
          origin_node_id: params.metadata.originNodeId,
          destination_node_id: params.metadata.destinationNodeId,
          custom_fields: [
            {
              display_name: 'Consumer ID',
              variable_name: 'consumer_id',
              value: params.metadata.consumerId,
            },
            {
              display_name: 'Origin Node',
              variable_name: 'origin_node',
              value: `${params.metadata.originNodeName} (${params.metadata.originNodeId})`,
            },
            {
              display_name: 'Destination Node',
              variable_name: 'destination_node',
              value: `${params.metadata.destinationNodeName} (${params.metadata.destinationNodeId})`,
            },
          ],
        },
      }),
    });

    const body = (await response.json()) as PaystackInitializeResponse;
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'initialize',
        body.message ?? `HTTP ${response.status}`,
      );
    }

    return {
      authorizationUrl: body.data.authorization_url,
      providerReference: body.data.reference,
    };
  }

  async verify(providerReference: string): Promise<PaymentVerificationResult> {
    const response = await fetch(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(providerReference)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } },
    );

    const body = (await response.json()) as PaystackVerifyResponse;
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'verify',
        body.message ?? `HTTP ${response.status}`,
      );
    }

    return {
      status:
        body.data.status === 'success'
          ? 'success'
          : body.data.status === 'failed'
            ? 'failed'
            : 'pending',
      amountKobo: body.data.amount,
      currency: body.data.currency,
      paidAt: body.data.paid_at ? new Date(body.data.paid_at) : null,
      providerReference: body.data.reference,
    };
  }

  async refund(
    providerReference: string,
    amountKobo?: number,
  ): Promise<PaymentRefundResult> {
    const response = await fetch(`${this.baseUrl}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transaction: providerReference,
        ...(amountKobo !== undefined ? { amount: amountKobo } : {}),
      }),
    });

    const body = (await response.json()) as PaystackRefundResponse;
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'refund',
        body.message ?? `HTTP ${response.status}`,
      );
    }

    return {
      status: body.data.status === 'processed' ? 'processed' : 'pending',
      providerRefundReference: String(body.data.id),
    };
  }

  // HMAC-SHA512 of the *raw* request body, per Paystack's docs — must be
  // computed over the exact bytes they sent, not a re-serialized parse of
  // them (see main.ts's raw-body middleware for the payments webhook route).
  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
    if (!signatureHeader) {
      return false;
    }

    const expected = createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');

    // timingSafeEqual throws on length mismatch instead of returning false.
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  parseWebhookEvent(rawBody: Buffer): PaymentWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      data?: { reference?: string };
    };

    const type =
      payload.event === 'charge.success'
        ? ('charge.success' as const)
        : payload.event === 'charge.failed'
          ? ('charge.failed' as const)
          : ('unknown' as const);

    return { type, providerReference: payload.data?.reference ?? '' };
  }
}
