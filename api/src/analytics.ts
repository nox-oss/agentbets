import { Context, Next } from 'hono';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

const ANALYTICS_FILE = process.env.ANALYTICS_FILE || './analytics.json';

interface AnalyticsEvent {
  timestamp: string;
  endpoint: string;
  method: string;
  visitorHash: string;  // Hash of IP + User-Agent for privacy
  userAgent?: string;
  referer?: string;
}

interface AnalyticsSummary {
  events: AnalyticsEvent[];
  funnel: {
    skillMd: Set<string>;
    markets: Set<string>;
    prepare: Set<string>;
    betsPlaced: Set<string>;
  };
}

// Load analytics
function loadAnalytics(): { events: AnalyticsEvent[] } {
  try {
    if (existsSync(ANALYTICS_FILE)) {
      return JSON.parse(readFileSync(ANALYTICS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load analytics:', e);
  }
  return { events: [] };
}

// Save analytics
function saveAnalytics(data: { events: AnalyticsEvent[] }) {
  try {
    // Keep only last 1000 events to prevent file bloat
    const trimmed = { events: data.events.slice(-1000) };
    writeFileSync(ANALYTICS_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error('Failed to save analytics:', e);
  }
}

// Analytics middleware
export function analyticsMiddleware() {
  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const userAgent = c.req.header('user-agent') || 'unknown';
    
    // Create privacy-preserving hash
    const visitorHash = crypto
      .createHash('sha256')
      .update(ip + userAgent)
      .digest('hex')
      .slice(0, 12);
    
    const event: AnalyticsEvent = {
      timestamp: new Date().toISOString(),
      endpoint: c.req.path,
      method: c.req.method,
      visitorHash,
      userAgent: userAgent.slice(0, 100),  // Truncate for storage
      referer: c.req.header('referer'),
    };
    
    // Log to console for Railway logs
    console.log(`[ANALYTICS] ${event.method} ${event.endpoint} visitor=${visitorHash}`);
    
    // Save to file
    const analytics = loadAnalytics();
    analytics.events.push(event);
    saveAnalytics(analytics);
    
    await next();
  };
}

// Get funnel summary
export function getFunnelSummary(): {
  uniqueVisitors: number;
  skillMdViews: number;
  marketsViews: number;
  prepareAttempts: number;
  betsPlaced: number;
  conversionRate: string;
} {
  const analytics = loadAnalytics();
  
  const skillMd = new Set<string>();
  const markets = new Set<string>();
  const prepare = new Set<string>();
  const bets = new Set<string>();
  const allVisitors = new Set<string>();
  
  for (const event of analytics.events) {
    allVisitors.add(event.visitorHash);
    
    if (event.endpoint === '/skill.md') {
      skillMd.add(event.visitorHash);
    }
    if (event.endpoint === '/markets' || event.endpoint.startsWith('/markets/')) {
      markets.add(event.visitorHash);
    }
    if (event.endpoint.includes('/agentwallet/prepare')) {
      prepare.add(event.visitorHash);
    }
    if (event.endpoint.includes('/agentwallet/process') && event.method === 'POST') {
      bets.add(event.visitorHash);
    }
  }
  
  const conversionRate = skillMd.size > 0 
    ? ((bets.size / skillMd.size) * 100).toFixed(1) + '%'
    : '0%';
  
  return {
    uniqueVisitors: allVisitors.size,
    skillMdViews: skillMd.size,
    marketsViews: markets.size,
    prepareAttempts: prepare.size,
    betsPlaced: bets.size,
    conversionRate,
  };
}
