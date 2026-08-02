/**
 * Cursor Dashboard API Client
 * 
 * Uses HTTP/JSON directly to api2.cursor.sh with JWT Bearer auth.
 * Verified: DashboardService/GetCurrentPeriodUsage works via
 * POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage
 * with Content-Type: application/json
 */

import type { CursorUsageResponse } from '../types/index.js';

const CURSOR_API_BASE = 'https://api2.cursor.sh';

export class DashboardClient {
  private jwtToken: string;
  private cachedUsage: CursorUsageResponse | null = null;
  private cachedTime: number = 0;
  private cacheTtl: number = 60_000; // 1 minute cache

  constructor(jwtToken: string) {
    this.jwtToken = jwtToken;
  }

  /**
   * Get current period usage from Cursor's backend API
   * Returns cached result if within TTL
   */
  async getUsage(): Promise<CursorUsageResponse> {
    const now = Date.now();
    if (this.cachedUsage && (now - this.cachedTime) < this.cacheTtl) {
      return this.cachedUsage;
    }

    const response = await fetch(
      `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.jwtToken}`,
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Dashboard API error ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const data = await response.json();
    this.cachedUsage = data;
    this.cachedTime = now;

    return data;
  }

  /**
   * Invalidate the usage cache (for forced refresh)
   */
  invalidateCache(): void {
    this.cachedUsage = null;
    this.cachedTime = 0;
  }

  /**
   * Validate the JWT token by making a simple API call
   */
  async validateToken(): Promise<{
    valid: boolean;
    email?: string;
    plan?: string;
    error?: string;
  }> {
    try {
      const parts = this.jwtToken.split('.');
      if (parts.length !== 3) {
        return { valid: false, error: 'Invalid JWT format' };
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
      
      // Check expiration
      const exp = payload.exp * 1000;
      if (Date.now() >= exp) {
        return { valid: false, error: 'JWT token expired' };
      }

      // Try API call to verify token works
      const usage = await this.getUsage();
      
      return {
        valid: true,
        email: payload.email ?? payload.sub ?? undefined,
        plan: usage.spendLimitUsage?.limitType,
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
