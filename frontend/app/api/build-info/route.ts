/**
 * ============================================================================
 * frontend/app/api/build-info/route.ts — FRONTEND BUILD DETAILS
 * ============================================================================
 *
 * In Next.js's "app router", a file named route.ts inside app/<path>/
 * becomes a server endpoint at that path. So this file answers
 *     GET /api/build-info     (on the FRONTEND's own domain, i.e. Vercel)
 * It's the one exception to "all /api calls go to Railway" — this runs on
 * Vercel's servers, not in the browser and not on the backend.
 *
 * WHY IT EXISTS
 * -------------
 * The "Build info" panel wants to show which git commit the frontend was
 * built from. Vercel provides that as VERCEL_GIT_COMMIT_SHA, but only to
 * SERVER code — browser code can't read it (only NEXT_PUBLIC_ variables
 * reach the browser). This small server route reads it and hands it to the
 * browser as JSON. Consumed by frontend/components/BuildInfoPanel.tsx.
 * ============================================================================
 */

import { NextResponse } from 'next/server';

// Evaluated once when this serverless function cold-starts - the closest
// approximation to "build/deploy time" available without a separate build
// step that writes a timestamp file.
// ("Serverless": Vercel starts a fresh copy of this code on demand; a
// "cold start" is the first run of a new copy.)
const instanceStartedAt = new Date().toISOString();

// Vercel sets VERCEL_GIT_COMMIT_SHA etc. server-side only - they aren't
// exposed to the client bundle without a NEXT_PUBLIC_ prefix. This route
// runs on the server per-request, so it can read them directly and hand
// them to the client widget without needing a build-time env mapping.
//
// Exporting a function named GET is how Next.js knows this handles GET
// requests. Each `||` chain tries Vercel's variable, then Railway's, then a
// generic one, then gives up with null.
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

  // NextResponse.json(...) sends the object back as JSON.
  return NextResponse.json({
    service: 'cloudgaming-hub-frontend',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development', // Vercel: 'production' | 'preview' | 'development'
    nodeVersion: process.version,
    gitCommit: gitCommit ? gitCommit.slice(0, 12) : null,   // shortened commit hash
    gitBranch,
    gitMessage,
    deploymentUrl: process.env.VERCEL_URL || null,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_URL || null,    // shows which backend this build talks to — handy for debugging
    instanceStartedAt,
  });
}
