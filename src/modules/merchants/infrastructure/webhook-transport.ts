import { lookup as dnsLookup } from 'dns';
import { request } from 'https';
import type { LookupFunction } from 'net';
import { Injectable } from '@nestjs/common';
import { isPublicAddress } from '../domain/webhooks';

export interface WebhookResponse {
  // null when no HTTP response arrived (timeout, refused, blocked address).
  status: number | null;
  // First 2 KB, for the delivery log.
  body: string | null;
  error: string | null;
  durationMs: number;
}

// Sends one webhook. A class (not an interface) so e2e suites can swap it
// for a fake that records requests.
export abstract class WebhookTransport {
  abstract post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<WebhookResponse>;
}

const MAX_LOGGED_BODY = 2_048;

// Resolves the host and refuses non-public addresses at connection time, so
// a hostname that later re-points at an internal address (DNS rebinding)
// still can't reach our network.
export const publicOnlyLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const list = addresses;
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (blocked || list.length === 0) {
      callback(
        Object.assign(
          new Error('Webhook host resolves to a non-public address'),
          {
            code: 'EBLOCKEDADDRESS',
          },
        ),
        '',
        0,
      );
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
};

@Injectable()
export class HttpsWebhookTransport extends WebhookTransport {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<WebhookResponse> {
    const started = Date.now();
    return new Promise((resolve) => {
      const done = (result: Omit<WebhookResponse, 'durationMs'>): void =>
        resolve({ ...result, durationMs: Date.now() - started });
      let req: ReturnType<typeof request>;
      try {
        req = request(
          url,
          {
            method: 'POST',
            headers: {
              ...headers,
              'content-length': String(Buffer.byteLength(body)),
            },
            lookup: publicOnlyLookup,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
              if (size < MAX_LOGGED_BODY) {
                chunks.push(chunk);
                size += chunk.length;
              }
            });
            res.on('end', () =>
              done({
                // Redirects are not followed: a 3xx is a failed delivery.
                status: res.statusCode ?? null,
                body: Buffer.concat(chunks)
                  .toString('utf8')
                  .slice(0, MAX_LOGGED_BODY),
                error: null,
              }),
            );
            res.on('error', (error) =>
              done({
                status: res.statusCode ?? null,
                body: null,
                error: error.message,
              }),
            );
          },
        );
      } catch (error) {
        done({ status: null, body: null, error: String(error) });
        return;
      }
      req.on('timeout', () => {
        req.destroy(new Error(`Timed out after ${timeoutMs} ms`));
      });
      req.on('error', (error) =>
        done({ status: null, body: null, error: error.message }),
      );
      req.end(body);
    });
  }
}
