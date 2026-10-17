/**
 * load-test.js — k6 load test for the PDF service API.
 *
 * Run (requires k6 installed: https://k6.io/docs/get-started/installation/):
 *   API_KEY=dev-only-api-key-change-in-production \
 *   k6 run scripts/load-test.js
 *
 * What it measures:
 *   - Job ACCEPTANCE rate (how fast the API accepts + persists + enqueues).
 *   - This is the API's intake capacity, NOT render throughput. The worker
 *     renders asynchronously; this test deliberately separates the two
 *     (per the assessment: distinguish acceptance rate from processing rate).
 *
 * Stages ramp virtual users up to simulate burst traffic. Thresholds assert
 * that acceptance stays fast and error rate stays low.
 *
 * To observe render throughput separately, watch the worker logs / batch
 * status while this runs — the queue depth will grow if acceptance outruns
 * rendering, which is exactly the backpressure behaviour we expect.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'dev-only-api-key-change-in-production';

export const options = {
  stages: [
    { duration: '10s', target: 10 }, // ramp to 10 virtual users
    { duration: '20s', target: 50 }, // ramp to 50
    { duration: '20s', target: 50 }, // hold at 50
    { duration: '10s', target: 0 }, // ramp down
  ],
  thresholds: {
    // 95% of acceptance requests should complete under 500ms
    http_req_duration: ['p(95)<500'],
    // Fewer than 1% failures
    http_req_failed: ['rate<0.01'],
  },
};

function invoicePayload(id) {
  return JSON.stringify({
    documentType: 'INVOICE',
    // Unique key per request so every one is a distinct accepted job
    idempotencyKey: `load-${__VU}-${__ITER}-${id}`,
    data: {
      invoiceNumber: `INV-LOAD-${id}`,
      invoiceDate: '2026-10-17',
      sellerName: 'Load Test Seller',
      sellerAddress: '1 Load Street',
      buyerName: 'Load Test Buyer',
      buyerAddress: '2 Test Avenue',
      currency: 'INR',
      lineItems: [
        { description: 'Service', quantity: 2, unitPrice: 500, amount: 1000 },
      ],
      taxRate: 0,
      totalAmount: 1000,
    },
  });
}

export default function () {
  const res = http.post(`${BASE_URL}/api/v1/jobs`, invoicePayload(Date.now()), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
  });

  check(res, {
    'status is 202 (accepted)': (r) => r.status === 202,
    'response has job id': (r) => {
      try {
        return Boolean(JSON.parse(r.body).id);
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}
