/**
 * ============================================================================
 * src/index.ts — THE FRONT DOOR OF THE BACKEND
 * ============================================================================
 *
 * WHAT THIS FILE DOES (in plain English)
 * --------------------------------------
 * This is the very first file that runs when the backend starts. Its job is
 * to build a web server, tell it which URLs it answers, and then start
 * listening for requests from the browser (the frontend on Vercel).
 *
 * Think of it like a receptionist's desk in an office building:
 *   - Requests arrive at the front door (a URL like /api/machines).
 *   - A series of "checkpoints" (called MIDDLEWARE) look at every request
 *     first: security headers, reading the request body, logging.
 *   - Then the request is sent to the right department (a ROUTER file in
 *     src/api/routes/) that actually does the work.
 *   - If nobody handles it, it gets a "404 Not Found" reply.
 *   - If something crashes along the way, an error handler catches it and
 *     sends back a tidy error instead of the server falling over.
 *
 * HOW IT IS STARTED
 * -----------------
 * `npm start` (see package.json) first runs the database migration script
 * (dist/db/migrate.js — creates/updates tables) and then runs the compiled
 * version of this file (dist/index.js). TypeScript (.ts) is compiled to
 * JavaScript (.js) by `npm run build` before deployment.
 *
 * KEY TERMS
 * ---------
 * - Express: the most popular Node.js library for building web servers.
 *   `app` below is the Express application object.
 * - Middleware: a function that runs on a request BEFORE (or around) the
 *   code that finally answers it. It can modify the request, reject it,
 *   or pass it along by calling `next()`.
 * - Router: a mini-app holding a group of related endpoints (e.g. everything
 *   under /api/machines). Each lives in its own file in src/api/routes/.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// IMPORTS — pulling in code from libraries and from our own files.
// ---------------------------------------------------------------------------

// `express` is the web-server library. We also import its TypeScript *types*
// (Express, Request, Response, NextFunction) so the compiler can check that
// we use requests and responses correctly.
import express, { Express, Request, Response, NextFunction } from 'express';

// `cors` = Cross-Origin Resource Sharing. Browsers block a web page on one
// domain (our Vercel frontend) from calling an API on another domain (this
// Railway backend) unless the API explicitly says "that's allowed". This
// middleware adds the headers that say so.
import cors from 'cors';

// `helmet` adds a set of standard security-related HTTP headers to every
// response (e.g. telling browsers not to guess content types). It's a cheap,
// widely-used safety net.
import helmet from 'helmet';

// Our own configuration: reads environment variables (PORT, DATABASE_URL...)
// once, in one place. See src/config/env.ts.
import { env } from './config/env';

// A helper that runs SQL against the Postgres database. We rename it to
// `dbQuery` here just to make it obvious at the call site that it's the DB.
import { query as dbQuery } from './config/database';

// Background jobs = tasks that run on a timer (like a cron job), not in
// response to a web request — e.g. syncing cost data every hour.
import { initializeJobs } from './jobs';

// ---------------------------------------------------------------------------
// ROUTE FILES — each one handles a group of related URLs.
// ---------------------------------------------------------------------------
import authRoutes from './api/routes/auth';                 // sign-up / login / saving cloud credentials
import machineRoutes from './api/routes/machines';          // launch / start / stop / delete gaming VMs
import costRoutes from './api/routes/costs';                // spend history and forecasts
import regionRoutes from './api/routes/regions';            // cloud regions and their prices
import reconRoutes from './api/routes/recon';              // Recon page: best region per hardware tier
import performanceRoutes from './api/routes/performance';   // CPU/GPU/network metrics for a machine
import streamingRoutes from './api/routes/streaming';       // how to connect Sunshine/Moonlight to a machine
import setupStatusRoutes from './api/routes/setup-status';  // progress of the automated machine setup
import snapshotRoutes from './api/routes/snapshots';        // disk backups that can move between clouds
import costAnalysisRoutes from './api/routes/cost-analysis'; // compare prices across AWS/Azure/GCP
import statusRoutes from './api/routes/status';             // health lights + build/version info
import credentialRoutes from './api/routes/credentials';    // add/check/remove your cloud keys (encrypted)
import operationRoutes from './api/routes/operations';      // live progress of cloud actions
import inventoryRoutes from './api/routes/inventory';       // what's deployed where (infrastructure map)
import { failOrphanedOperations } from './services/OperationLog';
import { recordRequest } from './services/Metrics';

// Middleware that checks the user's login token (a "JWT") and rejects the
// request if it's missing or invalid. See src/api/middleware/auth.ts.
import { authMiddleware } from './api/middleware/auth';

// Create the Express application. Everything below configures this object.
const app: Express = express();

// Railway puts a proxy in front of us. "Trust" one proxy hop so req.ip is the
// real visitor's address (used by the login brute-force limiter), not the proxy's.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// GLOBAL MIDDLEWARE — runs on EVERY request, in the order written here.
// Order matters: a request passes through these top to bottom.
// ---------------------------------------------------------------------------

// Security headers first, so they're present on every single response.
app.use(helmet());

// Allow browsers on other domains (our frontend) to call this API.
// If FRONTEND_URL is set, only that website (plus local development) may
// call this API from a browser. Unset = allow any origin (fine while
// setting up; tokens are still required for anything private).
app.use(
  cors(
    env.FRONTEND_URL
      ? { origin: [env.FRONTEND_URL, 'http://localhost:3000'] }
      : undefined
  )
);

// "Body parsing": when the frontend sends data (e.g. a form as JSON), it
// arrives as raw text. These two lines turn it into a JavaScript object and
// put it on `req.body`, so route code can just read `req.body.provider`.
app.use(express.json());                          // for JSON bodies (what our frontend sends)
app.use(express.urlencoded({ extended: true }));  // for classic HTML-form bodies

// Our own small logging middleware. For each request it records the start
// time, waits until the response has been fully sent ('finish' event), then
// prints one line like:  GET /api/machines 200 12ms
// Railway shows these lines in its log viewer.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now(); // milliseconds since 1970 — just used to measure elapsed time

  // `res.on('finish', ...)` registers a callback that fires later, once the
  // reply has gone out. We can't log the status code now because the route
  // hasn't produced one yet.
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    // Also count it for the BACKEND light's stats panel (services/Metrics.ts).
    // originalUrl, not path: by the time the reply finishes, Express has
    // trimmed the mount prefix off req.path (e.g. "/api/status" → "/").
    recordRequest(req.method, req.originalUrl.split('?')[0], res.statusCode, duration);
  });

  // IMPORTANT: calling next() hands the request on to the next middleware or
  // route. Forgetting it would leave the request hanging forever.
  next();
});

// ---------------------------------------------------------------------------
// HEALTH CHECK — GET /health
// A simple URL that hosting platforms or monitoring tools can hit to ask
// "are you alive, and can you reach the database?"
// ---------------------------------------------------------------------------
app.get('/health', async (req: Request, res: Response) => {
  try {
    // "SELECT 1" is the cheapest possible SQL query — it just returns the
    // number 1. If it succeeds, the database connection works.
    await dbQuery('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    // 503 = "Service Unavailable": we're running but can't do our job.
    res.status(503).json({ status: 'database-error', error });
  }
});

// ---------------------------------------------------------------------------
// ROUTES — connect URL prefixes to the router files imported above.
//
// `app.use('/api/machines', authMiddleware, machineRoutes)` means:
//   "For any URL starting with /api/machines, first run authMiddleware
//    (must be logged in), then hand the request to machineRoutes."
// Inside machines.ts, a route written as router.get('/:id') therefore
// answers GET /api/machines/123.
//
// Routes WITHOUT authMiddleware are public (no login needed).
// ---------------------------------------------------------------------------
app.use('/api/status', statusRoutes);          // PUBLIC: status lights must work before anyone logs in
app.use('/api/auth', authRoutes);              // PUBLIC: you can't require login on the login page
app.use('/api/machines', authMiddleware, machineRoutes);
app.use('/api/credentials', authMiddleware, credentialRoutes);  // your encrypted cloud keys
app.use('/api/operations', authMiddleware, operationRoutes);    // live progress of cloud actions
app.use('/api/inventory', authMiddleware, inventoryRoutes);     // what's deployed where (map)
app.use('/api/costs', authMiddleware, costRoutes);
app.use('/api/regions', authMiddleware, regionRoutes);
app.use('/api/recon', reconRoutes);            // PUBLIC: only reads the price catalogs
app.use('/api/performance', authMiddleware, performanceRoutes);
app.use('/api/streaming', streamingRoutes);    // login IS required: authMiddleware is attached to each route inside streaming.ts
app.use('/api/setup-status', authMiddleware, setupStatusRoutes);
app.use('/api/snapshots', authMiddleware, snapshotRoutes);
app.use('/api/cost-analysis', authMiddleware, costAnalysisRoutes);

// ---------------------------------------------------------------------------
// 404 HANDLER — "Not Found"
// Express runs middleware in order. If a request got all the way down here,
// no route above matched it, so we reply with a JSON 404.
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// ERROR HANDLER
// Express recognises an error handler by its FOUR parameters
// (err, req, res, next). If any route throws or calls next(error), Express
// skips straight to here. We log the full error for ourselves (visible in
// Railway logs) and send the client a short, safe message.
// `next` is unused but must be present, or Express won't treat this function
// as an error handler.
// ---------------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.statusCode || 500).json({   // 500 = "Internal Server Error" (a bug on our side)
    error: err.message || 'Internal server error',
    code: err.code,
  });
});

// ---------------------------------------------------------------------------
// START THE SERVER
// ---------------------------------------------------------------------------

// Which network port to listen on. Railway provides the PORT variable
// automatically; locally it defaults to 3000 (see src/config/env.ts).
const PORT = env.PORT;

// Kick off the timed background jobs (they run independently of requests).
initializeJobs();

// Operations left "running" by a previous server process can never finish;
// mark them failed with an explanation (see services/OperationLog.ts).
failOrphanedOperations();

// Begin accepting connections. The callback runs once the server is ready;
// these log lines are the first thing to look for in Railway's logs to
// confirm a deploy succeeded.
app.listen(PORT, () => {
  console.log(`CloudGaming Hub backend running on port ${PORT}`);
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`Log level: ${env.LOG_LEVEL}`);
});

// Exporting `app` lets other code (e.g. automated tests) import the server
// without starting it a second time.
export default app;
