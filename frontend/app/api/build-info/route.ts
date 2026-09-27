import { NextResponse } from 'next/server';

// Evaluated once when this serverless function cold-starts - the closest
// approximation to "build/deploy time" available without a separate build
// step that writes a timestamp file.
const instanceStartedAt = new Date().toISOString();

// Vercel sets VERCEL_GIT_COMMIT_SHA etc. server-side only - they aren't
// exposed to the client bundle without a NEXT_PUBLIC_ prefix. This route
// runs on the server per-request, so it can read them directly and hand
// them to the client widget without needing a build-time env mapping.
export async function GET() {
  const gitCommit =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    null;

  const gitBranch =
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.RAILWAY_GIT_BRANCH ||
    process.env.GIT_BRANCH ||
    null;

  const gitMessage = process.env.VERCEL_GIT_COMMIT_MESSAGE || null;

  return NextResponse.json({
    service: 'cloudgaming-hub-frontend',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    gitCommit: gitCommit ? gitCommit.slice(0, 12) : null,
    gitBranch,
    gitMessage,
    deploymentUrl: process.env.VERCEL_URL || null,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_URL || null,
    instanceStartedAt,
  });
}
